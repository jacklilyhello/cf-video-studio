import type { Env, Video, Version, Job, Upload } from "./types";
import {
  body,
  forwardRequestBody,
  HttpError,
  id,
  intValue,
  json,
  now,
  sameOrigin,
  textValue,
} from "./http";
import {
  configured,
  isAdmin,
  login,
  logout,
  rateLimit,
  requireAdmin,
  visitorIdentity,
} from "./auth";
import { getHistory, saveHistory, clearHistory } from "./history";
import {
  getWatchSettings,
  readWatchSettings,
  requireViewing,
  watchLogin,
  watchLogout,
  watchSession,
} from "./watch-access";
import { serveMedia } from "./media";
import { createQuote, cancelJob } from "./jobs";
import { resourceUsage, collectResourceUsage } from "./resource-usage";
import { manualUsageRetired } from "./usage-manual";
import { log } from "./logs";
import {
  createDeletionPlan,
  storageList,
  reconcileStorage,
  listDeletionPlans,
  getDeletionPlan,
} from "./storage";
import { PART_BYTES, uploadParts, uploadSpace } from "./uploads";
import {
  startAnalyticsSession,
  acceptAnalyticsSnapshot,
  playbackAnalytics,
  prunePlaybackAnalytics,
} from "./playback-analytics";
import { BUILD_COMMIT } from "./build-info";
import { acceptPlaybackReport } from "./reports";
import { cancelExpiredUploads } from "./maintenance";
import { readPublicationRevision } from "./videos";
import {
  checkSource,
  serveSourcePreview,
  reportSourcePlayback,
  publicSourcePlayback,
} from "./source";
import {
  DEFAULT_SITE_SETTINGS,
  getSite,
  readSiteSettings,
  serveSiteLogo,
} from "./site";
import {
  applySearchIndexingHeaders,
  NO_SEARCH_INDEXING,
  rewriteSiteHtml,
  searchIndexingDirective,
  serveRobots,
  serveSitemap,
} from "./search-indexing";
export { Coordinator } from "./coordinator";
export { Processor, TaskBridge } from "./processor";

async function config(env: Env) {
  const setting = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='progress_interval_seconds'",
  ).first<{ value: string }>();
  const interval = Number(setting?.value);
  return {
    configured: configured(env),
    env: env.APP_ENV ?? "unconfigured",
    processingEnabled: env.PROCESSING_ENABLED === "true",
    progressIntervalSeconds:
      Number.isSafeInteger(interval) && interval >= 15 && interval <= 30
        ? interval
        : 20,
    buildCommit: BUILD_COMMIT,
    usageConfigured: !!env.CF_USAGE_API_TOKEN && !!env.CLOUDFLARE_ACCOUNT_ID,
  };
}
async function publicSiteSettings(env: Env) {
  try {
    return await readSiteSettings(env);
  } catch {
    // Branding failure cannot open indexing or lock an existing media stream.
    return { ...DEFAULT_SITE_SETTINGS };
  }
}
async function indexableSiteSettings(env: Env) {
  const site = await publicSiteSettings(env);
  // The open welcome page may be indexed; protected room/video listings and
  // sitemaps must never disclose titles or identifiers to unauthenticated bots.
  const protectedViewing = await readWatchSettings(env)
    .then((settings) => settings.enabled)
    .catch(() => true);
  return { site, protectedViewing };
}
async function serveApplicationPage(request: Request, env: Env) {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith("/assets/") ||
    url.pathname === "/public-theme.js"
  )
    return applySearchIndexingHeaders(request, await env.ASSETS.fetch(request));
  const headers = new Headers(request.headers);
  // A 304 for the build asset cannot carry newly changed server-side policy.
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  const response = await env.ASSETS.fetch(new Request(request, { headers }));
  if (
    !response.headers.get("Content-Type")?.toLowerCase().includes("text/html")
  )
    return applySearchIndexingHeaders(request, response);
  const { site, protectedViewing } = await indexableSiteSettings(env);
  let publishedVerified = false;
  const videos = url.searchParams.getAll("video");
  if (
    site.searchIndexing &&
    !protectedViewing &&
    url.pathname === "/video" &&
    videos.length === 1 &&
    /^[A-Za-z0-9_-]{1,64}$/.test(videos[0])
  ) {
    try {
      publishedVerified = !!(await env.DB.prepare(
        "SELECT v.id FROM videos v JOIN versions r ON r.id=v.current_version_id AND r.video_id=v.id WHERE v.id=? AND v.published=1 AND r.state='verified'",
      )
        .bind(videos[0])
        .first());
    } catch {
      // Unknown publication is never a reason to expose content to indexing.
    }
  }
  const options = {
    searchIndexing:
      site.searchIndexing && (!protectedViewing || url.pathname === "/"),
    publishedVerified,
  };
  const directive = searchIndexingDirective(request.url, {
    ...options,
    method: request.method,
    status: response.status,
  });
  const suffix = url.pathname.startsWith("/admin")
    ? "管理后台"
    : url.pathname === "/video"
      ? "放映室"
      : "欢迎";
  return applySearchIndexingHeaders(
    request,
    rewriteSiteHtml(response, {
      name: site.name,
      title: `${site.name} · ${suffix}`,
      directive,
    }),
    options,
  );
}
function pageValues(request: Request) {
  const url = new URL(request.url);
  return {
    url,
    page: Math.max(
      1,
      Math.min(100000, Math.floor(Number(url.searchParams.get("page")) || 1)),
    ),
    q: (url.searchParams.get("q") ?? "").slice(0, 200),
    sort:
      url.searchParams.get("sort") === "title"
        ? "title COLLATE NOCASE ASC"
        : "updated_at DESC",
  };
}
async function catalog(request: Request, env: Env, admin: boolean) {
  const { url, page: requestedPage, q, sort } = pageValues(request);
  const size = admin ? 20 : 12;
  const state = (url.searchParams.get("status") ?? "").slice(0, 40);
  let where = admin
    ? "title LIKE ? AND status!='deleted'"
    : "title LIKE ? AND published=1 AND current_version_id IN (SELECT id FROM versions WHERE state='verified')";
  const args = [`%${q}%`];
  if (admin && state) {
    if (state === "published") where += " AND published=1";
    else {
      where += " AND status=?";
      args.push(state);
    }
  }
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM videos WHERE ${where}`,
  )
    .bind(...args)
    .first<{ n: number }>();
  const total = count?.n ?? 0;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / size)));
  const rows = await env.DB.prepare(
    `SELECT * FROM videos WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`,
  )
    .bind(...args, size, (page - 1) * size)
    .all<Video>();
  const items = admin
    ? rows.results
    : await Promise.all(
        rows.results.map(async (v) => {
          const r = await env.DB.prepare(
            "SELECT duration,timeline_id,mode,manifest FROM versions WHERE id=?",
          )
            .bind(v.current_version_id)
            .first<Version>();
          return {
            id: v.id,
            title: v.title,
            duration: r?.duration,
            versionId: v.current_version_id,
            timelineId: r?.timeline_id,
            mediaKind:
              r?.mode === "source"
                ? "source"
                : r?.mode === "faststart"
                  ? "mp4"
                  : "hls",
            mediaName:
              r?.mode === "source"
                ? "source.mp4"
                : r?.mode === "faststart"
                  ? "optimized.mp4"
                  : "index.m3u8",
            updatedAt: v.updated_at,
          };
        }),
      );
  return json({ items, total, page, pageSize: size });
}
async function coordinate(
  request: Request,
  env: Env,
  path: string,
  publicationRevision?: number,
) {
  const declared = request.headers.get("Content-Length");
  if (
    request.method === "PUT" &&
    /^\/uploads\/[^/]+\/parts\/\d+$/.test(path) &&
    declared &&
    /^\d+$/.test(declared) &&
    Number(declared) > PART_BYTES
  )
    throw new HttpError(413, "body_too_large", "请求内容过大");
  const forwarding = forwardRequestBody(request);
  const headers = new Headers(request.headers);
  // This value is captured by the authenticated Worker, never supplied by the
  // browser. A later unpublish revokes requests waiting on ingress or the DO.
  headers.delete("X-Internal-Publication-Revision");
  if (publicationRevision !== undefined)
    headers.set("X-Internal-Publication-Revision", String(publicationRevision));
  // The owned stream may close early and has no fixed-length transport promise.
  // Keep the original part-size rejection above; the DO also measures real bytes.
  headers.delete("Content-Length");
  try {
    return await env.COORDINATOR.get(
      env.COORDINATOR.idFromName("admission"),
    ).fetch(
      new Request(`https://internal${path}`, {
        method: request.method,
        headers,
        body: forwarding.body,
        signal: request.signal,
        duplex: "half",
      } as RequestInit),
    );
  } finally {
    // Stop the owned input before the outer Worker sends an early DO response.
    forwarding.stop();
  }
}
async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname;
  if (path === "/health" && request.method === "GET")
    return json({
      ok: true,
      configured: configured(env),
      buildCommit: BUILD_COMMIT,
      versionId: env.VERSION?.id ?? null,
    });
  if (path === "/api/config" && request.method === "GET")
    return json(await config(env));
  if (path === "/api/site" && request.method === "GET") return getSite(env);
  if (path === "/api/watch/session" && request.method === "GET")
    return watchSession(request, env);
  if (path === "/api/watch/login" && request.method === "POST")
    return watchLogin(request, env);
  if (path === "/api/watch/logout" && request.method === "POST")
    return watchLogout(request, env);
  if (path === "/robots.txt" && ["GET", "HEAD"].includes(request.method)) {
    const { site, protectedViewing } = await indexableSiteSettings(env);
    return serveRobots(request, {
      ...site,
      searchIndexing: site.searchIndexing && !protectedViewing,
    });
  }
  if (path === "/sitemap.xml" && ["GET", "HEAD"].includes(request.method)) {
    const { site, protectedViewing } = await indexableSiteSettings(env);
    return serveSitemap(request, env, {
      ...site,
      searchIndexing: site.searchIndexing && !protectedViewing,
    });
  }
  const logoMatch = /^\/site-logo\/([a-f0-9]{64})\.(png|jpg)$/.exec(path);
  if (logoMatch && ["GET", "HEAD"].includes(request.method))
    return serveSiteLogo(request, env, logoMatch[1], logoMatch[2]);
  if (path.startsWith("/site-logo/"))
    throw new HttpError(404, "logo_missing", "Logo 不可用");
  if (path === "/api/admin/session" && request.method === "GET")
    return json({
      authenticated: await isAdmin(request, env),
      configured: configured(env),
    });
  if (path === "/api/admin/login" && request.method === "POST")
    return login(request, env);
  if (path === "/api/admin/logout" && request.method === "POST")
    return logout(request);
  if (path.startsWith("/api/") && !["GET", "HEAD"].includes(request.method))
    sameOrigin(request);
  // Gate before catalog lookup, publication checks, R2 or internal cache access.
  // A missing/private video must be indistinguishable until viewing is granted.
  if (
    path === "/api/videos" ||
    path.startsWith("/api/videos/") ||
    path === "/api/history" ||
    path.startsWith("/api/history/") ||
    path === "/api/report" ||
    path.startsWith("/media/")
  )
    await requireViewing(request, env);
  if (path === "/api/videos" && request.method === "GET")
    return catalog(request, env, false);
  let match = /^\/api\/videos\/([^/]+)$/.exec(path);
  if (match && request.method === "GET") {
    const v = await env.DB.prepare(
      `SELECT v.id,v.title,r.duration,r.id AS versionId,r.timeline_id AS timelineId,v.updated_at AS updatedAt,CASE WHEN r.mode='source' THEN 'source' WHEN r.mode='faststart' THEN 'mp4' ELSE 'hls' END AS mediaKind,CASE WHEN r.mode='source' THEN 'source.mp4' WHEN r.mode='faststart' THEN 'optimized.mp4' ELSE 'index.m3u8' END AS mediaName,r.mode AS selectedMode,r.bytes AS selectedBytes,r.validation_json AS selectedValidation,v.source_key AS sourceKey,v.source_etag AS sourceEtag,v.source_revision AS sourceRevision,v.source_size AS sourceBytes FROM videos v JOIN versions r ON r.id=v.current_version_id AND r.video_id=v.id WHERE v.id=? AND v.published=1 AND r.state='verified'`,
    )
      .bind(match[1])
      .first<{
        id: string;
        title: string;
        duration: number | null;
        versionId: string;
        timelineId: string;
        updatedAt: number;
        mediaKind: string;
        mediaName: string;
        selectedMode: string;
        selectedBytes: number;
        selectedValidation: string | null;
        sourceKey: string | null;
        sourceEtag: string | null;
        sourceRevision: string;
        sourceBytes: number;
      }>();
    if (!v) throw new HttpError(404, "video_unavailable", "视频不可用");
    const {
      selectedMode,
      selectedBytes,
      selectedValidation,
      sourceKey,
      sourceEtag,
      sourceRevision,
      sourceBytes,
      ...video
    } = v;
    const sourcePlayback = publicSourcePlayback(
      {
        mode: selectedMode,
        bytes: selectedBytes,
        duration: video.duration,
        validation_json: selectedValidation,
      },
      {
        source_key: sourceKey,
        source_etag: sourceEtag,
        source_revision: sourceRevision,
        source_size: sourceBytes,
      },
    );
    return json({ ...video, ...(sourcePlayback ? { sourcePlayback } : {}) });
  }
  if (path === "/api/history/identity" && request.method === "POST")
    return visitorIdentity(request, env);
  if (path === "/api/history") {
    if (request.method === "GET") return getHistory(request, env);
    if (request.method === "POST") return saveHistory(request, env);
    if (request.method === "DELETE") return clearHistory(request, env);
  }
  if (path === "/api/report" && request.method === "POST")
    return acceptPlaybackReport(request, env, requestId);
  if (path === "/api/analytics/session" && request.method === "POST")
    return startAnalyticsSession(request, env);
  if (path === "/api/analytics/event" && request.method === "POST")
    return acceptAnalyticsSnapshot(request, env);
  match = /^\/media\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if (match) {
    const response = await serveMedia(
      request,
      env,
      match[1],
      match[2],
      match[3],
      false,
      ctx,
    );
    const { site, protectedViewing } = await indexableSiteSettings(env);
    return applySearchIndexingHeaders(request, response, {
      searchIndexing: site.searchIndexing && !protectedViewing,
      publishedVerified: response.ok,
    });
  }
  if (path.startsWith("/media/"))
    throw new HttpError(404, "media_unavailable", "媒体不可用");
  if (path.startsWith("/api/admin/")) {
    await requireAdmin(request, env);
    if (path === "/api/admin/usage/manual") return manualUsageRetired();
    if (
      ["/api/admin/resource-usage", "/api/admin/usage"].includes(path) &&
      request.method === "GET"
    ) {
      await rateLimit(env, "resource-usage-panel", 10, 60000);
      return json(
        await resourceUsage(env, {
          refresh: url.searchParams.get("refresh") === "1",
          range: (["24h", "billing", "all"].includes(
            url.searchParams.get("range") ?? "",
          )
            ? url.searchParams.get("range")
            : "24h") as "24h" | "billing" | "all",
          waitUntil: (pending) => ctx.waitUntil(pending),
        }),
      );
    }

    if (path === "/api/admin/watch" && request.method === "GET")
      return getWatchSettings(env);
    if (
      (path === "/api/admin/watch" && request.method === "PATCH") ||
      (path === "/api/admin/watch/revoke" && request.method === "POST")
    ) {
      await rateLimit(env, "watch-settings", 30, 60000);
      return coordinate(
        request,
        env,
        path.replace("/api/admin/watch", "/watch"),
      );
    }
    if (path === "/api/admin/site" && request.method === "GET")
      return getSite(env, true);
    if (path === "/api/admin/site" && request.method === "PATCH") {
      await rateLimit(env, "site-settings", 30, 60000);
      return coordinate(request, env, "/site");
    }
    if (
      path === "/api/admin/site/logo" &&
      ["POST", "DELETE"].includes(request.method)
    ) {
      await rateLimit(env, "site-logo", 15, 60000);
      return coordinate(request, env, "/site/logo");
    }
    match =
      /^\/api\/admin\/source\/([^/]+)\/(check|source\.mp4|playback-report)$/.exec(
        path,
      );
    if (match) {
      if (match[2] === "check" && request.method === "GET") {
        const reuse = url.searchParams.getAll("reuse");
        if (reuse.length > 1 || (reuse.length === 1 && reuse[0] !== "1"))
          throw new HttpError(
            400,
            "invalid_source_reuse",
            "原片检查复用参数无效",
          );
        return checkSource(env, match[1], {
          fresh: reuse.length === 0,
          beforeCheck: () => rateLimit(env, "source-check", 20, 60 * 1000),
          requestId,
          waitUntil: (pending) => ctx.waitUntil(pending),
        });
      }
      if (match[2] === "source.mp4" && ["GET", "HEAD"].includes(request.method))
        return serveSourcePreview(request, env, match[1], {
          requestId,
          waitUntil: (pending) => ctx.waitUntil(pending),
        });
      if (match[2] === "playback-report" && request.method === "POST") {
        await rateLimit(env, "source-playback-report", 30, 60 * 1000);
        return reportSourcePlayback(request, env, match[1]);
      }
    }
    match = /^\/api\/admin\/videos\/([^/]+)\/source-version$/.exec(path);
    if (match && request.method === "POST")
      return coordinate(request, env, `/videos/${match[1]}/source-version`);
    if (path === "/api/admin/upload-approvals" && request.method === "POST")
      return coordinate(request, env, "/upload-approvals");
    match = /^\/api\/admin\/upload-approvals\/([^/]+)\/confirm$/.exec(path);
    if (match && request.method === "POST")
      return coordinate(request, env, `/upload-approvals/${match[1]}/confirm`);
    match = /^\/api\/admin\/preview\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (match)
      return serveMedia(request, env, match[1], match[2], match[3], true, ctx);
    if (path === "/api/admin/overview" && request.method === "GET") {
      const counts = await env.DB.prepare(
        `SELECT COUNT(*) AS videos,COALESCE(SUM(published),0) AS published,COALESCE(SUM(CASE WHEN status='unprocessed' THEN 1 ELSE 0 END),0) AS unprocessed FROM videos WHERE status!='deleted'`,
      ).first();
      const activeJobs = await env.DB.prepare(
        `SELECT * FROM jobs WHERE state IN ('queued','starting','running','stopping','stop_unverified') ORDER BY created_at DESC`,
      ).all();
      const storage = await env.DB.prepare(
        `SELECT COALESCE(SUM(bytes),0) AS n FROM objects WHERE state='present'`,
      ).first<{ n: number }>();
      return json({
        counts,
        activeJobs: activeJobs.results,
        storageBytes: storage?.n ?? 0,
        config: await config(env),
      });
    }
    if (path === "/api/admin/videos" && request.method === "GET")
      return catalog(request, env, true);
    match = /^\/api\/admin\/videos\/([^/]+)$/.exec(path);
    if (match) {
      const video = await env.DB.prepare("SELECT * FROM videos WHERE id=?")
        .bind(match[1])
        .first<Video>();
      if (!video) throw new HttpError(404, "video_missing", "视频不存在");
      if (request.method === "PATCH") {
        const data = await body(request);
        const title = textValue(data.title, "标题");
        await env.DB.prepare(
          "UPDATE videos SET title=?,updated_at=? WHERE id=?",
        )
          .bind(title, now(), video.id)
          .run();
        return json({ updated: true });
      }
      if (request.method === "GET") {
        const [versions, jobs] = await Promise.all([
          env.DB.prepare(
            "SELECT * FROM versions WHERE video_id=? ORDER BY created_at DESC",
          )
            .bind(video.id)
            .all<Version>(),
          env.DB.prepare(
            "SELECT * FROM jobs WHERE video_id=? ORDER BY created_at DESC",
          )
            .bind(video.id)
            .all<Job>(),
        ]);
        return json({ video, versions: versions.results, jobs: jobs.results });
      }
    }
    match = /^\/api\/admin\/videos\/([^/]+)\/(publish|unpublish|quote)$/.exec(
      path,
    );
    if (match && request.method === "POST") {
      if (match[2] === "publish") {
        const revision = await readPublicationRevision(env, match[1]);
        return coordinate(
          request,
          env,
          `/videos/${match[1]}/publish`,
          revision,
        );
      }
      if (match[2] === "quote")
        return createQuote(env, match[1], await body(request));
      await env.DB.prepare(
        "UPDATE videos SET published=0,publication_revision=publication_revision+1,updated_at=? WHERE id=?",
      )
        .bind(now(), match[1])
        .run();
      await log(env, {
        stage: "unpublished",
        videoId: match[1],
        message: "已下架，后续媒体请求在内部缓存读取前拒绝",
      });
      return json({ published: false });
    }
    if (path === "/api/admin/uploads") {
      if (request.method === "POST")
        return coordinate(request, env, "/uploads");
      if (request.method === "GET") {
        const { url, page: requestedPage } = pageValues(request);
        const status = url.searchParams.get("status") ?? "unfinished";
        if (
          !["unfinished", "complete", "cancelled", "expired", "all"].includes(
            status,
          )
        )
          throw new HttpError(400, "invalid_upload_status", "上传状态筛选无效");
        const where =
          status === "unfinished"
            ? "u.state NOT IN ('complete','cancelled','expired')"
            : status === "all"
              ? "1=1"
              : "u.state=?";
        const args = ["unfinished", "all"].includes(status) ? [] : [status];
        let count = env.DB.prepare(
          `SELECT COUNT(*) AS n FROM uploads u WHERE ${where}`,
        );
        if (args.length) count = count.bind(...args);
        const total = (await count.first<{ n: number }>())?.n ?? 0;
        const pageSize = 50;
        const page = Math.min(
          requestedPage,
          Math.max(1, Math.ceil(total / pageSize)),
        );
        const uploads = await env.DB.prepare(
          `SELECT u.*,v.source_name AS name,v.title,(SELECT COALESCE(SUM(p.size),0) FROM upload_parts p WHERE p.upload_id=u.id) AS uploadedBytes FROM uploads u LEFT JOIN videos v ON v.id=u.video_id WHERE ${where} ORDER BY u.created_at DESC,u.id DESC LIMIT ? OFFSET ?`,
        )
          .bind(...args, pageSize, (page - 1) * pageSize)
          .all<
            Upload & {
              name: string | null;
              title: string | null;
              uploadedBytes: number;
            }
          >();
        const hasMore = page * pageSize < total;
        return json({
          items: await Promise.all(
            uploads.results.map(async (u) => ({
              ...u,
              parts: ["complete", "cancelled", "expired"].includes(u.state)
                ? []
                : await uploadParts(env, u.id),
            })),
          ),
          page,
          pageSize,
          total,
          hasMore,
          nextPage: hasMore ? page + 1 : null,
          status,
        });
      }
    }
    match =
      /^\/api\/admin(\/uploads\/[^/]+\/(?:parts\/\d+|complete|cancel))$/.exec(
        path,
      );
    if (match && ["POST", "PUT"].includes(request.method))
      return coordinate(request, env, match[1]);
    if (path === "/api/admin/jobs" && request.method === "GET")
      return json({
        items: (
          await env.DB.prepare(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100",
          ).all()
        ).results,
      });
    match = /^\/api\/admin\/quotes\/([^/]+)\/confirm$/.exec(path);
    if (match && request.method === "POST") {
      const data = await body(request);
      if (data.confirmation !== "START_PAID_TASK")
        throw new HttpError(
          400,
          "confirmation_required",
          "需要管理员明确确认本次报价",
        );
      return coordinate(
        new Request(request.url, { method: "POST" }),
        env,
        `/quotes/${match[1]}/confirm`,
      );
    }
    match = /^\/api\/admin\/jobs\/([^/]+)\/cancel$/.exec(path);
    if (match && request.method === "POST") return cancelJob(env, match[1]);
    if (path === "/api/admin/upload-space" && request.method === "GET")
      return uploadSpace(env);
    if (path === "/api/admin/playback-analytics" && request.method === "GET")
      return playbackAnalytics(request, env);
    match = /^\/api\/admin\/storage\/plans\/([^/]+)\/cancel$/.exec(path);
    if (match && request.method === "POST")
      return coordinate(request, env, `/deletions/${match[1]}/cancel`);
    if (path === "/api/admin/storage" && request.method === "GET")
      return storageList(request, env);
    if (path === "/api/admin/storage/plan" && request.method === "POST")
      return createDeletionPlan(request, env);
    if (path === "/api/admin/storage/plans" && request.method === "GET")
      return listDeletionPlans(request, env);
    if (path === "/api/admin/storage/reconcile" && request.method === "POST") {
      const data = await body(request);
      return reconcileStorage(
        env,
        typeof data.cursor === "string" ? data.cursor : "",
      );
    }
    match = /^\/api\/admin\/storage\/plans\/([^/]+)\/confirm$/.exec(path);
    if (match && request.method === "POST")
      return coordinate(request, env, `/deletions/${match[1]}/confirm`);
    match = /^\/api\/admin\/storage\/plans\/([^/]+)$/.exec(path);
    if (match && request.method === "GET")
      return getDeletionPlan(env, match[1]);
    if (path === "/api/admin/logs" && request.method === "GET") {
      const { page } = pageValues(request);
      const items = await env.DB.prepare(
        "SELECT * FROM logs ORDER BY created_at DESC LIMIT 50 OFFSET ?",
      )
        .bind((page - 1) * 50)
        .all();
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM logs",
      ).first<{ n: number }>();
      return json({
        items: items.results,
        total: count?.n ?? 0,
        page,
        pageSize: 50,
      });
    }
    if (path === "/api/admin/settings") {
      if (request.method === "GET")
        return json({
          settings: (
            await env.DB.prepare(
              "SELECT key,value,updated_at FROM settings WHERE key IN ('processing_concurrency','task_timeout_seconds','history_retention_days','log_retention_days','progress_interval_seconds','storage_limit_bytes','monthly_spend_limit_usd')",
            ).all()
          ).results,
          config: await config(env),
        });
      if (request.method === "PATCH") {
        const values = await body(request);
        const bounds: Record<string, [number, number]> = {
          processing_concurrency: [1, 10],
          task_timeout_seconds: [60, 21600],
          history_retention_days: [1, 3650],
          log_retention_days: [1, 90],
          progress_interval_seconds: [15, 30],
          storage_limit_bytes: [1, 20 * 1024 ** 3],
          monthly_spend_limit_usd: [0, 1000],
        };
        const statements = [];
        for (const [key, value] of Object.entries(values)) {
          if (!bounds[key])
            throw new HttpError(400, "setting_denied", "设置项不允许");
          const number = typeof value === "string" ? Number(value) : value;
          if (key === "monthly_spend_limit_usd") {
            if (
              typeof number !== "number" ||
              !Number.isFinite(number) ||
              number < 0 ||
              number > 1000 ||
              Math.abs(number * 100 - Math.round(number * 100)) > 1e-7
            )
              throw new HttpError(
                400,
                "invalid_currency",
                "预算金额须为不超过两位小数的美元",
              );
          } else intValue(number, ...bounds[key]);
          statements.push(
            env.DB.prepare(
              "UPDATE settings SET value=?,updated_at=? WHERE key=?",
            ).bind(String(number), now(), key),
          );
        }
        if (statements.length) await env.DB.batch(statements);
        return json({ updated: true });
      }
    }
    throw new HttpError(404, "not_found", "接口不存在");
  }
  if (path.startsWith("/api/"))
    throw new HttpError(404, "not_found", "接口不存在");
  if (path.startsWith("/admin/") && !(await isAdmin(request, env)))
    return Response.redirect(`${url.origin}/admin`, 303);
  if (!["GET", "HEAD"].includes(request.method))
    throw new HttpError(405, "method_denied", "请求方法不允许");
  if (path === "/" && url.searchParams.has("video"))
    return new Response(null, {
      status: 303,
      headers: { Location: `/video${url.search}`, "Cache-Control": "no-store" },
    });
  if (path === "/video/")
    return new Response(null, {
      status: 303,
      headers: { Location: `/video${url.search}`, "Cache-Control": "no-store" },
    });
  return serveApplicationPage(request, env);
}
function secure(response: Response, requestId: string) {
  const out = new Response(response.body, response);
  out.headers.set("X-Request-ID", requestId);
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "same-origin");
  out.headers.set("X-Frame-Options", "DENY");
  if (!out.headers.has("X-Robots-Tag"))
    out.headers.set("X-Robots-Tag", NO_SEARCH_INDEXING);
  out.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  out.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  return out;
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const requestId = id();
    try {
      return secure(await route(request, env, ctx, requestId), requestId);
    } catch (error) {
      const known = error instanceof HttpError;
      if (!known)
        ctx.waitUntil(
          log(env, {
            level: "error",
            stage: "request_error",
            requestId,
            message: error instanceof Error ? error.message : "unknown_error",
          }).catch(() => {}),
        );
      return secure(
        json(
          {
            error: {
              code: known ? error.code : "internal_error",
              message: known ? error.message : "暂时无法完成请求，请稍后重试",
              ...(known && error.details ? { details: error.details } : {}),
            },
            requestId,
          },
          known ? error.status : 500,
        ),
        requestId,
      );
    }
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const jobs = await env.DB.prepare(
          `SELECT id FROM jobs WHERE state IN ('queued','starting','running','stopping','stop_unverified')`,
        ).all<{ id: string }>();
        for (const job of jobs.results)
          try {
            await env.PROCESSOR.get(env.PROCESSOR.idFromName(job.id)).fetch(
              "https://processor/supervise",
              { method: "POST", body: JSON.stringify({ jobId: job.id }) },
            );
          } catch {
            await log(env, {
              level: "error",
              taskId: job.id,
              stage: "supervisor_unavailable",
              message: "停止监督调用失败；预算保持预留",
            });
          }
        await cancelExpiredUploads(env);
        if (new Date(event.scheduledTime).getUTCMinutes() !== 0) return;
        await Promise.allSettled([
          collectResourceUsage(env, { at: event.scheduledTime }),
          prunePlaybackAnalytics(env, event.scheduledTime),
        ]);
        const settings = await env.DB.prepare(
          `SELECT key,value FROM settings WHERE key IN ('history_retention_days','log_retention_days')`,
        ).all<{ key: string; value: string }>();
        const values = Object.fromEntries(
          settings.results.map((s) => [s.key, Number(s.value)]),
        );
        await env.DB.batch([
          env.DB.prepare("DELETE FROM watch_history WHERE updated_at<?").bind(
            now() - (values.history_retention_days || 180) * 86400000,
          ),
          env.DB.prepare("DELETE FROM logs WHERE created_at<?").bind(
            now() - (values.log_retention_days || 30) * 86400000,
          ),
          env.DB.prepare(
            `DELETE FROM usage_snapshots WHERE fetched_at<? AND id NOT IN (SELECT snapshot_id FROM reservations WHERE state NOT IN ('released','reconciled')) AND id NOT IN (SELECT snapshot_id FROM quotes WHERE state='open')`,
          ).bind(now() - 30 * 86400000),
        ]);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
