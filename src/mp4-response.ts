import type { Env } from "./types";
import { HttpError } from "./http";

function matchesRange(
  value: R2Range | undefined,
  offset: number,
  length: number,
) {
  return (
    !!value &&
    "offset" in value &&
    value.offset === offset &&
    "length" in value &&
    value.length === length
  );
}

function rangeForSource(value: string | null, size: number) {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error();
  const suffix = !match[1] ? Number(match[2]) : 0;
  const offset = match[1] ? Number(match[1]) : Math.max(0, size - suffix);
  const end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(suffix) ||
    (!match[1] && suffix <= 0) ||
    offset < 0 ||
    offset >= size ||
    end < offset
  )
    throw new Error();
  return { offset, length: Math.min(size - 1, end) - offset + 1 };
}

export async function streamMp4Object(
  request: Request,
  env: Env,
  head: R2Object,
  filename: "source.mp4" | "optimized.mp4" = "source.mp4",
) {
  if (!["GET", "HEAD"].includes(request.method))
    throw new HttpError(405, "method_denied", "请求方法不允许");
  const etag = `"${head.etag}"`;
  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store, max-age=0",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    ETag: etag,
    "Content-Disposition": `inline; filename="${filename}"`,
  });
  let range: { offset: number; length: number } | undefined;
  const ifRange = request.headers.get("If-Range");
  const modified = head.uploaded?.getTime();
  if (modified !== undefined && Number.isFinite(modified))
    headers.set("Last-Modified", new Date(modified).toUTCString());
  const date =
    ifRange &&
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      ifRange,
    )
      ? Date.parse(ifRange)
      : NaN;
  if (
    !ifRange ||
    ifRange === etag ||
    (Number.isFinite(date) &&
      modified !== undefined &&
      date >= Math.floor(modified / 1000) * 1000)
  ) {
    try {
      range = rangeForSource(request.headers.get("Range"), head.size);
    } catch {
      headers.set("Content-Range", `bytes */${head.size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
  }
  headers.set("Content-Length", String(range?.length ?? head.size));
  if (range)
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
    );
  if (request.method === "HEAD")
    return new Response(null, { status: range ? 206 : 200, headers });
  const object = await env.MEDIA.get(head.key, {
    onlyIf: { etagMatches: head.etag },
    ...(range ? { range } : {}),
  });
  if (
    !object ||
    !("body" in object) ||
    object.key !== head.key ||
    object.etag !== head.etag ||
    object.size !== head.size ||
    (range && !matchesRange(object.range, range.offset, range.length)) ||
    (!range && object.range && !matchesRange(object.range, 0, head.size))
  ) {
    if (object && "body" in object) void object.body.cancel().catch(() => {});
    throw new HttpError(404, "source_unavailable", "MP4 对象已变化或不可用");
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
