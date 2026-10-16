import { afterEach, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));
import worker from "../src/index";
import { login } from "../src/auth";
import type { Env } from "../src/types";
const { DatabaseSync } = await import("node:sqlite" as string);
const { readFileSync, readdirSync } = await import("node:fs" as string);
const databases: { close(): void }[] = [];
afterEach(() => {
  databases.splice(0).forEach((d) => d.close());
  vi.unstubAllGlobals();
});
function fixture() {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(dir)
    .filter((n: string) => n.endsWith(".sql"))
    .sort())
    native.exec(readFileSync(new URL(name, dir), "utf8"));
  const historical = JSON.stringify({
    schemaVersion: 1,
    checks: [{ id: "legacy-check", expiresAt: 1, value: 42 }],
    successful: [],
  });
  native
    .prepare("INSERT INTO settings VALUES('manual_usage_checks_json',?,1)")
    .run(historical);
  const processor = vi.fn();
  const env = {
    APP_ENV: "test",
    ADMIN_PASSWORD: "offline-admin-fixture",
    SESSION_SECRET: "offline-retirement-fixture-signing-secret-longer-than-32",
    DB: {
      prepare(sql: string) {
        const s = native.prepare(sql);
        let args: unknown[] = [];
        const q = {
          bind(...v: unknown[]) {
            args = v;
            return q;
          },
          async first() {
            return s.get(...args) || null;
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
    },
    COORDINATOR: {
      idFromName: () => "admission",
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
    PROCESSOR: { get: processor },
  } as unknown as Env;
  const origin = "https://retirement.example";
  const call = (
    method: string,
    cookie?: string,
    path = "/api/admin/usage/manual",
  ) =>
    worker.fetch(
      new Request(origin + path, {
        method,
        headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
        ...(method === "POST"
          ? { body: JSON.stringify({ value: 0, checkedAt: Date.now() }) }
          : {}),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );
  const authenticate = async () => {
    const r = await login(
      new Request(origin + "/api/admin/login", {
        method: "POST",
        headers: { Origin: origin },
        body: JSON.stringify({ password: "offline-admin-fixture" }),
      }),
      env,
    );
    return r.headers.get("Set-Cookie")!.split(";")[0];
  };
  return { native, historical, processor, call, authenticate };
}
it.each(["GET", "POST"])(
  "keeps retired %s endpoint administrator-only",
  async (method) => {
    const f = fixture(),
      r = await f.call(method);
    expect(r.status).toBe(401);
    expect(f.processor).not.toHaveBeenCalled();
  },
);
it.each(["GET", "POST"])(
  "returns explicit retirement for authenticated %s and retains historical audits without renewing or evaluating TTL",
  async (method) => {
    const f = fixture(),
      cookie = await f.authenticate(),
      fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const r = await f.call(method, cookie);
    expect(r.status).toBe(410);
    expect(await r.json()).toMatchObject({
      error: { code: "manual_usage_retired" },
    });
    expect(
      f.native
        .prepare(
          "SELECT value FROM settings WHERE key='manual_usage_checks_json'",
        )
        .get().value,
    ).toBe(f.historical);
    expect(f.native.prepare("SELECT COUNT(*) AS n FROM jobs").get().n).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.processor).not.toHaveBeenCalled();
  },
);

it("does not reveal scoped resource statistics or links before administrator authentication", async () => {
  const f = fixture(),
    fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const r = await f.call("GET", undefined, "/api/admin/resource-usage");
  expect(r.status).toBe(401);
  expect(await r.json()).toMatchObject({ error: { code: "login_required" } });
  expect(fetcher).not.toHaveBeenCalled();
  expect(f.processor).not.toHaveBeenCalled();
});
