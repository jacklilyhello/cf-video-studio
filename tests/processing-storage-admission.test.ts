import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/billing", async (original) => ({
  ...(await original<typeof import("../src/billing")>()),
  validateQuoteBudget: vi.fn(),
}));
vi.mock("../src/logs", () => ({ log: vi.fn(async () => {}) }));
import { validateQuoteBudget } from "../src/billing";
import { confirmProcessing } from "../src/jobs";
import type { Env, Quote } from "../src/types";
const billing =
  await vi.importActual<typeof import("../src/billing")>("../src/billing");
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
const at = Date.parse("2026-10-14T06:00:00Z");
const sourceKey = "videos/video/source/revision";
const period = "2026-10-13T00:00:00.000Z";
function setup(
  options: { limit?: number; actual?: number; quotedBytes?: number } = {},
) {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  for (const name of [
    "0001_initial.sql",
    "0002_imports.sql",
    "0003_deletion_items.sql",
    "0004_upload_approvals.sql",
    "0005_publication_revision.sql",
  ])
    native.exec(
      readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
    );
  native
    .prepare("UPDATE settings SET value=? WHERE key='storage_limit_bytes'")
    .run(String(options.limit ?? 1000));
  native
    .prepare(
      "INSERT INTO videos(id,title,source_key,source_size,source_etag,source_revision,source_name,status,created_at,updated_at) VALUES('video','Offline fixture',?,100,'source-etag','revision','fixture.mp4','unprocessed',?,?)",
    )
    .run(sourceKey, at, at);
  native
    .prepare(
      "INSERT INTO objects(key,video_id,category,bytes,etag,state,updated_at) VALUES(?,'video','source',100,'source-etag','present',?)",
    )
    .run(sourceKey, at);
  const plan = {
    mode: "probe-remux",
    quality: "source",
    sourceRevision: "revision",
    sourceEtag: "source-etag",
    periodStart: period,
    instance: billing.INSTANCES[0],
    maxOutputBytes: 200,
    maxMediaObjects: 2,
    totalTimeoutSeconds: 60,
    resourceAmounts: {
      ...billing.processingResourceAmounts(billing.INSTANCES[0], {
        mode: "probe-remux",
        maxOutputBytes: 200,
        maxMediaObjects: 2,
        totalTimeoutSeconds: 60,
      }),
      r2CurrentBytes: options.quotedBytes ?? 200,
    },
  };
  native
    .prepare(
      "INSERT INTO quotes(id,video_id,source_revision,source_etag,mode,quality,period_start,expires_at,state,data_json,created_at) VALUES('quote','video','revision','source-etag','probe-remux','source',?,?,'open',?,?)",
    )
    .run(period, at + 60000, JSON.stringify(plan), at);
  let beforeBatch: (() => void) | undefined;
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
          return {
            success: true,
            meta: { changes: Number(prepared.run(...values).changes) },
          };
        },
      };
      return statement;
    },
    async batch(statements: { execute(): unknown }[]) {
      const hook = beforeBatch;
      beforeBatch = undefined;
      hook?.();
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
  const dispatch = vi.fn(async () => Response.json({ accepted: true }));
  const actualBytes = options.actual ?? 100;
  const list = vi.fn(async () => ({
    objects: [
      { key: sourceKey, size: 100 },
      ...(actualBytes > 100
        ? [{ key: "unregistered-project-object", size: actualBytes - 100 }]
        : []),
    ],
    truncated: false,
  }));
  const env = {
    DB: db,
    APP_ENV: "test",
    PROCESSING_ENABLED: "true",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CF_USAGE_API_TOKEN: "offline-usage-fixture-token",
    MEDIA: {
      head: vi.fn(async () => ({
        key: sourceKey,
        size: 100,
        etag: "source-etag",
      })),
      list,
    },
    PROCESSOR: {
      idFromName: () => "offline-task",
      get: () => ({ fetch: dispatch }),
    },
  } as unknown as Env;
  // Only account admission is mocked for the job transaction tests. Project
  // policy and reservations come from the actual getUsage + SQLite module.
  vi.mocked(validateQuoteBudget).mockImplementation(async () => {
    const snapshot = await billing.getUsage(env);
    snapshot.project.actualBytes = actualBytes;
    return snapshot;
  });
  const quote = () =>
    native
      .prepare("SELECT * FROM quotes WHERE id='quote'")
      .get() as unknown as Quote;
  return {
    native,
    env,
    dispatch,
    list,
    plan,
    quote,
    beforeBatch(hook: () => void) {
      beforeBatch = hook;
    },
  };
}
function unchanged(f: ReturnType<typeof setup>) {
  expect(f.quote().state).toBe("open");
  expect(f.native.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(0);
  expect(f.native.prepare("SELECT COUNT(*) AS n FROM versions").get()?.n).toBe(
    0,
  );
  expect(f.dispatch).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(at);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/containers/me"))
        return Response.json({
          success: true,
          result: {
            limits: {
              vcpu_per_deployment: 4,
              memory_mib_per_deployment: 12288,
              disk_mb_per_deployment: 20000,
            },
          },
        });
      if (url.endsWith("/billable-usage/info"))
        return Response.json({
          success: true,
          result: {
            covered: true,
            subscriptions: [
              { billing_cycle_anchor_timestamp: "2024-07-13T00:00:00Z" },
            ],
          },
        });
      if (url.endsWith("/graphql"))
        return Response.json({ data: { viewer: { accounts: [{}] } } });
      return Response.json({ success: true, result: [] });
    }),
  );
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fresh processing project capacity with actual getUsage and SQLite", () => {
  it("rejects older quotes that do not reserve both bounded project censuses before any new provider reads", async () => {
    const f = setup();
    const oldPlan = structuredClone(f.plan);
    const oldAmounts = oldPlan.resourceAmounts as Record<string, number>;
    oldAmounts.r2ClassA -= 200;
    f.native
      .prepare("UPDATE quotes SET data_json=? WHERE id='quote'")
      .run(JSON.stringify(oldPlan));
    await expect(
      billing.validateQuoteBudget(f.env, f.quote()),
    ).rejects.toMatchObject({ code: "quote_changed" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
    expect(JSON.parse(f.quote().data_json).resourceAmounts.r2ClassA).toBe(
      oldAmounts.r2ClassA,
    );
    unchanged(f);
  });
  it("rejects a newly lowered project cap even while unrelated account metrics remain unknown", async () => {
    const f = setup();
    f.native.exec(
      "UPDATE settings SET value='250' WHERE key='storage_limit_bytes'",
    );
    await expect(
      billing.validateQuoteBudget(f.env, f.quote()),
    ).rejects.toMatchObject({ code: "storage_limit", status: 409 });
    const snapshot = await billing.getUsage(f.env);
    expect(snapshot.project).toMatchObject({
      storedBytes: 100,
      reservedBytes: 0,
      ledgerValid: true,
    });
    expect(snapshot.policy.storageLimitBytes).toBe(250);
    expect(snapshot.processingAllowed).toBe(false);
    unchanged(f);
  });
  it("counts the full legacy quoted reservation rather than only maxOutputBytes", async () => {
    const f = setup({ limit: 550, quotedBytes: 500 });
    await expect(
      billing.validateQuoteBudget(f.env, f.quote()),
    ).rejects.toMatchObject({ code: "storage_limit" });
    expect(JSON.parse(f.quote().data_json).resourceAmounts.r2CurrentBytes).toBe(
      500,
    );
    unchanged(f);
  });
  it("counts unregistered objects in the configured project bucket", async () => {
    const f = setup({ actual: 900 });
    await expect(
      billing.validateQuoteBudget(f.env, f.quote()),
    ).rejects.toMatchObject({ code: "storage_limit" });
    expect(f.list).toHaveBeenCalled();
    unchanged(f);
  });
  it("keeps incomplete R2 census unknown and never substitutes an empty inventory", async () => {
    const f = setup();
    f.list.mockRejectedValueOnce(new Error("offline storage failure"));
    await expect(
      billing.validateQuoteBudget(f.env, f.quote()),
    ).rejects.toMatchObject({ code: "budget_unknown" });
    expect(f.list).toHaveBeenCalledOnce();
    unchanged(f);
  });
  it("retains the account evidence gate when project space is sufficient", async () => {
    const f = setup();
    await expect(
      billing.validateQuoteBudget(f.env, f.quote()),
    ).rejects.toMatchObject({ code: "budget_unknown" });
    expect(f.list).toHaveBeenCalledOnce();
    unchanged(f);
  });
});

describe("atomic processing storage admission using actual SQLite", () => {
  it.each(["stored", "upload", "reservation", "lower-cap"])(
    "does not consume the quote or dispatch when %s changes after the fresh read",
    async (change) => {
      const f = setup();
      f.beforeBatch(() => {
        if (change === "stored")
          f.native
            .prepare(
              "INSERT INTO objects(key,category,bytes,state,updated_at) VALUES('racing-object','hls',800,'present',?)",
            )
            .run(at);
        if (change === "upload")
          f.native
            .prepare(
              "INSERT INTO uploads(id,video_id,object_key,fingerprint,expected_size,state,reserved_bytes,expires_at,created_at,updated_at) VALUES('racing-upload','video','videos/video/source/other','fingerprint',800,'unknown',800,?,?,?)",
            )
            .run(at + 60000, at, at);
        if (change === "reservation")
          f.native
            .prepare(
              "INSERT INTO reservations(id,owner_id,kind,period_start,amounts_json,state,created_at) VALUES('racing-reservation','other-task','processing',?,'{\"r2CurrentBytes\":800}','active',?)",
            )
            .run(period, at);
        if (change === "lower-cap")
          f.native.exec(
            "UPDATE settings SET value='250' WHERE key='storage_limit_bytes'",
          );
      });
      await expect(confirmProcessing(f.env, "quote")).rejects.toMatchObject({
        code: "storage_limit",
        status: 409,
      });
      unchanged(f);
      expect(
        f.native
          .prepare(
            "SELECT COUNT(*) AS n FROM reservations WHERE owner_id IN (SELECT id FROM jobs)",
          )
          .get()?.n,
      ).toBe(0);
    },
  );
  it("allows a raised setting only within the originally checked snapshot capacity", async () => {
    const allowed = setup();
    allowed.beforeBatch(() =>
      allowed.native.exec(
        "UPDATE settings SET value='2000' WHERE key='storage_limit_bytes'",
      ),
    );
    expect((await confirmProcessing(allowed.env, "quote")).status).toBe(202);
    expect(allowed.dispatch).toHaveBeenCalledOnce();
    const f = setup({ limit: 350 });
    f.beforeBatch(() => {
      f.native.exec(
        "UPDATE settings SET value='2000' WHERE key='storage_limit_bytes'",
      );
      f.native
        .prepare(
          "INSERT INTO objects(key,category,bytes,state,updated_at) VALUES('new-object','hls',100,'present',?)",
        )
        .run(at);
    });
    await expect(confirmProcessing(f.env, "quote")).rejects.toMatchObject({
      code: "storage_limit",
    });
    unchanged(f);
  });
  it("honors the actual census floor in the transaction even when DB objects are smaller", async () => {
    const f = setup({ actual: 900 });
    await expect(confirmProcessing(f.env, "quote")).rejects.toMatchObject({
      code: "storage_limit",
    });
    unchanged(f);
  });
  it("atomically rejects a legacy over-reservation without silently reducing it", async () => {
    const f = setup({ limit: 550, quotedBytes: 500 });
    await expect(confirmProcessing(f.env, "quote")).rejects.toMatchObject({
      code: "storage_limit",
    });
    unchanged(f);
    expect(JSON.parse(f.quote().data_json).resourceAmounts.r2CurrentBytes).toBe(
      500,
    );
  });
  it.each([200, 500])(
    "admits the exact boundary with %i quoted bytes and keeps replay idempotent",
    async (quotedBytes) => {
      const f = setup({ limit: 100 + quotedBytes, quotedBytes });
      expect((await confirmProcessing(f.env, "quote")).status).toBe(202);
      expect((await confirmProcessing(f.env, "quote")).status).toBe(200);
      expect(f.native.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(
        1,
      );
      const reservation = f.native
        .prepare(
          "SELECT amounts_json FROM reservations WHERE kind='processing'",
        )
        .get()!;
      expect(JSON.parse(String(reservation.amounts_json)).r2CurrentBytes).toBe(
        quotedBytes,
      );
      expect(validateQuoteBudget).toHaveBeenCalledOnce();
      expect(f.dispatch).toHaveBeenCalledOnce();
    },
  );
});
