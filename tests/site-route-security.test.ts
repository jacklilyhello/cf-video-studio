import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));
import worker from "../src/index";
import { login } from "../src/auth";
import type { Env } from "../src/types";

interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
    run(...values: unknown[]): unknown;
  };
  close(): void;
}
const { DatabaseSync } = (await import("node:sqlite" as string)) as {
  DatabaseSync: new (path: string) => Database;
};
const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: URL, encoding: string): string;
};
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllGlobals();
});
const origin = "https://site-route.example";

async function setup() {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  native.exec(
    readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  const db = {
    prepare(sql: string) {
      const prepared = native.prepare(sql);
      let values: unknown[] = [];
      const statement = {
        bind(...input: unknown[]) {
          values = input;
          return statement;
        },
        async first() {
          return prepared.get(...values) ?? null;
        },
        async all() {
          return { success: true, results: prepared.all(...values) };
        },
        async run() {
          return prepared.run(...values);
        },
      };
      return statement;
    },
  };
  const media = vi.fn(() => {
    throw new Error("Unexpected R2 access");
  });
  const processor = vi.fn(() => {
    throw new Error("Unexpected Container access");
  });
  const requests: Request[] = [];
  const coordinate = vi.fn(
    async (input: Request | string, init?: RequestInit) => {
      const request =
        typeof input === "string" ? new Request(input, init) : input;
      requests.push(request);
      await request.arrayBuffer();
      return Response.json({ allowed: true });
    },
  );
  const assets = vi.fn(
    async (_request: Request) =>
      new Response(
        "<!doctype html><html><head><title>Build default</title></head><body>Page</body></html>",
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public,max-age=3600",
            ETag: '"build-asset"',
          },
        },
      ),
  );
  const env = {
    DB: db,
    APP_ENV: "test",
    ADMIN_PASSWORD: "offline-site-route-fixture-password",
    SESSION_SECRET:
      "offline-site-route-fixture-secret-longer-than-32-characters",
    MEDIA: { head: media, get: media, put: media, delete: media },
    PROCESSOR: { get: processor },
    ASSETS: { fetch: assets },
    COORDINATOR: {
      idFromName: () => "admission",
      get: () => ({ fetch: coordinate }),
    },
  } as unknown as Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
  const authenticated = await login(
    new Request(origin + "/api/admin/login", {
      method: "POST",
      headers: { Origin: origin },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    }),
    env,
  );
  const cookie = authenticated.headers.get("Set-Cookie")!.split(";")[0];
  coordinate.mockClear();
  requests.length = 0;
  const fetch = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(origin + path, init), env, ctx);
  const setIndexing = (enabled: boolean) =>
    native
      .prepare(
        "INSERT INTO settings VALUES('site_branding_json',?,1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(
        JSON.stringify({
          name: "Moon & Water",
          searchIndexing: enabled,
          logo: null,
          updatedAt: 1,
        }),
      );
  // The real HTMLRewriter transform is independently exercised in Miniflare by
  // search-indexing.test.ts; this shim isolates Worker routing/header policy.
  vi.stubGlobal(
    "HTMLRewriter",
    class {
      on() {
        return this;
      }
      transform(response: Response) {
        return response;
      }
    },
  );
  return {
    native,
    env,
    ctx,
    fetch,
    setIndexing,
    cookie,
    coordinate,
    requests,
    assets,
    media,
    processor,
  };
}

describe("site settings preserve privileged boundaries", () => {
  const endpoints = [
    ["GET", "/api/admin/watch"],
    ["PATCH", "/api/admin/watch"],
    ["POST", "/api/admin/watch/revoke"],
    ["GET", "/api/admin/usage/manual"],
    ["POST", "/api/admin/usage/manual"],
    ["GET", "/api/admin/site"],
    ["PATCH", "/api/admin/site"],
    ["POST", "/api/admin/site/logo"],
    ["DELETE", "/api/admin/site/logo"],
  ] as const;
  it.each(endpoints)(
    "rejects anonymous %s %s before coordination or storage",
    async (method, path) => {
      const fixture = await setup();
      const response = await fixture.fetch(path, {
        method,
        headers: { Origin: origin },
        ...(["POST", "PATCH"].includes(method) ? { body: "{}" } : {}),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(fixture.coordinate).not.toHaveBeenCalled();
      expect(fixture.media).not.toHaveBeenCalled();
      expect(fixture.processor).not.toHaveBeenCalled();
    },
  );
  it.each(endpoints.filter(([method]) => method !== "GET"))(
    "rejects foreign-origin authenticated %s %s",
    async (method, path) => {
      const fixture = await setup();
      const response = await fixture.fetch(path, {
        method,
        headers: { Origin: "https://foreign.example", Cookie: fixture.cookie },
        ...(["POST", "PATCH"].includes(method) ? { body: "{}" } : {}),
      });
      expect(response.status).toBe(403);
      expect(fixture.coordinate).not.toHaveBeenCalled();
      expect(fixture.media).not.toHaveBeenCalled();
    },
  );
  it("forwards permitted setting changes to the shared admission object without starting processing", async () => {
    const fixture = await setup();
    const response = await fixture.fetch("/api/admin/site", {
      method: "PATCH",
      headers: {
        Origin: origin,
        Cookie: fixture.cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "A small cinema", searchIndexing: false }),
    });
    expect(response.status).toBe(200);
    expect(
      fixture.requests.map((request) => new URL(request.url).pathname),
    ).toEqual(["/rate", "/site"]);
    expect(fixture.requests[1].method).toBe("PATCH");
    expect(fixture.media).not.toHaveBeenCalled();
    expect(fixture.processor).not.toHaveBeenCalled();
  });
  it("publishes only the fixed safe branding fields with a closed missing-setting default", async () => {
    const fixture = await setup();
    const response = await fixture.fetch("/api/site");
    expect(await response.json()).toEqual({
      name: "Video Hub",
      logoUrl: null,
      searchIndexing: false,
      updatedAt: 0,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fixture.media).not.toHaveBeenCalled();
  });
  it("keeps private authentication, manual evidence and credential cache rows out of generic settings", async () => {
    const fixture = await setup();
    for (const key of [
      "watch_access_json",
      "manual_usage_checks_json",
      "r2_inventory_restricted_cache_v1",
      "site_branding_json",
    ])
      fixture.native
        .prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,1)")
        .run(
          key,
          JSON.stringify({
            digest: "private-digest",
            credentialHash: "private-fingerprint",
          }),
        );
    const response = await fixture.fetch("/api/admin/settings", {
      headers: { Cookie: fixture.cookie },
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { settings: { key: string }[] };
    expect(result.settings.map((row) => row.key).sort()).toEqual(
      [
        "processing_concurrency",
        "task_timeout_seconds",
        "history_retention_days",
        "log_retention_days",
        "progress_interval_seconds",
        "storage_limit_bytes",
        "monthly_spend_limit_usd",
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toContain("private-digest");
    expect(JSON.stringify(result)).not.toContain("private-fingerprint");
    expect(fixture.media).not.toHaveBeenCalled();
    expect(fixture.processor).not.toHaveBeenCalled();
  });
  it("does not expose an arbitrary logo key or prefix listing", async () => {
    const fixture = await setup();
    for (const path of [
      "/site-logo/list",
      "/site-logo/unknown.png",
      "/site-logo/" + "a".repeat(64) + ".png",
    ]) {
      const response = await fixture.fetch(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
    expect(fixture.media).not.toHaveBeenCalled();
  });
});

describe("server application pages and crawler policy", () => {
  it("applies changes to public page headers immediately while private and unknown pages remain noindex", async () => {
    const fixture = await setup();
    for (const path of ["/", "/video", "/admin"]) {
      const response = await fixture.fetch(path);
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    fixture.setIndexing(true);
    for (const path of ["/", "/video"])
      expect((await fixture.fetch(path)).headers.get("X-Robots-Tag")).toBe(
        "index, follow",
      );
    for (const path of [
      "/admin",
      "/unknown",
      "/api/history",
      "/api/admin/site",
      "/api/config",
    ])
      expect((await fixture.fetch(path)).headers.get("X-Robots-Tag")).toBe(
        "noindex, nofollow",
      );
    expect(
      (await fixture.fetch("/video?video=unpublished")).headers.get(
        "X-Robots-Tag",
      ),
    ).toBe("noindex, nofollow");
    fixture.setIndexing(false);
    expect((await fixture.fetch("/video")).headers.get("X-Robots-Tag")).toBe(
      "noindex, nofollow",
    );
    expect(fixture.processor).not.toHaveBeenCalled();
  });
  it("removes conditional app-HTML requests so a cached asset cannot retain prior indexing policy", async () => {
    const fixture = await setup();
    const response = await fixture.fetch("/", {
      headers: {
        "If-None-Match": '"old-indexable-page"',
        "If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT",
      },
    });
    const sent = fixture.assets.mock.calls[0][0];
    expect(sent.headers.has("If-None-Match")).toBe(false);
    expect(sent.headers.has("If-Modified-Since")).toBe(false);
    expect(response.headers.has("ETag")).toBe(false);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "img-src 'self' data:",
    );
    expect(response.headers.get("Content-Security-Policy")).not.toContain(
      "unsafe-inline",
    );
  });
  it("preserves old selected-video links with a relative redirect and no media/history read", async () => {
    const fixture = await setup();
    const response = await fixture.fetch("/?video=sintel-fixture");
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(
      "/video?video=sintel-fixture",
    );
    expect(fixture.assets).not.toHaveBeenCalled();
    expect(fixture.coordinate).not.toHaveBeenCalled();
    expect(fixture.media).not.toHaveBeenCalled();
    expect(fixture.processor).not.toHaveBeenCalled();
  });
});
