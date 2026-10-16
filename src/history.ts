import type { Env, Version } from "./types";
import {
  visitor,
  clearVisitorCookie,
  rateLimit,
  historyWriteContext,
  validHistoryWriteContext,
} from "./auth";
import { body, HttpError, json, now, sameOrigin, textValue } from "./http";

export async function getHistory(request: Request, env: Env) {
  const identity = await visitor(request, env);
  if (!identity)
    return json({ items: [], cookieEnabled: false, writeContext: null });
  const items = await env.DB.prepare(
    `SELECT h.video_id AS videoId,v.title,h.position,h.duration,h.watched,h.timeline_id AS timelineId,h.updated_at AS updatedAt FROM watch_history h JOIN videos v ON v.id=h.video_id WHERE h.host=? AND h.visitor_hash=? AND v.published=1 ORDER BY h.updated_at DESC LIMIT 200`,
  )
    .bind(new URL(request.url).host, identity)
    .all();
  return json({
    items: items.results,
    cookieEnabled: true,
    writeContext: await historyWriteContext(request, env, identity),
  });
}
export async function saveHistory(request: Request, env: Env) {
  sameOrigin(request);
  const identity = await visitor(request, env);
  if (!identity)
    throw new HttpError(
      409,
      "cookies_required",
      "当前浏览器未接受 Cookie，无法保存观看历史",
    );
  await rateLimit(env, `history:${identity}`, 15, 60 * 1000);
  await rateLimit(env, "history-global", 600, 60 * 1000);
  await rateLimit(
    env,
    `history-ip:${new URL(request.url).host}:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
    60,
    60 * 1000,
  );
  const data = await body(request, 4096);
  if (
    !(await validHistoryWriteContext(request, env, identity, data.writeContext))
  )
    throw new HttpError(
      409,
      "history_identity_changed",
      "观看历史身份已变化，请重新开始记录",
    );
  const videoId = textValue(data.videoId, "视频 ID", 64);
  const version = await env.DB.prepare(
    `SELECT r.* FROM versions r JOIN videos v ON v.current_version_id=r.id WHERE v.id=? AND v.published=1 AND r.state='verified'`,
  )
    .bind(videoId)
    .first<Version>();
  if (!version) throw new HttpError(404, "video_unavailable", "视频不可用");
  if (data.timelineId !== version.timeline_id)
    throw new HttpError(409, "timeline_changed", "视频内容已更新，请从头播放");
  const duration = version.duration ?? 0;
  const position = Number(data.position);
  const played = Number(data.playedSeconds ?? 0);
  const eventAt = Number(data.eventAt);
  if (
    !Number.isFinite(position) ||
    position < 0 ||
    position > duration + 1 ||
    !Number.isFinite(played) ||
    played < 0 ||
    played > 60 ||
    !Number.isSafeInteger(eventAt) ||
    Math.abs(eventAt - now()) > 5 * 60 * 1000
  )
    throw new HttpError(400, "invalid_progress", "观看进度无效");
  const eventId = textValue(data.eventId, "事件 ID", 80);
  const host = new URL(request.url).host;
  // Update only later events. Version changes reset history; duplicate/reordered tabs cannot move it backward in time.
  const previous = await env.DB.prepare(
    "SELECT played_seconds,last_event_at,watched FROM watch_history WHERE host=? AND visitor_hash=? AND video_id=? AND timeline_id=?",
  )
    .bind(host, identity, videoId, version.timeline_id)
    .first<{
      played_seconds: number;
      last_event_at: number;
      watched: number;
    }>();
  const elapsed = previous
    ? Math.max(0, (eventAt - previous.last_event_at) / 1000)
    : 60;
  const increment = Math.min(played, elapsed, 60);
  const manual =
    typeof data.watched === "boolean" ? Number(data.watched) : null;
  const watched =
    manual ??
    Number(
      !!previous?.watched ||
        (position >= duration * 0.95 &&
          (previous?.played_seconds ?? 0) + increment >=
            Math.min(duration * 0.8, 600)),
    );
  const boundedIncrement =
    "MIN(excluded.played_seconds,MAX(0,(excluded.last_event_at-watch_history.last_event_at)/1000.0))";
  await env.DB.prepare(
    `INSERT INTO watch_history(host,visitor_hash,video_id,timeline_id,position,duration,watched,played_seconds,last_event_at,event_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(host,visitor_hash,video_id) DO UPDATE SET timeline_id=excluded.timeline_id,position=excluded.position,duration=excluded.duration,watched=CASE WHEN ? IS NOT NULL THEN ? WHEN watch_history.timeline_id!=excluded.timeline_id THEN excluded.watched ELSE MAX(watch_history.watched,CASE WHEN excluded.position>=excluded.duration*0.95 AND watch_history.played_seconds+${boundedIncrement}>=MIN(excluded.duration*0.8,600) THEN 1 ELSE 0 END) END,played_seconds=CASE WHEN watch_history.timeline_id=excluded.timeline_id THEN watch_history.played_seconds+${boundedIncrement} ELSE excluded.played_seconds END,last_event_at=excluded.last_event_at,event_id=excluded.event_id,updated_at=excluded.updated_at WHERE excluded.last_event_at>watch_history.last_event_at AND excluded.event_id!=watch_history.event_id`,
  )
    .bind(
      host,
      identity,
      videoId,
      version.timeline_id,
      Math.min(position, duration),
      duration,
      watched,
      increment,
      eventAt,
      eventId,
      now(),
      manual,
      manual,
    )
    .run();
  return json({ saved: true });
}
export async function clearHistory(request: Request, env: Env) {
  sameOrigin(request);
  const identity = await visitor(request, env);
  if (identity)
    await env.DB.prepare(
      "DELETE FROM watch_history WHERE host=? AND visitor_hash=?",
    )
      .bind(new URL(request.url).host, identity)
      .run();
  return json({ cleared: true }, 200, { "Set-Cookie": clearVisitorCookie() });
}
