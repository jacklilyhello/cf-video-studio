export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}
export async function readRequestBytes(
  request: Request,
  maxBytes: number,
  options: { idleTimeoutMs?: number; totalTimeoutMs?: number } = {},
): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes)
    throw new HttpError(413, "body_too_large", "请求内容过大");
  if (request.signal.aborted)
    throw new HttpError(408, "request_aborted", "请求已中断，请重试");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  // Bound retained memory even if a sender delivers millions of tiny chunks.
  const buffer = new Uint8Array(maxBytes);
  let size = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let interrupted: HttpError | undefined;
  let interruptRead: ((error: HttpError) => void) | undefined;
  const stop = (error: HttpError) => {
    interrupted ??= error;
    interruptRead?.(interrupted);
  };
  const timeout = () =>
    stop(new HttpError(408, "body_timeout", "请求内容读取超时，请重试"));
  const abort = () =>
    stop(new HttpError(408, "request_aborted", "请求已中断，请重试"));
  const total = setTimeout(timeout, options.totalTimeoutMs ?? 30000);
  request.signal.addEventListener("abort", abort, { once: true });
  let complete = false;
  try {
    while (true) {
      if (interrupted) throw interrupted;
      // Only the current read retains a stop resolver. Reusing one pending
      // Promise across chunks would retain every Promise.race reaction.
      const stopped = new Promise<never>(
        (_resolve, reject) => (interruptRead = reject),
      );
      idle = setTimeout(timeout, options.idleTimeoutMs ?? 10000);
      const { done, value } = await Promise.race([reader.read(), stopped]);
      interruptRead = undefined;
      clearTimeout(idle);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new HttpError(413, "body_too_large", "请求内容过大");
      buffer.set(value, size - value.byteLength);
    }
    complete = true;
    return buffer.subarray(0, size);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "body_read_failed", "请求内容读取失败，请重试");
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
    interruptRead = undefined;
    request.signal.removeEventListener("abort", abort);
    // Stream cancellation can itself stall. No external mutation has started,
    // so abandon this local read without waiting for the sender to acknowledge.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Own the original reader so a subrequest cannot keep reading it after response. */
export function forwardRequestBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return { body: null, stop: () => {} };
  let closed = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let finishRead: (() => void) | undefined;
  const cancel = () => {
    finishRead?.();
    finishRead = undefined;
    void reader.cancel().catch(() => {});
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    async pull() {
      if (closed) return;
      try {
        const stopped = new Promise<ReadableStreamReadResult<Uint8Array>>(
          (resolve) =>
            (finishRead = () => resolve({ done: true, value: undefined })),
        );
        const next = await Promise.race([reader.read(), stopped]);
        finishRead = undefined;
        if (closed) return;
        if (next.done) {
          closed = true;
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        if (!closed) {
          closed = true;
          controller.error(error);
        }
      } finally {
        finishRead = undefined;
      }
    },
    cancel() {
      closed = true;
      cancel();
    },
  });
  return {
    body,
    stop() {
      if (!closed) {
        closed = true;
        controller.close();
      }
      cancel();
    },
  };
}
export async function body<
  T extends Record<string, unknown> = Record<string, unknown>,
>(request: Request, maxBytes = 64 * 1024): Promise<T> {
  try {
    const bytes = await readRequestBytes(request, maxBytes);
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error();
    return value as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "JSON 请求格式错误");
  }
}
export function textValue(value: unknown, label: string, max = 200): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new HttpError(400, "invalid_input", `${label}格式错误`);
  return value.trim();
}
export function intValue(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new HttpError(400, "invalid_number", "数值超出允许范围");
  return value;
}
export function sameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (
    origin !== new URL(request.url).origin ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    throw new HttpError(403, "origin_denied", "请在当前站点执行此操作");
}
export const now = () => Date.now();
export const id = () => crypto.randomUUID();
export async function sha256(
  input: string | ArrayBuffer | Uint8Array,
): Promise<string> {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
