import type { Env } from "./types";
import { cookieHeader, isAdmin, rateLimit, sign, visitor, equal } from "./auth";
import { body, HttpError, json, now, sameOrigin, sha256 } from "./http";
import { requireViewing } from "./watch-access";

const DAY = 86400000;
const KEEP_DAYS = 30;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Session = {
  id: string;
  visitor: string;
  host: string;
  kind: string;
  video_id: string;
  version_id: string;
  started_at: number;
  last_at: number;
  seq: number;
  excluded: number;
  started: number;
  watched_seconds: number;
  duration: number;
  intervals_json: string;
  completed: number;
  active: number;
  startup_ms: number | null;
  errors: number;
  stalls: number;
  country: string;
  browser: string;
  os: string;
  device: string;
};
export function singaporeDay(t: number) {
  return new Date(t + 8 * 3600000).toISOString().slice(0, 10);
}
export function analyticsRange(range: string | null, at = now()) {
  const today = Date.parse(singaporeDay(at) + "T00:00:00+08:00");
  const key = ["today", "24h", "7d", "30d"].includes(range ?? "")
    ? range!
    : "7d";
  return {
    start:
      key === "today"
        ? today
        : key === "24h"
          ? at - DAY
          : today - (key === "7d" ? 6 : 29) * DAY,
    end: at,
    label:
      key === "today"
        ? "今天 · 新加坡时间"
        : key === "24h"
          ? "近24小时"
          : key === "7d"
            ? "近7天"
            : "近30天",
    key,
  };
}
export function parseUserAgent(ua: string) {
  const browser = /Edg(?:iOS|A)?\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /CriOS\//.test(ua)
          ? "Chrome"
          : /Chrome\//.test(ua)
            ? "Chrome"
            : /Version\/.+Safari\//.test(ua)
              ? "Safari"
              : "未知";
  const os =
    /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))
      ? "iOS"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Macintosh|Mac OS X/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "未知";
  const device =
    /iPad|Tablet/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))
      ? "平板"
      : /Mobile|iPhone|iPod|Android/.test(ua)
        ? "手机"
        : browser === "未知"
          ? "未知"
          : "电脑";
  return { browser, os, device };
}
export function mergeWatchIntervals(
  value: unknown,
  duration: number,
  maxRanges = 128,
): [number, number][] {
  if (!Array.isArray(value) || value.length > maxRanges)
    throw new HttpError(400, "invalid_analytics", "观看区间无效");
  const ranges = value
    .map((v): [number, number] => {
      if (
        !Array.isArray(v) ||
        v.length !== 2 ||
        v.some((n) => typeof n !== "number" || !Number.isFinite(n)) ||
        v[0] < 0 ||
        v[1] < v[0] ||
        v[1] > duration + 0.1
      )
        throw new HttpError(400, "invalid_analytics", "观看区间无效");
      return [v[0], Math.min(duration, v[1])];
    })
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1] + 0.001) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}
export function watchedCoverage(ranges: [number, number][]) {
  return ranges.reduce((n, [a, b]) => n + b - a, 0);
}
const finite = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
const safeText = (v: unknown, max: number) =>
  typeof v === "string"
    ? v.replace(/[\x00-\x1f\x7f]/g, "").slice(0, max)
    : null;
const token = (
  env: Env,
  s: Pick<Session, "id" | "host" | "visitor" | "started_at">,
) => sign(env, `analytics:${s.host}:${s.visitor}:${s.id}:${s.started_at}`);
function dimension(s: Session, day: string) {
  return [day, s.host, s.video_id, s.country, s.browser, s.os, s.device];
}
function addDaily(
  env: Env,
  s: Session,
  day: string,
  delta: number[],
  guard: string,
  params: unknown[],
) {
  return env.DB.prepare(
    `INSERT INTO analytics_daily(day,host,video_id,country,browser,os,device,visits,plays,watched_seconds,completed,errors,stalls,startup_total_ms,startup_count,attempts)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}
 ON CONFLICT(day,host,video_id,country,browser,os,device) DO UPDATE SET
 visits=visits+excluded.visits,plays=plays+excluded.plays,watched_seconds=watched_seconds+excluded.watched_seconds,
 completed=completed+excluded.completed,errors=errors+excluded.errors,stalls=stalls+excluded.stalls,
 startup_total_ms=startup_total_ms+excluded.startup_total_ms,startup_count=startup_count+excluded.startup_count,attempts=attempts+excluded.attempts`,
  ).bind(...dimension(s, day), ...delta.slice(0, 8), delta[8] ?? 0, ...params);
}
function addIncrement(
  env: Env,
  s: Session,
  seq: number,
  start: number,
  end: number,
  delta: number[],
  guard: string,
  params: unknown[],
) {
  return env.DB.prepare(
    `INSERT INTO analytics_increments(session_id,seq,visitor,host,video_id,country,browser,os,device,start_at,end_at,visits,plays,watched_seconds,completed,errors,stalls,startup_total_ms,startup_count,attempts)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`,
  ).bind(
    s.id,
    seq,
    s.visitor,
    s.host,
    s.video_id,
    s.country,
    s.browser,
    s.os,
    s.device,
    start,
    end,
    ...delta,
    ...params,
  );
}
/** Boundaries split only the one reporting batch that overlaps them. */
export function splitWatchTime(start: number, end: number, seconds: number) {
  const parts: { day: string; seconds: number }[] = [];
  if (end <= start || seconds <= 0) return parts;
  let cursor = start;
  while (cursor < end) {
    const day = singaporeDay(cursor),
      next = Date.parse(day + "T00:00:00+08:00") + DAY;
    const until = Math.min(end, next);
    parts.push({ day, seconds: (seconds * (until - cursor)) / (end - start) });
    cursor = until;
  }
  return parts;
}
export async function startAnalyticsSession(request: Request, env: Env) {
  sameOrigin(request);
  const data = await body(request, 2048);
  if (
    typeof data.id !== "string" ||
    !UUID.test(data.id) ||
    typeof data.kind !== "string" ||
    !["visit", "playback"].includes(data.kind)
  )
    throw new HttpError(400, "invalid_analytics", "统计会话无效");
  await rateLimit(
    env,
    `analytics-start:${new URL(request.url).host}:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
    40,
    60000,
  );
  let identity = await visitor(request, env),
    setCookie: string | undefined;
  if (!identity) {
    const nonce = crypto.randomUUID();
    const host = new URL(request.url).host;
    const signature = await sign(env, `visitor:${host}:${nonce}`);
    identity = await sha256(`${host}:${nonce}`);
    setCookie = cookieHeader(
      "__Host-vh_visitor",
      `${nonce}.${signature}`,
      180 * 86400,
    );
  }
  const host = new URL(request.url).host;
  let videoId = "",
    versionId = "",
    duration = 0;
  if (data.kind === "playback") {
    await requireViewing(request, env);
    if (
      typeof data.videoId !== "string" ||
      typeof data.versionId !== "string" ||
      !UUID.test(data.videoId) ||
      !UUID.test(data.versionId)
    )
      throw new HttpError(400, "invalid_analytics", "统计视频无效");
    const v = await env.DB.prepare(
      "SELECT r.duration FROM videos v JOIN versions r ON r.id=v.current_version_id AND r.video_id=v.id WHERE v.id=? AND r.id=? AND v.published=1 AND r.state='verified'",
    )
      .bind(data.videoId, data.versionId)
      .first<{ duration: number }>();
    if (!v || !finite(v.duration, 864000) || v.duration <= 0)
      throw new HttpError(404, "video_unavailable", "视频不可用");
    videoId = data.videoId;
    versionId = data.versionId;
    duration = v.duration;
  }
  const ua = safeText(request.headers.get("User-Agent"), 512) ?? "";
  const excluded =
    (await isAdmin(request, env)) ||
    data.automation === true ||
    /bot|crawler|spider|headless|healthcheck/i.test(ua)
      ? 1
      : 0;
  const cf = request.cf;
  let referer: string | null = null;
  try {
    referer = new URL(request.headers.get("Referer") ?? "").hostname.slice(
      0,
      253,
    );
  } catch {}
  const rawIp = request.headers.get("CF-Connecting-IP");
  const ip =
    rawIp && rawIp.length <= 45 && /^[0-9a-fA-F:.]+$/.test(rawIp)
      ? rawIp
      : null;
  const at = now(),
    agent = parseUserAgent(ua);
  const s = {
    id: data.id,
    host,
    visitor: identity,
    kind: String(data.kind),
    video_id: videoId,
    version_id: versionId,
    duration,
    started_at: at,
    last_at: at,
    seq: 0,
    excluded,
    started: 0,
    watched_seconds: 0,
    completed: 0,
    startup_ms: null,
    errors: 0,
    stalls: 0,
    intervals_json: "[]",
    active: 0,
    country: safeText(cf?.country, 8) || "未知",
    ...agent,
  };
  const guard =
    "EXISTS(SELECT 1 FROM analytics_sessions WHERE id=? AND visitor=? AND host=? AND counted=0 AND excluded=0)";
  const statements = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO analytics_sessions(id,visitor,host,kind,video_id,version_id,started_at,last_at,excluded,ip,country,region,city,asn,ua,browser,os,device,referrer_host,duration) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      s.id,
      identity,
      host,
      s.kind,
      videoId,
      versionId,
      at,
      at,
      excluded,
      ip,
      s.country,
      safeText(cf?.region, 100),
      safeText(cf?.city, 100),
      typeof cf?.asn === "number" &&
        Number.isSafeInteger(cf.asn) &&
        cf.asn >= 0 &&
        cf.asn <= 4294967295
        ? cf.asn
        : null,
      ua,
      agent.browser,
      agent.os,
      agent.device,
      referer,
      duration,
    ),
  ];
  statements.push(
    addIncrement(
      env,
      s,
      0,
      at,
      at,
      [
        data.kind === "visit" ? 1 : 0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        data.kind === "playback" ? 1 : 0,
      ],
      guard,
      [s.id, identity, host],
    ),
  );
  statements.push(
    addDaily(
      env,
      s,
      singaporeDay(at),
      [
        data.kind === "visit" ? 1 : 0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        data.kind === "playback" ? 1 : 0,
      ],
      guard,
      [s.id, identity, host],
    ),
  );
  statements.push(
    env.DB.prepare(
      "UPDATE analytics_sessions SET counted=1 WHERE id=? AND visitor=? AND host=?",
    ).bind(s.id, identity, host),
  );
  await env.DB.batch(statements);
  const saved = await env.DB.prepare(
    "SELECT * FROM analytics_sessions WHERE id=? AND visitor=? AND host=?",
  )
    .bind(s.id, identity, host)
    .first<Session>();
  if (
    !saved ||
    saved.kind !== s.kind ||
    saved.video_id !== videoId ||
    saved.version_id !== versionId
  )
    throw new HttpError(409, "analytics_context_changed", "统计会话已变化");
  return json(
    {
      id: saved.id,
      token: await token(env, saved),
      excluded: !!saved.excluded,
      seq: saved.seq,
      watchedSeconds: saved.watched_seconds,
      intervals: JSON.parse(saved.intervals_json),
      started: !!saved.started,
      completed: !!saved.completed,
      errors: saved.errors,
      stalls: saved.stalls,
      startupMs: saved.startup_ms,
      startedAt: saved.started_at,
    },
    200,
    setCookie ? { "Set-Cookie": setCookie } : {},
  );
}
export async function acceptAnalyticsSnapshot(request: Request, env: Env) {
  sameOrigin(request);
  await requireViewing(request, env);
  const data = await body(request, 8192);
  if (
    typeof data.id !== "string" ||
    !UUID.test(data.id) ||
    typeof data.token !== "string" ||
    !Number.isSafeInteger(data.seq) ||
    Number(data.seq) < 1
  )
    throw new HttpError(400, "invalid_analytics", "统计事件无效");
  const identity = await visitor(request, env),
    host = new URL(request.url).host;
  const s = await env.DB.prepare(
    "SELECT * FROM analytics_sessions WHERE id=? AND visitor=? AND host=?",
  )
    .bind(data.id, identity ?? "", host)
    .first<Session>();
  if (
    !s ||
    s.kind !== "playback" ||
    !(await equal(data.token, await token(env, s)))
  )
    throw new HttpError(403, "analytics_context_changed", "统计会话无效");
  if (Number(data.seq) <= s.seq)
    return json({ accepted: true, duplicate: true }, 202);
  await rateLimit(env, `analytics-event:${host}:${identity}`, 20, 60000);
  const available = await env.DB.prepare(
    "SELECT 1 ok FROM videos v JOIN versions r ON r.id=v.current_version_id AND r.video_id=v.id WHERE v.id=? AND r.id=? AND v.published=1 AND r.state='verified'",
  )
    .bind(s.video_id, s.version_id)
    .first();
  if (!available) throw new HttpError(404, "video_unavailable", "视频不可用");
  const at = now();
  if (
    at - s.started_at > 24 * 3600000 ||
    (at - s.last_at < 1000 &&
      !(s.seq === 0 && data.started === true && data.watchedSeconds === 0))
  )
    return json({ accepted: false, reason: "event_window" }, 202);
  if (
    !finite(data.watchedSeconds, 864000) ||
    !finite(data.errors, 100) ||
    !Number.isInteger(data.errors) ||
    !finite(data.stalls, 10000) ||
    !Number.isInteger(data.stalls) ||
    data.watchedSeconds < s.watched_seconds ||
    data.errors < s.errors ||
    data.stalls < s.stalls
  )
    throw new HttpError(400, "invalid_analytics", "统计计数无效");
  const ranges = mergeWatchIntervals(data.intervals, s.duration);
  const previous = mergeWatchIntervals(
    JSON.parse(s.intervals_json),
    s.duration,
  );
  const mergedAll = mergeWatchIntervals(
    [...previous, ...ranges],
    s.duration,
    256,
  );
  // Retain the largest intervals if excessive seeking fragments the map. This
  // keeps completion conservative rather than joining gaps that were skipped.
  const merged =
    mergedAll.length <= 128
      ? mergedAll
      : mergedAll
          .sort((a, b) => b[1] - b[0] - (a[1] - a[0]))
          .slice(0, 128)
          .sort((a, b) => a[0] - b[0]);
  const coverage = watchedCoverage(merged);
  const delta = data.watchedSeconds - s.watched_seconds;
  // Client batches at 30 seconds. Bound client-reported work by elapsed server
  // time and playback rate; a seek must never turn into watched duration.
  if (
    delta > ((at - s.last_at) / 1000) * 4 + 1 ||
    coverage > data.watchedSeconds + 1
  )
    throw new HttpError(400, "invalid_analytics", "观看时长不符合实际时间范围");
  const started = s.started || data.started === true ? 1 : 0;
  if (!started && (data.watchedSeconds > 0 || coverage > 0))
    throw new HttpError(
      400,
      "invalid_analytics",
      "尚未开始播放，不能累计观看时长",
    );
  const active =
    started &&
    data.playing === true &&
    data.ended !== true &&
    data.error !== true
      ? 1
      : 0;
  const completed =
    s.completed ||
    (data.ended === true &&
      coverage >= s.duration * 0.9 &&
      data.watchedSeconds >= s.duration * 0.9)
      ? 1
      : 0;
  const startup =
    s.startup_ms ??
    (started && finite(data.startupMs, 120000) ? data.startupMs : null);
  const result =
    data.error === true
      ? "播放失败"
      : data.ended === true
        ? "播放结束"
        : started
          ? "已开始播放"
          : "尝试播放";
  const guard =
    "EXISTS(SELECT 1 FROM analytics_sessions WHERE id=? AND seq=? AND excluded=0)";
  const params = [s.id, s.seq];
  const statements: D1PreparedStatement[] = [];
  const day = singaporeDay(at);
  const portions = splitWatchTime(s.last_at, at, delta);
  const currentDelta = portions
    .filter((p) => p.day === day)
    .reduce((n, p) => n + p.seconds, 0);
  for (const portion of portions)
    if (portion.day !== day)
      statements.push(
        addDaily(
          env,
          s,
          portion.day,
          [0, 0, portion.seconds, 0, 0, 0, 0, 0],
          guard,
          params,
        ),
      );
  if (!s.excluded) {
    statements.push(
      addIncrement(
        env,
        s,
        Number(data.seq),
        s.last_at,
        at,
        [
          0,
          started - s.started,
          delta,
          completed - s.completed,
          data.errors - s.errors,
          data.stalls - s.stalls,
          s.startup_ms === null && startup !== null ? startup : 0,
          s.startup_ms === null && startup !== null ? 1 : 0,
          0,
        ],
        guard,
        params,
      ),
    );
    statements.push(
      addDaily(
        env,
        s,
        day,
        [
          0,
          started - s.started,
          currentDelta,
          completed - s.completed,
          data.errors - s.errors,
          data.stalls - s.stalls,
          s.startup_ms === null && startup !== null ? startup : 0,
          s.startup_ms === null && startup !== null ? 1 : 0,
        ],
        guard,
        params,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE analytics_sessions SET last_at=?,seq=?,started=?,watched_seconds=?,intervals_json=?,completed=?,startup_ms=?,errors=?,stalls=?,result=?,active=? WHERE id=? AND seq=?`,
    ).bind(
      at,
      data.seq,
      started,
      data.watchedSeconds,
      JSON.stringify(merged),
      completed,
      startup,
      data.errors,
      data.stalls,
      result,
      active,
      s.id,
      s.seq,
    ),
  );
  const results = await env.DB.batch(statements);
  return json(
    {
      accepted: true,
      ...(results.at(-1)?.meta.changes === 0 ? { duplicate: true } : {}),
    },
    202,
  );
}
export async function playbackAnalytics(request: Request, env: Env) {
  const url = new URL(request.url),
    range = analyticsRange(url.searchParams.get("range"));
  const host = (url.searchParams.get("host") ?? "").slice(0, 253),
    videoId = (url.searchParams.get("videoId") ?? "").slice(0, 64);
  const suppliedPage = Number(url.searchParams.get("page"));
  const page = Number.isSafeInteger(suppliedPage)
    ? Math.max(1, Math.min(10000, suppliedPage))
    : 1;
  const dimensions = (alias: string) =>
    (host ? ` AND ${alias}.host=?` : "") +
    (videoId ? ` AND ${alias}.video_id=?` : "");
  const filters = [...(host ? [host] : []), ...(videoId ? [videoId] : [])];
  // Event counters belong to their observation time. Duration uses interval
  // overlap so sessions that started before the range still contribute only
  // their in-range work; retained session totals are never summed as increments.
  const timed = `SELECT e.*,CASE WHEN e.end_at>=? AND e.end_at<=? THEN 1 ELSE 0 END inside,
 CASE WHEN e.end_at>e.start_at THEN MAX(0,MIN(e.end_at,?)-MAX(e.start_at,?))*1.0/(e.end_at-e.start_at) ELSE 0 END portion
 FROM analytics_increments e WHERE e.end_at>=? AND e.start_at<=?${dimensions("e")}`;
  const timedArgs = [
    range.start,
    range.end,
    range.end,
    range.start,
    range.start,
    range.end,
    ...filters,
  ];
  const cte = `WITH selected AS (${timed})`;
  const summaries = await env.DB.prepare(
    `${cte} SELECT COALESCE(SUM(visits*inside),0) visits,
 COUNT(DISTINCT CASE WHEN visits*inside>0 THEN host||':'||visitor END) visitors,
 COALESCE(SUM(attempts*inside),0) attempts,COALESCE(SUM(plays*inside),0) plays,
 COUNT(DISTINCT CASE WHEN plays*inside>0 OR watched_seconds*portion>0 THEN host||':'||visitor END) viewers,
 COALESCE(SUM(watched_seconds*portion),0) watchedSeconds,COALESCE(SUM(completed*inside),0) completed,
 SUM(startup_total_ms*inside)/NULLIF(SUM(startup_count*inside),0) startupMs,
 COALESCE(SUM(errors*inside),0) errors,COALESCE(SUM(stalls*inside),0) stalls FROM selected`,
  )
    .bind(...timedArgs)
    .first();
  const active = await env.DB.prepare(
    `SELECT COUNT(DISTINCT host||':'||visitor) n FROM analytics_sessions s WHERE s.excluded=0 AND s.started=1 AND s.active=1 AND s.last_at>?${dimensions("s")}`,
  )
    .bind(range.end - 300000, ...filters)
    .first<{ n: number }>();
  const summary = {
    visits: 0,
    visitors: 0,
    attempts: 0,
    plays: 0,
    viewers: 0,
    watchedSeconds: 0,
    completed: 0,
    startupMs: null,
    errors: 0,
    stalls: 0,
    ...summaries,
    recentActive: active?.n ?? 0,
  };
  const trendResult = await env.DB.prepare(
    `${cte} SELECT start_at,end_at,watched_seconds,visits,plays,inside FROM selected ORDER BY end_at`,
  )
    .bind(...timedArgs)
    .all<{
      start_at: number;
      end_at: number;
      watched_seconds: number;
      visits: number;
      plays: number;
      inside: number;
    }>();
  const days = new Map<
    string,
    { day: string; visits: number; plays: number; watchedSeconds: number }
  >();
  const dayRow = (day: string) => {
    let row = days.get(day);
    if (!row) {
      row = { day, visits: 0, plays: 0, watchedSeconds: 0 };
      days.set(day, row);
    }
    return row;
  };
  for (const e of trendResult.results) {
    if (e.inside) {
      const row = dayRow(singaporeDay(e.end_at));
      row.visits += e.visits;
      row.plays += e.plays;
    }
    const from = Math.max(e.start_at, range.start),
      to = Math.min(e.end_at, range.end);
    if (to > from)
      for (const part of splitWatchTime(
        from,
        to,
        (e.watched_seconds * (to - from)) / (e.end_at - e.start_at),
      ))
        dayRow(part.day).watchedSeconds += part.seconds;
  }
  const sessionWhere =
    "s.last_at>=? AND s.started_at<=? AND s.excluded=0" + dimensions("s");
  const sessionArgs = [range.start, range.end, ...filters];
  const queries = [
    env.DB.prepare(
      `${cte} SELECT e.video_id videoId,COALESCE(v.title,'已删除的视频') title,SUM(e.plays*e.inside) plays,SUM(e.watched_seconds*e.portion) watchedSeconds,SUM(e.completed*e.inside) completed FROM selected e LEFT JOIN videos v ON v.id=e.video_id WHERE e.video_id<>'' GROUP BY e.video_id ORDER BY plays DESC LIMIT 30`,
    ).bind(...timedArgs),
    ...["host", "country", "browser", "os", "device"].map((dim) =>
      env.DB.prepare(
        `${cte} SELECT ${dim},SUM(visits*inside) visits,SUM(plays*inside) plays FROM selected GROUP BY ${dim} ORDER BY plays DESC,visits DESC LIMIT 30`,
      ).bind(...timedArgs),
    ),
    env.DB.prepare(
      `SELECT s.id,s.started_at,s.last_at,s.video_id,v.title,s.version_id,s.host,s.ip,s.country,s.region,s.city,s.asn,s.ua,s.browser,s.os,s.device,s.referrer_host,s.started,s.watched_seconds,s.duration,s.completed,s.startup_ms,s.errors,s.stalls,s.result FROM analytics_sessions s LEFT JOIN videos v ON v.id=s.video_id WHERE ${sessionWhere} ORDER BY s.started_at DESC LIMIT 30 OFFSET ?`,
    ).bind(...sessionArgs, (page - 1) * 30),
    env.DB.prepare(
      `SELECT COUNT(*) total FROM analytics_sessions s WHERE ${sessionWhere}`,
    ).bind(...sessionArgs),
    env.DB.prepare("SELECT value FROM settings WHERE key='analytics_since'"),
    env.DB.prepare(
      `SELECT COALESCE(SUM(visits),0) visits,COALESCE(SUM(attempts),0) attempts,COALESCE(SUM(plays),0) plays,COALESCE(SUM(watched_seconds),0) watchedSeconds,COALESCE(SUM(completed),0) completed FROM analytics_daily d WHERE 1=1${dimensions("d")}`,
    ).bind(...filters),
  ];
  const results = await env.DB.batch(queries);
  const [
    videos,
    hosts,
    countries,
    browsers,
    systems,
    devices,
    sessions,
    total,
    since,
    lifetime,
  ] = results;
  return json({
    range,
    summary,
    trend: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    videos: videos.results,
    hosts: hosts.results,
    countries: countries.results,
    browsers: browsers.results,
    systems: systems.results,
    devices: devices.results,
    sessions: {
      items: sessions.results,
      total: (total.results[0] as { total?: number } | undefined)?.total ?? 0,
      page,
      pageSize: 30,
    },
    lifetime: lifetime.results[0],
    coverage: {
      since:
        Number((since.results[0] as { value?: string } | undefined)?.value) ||
        null,
      detailDays: KEEP_DAYS,
      aggregateDays: "永久",
      note: "人数按当前域名和浏览器 Cookie 去重，不等于自然人，不跨域识别。最近活跃指过去5分钟仍在播放且有事件的会话；地区是IP推断。观看时长按实际连续播放累计，跨时间边界的一批上报按时间区间比例分配。明细和范围增量保留30天，长期每日汇总独立保留；验收、机器人和管理员预览不进入普通统计。会话明细显示整段会话，汇总只含筛选范围。",
    },
  });
}
export async function prunePlaybackAnalytics(env: Env, at = now()) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM analytics_sessions WHERE started_at<?").bind(
      at - KEEP_DAYS * DAY,
    ),
    env.DB.prepare("DELETE FROM analytics_increments WHERE end_at<?").bind(
      at - KEEP_DAYS * DAY,
    ),
  ]);
}
