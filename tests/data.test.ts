import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("../src/billing", () => ({
  quoteProcessing: vi.fn(),
  validateQuoteBudget: vi.fn(),
}));
vi.mock("../src/logs", () => ({ log: vi.fn(async () => {}) }));
import { validateQuoteBudget } from "../src/billing";
import { confirmProcessing } from "../src/jobs";
import { visitorIdentity } from "../src/auth";
import { getHistory, saveHistory } from "../src/history";
import { createDeletionPlan, executeDeletion } from "../src/storage";
import type { Env } from "../src/types";

interface NativeStatement {
  all(...values: unknown[]): Record<string, unknown>[];
  get(...values: unknown[]): Record<string, unknown> | undefined;
  run(...values: unknown[]): { changes: number | bigint };
}
interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}
// Node 22 supplies SQLite directly; no database simulation or new native dependency.
const { DatabaseSync } = (await import("node:sqlite" as string)) as {
  DatabaseSync: new (path: string) => NativeDatabase;
};
const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: URL, encoding: string): string;
};
const databases: NativeDatabase[] = [];
const timestamp = Date.parse("2026-10-13T14:00:00Z");

function setup() {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  for (const file of [
    "0001_initial.sql",
    "0002_imports.sql",
    "0003_deletion_items.sql",
    "0004_upload_approvals.sql",
  ])
    native.exec(
      readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
    );
  let beforeBatch: (() => void) | undefined;
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const prepared = native.prepare(sql);
      const statement = {
        bind(...input: unknown[]) {
          values = input;
          return statement;
        },
        async first() {
          return prepared.get(...values) ?? null;
        },
        async all() {
          return { success: true, results: prepared.all(...values) };
        },
        async run() {
          return statement.execute();
        },
        execute() {
          const result = prepared.run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
    async batch(statements: { execute(): unknown }[]) {
      if (beforeBatch) {
        const hook = beforeBatch;
        beforeBatch = undefined;
        hook();
      }
      native.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.execute());
        native.exec("COMMIT");
        return results;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const dispatch = vi.fn(async () => Response.json({ accepted: true }));
  const env = {
    DB: db,
    PROCESSING_ENABLED: "true",
    APP_ENV: "test",
    SESSION_SECRET: "test-only-history-session-secret-at-least-32-characters",
    COORDINATOR: {
      idFromName: () => "singleton",
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
    PROCESSOR: { idFromName: () => "task", get: () => ({ fetch: dispatch }) },
  } as unknown as Env;
  native
    .prepare(
      "INSERT INTO videos(id,title,source_key,source_size,source_etag,source_revision,source_name,status,created_at,updated_at) VALUES('video','Title','videos/video/source/source',4,'source-etag','revision','test.mp4','unprocessed',?,?)",
    )
    .run(timestamp, timestamp);
  native
    .prepare(
      "INSERT INTO versions(id,video_id,prefix,state,mode,quality,manifest,bytes,duration,timeline_id,validation_json,created_at) VALUES('version','video','videos/video/versions/version/','verified','probe-remux','source','index.m3u8',18,1000,'timeline','{}',?)",
    )
    .run(timestamp);
  native.exec(
    "UPDATE videos SET current_version_id='version',published=1 WHERE id='video'",
  );
  return {
    native,
    env,
    dispatch,
    beforeBatch(hook: () => void) {
      beforeBatch = hook;
    },
  };
}
function request(
  path: string,
  data: unknown,
  cookie?: string,
  host = "one.example",
) {
  return new Request(`https://${host}${path}`, {
    method: "POST",
    headers: {
      Origin: `https://${host}`,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(data),
  });
}
function quote(native: NativeDatabase) {
  native
    .prepare(
      "INSERT INTO quotes(id,video_id,source_revision,source_etag,mode,quality,snapshot_id,period_start,expires_at,state,data_json,created_at) VALUES('quote','video','revision','source-etag','probe-remux','source','snapshot','2026-10-13',?,'open',?,?)",
    )
    .run(
      timestamp + 60000,
      JSON.stringify({
        totalTimeoutSeconds: 30,
        maxOutputBytes: 200,
        instance: { name: "standard-1" },
        resourceAmounts: { containerCpuSeconds: 15, r2CurrentBytes: 200 },
      }),
      timestamp,
    );
  vi.mocked(validateQuoteBudget).mockResolvedValue({
    id: "snapshot",
    periodStart: "2026-10-13",
    periodEnd: "2026-11-13T00:00:00Z",
    project: {
      storedBytes: 0,
      actualBytes: 0,
      reservedBytes: 0,
      ledgerValid: true,
    },
    policy: { storageLimitBytes: 10 * 1024 ** 3, monthlySpendLimitUsd: 0 },
  } as Awaited<ReturnType<typeof validateQuoteBudget>>);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(timestamp);
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("actual SQLite admission transactions", () => {
  it("creates one job/version/reservation and one dispatch under concurrent quote replay", async () => {
    const { native, env, dispatch } = setup();
    quote(native);
    await Promise.all([
      confirmProcessing(env, "quote"),
      confirmProcessing(env, "quote"),
    ]);
    expect(native.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(1);
    expect(
      native
        .prepare("SELECT COUNT(*) AS n FROM versions WHERE state='processing'")
        .get()?.n,
    ).toBe(1);
    expect(
      native.prepare("SELECT COUNT(*) AS n FROM reservations").get()?.n,
    ).toBe(1);
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("atomically rejects a deployment fence acquired after the preflight read", async () => {
    const { native, env, dispatch, beforeBatch } = setup();
    quote(native);
    beforeBatch(() =>
      native
        .prepare("INSERT INTO settings VALUES('deployment_fence_until',?,?)")
        .run(String(timestamp + 60000), timestamp),
    );
    await expect(confirmProcessing(env, "quote")).rejects.toMatchObject({
      code: "deployment_busy",
    });
    expect(
      native.prepare("SELECT state FROM quotes WHERE id='quote'").get()?.state,
    ).toBe("open");
    for (const table of ["jobs", "reservations"])
      expect(
        native.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
      ).toBe(0);
    expect(
      native
        .prepare("SELECT COUNT(*) AS n FROM versions WHERE state='processing'")
        .get()?.n,
    ).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("executes actual release admission and cannot overwrite another live fence", async () => {
    const { native } = setup();
    const { acquireReleaseFence } = await import(
      "../scripts/release-fence.mjs" as string
    );
    let clock = timestamp;
    const readBuild = vi.fn();
    const options = {
      query: async (sql: string) => native.prepare(sql).all(),
      revision: "a".repeat(40),
      worker: "fixture-test",
      buildUuid: "11111111-1111-4111-8111-111111111111",
      readBuild,
      now: () => clock,
      pause: async (ms: number) => {
        clock += ms;
      },
      timeoutMs: 40,
      pollMs: 20,
    };
    const acquired = await acquireReleaseFence(options);
    const owner = native
      .prepare("SELECT value FROM settings WHERE key='deployment_fence_owner'")
      .get()?.value;
    await expect(
      acquireReleaseFence({
        ...options,
        buildUuid: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toThrow("bounded waiting");
    expect(
      native
        .prepare(
          "SELECT value FROM settings WHERE key='deployment_fence_until'",
        )
        .get()?.value,
    ).toBe(String(acquired.fenceUntil));
    expect(
      native
        .prepare(
          "SELECT value FROM settings WHERE key='deployment_fence_owner'",
        )
        .get()?.value,
    ).toBe(owner);
    expect(readBuild).not.toHaveBeenCalled();
  });
  it("rejects active tasks through actual release admission without acquiring a fence", async () => {
    const { native } = setup();
    quote(native);
    native
      .prepare(
        "INSERT INTO jobs(id,video_id,version_id,quote_id,state,stage,started_at,created_at,updated_at) VALUES('task','video','version','quote','running','probe',?,?,?)",
      )
      .run(timestamp, timestamp, timestamp);
    const { acquireReleaseFence } = await import(
      "../scripts/release-fence.mjs" as string
    );
    const readBuild = vi.fn();
    const pause = vi.fn();
    await expect(
      acquireReleaseFence({
        query: async (sql: string) => native.prepare(sql).all(),
        revision: "a".repeat(40),
        worker: "fixture-test",
        buildUuid: "11111111-1111-4111-8111-111111111111",
        readBuild,
        pause,
        now: () => timestamp,
      }),
    ).rejects.toThrow("Active or stop-unverified processing tasks exist");
    expect(
      native
        .prepare(
          "SELECT COUNT(*) AS n FROM settings WHERE key IN ('deployment_fence_until','deployment_fence_owner')",
        )
        .get()?.n,
    ).toBe(0);
    expect(pause).not.toHaveBeenCalled();
    expect(readBuild).not.toHaveBeenCalled();
  });
});

describe("actual SQLite watch-history upserts", () => {
  it("bounds concurrent tab increments, ignores replay/reordering, and preserves history across title edits", async () => {
    const { native, env } = setup();
    const identity = await visitorIdentity(
      request("/api/history/identity", {}),
      env,
    );
    const cookie = identity.headers.get("Set-Cookie")!.split(";")[0];
    const { writeContext } = (await (
      await getHistory(
        new Request("https://one.example/api/history", {
          headers: { Cookie: cookie },
        }),
        env,
      )
    ).json()) as { writeContext: string };
    const event = (
      eventId: string,
      eventAt: number,
      position: number,
      playedSeconds: number,
    ) =>
      request(
        "/api/history",
        {
          videoId: "video",
          timelineId: "timeline",
          eventId,
          eventAt,
          position,
          playedSeconds,
          writeContext,
        },
        cookie,
      );
    await saveHistory(event("initial", timestamp, 100, 0), env);
    await Promise.all([
      saveHistory(event("tab-one", timestamp + 10000, 110, 20), env),
      saveHistory(event("tab-two", timestamp + 20000, 120, 20), env),
    ]);
    let row = native.prepare("SELECT * FROM watch_history").get()!;
    expect(row.played_seconds).toBe(20);
    expect(row.position).toBe(120);
    await saveHistory(event("tab-two", timestamp + 30000, 900, 60), env);
    await saveHistory(event("reordered", timestamp + 5000, 2, 60), env);
    native.exec("UPDATE videos SET title='Renamed' WHERE id='video'");
    row = native.prepare("SELECT * FROM watch_history").get()!;
    expect(row.played_seconds).toBe(20);
    expect(row.position).toBe(120);
    expect(
      native.prepare("SELECT COUNT(*) AS n FROM watch_history").get()?.n,
    ).toBe(1);
  });
  it("resets progress for a new verified timeline and rejects an old-tab update", async () => {
    const { native, env } = setup();
    const identity = await visitorIdentity(
      request("/api/history/identity", {}),
      env,
    );
    const cookie = identity.headers.get("Set-Cookie")!.split(";")[0];
    const { writeContext } = (await (
      await getHistory(
        new Request("https://one.example/api/history", {
          headers: { Cookie: cookie },
        }),
        env,
      )
    ).json()) as { writeContext: string };
    await saveHistory(
      request(
        "/api/history",
        {
          videoId: "video",
          timelineId: "timeline",
          eventId: "old",
          eventAt: timestamp,
          position: 900,
          playedSeconds: 60,
          watched: true,
          writeContext,
        },
        cookie,
      ),
      env,
    );
    native.exec(
      "UPDATE versions SET timeline_id='new-timeline' WHERE id='version'",
    );
    await saveHistory(
      request(
        "/api/history",
        {
          videoId: "video",
          timelineId: "new-timeline",
          eventId: "new",
          eventAt: timestamp + 20000,
          position: 10,
          playedSeconds: 10,
          writeContext,
        },
        cookie,
      ),
      env,
    );
    const row = native.prepare("SELECT * FROM watch_history").get()!;
    expect(row.timeline_id).toBe("new-timeline");
    expect(row.played_seconds).toBe(10);
    expect(row.watched).toBe(0);
    await expect(
      saveHistory(
        request(
          "/api/history",
          {
            videoId: "video",
            timelineId: "timeline",
            eventId: "late-old",
            eventAt: timestamp + 30000,
            position: 950,
            playedSeconds: 20,
            writeContext,
          },
          cookie,
        ),
        env,
      ),
    ).rejects.toMatchObject({ code: "timeline_changed" });
  });
});

describe("actual SQLite deletion/import recovery", () => {
  it("invalidates HLS before partial deletion, preserves source, and counts retry bytes once", async () => {
    const { native, env } = setup();
    native.exec("UPDATE videos SET published=0 WHERE id='video'");
    const prefix = "videos/video/versions/version/";
    const objects = new Map([
      ["index.m3u8", { key: prefix + "index.m3u8", size: 8, etag: "manifest" }],
      [
        "segment-000001.ts",
        { key: prefix + "segment-000001.ts", size: 10, etag: "segment" },
      ],
    ]);
    for (const object of objects.values())
      native
        .prepare(
          "INSERT INTO objects(key,video_id,version_id,category,bytes,etag,updated_at) VALUES(?,'video','version','hls',?,?,?)",
        )
        .run(object.key, object.size, object.etag, timestamp);
    let failManifest = true;
    env.MEDIA = {
      list: async () => ({ objects: [...objects.values()], truncated: false }),
      head: async (key: string) =>
        [...objects.values()].find((object) => object.key === key) ?? null,
      delete: async (key: string) => {
        if (failManifest && key.endsWith("index.m3u8"))
          throw new Error("temporary failure");
        objects.delete(key.slice(prefix.length));
      },
    } as unknown as R2Bucket;
    const response = await createDeletionPlan(
      request("/plan", {
        videoId: "video",
        kind: "version",
        versionId: "version",
      }),
      env,
    );
    const { plan } = (await response.json()) as { plan: { id: string } };
    const deletionRequest = () =>
      request("/confirm", { confirmation: "DELETE_LISTED_OBJECTS" });
    const partial = await (
      await executeDeletion(deletionRequest(), env, plan.id)
    ).json();
    expect(partial).toMatchObject({ state: "partial", releasedBytes: 10 });
    expect(
      native
        .prepare(
          "SELECT state,validation_json FROM versions WHERE id='version'",
        )
        .get(),
    ).toMatchObject({ state: "deleting", validation_json: null });
    await expect(
      createDeletionPlan(
        request("/plan", { videoId: "video", kind: "source" }),
        env,
      ),
    ).rejects.toMatchObject({ code: "hls_required" });
    failManifest = false;
    expect(
      await (await executeDeletion(deletionRequest(), env, plan.id)).json(),
    ).toMatchObject({ state: "complete", releasedBytes: 18 });
    expect(
      await (await executeDeletion(deletionRequest(), env, plan.id)).json(),
    ).toMatchObject({ state: "complete", releasedBytes: 18 });
    expect(
      native.prepare("SELECT source_key FROM videos WHERE id='video'").get()
        ?.source_key,
    ).toBe("videos/video/source/source");
  });
});
