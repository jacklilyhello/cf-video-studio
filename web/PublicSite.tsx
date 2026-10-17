import { useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  duration,
  HISTORY_TIMEOUT_MS,
  historyForTimeline,
  reloadPlayback,
  recoverWatchRecording,
  WatchProgressQueue,
  useLoad,
  type Config,
  type History,
  type Paged,
  type PublicVideo,
  type WatchRestartReason,
  type HistorySnapshot,
} from "./client";
import {
  Empty,
  ErrorBox,
  Icon,
  Loading,
  Logo,
  Modal,
  Notice,
  Pagination,
} from "./ui";
import { Player } from "./Player";
import { WatchSessionControl } from "./WatchAccess";
import { ThemeToggle, useSiteBrand } from "./public-theme";
import { MoonwaterLandscape } from "./Welcome";

function useDebounce(value: string) {
  const [result, setResult] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setResult(value), 300);
    return () => window.clearTimeout(timer);
  }, [value]);
  return result;
}

export function PublicSite() {
  const brand = useSiteBrand();
  const [search, setSearch] = useState("");
  const query = useDebounce(search);
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState(
    new URLSearchParams(location.search).get("video"),
  );
  const [initialPosition, setInitialPosition] = useState<number | null>(null);
  const [playerRevision, setPlayerRevision] = useState(0);
  const [nativeFallback, setNativeFallback] = useState<{
    videoId: string;
    versionId: string;
  } | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [historyError, setHistoryError] = useState<Error | null>(null);
  const [markSaving, setMarkSaving] = useState(false);
  const [identityUnavailable, setIdentityUnavailable] = useState(false);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyTimedOut, setHistoryTimedOut] = useState(false);
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const [retryingVideo, setRetryingVideo] = useState(false);
  const [playbackRetryError, setPlaybackRetryError] = useState<Error | null>(
    null,
  );
  const retryController = useRef<AbortController | null>(null);
  const recordingRecoveryController = useRef<AbortController | null>(null);
  const [recoveringHistory, setRecoveringHistory] = useState(false);
  const [historyRecoveryError, setHistoryRecoveryError] = useState<
    string | null
  >(null);
  const retryPosition = useRef(0);
  const historyChannel = useRef<BroadcastChannel | null>(null);
  const progressRef = useRef<
    (() => { position: number; duration: number }) | null
  >(null);
  const config = useLoad<Config>("/api/config");
  const catalog = useLoad<Paged<PublicVideo>>(
    `/api/videos?q=${encodeURIComponent(query)}&page=${page}&sort=${sort}`,
  );
  useEffect(() => {
    if (catalog.data && !catalog.loading) setPage(catalog.data.page);
  }, [catalog.data, catalog.loading]);
  const history = useLoad<HistorySnapshot>(
    historyReady ? "/api/history" : null,
    HISTORY_TIMEOUT_MS,
  );
  const selected = useLoad<PublicVideo>(
    selectedId ? `/api/videos/${encodeURIComponent(selectedId)}` : null,
  );
  const progressQueue = useRef<WatchProgressQueue | null>(null);
  if (!progressQueue.current)
    progressQueue.current = new WatchProgressQueue({ onSaved: history.reload });
  useEffect(() => {
    if (history.data)
      progressQueue.current?.setWriteContext(
        history.data.cookieEnabled ? history.data.writeContext : null,
      );
  }, [history.data]);
  useEffect(() => {
    document.title = `${brand.name} · 放映室`;
  }, [brand.name]);
  useEffect(() => {
    api(
      "/api/history/identity",
      { method: "POST", body: "{}" },
      HISTORY_TIMEOUT_MS,
    )
      .catch(() => {
        setIdentityUnavailable(true);
      })
      .finally(() => setHistoryReady(true));
  }, []);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("video-hub-history");
    historyChannel.current = channel;
    channel.onmessage = (event) => {
      if (event.data === "cleared") {
        cancelRecordingRecovery();
        progressQueue.current?.reset();
        setHistoryEpoch((value) => value + 1);
        history.setData({
          items: [],
          cookieEnabled: false,
          writeContext: null,
        });
      } else if (event.data === "ready") history.reload();
    };
    return () => {
      historyChannel.current = null;
      channel.close();
    };
  }, [history.reload, history.setData]);
  function cancelPlaybackRetry() {
    cancelRecordingRecovery();
    retryController.current?.abort();
    retryController.current = null;
    setRetryingVideo(false);
    setPlaybackRetryError(null);
  }
  function cancelRecordingRecovery() {
    recordingRecoveryController.current?.abort();
    recordingRecoveryController.current = null;
    setRecoveringHistory(false);
    setHistoryRecoveryError(null);
  }
  useEffect(() => {
    setPage(1);
  }, [query, sort]);
  useEffect(() => {
    const listener = () => {
      cancelPlaybackRetry();
      setSelectedId(new URLSearchParams(location.search).get("video"));
      setInitialPosition(null);
      setHistoryTimedOut(false);
    };
    window.addEventListener("popstate", listener);
    return () => {
      window.removeEventListener("popstate", listener);
      retryController.current?.abort();
      recordingRecoveryController.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (
      selectedId &&
      selected.data?.id === selectedId &&
      initialPosition === null &&
      (history.data || history.error)
    ) {
      const record = history.data?.items.find(
        (item) =>
          item.videoId === selectedId &&
          item.timelineId === selected.data?.timelineId,
      );
      setInitialPosition(record?.position || 0);
    }
  }, [selectedId, selected.data, initialPosition, history.data, history.error]);
  useEffect(() => {
    if (
      !selectedId ||
      selected.data?.id !== selectedId ||
      initialPosition !== null
    )
      return;
    const timer = window.setTimeout(() => {
      setInitialPosition(0);
      setHistoryTimedOut(true);
    }, HISTORY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [selectedId, selected.data, initialPosition]);
  function select(id: string, position: number | null = null) {
    cancelPlaybackRetry();
    setSelectedId(id);
    setInitialPosition(position);
    setHistoryTimedOut(false);
    window.history.pushState({}, "", `/video?video=${encodeURIComponent(id)}`);
    window.setTimeout(
      () =>
        document
          .getElementById("watch")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      50,
    );
  }
  function closePlayer() {
    cancelPlaybackRetry();
    setSelectedId(null);
    window.history.pushState({}, "", "/video");
  }
  async function clear() {
    cancelRecordingRecovery();
    progressQueue.current?.reset();
    setBusy(true);
    setHistoryError(null);
    try {
      await api("/api/history", { method: "DELETE" }, HISTORY_TIMEOUT_MS);
      setHistoryEpoch((value) => value + 1);
      history.setData({ items: [], cookieEnabled: false, writeContext: null });
      historyChannel.current?.postMessage("cleared");
      try {
        await api(
          "/api/history/identity",
          { method: "POST", body: "{}" },
          HISTORY_TIMEOUT_MS,
        );
        setIdentityUnavailable(false);
      } catch {
        setIdentityUnavailable(true);
      } finally {
        history.reload();
        historyChannel.current?.postMessage("ready");
      }
      setClearOpen(false);
    } catch (error) {
      progressQueue.current?.setWriteContext(undefined);
      setHistoryError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  const items = catalog.data?.items || [];
  const records = history.data?.items || [];
  const currentHistory = records.find((item) => item.videoId === selectedId);
  const timelineHistory = historyForTimeline(
    currentHistory,
    selected.data?.timelineId,
  );
  const timelineChanged =
    !!selected.data &&
    !!currentHistory &&
    selected.data.timelineId !== currentHistory.timelineId;
  const start = initialPosition ?? 0;
  async function retryCurrentVideo(position = retryPosition.current) {
    if (!selectedId || retryingVideo) return;
    cancelRecordingRecovery();
    retryController.current?.abort();
    const controller = new AbortController();
    retryController.current = controller;
    retryPosition.current = position;
    setRetryingVideo(true);
    setPlaybackRetryError(null);
    try {
      const result = await reloadPlayback(
        selectedId,
        selected.data
          ? { timelineId: selected.data.timelineId, position }
          : undefined,
        currentHistory,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (selected.data?.timelineId !== result.video.timelineId)
        progressQueue.current?.reset(history.data?.writeContext ?? null);
      selected.setData(result.video);
      setInitialPosition(result.position);
      setHistoryTimedOut(false);
      setPlayerRevision((value) => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) setPlaybackRetryError(error as Error);
    } finally {
      if (!controller.signal.aborted) setRetryingVideo(false);
    }
  }
  async function recoverHistory(reason: WatchRestartReason, position: number) {
    if (
      !selectedId ||
      !selected.data ||
      busy ||
      recordingRecoveryController.current
    )
      return;
    const controller = new AbortController();
    recordingRecoveryController.current = controller;
    setRecoveringHistory(true);
    setHistoryRecoveryError(null);
    const current = () =>
      recordingRecoveryController.current === controller &&
      !controller.signal.aborted;
    try {
      let cookieRecovery = reason === "cookies_required";
      const recover = (nextReason: WatchRestartReason) =>
        recoverWatchRecording(
          selectedId,
          { timelineId: selected.data!.timelineId, position },
          nextReason,
          controller.signal,
          () => historyChannel.current?.postMessage("cleared"),
        );
      const result = await recover(reason).catch((error: unknown) => {
        if (
          current() &&
          reason === "context_unavailable" &&
          error instanceof ApiError &&
          error.code === "cookies_required"
        ) {
          cookieRecovery = true;
          return recover("cookies_required");
        }
        throw error;
      });
      if (!current()) return;
      const versionChanged =
        selected.data.versionId !== result.video.versionId ||
        selected.data.timelineId !== result.video.timelineId;
      progressQueue.current?.reset(result.history.writeContext);
      history.setData(result.history);
      setHistoryEpoch((value) => value + 1);
      selected.setData(result.video);
      setHistoryError(null);
      setIdentityUnavailable(false);
      if (versionChanged) {
        setInitialPosition(result.position);
        setHistoryTimedOut(false);
        setPlayerRevision((value) => value + 1);
      }
      if (cookieRecovery) historyChannel.current?.postMessage("ready");
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.code === "cookies_required")
        progressQueue.current?.setWriteContext(null);
      else if (
        error instanceof ApiError &&
        error.code === "history_context_unavailable"
      )
        progressQueue.current?.setWriteContext(undefined);
      setHistoryRecoveryError(
        error instanceof ApiError && error.code === "cookies_required"
          ? "浏览器未接受观看记录 Cookie，仍可播放。允许 Cookie 后可重试恢复记录。"
          : error instanceof ApiError && error.code === "video_unavailable"
            ? "视频已下架或暂不可用，现有播放不会被打断。稍后可重试记录恢复。"
            : "观看记录恢复未完成，播放不受影响。请稍后重试。",
      );
    } finally {
      if (current()) {
        recordingRecoveryController.current = null;
        setRecoveringHistory(false);
      }
    }
  }
  function markWatched() {
    if (!selected.data || markSaving) return;
    const captured = progressRef.current?.();
    setHistoryError(null);
    setMarkSaving(true);
    const accepted = progressQueue.current!.enqueue(
      {
        videoId: selected.data.id,
        timelineId: selected.data.timelineId,
        position: Math.min(
          captured?.position ?? timelineHistory?.position ?? 0,
          selected.data.duration || 0,
        ),
        duration: captured?.duration || selected.data.duration || 0,
        playedSeconds: 0,
        watched: true,
      },
      false,
      () => setMarkSaving(false),
    );
    if (!accepted) {
      setMarkSaving(false);
      setHistoryError(new Error("标记尚未保存，请重新开始记录后重试。"));
    }
  }
  return (
    <div className="public-app room-app">
      <a className="skip-link" href="#room-main">
        跳到影片内容
      </a>
      <header className="public-header">
        <div className="public-container header-content">
          <Logo brand={brand} />
          <nav aria-label="主导航">
            <a className="nav-link active" href="/video" aria-current="page">
              放映室
            </a>
            <a className="nav-link" href="#history">
              <Icon name="clock" size={16} />
              <span>观看记录</span>
            </a>
          </nav>
          <WatchSessionControl />
          <ThemeToggle />
        </div>
      </header>
      <main className="public-container" id="room-main">
        {!selectedId && (
          <section className="hero">
            <div className="eyebrow">
              <span className="live-dot" /> YOUR PERSONAL CINEMA
            </div>
            <h1>
              好故事，
              <br className="mobile-only" />
              值得慢慢看。
            </h1>
            <p>收藏喜欢的片刻，让每一次播放都从这里开始。</p>
            <div className="hero-caption">
              <span>
                <Icon name="play" size={14} />
                随心播放
              </span>
              <span>
                <Icon name="clock" size={14} />
                接着上次观看
              </span>
              <span>
                <Icon name="shield" size={14} />
                无需注册
              </span>
            </div>
            <MoonwaterLandscape id="room" compact />
          </section>
        )}
        {selectedId && (
          <section className="watch-section" id="watch">
            <div className="section-heading">
              <button className="text-button" onClick={closePlayer}>
                ← 返回放映室
              </button>
              <span className="eyebrow">NOW PLAYING</span>
            </div>
            {selected.loading || retryingVideo ? (
              <Loading text="正在载入视频…" />
            ) : (playbackRetryError || selected.error) instanceof ApiError &&
              ((playbackRetryError || selected.error) as ApiError).status ===
                404 ? (
              <Empty
                icon="video"
                title="视频不存在或已下架"
                description="可以返回放映室选择其他影片。"
              >
                <a className="button" href="/video">
                  返回放映室
                </a>
              </Empty>
            ) : selected.error || playbackRetryError ? (
              <ErrorBox
                error={playbackRetryError || selected.error}
                retry={
                  playbackRetryError
                    ? () => void retryCurrentVideo()
                    : selected.reload
                }
                publicMessage
              />
            ) : (
              selected.data && (
                <>
                  {initialPosition === null ? (
                    <Loading text="正在核对续播位置…" />
                  ) : (
                    <Player
                      key={`${selected.data.id}:${playerRevision}`}
                      videoId={selected.data.id}
                      versionId={selected.data.versionId}
                      mediaKind={selected.data.mediaKind}
                      sourceProbe={selected.data.sourcePlayback?.probe}
                      sourceEtag={selected.data.sourcePlayback?.etag}
                      sourceBytes={selected.data.sourcePlayback?.bytes}
                      preferNative={
                        nativeFallback?.videoId === selected.data.id &&
                        nativeFallback.versionId === selected.data.versionId
                      }
                      timelineId={selected.data.timelineId}
                      title={selected.data.title}
                      initialPosition={start}
                      saveHistory={
                        history.data?.cookieEnabled === true && !busy
                      }
                      historyEpoch={historyEpoch}
                      interval={config.data?.progressIntervalSeconds}
                      onSaved={history.reload}
                      onRetry={(position, options) => {
                        if (options?.nativeFallback)
                          setNativeFallback({
                            videoId: selected.data!.id,
                            versionId: selected.data!.versionId,
                          });
                        void retryCurrentVideo(position);
                      }}
                      onRecoverHistory={(reason, position) =>
                        void recoverHistory(reason, position)
                      }
                      recoveringHistory={recoveringHistory}
                      historyRecoveryError={historyRecoveryError}
                      saveQueue={progressQueue.current!}
                      progressRef={progressRef}
                    />
                  )}
                  <div className="player-heading">
                    <div>
                      <h1>{selected.data.title}</h1>
                      <p className="muted">
                        {duration(selected.data.duration)}{" "}
                        <span className="separator">·</span>{" "}
                        {timelineHistory?.watched
                          ? "已看过"
                          : start > 0
                            ? `从 ${duration(start)} 继续`
                            : "开始一段新旅程"}
                      </p>
                    </div>
                    <div className="row-actions">
                      <button
                        className="button"
                        onClick={() => {
                          setInitialPosition(0);
                          setPlayerRevision((n) => n + 1);
                        }}
                      >
                        <Icon name="refresh" size={16} />
                        从头播放
                      </button>
                      <button
                        className="button"
                        disabled={
                          !history.data?.cookieEnabled ||
                          !!timelineHistory?.watched ||
                          markSaving
                        }
                        onClick={() => void markWatched()}
                      >
                        <Icon name="check" size={16} />
                        {timelineHistory?.watched
                          ? "已看过"
                          : markSaving
                            ? "等待保存…"
                            : "标记看过"}
                      </button>
                    </div>
                  </div>
                  {timelineChanged && (
                    <Notice>
                      这个视频已更新为新的内容版本，本次将从头播放。
                    </Notice>
                  )}
                  {historyTimedOut && (
                    <Notice>
                      观看记录读取较慢，本次从头播放。稍后返回的旧进度不会打断当前播放。
                    </Notice>
                  )}
                </>
              )
            )}
          </section>
        )}
        {history.data && !history.data.cookieEnabled && (
          <Notice>
            {identityUnavailable
              ? "观看记录暂时不可用。你仍然可以播放视频，稍后重新打开页面可重试保存记录。"
              : "浏览器未接受观看记录 Cookie。你仍然可以播放视频，但无法保存本域名的观看进度。"}
          </Notice>
        )}
        <ErrorBox error={historyError} publicMessage />
        {!!records.length && (
          <section className="history-section" id="history">
            <div className="section-heading">
              <div>
                <span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span>
                <h2>
                  继续观看 <span className="count">{records.length}</span>
                </h2>
              </div>
              <button
                className="text-button"
                onClick={() => setClearOpen(true)}
              >
                <Icon name="trash" size={15} />
                清除记录
              </button>
            </div>
            <div className="history-grid">
              {records.slice(0, 6).map((item) => (
                <button
                  className="history-card"
                  key={item.videoId}
                  onClick={() => select(item.videoId)}
                >
                  <span className="history-play">
                    <Icon name="play" size={19} />
                  </span>
                  <div>
                    <h3>{item.title}</h3>
                    <p>
                      {item.watched
                        ? "已看过"
                        : `看到 ${duration(item.position)}`}{" "}
                      <span> / {duration(item.duration)}</span>
                    </p>
                    <progress
                      value={item.position}
                      max={item.duration || 1}
                      className="progress"
                      aria-label="观看进度"
                    />
                  </div>
                  <Icon name="arrow" size={17} />
                </button>
              ))}
            </div>
          </section>
        )}
        <section className="catalog-section">
          <div className="section-heading catalog-heading">
            <div>
              <span className="eyebrow">THE COLLECTION</span>
              <h2>
                全部视频{" "}
                {catalog.data && (
                  <span className="count">{catalog.data.total}</span>
                )}
              </h2>
            </div>
            <div className="catalog-tools">
              <label className="search">
                <Icon name="search" size={18} />
                <input
                  placeholder="搜索视频…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="搜索视频"
                />
                {search && (
                  <button
                    className="icon-button"
                    aria-label="清空搜索"
                    onClick={() => setSearch("")}
                  >
                    <Icon name="close" size={15} />
                  </button>
                )}
              </label>
              <select
                aria-label="视频排序"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="newest">最近更新</option>
                <option value="title">标题排序</option>
              </select>
            </div>
          </div>
          {catalog.loading ? (
            <Loading text="正在寻找好故事…" />
          ) : catalog.error ? (
            <ErrorBox
              error={catalog.error}
              retry={catalog.reload}
              publicMessage
            />
          ) : !items.length ? (
            <Empty
              title={query ? "没有找到相关视频" : "放映室正在准备中"}
              description={
                query
                  ? "试试其他标题或清空搜索。"
                  : "发布后的影片会出现在这里，稍后再来看看。"
              }
            >
              {query && (
                <button className="button" onClick={() => setSearch("")}>
                  清空搜索
                </button>
              )}
            </Empty>
          ) : (
            <>
              <div className="video-grid">
                {items.map((item, index) => {
                  const record = historyForTimeline(
                    records.find((record) => record.videoId === item.id),
                    item.timelineId,
                  );
                  return (
                    <button
                      className="video-card"
                      key={item.id}
                      onClick={() => select(item.id)}
                    >
                      <div className={`video-cover cover-${index % 5}`}>
                        <div className="cover-orbit" />
                        <span className="cover-number">
                          {String((page - 1) * 12 + index + 1).padStart(2, "0")}
                        </span>
                        <span className="cover-play">
                          <Icon name="play" size={26} />
                        </span>
                        <span className="cover-duration">
                          {duration(item.duration)}
                        </span>
                        {!!record?.watched && (
                          <span className="watched-badge">
                            <Icon name="check" size={12} />
                            已看过
                          </span>
                        )}
                        {!!record && !record.watched && record.duration > 0 && (
                          <progress
                            className="cover-progress"
                            value={record.position}
                            max={record.duration}
                            aria-label="观看进度"
                          />
                        )}
                      </div>
                      <div className="video-info">
                        <h3>{item.title}</h3>
                        <p>
                          {record && !record.watched
                            ? `继续观看 · ${duration(record.position)}`
                            : "点击播放"}
                          <Icon name="arrow" size={16} />
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {!catalog.loading &&
            !catalog.error &&
            catalog.data &&
            catalog.data.total > 0 && (
              <Pagination
                page={page}
                total={catalog.data.total}
                pageSize={catalog.data.pageSize}
                onPage={setPage}
              />
            )}
        </section>
        {!records.length && historyReady && !history.loading && (
          <section id="history" className="history-empty">
            <Icon name="clock" size={17} />
            <p>
              观看后，进度会保存在当前浏览器与域名下。清除 Cookie
              或使用无痕模式会创建新的记录。
            </p>
            {history.data?.cookieEnabled === true && (
              <button
                className="text-button"
                onClick={() => setClearOpen(true)}
              >
                清除当前域名历史
              </button>
            )}
            {history.error && (
              <button className="text-button" onClick={history.reload}>
                重试加载记录
              </button>
            )}
          </section>
        )}
      </main>
      <footer className="public-footer public-container">
        <Logo small brand={brand} />
        <span>好内容，在这里相遇。</span>
        <span>
          {brand.name} <b>· 私人放映室</b>
        </span>
      </footer>
      {clearOpen && (
        <Modal
          title="清除观看记录"
          onClose={() => setClearOpen(false)}
          busy={busy}
        >
          <p>将清除当前浏览器、当前域名下的全部观看记录和续播位置。</p>
          <div className="modal-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => setClearOpen(false)}
            >
              保留记录
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void clear()}
            >
              {busy ? "正在清除…" : "确认清除"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
