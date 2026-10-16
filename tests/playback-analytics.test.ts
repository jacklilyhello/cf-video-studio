import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startAnalyticsSession,
  acceptAnalyticsSnapshot,
  playbackAnalytics,
  prunePlaybackAnalytics,
  analyticsRange,
  mergeWatchIntervals,
  watchedCoverage,
  parseUserAgent,
} from "../src/playback-analytics";
import { login } from "../src/auth";
import type { Env } from "../src/types";

interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...v: unknown[]): Record<string, unknown> | undefined;
    all(...v: unknown[]): Record<string, unknown>[];
    run(...v: unknown[]): { changes: number | bigint };
  };
  close(): void;
}
const { DatabaseSync } = (await import("node:sqlite" as string)) as {
  DatabaseSync: new (path: string) => NativeDatabase;
};
const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: URL, encoding: string): string;
};
const databases: NativeDatabase[] = [];
const VIDEO = "11111111-1111-4111-8111-111111111111",
  VERSION = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const base = Date.parse("2026-10-16T02:00:00Z");
let clock = base;
beforeEach(() => {
  clock = base;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});
function setup(duration = 100) {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  for (const file of ["0001_initial.sql", "0011_playback_analytics.sql"])
    native.exec(
      readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
    );
  native
    .prepare(
      "INSERT INTO videos(id,title,source_revision,source_name,published,current_version_id,created_at,updated_at) VALUES(?,'Offline analytics fixture','revision','fixture.mp4',1,?,0,0)",
    )
    .run(VIDEO, VERSION);
  native
    .prepare(
      "INSERT INTO versions(id,video_id,prefix,state,mode,quality,timeline_id,duration,created_at) VALUES(?,?,'fixture/','verified','source','source','timeline',?,0)",
    )
    .run(VERSION, VIDEO, duration);
  let race = 0,
    release: () => void = () => {},
    gate = Promise.resolve();
  const DB = {
    prepare(sql: string) {
      const prepared = native.prepare(sql);
      let args: unknown[] = [];
      const s = {
        bind(...v: unknown[]) {
          args = v;
          return s;
        },
        async first() {
          return prepared.get(...args) ?? null;
        },
        async all() {
          return { success: true, results: prepared.all(...args) };
        },
        async run() {
          return s.execute();
        },
        execute() {
          return /^\s*(SELECT|WITH)\b/i.test(sql)
            ? {
                success: true,
                results: prepared.all(...args),
                meta: { changes: 0 },
              }
            : {
                success: true,
                results: [],
                meta: { changes: Number(prepared.run(...args).changes) },
              };
        },
      };
      return s;
    },
    async batch(statements: { execute(): unknown }[]) {
      if (race) {
        if (--race === 0) release();
        await gate;
      }
      native.exec("BEGIN IMMEDIATE");
      try {
        const result = statements.map((s) => s.execute());
        native.exec("COMMIT");
        return result;
      } catch (e) {
        native.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const rate = vi.fn(async () => Response.json({ allowed: true }));
  const env = {
    DB,
    APP_ENV: "test",
    ADMIN_PASSWORD: "offline-password",
    SESSION_SECRET: "offline-analytics-session-secret-32-chars",
    COORDINATOR: { idFromName: () => "rate", get: () => ({ fetch: rate }) },
  } as unknown as Env;
  const request = (
    data: unknown,
    cookie = "",
    host = "fixture.example",
    headers: Record<string, string> = {},
  ) =>
    new Request(`https://${host}/api/analytics/session`, {
      method: "POST",
      headers: {
        Origin: `https://${host}`,
        "Content-Type": "application/json",
        Cookie: cookie,
        ...headers,
      },
      body: JSON.stringify(data),
    });
  const start = async (
    kind = "playback",
    cookie = "",
    id = SESSION,
    headers: Record<string, string> = {},
  ) => {
    const req = request(
      {
        id,
        kind,
        ...(kind === "playback" ? { videoId: VIDEO, versionId: VERSION } : {}),
      },
      cookie,
      "fixture.example",
      headers,
    );
    Object.defineProperty(req, "cf", {
      value: {
        country: "SG",
        region: "Singapore",
        city: "Singapore",
        asn: 13335,
        colo: "LHR",
      },
    });
    const response = await startAnalyticsSession(req, env);
    return {
      data: (await response.json()) as Record<string, unknown>,
      cookie: response.headers.get("Set-Cookie")?.split(";")[0] ?? cookie,
    };
  };
  const event = (
    session: { data: Record<string, unknown>; cookie: string },
    data: Record<string, unknown> = {},
  ) =>
    acceptAnalyticsSnapshot(
      request(
        {
          id: session.data.id,
          token: session.data.token,
          seq: 1,
          started: true,
          playing: true,
          watchedSeconds: 10,
          intervals: [[0, 10]],
          errors: 0,
          stalls: 0,
          ...data,
        },
        session.cookie,
      ),
      env,
    );
  const stats = async (query = "range=today") =>
    (await (
      await playbackAnalytics(
        new Request(
          `https://fixture.example/api/admin/playback-analytics?${query}`,
        ),
        env,
      )
    ).json()) as {
      summary: Record<string, number | null>;
      trend: { day: string; watchedSeconds: number }[];
      sessions: {
        items: Record<string, unknown>[];
        total: number;
        page: number;
      };
      lifetime: Record<string, number>;
      coverage: { note: string };
      hosts: Record<string, unknown>[];
      countries: Record<string, unknown>[];
    };
  return {
    native,
    env,
    rate,
    request,
    start,
    event,
    stats,
    race() {
      race = 2;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
}

describe("trusted playback sessions and privacy", () => {
  it("counts a retried visit once and distinguishes a playback attempt from actual start", async () => {
    const f = setup();
    const visit = await f.start("visit");
    await f.start("visit", visit.cookie);
    const play = await f.start("playback", visit.cookie, crypto.randomUUID());
    expect((await f.stats()).summary).toMatchObject({
      visits: 1,
      visitors: 1,
      attempts: 1,
      plays: 0,
      viewers: 0,
      watchedSeconds: 0,
      startupMs: null,
    });
    expect(play.data).toMatchObject({
      seq: 0,
      watchedSeconds: 0,
      intervals: [],
      started: false,
      completed: false,
    });
  });
  it("uses request host and trusted client geography, retaining only referrer host and no authentication material", async () => {
    const f = setup();
    const session = await f.start("playback", "", SESSION, {
      "CF-Connecting-IP": "2001:db8::1",
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1",
      Referer: "https://outside.example/path?password=should-not-save",
    });
    clock += 10000;
    await f.event(session);
    const stats = await f.stats();
    expect(stats.sessions.items[0]).toMatchObject({
      host: "fixture.example",
      ip: "2001:db8::1",
      country: "SG",
      region: "Singapore",
      city: "Singapore",
      asn: 13335,
      referrer_host: "outside.example",
      browser: "Safari",
      os: "iOS",
      device: "手机",
      video_id: VIDEO,
      version_id: VERSION,
    });
    expect(JSON.stringify(stats)).not.toContain("should-not-save");
    expect(JSON.stringify(stats)).not.toContain(String(session.data.token));
    expect(JSON.stringify(stats)).not.toContain("__Host-vh_visitor");
    expect(JSON.stringify(stats)).not.toContain("LHR");
  });
  it("does not accept another host, cookie identity, token or viewing authorization", async () => {
    const f = setup();
    const session = await f.start();
    clock += 10000;
    const data = { id: SESSION, token: session.data.token, seq: 1 };
    await expect(
      acceptAnalyticsSnapshot(
        f.request(data, session.cookie, "other.example"),
        f.env,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      acceptAnalyticsSnapshot(f.request(data, ""), f.env),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      f.event(session, { token: "bad-token" }),
    ).rejects.toMatchObject({ status: 403 });
    f.native
      .prepare(
        "INSERT INTO settings(key,value,updated_at) VALUES('watch_access_json',?,0)",
      )
      .run(
        JSON.stringify({
          enabled: true,
          revision: 1,
          updatedAt: clock,
          salt: "a".repeat(32),
          digest: "b".repeat(64),
        }),
      );
    await expect(f.event(session)).rejects.toMatchObject({
      code: "watch_required",
    });
    expect((await f.stats()).summary.plays).toBe(0);
  });
  it("rejects telemetry after the video is unpublished", async () => {
    const f = setup();
    const session = await f.start();
    clock += 10000;
    f.native.prepare("UPDATE videos SET published=0").run();
    await expect(f.event(session)).rejects.toMatchObject({
      code: "video_unavailable",
    });
    expect((await f.stats()).summary.plays).toBe(0);
  });
  it("excludes bots, automation and signed administrators while retaining diagnostic sessions", async () => {
    const f = setup();
    const bot = await f.start("playback", "", SESSION, {
      "User-Agent": "HeadlessChrome/100",
    });
    clock += 10000;
    await f.event(bot);
    const admin = await login(
      f.request({ password: "offline-password" }),
      f.env,
    );
    const cookie = admin.headers.get("Set-Cookie")!.split(";")[0];
    const session = await f.start("playback", cookie, crypto.randomUUID());
    clock += 10000;
    await f.event(session);
    expect(bot.data.excluded).toBe(true);
    expect(session.data.excluded).toBe(true);
    expect((await f.stats()).summary).toMatchObject({
      attempts: 0,
      plays: 0,
      watchedSeconds: 0,
    });
    expect(
      f.native.prepare("SELECT COUNT(*) n FROM analytics_sessions").get()?.n,
    ).toBe(2);
  });
  it("does not accept cross-origin starts or write a visit for a context collision", async () => {
    const f = setup();
    const visitor = await f.start("visit");
    const cross = f.request({ id: crypto.randomUUID(), kind: "visit" });
    cross.headers.set("Origin", "https://different.example");
    await expect(startAnalyticsSession(cross, f.env)).rejects.toMatchObject({
      status: 403,
    });
    await expect(f.start("playback", visitor.cookie)).rejects.toMatchObject({
      code: "analytics_context_changed",
    });
    expect((await f.stats()).summary).toMatchObject({ visits: 1, attempts: 0 });
  });
});

describe("idempotent cumulative snapshots and actual watch coverage", () => {
  it("accepts an immediate actual-start event and records no watch time before playback", async () => {
    const f = setup();
    const session = await f.start();
    await f.event(session, {
      watchedSeconds: 0,
      intervals: [],
      startupMs: 100,
    });
    expect((await f.stats()).summary).toMatchObject({
      plays: 1,
      watchedSeconds: 0,
      startupMs: 100,
    });
    clock += 10000;
    await f.event(session, {
      seq: 2,
      watchedSeconds: 0,
      intervals: [],
      playing: false,
    });
    expect((await f.stats()).summary.recentActive).toBe(0);
  });
  it("deduplicates replays and concurrent sequences without double aggregation", async () => {
    const f = setup();
    const session = await f.start();
    clock += 10000;
    f.race();
    const results = await Promise.all([f.event(session), f.event(session)]);
    expect(
      (await Promise.all(results.map((r) => r.json()))).filter(
        (v) => (v as { duplicate?: boolean }).duplicate,
      ),
    ).toHaveLength(1);
    expect((await f.stats()).summary).toMatchObject({
      plays: 1,
      watchedSeconds: 10,
    });
    expect(await (await f.event(session)).json()).toMatchObject({
      accepted: true,
      duplicate: true,
    });
    clock += 10000;
    await f.event(session, {
      seq: 2,
      watchedSeconds: 20,
      intervals: [[0, 20]],
    });
    expect((await f.stats()).summary).toMatchObject({
      plays: 1,
      watchedSeconds: 20,
    });
    const restored = await f.start("playback", session.cookie);
    expect(restored.data).toMatchObject({
      seq: 2,
      watchedSeconds: 20,
      intervals: [[0, 20]],
      started: true,
    });
  });
  it("ignores out-of-order old sequences and preserves the winning cumulative snapshot", async () => {
    const f = setup();
    const session = await f.start();
    clock += 20000;
    await f.event(session, {
      seq: 2,
      watchedSeconds: 20,
      intervals: [[0, 20]],
    });
    await f.event(session, { seq: 1, watchedSeconds: 10 });
    expect((await f.stats()).summary.watchedSeconds).toBe(20);
  });
  it("accepts a valid cumulative retry after a long network outage", async () => {
    const f = setup(1000);
    const session = await f.start();
    clock += 600000;
    await f.event(session, {
      seq: 20,
      watchedSeconds: 600,
      intervals: [[0, 600]],
    });
    expect((await f.stats()).summary.watchedSeconds).toBe(600);
    clock += 1000;
    await f.event(session, {
      seq: 21,
      watchedSeconds: 600,
      intervals: [[0, 600]],
    });
    expect((await f.stats()).summary.watchedSeconds).toBe(600);
  });
  it("does not count a seek to the end as full viewing or completion", async () => {
    const f = setup();
    const session = await f.start();
    clock += 10000;
    await f.event(session, {
      ended: true,
      playing: false,
      watchedSeconds: 10,
      intervals: [
        [0, 5],
        [95, 100],
      ],
    });
    expect((await f.stats()).summary).toMatchObject({
      watchedSeconds: 10,
      completed: 0,
      recentActive: 0,
    });
  });
  it("counts completion only once after at least 90% of actual coverage", async () => {
    const f = setup();
    const session = await f.start();
    clock += 100000;
    await f.event(session, {
      ended: true,
      playing: false,
      watchedSeconds: 95,
      intervals: [[0, 95]],
    });
    clock += 1000;
    await f.event(session, {
      seq: 2,
      ended: true,
      playing: false,
      watchedSeconds: 95,
      intervals: [[0, 95]],
    });
    expect((await f.stats()).summary).toMatchObject({
      plays: 1,
      watchedSeconds: 95,
      completed: 1,
    });
  });
  it.each([
    { started: false, watchedSeconds: 10 },
    { watchedSeconds: 100, intervals: [[0, 100]] },
    { watchedSeconds: 10, intervals: [[0, 100]] },
    { watchedSeconds: -1 },
    { errors: 1.2 },
    { stalls: 10001 },
    { intervals: [[40, 30]] },
  ])("rejects impossible counters or intervals %#", async (patch) => {
    const f = setup();
    const session = await f.start();
    clock += 1000;
    await expect(f.event(session, patch)).rejects.toMatchObject({
      code: "invalid_analytics",
    });
    expect((await f.stats()).summary.plays).toBe(0);
  });
  it("bounds excessive frequency and rate failures without applying an increment", async () => {
    const f = setup();
    const session = await f.start();
    clock += 500;
    expect(await (await f.event(session)).json()).toMatchObject({
      accepted: false,
      reason: "event_window",
    });
    clock += 10000;
    f.rate.mockResolvedValueOnce(
      Response.json({ limited: true }, { status: 429 }),
    );
    await expect(f.event(session)).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect((await f.stats()).summary.watchedSeconds).toBe(0);
  });
});

describe("range boundaries and retention", () => {
  it("splits a reporting batch across Singapore midnight without duplicating full session totals", async () => {
    clock = Date.parse("2026-10-15T15:59:50Z");
    const f = setup();
    const session = await f.start();
    clock += 20000;
    await f.event(session, { watchedSeconds: 20, intervals: [[0, 20]] });
    const today = await f.stats("range=today"),
      week = await f.stats("range=7d");
    expect(today.summary.watchedSeconds).toBeCloseTo(10);
    expect(week.summary.watchedSeconds).toBeCloseTo(20);
    expect(week.trend.map((row) => row.watchedSeconds)).toEqual([10, 10]);
    expect(
      f.native
        .prepare("SELECT SUM(watched_seconds) n FROM analytics_daily")
        .get()?.n,
    ).toBeCloseTo(20);
  });
  it("clamps rolling 24-hour overlap and counts a viewer from an earlier-started session", async () => {
    const f = setup();
    const session = await f.start();
    clock += 20000;
    await f.event(session, { watchedSeconds: 20, intervals: [[0, 20]] });
    clock = base + 86400000 + 10000;
    const stats = await f.stats("range=24h");
    expect(stats.summary.watchedSeconds).toBeCloseTo(10);
    expect(stats.summary.viewers).toBe(1);
    expect(stats.summary.attempts).toBe(0);
    expect(stats.summary.plays).toBe(1);
    expect(
      stats.trend.reduce((n, row) => n + row.watchedSeconds, 0),
    ).toBeCloseTo(10);
  });
  it("filters by actual site host and video without using external referrer as the site", async () => {
    const f = setup();
    const session = await f.start("playback", "", SESSION, {
      Referer: "https://external.example/",
    });
    clock += 10000;
    await f.event(session);
    expect(
      (await f.stats(`range=today&host=external.example`)).summary.plays,
    ).toBe(0);
    expect(
      (await f.stats(`range=today&host=fixture.example&videoId=${VIDEO}`))
        .summary.plays,
    ).toBe(1);
    expect((await f.stats("range=today&page=1.5")).sessions.page).toBe(1);
  });
  it("removes sensitive details and bounded increments after 30 days without clearing permanent aggregates", async () => {
    const f = setup();
    const session = await f.start();
    clock += 10000;
    await f.event(session);
    clock += 31 * 86400000;
    await prunePlaybackAnalytics(f.env);
    expect(
      f.native.prepare("SELECT COUNT(*) n FROM analytics_sessions").get()?.n,
    ).toBe(0);
    expect(
      f.native.prepare("SELECT COUNT(*) n FROM analytics_increments").get()?.n,
    ).toBe(0);
    const stats = await f.stats();
    expect(stats.summary.watchedSeconds).toBe(0);
    expect(stats.lifetime).toMatchObject({
      plays: 1,
      attempts: 1,
      watchedSeconds: 10,
    });
  });
});

it("merges actual watched coverage and parses common browsers without equating edge location to user region", () => {
  const ranges = mergeWatchIntervals(
    [
      [0, 10],
      [5, 20],
      [90, 100],
    ],
    100,
  );
  expect(watchedCoverage(ranges)).toBe(30);
  expect(
    parseUserAgent("Mozilla/5.0 (iPhone) EdgiOS/128 Mobile/15 Safari/604.1"),
  ).toMatchObject({ browser: "Edge", os: "iOS", device: "手机" });
  expect(
    parseUserAgent(
      "Mozilla/5.0 (Macintosh) Version/18.0 Mobile/15 Safari/604.1",
    ),
  ).toMatchObject({ browser: "Safari", os: "iOS", device: "平板" });
  expect(
    analyticsRange("today", Date.parse("2026-10-16T00:01:00+08:00")).start,
  ).toBe(Date.parse("2026-10-16T00:00:00+08:00"));
});
