import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));
import worker from "../src/index";
import { visitorIdentity } from "../src/auth";
import { clearHistory, getHistory, saveHistory } from "../src/history";
import {
  WatchProgressQueue,
  reloadPlayback,
  type WatchSaveState,
} from "../web/client";
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
const { DatabaseSync } = (await import("node:sqlite" as string)) as {
  DatabaseSync: new (path: string) => NativeDatabase;
};
const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: URL, encoding: string): string;
};
const databases: NativeDatabase[] = [];
const queues: WatchProgressQueue[] = [];
const origin = "https://history-test.example";
const observation = (position: number, playedSeconds: number) => ({
  videoId: "video",
  timelineId: "old-timeline",
  position,
  duration: 40,
  playedSeconds,
});
function queue(writeContext: string) {
  const states: WatchSaveState[] = [];
  const saved = vi.fn();
  const result = new WatchProgressQueue({
    onSaved: saved,
    onState: (state) => states.push(state),
  });
  result.setWriteContext(writeContext);
  queues.push(result);
  return { queue: result, states, saved };
}
async function setup() {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  native.exec(
    readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  native.exec(
    "INSERT INTO videos(id,title,source_revision,source_name,status,published,current_version_id,created_at,updated_at) VALUES('video','Fixture','source','fixture.mp4','ready',1,'old',1,1)",
  );
  native.exec(
    "INSERT INTO versions(id,video_id,prefix,state,mode,quality,duration,timeline_id,created_at) VALUES('old','video','videos/video/versions/old/','verified','probe-remux','source',40,'old-timeline',1),('new','video','videos/video/versions/new/','verified','probe-remux','source',80,'new-timeline',1)",
  );
  const db = {
    prepare(sql: string) {
      const prepared = native.prepare(sql);
      let values: unknown[] = [];
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
          return {
            success: true,
            meta: { changes: Number(prepared.run(...values).changes) },
          };
        },
      };
      return statement;
    },
  };
  const container = vi.fn();
  const env = {
    DB: db,
    APP_ENV: "test",
    SESSION_SECRET: "test-only-history-queue-session-secret-over-32-characters",
    COORDINATOR: {
      idFromName: () => "admission",
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
    PROCESSOR: { get: container },
  } as unknown as Env;
  let cookie = "";
  const bodies: Record<string, unknown>[] = [];
  async function call(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    headers.set("Origin", origin);
    headers.set("Cookie", cookie);
    const request = new Request(origin + path, { ...options, headers });
    let response: Response;
    if (path === "/api/history/identity")
      response = await visitorIdentity(request, env);
    else if (path === "/api/history" && options.method === "DELETE")
      response = await clearHistory(request, env);
    else if (path === "/api/history" && options.method === "POST") {
      bodies.push(JSON.parse(String(options.body)));
      response = await saveHistory(request, env);
    } else if (path === "/api/history")
      response = await getHistory(request, env);
    else
      response = await worker.fetch(request, env, {
        waitUntil: vi.fn(),
      } as unknown as ExecutionContext);
    const issued = response.headers.get("Set-Cookie");
    if (issued)
      cookie = issued.includes("Max-Age=0") ? "" : issued.split(";")[0];
    return response;
  }
  await call("/api/history/identity", { method: "POST", body: "{}" });
  const { writeContext } = (await (await call("/api/history")).json()) as {
    writeContext: string;
  };
  const requests: Promise<Response>[] = [];
  function fetchWith(handler = call) {
    const fetch = vi.fn((path: string, options?: RequestInit) => {
      const request = handler(path, options);
      requests.push(request);
      return request;
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  async function settle() {
    for (let index = 0; index < 5; index++) {
      await Promise.allSettled([...requests]);
      await vi.advanceTimersByTimeAsync(0);
    }
  }
  const row = () => native.prepare("SELECT * FROM watch_history").get();
  const history = async () =>
    (await (await call("/api/history")).json()) as {
      items: unknown[];
      cookieEnabled: boolean;
      writeContext: string | null;
    };
  return {
    native,
    env,
    bodies,
    call,
    fetchWith,
    settle,
    row,
    history,
    container,
    getCookie: () => cookie,
    writeContext,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-14T04:00:00Z"));
});
afterEach(() => {
  for (const pending of queues.splice(0)) pending.reset();
  for (const database of databases.splice(0)) database.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("bounded history saves using the real SQLite/server contract", () => {
  it("allows one request in flight and coalesces unsent increments without losing played time", async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempt = 0;
    const fetch = s.fetchWith(async (path, options) => {
      if (++attempt === 1) await gate;
      return s.call(path, options);
    });
    const { queue: saver } = queue(s.writeContext);
    saver.enqueue(observation(1, 1));
    await vi.advanceTimersByTimeAsync(1000);
    saver.enqueue(observation(2, 1));
    await vi.advanceTimersByTimeAsync(1000);
    saver.enqueue(observation(3, 1));
    expect(fetch).toHaveBeenCalledOnce();
    release();
    await s.settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(s.bodies.map((body) => body.playedSeconds)).toEqual([1, 2]);
    expect(s.row()).toMatchObject({ position: 3, played_seconds: 3 });
  });

  it("retries a failed write with the same event and preserves enough actual watching to mark a completed clip", async () => {
    const s = await setup();
    let attempt = 0;
    const fetch = s.fetchWith((path, options) =>
      ++attempt === 1
        ? Promise.reject(new Error("Network unavailable"))
        : s.call(path, options),
    );
    const { queue: saver } = queue(s.writeContext);
    saver.enqueue(observation(20, 20));
    await s.settle();
    await vi.advanceTimersByTimeAsync(1000);
    await s.settle();
    await vi.advanceTimersByTimeAsync(19000);
    saver.enqueue(observation(40, 20));
    await s.settle();
    expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body);
    expect(s.row()).toMatchObject({
      position: 40,
      played_seconds: 40,
      watched: 1,
    });
  });

  it("does not double count when D1 committed but the first acknowledgement was lost", async () => {
    const s = await setup();
    let attempt = 0;
    const fetch = s.fetchWith(async (path, options) => {
      const response = await s.call(path, options);
      if (++attempt === 1) throw new Error("Acknowledgement lost");
      return response;
    });
    const { queue: saver } = queue(s.writeContext);
    saver.enqueue(observation(20, 20));
    await s.settle();
    expect(s.row()?.played_seconds).toBe(20);
    await vi.advanceTimersByTimeAsync(1000);
    await s.settle();
    expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body);
    expect(s.row()?.played_seconds).toBe(20);
    await vi.advanceTimersByTimeAsync(19000);
    saver.enqueue(observation(40, 20));
    await s.settle();
    expect(s.row()).toMatchObject({ played_seconds: 40, watched: 1 });
  });

  it("times out stalled writes and never overlaps an automatic retry", async () => {
    let active = 0;
    let maximum = 0;
    const fetch = vi.fn(
      (_path: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          active += 1;
          maximum = Math.max(maximum, active);
          options.signal!.addEventListener(
            "abort",
            () => {
              active -= 1;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const { queue: saver, states } = queue("a".repeat(64));
    saver.enqueue(observation(20, 20));
    await vi.advanceTimersByTimeAsync(12000);
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    expect(maximum).toBe(1);
    expect(states.some((state) => state.error && !state.needsRestart)).toBe(
      true,
    );
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
    saver.reset();
    expect(active).toBe(0);
  });

  it("promotes an unacknowledged save to keepalive with its original identity before leaving", async () => {
    const s = await setup();
    let committed!: () => void;
    const firstCommitted = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let attempt = 0;
    const fetch = s.fetchWith(async (path, options) => {
      const response = await s.call(path, options);
      if (++attempt === 1) {
        committed();
        return new Promise<Response>((_resolve, reject) =>
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        );
      }
      return response;
    });
    const { queue: saver } = queue(s.writeContext);
    saver.enqueue(observation(20, 20));
    await firstCommitted;
    saver.flush(true);
    await s.settle();
    expect(fetch.mock.calls[0][1]?.keepalive).toBe(false);
    expect(fetch.mock.calls[1][1]?.keepalive).toBe(true);
    expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body);
    expect(s.row()?.played_seconds).toBe(20);
  });

  it("retains the old video's leave save while serializing a newly selected video's progress", async () => {
    const s = await setup();
    s.native.exec(
      "INSERT INTO videos(id,title,source_revision,source_name,status,published,current_version_id,created_at,updated_at) VALUES('second','Second fixture','source-2','second.mp4','ready',1,'second-version',1,1)",
    );
    s.native.exec(
      "INSERT INTO versions(id,video_id,prefix,state,mode,quality,duration,timeline_id,created_at) VALUES('second-version','second','videos/second/versions/second-version/','verified','probe-remux','source',40,'second-timeline',1)",
    );
    let active = 0;
    let maximum = 0;
    let attempt = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = s.fetchWith(async (path, options) => {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        if (++attempt === 1) await gate;
        return await s.call(path, options);
      } finally {
        active -= 1;
      }
    });
    const { queue: saver } = queue(s.writeContext);
    saver.enqueue(observation(20, 20), true);
    await vi.advanceTimersByTimeAsync(1000);
    saver.enqueue({
      ...observation(1, 1),
      videoId: "second",
      timelineId: "second-timeline",
    });
    expect(fetch).toHaveBeenCalledOnce();
    release();
    await s.settle();
    expect(maximum).toBe(1);
    expect(s.bodies.map((event) => event.videoId)).toEqual(["video", "second"]);
    expect(
      s.native
        .prepare(
          "SELECT video_id,played_seconds FROM watch_history ORDER BY video_id",
        )
        .all(),
    ).toEqual([
      { video_id: "second", played_seconds: 1 },
      { video_id: "video", played_seconds: 20 },
    ]);
  });

  it("splits a delayed observation into the server's bounded increments without dropping watched time", async () => {
    const s = await setup();
    s.native.exec("UPDATE versions SET duration=180 WHERE id='old'");
    s.fetchWith();
    const { queue: saver } = queue(s.writeContext);
    saver.enqueue({ ...observation(20, 20), duration: 180 });
    await s.settle();
    await vi.advanceTimersByTimeAsync(120000);
    saver.enqueue({ ...observation(140, 120), duration: 180 });
    await s.settle();
    expect(s.bodies.map((event) => event.playedSeconds)).toEqual([20, 60, 60]);
    expect(s.row()).toMatchObject({ position: 140, played_seconds: 140 });
  });

  it("orders a manual watched marker after captured playback and confirms it only after its acknowledgement", async () => {
    const s = await setup();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseMarker!: () => void;
    const markerGate = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    let markerCommitted!: () => void;
    const markerWritten = new Promise<void>((resolve) => {
      markerCommitted = resolve;
    });
    let attempt = 0;
    const fetch = s.fetchWith(async (path, options) => {
      const index = ++attempt;
      if (index === 1) await firstGate;
      const response = await s.call(path, options);
      if (index === 1) throw new Error("First acknowledgement lost");
      if (JSON.parse(String(options?.body)).watched) {
        markerCommitted();
        await markerGate;
      }
      return response;
    });
    const { queue: saver } = queue(s.writeContext);
    saver.enqueue(observation(20, 20));
    await vi.advanceTimersByTimeAsync(2000);
    // The player's explicit flush transfers its current increment first.
    saver.enqueue(observation(22, 2));
    const confirmed = vi.fn();
    saver.enqueue({ ...observation(22, 0), watched: true }, false, confirmed);
    expect(fetch).toHaveBeenCalledOnce();
    expect(confirmed).not.toHaveBeenCalled();
    releaseFirst();
    await s.settle();
    await vi.advanceTimersByTimeAsync(1000);
    await markerWritten;
    expect(confirmed).not.toHaveBeenCalled();
    expect(s.row()).toMatchObject({
      position: 22,
      played_seconds: 22,
      watched: 1,
    });
    releaseMarker();
    await s.settle();
    expect(confirmed).toHaveBeenCalledExactlyOnceWith(true);
    expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body);
    expect(s.bodies.map((body) => body.playedSeconds)).toEqual([20, 20, 2, 0]);
  });

  it("rejects an old player's leave writer after reset without blocking the new timeline", async () => {
    const s = await setup();
    const fetch = s.fetchWith();
    const { queue: saver, states } = queue(s.writeContext);
    const oldPlayerWriter = saver.writer();
    saver.reset(s.writeContext);
    s.native.exec(
      "UPDATE videos SET current_version_id='new' WHERE id='video'",
    );
    // Simulates an old React effect cleanup after the replacement data arrived.
    expect(oldPlayerWriter.enqueue(observation(20, 20), true)).toBe(false);
    oldPlayerWriter.flush(true);
    expect(fetch).not.toHaveBeenCalled();
    const currentPlayerWriter = saver.writer();
    currentPlayerWriter.enqueue({
      ...observation(1, 1),
      duration: 80,
      timelineId: "new-timeline",
    });
    await s.settle();
    expect(fetch).toHaveBeenCalledOnce();
    expect(s.row()).toMatchObject({
      timeline_id: "new-timeline",
      played_seconds: 1,
    });
    expect(states.every((state) => !state.needsRestart && !state.error)).toBe(
      true,
    );
  });

  it("drops the old generation on clear and cannot replay it into the replacement visitor cookie", async () => {
    const s = await setup();
    const fetch = s.fetchWith(() => Promise.reject(new Error("Offline")));
    const { queue: saver } = queue(s.writeContext);
    saver.enqueue(observation(20, 20));
    await s.settle();
    saver.reset();
    await s.call("/api/history", { method: "DELETE" });
    await s.call("/api/history/identity", { method: "POST", body: "{}" });
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetch).toHaveBeenCalledOnce();
    expect((await s.history()).items).toHaveLength(0);
    s.fetchWith();
    saver.reset((await s.history()).writeContext);
    saver.enqueue(observation(21, 1));
    await s.settle();
    expect(s.row()).toMatchObject({ position: 21, played_seconds: 1 });
  });

  it("requires an explicit restart after the five-minute window and never re-identifies the uncertain event automatically", async () => {
    const s = await setup();
    const fetch = s.fetchWith(() => Promise.reject(new Error("Offline")));
    const { queue: saver, states } = queue(s.writeContext);
    saver.enqueue(observation(20, 20));
    await s.settle();
    await vi.advanceTimersByTimeAsync(320000);
    expect(states.at(-1)).toMatchObject({ needsRestart: true });
    expect(
      new Set(fetch.mock.calls.map((call) => String(call[1]?.body))).size,
    ).toBe(1);
    const attempts = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(attempts);
    saver.reset();
    s.fetchWith();
    saver.reset((await s.history()).writeContext);
    saver.enqueue(observation(21, 1));
    await s.settle();
    expect(s.row()?.played_seconds).toBe(1);
  });

  it("reloads the actual published version and resets position only when its timeline changed", async () => {
    const s = await setup();
    const fetch = s.fetchWith();
    const old = await reloadPlayback("video", {
      timelineId: "old-timeline",
      position: 17,
    });
    expect(old).toMatchObject({ video: { versionId: "old" }, position: 17 });
    s.native.exec(
      "UPDATE videos SET current_version_id='new' WHERE id='video'",
    );
    const changed = await reloadPlayback("video", {
      timelineId: "old-timeline",
      position: 17,
    });
    expect(changed).toMatchObject({
      video: { versionId: "new", timelineId: "new-timeline" },
      position: 0,
    });
    expect(
      fetch.mock.calls.every(([path]) => path === "/api/videos/video"),
    ).toBe(true);
    expect(s.container).not.toHaveBeenCalled();
    const otherHost = await getHistory(
      new Request("https://other.example/api/history", {
        headers: { Cookie: s.getCookie() },
      }),
      s.env,
    );
    expect(await otherHost.json()).toEqual({
      items: [],
      cookieEnabled: false,
      writeContext: null,
    });
  });
});
