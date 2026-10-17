import { useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  bytes,
  duration,
  type SourceCheck,
  type SourcePreviewEvidence,
  type Version,
  type Video,
} from "./client";
import { Player } from "./Player";
import { SourceMediaDiagnostics } from "./SourceMediaDiagnostics";
import type { SourceStartupTiming } from "./sourceStartupTiming";
import { Loading, Modal, Notice } from "./ui";
import { MediaErrorBox } from "./media-errors";

// The source metadata check has a 90-second deadline; leave response headroom.
const SOURCE_CHECK_TIMEOUT_MS = 100000;
const indexPlacement = {
  "before-media": "前部索引：位于全部媒体数据之前",
  "after-media": "尾部索引：位于全部媒体数据之后",
  "between-media": "中部索引：位于媒体数据之间",
  unknown: "无法确认",
};
const indexReasons = {
  "top-level-scan-unverified": "顶层结构扫描尚未完整核验。",
  "missing-or-duplicate-moov": "未找到唯一的 moov 索引。",
  "media-ranges-unverified": "媒体数据范围尚未完整核验。",
};

export function SourcePreview({
  video,
  onClose,
  onCreated,
}: {
  video: Video;
  onClose: () => void;
  onCreated: (version: Version) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [playerRevision, setPlayerRevision] = useState(0);
  const playerEpoch = useRef(0);
  const opened = useRef({ videoId: video.id, at: performance.now() });
  const lastCheck = useRef<{ videoId: string; revision: number } | null>(null);
  const forceFreshCheck = useRef(false);
  const [startupReason, setStartupReason] = useState("本次打开");
  const [checkTiming, setCheckTiming] = useState<{
    startMs: number;
    endMs: number | null;
    elapsedMs: number | null;
  } | null>(null);
  const [startupTiming, setStartupTiming] =
    useState<SourceStartupTiming | null>(null);
  const [source, setSource] = useState<SourceCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [evidence, setEvidence] = useState<SourcePreviewEvidence | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const started = performance.now();
    if (opened.current.videoId !== video.id)
      opened.current = { videoId: video.id, at: started };
    if (lastCheck.current?.videoId !== video.id)
      forceFreshCheck.current = false;
    const recheck = forceFreshCheck.current;
    lastCheck.current = { videoId: video.id, revision };
    const sinceOpen = () =>
      Math.max(0, Math.round(performance.now() - opened.current.at));
    setCheckTiming({ startMs: sinceOpen(), endMs: null, elapsedMs: null });
    setStartupReason(recheck ? "重新检查后" : "本次打开");
    setStartupTiming(null);
    setPlayerRevision(0);
    playerEpoch.current++;
    setLoading(true);
    setSource(null);
    setError(null);
    setEvidence(null);
    setAcknowledged(false);
    api<{ source: SourceCheck }>(
      `/api/admin/source/${encodeURIComponent(video.id)}/check${recheck ? "" : "?reuse=1"}`,
      { signal: controller.signal },
      SOURCE_CHECK_TIMEOUT_MS,
    )
      .then((result) => {
        if (!controller.signal.aborted) setSource(result.source);
      })
      .catch((failure: Error) => {
        if (!controller.signal.aborted) setError(failure);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setCheckTiming((previous) => ({
            startMs: previous?.startMs ?? 0,
            endMs: sinceOpen(),
            elapsedMs: Math.max(0, Math.round(performance.now() - started)),
          }));
          setLoading(false);
        }
      });
    return () => {
      playerEpoch.current++;
      controller.abort();
    };
  }, [video.id, revision]);
  const evidenceEpoch = playerEpoch.current;
  const index = source?.probe?.index;
  const randomAccessIndex = source?.probe?.fragmented?.randomAccessIndex;
  // Position/codec metadata can be known even when a later track fails.
  // Only the complete current result can authorize a player or a version.
  const inspected =
    source?.videoId === video.id &&
    source.compatible &&
    source.reasons.length === 0;
  const canConfirm =
    inspected &&
    !!evidence?.played &&
    !!evidence.seeked &&
    evidence.durationSeconds > 0 &&
    acknowledged;
  function reloadPlayer() {
    if (busy || !inspected || !source?.previewUrl) return;
    playerEpoch.current++;
    setEvidence(null);
    setAcknowledged(false);
    setStartupTiming(null);
    setStartupReason("重新加载");
    setPlayerRevision((value) => value + 1);
  }
  function requestCheck(fresh = false) {
    if (busy) return;
    playerEpoch.current++;
    setSource(null);
    setEvidence(null);
    setAcknowledged(false);
    setStartupTiming(null);
    setLoading(true);
    forceFreshCheck.current = fresh;
    setRevision((value) => value + 1);
  }
  async function create() {
    if (!source || !evidence || !canConfirm) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ version: Version }>(
        `/api/admin/videos/${encodeURIComponent(video.id)}/source-version`,
        {
          method: "POST",
          body: JSON.stringify({
            sourceEtag: source.etag,
            sourceRevision: source.revision,
            attestation: {
              ...evidence,
              played: true,
              seeked: true,
              audioConfirmed: true,
            },
          }),
        },
        SOURCE_CHECK_TIMEOUT_MS,
      );
      onCreated(result.version);
    } catch (failure) {
      setError(
        (failure instanceof ApiError &&
          ["request_timeout", "request_failed"].includes(failure.code)) ||
          failure instanceof TypeError
          ? new ApiError(
              "建立原片版本的响应未核实；请先刷新视频管理核对已有版本。",
              "source_version_creation_unverified",
              failure instanceof ApiError ? failure.requestId : undefined,
            )
          : (failure as Error),
      );
    } finally {
      setBusy(false);
    }
  }
  const measuredTime = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? `${value} ms`
      : "尚未观察到";
  return (
    <Modal title="原片直接播放预览" wide busy={busy} onClose={onClose}>
      <div className="stack">
        <Notice>
          检查不会改变原片，也不会启动处理或产生转换文件。请播放、拖动并核对声音与画面，再建立可发布的原片版本。
        </Notice>
        <details className="subpanel">
          <summary>播放与检查耗时（技术详情）</summary>
          <strong>本次起播计时 · {startupReason}</strong>
          <dl className="info-list">
            {[
              ["打开至检查开始", measuredTime(checkTiming?.startMs)],
              ["检查请求耗时", measuredTime(checkTiming?.elapsedMs)],
              ["打开至检查完成", measuredTime(checkTiming?.endMs)],
              [
                "结构证明",
                source?.preparation?.structureProof === "persisted"
                  ? "已复用与当前身份匹配的完整证明"
                  : source?.preparation?.structureProof === "fresh"
                    ? "本次完成完整结构校验"
                    : "无法确认",
              ],
              ["服务端准备耗时", measuredTime(source?.preparation?.elapsedMs)],
              ["播放器初始化", measuredTime(startupTiming?.initializedMs)],
              [
                "初始化至元数据就绪",
                measuredTime(startupTiming?.loadedMetadataMs),
              ],
              [
                "初始化至当前帧数据就绪",
                measuredTime(startupTiming?.loadedDataMs),
              ],
              ["初始化至可继续播放", measuredTime(startupTiming?.canPlayMs)],
              [
                "初始化至首次开始播放",
                measuredTime(startupTiming?.firstPlayingMs),
              ],
              [
                "初始化至播放请求",
                measuredTime(startupTiming?.playRequestedMs),
              ],
              [
                "播放请求至首次开始播放",
                measuredTime(
                  startupTiming?.firstPlayingMs != null &&
                    startupTiming.playRequestedMs != null
                    ? startupTiming.firstPlayingMs -
                        startupTiming.playRequestedMs
                    : null,
                ),
              ],
              [
                "初始化至首个视频帧回调",
                measuredTime(startupTiming?.firstFrameMs),
              ],
            ].map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="muted small-text">
            仅记录本次实际观察到的阶段；未触发的事件不估算耗时。初始化至开始播放包含等待播放操作的时间；视频帧回调仅表示提交合成。结构证明复用不代表浏览器媒体缓存命中；媒体缓存冷暖与硬件解码状态仍无法确认。
          </p>
        </details>
        {loading ? (
          <Loading text="正在核对原片身份并进行有界 MP4 元数据校验（最多等待 100 秒）…" />
        ) : (
          <>
            <MediaErrorBox
              error={error}
              stage="check"
              retryLabel="重新检查原片"
              retry={!source ? () => requestCheck() : undefined}
            />
            {source && (
              <>
                <div className="subpanel" role="status">
                  <strong>
                    {inspected ? "原片结构检查已通过" : "原片结构检查尚未通过"}
                  </strong>
                  <p>
                    {inspected
                      ? evidence?.played && evidence.seeked
                        ? "当前浏览器已观察到播放推进和拖动；声音与音画同步仍须管理员亲自核对。"
                        : "可以开始管理员私有预览；当前浏览器的播放、拖动和声音尚未验证。"
                      : "已识别的索引或轨道信息只是部分结果，不能证明整份原片可以直接播放。请按下方原因继续诊断。"}
                  </p>
                  <p className="muted small-text">{video.title}</p>
                </div>
                <details className="subpanel">
                  <summary>原片身份、索引与轨道（技术详情）</summary>
                  <p className="small-text">
                    视频 ID：{source.videoId} · 原片修订：{source.revision}
                    <br />
                    ETag：{source.etag}
                    {source.parserVersion && (
                      <> · 检查器：{source.parserVersion}</>
                    )}
                    {source.checkedAt && (
                      <>
                        {" "}
                        · 本次身份与结构核对时间：
                        {new Date(source.checkedAt).toLocaleString("zh-CN")}
                      </>
                    )}
                  </p>
                  <dl className="info-list">
                    <div>
                      <dt>原片大小</dt>
                      <dd>{bytes(source.bytes)}</dd>
                    </div>
                    <div>
                      <dt>媒体时长</dt>
                      <dd>{duration(source.probe?.durationSeconds)}</dd>
                    </div>
                    <div>
                      <dt>视频</dt>
                      <dd>
                        {source.probe?.width &&
                        source.probe.height &&
                        source.probe.videoCodec
                          ? `${source.probe.width} × ${source.probe.height} · ${source.probe.videoCodec}`
                          : "无法确认"}
                      </dd>
                    </div>
                    <div>
                      <dt>音轨</dt>
                      <dd>
                        {source.probe?.audioCodec === null &&
                        source.probe.audioChannels === 0
                          ? "无音轨（请在预览时核对）"
                          : source.probe?.audioCodec &&
                              source.probe.audioChannels
                            ? `${source.probe.audioCodec} · ${source.probe.audioChannels} 声道`
                            : "无法确认"}
                      </dd>
                    </div>
                    <div>
                      <dt>MP4 索引位置（moov）</dt>
                      <dd>
                        {indexPlacement[index?.placement || "unknown"] ||
                          "无法确认"}
                        {typeof index?.moovOffset === "number" &&
                          Number.isSafeInteger(index.moovOffset) &&
                          index.moovOffset >= 0 && (
                            <small>
                              起始字节偏移{" "}
                              {index.moovOffset.toLocaleString("zh-CN")}
                              （从 0 开始）
                              {typeof index.moovBytes === "number" &&
                                Number.isSafeInteger(index.moovBytes) &&
                                index.moovBytes > 0 && (
                                  <> · 索引大小 {bytes(index.moovBytes)}</>
                                )}
                            </small>
                          )}
                      </dd>
                    </div>
                    <div>
                      <dt>直接播放检查</dt>
                      <dd>
                        {inspected
                          ? "符合当前原片播放范围"
                          : "尚未确认符合当前原片播放范围"}
                      </dd>
                    </div>
                    {source.probe?.fragmented && (
                      <div>
                        <dt>分片 MP4 结构</dt>
                        <dd>
                          已核对 {source.probe.fragmented.fragmentCount}{" "}
                          个片段、
                          {source.probe.fragmented.sampleCount.toLocaleString(
                            "zh-CN",
                          )}{" "}
                          个样本的范围与时间轴
                        </dd>
                      </div>
                    )}
                    {inspected &&
                      source.probe?.nativeEdits?.map((edit) => (
                        <div key={edit.track}>
                          <dt>
                            {edit.track === "video" ? "视频" : "音频"}时间轴
                          </dt>
                          <dd>
                            电影起点 {edit.movieStartSeconds ?? 0} 秒 ·
                            媒体修剪起点 {edit.mediaStartSeconds} 秒 ·
                            保留媒体段 {edit.durationSeconds} 秒
                          </dd>
                        </div>
                      ))}
                    {randomAccessIndex && (
                      <div>
                        <dt>尾部随机访问索引</dt>
                        <dd>
                          {randomAccessIndex.basis === "track-id-compatibility"
                            ? "按轨道兼容定位"
                            : "按片段内轨道顺序定位"}
                          {" · "}
                          {randomAccessIndex.entries.toLocaleString("zh-CN")} 条
                        </dd>
                      </div>
                    )}
                  </dl>
                </details>
                {inspected &&
                  randomAccessIndex?.basis === "track-id-compatibility" && (
                    <Notice>
                      尾部索引采用按轨道兼容定位。请实际播放，重点核对拖动后的声音与画面；结构检查不代表完整解码。
                    </Notice>
                  )}
                {index?.reason && (
                  <p className="muted small-text">
                    {indexReasons[index.reason]}
                  </p>
                )}
                <Notice>
                  {index?.placement === "before-media"
                    ? "索引已在文件开头，无需为了前置索引再次优化。索引位置本身不代表时间轴或浏览器播放已通过。"
                    : index?.placement === "after-media" ||
                        index?.placement === "between-media"
                      ? inspected
                        ? "已核实索引在媒体之后或之间。请先预览；仅在首播确实较慢时评估前置索引无损优化，生成独立文件且不重新编码。云端优化须另取报价并确认 Container 费用。"
                        : "已识别索引位置；它不能解释所有检查失败。先处理下方具体原因，再判断前置索引整理是否有帮助。"
                      : "索引位置尚未核实，暂不能判断前置索引整理是否有帮助。"}
                  {inspected && source.probe?.nativeEdits?.length
                    ? " 此文件的时间轴修剪及轨道延迟已通过结构检查，原生播放器会读取完整编辑列表；原片与音画偏移均保留。实际播放效果仍待浏览器验证。"
                    : ""}
                </Notice>
                {source.reasons.map((reason) => (
                  <MediaErrorBox key={reason} code={reason} stage="check" />
                ))}
                {inspected && source.previewUrl && (
                  <Player
                    key={`${source.revision}:${revision}:${playerRevision}`}
                    videoId={video.id}
                    versionId={source.revision}
                    timelineId={source.revision}
                    title={video.title}
                    mediaKind="source"
                    sourceRevision={source.revision}
                    sourceProbe={source.probe}
                    sourceEtag={source.etag}
                    sourceBytes={source.bytes}
                    mediaUrl={`/api/admin/source/${encodeURIComponent(video.id)}/source.mp4`}
                    preview
                    onPreviewEvidence={(next) => {
                      if (evidenceEpoch === playerEpoch.current)
                        setEvidence(next);
                    }}
                    onStartupTiming={(next) => {
                      if (evidenceEpoch === playerEpoch.current)
                        setStartupTiming(next);
                    }}
                  />
                )}
                {inspected && (
                  <SourceMediaDiagnostics
                    videoId={video.id}
                    sourceRevision={source.revision}
                    size={source.bytes}
                    disabled={busy}
                  />
                )}
                <div className="subpanel">
                  <strong>本次浏览器预览证据</strong>
                  <p>
                    实际播放：
                    {evidence?.played ? "已观察到播放进度" : "等待播放"} ·
                    拖动：
                    {evidence?.seeked
                      ? `已从 ${duration(evidence.seekFromSeconds)} 跳至 ${duration(evidence.seekToSeconds)}`
                      : "请使用播放控件拖动到另一位置"}
                  </p>
                  <p className="muted small-text">
                    这些事件只证明当前浏览器的操作，并由管理员声明核对结果。服务端没有执行完整解码、音画同步或全浏览器兼容性验收。
                  </p>
                </div>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    disabled={busy || !inspected}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  我已实际播放并核对画面、声音（无音轨时核对无音轨）和拖动结果，同意建立共用这份原片文件的播放版本，不新增视频文件。
                </label>
                <Notice>
                  建立版本不会自动发布，也不会替换当前播放版本。后续仍须选择并确认发布；这项结果不会标记为
                  HLS 处理完成。
                </Notice>
                <div className="modal-actions">
                  {inspected && source.previewUrl && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={reloadPlayer}
                    >
                      重新加载播放器
                    </button>
                  )}
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => requestCheck(true)}
                  >
                    重新检查原片
                  </button>
                  <button
                    className="button primary"
                    disabled={busy || !canConfirm}
                    onClick={() => void create()}
                  >
                    {busy ? "正在核对并建立版本…" : "确认预览并建立原片版本"}
                  </button>
                </div>
                {inspected && source.previewUrl && (
                  <p className="muted small-text">
                    重新加载只重开播放器，不重新生成或处理媒体；本次播放、拖动证据和确认勾选将清空。
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
