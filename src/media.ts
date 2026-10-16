import type { Env, Version } from "./types";
import { HttpError } from "./http";
import { serveSourceVersion } from "./source";
import { serveFaststartVersion } from "./faststart";
export function parseRange(
  value: string | null,
  size: number,
): { offset: number; length: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]))
    throw new HttpError(416, "invalid_range", "请求范围无效");
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      throw new HttpError(416, "invalid_range", "请求范围无效");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw new HttpError(416, "invalid_range", "请求范围无效");
  end = Math.min(end, size - 1);
  return { offset: start, length: end - start + 1 };
}
export function safeMediaName(value: string) {
  return /^(?:index\.m3u8|segment-\d{6}\.ts)$/.test(value);
}
export async function serveMedia(
  request: Request,
  env: Env,
  videoId: string,
  versionId: string,
  name: string,
  preview: boolean,
  ctx: ExecutionContext,
) {
  if (
    !["GET", "HEAD"].includes(request.method) ||
    (!safeMediaName(name) && !["source.mp4", "optimized.mp4"].includes(name))
  )
    throw new HttpError(404, "media_missing", "媒体不可用");
  // This query precedes EVERY cache/R2 read, including HEAD/Range and warmed cache.
  const version = await env.DB.prepare(
    `SELECT r.* FROM versions r JOIN videos v ON v.id=r.video_id WHERE v.id=? AND r.id=? AND r.state='verified' ${preview ? "" : "AND v.published=1 AND v.current_version_id=r.id"}`,
  )
    .bind(videoId, versionId)
    .first<Version>();
  if (!version)
    throw new HttpError(404, "media_unavailable", "视频已下架或不可用");
  if (version.mode === "source") {
    if (name !== "source.mp4")
      throw new HttpError(404, "media_missing", "媒体不可用");
    try {
      return await serveSourceVersion(request, env, version);
    } catch (error) {
      if (preview) throw error;
      throw new HttpError(404, "media_unavailable", "视频已下架或不可用");
    }
  }
  if (version.mode === "faststart") {
    if (name !== "optimized.mp4")
      throw new HttpError(404, "media_missing", "媒体不可用");
    try {
      return await serveFaststartVersion(request, env, version, preview);
    } catch (error) {
      if (preview) throw error;
      throw new HttpError(404, "media_unavailable", "视频已下架或不可用");
    }
  }
  if (
    !["probe-remux", "transcode"].includes(version.mode) ||
    name === "source.mp4" ||
    name === "optimized.mp4"
  )
    throw new HttpError(404, "media_missing", "媒体不可用");
  const key = version.prefix + name;
  const registered = await env.DB.prepare(
    `SELECT bytes,etag FROM objects WHERE key=? AND version_id=? AND state='present'`,
  )
    .bind(key, versionId)
    .first<{ bytes: number; etag: string }>();
  if (!registered) throw new HttpError(404, "media_missing", "媒体不可用");
  const range = parseRange(request.headers.get("Range"), registered.bytes);
  const headers = new Headers({
    "Content-Type": name.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : "video/mp2t",
    "Cache-Control": "no-store, max-age=0",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    ETag: `"${registered.etag}"`,
  });
  headers.set("Content-Length", String(range?.length ?? registered.bytes));
  if (range)
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${registered.bytes}`,
    );
  if (request.method === "HEAD") {
    const head = await env.MEDIA.head(key);
    if (
      !head ||
      head.size !== registered.bytes ||
      head.etag !== registered.etag
    )
      throw new HttpError(404, "media_missing", "媒体不可用");
    return new Response(null, { status: range ? 206 : 200, headers });
  }
  const cacheKey = new Request(
    `https://internal-cache.invalid/${env.APP_ENV}/${videoId}/${versionId}/${registered.etag}/${name}`,
  );
  const edgeCache = (
    caches as unknown as {
      default: {
        match(key: Request): Promise<Response | undefined>;
        put(key: Request, response: Response): Promise<void>;
      };
    }
  ).default;
  if (!preview && !range) {
    const cached = await edgeCache.match(cacheKey);
    if (cached) return new Response(cached.body, { headers });
  }
  const object = await env.MEDIA.get(key, {
    onlyIf: { etagMatches: registered.etag },
    ...(range ? { range } : {}),
  });
  if (
    !object ||
    !("body" in object) ||
    object.size !== registered.bytes ||
    object.etag !== registered.etag
  )
    throw new HttpError(404, "media_missing", "媒体不可用");
  const response = new Response(object.body, {
    status: range ? 206 : 200,
    headers,
  });
  if (!preview && !range) {
    const internal = response.clone();
    internal.headers.set("Cache-Control", "public, max-age=86400");
    ctx.waitUntil(edgeCache.put(cacheKey, internal));
  }
  return response;
}
