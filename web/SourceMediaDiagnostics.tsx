import { useEffect, useRef, useState } from "react";

const RANGE_BYTES = 65536;
const REQUEST_TIMEOUT_MS = 15000;
type Failure =
  | "timeout"
  | "connection"
  | "redirect"
  | "status"
  | "headers"
  | "bounded_read_unavailable"
  | "body";
const failureText: Record<Failure, string> = {
  timeout: "本项等待超过 15 秒，尚未核实",
  connection: "本项连接未完成",
  redirect: "响应发生重定向，已停止",
  status: "响应状态不符合预期，未读取正文",
  headers: "响应范围、长度或类型不符合预期，未读取正文",
  bounded_read_unavailable:
    "浏览器不支持本诊断所需的严格限量读取，正文尚未核实",
  body: "范围正文未完整读取",
};
export type SourceMediaDiagnosticResult = {
  method: "HEAD" | "GET";
  status: number | null;
  expectedRange: string | null;
  contentRange: string | null;
  contentLength: string | null;
  contentType: string | null;
  acceptRanges: string | null;
  cacheControl: string | null;
  ttfbMs: number | null;
  firstByteMs: number | null;
  bytes: number;
  totalMs: number;
  failure: Failure | null;
};
type DiagnosticFetch = (
  path: string,
  options: RequestInit,
) => Promise<Response>;
class DiagnosticFailure extends Error {
  constructor(readonly code: Failure) {
    super(code);
  }
}
function aborted() {
  return new DOMException("Aborted", "AbortError");
}
async function withAbort<T>(pending: Promise<T>, signal: AbortSignal) {
  // Remote operations may ignore abort. Their eventual rejection must still
  // be handled, and a late response body is separately disposed below.
  void pending.catch(() => {});
  if (signal.aborted) throw aborted();
  let rejectAbort!: () => void;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(aborted());
        signal.addEventListener("abort", rejectAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", rejectAbort);
  }
}
function header(response: Response, name: string) {
  const value = response.headers.get(name);
  return value === null ? null : value.slice(0, 160);
}
async function inspectRequest(
  path: string,
  size: number,
  method: "HEAD" | "GET",
  range: { start: number; end: number } | "invalid" | null,
  parentSignal: AbortSignal,
  fetcher: DiagnosticFetch,
): Promise<SourceMediaDiagnosticResult> {
  const started = Date.now();
  const elapsed = () => Math.max(0, Date.now() - started);
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  if (parentSignal.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const expectedRange =
    range === "invalid"
      ? `bytes=${size}-`
      : range
        ? `bytes=${range.start}-${range.end}`
        : null;
  const result: SourceMediaDiagnosticResult = {
    method,
    status: null,
    expectedRange,
    contentRange: null,
    contentLength: null,
    contentType: null,
    acceptRanges: null,
    cacheControl: null,
    ttfbMs: null,
    firstByteMs: null,
    bytes: 0,
    totalMs: 0,
    failure: null,
  };
  let response: Response | null = null;
  let reader: ReadableStreamBYOBReader | null = null;
  let readerCancelled = false;
  const disposed = new WeakSet<ReadableStream>();
  const disposeBody = (value: Response) => {
    if (!value.body || disposed.has(value.body)) return;
    disposed.add(value.body);
    try {
      void value.body.cancel().catch(() => {});
    } catch {}
  };
  const dispose = () => {
    if (reader) {
      if (readerCancelled) return;
      readerCancelled = true;
      try {
        void reader.cancel().catch(() => {});
      } catch {}
    } else if (response) disposeBody(response);
  };
  controller.signal.addEventListener("abort", dispose, { once: true });
  try {
    if (controller.signal.aborted) throw aborted();
    const received = await withAbort<Response>(
      fetcher(path, {
        method,
        credentials: "same-origin",
        mode: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        ...(expectedRange ? { headers: { Range: expectedRange } } : {}),
      }).then((value) => {
        if (controller.signal.aborted) disposeBody(value);
        return value;
      }),
      controller.signal,
    );
    response = received;
    if (controller.signal.aborted) throw aborted();
    result.ttfbMs = elapsed();
    result.status = received.status;
    result.contentRange = header(received, "content-range");
    result.contentLength = header(received, "content-length");
    result.contentType = header(received, "content-type");
    result.acceptRanges = header(received, "accept-ranges");
    result.cacheControl = header(received, "cache-control");
    if (received.redirected) throw new DiagnosticFailure("redirect");
    const expectedStatus =
      method === "HEAD" ? 200 : range === "invalid" ? 416 : 206;
    if (received.status !== expectedStatus)
      throw new DiagnosticFailure("status");
    const expectedLength =
      range && range !== "invalid"
        ? range.end - range.start + 1
        : method === "HEAD"
          ? size
          : 0;
    const expectedContentRange =
      range === "invalid"
        ? `bytes */${size}`
        : range
          ? `bytes ${range.start}-${range.end}/${size}`
          : null;
    if (
      received.headers.get("content-range") !== expectedContentRange ||
      received.headers.get("content-length") !== String(expectedLength) ||
      received.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "video/mp4"
    )
      throw new DiagnosticFailure("headers");
    // HEAD and invalid ranges never consume a body, even if one is returned.
    if (method === "HEAD" || range === "invalid") return result;
    if (!received.body) throw new DiagnosticFailure("body");
    try {
      // A default reader can deliver an oversized chunk in a single read.
      // BYOB strictly caps delivered bytes to the remaining approved range.
      reader = received.body.getReader({ mode: "byob" });
    } catch {
      throw new DiagnosticFailure("bounded_read_unavailable");
    }
    while (result.bytes < expectedLength) {
      const next = await withAbort(
        reader.read(new Uint8Array(expectedLength - result.bytes)),
        controller.signal,
      );
      if (controller.signal.aborted) throw aborted();
      if (next.value?.byteLength) {
        result.firstByteMs ??= elapsed();
        result.bytes += next.value.byteLength;
      }
      if (next.done && result.bytes < expectedLength)
        throw new DiagnosticFailure("body");
    }
    return result;
  } catch (error) {
    if (parentSignal.aborted) throw aborted();
    result.failure = timedOut
      ? "timeout"
      : error instanceof DiagnosticFailure
        ? error.code
        : reader
          ? "body"
          : "connection";
    return result;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", dispose);
    dispose();
    result.totalMs = elapsed();
  }
}

export async function inspectSourceMediaConnection(
  videoId: string,
  size: number,
  signal: AbortSignal,
  onResult: (result: SourceMediaDiagnosticResult) => void,
  fetcher: DiagnosticFetch = fetch,
) {
  if (!videoId || !Number.isSafeInteger(size) || size < 1) return;
  const path = `/api/admin/source/${encodeURIComponent(videoId)}/source.mp4`;
  const ranges = [
    null,
    { start: 0, end: Math.min(size, RANGE_BYTES) - 1 },
    { start: Math.max(0, size - RANGE_BYTES), end: size - 1 },
    "invalid",
  ] as const;
  for (const [index, range] of ranges.entries()) {
    if (signal.aborted) return;
    const result = await inspectRequest(
      path,
      size,
      index === 0 ? "HEAD" : "GET",
      range,
      signal,
      fetcher,
    );
    if (signal.aborted) return;
    onResult(result);
  }
}

export function SourceMediaDiagnostics({
  videoId,
  sourceRevision,
  size,
  disabled = false,
}: {
  videoId: string;
  sourceRevision: string;
  size: number;
  disabled?: boolean;
}) {
  const [results, setResults] = useState<SourceMediaDiagnosticResult[]>([]);
  const [running, setRunning] = useState(false);
  const active = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    active.current?.abort();
    active.current = null;
    setResults([]);
    setRunning(false);
    return () => {
      epoch.current++;
      active.current?.abort();
      active.current = null;
    };
  }, [videoId, sourceRevision, size]);
  async function inspect() {
    if (disabled || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const generation = epoch.current;
    setResults([]);
    setRunning(true);
    try {
      await inspectSourceMediaConnection(
        videoId,
        size,
        controller.signal,
        (result) => {
          if (generation === epoch.current && !controller.signal.aborted)
            setResults((previous) => [...previous, result]);
        },
      );
    } catch {
      // Closing/changing the source retires this run; no raw transport error is shown.
    } finally {
      if (generation === epoch.current && active.current === controller) {
        active.current = null;
        setRunning(false);
      }
    }
  }
  const time = (value: number | null) =>
    value === null ? "尚未取得" : `${value} ms`;
  const titles = ["对象头", "文件开头", "文件末尾", "越界范围"];
  return (
    <section className="subpanel stack" aria-label="原片媒体连接诊断">
      <div>
        <strong>媒体连接诊断</strong>
        <p className="muted small-text">
          手动检查 HEAD 和范围响应，每项最多等待 15 秒，正文合计最多读取 128
          KiB；只验证本次连接与范围读取，不代表解码、声音或画面正常。
        </p>
        <button
          className="button"
          disabled={disabled || running}
          onClick={() => void inspect()}
        >
          {running ? "正在检查媒体连接…" : "检查媒体连接"}
        </button>
      </div>
      <div aria-live="polite">
        {results.map((result, index) => (
          <div className="subpanel" key={index}>
            <strong>
              {titles[index]} · {result.method} ·{" "}
              {result.status ?? "未取得状态"}
            </strong>
            <p>
              {result.failure
                ? failureText[result.failure]
                : "本项连接与范围响应已核实"}
            </p>
            <dl className="info-list">
              {[
                ["请求范围", result.expectedRange ?? "不读取正文"],
                ["Content-Range", result.contentRange ?? "无"],
                ["Content-Length", result.contentLength ?? "无"],
                ["Content-Type", result.contentType ?? "无"],
                ["Accept-Ranges", result.acceptRanges ?? "无"],
                ["Cache-Control", result.cacheControl ?? "无"],
                ["响应头等待（TTFB）", time(result.ttfbMs)],
                ["首字节等待", time(result.firstByteMs)],
                ["读取字节数", String(result.bytes)],
                ["总耗时", time(result.totalMs)],
              ].map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}
