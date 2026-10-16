import { useCallback, useEffect, useRef, useState } from "react";
import type { FragmentedMp4Summary } from "../src/fragmented-mp4";

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public requestId?: string,
    public status?: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T = Record<string, unknown>>(
  path: string,
  options: RequestInit = {},
  timeoutMs?: number,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (typeof options.body === "string")
    headers.set("Content-Type", "application/json");
  const controller = timeoutMs ? new AbortController() : null;
  const externalAbort = () => controller?.abort(options.signal?.reason);
  if (options.signal?.aborted) externalAbort();
  else options.signal?.addEventListener("abort", externalAbort, { once: true });
  let timedOut = false;
  const timer = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers,
      ...(controller ? { signal: controller.signal } : {}),
    });
    const body = (await response.json().catch((error) => {
      if (timedOut || controller?.signal.aborted || options.signal?.aborted)
        throw error;
      return null;
    })) as {
      error?: {
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
      };
      requestId?: string;
    } | null;
    if (
      response.status === 401 &&
      path.startsWith("/api/admin/") &&
      !path.endsWith("/login") &&
      !path.endsWith("/session")
    )
      window.dispatchEvent(new Event("hub-session-expired"));
    if (
      !options.signal?.aborted &&
      !controller?.signal.aborted &&
      /^\/api\/(?:videos(?:[/?]|$)|history(?:[/?]|$)|report(?:[/?]|$))/.test(
        path,
      ) &&
      ((response.status === 401 && body?.error?.code === "watch_required") ||
        (response.status === 503 && body?.error?.code === "watch_unavailable"))
    )
      window.dispatchEvent(new Event("hub-watch-required"));
    if (!response.ok)
      throw new ApiError(
        body?.error?.message || "请求未能完成，请重试。",
        body?.error?.code || "request_failed",
        body?.requestId,
        response.status,
        body?.error?.details,
      );
    return body as T;
  } catch (error) {
    if (timedOut)
      throw new ApiError("请求超时，请稍后重试。", "request_timeout");
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", externalAbort);
  }
}

export function send<T = Record<string, unknown>>(
  path: string,
  body: unknown = {},
  method = "POST",
) {
  return api<T>(path, { method, body: JSON.stringify(body) });
}

type PlaybackFailureCode =
  | "playback_native_error"
  | "playback_hls_fatal"
  | "playback_hls_unsupported"
  | "playback_loader_failed";
type PlaybackFailure = {
  code: PlaybackFailureCode;
  videoId: string;
  versionId: string;
  nativeErrorCode?: number;
  hlsErrorType?: string;
};
const playbackReportCodes = new Set<PlaybackFailureCode>([
  "playback_native_error",
  "playback_hls_fatal",
  "playback_hls_unsupported",
  "playback_loader_failed",
]);
const hlsReportTypes = new Set([
  "networkError",
  "mediaError",
  "keySystemError",
  "muxError",
  "otherError",
]);
const recentPlaybackReports = new Map<string, number>();
let playbackReportTimes: number[] = [];

export function reportPlaybackFailure(report: PlaybackFailure): Promise<void> {
  if (
    !playbackReportCodes.has(report.code) ||
    typeof report.videoId !== "string" ||
    typeof report.versionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(report.videoId) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(report.versionId)
  )
    return Promise.resolve();
  // Rebuild from selected primitives. Media errors may contain URLs, response
  // headers or raw diagnostics; none of those enter this request.
  const payload: PlaybackFailure = {
    code: report.code,
    videoId: report.videoId,
    versionId: report.versionId,
  };
  if (
    report.code === "playback_native_error" &&
    Number.isInteger(report.nativeErrorCode) &&
    report.nativeErrorCode! >= 1 &&
    report.nativeErrorCode! <= 4
  )
    payload.nativeErrorCode = report.nativeErrorCode;
  if (report.code === "playback_hls_fatal")
    payload.hlsErrorType = hlsReportTypes.has(report.hlsErrorType || "")
      ? report.hlsErrorType
      : "otherError";
  const now = Date.now();
  playbackReportTimes = playbackReportTimes.filter(
    (time) => now - time < 60000,
  );
  for (const [key, time] of recentPlaybackReports)
    if (now - time >= 60000) recentPlaybackReports.delete(key);
  const key = JSON.stringify(payload);
  if (playbackReportTimes.length >= 3 || recentPlaybackReports.has(key))
    return Promise.resolve();
  playbackReportTimes.push(now);
  recentPlaybackReports.set(key, now);
  return api(
    "/api/report",
    {
      method: "POST",
      mode: "same-origin",
      keepalive: true,
      body: key,
    },
    4000,
  ).then(
    () => undefined,
    () => undefined,
  );
}

type SourcePlaybackPhase =
  "loadedmetadata" | "playing" | "seeked" | "error" | "stalled" | "waiting";
type SourcePlaybackReport = {
  videoId: string;
  sourceRevision: string;
  phase: SourcePlaybackPhase;
  nativeErrorCode?: number;
  networkState?: number;
  readyState?: number;
  currentTime?: number;
  duration?: number;
};
const sourceReportPhases = new Set<SourcePlaybackPhase>([
  "loadedmetadata",
  "playing",
  "seeked",
  "error",
  "stalled",
  "waiting",
]);
const recentSourceReports = new Map<string, number>();
let sourceReportTimes: number[] = [];
export function reportSourcePreview(
  report: SourcePlaybackReport,
): Promise<void> {
  if (
    typeof report.videoId !== "string" ||
    typeof report.sourceRevision !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(report.videoId) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(report.sourceRevision) ||
    !sourceReportPhases.has(report.phase)
  )
    return Promise.resolve();
  const payload: Record<string, string | number> = {
    sourceRevision: report.sourceRevision,
    phase: report.phase,
  };
  for (const [key, maximum] of [
    ["nativeErrorCode", 4],
    ["networkState", 3],
    ["readyState", 4],
  ] as const) {
    const value = report[key];
    if (Number.isInteger(value) && value! >= 0 && value! <= maximum)
      payload[key] = value!;
  }
  for (const key of ["currentTime", "duration"] as const) {
    const value = report[key];
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 7 * 86400
    )
      payload[key] = value;
  }
  const now = Date.now();
  sourceReportTimes = sourceReportTimes.filter((time) => now - time < 60000);
  for (const [key, time] of recentSourceReports)
    if (now - time >= 60000) recentSourceReports.delete(key);
  const key = JSON.stringify([
    report.videoId,
    report.sourceRevision,
    report.phase,
  ]);
  if (sourceReportTimes.length >= 6 || recentSourceReports.has(key))
    return Promise.resolve();
  sourceReportTimes.push(now);
  recentSourceReports.set(key, now);
  return api(
    `/api/admin/source/${encodeURIComponent(report.videoId)}/playback-report`,
    {
      method: "POST",
      mode: "same-origin",
      keepalive: true,
      body: JSON.stringify(payload),
    },
    4000,
  ).then(
    () => undefined,
    () => undefined,
  );
}

export function useLoad<T>(path: string | null, timeoutMs?: number) {
  const [data, setLoadedData] = useState<T | null>(null);
  const activeLoad = useRef<AbortController | null>(null);
  const loadGeneration = useRef(0);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  const setData = useCallback(
    (value: T | null | ((previous: T | null) => T | null)) => {
      activeLoad.current?.abort();
      activeLoad.current = null;
      loadGeneration.current += 1;
      setLoadedData(value);
      setError(null);
      setLoading(false);
    },
    [],
  );
  useEffect(() => {
    const generation = ++loadGeneration.current;
    if (!path) {
      setLoadedData(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    activeLoad.current = controller;
    setLoading(true);
    setError(null);
    api<T>(path, { signal: controller.signal }, timeoutMs)
      .then((value) => {
        if (!controller.signal.aborted && generation === loadGeneration.current)
          setLoadedData(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted && generation === loadGeneration.current)
          setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === loadGeneration.current)
          setLoading(false);
      });
    return () => controller.abort();
  }, [path, revision, timeoutMs]);
  return { data, error, loading, reload, setData };
}

export function bytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "无法确认";
  if (!value) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const power = Math.min(
    Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)),
    4,
  );
  return `${(value / 1024 ** power).toLocaleString("zh-CN", { maximumFractionDigits: power ? 2 : 0 })} ${units[power]}`;
}
export function date(value: number | string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function duration(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "时长待确认";
  const total = Math.max(0, Math.floor(value));
  return total >= 3600
    ? `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
    : `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
export type PublicVideo = {
  id: string;
  title: string;
  duration: number | null;
  versionId: string;
  timelineId: string;
  updatedAt: number;
  mediaKind?: "source" | "hls" | "mp4";
  mediaName?: "source.mp4" | "index.m3u8" | "optimized.mp4";
  sourcePlayback?: {
    bytes: number;
    etag: string;
    probe: NonNullable<SourceCheck["probe"]>;
  };
};
export type SourcePreviewEvidence = {
  played: boolean;
  seeked: boolean;
  durationSeconds: number;
  seekFromSeconds: number;
  seekToSeconds: number;
};
export type SourceCheck = {
  videoId: string;
  etag: string;
  revision: string;
  bytes: number;
  compatible: boolean;
  parserVersion?: string;
  checkedAt?: number;
  preparation?: {
    structureProof: "persisted" | "fresh";
    elapsedMs: number;
  };
  probe: {
    durationSeconds?: number;
    width?: number;
    height?: number;
    videoCodec?: string;
    audioCodec?: string | null;
    audioChannels?: number;
    nativeEdits?: {
      track: "video" | "audio";
      mediaStartSeconds: number;
      durationSeconds: number;
      movieStartSeconds?: number;
    }[];
    fragmented?: FragmentedMp4Summary;
    index?: {
      basis: "bounded-top-level-box-scan";
      placement: "before-media" | "after-media" | "between-media" | "unknown";
      moovOffset?: number;
      moovBytes?: number;
      reason?:
        | "top-level-scan-unverified"
        | "missing-or-duplicate-moov"
        | "media-ranges-unverified";
    };
  } | null;
  reasons: string[];
  previewUrl?: string;
};
export type History = {
  videoId: string;
  title: string;
  position: number;
  duration: number;
  watched: number | boolean;
  timelineId: string;
  updatedAt: number;
};
export const HISTORY_TIMEOUT_MS = 4000;
export type HistorySnapshot = {
  items: History[];
  cookieEnabled: boolean;
  writeContext: string | null;
};
function validWriteContext(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
const HISTORY_EVENT_MAX_AGE_MS = 5 * 60 * 1000;
export function historyForTimeline(
  record: History | undefined,
  timelineId: string | undefined,
) {
  return record && record.timelineId === timelineId ? record : undefined;
}
export function saveWatchProgress(
  element: Pick<HTMLVideoElement, "currentTime" | "duration">,
  identity: { videoId: string; timelineId: string; writeContext: string },
  playedSeconds: number,
  keepalive = false,
) {
  return postWatchProgress(
    {
      ...identity,
      position: element.currentTime,
      duration: element.duration,
      playedSeconds,
      eventId: crypto.randomUUID(),
      eventAt: Date.now(),
    },
    { keepalive },
  );
}
type WatchObservation = {
  videoId: string;
  timelineId: string;
  position: number;
  duration: number;
  playedSeconds: number;
  eventAt: number;
  writeContext: string;
  watched?: boolean;
};
export type WatchProgressEvent = WatchObservation & { eventId: string };
export type WatchRestartReason =
  | "event_expired"
  | "timeline_changed"
  | "cookies_required"
  | "history_identity_changed"
  | "context_unavailable"
  | "video_unavailable"
  | "invalid_progress";
export type WatchSaveState = {
  error: Error | null;
  needsRestart: boolean;
  restartReason?: WatchRestartReason;
};
function postWatchProgress(
  event: WatchProgressEvent,
  options: { keepalive?: boolean; signal?: AbortSignal } = {},
) {
  return api(
    "/api/history",
    {
      method: "POST",
      ...options,
      body: JSON.stringify(event),
    },
    HISTORY_TIMEOUT_MS,
  );
}

/** Keeps one immutable retry event ahead of coalesced, unsent observations. */
export class WatchProgressQueue {
  private pending: WatchProgressEvent | null = null;
  private pendingSettled?: (saved: boolean) => void;
  private queued: {
    observation: WatchObservation;
    onSettled?: (saved: boolean) => void;
  }[] = [];
  private flight: {
    controller: AbortController;
    generation: number;
    keepalive: boolean;
    promote: boolean;
  } | null = null;
  private generation = 0;
  private background = false;
  private restartRequired = false;
  private attempts = 0;
  private lastEventAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private state: WatchSaveState = { error: null, needsRestart: false };
  private writeContext: string | null = null;
  private listeners = new Set<(state: WatchSaveState) => void>();

  constructor(
    private callbacks: {
      onSaved?: () => void;
      onState?: (state: WatchSaveState) => void;
    } = {},
  ) {}

  subscribe(listener: (state: WatchSaveState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  writer() {
    const generation = this.generation;
    return {
      enqueue: (...args: Parameters<WatchProgressQueue["enqueue"]>) =>
        generation === this.generation && this.enqueue(...args),
      flush: (keepalive = false) => {
        if (generation === this.generation) this.flush(keepalive);
      },
    };
  }

  setWriteContext(context: unknown) {
    if (context !== null && !validWriteContext(context)) {
      this.requireRestart("context_unavailable");
      return;
    }
    if (context === this.writeContext) return;
    if (this.writeContext !== null) {
      this.requireRestart(
        context === null ? "cookies_required" : "history_identity_changed",
      );
      return;
    }
    if (!this.restartRequired) this.writeContext = context;
  }

  enqueue(
    observation: Omit<WatchObservation, "eventAt" | "writeContext">,
    keepalive = false,
    onSettled?: (saved: boolean) => void,
  ) {
    if (
      this.restartRequired ||
      !this.writeContext ||
      !Number.isFinite(observation.position) ||
      !Number.isFinite(observation.duration) ||
      observation.duration <= 0 ||
      !Number.isFinite(observation.playedSeconds) ||
      observation.playedSeconds < 0
    )
      return false;
    let remaining = observation.playedSeconds;
    do {
      const delta = Math.min(60, remaining);
      remaining -= delta;
      const eventAt = Math.max(
        Date.now() - remaining * 1000,
        this.lastEventAt + 1,
      );
      this.lastEventAt = eventAt;
      const next = {
        ...observation,
        playedSeconds: delta,
        eventAt,
        writeContext: this.writeContext,
      };
      const tail = this.queued.at(-1);
      if (
        tail &&
        !tail.onSettled &&
        !onSettled &&
        tail.observation.watched === undefined &&
        next.watched === undefined &&
        tail.observation.videoId === next.videoId &&
        tail.observation.timelineId === next.timelineId &&
        tail.observation.playedSeconds + delta <= 60
      )
        this.queued[this.queued.length - 1] = {
          observation: {
            ...next,
            playedSeconds: tail.observation.playedSeconds + delta,
          },
        };
      else
        this.queued.push({
          observation: next,
          onSettled: remaining === 0 ? onSettled : undefined,
        });
    } while (remaining > 0);
    this.flush(keepalive);
    return true;
  }

  flush(keepalive = false) {
    if (keepalive) {
      this.background = true;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      if (this.flight && !this.flight.keepalive) {
        // Replace the transport, never the event identity: the first request
        // may have reached D1 even when its response was lost.
        this.flight.promote = true;
        this.flight.controller.abort();
      }
    }
    if (!this.retryTimer) this.drain();
  }

  reset(nextContext: string | null = null) {
    if (nextContext !== null && !validWriteContext(nextContext)) {
      this.requireRestart("context_unavailable");
      return;
    }
    this.generation += 1;
    this.flight?.controller.abort();
    this.flight = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.discardConfirmations();
    this.pending = null;
    this.queued = [];
    this.background = false;
    this.restartRequired = false;
    this.attempts = 0;
    this.lastEventAt = 0;
    this.writeContext = nextContext;
    this.publishState({ error: null, needsRestart: false });
  }

  private drain() {
    if (this.flight || this.restartRequired) return;
    if (!this.pending) {
      const entry = this.queued.shift();
      if (!entry) {
        this.background = false;
        return;
      }
      this.pending = { ...entry.observation, eventId: crypto.randomUUID() };
      this.pendingSettled = entry.onSettled;
    }
    if (Date.now() - this.pending.eventAt > HISTORY_EVENT_MAX_AGE_MS) {
      this.requireRestart("event_expired");
      return;
    }
    const event = this.pending;
    const flight = {
      controller: new AbortController(),
      generation: this.generation,
      keepalive: this.background,
      promote: false,
    };
    this.flight = flight;
    let succeeded = false;
    void postWatchProgress(event, {
      keepalive: flight.keepalive,
      signal: flight.controller.signal,
    })
      .then(() => {
        if (flight.generation !== this.generation || this.restartRequired)
          return;
        succeeded = true;
        this.pending = null;
        const settled = this.pendingSettled;
        this.pendingSettled = undefined;
        this.attempts = 0;
        this.publishState({ error: null, needsRestart: false });
        this.callbacks.onSaved?.();
        settled?.(true);
      })
      .catch((error: Error) => {
        if (
          flight.generation !== this.generation ||
          flight.promote ||
          this.restartRequired
        )
          return;
        if (
          Date.now() - event.eventAt > HISTORY_EVENT_MAX_AGE_MS ||
          (error instanceof ApiError &&
            [
              "invalid_progress",
              "timeline_changed",
              "video_unavailable",
              "cookies_required",
              "history_identity_changed",
            ].includes(error.code))
        ) {
          this.requireRestart(
            Date.now() - event.eventAt > HISTORY_EVENT_MAX_AGE_MS
              ? "event_expired"
              : ((error as ApiError).code as WatchRestartReason),
          );
          return;
        }
        this.publishState({ error, needsRestart: false });
        this.attempts += 1;
      })
      .finally(() => {
        if (this.flight !== flight) return;
        this.flight = null;
        if (flight.generation !== this.generation || this.restartRequired)
          return;
        if (succeeded || flight.promote) this.drain();
        else {
          this.retryTimer = setTimeout(
            () => {
              this.retryTimer = null;
              this.drain();
            },
            Math.min(20000, 1000 * 2 ** Math.min(4, this.attempts - 1)),
          );
        }
      });
  }

  private requireRestart(reason: WatchRestartReason) {
    this.restartRequired = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.discardConfirmations();
    this.publishState({
      error: new ApiError(
        reason === "timeline_changed"
          ? "视频版本已更新，请重新核对当前版本后恢复记录。此前未确认片段可能不完整。"
          : reason === "cookies_required"
            ? "观看记录 Cookie 已失效。恢复时会核验当前域名的新身份，并丢弃旧访客未确认片段。"
            : reason === "history_identity_changed"
              ? "当前域名的访客身份已改变。请明确恢复记录；旧访客未确认片段不会迁移到新身份。"
              : reason === "context_unavailable"
                ? "观看记录身份数据暂时无法核验。请稍后重试恢复；现有播放不受影响。"
                : "未确认记录已超出安全重试范围，或视频已不可用。重新开始记录后，此前未确认片段可能不完整。",
        "history_restart_required",
      ),
      needsRestart: true,
      restartReason: reason,
    });
  }

  private discardConfirmations() {
    this.pendingSettled?.(false);
    this.pendingSettled = undefined;
    for (const entry of this.queued) {
      entry.onSettled?.(false);
      entry.onSettled = undefined;
    }
  }

  private publishState(state: WatchSaveState) {
    this.state = state;
    this.callbacks.onState?.(state);
    for (const listener of this.listeners) listener(state);
  }
}

export async function reloadPlayback(
  videoId: string,
  previous?: { timelineId: string; position: number },
  history?: History,
  signal?: AbortSignal,
) {
  const video = await api<PublicVideo>(
    `/api/videos/${encodeURIComponent(videoId)}`,
    { signal },
    10000,
  );
  const position =
    previous?.timelineId === video.timelineId
      ? previous.position
      : (historyForTimeline(history, video.timelineId)?.position ?? 0);
  return {
    video,
    position: Number.isFinite(position)
      ? Math.max(0, Math.min(position, video.duration ?? position))
      : 0,
  };
}
export async function recoverWatchRecording(
  videoId: string,
  previous: { timelineId: string; position: number },
  reason: WatchRestartReason,
  signal: AbortSignal,
  beforeIdentity?: () => void,
) {
  const { video } = await reloadPlayback(videoId, previous, undefined, signal);
  if (signal.aborted) throw new DOMException("已取消", "AbortError");
  if (reason === "cookies_required") {
    beforeIdentity?.();
    await api(
      "/api/history/identity",
      { method: "POST", body: "{}", signal },
      HISTORY_TIMEOUT_MS,
    );
  }
  if (signal.aborted) throw new DOMException("已取消", "AbortError");
  const history = await api<HistorySnapshot>(
    "/api/history",
    { signal },
    HISTORY_TIMEOUT_MS,
  );
  if (signal.aborted) throw new DOMException("已取消", "AbortError");
  if (history.cookieEnabled !== true)
    throw new ApiError(
      "浏览器未接受观看记录 Cookie，仍可播放。允许 Cookie 后可重试恢复记录。",
      "cookies_required",
    );
  if (!validWriteContext(history.writeContext))
    throw new ApiError(
      "观看记录身份尚未核实，请稍后重试。",
      "history_context_unavailable",
    );
  const record = history.items.find((item) => item.videoId === videoId);
  const position =
    previous.timelineId === video.timelineId
      ? previous.position
      : (historyForTimeline(record, video.timelineId)?.position ?? 0);
  return {
    video,
    history,
    position: Number.isFinite(position)
      ? Math.max(0, Math.min(position, video.duration ?? position))
      : 0,
  };
}
export type Video = {
  id: string;
  title: string;
  source_key: string | null;
  source_size: number;
  source_revision: string;
  source_name: string;
  status: string;
  published: number;
  current_version_id: string | null;
  created_at: number;
  updated_at: number;
  probe_json: string | null;
};
export type Version = {
  id: string;
  video_id: string;
  prefix: string;
  state: string;
  mode: string;
  quality: string;
  manifest: string | null;
  bytes: number;
  duration: number | null;
  timeline_id: string;
  validation_json: string | null;
  created_at: number;
};
export type Job = {
  id: string;
  video_id: string;
  version_id: string;
  state: string;
  stage: string;
  progress_json: string | null;
  error: string | null;
  started_at: number | null;
  deadline_at: number | null;
  stop_verified: number;
  stop_evidence_json: string | null;
  consumption_json: string | null;
  created_at: number;
  updated_at: number;
};
export type UploadPart = {
  number: number;
  size: number;
  sha256: string;
  etag: string;
};
export type Upload = {
  id: string;
  video_id: string;
  fingerprint: string;
  expected_size: number;
  state: string;
  reserved_bytes: number;
  expires_at: number;
  created_at: number;
  updated_at: number;
  error: string | null;
  parts?: UploadPart[];
};
export type Paged<T> = {
  items: T[];
  page: number;
  total: number;
  pageSize: number;
};
export type Config = {
  configured: boolean;
  env: string;
  processingEnabled: boolean;
  progressIntervalSeconds: number;
  buildCommit?: string;
};
export const stateNames: Record<string, string> = {
  uploading: "上传中",
  uploaded: "待处理",
  unprocessed: "待处理",
  unpublished: "未发布",
  published: "已发布",
  ready: "可播放",
  verified: "已校验",
  complete: "已完成",
  completed: "已完成",
  succeeded: "处理成功",
  open: "待确认",
  running: "运行中",
  starting: "启动中",
  queued: "排队中",
  failed: "失败",
  cancelled: "已取消",
  canceled: "已取消",
  expired: "已过期",
  needs_confirmation: "等待再次确认",
  timed_out: "已超时",
  awaiting_confirmation: "等待再次确认",
  stopped: "已停止",
  stopping: "停止核验中",
  stop_unverified: "停止尚未核实",
  upload_cancelled: "上传已取消",
  objects_missing: "对象缺失",
  completing: "正在核实上传完成",
  creating: "正在建立上传",
  unknown: "结果尚未核实",
  pending: "待执行",
  present: "存在",
  missing: "缺失",
  needs_transcode: "需要重新编码",
  probe_remux: "探测与无损封装",
  "probe-remux": "探测与无损封装",
  transcode: "重新编码",
  faststart: "MP4 无损优化（faststart）",
  "copy-only": "仅复制码流（不重新编码）",
  source: "原分辨率",
  version: "播放版本",
  video: "整部视频",
  current_hls: "当前 HLS",
  historical_hls: "历史 HLS",
  mp4: "优化 MP4 产物",
  current_mp4: "当前优化 MP4",
  historical_mp4: "历史优化 MP4",
  failed_output: "失败产物",
  downloading: "下载原片",
  probing: "媒体探测",
  processing: "视频处理",
  validating: "产物校验",
  uploading_output: "上传产物",
};
export const label = (value: string) => stateNames[value] || value;
