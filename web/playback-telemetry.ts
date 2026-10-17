// Best-effort cumulative telemetry; playback and history never await it.
export type WatchedRange = [number, number];
const RESTORE_MS = 30 * 60 * 1000;
const SESSION_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 4000;
const LEASE_KEY = "vh-playback-lease";
const ACCEPTANCE_KEY = "vh-analytics-acceptance";
export function isAnalyticsAcceptance() {
  const webdriver =
    typeof navigator !== "undefined" && navigator.webdriver === true;
  let explicit: string | null = null;
  try {
    if (typeof location !== "undefined")
      explicit = new URLSearchParams(location.search).get("acceptance");
  } catch {}
  if (explicit === "1" || explicit === "0") {
    try {
      if (explicit === "1") sessionStorage.setItem(ACCEPTANCE_KEY, "1");
      else sessionStorage.removeItem(ACCEPTANCE_KEY);
    } catch {}
    // The explicit URL still controls this page if persistence is unavailable.
    return webdriver || explicit === "1";
  }
  if (webdriver) return true;
  try {
    return sessionStorage.getItem(ACCEPTANCE_KEY) === "1";
  } catch {
    return false;
  }
}
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);

export function addPlayedRange(
  ranges: WatchedRange[],
  start: number,
  end: number,
) {
  if (!finite(start) || !finite(end) || end <= start) return;
  const next: WatchedRange[] = [...ranges, [start, end] as WatchedRange].sort(
    (a, b) => a[0] - b[0],
  );
  const merged: WatchedRange[] = [];
  for (const range of next) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 0.001)
      last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  // Excessive fragmentation may understate completion; never join skipped gaps.
  const retained =
    merged.length <= 128
      ? merged
      : merged
          .sort((a, b) => b[1] - b[0] - (a[1] - a[0]))
          .slice(0, 128)
          .sort((a, b) => a[0] - b[0]);
  ranges.splice(0, ranges.length, ...retained);
}
function validRanges(value: unknown): value is WatchedRange[] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (range) =>
        Array.isArray(range) &&
        range.length === 2 &&
        finite(range[0]) &&
        finite(range[1]) &&
        range[1] >= range[0],
    )
  );
}
async function post(path: string, data: unknown, keepalive = false) {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(data),
      keepalive,
      signal: keepalive ? undefined : AbortSignal.timeout(8000),
    });
    return {
      status: response.status,
      data: response.ok
        ? ((await response.json()) as Record<string, unknown>)
        : null,
    };
  } catch {
    return { status: 0, data: null };
  }
}
let visitStarted: Promise<unknown> | null = null;
export function recordPageVisit() {
  if (typeof location === "undefined" || location.pathname.startsWith("/admin"))
    return;
  // StrictMode replays share one request. A real navigation is another page visit.
  visitStarted ??= post("/api/analytics/session", {
    id: crypto.randomUUID(),
    kind: "visit",
    automation: isAnalyticsAcceptance(),
  });
  return visitStarted;
}

type Saved = {
  id: string;
  updatedAt: number;
  startedAt: number;
  seq: number;
  watchedSeconds: number;
  intervals: WatchedRange[];
  started: boolean;
  ended: boolean;
  completed: boolean;
  errors: number;
  stalls: number;
  startupMs: number | null;
};
function readSaved(key: string, storage: Storage | null): Saved | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw || raw.length > 16384) return null;
    const value = JSON.parse(raw) as Saved;
    if (
      !uuid(value.id) ||
      !finite(value.updatedAt) ||
      Date.now() < value.updatedAt ||
      Date.now() - value.updatedAt > RESTORE_MS ||
      !finite(value.startedAt) ||
      Date.now() - value.startedAt >= SESSION_MS ||
      !Number.isSafeInteger(value.seq) ||
      value.seq < 0 ||
      !finite(value.watchedSeconds) ||
      value.watchedSeconds > 864000 ||
      !validRanges(value.intervals) ||
      !Number.isSafeInteger(value.errors) ||
      value.errors < 0 ||
      value.errors > 100 ||
      !Number.isSafeInteger(value.stalls) ||
      value.stalls < 0 ||
      value.stalls > 10000 ||
      typeof value.started !== "boolean" ||
      typeof value.ended !== "boolean" ||
      typeof value.completed !== "boolean" ||
      !(value.startupMs === null || finite(value.startupMs))
    ) {
      storage?.removeItem(key);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function attachPlaybackTelemetry(
  element: HTMLVideoElement,
  videoId: string,
  versionId: string,
  options: { preview?: boolean } = {},
) {
  if (options.preview) return () => {};
  const host = typeof location === "undefined" ? "" : location.host;
  const automation = isAnalyticsAcceptance();
  // Preserve ordinary refresh recovery while never restoring its totals or
  // owner-bound ID into an excluded acceptance session (or vice versa).
  const cacheKey = `vh-playback-session${automation ? ":acceptance" : ""}:${JSON.stringify([host, videoId, versionId])}`;
  let storage: Storage | null = null;
  try {
    storage = sessionStorage;
  } catch {}
  const saved = readSaved(cacheKey, storage);
  let id = saved?.id ?? crypto.randomUUID();
  const owner = crypto.randomUUID();
  let credentials: { id: string; token: string } | null = null;
  let attempted = false;
  let heldLease = false;
  let disposed = false,
    starting = false,
    inflight = false,
    flushPending = false;
  let seq = saved?.seq ?? 0,
    watchedSeconds = saved?.watchedSeconds ?? 0;
  let started = saved?.started ?? false,
    ended = saved?.ended ?? false,
    completed = saved?.completed ?? false;
  let errors = saved?.errors ?? 0,
    stalls = saved?.stalls ?? 0,
    startupMs = saved?.startupMs ?? null;
  let startedAt = saved?.startedAt ?? Date.now(),
    requestedAt: number | null = null;
  let activePlaying =
    !element.paused && !element.ended && element.readyState >= 3;
  let failed = false,
    waiting = false,
    seeking = false;
  let lastPosition = element.currentTime,
    lastTick = performance.now();
  const intervals: WatchedRange[] =
    saved?.intervals.map((range) => [...range]) ?? [];
  const persist = () => {
    try {
      storage?.setItem(
        cacheKey,
        JSON.stringify({
          id,
          updatedAt: Date.now(),
          startedAt,
          seq,
          watchedSeconds,
          intervals,
          started,
          ended,
          completed,
          errors,
          stalls,
          startupMs,
        } satisfies Saved),
      );
    } catch {}
  };
  const releaseLease = () => {
    heldLease = false;
    try {
      const lease = JSON.parse(localStorage.getItem(LEASE_KEY) ?? "null");
      if (lease?.owner === owner) localStorage.removeItem(LEASE_KEY);
    } catch {}
  };
  const ownsLease = () => {
    try {
      const raw = localStorage.getItem(LEASE_KEY),
        lease = raw ? JSON.parse(raw) : null;
      if (
        lease &&
        lease.owner !== owner &&
        finite(lease.at) &&
        Date.now() >= lease.at &&
        Date.now() - lease.at < LEASE_MS
      )
        return false;
      localStorage.setItem(
        LEASE_KEY,
        JSON.stringify({ owner, at: Date.now() }),
      );
      return true;
    } catch {
      return true;
    }
  };
  const reset = () => {
    lastTick = performance.now();
    lastPosition = element.currentTime;
  };
  const sample = (boundary = false) => {
    const t = performance.now(),
      position = element.currentTime,
      wall = Math.max(0, (t - lastTick) / 1000),
      delta = position - lastPosition;
    const rate =
      finite(element.playbackRate) && element.playbackRate > 0
        ? Math.min(4, element.playbackRate)
        : 1;
    const eligible =
      !disposed &&
      activePlaying &&
      !failed &&
      !waiting &&
      !seeking &&
      !element.seeking &&
      (boundary ||
        (!element.paused && !element.ended && element.readyState >= 3));
    const owned = eligible && ownsLease();
    if (owned && heldLease && delta > 0 && delta <= wall * rate + 0.25) {
      started = true;
      watchedSeconds += delta;
      addPlayedRange(intervals, lastPosition, position);
      persist();
    }
    heldLease = owned;
    lastTick = t;
    lastPosition = position;
  };
  const fresh = () => {
    id = crypto.randomUUID();
    seq = 0;
    watchedSeconds = 0;
    intervals.splice(0);
    started = activePlaying && !waiting && !failed && heldLease;
    ended = false;
    completed = false;
    errors = 0;
    stalls = 0;
    startupMs = null;
    startedAt = Date.now();
    reset();
    persist();
  };
  const begin = async () => {
    if (!attempted || starting || credentials || disposed) return;
    starting = true;
    try {
      await visitStarted;
      let result = await post("/api/analytics/session", {
        id,
        kind: "playback",
        videoId,
        versionId,
        automation,
      });
      if (disposed) return;
      // A cleared cookie or expired backend session must not trap future telemetry
      // behind an old owner-bound ID. Never transfer old totals to a new session.
      if (
        result.status === 409 ||
        (finite(result.data?.startedAt) &&
          Date.now() - result.data.startedAt >= SESSION_MS)
      ) {
        fresh();
        result = await post("/api/analytics/session", {
          id,
          kind: "playback",
          videoId,
          versionId,
          automation,
        });
      }
      const data = result.data;
      if (
        disposed ||
        !data ||
        !uuid(data.id) ||
        data.id !== id ||
        typeof data.token !== "string"
      )
        return;
      if (Number.isSafeInteger(data.seq) && Number(data.seq) >= 0)
        seq = Math.max(seq, Number(data.seq));
      if (finite(data.watchedSeconds))
        watchedSeconds = Math.max(watchedSeconds, data.watchedSeconds);
      if (validRanges(data.intervals))
        for (const range of data.intervals) addPlayedRange(intervals, ...range);
      if (Number.isSafeInteger(data.errors) && Number(data.errors) >= 0)
        errors = Math.min(100, Math.max(errors, Number(data.errors)));
      if (Number.isSafeInteger(data.stalls) && Number(data.stalls) >= 0)
        stalls = Math.min(10000, Math.max(stalls, Number(data.stalls)));
      started ||= data.started === true;
      completed ||= data.completed === true;
      if (startupMs === null && finite(data.startupMs))
        startupMs = data.startupMs;
      if (finite(data.startedAt)) startedAt = data.startedAt;
      credentials = { id, token: data.token };
      persist();
    } finally {
      starting = false;
      if (!disposed && credentials && flushPending) {
        flushPending = false;
        void flush();
      }
    }
  };
  const flush = async (keepalive = false) => {
    if (!attempted) return;
    sample();
    persist();
    if (!credentials) {
      if (!disposed) {
        flushPending = true;
        void begin();
      }
      return;
    }
    if (inflight && !keepalive) {
      flushPending = true;
      return;
    }
    flushPending = false;
    const playing =
      started &&
      activePlaying &&
      !element.paused &&
      !element.ended &&
      !waiting &&
      !seeking &&
      !failed;
    const snapshot = {
      ...credentials,
      seq: ++seq,
      started,
      ended,
      playing,
      watchedSeconds,
      intervals,
      errors,
      stalls,
      startupMs,
      error: failed,
    };
    persist();
    inflight = true;
    try {
      await post("/api/analytics/event", snapshot, keepalive);
    } finally {
      inflight = false;
      if (!disposed && flushPending) {
        flushPending = false;
        void flush();
      }
    }
  };
  const play = () => {
    attempted = true;
    requestedAt ??= performance.now();
    void begin();
  };
  const playing = () => {
    attempted = true;
    failed = false;
    waiting = false;
    seeking = false;
    ended = false;
    activePlaying = true;
    heldLease = ownsLease();
    if (heldLease) started = true;
    if (startupMs === null && requestedAt !== null)
      startupMs = Math.max(0, performance.now() - requestedAt);
    reset();
    void flush();
  };
  const pause = () => {
    sample(true);
    activePlaying = false;
    releaseLease();
    void flush();
  };
  const seek = () => {
    seeking = true;
    reset();
  };
  const seeked = () => {
    seeking = false;
    heldLease = activePlaying && !waiting && !failed && ownsLease();
    reset();
  };
  const wait = () => {
    sample(true);
    if (!waiting && activePlaying && !element.paused && started)
      stalls = Math.min(10000, stalls + 1);
    waiting = true;
    releaseLease();
    persist();
  };
  const finish = () => {
    sample(true);
    activePlaying = false;
    ended = true;
    releaseLease();
    void flush();
  };
  const fail = () => {
    if (failed) return;
    sample(true);
    failed = true;
    errors = Math.min(100, errors + 1);
    releaseLease();
    void flush();
  };
  const hidden = () => {
    if (document.visibilityState === "hidden") {
      sample();
      void flush(true);
    }
  };
  const leave = () => {
    sample(true);
    activePlaying = false;
    releaseLease();
    void flush(true);
  };
  const listeners: [string, EventListener][] = [
    ["play", play],
    ["playing", playing],
    ["pause", pause],
    ["seeking", seek],
    ["seeked", seeked],
    ["waiting", wait],
    ["stalled", wait],
    ["ended", finish],
    ["error", fail],
    ["vh-playback-error", fail],
  ];
  for (const [event, listener] of listeners)
    element.addEventListener(event, listener);
  const tick = setInterval(() => sample(), 1000),
    heartbeat = setInterval(() => void flush(), 30000);
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("pagehide", leave);
  if (activePlaying) {
    attempted = true;
    ended = false;
    heldLease = ownsLease();
    if (heldLease) started = true;
    void begin();
    void flush();
  }
  return () => {
    if (disposed) return;
    sample(true);
    activePlaying = false;
    disposed = true;
    void flush(true);
    releaseLease();
    clearInterval(tick);
    clearInterval(heartbeat);
    for (const [event, listener] of listeners)
      element.removeEventListener(event, listener);
    document.removeEventListener("visibilitychange", hidden);
    window.removeEventListener("pagehide", leave);
  };
}
