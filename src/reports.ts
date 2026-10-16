import type { Env } from "./types";
import { rateLimit } from "./auth";
import { body, HttpError, json, sameOrigin } from "./http";
import { log } from "./logs";

const codes = new Set([
  "playback_native_error",
  "playback_hls_fatal",
  "playback_hls_unsupported",
  "playback_loader_failed",
]);
const hlsTypes = new Set([
  "networkError",
  "mediaError",
  "keySystemError",
  "muxError",
  "otherError",
]);
const allowedKeys = new Set([
  "code",
  "videoId",
  "versionId",
  "nativeErrorCode",
  "hlsErrorType",
]);
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export async function acceptPlaybackReport(
  request: Request,
  env: Env,
  requestId: string,
) {
  sameOrigin(request);
  await rateLimit(env, "report-global", 100, 60 * 1000);
  await rateLimit(
    env,
    `report:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
    5,
    60 * 1000,
  );
  await rateLimit(env, "report-day", 1000, 24 * 3600 * 1000);
  const data = await body(request, 2048);
  if (
    Object.keys(data).some((key) => !allowedKeys.has(key)) ||
    typeof data.code !== "string" ||
    !codes.has(data.code) ||
    !validId(data.videoId) ||
    !validId(data.versionId) ||
    (data.nativeErrorCode !== undefined &&
      (data.code !== "playback_native_error" ||
        typeof data.nativeErrorCode !== "number" ||
        !Number.isInteger(data.nativeErrorCode) ||
        data.nativeErrorCode < 1 ||
        data.nativeErrorCode > 4)) ||
    (data.hlsErrorType !== undefined &&
      (data.code !== "playback_hls_fatal" ||
        typeof data.hlsErrorType !== "string" ||
        !hlsTypes.has(data.hlsErrorType)))
  )
    throw new HttpError(400, "invalid_report", "错误报告格式无效");

  // Do not store arbitrary visitor strings as diagnostic identifiers, or expose
  // whether a private/removed version exists through this write-only endpoint.
  const known = await env.DB.prepare(
    "SELECT id FROM versions WHERE id=? AND video_id=?",
  )
    .bind(data.versionId, data.videoId)
    .first<{ id: string }>();
  if (known)
    await log(env, {
      level: "warn",
      stage: "visitor_report",
      requestId,
      videoId: data.videoId,
      message: data.code,
      details: {
        versionId: data.versionId,
        ...(data.nativeErrorCode === undefined
          ? {}
          : { nativeErrorCode: data.nativeErrorCode }),
        ...(data.hlsErrorType === undefined
          ? {}
          : { hlsErrorType: data.hlsErrorType }),
      },
    });
  return json({ accepted: true }, 202);
}
