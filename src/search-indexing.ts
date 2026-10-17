import type { Env } from "./types";

export const NO_SEARCH_INDEXING = "noindex, nofollow";
export const SEARCH_INDEXING = "index, follow";
export type SearchIndexingDirective =
  typeof NO_SEARCH_INDEXING | typeof SEARCH_INDEXING;
export interface SearchIndexingOptions {
  searchIndexing?: boolean;
  status?: number;
  method?: string;
  // Supplied only after the existing publication/version authorization. This
  // advisory policy does not grant access or replace the media route's checks.
  publishedVerified?: boolean;
}

/** Robots directives control cooperative search engines, never authorization. */
export function searchIndexingDirective(
  url: string | URL,
  options: SearchIndexingOptions = {},
): SearchIndexingDirective {
  if (options.searchIndexing !== true) return NO_SEARCH_INDEXING;
  const status = options.status ?? 200;
  if (!Number.isInteger(status) || status < 200 || status >= 300)
    return NO_SEARCH_INDEXING;
  if (options.method && !["GET", "HEAD"].includes(options.method))
    return NO_SEARCH_INDEXING;
  let target: URL;
  try {
    target = new URL(String(url));
  } catch {
    return NO_SEARCH_INDEXING;
  }
  if (!["http:", "https:"].includes(target.protocol)) return NO_SEARCH_INDEXING;
  const videos = target.searchParams.getAll("video");
  const selected =
    videos.length === 1 && /^[A-Za-z0-9_-]{1,64}$/.test(videos[0]);
  if (target.pathname === "/" || target.pathname === "/video")
    return videos.length === 0 ||
      (selected && options.publishedVerified === true)
      ? SEARCH_INDEXING
      : NO_SEARCH_INDEXING;
  if (
    /^\/media\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[^/]+$/.test(target.pathname) &&
    options.publishedVerified === true
  )
    return SEARCH_INDEXING;
  // Admin, every API endpoint, static resources and unknown SPA paths remain
  // noindex even when an unrelated caller supplies a publication flag.
  return NO_SEARCH_INDEXING;
}

export function applySearchIndexingHeaders(
  request: Request,
  response: Response,
  options: SearchIndexingOptions = {},
): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "X-Robots-Tag",
    searchIndexingDirective(request.url, {
      ...options,
      status: response.status,
      method: request.method,
    }),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function escapeMarkup(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return escaped[character];
  });
}
export interface SiteHtmlOptions {
  name: string;
  title?: string;
  directive?: SearchIndexingDirective;
}
export function siteHeadMarkup(options: SiteHtmlOptions): string {
  const text = (value: string, max: number) =>
    value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, max);
  const name = text(options.name, 120) || "Video Hub";
  const title = text(options.title ?? name, 200) || name;
  const directive =
    options.directive === SEARCH_INDEXING
      ? SEARCH_INDEXING
      : NO_SEARCH_INDEXING;
  return `<title>${escapeMarkup(title)}</title><meta name="robots" content="${directive}"><meta property="og:site_name" content="${escapeMarkup(name)}">`;
}

export function rewriteSiteHtml(
  response: Response,
  options: SiteHtmlOptions,
  makeRewriter: () => HTMLRewriter = () => new HTMLRewriter(),
): Response {
  const headers = new Headers(response.headers);
  const html = response.headers
    .get("Content-Type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (response.status !== 200 || html !== "text/html") {
    headers.set("X-Robots-Tag", NO_SEARCH_INDEXING);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const directive =
    options.directive === SEARCH_INDEXING
      ? SEARCH_INDEXING
      : NO_SEARCH_INDEXING;
  headers.set("X-Robots-Tag", directive);
  headers.set("Cache-Control", "no-store");
  for (const name of ["Content-Length", "ETag", "Last-Modified", "Content-MD5"])
    headers.delete(name);
  const remove = {
    element: (element: Element) => {
      element.remove();
    },
  };
  const robotNames = new Set([
    "robots",
    "googlebot",
    "googlebot-news",
    "bingbot",
    "slurp",
    "yandexbot",
    "baiduspider",
    "duckduckbot",
  ]);
  return makeRewriter()
    .on("head title", remove)
    .on("head meta", {
      element(element) {
        const name = element.getAttribute("name")?.trim().toLowerCase();
        const property = element.getAttribute("property")?.trim().toLowerCase();
        if ((name && robotNames.has(name)) || property === "og:site_name")
          element.remove();
      },
    })
    .on("head", {
      element(element) {
        element.append(siteHeadMarkup({ ...options, directive }), {
          html: true,
        });
      },
    })
    .transform(
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
    );
}

function origin(request: Request): string {
  const url = new URL(request.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw new Error("invalid_indexing_origin");
  return url.origin;
}
function textResponse(
  request: Request,
  value: string,
  type: string,
  status = 200,
) {
  return new Response(request.method === "HEAD" ? null : value, {
    status,
    headers: {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Robots-Tag": NO_SEARCH_INDEXING,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function methodDenied(request: Request) {
  const response = textResponse(
    request,
    "Method not allowed\n",
    "text/plain; charset=utf-8",
    405,
  );
  response.headers.set("Allow", "GET, HEAD");
  return response;
}

export function serveRobots(
  request: Request,
  options: { searchIndexing?: boolean } = {},
): Response {
  if (!["GET", "HEAD"].includes(request.method)) return methodDenied(request);
  const rules = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /api/",
  ];
  if (options.searchIndexing === true)
    rules.push(`Sitemap: ${origin(request)}/sitemap.xml`);
  return textResponse(
    request,
    rules.join("\n") + "\n",
    "text/plain; charset=utf-8",
  );
}

// The protocol permits 50,000 URLs per sitemap. Read one sentinel row beyond
// the available video slots, and fail rather than silently publish a partial list.
const SITEMAP_VIDEO_LIMIT = 49999;
export async function serveSitemap(
  request: Request,
  env: Pick<Env, "DB">,
  options: { searchIndexing?: boolean } = {},
): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method)) return methodDenied(request);
  if (options.searchIndexing !== true)
    return textResponse(
      request,
      "Not found\n",
      "text/plain; charset=utf-8",
      404,
    );
  const currentOrigin = origin(request);
  try {
    const result = await env.DB.prepare(
      `SELECT v.id FROM videos v JOIN versions r ON r.id=v.current_version_id AND r.video_id=v.id
       WHERE v.published=1 AND v.status!='deleted' AND r.state='verified'
       ORDER BY v.id LIMIT ?`,
    )
      .bind(SITEMAP_VIDEO_LIMIT + 1)
      .all<{ id: string }>();
    if (
      result.success !== true ||
      !Array.isArray(result.results) ||
      result.results.length > SITEMAP_VIDEO_LIMIT ||
      result.results.some((row) => !/^[A-Za-z0-9_-]{1,64}$/.test(row.id)) ||
      new Set(result.results.map((row) => row.id)).size !==
        result.results.length
    )
      throw new Error("sitemap_inventory_unverified");
    const urls = [
      `${currentOrigin}/`,
      ...result.results.map(
        (row) => `${currentOrigin}/video?video=${encodeURIComponent(row.id)}`,
      ),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
      .map((url) => `<url><loc>${escapeMarkup(url)}</loc></url>`)
      .join("")}</urlset>\n`;
    return textResponse(request, xml, "application/xml; charset=utf-8");
  } catch {
    return textResponse(
      request,
      "Sitemap unavailable\n",
      "text/plain; charset=utf-8",
      503,
    );
  }
}
