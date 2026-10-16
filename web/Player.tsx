import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type RefObject,
} from "react";
import type Hls from "hls.js";
import {
  reportPlaybackFailure,
  reportSourcePreview,
  WatchProgressQueue,
  type WatchSaveState,
  type WatchRestartReason,
  type SourcePreviewEvidence,
  type SourceCheck,
} from "./client";
import { Icon } from "./ui";
import {
  createSourceStartupTiming,
  type SourceStartupTiming,
} from "./sourceStartupTiming";
import { attachFragmentedSourcePlayer } from "./source-mse-player";
import { attachPlaybackTelemetry } from "./playback-telemetry";
import {
  explainMediaError,
  MediaErrorBox,
  type MediaErrorContext,
} from "./media-errors";

type Props = {
  videoId: string;
  versionId: string;
  timelineId: string;
  title: string;
  initialPosition?: number;
  saveHistory?: boolean;
  preview?: boolean;
  mediaKind?: "hls" | "source" | "mp4";
  mediaUrl?: string;
  sourceRevision?: string;
  sourceProbe?: SourceCheck["probe"];
  sourceEtag?: string;
  sourceBytes?: number;
  preferNative?: boolean;
  onPreviewEvidence?: (evidence: SourcePreviewEvidence) => void;
  onStartupTiming?: (timing: SourceStartupTiming) => void;
  interval?: number;
  historyEpoch?: number;
  onSaved?: () => void;
  onRetry?: (position: number, options?: { nativeFallback?: boolean }) => void;
  onRecoverHistory?: (reason: WatchRestartReason, position: number) => void;
  recoveringHistory?: boolean;
  historyRecoveryError?: string | null;
  saveQueue?: WatchProgressQueue;
  progressRef?: RefObject<
    (() => { position: number; duration: number }) | null
  >;
};
export function Player({
  videoId,
  versionId,
  timelineId,
  title,
  initialPosition = 0,
  saveHistory = false,
  preview = false,
  mediaKind = "hls",
  mediaUrl,
  sourceRevision,
  sourceProbe,
  sourceEtag,
  sourceBytes,
  preferNative = false,
  onPreviewEvidence,
  onStartupTiming,
  interval = 20,
  historyEpoch = 0,
  onSaved,
  onRetry,
  onRecoverHistory,
  recoveringHistory = false,
  historyRecoveryError,
  saveQueue,
  progressRef,
}: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const played = useRef(0);
  const lastPosition = useRef<number | null>(null);
  const recording = useRef(false);
  recording.current = saveHistory && !preview;
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  const evidenceCallback = useRef(onPreviewEvidence);
  evidenceCallback.current = onPreviewEvidence;
  const startupCallback = useRef(onStartupTiming);
  startupCallback.current = onStartupTiming;
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (preview || !video.current) return;
    return attachPlaybackTelemetry(video.current, videoId, versionId);
  }, [videoId, versionId, preview, retry]);
  const [buffering, setBuffering] = useState(true);
  const [error, setError] = useState(false);
  const [failedAdapter, setFailedAdapter] = useState(false);
  const [nativeTarget, setNativeTarget] = useState<string | null>(null);
  const [playbackMode, setPlaybackMode] = useState("原生播放器");
  const [saveState, setSaveState] = useState<WatchSaveState>({
    error: null,
    needsRestart: false,
  });
  const [mediaFailure, setMediaFailure] = useState<Omit<
    MediaErrorContext,
    "stage"
  > | null>(null);
  const queue = useRef<WatchProgressQueue | null>(saveQueue ?? null);
  if (!queue.current)
    queue.current = new WatchProgressQueue({
      onSaved: () => savedCallback.current?.(),
    });
  const activeWriter = useRef<{
    writer: ReturnType<WatchProgressQueue["writer"]>;
  } | null>(null);
  useEffect(() => queue.current!.subscribe(setSaveState), []);
  useEffect(() => {
    if (!saveQueue) queue.current?.reset();
    if (activeWriter.current)
      activeWriter.current.writer = queue.current!.writer();
    played.current = 0;
    lastPosition.current = video.current?.currentTime ?? null;
  }, [saveHistory, preview, historyEpoch, saveQueue]);
  const save = useCallback(
    (
      element: HTMLVideoElement,
      identity: { videoId: string; timelineId: string },
      keepalive: boolean,
      writer: ReturnType<WatchProgressQueue["writer"]>,
    ) => {
      if (
        !recording.current ||
        !element ||
        !Number.isFinite(element.duration) ||
        element.duration <= 0
      )
        return;
      const elapsed = played.current;
      played.current = 0;
      const moved =
        lastPosition.current !== null &&
        Math.abs(element.currentTime - lastPosition.current) > 0.01;
      lastPosition.current = element.currentTime;
      if (elapsed > 0 || moved)
        writer.enqueue(
          {
            ...identity,
            position: element.currentTime,
            duration: element.duration,
            playedSeconds: elapsed,
          },
          keepalive,
        );
      else if (keepalive) writer.flush(true);
    },
    [],
  );
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    setError(false);
    setMediaFailure(null);
    setFailedAdapter(false);
    setBuffering(true);
    played.current = 0;
    let hls: Hls | null = null;
    const adapterController = new AbortController();
    let disposeAdapter: (() => void) | undefined;
    let adapterSelected = false;
    let disposed = false;
    const startup =
      preview && mediaKind === "source"
        ? createSourceStartupTiming((timing) =>
            startupCallback.current?.(timing),
          )
        : null;
    let fatalPlaybackError = false;
    const mediaName =
      mediaKind === "source"
        ? "source.mp4"
        : mediaKind === "mp4"
          ? "optimized.mp4"
          : "index.m3u8";
    const url =
      mediaUrl ||
      (preview
        ? `/api/admin/preview/${encodeURIComponent(videoId)}/${encodeURIComponent(versionId)}/${mediaName}`
        : `/media/${encodeURIComponent(videoId)}/${encodeURIComponent(versionId)}/${mediaName}`);
    let evidence: SourcePreviewEvidence = {
      played: false,
      seeked: false,
      durationSeconds: 0,
      seekFromSeconds: 0,
      seekToSeconds: 0,
    };
    let previewPosition = element.currentTime;
    let seekFrom = previewPosition;
    let seekInProgress = false;
    const emitEvidence = () => {
      if (preview && (mediaKind === "source" || mediaKind === "mp4"))
        evidenceCallback.current?.({ ...evidence });
    };
    const sourceReport = (
      phase: Parameters<typeof reportSourcePreview>[0]["phase"],
    ) => {
      if (preview && mediaKind === "source" && sourceRevision)
        void reportSourcePreview({
          videoId,
          sourceRevision,
          phase,
          nativeErrorCode: element.error?.code ?? 0,
          networkState: element.networkState,
          readyState: element.readyState,
          currentTime: element.currentTime,
          duration: element.duration,
        });
    };
    emitEvidence();
    function onLoaded() {
      startup?.mark("loadedmetadata");
      if (initialPosition > 0 && Number.isFinite(element!.duration))
        element!.currentTime = Math.min(
          initialPosition,
          Math.max(0, element!.duration - 1),
        );
      lastPosition.current = element!.currentTime;
      previewPosition = element!.currentTime;
      evidence.durationSeconds = Number.isFinite(element!.duration)
        ? element!.duration
        : 0;
      emitEvidence();
      sourceReport("loadedmetadata");
      setBuffering(false);
    }
    function waiting() {
      setBuffering(true);
      sourceReport("waiting");
    }
    function playing() {
      startup?.mark("playing");
      ready();
      sourceReport("playing");
    }
    function stalled() {
      sourceReport("stalled");
    }
    function ready() {
      setBuffering(false);
      if (!fatalPlaybackError && element!.readyState >= 3 && !element!.error)
        setError(false);
    }
    const loadedData = () => startup?.mark("loadeddata");
    const playRequested = () => startup?.mark("play");
    const canPlay = () => {
      startup?.mark("canplay");
      ready();
    };
    function failed(
      code:
        | "playback_hls_fatal"
        | "playback_hls_unsupported"
        | "playback_loader_failed",
      hlsErrorType?: string,
    ) {
      fatalPlaybackError = true;
      setMediaFailure({ code, hlsErrorType });
      setError(true);
      setBuffering(false);
      if (!preview) element!.dispatchEvent(new Event("vh-playback-error"));
      if (!preview)
        void reportPlaybackFailure({ code, videoId, versionId, hlsErrorType });
    }
    function mediaFailed() {
      if (disposed) return;
      if (adapterSelected) {
        fatalPlaybackError = true;
        setFailedAdapter(true);
        adapterController.abort();
        disposeAdapter?.();
      }
      setError(true);
      setMediaFailure({
        code: "playback_native_error",
        nativeErrorCode: element!.error?.code,
      });
      setBuffering(false);
      sourceReport("error");
      if (!preview)
        void reportPlaybackFailure({
          code: "playback_native_error",
          videoId,
          versionId,
          nativeErrorCode: element!.error?.code,
        });
    }
    const identity = { videoId, timelineId };
    const session = { writer: queue.current!.writer() };
    activeWriter.current = session;
    const flush = () =>
      saveRef.current(element, identity, false, session.writer);
    const leave = () =>
      saveRef.current(element, identity, true, session.writer);
    const captureProgress = () => {
      flush();
      return { position: element.currentTime, duration: element.duration };
    };
    const seeking = () => {
      seekFrom = previewPosition;
      seekInProgress = true;
    };
    const seeked = () => {
      if (
        Number.isFinite(element.duration) &&
        element.duration > 0 &&
        seekFrom >= 0 &&
        seekFrom <= element.duration &&
        element.currentTime >= 0 &&
        element.currentTime <= element.duration &&
        Math.abs(element.currentTime - seekFrom) >=
          Math.min(1, element.duration * 0.2)
      ) {
        evidence = {
          ...evidence,
          seeked: true,
          seekFromSeconds: seekFrom,
          seekToSeconds: element.currentTime,
        };
        emitEvidence();
      }
      previewPosition = element.currentTime;
      seekInProgress = false;
      sourceReport("seeked");
      flush();
    };
    const progress = () => {
      if (
        !element.paused &&
        !element.seeking &&
        !seekInProgress &&
        element.readyState >= 3 &&
        element.currentTime > previewPosition + 0.05
      ) {
        if (!evidence.played) {
          evidence.played = true;
          emitEvidence();
        }
      }
      if (!element.seeking) previewPosition = element.currentTime;
    };
    if (progressRef) progressRef.current = captureProgress;
    element.addEventListener("loadedmetadata", onLoaded);
    element.addEventListener("waiting", waiting);
    element.addEventListener("loadeddata", loadedData);
    element.addEventListener("play", playRequested);
    element.addEventListener("canplay", canPlay);
    element.addEventListener("playing", playing);
    element.addEventListener("stalled", stalled);
    element.addEventListener("error", mediaFailed);
    element.addEventListener("pause", flush);
    element.addEventListener("ended", flush);
    element.addEventListener("seeking", seeking);
    element.addEventListener("seeked", seeked);
    element.addEventListener("timeupdate", progress);
    const frameCallback =
      startup && typeof element.requestVideoFrameCallback === "function"
        ? element.requestVideoFrameCallback(() => {
            if (!disposed) startup.mark("frame");
          })
        : null;
    if (
      mediaKind === "source" &&
      sourceProbe?.fragmented &&
      sourceEtag &&
      Number.isSafeInteger(sourceBytes) &&
      sourceBytes! > 0 &&
      typeof sourceProbe.durationSeconds === "number" &&
      sourceProbe.durationSeconds > 0 &&
      !preferNative &&
      nativeTarget !== `${videoId}:${versionId}`
    ) {
      adapterSelected = true;
      setPlaybackMode("正在准备分片按需播放");
      const adapterFailed = () => {
        if (disposed) return;
        fatalPlaybackError = true;
        setMediaFailure({ code: "playback_mse_failed" });
        setFailedAdapter(true);
        setError(true);
        setBuffering(false);
        if (preview) sourceReport("error");
        else
          void reportPlaybackFailure({
            code: "playback_loader_failed",
            videoId,
            versionId,
          });
      };
      void attachFragmentedSourcePlayer(element, {
        url,
        probe: sourceProbe,
        sourceEtag,
        sourceBytes: sourceBytes!,
        durationSeconds: sourceProbe.durationSeconds,
        signal: adapterController.signal,
        onFatal: adapterFailed,
      })
        .then((result) => {
          if (disposed || adapterController.signal.aborted) {
            if (result.kind === "mse") result.dispose();
            return;
          }
          if (fatalPlaybackError) {
            if (result.kind === "mse") result.dispose();
            return;
          }
          if (result.kind === "unsupported") {
            adapterSelected = false;
            setPlaybackMode("原生播放器");
            element.src = url;
          } else {
            disposeAdapter = result.dispose;
            setPlaybackMode("分片按需播放（MSE）");
          }
        })
        .catch(() => {
          if (!adapterController.signal.aborted) adapterFailed();
        });
    } else if (
      mediaKind === "source" ||
      mediaKind === "mp4" ||
      element.canPlayType("application/vnd.apple.mpegurl")
    ) {
      setPlaybackMode("原生播放器");
      element.src = url;
    } else
      void import("hls.js")
        .then(({ default: Hls }) => {
          if (disposed) return;
          if (!Hls.isSupported()) {
            failed("playback_hls_unsupported");
            return;
          }
          hls = new Hls({
            enableWorker: true,
            xhrSetup(xhr) {
              xhr.withCredentials = true;
            },
          });
          hls.loadSource(url);
          hls.attachMedia(element);
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal && !disposed) {
              failed("playback_hls_fatal", data.type);
              hls?.destroy();
            }
          });
        })
        .catch(() => {
          if (!disposed) failed("playback_loader_failed");
        });
    const tick = window.setInterval(() => {
      if (
        recording.current &&
        !element.paused &&
        !element.ended &&
        element.readyState >= 3 &&
        !element.seeking
      )
        played.current += 1;
    }, 1000);
    const timer = window.setInterval(
      flush,
      Math.max(15, Math.min(30, interval)) * 1000,
    );
    const visibility = () => {
      if (document.visibilityState === "hidden") leave();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", leave);
    return () => {
      disposed = true;
      adapterController.abort();
      disposeAdapter?.();
      startup?.close();
      if (
        frameCallback !== null &&
        typeof element.cancelVideoFrameCallback === "function"
      )
        element.cancelVideoFrameCallback(frameCallback);
      leave();
      if (activeWriter.current === session) activeWriter.current = null;
      if (progressRef?.current === captureProgress) progressRef.current = null;
      window.clearInterval(tick);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", leave);
      element.removeEventListener("loadedmetadata", onLoaded);
      element.removeEventListener("waiting", waiting);
      element.removeEventListener("loadeddata", loadedData);
      element.removeEventListener("play", playRequested);
      element.removeEventListener("canplay", canPlay);
      element.removeEventListener("playing", playing);
      element.removeEventListener("stalled", stalled);
      element.removeEventListener("error", mediaFailed);
      element.removeEventListener("pause", flush);
      element.removeEventListener("ended", flush);
      element.removeEventListener("seeking", seeking);
      element.removeEventListener("seeked", seeked);
      element.removeEventListener("timeupdate", progress);
      hls?.destroy();
      element.removeAttribute("src");
      element.load();
    };
  }, [
    videoId,
    versionId,
    timelineId,
    initialPosition,
    preview,
    retry,
    interval,
    progressRef,
    mediaKind,
    mediaUrl,
    sourceRevision,
    sourceProbe,
    sourceEtag,
    sourceBytes,
    preferNative,
    nativeTarget,
  ]);
  const playbackFailure = mediaFailure
    ? explainMediaError(null, { stage: "preview", ...mediaFailure })
    : null;
  return (
    <>
      <div className="player">
        <video
          ref={video}
          controls
          playsInline
          preload="metadata"
          {...(mediaKind !== "hls" ? { "data-media-kind": mediaKind } : {})}
          aria-label={title}
        />
        {buffering && !error && (
          <div className="player-status" role="status">
            <span className="spinner" />
            正在准备播放…
          </div>
        )}
        {error && (
          <div className="player-error" role="alert">
            <Icon name="film" size={36} />
            <h3>
              {preview && playbackFailure
                ? playbackFailure.title
                : playbackFailure?.category === "browser-path-unsupported"
                  ? "当前浏览器不支持此播放方式"
                  : "暂时无法播放这个视频"}
            </h3>
            <p>
              {preview
                ? "请查看播放器下方的原因、下一步和管理员技术详情。"
                : playbackFailure?.category === "browser-path-unsupported"
                  ? "请使用支持此播放方式的另一款浏览器打开同一视频。"
                  : "请检查网络后重新加载；仍无法播放时联系管理员。"}
            </p>
            {(!playbackFailure ||
              playbackFailure.retryable ||
              failedAdapter) && (
              <button
                className="button primary"
                onClick={() => {
                  if (failedAdapter) setNativeTarget(`${videoId}:${versionId}`);
                  if (onRetry)
                    onRetry(
                      video.current?.currentTime ?? 0,
                      failedAdapter ? { nativeFallback: true } : undefined,
                    );
                  else setRetry((n) => n + 1);
                }}
              >
                <Icon name="refresh" />
                {failedAdapter ? "使用原生播放重试" : "重新加载"}
              </button>
            )}
          </div>
        )}
        {preview && (
          <span className="preview-badge">
            <Icon name="lock" size={14} />
            管理员预览
          </span>
        )}
      </div>
      {preview && error && mediaFailure && (
        <MediaErrorBox stage="preview" {...mediaFailure} />
      )}
      {preview && mediaKind === "source" && (
        <p className="muted small-text" role="status">
          播放方式：{playbackMode}。此状态不代表硬件解码已启用。
        </p>
      )}
      {saveState.error && (
        <p className="muted small-text" role="status">
          {saveState.needsRestart
            ? saveState.error.message
            : "播放正常，观看记录暂未保存，正在保留原事件并重试。"}
          {saveState.needsRestart && (
            <button
              className="text-button"
              disabled={recoveringHistory || !onRecoverHistory}
              onClick={() => {
                if (!recoveringHistory)
                  onRecoverHistory?.(
                    saveState.restartReason ?? "event_expired",
                    video.current?.currentTime ?? 0,
                  );
              }}
            >
              {recoveringHistory ? "正在核对记录…" : "重新开始记录"}
            </button>
          )}
        </p>
      )}
      {historyRecoveryError && (
        <p className="muted small-text" role="status">
          {historyRecoveryError}
        </p>
      )}
    </>
  );
}
