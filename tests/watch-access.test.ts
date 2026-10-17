import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));
import worker from "../src/index";
import { login, visitorIdentity } from "../src/auth";
import {
  changeWatchSettings,
  getWatchSettings,
  readWatchSettings,
  requireViewing,
  watchLogin,
  watchLogout,
  watchSession,
  WATCH_SESSION_MS,
} from "../src/watch-access";
import type { Env } from "../src/types";
const { DatabaseSync } = await import("node:sqlite" as string);
const { readFileSync } = await import("node:fs" as string);
const databases: { close(): void }[] = [];
afterEach(() => {
  databases.splice(0).forEach((x) => x.close());
  vi.unstubAllGlobals();
});
const origin = "https://watch-test.example";
const password = "offline-viewing-fixture";
function setup() {
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
      const s = native.prepare(sql);
      let args: unknown[] = [];
      const q = {
        bind(...a: unknown[]) {
          args = a;
          return q;
        },
        async first() {
          return s.get(...args) ?? null;
        },
        async all() {
          return { success: true, results: s.all(...args) };
        },
        async run() {
          return s.run(...args);
        },
      };
      return q;
    },
    async batch(q: { run(): Promise<unknown> }[]) {
      return Promise.all(q.map((s) => s.run()));
    },
  };
  const processor = vi.fn(() => {
    throw Error("Container access forbidden");
  });
  const media = vi.fn(() => {
    throw Error("R2 access before authorization forbidden");
  });
  const rate = vi.fn(async () => Response.json({ allowed: true }));
  const env = {
    DB: db,
    APP_ENV: "test",
    ADMIN_PASSWORD: "offline-admin-fixture-password",
    SESSION_SECRET: "offline-watch-fixture-secret-longer-than-32",
    COORDINATOR: {
      idFromName: () => "admission",
      get: () => ({ fetch: rate }),
    },
    PROCESSOR: { get: processor },
    MEDIA: { head: media, get: media, put: media },
    ASSETS: {
      fetch: async () =>
        new Response(
          "<html><head><title>Site</title></head><body>Welcome</body></html>",
          { headers: { "Content-Type": "text/html" } },
        ),
    },
  } as unknown as Env;
  vi.stubGlobal(
    "HTMLRewriter",
    class {
      on() {
        return this;
      }
      transform(r: Response) {
        return r;
      }
    },
  );
  const req = (path: string, init: RequestInit = {}) =>
    new Request(origin + path, init);
  const mutate = (data: unknown, revoke = false) =>
    changeWatchSettings(
      req("/internal", {
        method: revoke ? "POST" : "PATCH",
        body: JSON.stringify(data),
      }),
      env,
      revoke,
    );
  const enable = () => mutate({ expectedRevision: 0, enabled: true, password });
  const authenticate = (p = password, host = origin) =>
    watchLogin(
      new Request(host + "/api/watch/login", {
        method: "POST",
        headers: { Origin: host },
        body: JSON.stringify({ password: p }),
      }),
      env,
    );
  const fetch = (path: string, init: RequestInit = {}) =>
    worker.fetch(req(path, init), env, {
      waitUntil: vi.fn(),
    } as unknown as ExecutionContext);
  return {
    native,
    env,
    req,
    mutate,
    enable,
    authenticate,
    fetch,
    processor,
    media,
    rate,
  };
}
function cookie(r: Response) {
  return r.headers.get("Set-Cookie")!.split(";")[0];
}

describe("independent viewing authorization", () => {
  it("defaults off on upgrade, and cannot enable without a configured passphrase", async () => {
    const f = setup();
    expect(await (await getWatchSettings(f.env)).json()).toEqual({
      enabled: false,
      configured: false,
      revision: 0,
      updatedAt: 0,
    });
    await expect(
      f.mutate({ expectedRevision: 0, enabled: true }),
    ).rejects.toMatchObject({ code: "watch_password_required" });
    expect((await f.fetch("/api/videos")).status).toBe(200);
    expect(f.processor).not.toHaveBeenCalled();
  });
  it("stores a salted digest and signs a host-only 30-day HttpOnly viewing cookie distinct from admin/history", async () => {
    const f = setup();
    await f.enable();
    const response = await f.authenticate();
    const header = response.headers.get("Set-Cookie")!;
    expect(header).toContain("__Host-vh_watch=");
    for (const part of [
      "Secure",
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${WATCH_SESSION_MS / 1000}`,
    ])
      expect(header).toContain(part);
    expect(header).not.toContain("Domain=");
    expect(header).not.toContain(password);
    expect(
      JSON.stringify(await (await getWatchSettings(f.env)).json()),
    ).not.toMatch(/digest|salt|offline/);
    const stored = await readWatchSettings(f.env);
    expect(stored.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(password);
    const request = f.req("/api/watch/session", {
      headers: { Cookie: cookie(response) },
    });
    expect(await (await watchSession(request, f.env)).json()).toMatchObject({
      authorized: true,
      enabled: true,
    });
    expect(
      (
        await f.fetch("/api/admin/session", {
          headers: { Cookie: cookie(response) },
        })
      ).status,
    ).toBe(200);
    expect(
      await (
        await f.fetch("/api/admin/session", {
          headers: { Cookie: cookie(response) },
        })
      ).json(),
    ).toMatchObject({ authenticated: false });
  });
  it("rejects incorrect passphrase, forged/expired/wrong-host cookies and preserves admin preview access", async () => {
    const f = setup();
    await f.enable();
    await expect(f.authenticate("wrong-passphrase")).rejects.toMatchObject({
      status: 401,
    });
    const c = cookie(await f.authenticate());
    await expect(
      requireViewing(
        f.req("/api/videos", { headers: { Cookie: c + "forged" } }),
        f.env,
      ),
    ).rejects.toMatchObject({ code: "watch_required" });
    await expect(
      requireViewing(
        new Request("https://second-watch.example/api/videos", {
          headers: { Cookie: c },
        }),
        f.env,
      ),
    ).rejects.toMatchObject({ code: "watch_required" });
    const parts = c.split("=")[1].split(".");
    parts[0] = "1";
    await expect(
      requireViewing(
        f.req("/api/videos", {
          headers: { Cookie: "__Host-vh_watch=" + parts.join(".") },
        }),
        f.env,
      ),
    ).rejects.toMatchObject({ code: "watch_required" });
    const admin = await login(
      f.req("/api/admin/login", {
        method: "POST",
        headers: { Origin: origin },
        body: JSON.stringify({ password: f.env.ADMIN_PASSWORD }),
      }),
      f.env,
    );
    expect(
      await (
        await watchSession(
          f.req("/api/watch/session", { headers: { Cookie: cookie(admin) } }),
          f.env,
        )
      ).json(),
    ).toMatchObject({ authorized: true, expiresAt: null });
  });
  it("revokes all hosts by generation, changes passphrase, and never revives pre-disable cookies", async () => {
    const f = setup();
    await f.enable();
    const first = cookie(await f.authenticate());
    const secondOrigin = "https://second-watch.example";
    const second = cookie(await f.authenticate(password, secondOrigin));
    await expect(f.mutate({ expectedRevision: 1 }, true)).rejects.toMatchObject(
      { code: "confirmation_required" },
    );
    await f.mutate({ expectedRevision: 1, confirmed: true }, true);
    for (const [host, c] of [
      [origin, first],
      [secondOrigin, second],
    ])
      await expect(
        requireViewing(
          new Request(host + "/api/videos", { headers: { Cookie: c } }),
          f.env,
        ),
      ).rejects.toMatchObject({ code: "watch_required" });
    await expect(
      f.mutate({ expectedRevision: 1, enabled: false }),
    ).rejects.toMatchObject({ code: "watch_settings_changed" });
    const beforeChange = cookie(await f.authenticate());
    await f.mutate({
      expectedRevision: 2,
      password: "offline-changed-fixture",
    });
    await expect(f.authenticate()).rejects.toMatchObject({
      code: "invalid_watch_password",
    });
    await expect(
      requireViewing(
        f.req("/api/videos", { headers: { Cookie: beforeChange } }),
        f.env,
      ),
    ).rejects.toMatchObject({ code: "watch_required" });
    const beforeDisable = cookie(
      await f.authenticate("offline-changed-fixture"),
    );
    await f.mutate({ expectedRevision: 3, enabled: false });
    await requireViewing(f.req("/api/videos"), f.env);
    await f.mutate({ expectedRevision: 4, enabled: true });
    await expect(
      requireViewing(
        f.req("/api/videos", { headers: { Cookie: beforeDisable } }),
        f.env,
      ),
    ).rejects.toMatchObject({ code: "watch_required" });
    expect(f.processor).not.toHaveBeenCalled();
    expect(f.media).not.toHaveBeenCalled();
  });
  it("logout clears only viewing authorization, and requires same origin", async () => {
    const f = setup();
    await f.enable();
    const history = await visitorIdentity(
      f.req("/api/history/identity", {
        method: "POST",
        headers: { Origin: origin },
      }),
      f.env,
    );
    const response = await watchLogout(
      f.req("/api/watch/logout", {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: cookie(history) + "; " + cookie(await f.authenticate()),
        },
      }),
      f.env,
    );
    expect(response.headers.get("Set-Cookie")).toMatch(
      /^__Host-vh_watch=; .*Max-Age=0/,
    );
    expect(response.headers.get("Set-Cookie")).not.toMatch(/visitor|admin/);
    await expect(
      watchLogout(
        f.req("/api/watch/logout", {
          method: "POST",
          headers: { Origin: "https://foreign.example" },
        }),
        f.env,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it.each([
    "not-json",
    JSON.stringify({
      enabled: true,
      revision: 1,
      updatedAt: 1,
      salt: null,
      digest: null,
    }),
  ])("fails closed for corrupt enabled/configuration %s", async (value) => {
    const f = setup();
    f.native
      .prepare("INSERT INTO settings VALUES('watch_access_json',?,1)")
      .run(value);
    expect((await f.fetch("/api/videos")).status).toBe(503);
    expect((await f.fetch("/media/private/version/source.mp4")).status).toBe(
      503,
    );
    expect(
      (
        await f.fetch("/api/watch/logout", {
          method: "POST",
          headers: { Origin: origin },
        })
      ).headers.get("Set-Cookie"),
    ).toContain("Max-Age=0");
    expect(f.media).not.toHaveBeenCalled();
  });
  it.each([
    "/api/videos",
    "/api/videos/unknown",
    "/api/history",
    "/media/video/version/source.mp4",
    "/media/video/version/index.m3u8",
    "/media/video/version/seg-0001.ts",
    "/media/bad",
  ])("gates %s before object/cache/publication lookup", async (path) => {
    const f = setup();
    await f.enable();
    const response = await f.fetch(path, {
      headers: { Range: "bytes=0-1", "If-None-Match": "cached" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "watch_required" },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(f.media).not.toHaveBeenCalled();
    expect(f.processor).not.toHaveBeenCalled();
  });
  it("keeps published-state checks after authentication and leaves homepage/admin endpoints independent", async () => {
    const f = setup();
    await f.enable();
    const headers = { Cookie: cookie(await f.authenticate()) };
    expect((await f.fetch("/api/videos/missing", { headers })).status).toBe(
      404,
    );
    expect(
      (await f.fetch("/media/missing/version/source.mp4", { headers })).status,
    ).toBe(404);
    expect((await f.fetch("/")).status).toBe(200);
    expect((await f.fetch("/api/admin/session")).status).toBe(200);
    expect((await f.fetch("/api/admin/watch")).status).toBe(401);
    expect(
      (await f.fetch("/video?video=hidden")).headers.get("X-Robots-Tag"),
    ).toBe("noindex, nofollow");
  });
  it("requires same-origin login, bounds input and keeps rate keys separate from administrator login", async () => {
    const f = setup();
    await f.enable();
    await expect(
      watchLogin(
        f.req("/api/watch/login", {
          method: "POST",
          headers: { Origin: "https://evil.example" },
          body: JSON.stringify({ password }),
        }),
        f.env,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await f.authenticate();
    expect(f.rate).toHaveBeenCalledTimes(2);
    await expect(
      f.mutate({ expectedRevision: 1, password: "short" }),
    ).rejects.toMatchObject({ code: "invalid_watch_password" });
    await expect(
      f.mutate({ expectedRevision: 1, password: "x".repeat(129) }),
    ).rejects.toMatchObject({ code: "invalid_watch_password" });
  });
});
