import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));
import worker from "../src/index";
import { login } from "../src/auth";
import * as billing from "../src/billing";
import * as resources from "../src/resource-usage";
import type { Env } from "../src/types";

interface NativeStatement {
  all(...values: unknown[]): Record<string, unknown>[];
  get(...values: unknown[]): Record<string, unknown> | undefined;
  run(...values: unknown[]): { changes: number | bigint };
}
interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}
const { DatabaseSync } = (await import("node:sqlite" as string)) as {
  DatabaseSync: new (path: string) => NativeDatabase;
};
const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: URL, encoding: string): string;
};
const databases: NativeDatabase[] = [];
const origin = "https://configuration-test.example";

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
          return statement.execute();
        },
        execute() {
          const result = prepared.run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
    async batch(statements: { execute(): unknown }[]) {
      native.exec("BEGIN IMMEDIATE");
      try {
        const result = statements.map((statement) => statement.execute());
        native.exec("COMMIT");
        return result;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const start = vi.fn();
  const env = {
    DB: db,
    APP_ENV: "test",
    ADMIN_PASSWORD: "test-only-configuration-password",
    SESSION_SECRET: "test-only-configuration-session-secret-over-32-characters",
    CF_USAGE_API_TOKEN: "test-only-configuration-usage-token",
    CLOUDFLARE_ACCOUNT_ID: "test-only-private-account-identifier",
    PROCESSING_ENABLED: "false",
    PROCESSOR: { get: start },
    COORDINATOR: {
      idFromName: () => "admission",
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
  } as unknown as Env;
  const authentication = await login(
    new Request(`${origin}/api/admin/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    }),
    env,
  );
  const cookie = authentication.headers.get("Set-Cookie")!.split(";")[0];
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
  const get = (path = "/api/config") =>
    worker.fetch(
      new Request(`${origin}${path}`, {
        headers: path.startsWith("/api/admin/") ? { Cookie: cookie } : {},
      }),
      env,
      ctx,
    );
  const save = (interval: number, authenticated = true) =>
    worker.fetch(
      new Request(`${origin}/api/admin/settings`, {
        method: "PATCH",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...(authenticated ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify({ progress_interval_seconds: interval }),
      }),
      env,
      ctx,
    );
  return { native, env, get, save, start };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

describe("public configuration uses the administrator's saved interval", () => {
  it("routes both usage URLs to scoped automatic statistics without reading old account/upload snapshots", async () => {
    const { native, get, start } = await setup();
    native
      .prepare(
        "INSERT INTO usage_snapshots(id,fetched_at,complete,data_json) VALUES('legacy',?,0,?)",
      )
      .run(
        Date.now(),
        JSON.stringify({ marker: "obsolete-account-balance", scope: "all" }),
      );
    const data = {
      environment: "test",
      worker: "fixture-worker",
      cards: [],
      fetchedAt: Date.now(),
      cached: false,
      nextRefreshAt: Date.now() + 30000,
      period: {
        start: "2026-10-15",
        end: "2026-10-16",
        label: "bounded fixture",
      },
      policy: { processingEnabled: false, monthlyIncrementalBudgetUsd: 0 },
    };
    const read = vi.spyOn(resources, "resourceUsage").mockResolvedValue(data);
    const old = vi.spyOn(billing, "getUsage");
    for (const path of ["/api/admin/usage", "/api/admin/resource-usage"]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(data);
    }
    expect(read).toHaveBeenCalledTimes(2);
    expect(old).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(
      native.prepare("SELECT COUNT(*) AS n FROM usage_snapshots").get()!.n,
    ).toBe(1);
  });

  it("reflects both valid boundaries after real authenticated settings writes", async () => {
    const { native, get, save, start } = await setup();
    expect(await (await get()).json()).toMatchObject({
      progressIntervalSeconds: 20,
    });
    for (const interval of [15, 30]) {
      expect((await save(interval)).status).toBe(200);
      expect(
        native
          .prepare(
            "SELECT value FROM settings WHERE key='progress_interval_seconds'",
          )
          .get()?.value,
      ).toBe(String(interval));
      expect(await (await get()).json()).toMatchObject({
        progressIntervalSeconds: interval,
      });
      for (const path of ["/api/admin/settings", "/api/admin/overview"])
        expect(await (await get(path)).json()).toMatchObject({
          config: { progressIntervalSeconds: interval },
        });
    }
    expect(start).not.toHaveBeenCalled();
  });

  it("returns only public metadata without secret or unrelated settings values", async () => {
    const { native, env, get } = await setup();
    const privateSetting = "test-only-private-setting-canary";
    native
      .prepare("INSERT INTO settings VALUES('private_operator_value',?,0)")
      .run(privateSetting);
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = await response.text();
    for (const value of [
      env.ADMIN_PASSWORD!,
      env.SESSION_SECRET!,
      env.CF_USAGE_API_TOKEN!,
      env.CLOUDFLARE_ACCOUNT_ID!,
      privateSetting,
    ])
      expect(text).not.toContain(value);
    expect(JSON.parse(text)).toMatchObject({
      configured: true,
      env: "test",
      processingEnabled: false,
      usageConfigured: true,
      progressIntervalSeconds: 20,
    });
  });

  it("uses the safe default for invalid or missing persisted values", async () => {
    const { native, get } = await setup();
    const update = native.prepare(
      "UPDATE settings SET value=? WHERE key='progress_interval_seconds'",
    );
    for (const value of ["14", "31", "20.5", "NaN", "Infinity", "invalid"]) {
      update.run(value);
      expect(await (await get()).json()).toMatchObject({
        progressIntervalSeconds: 20,
      });
    }
    native.exec("DELETE FROM settings WHERE key='progress_interval_seconds'");
    expect(await (await get()).json()).toMatchObject({
      progressIntervalSeconds: 20,
    });
  });

  it("preserves the saved interval when an invalid or anonymous change is rejected", async () => {
    const { get, save } = await setup();
    expect((await save(30)).status).toBe(200);
    for (const interval of [14, 31, 20.5])
      expect((await save(interval)).status).toBe(400);
    expect((await save(15, false)).status).toBe(401);
    expect(await (await get()).json()).toMatchObject({
      progressIntervalSeconds: 30,
    });
  });
});
