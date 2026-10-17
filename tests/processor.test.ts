import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: DurableObjectState,
      public env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
import {
  manifestSegments,
  Processor,
  safeOutputName,
  stoppedEvidence,
  TaskBridge,
} from "../src/processor";
import { confirmProcessing } from "../src/jobs";
import type { Env } from "../src/types";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function pendingControlFixture(
  options: {
    lifecycle?: Record<string, unknown>;
    running?: boolean;
    read?: (sql: string) => Promise<unknown>;
    write?: (sql: string) => Promise<unknown>;
  } = {},
) {
  const stored = new Map<string, unknown>();
  if (options.lifecycle) stored.set("lifecycle", options.lifecycle);
  let running = options.running ?? true;
  const container = {
    get running() {
      return running;
    },
    images: { processor: "image" },
    start: vi.fn(() => {
      running = true;
    }),
    destroy: vi.fn(async () => {
      running = false;
    }),
    signal: vi.fn(),
    inspect: vi.fn(async () => (running ? { image: "image" } : null)),
    interceptOutboundHttp: vi.fn(async () => {}),
    setInactivityTimeout: vi.fn(async () => {}),
    monitor: vi.fn(() => new Promise<void>(() => {})),
  };
  const storage = {
    get: vi.fn(async (key: string) => stored.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      stored.set(key, value);
    }),
    setAlarm: vi.fn(async (_at: number) => {}),
    deleteAlarm: vi.fn(async () => {}),
  };
  const queries: string[] = [];
  const db = {
    prepare(sql: string) {
      queries.push(sql);
      const statement = {
        bind: (..._args: unknown[]) => statement,
        first: () => (options.read ? options.read(sql) : Promise.resolve(null)),
        run: () =>
          options.write
            ? options.write(sql)
            : Promise.resolve({ meta: { changes: 1 } }),
      };
      return statement;
    },
    batch: vi.fn(async (_statements: unknown[]) => []),
  };
  let initialization: Promise<unknown> = Promise.resolve();
  const ctx = {
    id: { toString: () => "do-id" },
    container,
    storage,
    exports: { TaskBridge: () => ({}) },
    waitUntil: vi.fn(),
    blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
      initialization = callback();
      return initialization;
    },
  } as unknown as DurableObjectState;
  const env = {
    DB: db,
    MEDIA: { head: vi.fn(async () => ({ size: 1024, etag: "source-etag" })) },
    PROCESSING_ENABLED: "true",
    PROCESSOR: { idFromName: () => ({ toString: () => "do-id" }) },
  } as unknown as Env;
  return {
    processor: new Processor(ctx, env),
    initialize: () => initialization,
    container,
    storage,
    stored,
    queries,
    db,
  };
}

describe("task storage confinement", () => {
  it("allows only the exact generated HLS names", () => {
    expect(safeOutputName("index.m3u8")).toBe(true);
    expect(safeOutputName("segment-000001.ts")).toBe(true);
    for (const name of [
      "../source",
      "segment-000001.ts/../source",
      "/segment-000001.ts",
      "%2e%2e",
      "index.m3u8?token=value",
      "source.mp4",
      "segment-1.ts",
      "segment-000001.ts\0",
    ])
      expect(safeOutputName(name)).toBe(false);
  });
  it("rejects absolute, external, repeated, missing-end and encrypted references", () => {
    const manifest =
      "#EXTM3U\n#EXTINF:6.0,\nsegment-000001.ts\n#EXT-X-ENDLIST\n";
    expect(manifestSegments(manifest)).toEqual(["segment-000001.ts"]);
    for (const changed of [
      manifest.replace("segment-000001.ts", "../source"),
      manifest.replace("segment-000001.ts", "https://external.example/file"),
      manifest.replace(
        "#EXT-X-ENDLIST",
        "#EXTINF:6.0,\nsegment-000001.ts\n#EXT-X-ENDLIST",
      ),
      manifest.replace("#EXT-X-ENDLIST", ""),
      manifest.replace(
        "#EXTM3U",
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="http://task.internal/input"',
      ),
    ])
      expect(() => manifestSegments(changed)).toThrow();
  });
});

describe("Container stop evidence", () => {
  it("destroys at an expired deadline before waiting for a never-settling catalog read", async () => {
    vi.useFakeTimers();
    const fixture = pendingControlFixture({
      lifecycle: {
        jobId: "task",
        startRequestedAt: 1,
        startIssuedAt: 1,
        handoffConfirmedAt: 1,
        deadlineAt: 2,
      },
      read: () => new Promise(() => {}),
    });
    await fixture.initialize();
    const result = fixture.processor.fetch(
      new Request("https://processor/supervise", { method: "POST" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.container.destroy).toHaveBeenCalledOnce();
    expect(fixture.container.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1001);
    expect((await result).status).toBe(200);
    expect(fixture.db.batch).not.toHaveBeenCalled();
    expect(
      fixture.queries.some((sql) => sql.includes("state='stop_unverified'")),
    ).toBe(true);
    expect(fixture.storage.setAlarm).toHaveBeenLastCalledWith(
      Date.now() + 4999,
    );
  });

  it("bounds a pending catalog read by the remaining time before physical shutdown", async () => {
    vi.useFakeTimers();
    const fixture = pendingControlFixture({
      lifecycle: {
        jobId: "task",
        startRequestedAt: 1,
        startIssuedAt: 1,
        handoffConfirmedAt: 1,
        deadlineAt: Date.now() + 10500,
      },
      read: () => new Promise(() => {}),
    });
    await fixture.initialize();
    const supervised = fixture.processor.alarm();
    await vi.advanceTimersByTimeAsync(499);
    expect(fixture.container.signal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await supervised;
    expect(fixture.container.signal).toHaveBeenCalledWith(15);
    expect(fixture.db.batch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1001);
    const forced = fixture.processor.alarm();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.container.destroy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1001);
    await forced;
    expect(fixture.db.batch).not.toHaveBeenCalled();
    expect(fixture.container.start).not.toHaveBeenCalled();
  });

  it("releases the stop guard and restores a force-stop alarm after a pending catalog write", async () => {
    vi.useFakeTimers();
    const fixture = pendingControlFixture({
      lifecycle: {
        jobId: "task",
        startRequestedAt: 1,
        startIssuedAt: 1,
        handoffConfirmedAt: 1,
        deadlineAt: Date.now() + 60000,
        terminal: "cancelled",
      },
      write: () => new Promise(() => {}),
    });
    await fixture.initialize();
    const requested = fixture.processor.fetch(
      new Request("https://processor/supervise", { method: "POST" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.container.signal).toHaveBeenCalledWith(15);
    // This wakeup encounters the in-flight control call. Its replacement must
    // survive after the catalog timeout releases stopping=true.
    await fixture.processor.alarm();
    await vi.advanceTimersByTimeAsync(1001);
    expect((await requested).status).toBe(200);
    expect(
      fixture.storage.setAlarm.mock.calls.at(-1)?.[0],
    ).toBeGreaterThanOrEqual(Date.now());
    const forced = fixture.processor.alarm();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.container.destroy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1001);
    await forced;
    expect(fixture.db.batch).not.toHaveBeenCalled();
    expect(fixture.container.start).not.toHaveBeenCalled();
  });

  it("schedules physical completion supervision before a pending finish-state write", async () => {
    vi.useFakeTimers();
    const fixture = pendingControlFixture({
      lifecycle: {
        jobId: "task",
        startRequestedAt: 1,
        startIssuedAt: 1,
        handoffConfirmedAt: 1,
        deadlineAt: Date.now() + 60000,
      },
      write: () => new Promise(() => {}),
    });
    await fixture.initialize();
    const finished = fixture.processor.fetch(
      new Request("https://processor/finish", {
        method: "POST",
        body: JSON.stringify({ jobId: "task", state: "succeeded" }),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.storage.setAlarm).toHaveBeenLastCalledWith(Date.now() + 500);
    const supervised = fixture.processor.alarm();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.container.signal).toHaveBeenCalledWith(15);
    await vi.advanceTimersByTimeAsync(1001);
    expect((await finished).status).toBe(202);
    await supervised;
    expect(fixture.db.batch).not.toHaveBeenCalled();
  });

  it("destroys an inspected instance even when the local running flag is false", async () => {
    vi.useFakeTimers();
    const fixture = pendingControlFixture({
      lifecycle: {
        jobId: "task",
        startRequestedAt: 1,
        startIssuedAt: 1,
        handoffConfirmedAt: 1,
        deadlineAt: 2,
      },
      running: false,
    });
    fixture.container.inspect.mockResolvedValueOnce({
      image: "pending-instance",
    });
    await fixture.initialize();
    await fixture.processor.alarm();
    expect(fixture.container.destroy).toHaveBeenCalledOnce();
    expect(fixture.container.inspect).toHaveBeenCalledTimes(2);
    expect(fixture.db.batch).not.toHaveBeenCalled();
  });

  it.each(["cancel", "deadline"])(
    "never issues a late start after %s during durable-attempt persistence",
    async (action) => {
      vi.useFakeTimers();
      const plan = {
        totalTimeoutSeconds: 60,
        maxOutputBytes: 1024,
        instance: {
          name: "standard-1",
          vcpu: 0.5,
          memoryBytes: 4 * 1024 ** 3,
          diskBytes: 8e9,
        },
        resourceAmounts: { containerCpuSeconds: 30 },
      };
      const job = {
        id: "task",
        video_id: "video",
        version_id: "version",
        quote_id: "quote",
        state: "queued",
        stop_verified: 0,
      };
      const quote = {
        video_id: "video",
        state: "confirmed",
        expires_at: Date.now() + 120000,
        source_revision: "revision",
        source_etag: "source-etag",
        data_json: JSON.stringify(plan),
      };
      const version = {
        id: "version",
        task_id: "task",
        video_id: "video",
        prefix: "videos/video/versions/version/",
      };
      const video = {
        id: "video",
        source_key: "videos/video/source/revision",
        source_revision: "revision",
        source_etag: "source-etag",
        source_size: 1024,
      };
      const fixture = pendingControlFixture({
        running: false,
        read: async (sql) =>
          sql.includes("FROM jobs")
            ? job
            : sql.includes("FROM quotes")
              ? quote
              : sql.includes("FROM versions")
                ? version
                : video,
      });
      await fixture.initialize();
      let savedAttempt = false;
      let resumeSave!: () => void;
      const pendingSave = new Promise<void>((resolve) => {
        resumeSave = resolve;
      });
      fixture.storage.put.mockImplementation(async (key, value) => {
        fixture.stored.set(key, value);
        if (
          key === "lifecycle" &&
          (value as { startIssuedAt?: number }).startIssuedAt &&
          !savedAttempt
        ) {
          savedAttempt = true;
          await pendingSave;
        }
      });
      const started = fixture.processor.fetch(
        new Request("https://processor/start", {
          method: "POST",
          body: JSON.stringify({ jobId: "task" }),
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(savedAttempt).toBe(true);
      if (action === "cancel") {
        await fixture.processor.fetch(
          new Request("https://processor/cancel", { method: "POST" }),
        );
      } else {
        await vi.advanceTimersByTimeAsync(50000);
        await fixture.processor.alarm();
      }
      resumeSave();
      expect((await started).status).toBe(502);
      expect(fixture.container.start).not.toHaveBeenCalled();
    },
  );

  it("never equates a stop request or a false running bit alone with verified stop", () => {
    expect(stoppedEvidence(false, null)).toBe(true);
    expect(stoppedEvidence(true, null)).toBe(false);
    expect(stoppedEvidence(false, { image: "sha256:running-image" })).toBe(
      false,
    );
    expect(stoppedEvidence(false, undefined)).toBe(false);
  });
  it("reserves shutdown time before a persisted deadline even during a catalog outage", async () => {
    vi.useFakeTimers();
    const deadlineAt = Date.now() + 10_000;
    const stored = new Map<string, unknown>([
      [
        "lifecycle",
        {
          jobId: "task",
          startRequestedAt: 1,
          startIssuedAt: 1,
          handoffConfirmedAt: 1,
          deadlineAt,
        },
      ],
    ]);
    let running = true;
    const container = {
      get running() {
        return running;
      },
      start: vi.fn(),
      destroy: vi.fn(async () => {
        running = false;
      }),
      signal: vi.fn(),
      inspect: vi.fn(async () => (running ? { image: "image" } : null)),
      interceptOutboundHttp: vi.fn(async () => {}),
      setInactivityTimeout: vi.fn(async () => {}),
      monitor: vi.fn(() => new Promise<void>(() => {})),
    };
    const storage = {
      get: vi.fn(async (key: string) => stored.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        stored.set(key, value);
      }),
      setAlarm: vi.fn(async () => {}),
      deleteAlarm: vi.fn(async () => {}),
    };
    let initialization: Promise<unknown> = Promise.resolve();
    const ctx = {
      storage,
      container,
      exports: { TaskBridge: () => ({}) },
      waitUntil: vi.fn(),
      blockConcurrencyWhile: vi.fn((callback: () => Promise<unknown>) => {
        initialization = callback();
        return initialization;
      }),
    } as unknown as DurableObjectState;
    const db = {
      prepare: vi.fn(() => {
        const statement = {
          bind: vi.fn(() => statement),
          first: vi.fn(async () => {
            throw new Error("D1 unavailable");
          }),
          run: vi.fn(async () => {
            throw new Error("D1 unavailable");
          }),
        };
        return statement;
      }),
    };
    const processor = new Processor(ctx, { DB: db } as unknown as Env);
    await initialization;
    const response = await processor.fetch(
      new Request("https://processor/supervise", { method: "POST" }),
    );
    expect(response.status).toBe(200);
    expect(container.signal).toHaveBeenCalledWith(15);
    expect(container.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await processor.alarm();
    expect(container.start).not.toHaveBeenCalled();
    expect(container.destroy).toHaveBeenCalledOnce();
    expect(Date.now()).toBe(deadlineAt - 9000);
    expect(container.inspect).toHaveBeenCalled();
    expect(storage.setAlarm).toHaveBeenCalled();
  });
  it("retries a stop whose platform control call does not settle and keeps its reservation", async () => {
    vi.useFakeTimers();
    const lifecycle = {
      jobId: "task",
      startRequestedAt: 1,
      startIssuedAt: 1,
      handoffConfirmedAt: 1,
      deadlineAt: 2,
    };
    const destroy = vi.fn(() => new Promise<void>(() => {}));
    const queries: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        queries.push(sql);
        const statement = {
          bind: vi.fn(() => statement),
          first: vi.fn(async () => null),
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
        };
        return statement;
      }),
    };
    let initialization: Promise<unknown> = Promise.resolve();
    const setAlarm = vi.fn(async () => {});
    const ctx = {
      storage: {
        get: vi.fn(async () => lifecycle),
        put: vi.fn(async () => {}),
        setAlarm,
      },
      container: {
        running: true,
        destroy,
        signal: vi.fn(),
        inspect: vi.fn(),
        interceptOutboundHttp: vi.fn(async () => {}),
        setInactivityTimeout: vi.fn(async () => {}),
        monitor: vi.fn(() => new Promise<void>(() => {})),
      },
      exports: { TaskBridge: () => ({}) },
      waitUntil: vi.fn(),
      blockConcurrencyWhile: vi.fn((callback: () => Promise<unknown>) => {
        initialization = callback();
        return initialization;
      }),
    } as unknown as DurableObjectState;
    const processor = new Processor(ctx, { DB: db } as unknown as Env);
    await initialization;
    const response = processor.fetch(
      new Request("https://processor/supervise", { method: "POST" }),
    );
    await vi.advanceTimersByTimeAsync(5001);
    expect((await response).status).toBe(200);
    expect(destroy).toHaveBeenCalledOnce();
    expect(queries.some((sql) => sql.includes("state='stop_unverified'"))).toBe(
      true,
    );
    expect(queries.some((sql) => sql.includes("UPDATE reservations"))).toBe(
      false,
    );
    expect(setAlarm).toHaveBeenLastCalledWith(Date.now() + 4999);
  });
  it("treats a saved start attempt as a replay after restart", async () => {
    const lifecycle = {
      jobId: "task",
      startRequestedAt: 1,
      deadlineAt: Date.now() + 60000,
    };
    let initialization: Promise<unknown> = Promise.resolve();
    const start = vi.fn();
    const ctx = {
      id: { toString: () => "do-id" },
      container: { running: false, start },
      storage: {
        get: vi.fn(async () => lifecycle),
        setAlarm: vi.fn(async () => {}),
      },
      blockConcurrencyWhile: vi.fn((callback: () => Promise<unknown>) => {
        initialization = callback();
        return initialization;
      }),
    } as unknown as DurableObjectState;
    const processor = new Processor(ctx, {
      PROCESSOR: { idFromName: () => ({ toString: () => "do-id" }) },
    } as unknown as Env);
    await initialization;
    const response = await processor.fetch(
      new Request("https://processor/start", {
        method: "POST",
        body: JSON.stringify({ jobId: "task" }),
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ duplicate: true });
    expect(start).not.toHaveBeenCalled();
  });
});

describe("paid task replay", () => {
  it("returns the original finished job even when processing was later disabled", async () => {
    const existing = { id: "old-task", state: "succeeded", stop_verified: 1 };
    const first = vi.fn(async () => existing);
    const db = { prepare: vi.fn(() => ({ bind: () => ({ first }) })) };
    const dispatch = vi.fn();
    const response = await confirmProcessing(
      {
        DB: db,
        PROCESSING_ENABLED: "false",
        PROCESSOR: { get: dispatch },
      } as unknown as Env,
      "used-quote",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      duplicate: true,
      job: existing,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("long HLS inventory verification", () => {
  it("verifies more than 1000 segments with paginated listings instead of per-object HEAD calls", async () => {
    const prefix = "videos/video/versions/version/";
    const segmentNames = Array.from(
      { length: 1001 },
      (_, i) => `segment-${String(i).padStart(6, "0")}.ts`,
    );
    const manifest = `#EXTM3U\n${segmentNames.map((name) => `#EXTINF:6.0,\n${name}`).join("\n")}\n#EXT-X-ENDLIST\n`;
    const objects = [
      ...segmentNames.map((name) => ({
        name,
        size: 1,
        sha256: "a".repeat(64),
      })),
      { name: "index.m3u8", size: manifest.length, sha256: "b".repeat(64) },
    ];
    const actual = objects.map((object) => ({
      key: prefix + object.name,
      size: object.size,
      etag: `etag-${object.name}`,
      checksums: {},
    }));
    const indexed = objects.map((object) => ({
      key: prefix + object.name,
      state: "present",
      bytes: object.size,
      etag: `etag-${object.name}`,
      sha256: object.sha256,
    }));
    const job = {
      id: "task",
      video_id: "video",
      quote_id: "quote",
      version_id: "version",
      state: "running",
      stop_verified: 0,
      deadline_at: Date.now() + 60000,
    };
    const version = {
      id: "version",
      video_id: "video",
      task_id: "task",
      prefix,
      state: "processing",
    };
    const quote = {
      id: "quote",
      video_id: "video",
      data_json: JSON.stringify({ maxOutputBytes: 1e7, maxMediaObjects: 2000 }),
    };
    const db = {
      prepare(sql: string) {
        const statement = {
          bind: () => statement,
          first: async () =>
            sql.includes("FROM jobs")
              ? job
              : sql.includes("FROM quotes")
                ? quote
                : sql.includes("FROM versions")
                  ? version
                  : { id: "video" },
          all: async () => ({ results: indexed }),
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
        };
        return statement;
      },
    };
    const list = vi.fn(async (options: { cursor?: string }) =>
      options.cursor
        ? { objects: actual.slice(1000), truncated: false }
        : {
            objects: actual.slice(0, 1000),
            truncated: true,
            cursor: "page-two",
          },
    );
    const head = vi.fn();
    const fetch = vi.fn(async (_url?: string) =>
      Response.json({ stopping: true }),
    );
    const env = {
      DB: db,
      MEDIA: {
        list,
        head,
        get: vi.fn(async () => ({
          size: manifest.length,
          etag: "etag-index.m3u8",
          text: async () => manifest,
        })),
      },
      PROCESSOR: { idFromName: () => "task", get: () => ({ fetch }) },
    } as unknown as Env;
    const bridge = new TaskBridge(
      { props: { taskId: "task" } } as unknown as ExecutionContext,
      env,
    );
    const response = await bridge.fetch(
      new Request("http://task.internal/complete", {
        method: "POST",
        body: JSON.stringify({
          manifest: "index.m3u8",
          objects,
          durationSeconds: 6006,
          validation: {
            allSegmentsDecoded: true,
            playlistDecoded: true,
            keyframeStarts: true,
            codecAndResolutionVerified: true,
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledTimes(2);
    expect(head).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0]?.[0]).toBe("https://processor/finish");
  });
});
