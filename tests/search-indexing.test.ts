import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySearchIndexingHeaders,
  NO_SEARCH_INDEXING,
  rewriteSiteHtml,
  SEARCH_INDEXING,
  searchIndexingDirective,
  serveRobots,
  serveSitemap,
  siteHeadMarkup,
} from "../src/search-indexing";
import type { Env } from "../src/types";

const origin = "https://indexing-test.example";
const request = (path: string, method = "GET") =>
  new Request(origin + path, { method });

const { DatabaseSync } = (await import("node:sqlite" as string)) as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...values: unknown[]): Record<string, unknown>[];
      run(...values: unknown[]): unknown;
    };
    close(): void;
  };
};
const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: URL, encoding: string): string;
};
const databases: InstanceType<typeof DatabaseSync>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});
function setup() {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  native.exec(
    readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  const video = (
    id: string,
    published: number,
    versionId: string | null,
    state = "ready",
  ) =>
    native
      .prepare(
        "INSERT INTO videos(id,title,source_revision,source_name,status,published,current_version_id,created_at,updated_at) VALUES(?,'Private business title','revision','private.mp4',?,?,?,1,1)",
      )
      .run(id, state, published, versionId);
  const version = (id: string, videoId: string, state = "verified") =>
    native
      .prepare(
        "INSERT INTO versions(id,video_id,prefix,state,mode,quality,manifest,timeline_id,validation_json,created_at) VALUES(?,?,?,?,'probe-remux','source','index.m3u8','timeline','{}',1)",
      )
      .run(id, videoId, `videos/${videoId}/versions/${id}/`, state);
  video("public-video", 1, "public-version");
  version("public-version", "public-video");
  video("unpublished-video", 0, "private-version");
  version("private-version", "unpublished-video");
  video("processing-video", 1, "processing-version");
  version("processing-version", "processing-video", "processing");
  video("unselected-video", 1, null);
  version("unselected-version", "unselected-video");
  video("foreign-reference", 1, "public-version");
  video("deleted-video", 1, "deleted-version", "deleted");
  version("deleted-version", "deleted-video");
  const prepare = vi.fn((sql: string) => {
    const statement = native.prepare(sql);
    let values: unknown[] = [];
    const bound = {
      bind(...input: unknown[]) {
        values = input;
        return bound;
      },
      async all() {
        return { success: true, results: statement.all(...values) };
      },
    };
    return bound;
  });
  return {
    native,
    prepare,
    env: { DB: { prepare } } as unknown as Pick<Env, "DB">,
  };
}

describe("closed-by-default search indexing policy", () => {
  it.each([
    "/",
    "/video?video=public",
    "/media/public/version/source.mp4",
    "/api/videos",
  ])(
    "defaults %s to noindex without a setting read or publication guess",
    (path) => {
      expect(searchIndexingDirective(origin + path)).toBe(NO_SEARCH_INDEXING);
      expect(
        searchIndexingDirective(origin + path, {
          searchIndexing: "true" as unknown as boolean,
          publishedVerified: true,
        }),
      ).toBe(NO_SEARCH_INDEXING);
    },
  );
  it.each([
    "/admin",
    "/admin/preview",
    "/api/history",
    "/api/admin/preview/id/v/source.mp4",
    "/api/videos",
    "/api/videos/public",
    "/site-logo",
    "/assets/app.js",
    "/unknown",
    "/robots.txt",
    "/sitemap.xml",
  ])(
    "keeps %s noindex even when indexing and a publication flag are supplied",
    (path) => {
      expect(
        searchIndexingDirective(origin + path, {
          searchIndexing: true,
          publishedVerified: true,
        }),
      ).toBe(NO_SEARCH_INDEXING);
    },
  );
  it("allows the public homepage but needs verified current publication for a selected video", () => {
    for (const path of ["/", "/video"])
      expect(
        searchIndexingDirective(origin + path, { searchIndexing: true }),
      ).toBe(SEARCH_INDEXING);
    for (const path of ["/video?video=public", "/?video=public"]) {
      expect(
        searchIndexingDirective(origin + path, { searchIndexing: true }),
      ).toBe(NO_SEARCH_INDEXING);
      expect(
        searchIndexingDirective(origin + path, {
          searchIndexing: true,
          publishedVerified: true,
        }),
      ).toBe(SEARCH_INDEXING);
    }
    for (const path of [
      "/video?video=",
      "/video?video=../private",
      "/video?video=a&video=b",
      "/?video=a&video=a",
    ])
      expect(
        searchIndexingDirective(origin + path, {
          searchIndexing: true,
          publishedVerified: true,
        }),
      ).toBe(NO_SEARCH_INDEXING);
  });
  it.each([400, 401, 403, 404, 409, 416, 429, 500, 503])(
    "never indexes status %i",
    (status) => {
      expect(
        searchIndexingDirective(origin + "/", {
          searchIndexing: true,
          publishedVerified: true,
          status,
        }),
      ).toBe(NO_SEARCH_INDEXING);
      expect(
        searchIndexingDirective(origin + "/media/video/version/source.mp4", {
          searchIndexing: true,
          publishedVerified: true,
          status,
        }),
      ).toBe(NO_SEARCH_INDEXING);
    },
  );
  it.each(["GET", "HEAD"])(
    "protects media %s/206 without changing Range metadata or the body",
    async (method) => {
      for (const enabled of [false, true]) {
        const response = applySearchIndexingHeaders(
          request("/media/video/version/source.mp4", method),
          new Response(method === "HEAD" ? null : new Uint8Array([1, 2, 3]), {
            status: 206,
            headers: {
              "Content-Range": "bytes 5-7/100",
              "Content-Length": "3",
              ETag: '"fixed-etag"',
              "Cache-Control": "no-store",
            },
          }),
          { searchIndexing: enabled, publishedVerified: true },
        );
        expect(response.status).toBe(206);
        expect(response.headers.get("X-Robots-Tag")).toBe(
          enabled ? SEARCH_INDEXING : NO_SEARCH_INDEXING,
        );
        expect(response.headers.get("Content-Range")).toBe("bytes 5-7/100");
        expect(response.headers.get("Content-Length")).toBe("3");
        expect(response.headers.get("ETag")).toBe('"fixed-etag"');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
          method === "HEAD" ? new Uint8Array() : new Uint8Array([1, 2, 3]),
        );
      }
    },
  );
  it("does not apply public indexing to a private preview, rejected range or POST", () => {
    for (const [path, status, method] of [
      ["/api/admin/source/video/source.mp4", 206, "GET"],
      ["/media/video/version/source.mp4", 416, "HEAD"],
      ["/", 200, "POST"],
    ] as const) {
      const response = applySearchIndexingHeaders(
        request(path, method),
        new Response(null, { status }),
        { searchIndexing: true, publishedVerified: true },
      );
      expect(response.headers.get("X-Robots-Tag")).toBe(NO_SEARCH_INDEXING);
    }
  });
});

describe("robots and current published sitemap", () => {
  it("allows crawling noindex pages without disallowing the whole site or advertising a disabled sitemap", async () => {
    const response = serveRobots(request("/robots.txt"));
    expect(await response.text()).toBe(
      "User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const head = serveRobots(request("/robots.txt", "HEAD"));
    expect(await head.text()).toBe("");
    expect(head.headers.get("Content-Type")).toContain("text/plain");
  });
  it("uses the current request origin for the enabled sitemap without a production canonical", async () => {
    const response = serveRobots(
      new Request("https://second-test.example/robots.txt"),
      { searchIndexing: true },
    );
    expect(await response.text()).toContain(
      "Sitemap: https://second-test.example/sitemap.xml\n",
    );
  });
  it("returns 404 without consulting the database while indexing is disabled", async () => {
    const prepare = vi.fn(() => {
      throw new Error("No disabled sitemap query");
    });
    const response = await serveSitemap(request("/sitemap.xml"), {
      DB: { prepare },
    } as unknown as Pick<Env, "DB">);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found\n");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(prepare).not.toHaveBeenCalled();
  });
  it("selects only the currently published verified version belonging to its video using actual SQLite", async () => {
    const f = setup();
    const response = await serveSitemap(request("/sitemap.xml"), f.env, {
      searchIndexing: true,
    });
    const xml = await response.text();
    expect(response.status).toBe(200);
    expect(xml).toContain(
      "<url><loc>https://indexing-test.example/</loc></url>",
    );
    expect(xml).toContain(
      "<url><loc>https://indexing-test.example/video?video=public-video</loc></url>",
    );
    expect(xml.match(/<url>/g)).toHaveLength(2);
    expect(xml).not.toMatch(
      /unpublished-video|processing-video|unselected-video|foreign-reference|deleted-video|Private business|private.mp4|revision|public-version/,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    f.native.exec("UPDATE videos SET published=0 WHERE id='public-video'");
    expect(
      await (
        await serveSitemap(request("/sitemap.xml"), f.env, {
          searchIndexing: true,
        })
      ).text(),
    ).not.toContain("public-video");
    const head = await serveSitemap(request("/sitemap.xml", "HEAD"), f.env, {
      searchIndexing: true,
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
  it("never retains another host's sitemap URLs", async () => {
    const f = setup();
    const response = await serveSitemap(
      new Request("https://other-host.example/sitemap.xml"),
      f.env,
      { searchIndexing: true },
    );
    const xml = await response.text();
    expect(xml).toContain(
      "https://other-host.example/video?video=public-video",
    );
    expect(xml).not.toContain(origin);
  });
  it.each([
    "failed query",
    "invalid success",
    "invalid id",
    "duplicate id",
    "too many videos",
  ])(
    "fails closed for a %s rather than publishing a partial or unsafe inventory",
    async (failure) => {
      const all = vi.fn(async () => {
        if (failure === "failed query")
          throw new Error("private upstream failure");
        return {
          success: failure !== "invalid success",
          results:
            failure === "too many videos"
              ? Array.from({ length: 50000 }, (_, n) => ({ id: `v-${n}` }))
              : failure === "duplicate id"
                ? [{ id: "same" }, { id: "same" }]
                : [{ id: failure === "invalid id" ? 'private<&"' : "valid" }],
        };
      });
      const env = {
        DB: { prepare: () => ({ bind: () => ({ all }) }) },
      } as unknown as Pick<Env, "DB">;
      const response = await serveSitemap(request("/sitemap.xml"), env, {
        searchIndexing: true,
      });
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("Sitemap unavailable\n");
      expect(response.headers.get("X-Robots-Tag")).toBe(NO_SEARCH_INDEXING);
    },
  );
  it("refuses non-read methods without consulting storage", async () => {
    const prepare = vi.fn();
    const env = { DB: { prepare } } as unknown as Pick<Env, "DB">;
    for (const response of [
      serveRobots(request("/robots.txt", "POST"), { searchIndexing: true }),
      await serveSitemap(request("/sitemap.xml", "POST"), env, {
        searchIndexing: true,
      }),
    ]) {
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
      expect(response.headers.get("X-Robots-Tag")).toBe(NO_SEARCH_INDEXING);
    }
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("server HTML indexing metadata", () => {
  it("escapes site name/title and defaults an unknown directive to noindex", () => {
    const markup = siteHeadMarkup({
      name: '<img src=x onerror="alert(1)">',
      title: "</title><script>unsafe</script>",
      directive: 'index"><script>unsafe</script>' as typeof SEARCH_INDEXING,
    });
    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(markup).toContain(
      "&lt;/title&gt;&lt;script&gt;unsafe&lt;/script&gt;",
    );
    expect(markup).toContain('content="noindex, nofollow"');
    expect(markup).not.toMatch(/<script|<img/);
  });
  it("does not initialize an HTML parser or change an error/non-HTML body", async () => {
    const factory = vi.fn(() => {
      throw new Error("No parser for errors or non-HTML");
    });
    for (const [status, type] of [
      [404, "text/html"],
      [200, "application/json"],
    ] as const) {
      const response = rewriteSiteHtml(
        new Response("original", { status, headers: { "Content-Type": type } }),
        { name: "Site", directive: SEARCH_INDEXING },
        factory,
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("X-Robots-Tag")).toBe(NO_SEARCH_INDEXING);
      expect(await response.text()).toBe("original");
    }
    expect(factory).not.toHaveBeenCalled();
  });
  it("rewrites actual HTMLRewriter output, removing conflicting fallback tags and escaping the current server values", async () => {
    const [{ Miniflare }, { transform }] = await Promise.all([
      import("miniflare" as string),
      import("esbuild" as string),
    ]);
    const code = (
      await transform(
        readFileSync(
          new URL("../src/search-indexing.ts", import.meta.url),
          "utf8",
        ),
        { loader: "ts", format: "esm" },
      )
    ).code;
    const script = `import {rewriteSiteHtml,SEARCH_INDEXING,NO_SEARCH_INDEXING} from './indexing.mjs';\nexport default {async fetch(request){const value=await request.json();return rewriteSiteHtml(new Response(value.body,{headers:{'Content-Type':'text/html','Cache-Control':'public,max-age=31536000','ETag':'old-tag','Last-Modified':'Wed, 14 Oct 2026 00:00:00 GMT','Content-Length':'9999','Content-Security-Policy':"default-src 'self'"}}),{name:value.name,title:value.title,directive:value.enabled===true?SEARCH_INDEXING:NO_SEARCH_INDEXING});}};`;
    const mf = new Miniflare({
      cf: false,
      telemetry: { enabled: false },
      workers: [
        {
          config: {
            name: "indexing-unit-test",
            compatibilityDate: "2026-10-13",
            manifest: {
              mainModule: "worker.mjs",
              modules: {
                "worker.mjs": { type: "esm", contents: script },
                "indexing.mjs": { type: "esm", contents: code },
              },
            },
          },
        },
      ],
    });
    try {
      const html =
        '<!doctype html><html><head><meta charset="UTF-8"><meta NAME="ROBOTS" content="noindex"><meta name="googlebot" content="none"><meta name="bingbot" content="noindex"><meta property="og:site_name" content="Old"><title>Old title</title></head><body><div id="root">Kept</div><script src="/assets/app.js"></script></body></html>';
      for (const enabled of [true, false]) {
        const response = await mf.dispatchFetch(origin + "/", {
          method: "POST",
          body: JSON.stringify({
            body: html,
            enabled,
            name: '月水 & "站点" <script>',
            title: "当前 <img> 标题",
          }),
        });
        const output = await response.text();
        const directive = enabled ? SEARCH_INDEXING : NO_SEARCH_INDEXING;
        expect(response.headers.get("X-Robots-Tag")).toBe(directive);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("Content-Length")).toBeNull();
        expect(response.headers.get("ETag")).toBeNull();
        expect(response.headers.get("Last-Modified")).toBeNull();
        expect(response.headers.get("Content-Security-Policy")).toBe(
          "default-src 'self'",
        );
        expect(output).toContain(`<meta name="robots" content="${directive}">`);
        expect(output.match(/name="robots"/gi)).toHaveLength(1);
        expect(output.match(/<title>/gi)).toHaveLength(1);
        expect(output).toContain("<title>当前 &lt;img&gt; 标题</title>");
        expect(output).toContain(
          'content="月水 &amp; &quot;站点&quot; &lt;script&gt;"',
        );
        expect(output).not.toMatch(/googlebot|bingbot|Old title|content="Old"/);
        expect(output).toContain(
          '<div id="root">Kept</div><script src="/assets/app.js"></script>',
        );
      }
    } finally {
      await mf.dispose();
    }
  }, 20000);
});
