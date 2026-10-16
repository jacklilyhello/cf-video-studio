import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachPlaybackTelemetry,
  addPlayedRange,
  isAnalyticsAcceptance,
} from "../web/playback-telemetry";

class MemoryStorage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
}
class Media extends EventTarget {
  currentTime = 0;
  duration = 3600;
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  playbackRate = 1;
  emit(name: string) {
    this.dispatchEvent(new Event(name));
  }
  play() {
    this.paused = false;
    this.emit("play");
    this.emit("playing");
  }
  pause() {
    this.paused = true;
    this.emit("pause");
  }
  finish() {
    this.ended = true;
    this.paused = true;
    this.emit("ended");
  }
}
type Snapshot = {
  id: string;
  seq: number;
  started: boolean;
  playing: boolean;
  ended: boolean;
  watchedSeconds: number;
  intervals: [number, number][];
  errors: number;
  stalls: number;
  error: boolean;
  startupMs: number | null;
};
type Session = {
  id: string;
  token: string;
  seq: number;
  watchedSeconds: number;
  intervals: [number, number][];
  started: boolean;
  completed: boolean;
  errors: number;
  stalls: number;
  startupMs: number | null;
  startedAt: number;
};
const cleanups: (() => void)[] = [];
let local: MemoryStorage,
  storage: MemoryStorage,
  documentEvents: EventTarget & { visibilityState: string },
  windowEvents: EventTarget;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-16T04:00:00Z"));
  const base = Date.now();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - base);
  local = new MemoryStorage();
  storage = new MemoryStorage();
  documentEvents = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  windowEvents = new EventTarget();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("window", windowEvents);
  vi.stubGlobal("navigator", { webdriver: false });
  vi.stubGlobal("location", {
    host: "fixture.example",
    pathname: "/video/fixture",
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  const sessions = new Map<string, Session>();
  let failStart = false,
    failEvents = 0;
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    const data = JSON.parse(String(init.body));
    if (path === "/api/analytics/session") {
      if (failStart) throw new Error("offline");
      let session = sessions.get(data.id);
      if (!session) {
        session = {
          id: data.id,
          token: "offline-owner-token",
          seq: 0,
          watchedSeconds: 0,
          intervals: [],
          started: false,
          completed: false,
          errors: 0,
          stalls: 0,
          startupMs: null,
          startedAt: Date.now(),
        };
        sessions.set(data.id, session);
      }
      return Response.json(session);
    }
    if (path === "/api/analytics/event") {
      if (failEvents-- > 0) throw new Error("offline");
      const session = sessions.get(data.id)!;
      if (data.seq > session.seq)
        Object.assign(session, {
          seq: data.seq,
          watchedSeconds: data.watchedSeconds,
          intervals: data.intervals,
          started: data.started,
          completed: data.ended,
          errors: data.errors,
          stalls: data.stalls,
          startupMs: data.startupMs,
        });
      return Response.json({ accepted: true });
    }
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetch);
  const attach = (
    media = new Media(),
    video = "video",
    version = "version",
    preview = false,
  ) => {
    const cleanup = attachPlaybackTelemetry(
      media as unknown as HTMLVideoElement,
      video,
      version,
      { preview },
    );
    cleanups.push(cleanup);
    return { media, cleanup };
  };
  const events = () =>
    fetch.mock.calls
      .filter(([path]) => path === "/api/analytics/event")
      .map(([, init]) => JSON.parse(String(init.body)) as Snapshot);
  const starts = () =>
    fetch.mock.calls
      .filter(([path]) => path === "/api/analytics/session")
      .map(
        ([, init]) =>
          JSON.parse(String(init.body)) as {
            id: string;
            kind: "visit" | "playback";
            videoId: string;
            versionId: string;
            automation: boolean;
          },
      );
  return {
    attach,
    events,
    starts,
    fetch,
    sessions,
    failStart(value = true) {
      failStart = value;
    },
    failEvents(count = 1) {
      failEvents = count;
    },
  };
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}
async function advance(media: Media, seconds: number) {
  for (let n = 0; n < Math.floor(seconds); n++) {
    media.currentTime += media.playbackRate;
    await vi.advanceTimersByTimeAsync(1000);
  }
  const fraction = seconds % 1;
  if (fraction) {
    media.currentTime += fraction * media.playbackRate;
    await vi.advanceTimersByTimeAsync(fraction * 1000);
  }
}

describe("statistics-only acceptance marking", () => {
  it.each([null, "0", "true", "1", "01"])(
    "only enables the explicit session flag for %s",
    (value) => {
      if (value !== null) storage.setItem("vh-analytics-acceptance", value);
      expect(isAnalyticsAcceptance()).toBe(value === "1");
    },
  );
  it("keeps markers within the current origin's tab storage and never reads localStorage", () => {
    storage.setItem("vh-analytics-acceptance", "1");
    local.setItem("vh-analytics-acceptance", "1");
    expect(isAnalyticsAcceptance()).toBe(true);
    vi.stubGlobal("location", {
      host: "other.example",
      pathname: "/video/fixture",
    });
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    expect(isAnalyticsAcceptance()).toBe(false);
    vi.stubGlobal("location", {
      host: "fixture.example",
      pathname: "/video/fixture",
    });
    vi.stubGlobal("sessionStorage", storage);
    expect(isAnalyticsAcceptance()).toBe(true);
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    expect(isAnalyticsAcceptance()).toBe(false);
  });
  it("tolerates missing or blocked storage while preserving webdriver exclusion", () => {
    vi.stubGlobal("sessionStorage", {
      getItem() {
        throw new Error("Storage unavailable");
      },
    });
    expect(isAnalyticsAcceptance()).toBe(false);
    vi.stubGlobal("navigator", { webdriver: true });
    expect(isAnalyticsAcceptance()).toBe(true);
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("sessionStorage", undefined);
    expect(isAnalyticsAcceptance()).toBe(false);
  });
  it("enables and clears the tab marker through explicit acceptance URLs, retaining it across later routes and refreshes", async () => {
    const visit = async (search: string) => {
      vi.stubGlobal("location", {
        host: "fixture.example",
        pathname: "/video/fixture",
        search,
      });
      vi.resetModules();
      const { recordPageVisit } = await import("../web/playback-telemetry");
      await recordPageVisit();
    };
    const f = setup();
    await visit("?acceptance=1");
    expect(storage.getItem("vh-analytics-acceptance")).toBe("1");
    await visit("");
    await visit("?filter=recent");
    expect(f.starts().map((start) => start.automation)).toEqual([
      true,
      true,
      true,
    ]);
    await visit("?acceptance=0");
    expect(storage.getItem("vh-analytics-acceptance")).toBeNull();
    await visit("");
    expect(f.starts().map((start) => start.automation)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
  it.each(["true", "2", "01", ""])(
    "does not interpret acceptance=%s as the dedicated URL control",
    (value) => {
      vi.stubGlobal("location", { search: `?acceptance=${value}` });
      expect(isAnalyticsAcceptance()).toBe(false);
      expect(storage.getItem("vh-analytics-acceptance")).toBeNull();
    },
  );
  it.each(["1", "0"])(
    "reports the explicit acceptance=%s URL even when all storage operations fail",
    async (value) => {
      const blocked = () => {
        throw new Error("Storage unavailable");
      };
      vi.stubGlobal("sessionStorage", {
        getItem: blocked,
        setItem: blocked,
        removeItem: blocked,
      });
      vi.stubGlobal("location", {
        host: "fixture.example",
        pathname: "/video/fixture",
        search: `?acceptance=${value}`,
      });
      const f = setup();
      vi.resetModules();
      const { recordPageVisit } = await import("../web/playback-telemetry");
      await recordPageVisit();
      const { media } = f.attach();
      media.play();
      await settle();
      expect(f.starts()).toHaveLength(2);
      expect(
        f.starts().every((start) => start.automation === (value === "1")),
      ).toBe(true);
      expect(media.paused).toBe(false);
    },
  );
  it.each([false, true])(
    "sends page visits with the current acceptance flag %s",
    async (marked) => {
      const f = setup();
      if (marked) storage.setItem("vh-analytics-acceptance", "1");
      vi.resetModules();
      const { recordPageVisit } = await import("../web/playback-telemetry");
      await recordPageVisit();
      await recordPageVisit();
      expect(f.starts()).toHaveLength(1);
      expect(f.starts()[0]).toMatchObject({
        kind: "visit",
        automation: marked,
      });
    },
  );
  it.each(["session marker", "webdriver", "URL"])(
    "isolates saved playback sessions in both directions for %s",
    async (mode) => {
      const f = setup();
      const normal = f.attach();
      normal.media.play();
      await settle();
      await advance(normal.media, 5);
      normal.cleanup();
      await settle();
      const normalId = f.starts()[0].id;
      const mark = (enabled: boolean) => {
        if (mode === "webdriver")
          vi.stubGlobal("navigator", { webdriver: enabled });
        else if (mode === "URL")
          vi.stubGlobal("location", {
            host: "fixture.example",
            pathname: "/video/fixture",
            search: `?acceptance=${enabled ? "1" : "0"}`,
          });
        else if (enabled) storage.setItem("vh-analytics-acceptance", "1");
        else storage.removeItem("vh-analytics-acceptance");
      };
      mark(true);
      const acceptance = f.attach();
      acceptance.media.play();
      await settle();
      expect(f.starts()[1]).toMatchObject({ automation: true });
      expect(f.starts()[1].id).not.toBe(normalId);
      const acceptanceId = f.starts()[1].id;
      await advance(acceptance.media, 2);
      acceptance.cleanup();
      await settle();
      expect(f.events().at(-1)?.watchedSeconds).toBe(2);
      mark(false);
      const restoredNormal = f.attach();
      restoredNormal.media.play();
      await settle();
      expect(f.starts()[2]).toMatchObject({ id: normalId, automation: false });
      expect(f.events().at(-1)?.watchedSeconds).toBe(5);
      restoredNormal.cleanup();
      await settle();
      mark(true);
      const restoredAcceptance = f.attach();
      restoredAcceptance.media.play();
      await settle();
      expect(f.starts()[3]).toMatchObject({
        id: acceptanceId,
        automation: true,
      });
      expect(f.events().at(-1)?.watchedSeconds).toBe(2);
    },
  );
});

describe("actual media events and batched playback telemetry", () => {
  it("counts an attempt only after a real play event and never on mounting or disposing an unopened player", async () => {
    const f = setup();
    const unopened = f.attach();
    await settle();
    await vi.advanceTimersByTimeAsync(60000);
    unopened.cleanup();
    await settle();
    expect(f.fetch).not.toHaveBeenCalled();
    const actual = f.attach();
    actual.media.paused = false;
    actual.media.emit("play");
    await settle();
    expect(f.starts()).toHaveLength(1);
    expect(f.events()).toHaveLength(0);
    expect([...f.sessions.values()][0].started).toBe(false);
    actual.media.emit("playing");
    await settle();
    expect(f.events().at(-1)?.started).toBe(true);
  });
  it("sends one immediate start and a 30-second batch rather than per-second or per-fragment events", async () => {
    const f = setup();
    const { media } = f.attach();
    await settle();
    media.play();
    await settle();
    expect(f.starts()).toHaveLength(1);
    expect(f.events()).toHaveLength(1);
    expect(f.events()[0]).toMatchObject({
      started: true,
      playing: true,
      watchedSeconds: 0,
      error: false,
    });
    await advance(media, 29);
    expect(f.events()).toHaveLength(1);
    await advance(media, 1);
    expect(f.events()).toHaveLength(2);
    expect(f.events()[1].watchedSeconds).toBe(30);
    expect(f.events()[1].intervals).toEqual([[0, 30]]);
  });
  it("does not count the skipped seek gap, paused time or buffering", async () => {
    const f = setup();
    const { media } = f.attach();
    await settle();
    media.play();
    await settle();
    await advance(media, 5);
    media.seeking = true;
    media.currentTime = 100;
    media.emit("seeking");
    await vi.advanceTimersByTimeAsync(2000);
    media.seeking = false;
    media.emit("seeked");
    await advance(media, 5);
    media.pause();
    await settle();
    expect(f.events().at(-1)?.watchedSeconds).toBe(10);
    expect(f.events().at(-1)?.intervals).toEqual([
      [0, 5],
      [100, 105],
    ]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.events().at(-1)?.watchedSeconds).toBe(10);
    media.play();
    await settle();
    media.readyState = 2;
    media.emit("waiting");
    media.emit("stalled");
    await advance(media, 3);
    media.readyState = 4;
    media.emit("playing");
    await settle();
    await advance(media, 2);
    media.pause();
    await settle();
    expect(f.events().at(-1)).toMatchObject({
      watchedSeconds: 12,
      stalls: 1,
      playing: false,
    });
  });
  it("preserves the last fractional second when pause and ended have already changed native flags", async () => {
    const f = setup();
    const { media } = f.attach();
    await settle();
    media.play();
    await settle();
    await advance(media, 1.4);
    media.pause();
    await settle();
    expect(f.events().at(-1)?.watchedSeconds).toBeCloseTo(1.4);
    media.play();
    await settle();
    await advance(media, 0.3);
    media.finish();
    await settle();
    expect(f.events().at(-1)).toMatchObject({ ended: true, playing: false });
    expect(f.events().at(-1)?.watchedSeconds).toBeCloseTo(1.7);
  });
  it("clears current failure on recovery while preserving cumulative errors, deduplicating native and custom failure signals", async () => {
    const f = setup();
    const { media } = f.attach();
    await settle();
    media.play();
    await settle();
    await advance(media, 2);
    media.emit("error");
    media.emit("vh-playback-error");
    await settle();
    expect(f.events().at(-1)).toMatchObject({
      errors: 1,
      error: true,
      playing: false,
    });
    media.emit("playing");
    await settle();
    await advance(media, 2);
    media.pause();
    await settle();
    expect(f.events().at(-1)).toMatchObject({
      errors: 1,
      error: false,
      watchedSeconds: 4,
    });
    media.emit("playing");
    media.emit("error");
    await settle();
    expect(f.events().at(-1)?.errors).toBe(2);
  });
  it("retains unsent cumulative work through failures and retries without affecting media events", async () => {
    const f = setup();
    const { media } = f.attach();
    await settle();
    media.play();
    await settle();
    f.failEvents();
    await advance(media, 30);
    expect(media.paused).toBe(false);
    expect(f.events().at(-1)?.watchedSeconds).toBe(30);
    await advance(media, 30);
    expect(f.events().at(-1)?.watchedSeconds).toBe(60);
    expect(f.events().at(-1)?.seq).toBeGreaterThan(f.events()[1].seq);
    expect([...f.sessions.values()][0].watchedSeconds).toBe(60);
  });
  it("returns immediately and lets playback continue when session creation and browser storage fail", async () => {
    const f = setup();
    f.failStart();
    vi.stubGlobal("sessionStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    });
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    });
    const { media } = f.attach();
    media.play();
    await settle();
    await advance(media, 31);
    expect(media.paused).toBe(false);
    expect(f.events()).toHaveLength(0);
    f.failStart(false);
    await advance(media, 30);
    media.pause();
    await settle();
    expect(f.events().at(-1)?.watchedSeconds).toBe(61);
  });
  it("uses keepalive for page exit, closes active state and removes listeners on cleanup", async () => {
    const f = setup();
    const { media, cleanup } = f.attach();
    await settle();
    media.play();
    await settle();
    await advance(media, 2.4);
    windowEvents.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(f.events().at(-1)).toMatchObject({ playing: false });
    expect(f.events().at(-1)?.watchedSeconds).toBeCloseTo(2.4);
    const calls = f.fetch.mock.calls.filter(
      ([path]) => path === "/api/analytics/event",
    );
    expect(calls.at(-1)?.[1].keepalive).toBe(true);
    cleanup();
    await settle();
    const before = f.events().length;
    media.play();
    await advance(media, 60);
    expect(f.events()).toHaveLength(before);
  });
  it("does not attach or send administrator preview telemetry", async () => {
    const f = setup();
    const { media } = f.attach(
      new Media(),
      "private-video",
      "private-version",
      true,
    );
    media.play();
    media.emit("error");
    await advance(media, 31);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe("refresh recovery and shared-origin leases", () => {
  it("restores the same session for 30 minutes, preserves local pending work and uses the server sequence floor", async () => {
    const f = setup();
    const first = f.attach();
    await settle();
    first.media.play();
    await settle();
    await advance(first.media, 5);
    f.failEvents();
    first.cleanup();
    await settle();
    const id = f.starts()[0].id;
    const server = f.sessions.get(id)!;
    server.seq = 10;
    server.watchedSeconds = 2;
    server.intervals = [[0, 2]];
    const refreshed = f.attach();
    await settle();
    refreshed.media.currentTime = 5;
    refreshed.media.play();
    await settle();
    await advance(refreshed.media, 1);
    refreshed.media.pause();
    await settle();
    expect(f.starts()[1].id).toBe(id);
    expect(f.events().at(-1)?.id).toBe(id);
    expect(f.events().at(-1)?.seq).toBeGreaterThan(10);
    expect(f.events().at(-1)?.watchedSeconds).toBe(6);
    expect(f.events().at(-1)?.intervals).toEqual([[0, 6]]);
    expect(f.sessions.size).toBe(1);
  });
  it("starts a new session after 30 minutes and isolates different versions", async () => {
    const f = setup();
    const first = f.attach();
    await settle();
    first.media.play();
    await settle();
    first.cleanup();
    await settle();
    await vi.advanceTimersByTimeAsync(30 * 60000 + 1);
    const next = f.attach();
    next.media.play();
    await settle();
    const other = f.attach(new Media(), "video", "other-version");
    other.media.play();
    await settle();
    expect(new Set(f.starts().map((s) => s.id)).size).toBe(3);
  });
  it("uses a fresh owner-bound session after cookie identity changes rather than looping on a stale ID", async () => {
    const f = setup();
    const first = f.attach();
    await settle();
    first.media.play();
    await settle();
    first.cleanup();
    await settle();
    const stale = f.starts()[0].id;
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (path, init) =>
      path === "/api/analytics/session" &&
      JSON.parse(String(init.body)).id === stale
        ? Response.json(
            { error: { code: "analytics_context_changed" } },
            { status: 409 },
          )
        : original(path, init),
    );
    const next = f.attach();
    await settle();
    next.media.play();
    await settle();
    expect(f.starts().at(-1)?.id).not.toBe(stale);
    expect(f.events().at(-1)).toMatchObject({
      started: true,
      watchedSeconds: 0,
    });
  });
  it("does not count two tabs at once and transfers sampling when the current owner pauses", async () => {
    const f = setup();
    const first = f.attach();
    await settle();
    first.media.play();
    await settle();
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    const second = f.attach();
    await settle();
    second.media.play();
    await settle();
    for (let n = 0; n < 5; n++) {
      first.media.currentTime++;
      second.media.currentTime++;
      await vi.advanceTimersByTimeAsync(1000);
    }
    first.media.pause();
    await settle();
    second.media.pause();
    await settle();
    const firstId = f.starts()[0].id,
      secondId = f.starts()[1].id;
    expect(
      f
        .events()
        .filter((e) => e.id === firstId)
        .at(-1)?.watchedSeconds,
    ).toBe(5);
    expect(
      f
        .events()
        .filter((e) => e.id === secondId)
        .at(-1)?.watchedSeconds,
    ).toBe(0);
    second.media.play();
    await settle();
    await advance(second.media, 2);
    second.media.pause();
    await settle();
    expect(
      f
        .events()
        .filter((e) => e.id === secondId)
        .at(-1)?.watchedSeconds,
    ).toBe(2);
  });
});

it("keeps fragmented watch intervals conservative instead of counting skipped gaps", () => {
  const ranges: [number, number][] = [];
  addPlayedRange(ranges, 0, 3);
  addPlayedRange(ranges, 2, 4);
  addPlayedRange(ranges, 90, 100);
  expect(ranges).toEqual([
    [0, 4],
    [90, 100],
  ]);
  for (let n = 0; n < 200; n++)
    addPlayedRange(ranges, 200 + n * 2, 201 + n * 2);
  expect(ranges.length).toBe(128);
  expect(ranges.some(([a, b]) => a === 0 && b === 100)).toBe(false);
});
