import { useEffect, useState } from "react";
import {
  ApiError,
  api,
  bytes,
  date,
  label,
  send,
  useLoad,
  type Paged,
} from "./client";
import "./storage.css";
import {
  Badge,
  Empty,
  ErrorBox,
  Icon,
  Loading,
  Modal,
  Notice,
  Pagination,
} from "./ui";

export type DeleteRequest = {
  kind: "source" | "version" | "video" | "failed";
  videoId?: string;
  versionId?: string;
  preservePlayback?: boolean;
  removeDependencies?: boolean;
};
type StoredVersion = {
  id: string;
  mode: string;
  state: string;
  bytes: number;
  fileCount: number;
  current: boolean;
  usesSource: boolean;
  createdAt: number;
};
type StoredVideo = {
  id: string;
  title: string;
  source_name: string;
  source_key: string | null;
  sourceBytes: number;
  generatedBytes: number;
  reservedBytes: number;
  published: number;
  versions: StoredVersion[];
};
type DeletePlan = {
  id: string;
  kind: DeleteRequest["kind"];
  videoId: string;
  videoTitle?: string;
  versionId: string | null;
  versionIds?: string[];
  dependencyVersionIds?: string[];
  preservePlayback?: boolean;
  removeDependencies?: boolean;
  retainedVersionId?: string | null;
  sourceReferenceOnly?: boolean;
  requiresUnpublish: boolean;
  warning: string;
  state: string;
  expiresAt: number;
  expired?: boolean;
  noAction?: boolean;
  totalBytes: number;
  releasedBytes: number;
  remainingCount: number;
  remainingBytes?: number;
  objects: { key: string; bytes: number; state: string; missing?: boolean }[];
  failures: { key: string; error: string }[];
};
type ActivePlan = {
  id: string;
  kind: DeleteRequest["kind"];
  videoId: string;
  videoTitle: string;
  state: string;
  expired: boolean;
  remainingCount: number;
  releasedBytes: number;
  createdAt: number;
};
const names = {
  source: "删除原片",
  version: "删除选定版本",
  video: "彻底删除视频",
  failed: "清理失败生成文件",
};
function deletionTarget(target: DeleteRequest | DeletePlan): DeleteRequest {
  return {
    kind: target.kind,
    videoId: target.videoId,
    versionId: target.versionId || undefined,
    preservePlayback: target.preservePlayback,
    removeDependencies: target.removeDependencies,
  };
}
function versionName(version: StoredVersion) {
  return version.mode === "source"
    ? "原片直接播放"
    : version.mode === "faststart"
      ? "优化 MP4"
      : version.mode === "transcode"
        ? "转码 HLS"
        : "无损 HLS";
}
function FileDetails({ videoId }: { videoId: string }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const files = useLoad<Paged<{ key: string; bytes: number; state: string }>>(
    open
      ? `/api/admin/storage?q=${encodeURIComponent(videoId)}&page=${page}`
      : null,
  );
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>技术文件详情</summary>
      {open &&
        (files.loading ? (
          <Loading />
        ) : files.error ? (
          <ErrorBox error={files.error} />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>文件路径</th>
                    <th>大小</th>
                  </tr>
                </thead>
                <tbody>
                  {files.data?.items.map((file) => (
                    <tr key={file.key}>
                      <td className="object-path mono">{file.key}</td>
                      <td>{bytes(file.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {files.data && (
              <Pagination
                page={page}
                total={files.data.total}
                pageSize={files.data.pageSize}
                onPage={setPage}
              />
            )}
          </>
        ))}
    </details>
  );
}
export function Storage() {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [planPage, setPlanPage] = useState(1);
  const [request, setRequest] = useState<DeleteRequest | null>(null);
  const [resuming, setResuming] = useState<ActivePlan | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<{
    checked: number;
    missing: number;
    hasMore: boolean;
    nextCursor: string | null;
  } | null>(null);
  const storage = useLoad<
    Paged<StoredVideo> & {
      summary: {
        sourceBytes: number;
        generatedBytes: number;
        reservedBytes: number;
        otherBytes?: number;
      };
    }
  >(
    `/api/admin/storage?view=videos&q=${encodeURIComponent(query)}&page=${page}`,
  );
  const plans = useLoad<Paged<ActivePlan>>(
    `/api/admin/storage/plans?page=${planPage}`,
  );
  useEffect(() => {
    if (!plans.data || plans.loading) return;
    const last = Math.max(1, Math.ceil(plans.data.total / plans.data.pageSize));
    if (planPage > last) setPlanPage(last);
  }, [plans.data, plans.loading, planPage]);
  function refresh() {
    storage.reload();
    plans.reload();
  }
  async function cancel(planId: string) {
    setBusy(true);
    setError(null);
    try {
      await send(
        `/api/admin/storage/plans/${encodeURIComponent(planId)}/cancel`,
        {},
      );
      plans.reload();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  async function reconcile() {
    setBusy(true);
    setError(null);
    try {
      const next = await send<{
        checked: number;
        missing: number;
        hasMore: boolean;
        nextCursor: string | null;
      }>("/api/admin/storage/reconcile", {
        cursor: reconcileResult?.hasMore ? reconcileResult.nextCursor : "",
      });
      setReconcileResult((previous) => ({
        ...next,
        checked: next.checked + (previous?.hasMore ? previous.checked : 0),
        missing: next.missing + (previous?.hasMore ? previous.missing : 0),
      }));
      storage.reload();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack storage-page">
      <Notice>
        按视频管理原片和生成文件。删除前会检查实际文件和播放影响；文件没有回收站。成功原片与生成版本不会自动清理。
      </Notice>
      {storage.data && (
        <div className="storage-summary">
          {[
            ["上传的原片", storage.data.summary.sourceBytes],
            ["生成文件", storage.data.summary.generatedBytes],
            ["上传预留", storage.data.summary.reservedBytes],
            ...(storage.data.summary.otherBytes
              ? [["网站图片", storage.data.summary.otherBytes]]
              : []),
          ].map(([title, value]) => (
            <div className="stat-card" key={String(title)}>
              <small>{title}</small>
              <strong>{bytes(Number(value))}</strong>
            </div>
          ))}
        </div>
      )}
      <ErrorBox error={error} />
      <div className="panel">
        <div className="toolbar">
          <label className="search">
            <Icon name="search" size={18} />
            <input
              aria-label="搜索视频存储"
              placeholder="搜索视频名称或文件名…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <button
            className="button"
            disabled={busy}
            onClick={() => void reconcile()}
          >
            {busy
              ? "正在核对…"
              : reconcileResult?.hasMore
                ? "继续核对文件"
                : "核对文件是否存在"}
          </button>
        </div>
        {reconcileResult && (
          <Notice>
            已检查 {reconcileResult.checked} 个登记文件，发现{" "}
            {reconcileResult.missing} 个文件缺失或变化。
            {reconcileResult.hasMore ? "还有文件待核对。" : "本次核对完成。"}
            核对不会删除文件。
          </Notice>
        )}
        {storage.loading ? (
          <Loading />
        ) : storage.error ? (
          <ErrorBox error={storage.error} retry={storage.reload} />
        ) : !storage.data?.items.length ? (
          <Empty
            icon="storage"
            title="没有符合条件的视频"
            description="上传视频后，可以在这里查看原片与生成文件的空间。"
          />
        ) : (
          <div className="stack">
            {storage.data.items.map((video) => (
              <article className="panel stack" key={video.id}>
                <div className="toolbar">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <h3 style={{ overflowWrap: "anywhere" }}>{video.title}</h3>
                    <small
                      className="muted"
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {video.source_name}
                    </small>
                  </div>
                  <span className="badge">
                    {video.published ? "已发布" : "未发布"}
                  </span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>内容</th>
                        <th>占用空间</th>
                        <th>使用状态</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>
                          <strong>上传的原片</strong>
                        </td>
                        <td>{bytes(video.sourceBytes)}</td>
                        <td>
                          {!video.source_key
                            ? "已删除"
                            : video.versions.some(
                                  (v) => v.usesSource && v.current,
                                )
                              ? "用于当前直接播放"
                              : "保留用于检查或转换"}
                        </td>
                        <td>
                          <button
                            className="text-button danger-text"
                            disabled={!video.source_key}
                            onClick={() =>
                              setRequest({ kind: "source", videoId: video.id })
                            }
                          >
                            删除原片
                          </button>
                        </td>
                      </tr>
                      {video.versions.map((version) => (
                        <tr key={version.id}>
                          <td>
                            <strong>{versionName(version)}</strong>
                            <small className="muted">
                              {date(version.createdAt)}
                            </small>
                          </td>
                          <td>
                            {version.usesSource
                              ? "共用原片，不重复占用"
                              : `${bytes(version.bytes)} · ${version.fileCount} 个文件`}
                          </td>
                          <td>
                            {version.current
                              ? "当前播放版本"
                              : "未选为当前播放"}
                            <small>
                              <Badge value={version.state} />
                            </small>
                          </td>
                          <td>
                            <button
                              className="text-button danger-text"
                              onClick={() =>
                                setRequest({
                                  kind: "version",
                                  videoId: video.id,
                                  versionId: version.id,
                                })
                              }
                            >
                              {version.usesSource
                                ? "移除播放记录"
                                : "删除这个生成版本"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {video.reservedBytes > 0 && (
                  <p className="muted">
                    这个视频还有 {bytes(video.reservedBytes)}{" "}
                    上传预留。删除前请先完成或取消上传。
                  </p>
                )}
                <div className="toolbar">
                  <span className="muted small-text">
                    生成文件合计 {bytes(video.generatedBytes)}
                  </span>
                  <div className="storage-actions">
                    {video.versions.some((v) =>
                      [
                        "failed",
                        "cancelled",
                        "timed_out",
                        "needs_confirmation",
                      ].includes(v.state),
                    ) && (
                      <button
                        className="button small"
                        onClick={() =>
                          setRequest({ kind: "failed", videoId: video.id })
                        }
                      >
                        清理失败文件
                      </button>
                    )}
                    <button
                      className="button small danger"
                      onClick={() =>
                        setRequest({ kind: "video", videoId: video.id })
                      }
                    >
                      彻底删除这个视频
                    </button>
                  </div>
                </div>
                <FileDetails videoId={video.id} />
              </article>
            ))}
            <Pagination
              page={page}
              total={storage.data.total}
              pageSize={storage.data.pageSize}
              onPage={setPage}
            />
          </div>
        )}
      </div>
      <div className="panel stack">
        <h3>删除未完成</h3>
        <p className="muted small-text">
          未开始的请求可以取消。已开始的删除只会继续原来确认的范围。
        </p>
        {plans.loading ? (
          <Loading />
        ) : plans.error ? (
          <ErrorBox error={plans.error} retry={plans.reload} />
        ) : !plans.data?.items.length ? (
          <p className="muted">没有待处理的删除。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>视频 / 操作</th>
                  <th>状态</th>
                  <th>进度</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {plans.data.items.map((plan) => (
                  <tr key={plan.id}>
                    <td style={{ overflowWrap: "anywhere" }}>
                      <strong>{plan.videoTitle || "视频"}</strong>
                      <small>{names[plan.kind]}</small>
                    </td>
                    <td>
                      {plan.expired
                        ? "确认已过期，文件尚未删除"
                        : plan.state === "pending"
                          ? "尚未开始"
                          : "删除未完成"}
                    </td>
                    <td>
                      还剩 {plan.remainingCount} 个文件
                      <small>已释放 {bytes(plan.releasedBytes)}</small>
                    </td>
                    <td>
                      <div className="storage-actions">
                        <button
                          className="button small"
                          onClick={() => setResuming(plan)}
                        >
                          {plan.expired
                            ? "重新检查"
                            : plan.state === "pending"
                              ? "查看"
                              : "继续删除"}
                        </button>
                        {plan.state === "pending" && (
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => void cancel(plan.id)}
                          >
                            取消待办
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {plans.data &&
          !plans.error &&
          plans.data.total > plans.data.pageSize && (
            <Pagination
              page={planPage}
              total={plans.data.total}
              pageSize={plans.data.pageSize}
              onPage={setPlanPage}
            />
          )}
      </div>
      {request && (
        <DeletionDialog
          request={request}
          onClose={() => {
            setRequest(null);
            refresh();
          }}
          onDone={() => {
            setRequest(null);
            refresh();
          }}
        />
      )}
      {resuming && (
        <DeletionDialog
          planId={resuming.id}
          videoTitle={resuming.videoTitle}
          request={{ kind: resuming.kind, videoId: resuming.videoId }}
          onClose={() => {
            setResuming(null);
            refresh();
          }}
          onDone={() => {
            setResuming(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
export function DeletionDialog({
  request,
  planId,
  videoTitle,
  onClose,
  onDone,
}: {
  request?: DeleteRequest;
  planId?: string;
  videoTitle?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [plan, setPlan] = useState<DeletePlan | null>(null);
  const [knownTitle, setKnownTitle] = useState(videoTitle || "");
  const [savedTarget, setSavedTarget] = useState<DeleteRequest | null>(() =>
    !planId && request ? deletionTarget(request) : null,
  );
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<"cancel" | "confirm" | null>(
    null,
  );
  const busy = busyAction !== null;
  const [preservePlayback, setPreservePlayback] = useState(
    request?.preservePlayback !== false,
  );
  const [unpublish, setUnpublish] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [typed, setTyped] = useState("");
  const [outcome, setOutcome] = useState<{
    state: string;
    releasedBytes: number;
    remainingCount: number;
    failures: { key: string; error: string }[];
  } | null>(null);
  const kind = plan?.kind || savedTarget?.kind || request?.kind;
  const expired =
    !!plan && plan.state === "pending" && Date.now() >= plan.expiresAt;
  const complete =
    outcome?.state === "complete" ||
    plan?.state === "complete" ||
    plan?.noAction === true;
  const started = !!plan && ["partial", "running"].includes(plan.state);
  const changed =
    error instanceof ApiError &&
    [
      "objects_changed",
      "plan_changed",
      "metadata_changed",
      "scope_denied",
      "source_referenced",
      "unpublish_required",
    ].includes(error.code);
  const canRegenerate = expired || changed;
  function showPlan(next: DeletePlan) {
    setPlan(next);
    if (next.videoTitle) setKnownTitle(next.videoTitle);
  }
  async function load(existing = false, keepPlayback = preservePlayback) {
    setLoading(true);
    setError(null);
    setOutcome(null);
    setAcknowledge(false);
    setTyped("");
    setUnpublish(false);
    try {
      if (existing && planId) {
        const result = await api<{ plan: DeletePlan }>(
          `/api/admin/storage/plans/${encodeURIComponent(planId)}`,
        );
        showPlan(result.plan);
        setSavedTarget(deletionTarget(result.plan));
        setPreservePlayback(result.plan.preservePlayback !== false);
      } else {
        const target = plan ? deletionTarget(plan) : savedTarget;
        if (!target)
          throw new Error("无法确认要删除的视频，请关闭窗口并重新选择。");
        const nextTarget = {
          ...target,
          ...(target.kind === "source"
            ? {
                preservePlayback: keepPlayback,
                removeDependencies: target.removeDependencies ?? true,
              }
            : {}),
        };
        // Keep only the reviewed identity/options when replacing a plan. A
        // failed replacement must not lose its version or broaden a retry.
        setSavedTarget(nextTarget);
        // Cancel the unused confirmation so changing options does not leave duplicate pending work.
        if (plan?.state === "pending")
          await send(
            `/api/admin/storage/plans/${encodeURIComponent(plan.id)}/cancel`,
            {},
          );
        setPlan(null);
        const result = await send<{ plan: DeletePlan }>(
          "/api/admin/storage/plan",
          nextTarget,
        );
        showPlan(result.plan);
      }
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load(!!planId);
  }, []);
  async function cancel() {
    if (!plan) {
      onClose();
      return;
    }
    setBusyAction("cancel");
    setError(null);
    try {
      await send(
        `/api/admin/storage/plans/${encodeURIComponent(plan.id)}/cancel`,
        {},
      );
      onDone();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusyAction(null);
    }
  }
  async function confirm() {
    if (!plan) return;
    setBusyAction("confirm");
    setError(null);
    try {
      setOutcome(
        await send(
          `/api/admin/storage/plans/${encodeURIComponent(plan.id)}/confirm`,
          {
            confirmation: "DELETE_LISTED_OBJECTS",
            unpublish,
            removeDependencies: true,
          },
        ),
      );
      try {
        showPlan(
          (
            await api<{ plan: DeletePlan }>(
              `/api/admin/storage/plans/${encodeURIComponent(plan.id)}`,
            )
          ).plan,
        );
      } catch {
        /* Keep the verified operation result when progress refresh fails. */
      }
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusyAction(null);
    }
  }
  const failures = outcome?.failures || plan?.failures || [];
  const newFiles = failures.some(
    (f) => f.error === "unconfirmed_new_object_requires_new_plan",
  );
  const physical = !!plan?.objects.some((object) => !object.missing);
  return (
    <Modal
      title={complete ? "删除已完成" : kind ? names[kind] : "检查删除范围"}
      wide
      onClose={outcome ? onDone : onClose}
      busy={busy}
    >
      <div className="stack deletion-dialog">
        {kind === "source" && !started && !outcome && (
          <div className="panel stack">
            <strong>删除原片后如何播放</strong>
            <label className="checkbox">
              <input
                type="radio"
                name="source-delete-playback"
                checked={preservePlayback}
                disabled={loading || busy}
                onChange={() => {
                  setPreservePlayback(true);
                  void load(false, true);
                }}
              />
              保留播放能力：只保留已经独立、完整且可用的 MP4 或 HLS 版本
            </label>
            <label className="checkbox">
              <input
                type="radio"
                name="source-delete-playback"
                checked={!preservePlayback}
                disabled={loading || busy}
                onChange={() => {
                  setPreservePlayback(false);
                  void load(false, false);
                }}
              />
              同时移除依赖原片的播放版本，必要时将视频下架
            </label>
            <small className="muted">
              两种选择都会移除依赖这份原片的直接播放记录，不会启动转换任务。
            </small>
          </div>
        )}
        {loading ? (
          <Loading text="正在核实文件、保留内容与播放影响…" />
        ) : (
          <>
            <ErrorBox
              error={error}
              retry={
                !plan ? () => void load(!!planId && !savedTarget) : undefined
              }
            />
            {plan && (
              <>
                <div className="warning-panel">
                  <h3 style={{ overflowWrap: "anywhere" }}>
                    {plan.videoTitle || knownTitle || "选定视频"}
                  </h3>
                  <p>{plan.warning}</p>
                  <p>
                    <strong>
                      预计释放{" "}
                      {bytes(
                        started
                          ? (plan.remainingBytes ?? plan.totalBytes)
                          : plan.totalBytes,
                      )}
                    </strong>
                    {physical
                      ? ` · ${plan.objects.filter((object) => !object.missing).length} 个实际文件`
                      : " · 不删除物理文件"}
                  </p>
                  <p>
                    {plan.kind === "video"
                      ? "保留：这个视频之外的所有内容。"
                      : plan.kind === "source"
                        ? "保留：其他生成文件。"
                        : "保留：原片和其他版本。"}
                  </p>
                  <p>
                    {plan.requiresUnpublish
                      ? "前台影响：开始删除前会将这个视频下架。"
                      : plan.retainedVersionId &&
                          plan.dependencyVersionIds?.length
                        ? "前台影响：切换到已核实的独立播放版本。"
                        : "前台影响：当前播放不受影响。"}
                  </p>
                  {physical && <strong>文件删除后不能恢复。</strong>}
                </div>
                {plan.sourceReferenceOnly && (
                  <Notice>移除版本记录，原片保留，不释放文件空间。</Notice>
                )}
                {expired && (
                  <Notice>
                    删除确认已过期，尚未删除文件。重新检查后可以再次确认，也可以取消这条待办。
                  </Notice>
                )}
                {(canRegenerate || newFiles) && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void load()}
                  >
                    重新检查删除范围
                  </button>
                )}
                {!!plan.objects.length && (
                  <details>
                    <summary>查看文件清单与处理进度</summary>
                    <div className="table-wrap deletion-objects">
                      <table>
                        <thead>
                          <tr>
                            <th>文件</th>
                            <th>大小</th>
                            <th>状态</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.objects.map((object) => (
                            <tr key={object.key}>
                              <td className="mono object-path">{object.key}</td>
                              <td>{bytes(object.bytes)}</td>
                              <td>
                                {object.state === "deleted"
                                  ? "已移除"
                                  : object.state === "failed"
                                    ? "删除未完成"
                                    : object.missing
                                      ? "文件已缺失，仅同步记录"
                                      : "待删除"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
                {outcome || complete ? (
                  <>
                    <div className={complete ? "success-box" : "warning-panel"}>
                      <strong>
                        {complete
                          ? plan.noAction
                            ? "没有需要删除的内容，无需再确认。"
                            : "所选内容已删除，视频记录已同步。"
                          : "删除未完成"}
                      </strong>
                      <p>
                        已核实释放{" "}
                        {bytes(outcome?.releasedBytes ?? plan.releasedBytes)}。
                        {!complete &&
                          `还剩 ${outcome?.remainingCount ?? plan.remainingCount} 个原定文件待处理。`}
                      </p>
                    </div>
                    {!!failures.length && (
                      <Notice>
                        {newFiles
                          ? "视频中出现了新文件，这次没有删除它们。重新检查会显示新范围，并要求再次确认。"
                          : `${failures.length} 个文件暂时未删除或核实成功。可以继续删除；范围不会扩大。`}
                      </Notice>
                    )}
                    {!complete && !newFiles && !canRegenerate && (
                      <button
                        className="button danger"
                        disabled={busy}
                        onClick={() => void confirm()}
                      >
                        {busyAction === "confirm"
                          ? "正在继续删除…"
                          : "继续删除"}
                      </button>
                    )}
                    <div className="modal-actions">
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={onDone}
                      >
                        {complete ? "完成" : "关闭，稍后继续"}
                      </button>
                    </div>
                  </>
                ) : !expired && !canRegenerate ? (
                  <>
                    {started && (
                      <Notice>
                        这次删除已经开始。继续操作只处理原来确认的文件，关闭后仍可稍后继续。
                      </Notice>
                    )}
                    {plan.requiresUnpublish && (
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={unpublish}
                          onChange={(e) => setUnpublish(e.target.checked)}
                        />
                        我同意先将这个视频下架
                      </label>
                    )}
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={acknowledge}
                        onChange={(e) => setAcknowledge(e.target.checked)}
                      />
                      {physical
                        ? "我确认删除以上内容，并了解文件不能恢复"
                        : "我确认移除以上视频或播放记录，其他文件保留"}
                    </label>
                    {physical && (
                      <label className="field-label">
                        输入「删除」确认
                        <input
                          value={typed}
                          onChange={(e) => setTyped(e.target.value)}
                          placeholder="删除"
                          autoComplete="off"
                        />
                      </label>
                    )}
                    <div className="modal-actions">
                      <button
                        className="button"
                        disabled={busy}
                        onClick={started ? onClose : () => void cancel()}
                      >
                        {started
                          ? "稍后继续"
                          : busyAction === "cancel"
                            ? "正在取消…"
                            : "取消，保留文件"}
                      </button>
                      <button
                        className="button danger"
                        disabled={
                          busy ||
                          !acknowledge ||
                          (physical && typed !== "删除") ||
                          (plan.requiresUnpublish && !unpublish)
                        }
                        onClick={() => void confirm()}
                      >
                        {busyAction === "confirm"
                          ? physical
                            ? "正在删除…"
                            : "正在移除记录…"
                          : physical
                            ? "确认删除"
                            : "确认移除记录"}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="modal-actions">
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => void cancel()}
                    >
                      {busyAction === "cancel"
                        ? "正在取消…"
                        : "取消待办，保留文件"}
                    </button>
                    <button className="button" onClick={onClose}>
                      关闭
                    </button>
                  </div>
                )}
                {!started && !outcome && !complete && (
                  <small className="muted">
                    本次确认有效至 {date(plan.expiresAt)}
                    。执行前会再次检查文件和活动任务。
                  </small>
                )}
              </>
            )}
            {!plan && !loading && (
              <div className="modal-actions">
                <button className="button" onClick={onClose}>
                  保留文件并关闭
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
