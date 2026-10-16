import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  bytes,
  date,
  api,
  ApiError,
  useLoad,
  type Upload,
  type UploadPart,
} from "./client";
import {
  Badge,
  Empty,
  ErrorBox,
  Icon,
  Loading,
  Notice,
  Pagination,
} from "./ui";
import { MediaErrorBox } from "./media-errors";

const CHUNK = 8 * 1024 * 1024;
const MAX = 20 * 1024 ** 3;
const CONTROL_TIMEOUT_MS = 30000;
function uploadControl<T = Record<string, unknown>>(
  path: string,
  body: unknown = {},
) {
  return api<T>(
    path,
    { method: "POST", body: JSON.stringify(body) },
    CONTROL_TIMEOUT_MS,
  );
}
type UploadList = {
  items: (Upload & { name?: string; title?: string; uploadedBytes?: number })[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  nextPage: number | null;
};
type Entry = {
  key: string;
  file: File;
  title: string;
  fingerprint?: string;
  uploadId?: string;
  reused?: boolean;
  additionalBytes?: number;
  fingerprintedBytes?: number;
  state:
    | "queued"
    | "hashing"
    | "uploading"
    | "completing"
    | "paused"
    | "complete"
    | "failed"
    | "cancelling"
    | "cancelled";
  completionUnverified?: boolean;
  completedBytes: number;
  activeBytes: number;
  parts: UploadPart[];
  error?: string;
  mediaError?: Error;
};
const hex = (data: ArrayBuffer) =>
  [...new Uint8Array(data)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
async function sha(data: BufferSource) {
  return hex(await crypto.subtle.digest("SHA-256", data));
}
export async function fingerprintFile(
  file: File,
  onProgress?: (bytes: number) => void,
  signal?: AbortSignal,
) {
  const chunks: string[] = [];
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    if (signal?.aborted) throw new DOMException("暂停", "AbortError");
    chunks.push(
      await sha(await file.slice(offset, offset + CHUNK).arrayBuffer()),
    );
    onProgress?.(Math.min(file.size, offset + CHUNK));
  }
  if (signal?.aborted) throw new DOMException("暂停", "AbortError");
  return sha(
    new TextEncoder().encode(
      JSON.stringify({
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        algorithm: "sha256-chunks-v1",
        chunkBytes: CHUNK,
        chunks,
      }),
    ),
  );
}
function uploadPart(
  path: string,
  chunk: Blob,
  hash: string,
  onProgress: (n: number) => void,
  signal: AbortSignal,
): Promise<UploadPart> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Part-SHA256", hash);
    xhr.timeout = 120000;
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", abort);
    xhr.onload = () => {
      cleanup();
      if (xhr.status === 401)
        window.dispatchEvent(new Event("hub-session-expired"));
      let body;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        reject(
          new ApiError(
            xhr.status === 401 ? "管理员登录已失效" : "上传响应无法识别",
            xhr.status === 401 ? "unauthorized" : "upload_response_invalid",
            undefined,
            xhr.status,
          ),
        );
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300)
        reject(
          new ApiError(
            body?.error?.message || "分片上传失败。",
            body?.error?.code || "request_failed",
            body?.requestId,
            xhr.status,
            body?.error?.details,
          ),
        );
      else resolve(body);
    };
    xhr.onerror = () => {
      cleanup();
      reject(new ApiError("上传网络中断", "upload_network"));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new ApiError("分片上传超时", "upload_timeout"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("暂停", "AbortError"));
    };
    xhr.send(chunk);
  });
}

export function Uploads({ onComplete }: { onComplete: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const entriesRef = useRef(entries);
  const active = useRef(new Map<string, AbortController>());
  const reselected = useRef(new Set<string>());
  const cancelled = useRef(new Set<string>());
  const cancelConfirmed = useRef(new Set<string>());
  const cancelPending = useRef(new Set<string>());
  const creationUnverified = useRef(new Set<string>());
  const alive = useRef(true);
  const [inputError, setInputError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [remoteError, setRemoteError] = useState<Error | null>(null);
  const [remotePage, setRemotePage] = useState(1);
  const space = useLoad<{
    usedBytes: number;
    reservedBytes: number;
    limitBytes: number;
    availableBytes: number;
    checkedAt: number;
  }>("/api/admin/upload-space");
  const remote = useLoad<UploadList>(
    `/api/admin/uploads?status=unfinished&page=${remotePage}`,
  );
  useEffect(() => {
    if (remote.data && !remote.loading) {
      const last = Math.max(
        1,
        Math.ceil(remote.data.total / remote.data.pageSize),
      );
      if (remotePage > last) setRemotePage(last);
    }
  }, [remote.data, remote.loading, remotePage]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      active.current.forEach((controller) => controller.abort());
    };
  }, []);
  function changeEntries(change: (previous: Entry[]) => Entry[]) {
    if (!alive.current) return;
    // Keep identity claims synchronous: two hashes may finish before React
    // commits either state update, but only one entry may request admission.
    const next = change(entriesRef.current);
    entriesRef.current = next;
    setEntries(next);
  }
  function update(key: string, patch: Partial<Entry>) {
    changeEntries((previous) =>
      previous.map((e) => (e.key === key ? { ...e, ...patch } : e)),
    );
  }
  async function run(entry: Entry, controller: AbortController) {
    let uploadId = entry.uploadId;
    let completing = false;
    try {
      update(entry.key, {
        state: "hashing",
        error: undefined,
        activeBytes: 0,
        completionUnverified: false,
      });
      const hash =
        entry.fingerprint ||
        (await fingerprintFile(
          entry.file,
          (fingerprintedBytes) => update(entry.key, { fingerprintedBytes }),
          controller.signal,
        ));
      if (controller.signal.aborted) {
        if (cancelled.current.has(entry.key))
          update(entry.key, { state: "cancelled" });
        return;
      }
      const matching = entriesRef.current.find(
        (other) =>
          other.key !== entry.key &&
          other.file.name === entry.file.name &&
          other.file.size === entry.file.size &&
          other.fingerprint === hash &&
          !["complete", "cancelled"].includes(other.state),
      );
      if (matching) {
        changeEntries((previous) =>
          previous.filter((e) => e.key !== entry.key),
        );
        if (
          ["paused", "failed"].includes(matching.state) &&
          !cancelled.current.has(matching.key) &&
          !cancelPending.current.has(matching.key)
        ) {
          if (active.current.has(matching.key))
            reselected.current.add(matching.key);
          else if (!creationUnverified.current.has(matching.key))
            resume(matching);
        }
        return;
      }
      update(entry.key, { fingerprint: hash });
      // The server verifies completed source objects before allowing reuse.
      // A list entry alone cannot prove that an old source still exists.
      creationUnverified.current.add(entry.key);
      const created = await uploadControl<{
        upload: Upload;
        parts: UploadPart[];
        reused?: boolean;
        additionalBytes?: number;
      }>("/api/admin/uploads", {
        name: entry.file.name,
        title: entry.title,
        size: entry.file.size,
        fingerprint: hash,
      });
      update(entry.key, {
        reused: created.reused,
        additionalBytes: created.additionalBytes,
      });
      space.reload();
      const remoteUpload = created.upload;
      let parts: UploadPart[] = created.parts || [];
      uploadId = remoteUpload.id;
      creationUnverified.current.delete(entry.key);
      if (controller.signal.aborted) {
        if (cancelled.current.has(entry.key)) {
          try {
            if (!cancelConfirmed.current.has(entry.key))
              await uploadControl(
                `/api/admin/uploads/${encodeURIComponent(uploadId)}/cancel`,
              );
            cancelConfirmed.current.add(entry.key);
            update(entry.key, { uploadId, state: "cancelled" });
          } catch (error) {
            update(entry.key, {
              uploadId,
              state: "failed",
              error:
                error instanceof Error ? error.message : "取消未核实，请重试。",
              mediaError:
                error instanceof Error
                  ? error
                  : new ApiError("取消未核实", "abort_unverified"),
            });
          }
        } else update(entry.key, { uploadId, state: "paused", parts });
        remote.reload();
        return;
      }
      update(entry.key, {
        uploadId,
        state: controller.signal.aborted ? "paused" : "uploading",
        parts,
      });
      let completedBytes = 0;
      for (let part = 1; part <= Math.ceil(entry.file.size / CHUNK); part++) {
        if (controller.signal.aborted) return;
        const blob = entry.file.slice((part - 1) * CHUNK, part * CHUNK);
        const data = await blob.arrayBuffer();
        const chunkHash = await sha(data);
        if (controller.signal.aborted) return;
        const old = parts.find((p) => p.number === part);
        if (old && old.size === blob.size && old.sha256 === chunkHash) {
          completedBytes += blob.size;
          update(entry.key, { completedBytes, activeBytes: 0 });
          continue;
        }
        if (old)
          throw new ApiError(
            "已上传分片与所选文件不匹配。请取消此上传并重新选择正确的原文件。",
            "upload_file_mismatch",
          );
        const result = await uploadPart(
          `/api/admin/uploads/${encodeURIComponent(uploadId)}/parts/${part}`,
          blob,
          chunkHash,
          (n) => update(entry.key, { activeBytes: n }),
          controller.signal,
        );
        parts = [...parts, result];
        completedBytes += blob.size;
        update(entry.key, { parts, completedBytes, activeBytes: 0 });
      }
      if (controller.signal.aborted) return;
      completing = true;
      update(entry.key, {
        state: "completing",
        completedBytes: entry.file.size,
        activeBytes: 0,
      });
      await uploadControl(
        `/api/admin/uploads/${encodeURIComponent(uploadId)}/complete`,
      );
      update(entry.key, {
        state: "complete",
        completionUnverified: false,
        completedBytes: entry.file.size,
        activeBytes: 0,
      });
      remote.reload();
      space.reload();
      onComplete();
    } catch (error) {
      if (
        !uploadId &&
        error instanceof ApiError &&
        ["storage_limit", "project_storage_unknown", "upload_size"].includes(
          error.code,
        )
      )
        creationUnverified.current.delete(entry.key);
      if (!controller.signal.aborted)
        update(entry.key, {
          state: "failed",
          activeBytes: 0,
          completionUnverified: completing,
          error: completing
            ? "文件已传输，完成保存的结果尚未核实。请核对保存结果，会复用已有上传和分片，不会重新传一份原片。"
            : error instanceof Error
              ? error.message
              : "上传结果尚未核实。",
          mediaError:
            completing &&
            (!(error instanceof ApiError) ||
              ["request_failed", "request_timeout"].includes(error.code))
              ? new ApiError(
                  "完成保存结果尚未核实",
                  "completion_unverified",
                  error instanceof ApiError ? error.requestId : undefined,
                )
              : error instanceof Error
                ? error
                : new Error("上传结果尚未核实"),
        });
      else if (
        cancelled.current.has(entry.key) &&
        !uploadId &&
        !creationUnverified.current.has(entry.key)
      )
        update(entry.key, { state: "cancelled", activeBytes: 0 });
      else if (
        cancelled.current.has(entry.key) &&
        !cancelConfirmed.current.has(entry.key) &&
        !cancelPending.current.has(entry.key)
      )
        update(entry.key, {
          uploadId,
          state: "failed",
          activeBytes: 0,
          error:
            "取消结果尚未核实。请刷新下方未完成清单，按文件名与上传编号核对并重试取消。",
          mediaError: new ApiError("取消结果尚未核实", "abort_unverified"),
        });
      else if (creationUnverified.current.has(entry.key))
        update(entry.key, {
          state: "paused",
          error:
            "创建结果尚未核实。继续时会按原指纹核对；也可刷新下方未完成清单取消已建立的任务。",
          mediaError: new ApiError("创建结果尚未核实", "upload_unknown"),
        });
    } finally {
      active.current.delete(entry.key);
      if (reselected.current.delete(entry.key)) {
        const current = entriesRef.current.find((e) => e.key === entry.key);
        if (
          current &&
          ["paused", "failed"].includes(current.state) &&
          !cancelled.current.has(entry.key) &&
          !cancelPending.current.has(entry.key) &&
          !creationUnverified.current.has(entry.key)
        )
          resume(current);
      }
      changeEntries((previous) => [...previous]);
    }
  }
  useEffect(() => {
    const available = Math.max(0, 2 - active.current.size);
    entriesRef.current
      .filter((e) => e.state === "queued" && !active.current.has(e.key))
      .slice(0, available)
      .forEach((entry) => {
        const controller = new AbortController();
        active.current.set(entry.key, controller);
        void run(entry, controller);
      });
  }, [entries]);
  function add(files: FileList | File[]) {
    setInputError(null);
    const selected = Array.from(files);
    const invalid = selected.filter((f) => !f.size || f.size > MAX);
    if (invalid.length)
      setInputError(
        `${invalid.map((f) => f.name).join("、")}：文件必须非空且不超过 20 GiB。`,
      );
    changeEntries((previous) => [
      ...previous,
      ...selected
        .filter((f) => f.size > 0 && f.size <= MAX)
        .map((file) => ({
          key: crypto.randomUUID(),
          file,
          title: file.name.replace(/\.[^.]+$/, ""),
          state: "queued" as const,
          completedBytes: 0,
          activeBytes: 0,
          parts: [],
        })),
    ]);
  }
  function choose(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files) add(e.target.files);
    e.target.value = "";
  }
  function pause(entry: Entry) {
    if (
      entriesRef.current.find((item) => item.key === entry.key)?.state ===
      "completing"
    )
      return;
    reselected.current.delete(entry.key);
    active.current.get(entry.key)?.abort();
    update(entry.key, { state: "paused", activeBytes: 0 });
    remote.reload();
  }
  function resume(entry: Entry) {
    reselected.current.delete(entry.key);
    cancelled.current.delete(entry.key);
    cancelConfirmed.current.delete(entry.key);
    update(entry.key, {
      state: "queued",
      error: undefined,
      mediaError: undefined,
    });
  }
  async function cancel(entry: Entry) {
    if (
      entriesRef.current.find((item) => item.key === entry.key)?.state ===
      "completing"
    )
      return;
    reselected.current.delete(entry.key);
    cancelled.current.add(entry.key);
    cancelPending.current.add(entry.key);
    active.current.get(entry.key)?.abort();
    update(entry.key, { state: "cancelling", activeBytes: 0 });
    try {
      if (entry.uploadId)
        await uploadControl(
          `/api/admin/uploads/${encodeURIComponent(entry.uploadId)}/cancel`,
        );
      else if (
        !active.current.has(entry.key) &&
        creationUnverified.current.has(entry.key)
      )
        throw new ApiError(
          "创建结果尚未核实。请刷新下方未完成清单，找到服务器上的任务后取消。",
          "upload_unknown",
        );
      if (entry.uploadId || !active.current.has(entry.key)) {
        cancelConfirmed.current.add(entry.key);
        update(entry.key, { state: "cancelled" });
      }
      remote.reload();
      space.reload();
    } catch (error) {
      update(entry.key, {
        state: "failed",
        error: error instanceof Error ? error.message : "取消未核实，请重试。",
        mediaError:
          error instanceof Error
            ? error
            : new ApiError("取消未核实", "abort_unverified"),
      });
    } finally {
      cancelPending.current.delete(entry.key);
    }
  }
  async function cancelRemote(upload: Upload) {
    setRemoteError(null);
    try {
      await uploadControl(
        `/api/admin/uploads/${encodeURIComponent(upload.id)}/cancel`,
      );
      remote.reload();
      space.reload();
    } catch (error) {
      setRemoteError(error as Error);
    }
  }
  const selectedBytes = entries.reduce(
    (sum, entry) => sum + entry.file.size,
    0,
  );
  const total = entries.reduce(
    (n, e) => n + (e.state === "cancelled" ? 0 : e.file.size),
    0,
  );
  const done = entries.reduce(
    (n, e) =>
      n +
      (e.state === "cancelled"
        ? 0
        : Math.min(e.file.size, e.completedBytes + e.activeBytes)),
    0,
  );
  const saved =
    remote.data?.items.filter(
      (u) =>
        !["complete", "completed", "cancelled", "expired"].includes(u.state) &&
        !entries.some((e) => e.uploadId === u.id),
    ) || [];
  return (
    <div className="stack">
      <div
        className={`dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
      >
        <div className="upload-symbol">
          <Icon name="upload" size={30} />
        </div>
        <h3>把视频拖到这里</h3>
        <p>或选择多个文件，建立你的影片库</p>
        <label className="button primary">
          选择视频
          <input
            className="file-input"
            type="file"
            multiple
            accept="video/*,.mkv,.mov,.avi,.m2ts,.ts"
            onChange={choose}
          />
        </label>
        <small>每个文件最多 20 GiB · 8 MiB 分片 · 同时上传 2 个文件</small>
      </div>
      <Notice>
        上传只保存原片，不启动媒体探测或处理。刷新后重新选择同一原文件，即可核对指纹并继续已上传的分片。新增上传受实际存储预算约束。
      </Notice>
      <ErrorBox error={inputError} />
      <div className="panel">
        <div className="section-heading">
          <h3>项目空间</h3>
          <button className="text-button" onClick={space.reload}>
            刷新空间
          </button>
        </div>
        {space.data ? (
          <p>
            已用 {bytes(space.data.usedBytes)} · 上传与处理预留{" "}
            {bytes(space.data.reservedBytes)} · 项目上限{" "}
            {bytes(space.data.limitBytes)} · 可用{" "}
            {bytes(space.data.availableBytes)}
          </p>
        ) : (
          <p className="muted">
            {space.loading
              ? "正在核对项目文件和预留…"
              : "空间信息暂不可用；开始上传时会再次核对项目空间。"}
          </p>
        )}
        {space.error && (
          <MediaErrorBox
            error={space.error}
            stage="upload"
            retry={space.reload}
            retryLabel="刷新空间"
          />
        )}
        <p className="muted small-text">
          仅检查本项目文件与并发预留。普通上传不需要账户余额或额外批准，也不会启动视频处理。已完成或可恢复的同一文件核验后复用，新增空间为零。
        </p>
      </div>
      {!!entries.length && (
        <div className="panel">
          <div className="section-heading">
            <h3>
              本次选择{" "}
              <span className="muted">
                {entries.length} 个文件 · 总大小 {bytes(selectedBytes)}
              </span>
            </h3>
            <span>
              {bytes(done)} / {bytes(total)}
            </span>
          </div>
          <p className="muted small-text">
            预计新增空间{" "}
            {bytes(
              entries.reduce(
                (sum, entry) =>
                  sum +
                  (["cancelled"].includes(entry.state)
                    ? 0
                    : (entry.additionalBytes ?? entry.file.size)),
                0,
              ),
            )}
            ；服务器核验后自动扣除复用文件。
          </p>
          <progress
            className="progress"
            value={done}
            max={total || 1}
            aria-label="总体上传进度"
          />
          <div className="upload-list">
            {entries.map((entry) => (
              <div className="upload-row" key={entry.key}>
                <div className="file-icon">
                  <Icon name="film" />
                </div>
                <div className="upload-body">
                  <div className="spread">
                    <strong className="truncate" title={entry.file.name}>
                      {entry.file.name}
                    </strong>
                    <span className="muted">
                      {entry.state === "hashing"
                        ? `核对完整文件指纹 ${bytes(entry.fingerprintedBytes ?? 0)} / ${bytes(entry.file.size)}`
                        : entry.state === "uploading"
                          ? `${Math.floor(((entry.completedBytes + entry.activeBytes) / entry.file.size) * 100)}%`
                          : (
                              {
                                queued: "排队中",
                                paused: "已暂停",
                                complete: "已完成",
                                completing: "正在完成保存",
                                failed: "上传失败",
                                cancelling: "正在核实取消",
                                cancelled: "已取消",
                              } as Record<string, string>
                            )[entry.state]}
                    </span>
                  </div>
                  {entry.state !== "cancelled" && (
                    <progress
                      className="progress"
                      value={Math.min(
                        entry.file.size,
                        entry.completedBytes + entry.activeBytes,
                      )}
                      max={entry.file.size}
                      aria-label={`${entry.file.name} 上传进度`}
                    />
                  )}
                  <div className="spread">
                    <small>
                      {entry.state === "cancelled" ? (
                        <>
                          文件大小 {bytes(entry.file.size)} ·
                          已取消，不会继续上传
                        </>
                      ) : (
                        <>
                          {bytes(entry.completedBytes)} /{" "}
                          {bytes(entry.file.size)}
                          {entry.reused && " · 复用已有上传，不新增空间"}
                        </>
                      )}
                    </small>
                    <div className="row-actions">
                      {["queued", "hashing", "uploading"].includes(
                        entry.state,
                      ) && (
                        <button
                          className="text-button"
                          onClick={() => pause(entry)}
                        >
                          暂停
                        </button>
                      )}
                      {["paused", "failed"].includes(entry.state) && (
                        <button
                          className="text-button"
                          onClick={() => resume(entry)}
                        >
                          {entry.completionUnverified
                            ? "核对保存结果"
                            : entry.state === "failed"
                              ? "重试"
                              : "继续"}
                        </button>
                      )}
                      {![
                        "complete",
                        "cancelled",
                        "cancelling",
                        "completing",
                      ].includes(entry.state) && (
                        <button
                          className="text-button danger-text"
                          onClick={() => void cancel(entry)}
                        >
                          取消
                        </button>
                      )}
                    </div>
                  </div>
                  {entry.state === "completing" && (
                    <p className="muted small-text" role="status">
                      文件传输已完成，正在合并分片并核实保存。此时不能暂停或取消；关闭页面后可重选原文件核对结果。
                    </p>
                  )}
                  {entry.error && (
                    <MediaErrorBox
                      error={entry.mediaError || entry.error}
                      stage="upload"
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {remote.loading && !remote.data && <Loading />}
      {remote.error && (
        <MediaErrorBox
          error={remote.error}
          stage="upload"
          retry={remote.reload}
          retryLabel="刷新清单"
        />
      )}
      {!!remote.data?.total && (
        <div className="panel">
          <div className="section-heading">
            <h3>
              未完成的上传 <span className="count">{remote.data.total}</span>
            </h3>
            <button
              className="button small"
              disabled={remote.loading}
              onClick={remote.reload}
            >
              <Icon name="refresh" size={15} />
              {remote.loading ? "刷新中…" : "刷新清单"}
            </button>
          </div>
          <p className="muted">
            可按文件名和上传编号逐页找到旧任务，取消无需原文件。继续上传时重新选择原文件后自动核对。取消会终止未完成的上传，并在核实后释放未使用预留。
          </p>
          <MediaErrorBox error={remoteError} stage="upload" />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>文件 / 上传编号</th>
                  <th>已保存 / 文件大小</th>
                  <th>状态</th>
                  <th>到期时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {saved.map((upload) => (
                  <tr key={upload.id}>
                    <td>
                      <strong>
                        {upload.name || upload.title || "原文件名未提供"}
                      </strong>
                      <small className="mono">{upload.id}</small>
                    </td>
                    <td>
                      {bytes(
                        upload.uploadedBytes ??
                          upload.parts?.reduce((n, p) => n + p.size, 0) ??
                          null,
                      )}{" "}
                      / {bytes(upload.expected_size)}
                    </td>
                    <td>
                      <Badge value={upload.state} />
                    </td>
                    <td>{date(upload.expires_at)}</td>
                    <td>
                      <button
                        className="text-button danger-text"
                        onClick={() => void cancelRemote(upload)}
                      >
                        取消上传
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!saved.length && (
            <p className="muted small-text">
              本页任务已显示在本次上传队列中，可翻页查看其他未完成任务。
            </p>
          )}
          <Pagination
            page={remotePage}
            total={remote.data.total}
            pageSize={remote.data.pageSize}
            onPage={setRemotePage}
          />
        </div>
      )}
      {!entries.length &&
        !remote.data?.total &&
        !remote.loading &&
        !remote.error && (
          <Empty
            icon="upload"
            title="上传队列是空的"
            description="准备好视频后，从上方添加文件。"
          />
        )}
    </div>
  );
}
