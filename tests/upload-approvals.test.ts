import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: DurableObjectState,
      public env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {},
}));
import { Coordinator } from "../src/coordinator";
import worker from "../src/index";
import { createUpload, MAX_FILE_BYTES, uploadSpace } from "../src/uploads";
import { requireStorageBudget } from "../src/billing";
import { sha256 } from "../src/http";
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
const at = Date.parse("2026-10-14T03:00:00Z");
const fileA = {
  name: "a.mp4",
  title: "A",
  size: 16,
  fingerprint: "a".repeat(64),
};
const fileB = {
  name: "b.webm",
  title: "B",
  size: 24,
  fingerprint: "b".repeat(64),
};
function request(path: string, data: unknown) {
  return new Request("https://fixture.example" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://fixture.example",
    },
    body: JSON.stringify(data),
  });
}
function setup(limit = 10 * 1024 ** 3) {
  vi.spyOn(Date, "now").mockReturnValue(at);
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  for (const filename of [
    "0001_initial.sql",
    "0002_imports.sql",
    "0003_deletion_items.sql",
    "0004_upload_approvals.sql",
    "0007_upload_manual_evidence.sql",
  ])
    native.exec(
      readFileSync(
        new URL(`../migrations/${filename}`, import.meta.url),
        "utf8",
      ),
    );
  native
    .prepare("UPDATE settings SET value=? WHERE key='storage_limit_bytes'")
    .run(String(limit));
  let failSql: string | undefined, loseSql: string | undefined;
  let beforeBatch: { sql: string; run: () => void } | undefined;
  const db = {
    prepare(sql: string) {
      const prepared = native.prepare(sql);
      let values: unknown[] = [];
      const statement = {
        sql,
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
          if (failSql && sql.includes(failSql)) {
            failSql = undefined;
            throw new Error("Injected D1 rollback");
          }
          return {
            success: true,
            meta: { changes: Number(prepared.run(...values).changes) },
          };
        },
      };
      return statement;
    },
    async batch(statements: { sql: string; execute(): unknown }[]) {
      if (
        beforeBatch &&
        statements.some((item) => item.sql.includes(beforeBatch!.sql))
      ) {
        const callback = beforeBatch.run;
        beforeBatch = undefined;
        callback();
      }
      native.exec("BEGIN IMMEDIATE");
      let result: unknown[];
      try {
        result = statements.map((item) => item.execute());
        native.exec("COMMIT");
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
      if (loseSql && statements.some((item) => item.sql.includes(loseSql!))) {
        loseSql = undefined;
        throw new Error("Injected lost commit response");
      }
      return result;
    },
  };
  const objects = new Map<
    string,
    {
      key: string;
      size: number;
      etag: string;
      customMetadata?: Record<string, string>;
    }
  >();
  const list = vi.fn(async () => ({
    objects: [...objects.values()],
    truncated: false,
  }));
  const createMultipartUpload = vi.fn(
    async (_key: string, _options: unknown) => ({
      uploadId: "multipart-" + createMultipartUpload.mock.calls.length,
    }),
  );
  const abort = vi.fn(async () => {});
  const uploadPart = vi.fn(async (_number: number, _bytes: Uint8Array) => ({
    etag: "fixture-part",
  }));
  const processor = vi.fn(() => {
    throw new Error("Processing must remain disabled");
  });
  const evidence = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => evidence.get(key),
    put: async (key: string, value: unknown) => {
      evidence.set(key, structuredClone(value));
    },
    delete: async (key: string) => evidence.delete(key),
    getAlarm: async () => at + 60000,
    setAlarm: async () => {},
  };
  const env = {
    DB: db,
    MEDIA: {
      list,
      createMultipartUpload,
      head: vi.fn(async (key: string) => objects.get(key) ?? null),
      resumeMultipartUpload: () => ({ abort, uploadPart }),
    },
    PROCESSING_ENABLED: "false",
    APP_ENV: "test",
    ADMIN_PASSWORD: "offline-fixture-password",
    SESSION_SECRET: "offline-fixture-session-at-least-32-characters",
    PROCESSOR: { get: processor, idFromName: processor },
  } as unknown as Env;
  const coordinator = new Coordinator(
    { storage } as unknown as DurableObjectState,
    env,
  );
  const coordinate = (path: string, data: unknown) =>
    coordinator.fetch(request(path, data));
  env.COORDINATOR = {
    idFromName: () => "admission",
    get: () => ({
      fetch: (input: Request | string, init?: RequestInit) =>
        coordinator.fetch(
          input instanceof Request ? input : new Request(input, init),
        ),
    }),
  } as unknown as DurableObjectNamespace;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
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
    if (url.endsWith("/billable-usage"))
      return Response.json({
        success: true,
        result: [
          {
            ServiceName: "R2 Storage Class A Operations",
            BillingPeriodStart: "2026-10-13T00:00:00Z",
            ConsumedQuantity: 1000000,
          },
        ],
      });
    if (url.endsWith("/subscriptions"))
      return Response.json({
        success: true,
        result: [
          { state: "Active", rate_plan: { id: "r2_paid" } },
          { state: "Paid", rate_plan: { id: "workers_paid" } },
        ],
      });
    if (url.endsWith("/graphql")) {
      const query = String(init?.body);
      if (
        /containersUsage|durableObjects|workersInvocations|workersBuilds/.test(
          query,
        )
      )
        throw new Error("Unrelated query");
      return Response.json({
        data: {
          viewer: {
            accounts: [
              {
                r2OperationsAdaptiveGroups: [],
                d1AnalyticsAdaptiveGroups: [],
                r2StorageAdaptiveGroups: [],
                d1StorageAdaptiveGroups: [],
              },
            ],
          },
        },
      });
    }
    return Response.json({ success: true, result: {} });
  });
  vi.stubGlobal("fetch", fetch);
  return {
    env,
    native,
    coordinate,
    objects,
    list,
    fetch,
    processor,
    abort,
    uploadPart,
    createMultipartUpload,
    count(table: string) {
      return Number(
        native.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
      );
    },
    failOn(sql: string) {
      failSql = sql;
    },
    loseOn(sql: string) {
      loseSql = sql;
    },
    before(sql: string, run: () => void) {
      beforeBatch = { sql, run };
    },
  };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ordinary upload uses project capacity without account-risk approval", () => {
  it("uploads with no account token, billing period or account usage and never calls account API or processor", async () => {
    const f = setup();
    const response = await f.coordinate("/uploads", fileA);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      reused: false,
      additionalBytes: 16,
      upload: { state: "uploading", reserved_bytes: 16 },
    });
    expect(f.createMultipartUpload).toHaveBeenCalledOnce();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.processor).not.toHaveBeenCalled();
    expect(f.count("upload_approvals")).toBe(0);
    expect(f.count("usage_snapshots")).toBe(0);
  });
  it("does not block when an available account API would report exhausted included quantities", async () => {
    const f = setup();
    f.env.CLOUDFLARE_ACCOUNT_ID = "a".repeat(32);
    f.env.CF_USAGE_API_TOKEN = "offline-token";
    expect((await f.coordinate("/uploads", fileA)).status).toBe(201);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(["expired", "prepared", "confirmed"])(
    "ignores a stale %s permission sent by an old client",
    async (state) => {
      const f = setup(32);
      f.native
        .prepare(
          "INSERT INTO upload_approvals(id,scope_hash,state,total_bytes,additional_bytes,reasons_json,expires_at,created_at) VALUES('old','scope',?,16,16,'[]',?,?)",
        )
        .run(state, at + 60000, at);
      f.native
        .prepare(
          "INSERT INTO upload_approval_files(id,approval_id,name,title,expected_size,fingerprint,reserved_bytes) VALUES('old-file','old','a.mp4','A',16,?,16)",
        )
        .run(fileA.fingerprint);
      f.native
        .prepare(
          `INSERT INTO reservations(id,owner_id,kind,amounts_json,state,created_at) VALUES('old-reservation','old-file','upload_approval','{"r2CurrentBytes":16}','reserved',?)`,
        )
        .run(at);
      expect(
        (
          await f.coordinate("/uploads", {
            ...fileA,
            approvalId: "old",
            includeManualChecks: true,
          })
        ).status,
      ).toBe(201);
      expect(
        f.native
          .prepare("SELECT state FROM upload_approvals WHERE id='old'")
          .get()?.state,
      ).toBe("expired");
      expect(
        f.native
          .prepare("SELECT state FROM reservations WHERE id='old-reservation'")
          .get()?.state,
      ).toBe("released");
      expect(
        f.native
          .prepare(
            "SELECT reserved_bytes FROM upload_approval_files WHERE id='old-file'",
          )
          .get()?.reserved_bytes,
      ).toBe(0);
    },
  );
  it("returns an actionable retirement response for old upload approval routes", async () => {
    const f = setup();
    for (const path of ["/upload-approvals", "/upload-approvals/old/confirm"]) {
      const response = await f.coordinate(path, {});
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        error: { code: "upload_approval_retired" },
      });
    }
    expect(f.createMultipartUpload).not.toHaveBeenCalled();
  });
  it("reselects and resumes the same upload without new space or a second multipart", async () => {
    const f = setup(16);
    const first = (await (await f.coordinate("/uploads", fileA)).json()) as {
      upload: { id: string };
    };
    const replay = await f.coordinate("/uploads", {
      ...fileA,
      approvalId: "missing-old-id",
    });
    expect(await replay.json()).toMatchObject({
      upload: { id: first.upload.id },
      reused: true,
      additionalBytes: 0,
    });
    expect(f.createMultipartUpload).toHaveBeenCalledOnce();
    expect(f.count("reservations")).toBe(1);
  });
  it("keeps an unknown creation and its reservation, then resumes it rather than starting another upload", async () => {
    const f = setup();
    f.createMultipartUpload.mockRejectedValueOnce(new Error("unknown outcome"));
    expect((await f.coordinate("/uploads", fileA)).status).toBe(503);
    expect(await (await f.coordinate("/uploads", fileA)).json()).toMatchObject({
      upload: { state: "unknown", reserved_bytes: 16 },
      reused: true,
    });
    expect(f.createMultipartUpload).toHaveBeenCalledOnce();
  });
  it("retains live multipart reservations when retiring unused permissions", async () => {
    const f = setup(31);
    expect((await f.coordinate("/uploads", fileA)).status).toBe(201);
    expect((await f.coordinate("/uploads", fileB)).status).toBe(409);
    expect(f.createMultipartUpload).toHaveBeenCalledOnce();
    expect(
      f.native.prepare("SELECT SUM(reserved_bytes) AS n FROM uploads").get()?.n,
    ).toBe(16);
  });
  it("counts actual unregistered objects and processing reservations against the project hard limit", async () => {
    const f = setup(100);
    f.objects.set("unregistered", {
      key: "unregistered",
      size: 75,
      etag: "other",
    });
    f.native
      .prepare(
        `INSERT INTO reservations(id,owner_id,kind,amounts_json,state,created_at) VALUES('processing','job','processing','{"r2CurrentBytes":10}','active',?)`,
      )
      .run(at);
    const response = await f.coordinate("/uploads", fileA);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "storage_limit",
        details: {
          usedBytes: 75,
          reservedBytes: 10,
          additionalBytes: 16,
          limitBytes: 100,
        },
      },
    });
    expect(f.createMultipartUpload).not.toHaveBeenCalled();
  });
  it("allows exact project-limit admission and refuses one byte more without starting a multipart", async () => {
    const f = setup(16);
    expect((await f.coordinate("/uploads", fileA)).status).toBe(201);
    expect((await f.coordinate("/uploads", { ...fileB, size: 1 })).status).toBe(
      409,
    );
    expect(f.createMultipartUpload).toHaveBeenCalledOnce();
  });
  it("checks the transactional fence after a competing reservation or limit reduction", async () => {
    const f = setup(100);
    f.before("INSERT INTO videos", () =>
      f.native
        .prepare(
          "UPDATE settings SET value='15' WHERE key='storage_limit_bytes'",
        )
        .run(),
    );
    expect((await f.coordinate("/uploads", fileA)).status).toBe(409);
    expect(f.count("videos")).toBe(0);
    expect(f.count("uploads")).toBe(0);
    expect(f.count("reservations")).toBe(0);
    expect(f.createMultipartUpload).not.toHaveBeenCalled();
  });
  it("serializes competing files through the coordinator and preserves concurrent upload reservations", async () => {
    const f = setup(30);
    const results = await Promise.all([
      f.coordinate("/uploads", fileA),
      f.coordinate("/uploads", fileB),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(f.createMultipartUpload).toHaveBeenCalledOnce();
  });
  it("recovers a lost database commit response without another multipart or duplicate rows", async () => {
    const f = setup();
    f.loseOn("INSERT INTO uploads");
    expect((await f.coordinate("/uploads", fileA)).status).toBe(500);
    expect(await (await f.coordinate("/uploads", fileA)).json()).toMatchObject({
      reused: true,
      upload: { state: "creating" },
    });
    expect(f.count("uploads")).toBe(1);
    expect(f.count("videos")).toBe(1);
    expect(f.createMultipartUpload).not.toHaveBeenCalled();
  });
  it("checks 20 GiB and nonempty size before project storage or external reads", async () => {
    const f = setup();
    for (const size of [0, MAX_FILE_BYTES + 1])
      expect((await f.coordinate("/uploads", { ...fileA, size })).status).toBe(
        400,
      );
    expect(f.list).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(["-1", "invalid", "1.5"])(
    "fails closed for invalid project hard limit %s",
    async (limit) => {
      const f = setup();
      f.native
        .prepare("UPDATE settings SET value=? WHERE key='storage_limit_bytes'")
        .run(limit);
      expect(
        await (await f.coordinate("/uploads", fileA)).json(),
      ).toMatchObject({ error: { code: "project_storage_unknown" } });
      expect(f.createMultipartUpload).not.toHaveBeenCalled();
    },
  );
  it("does not confuse unrelated invalid account-consumption fields with project storage", async () => {
    const f = setup();
    f.native
      .prepare(
        `INSERT INTO reservations(id,owner_id,kind,amounts_json,state,created_at) VALUES('usage','old-upload','upload','{"r2ClassA":-1}','consumed',?)`,
      )
      .run(at);
    expect((await f.coordinate("/uploads", fileA)).status).toBe(201);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("refuses corrupt storage reservations and incomplete R2 census", async () => {
    const f = setup();
    f.native
      .prepare(
        `INSERT INTO reservations(id,owner_id,kind,amounts_json,state,created_at) VALUES('bad','job','processing','{"r2CurrentBytes":-1}','active',?)`,
      )
      .run(at);
    expect((await f.coordinate("/uploads", fileA)).status).toBe(503);
    f.native.prepare("DELETE FROM reservations").run();
    f.list.mockResolvedValueOnce({ objects: [], truncated: true } as never);
    expect((await f.coordinate("/uploads", fileA)).status).toBe(503);
    expect(f.createMultipartUpload).not.toHaveBeenCalled();
  });
  it("shows current project space without querying account balances", async () => {
    const f = setup(100);
    await f.coordinate("/uploads", fileA);
    expect(await (await uploadSpace(f.env)).json()).toMatchObject({
      usedBytes: 0,
      reservedBytes: 16,
      availableBytes: 84,
      limitBytes: 100,
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("can still display space while occupancy already exceeds the project limit", async () => {
    const f = setup(10);
    f.objects.set("existing", { key: "existing", size: 20, etag: "exists" });
    expect(await (await uploadSpace(f.env)).json()).toMatchObject({
      usedBytes: 20,
      availableBytes: 0,
      limitBytes: 10,
    });
    await expect(requireStorageBudget(f.env, 1)).rejects.toMatchObject({
      code: "storage_limit",
    });
  });
  it("validates and reuses accepted parts without billing checks", async () => {
    const f = setup();
    const created = (await (await f.coordinate("/uploads", fileA)).json()) as {
      upload: { id: string };
    };
    const content = new Uint8Array(16);
    const digest = await sha256(content);
    const part = () =>
      new Request(
        `https://fixture.example/uploads/${created.upload.id}/parts/1`,
        { method: "PUT", headers: { "X-Part-SHA256": digest }, body: content },
      );
    expect(
      (
        await new Coordinator(
          { storage: {} } as unknown as DurableObjectState,
          f.env,
        ).fetch(part())
      ).status,
    ).toBe(200);
    expect(
      (
        await new Coordinator(
          { storage: {} } as unknown as DurableObjectState,
          f.env,
        ).fetch(part())
      ).status,
    ).toBe(200);
    expect(f.uploadPart).toHaveBeenCalledOnce();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("migrates obsolete permissions while preserving uploads, objects, history and audit evidence", async () => {
    const f = setup();
    await f.coordinate("/uploads", fileA);
    const before = f.native.prepare("SELECT * FROM uploads").all();
    f.native.exec(
      readFileSync(
        new URL("../migrations/0009_upload_policy.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(f.native.prepare("SELECT * FROM uploads").all()).toEqual(before);
    expect(f.count("reservations")).toBe(1);
    expect(f.count("videos")).toBe(1);
    expect(f.count("upload_approvals")).toBe(0);
  });
  it("retired import mutations cannot be executed through the coordinator", async () => {
    const f = setup();
    expect(
      (
        await f.coordinate("/imports/old/confirm", {
          confirmation: "INDEX_LISTED_OBJECTS",
        })
      ).status,
    ).toBe(404);
    expect(f.count("videos")).toBe(0);
    expect(f.createMultipartUpload).not.toHaveBeenCalled();
  });
  it("keeps direct upload behind administrator login and exact origin while retired imports cannot execute", async () => {
    const f = setup();
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    expect(
      (await worker.fetch(request("/api/admin/uploads", fileA), f.env, ctx))
        .status,
    ).toBe(401);
    const loginResponse = await worker.fetch(
      request("/api/admin/login", { password: f.env.ADMIN_PASSWORD }),
      f.env,
      ctx,
    );
    const cookie = loginResponse.headers.get("Set-Cookie")!.split(";")[0];
    const direct = request("/api/admin/uploads", {
      ...fileA,
      approvalId: "expired-permission",
    });
    direct.headers.set("Cookie", cookie);
    expect((await worker.fetch(direct, f.env, ctx)).status).toBe(201);
    const cross = request("/api/admin/uploads", fileB);
    cross.headers.set("Cookie", cookie);
    cross.headers.set("Origin", "https://other.example");
    expect((await worker.fetch(cross, f.env, ctx)).status).toBe(403);
    for (const path of [
      "/api/admin/imports",
      "/api/admin/imports/plan",
      "/api/admin/imports/plans/old/confirm",
    ]) {
      const retired = request(path, {
        keys: ["imports/legacy.mp4"],
        confirmation: "INDEX_LISTED_OBJECTS",
      });
      retired.headers.set("Cookie", cookie);
      expect((await worker.fetch(retired, f.env, ctx)).status).toBe(404);
    }
    expect(f.count("uploads")).toBe(1);
    expect(f.createMultipartUpload).toHaveBeenCalledOnce();
    expect(f.processor).not.toHaveBeenCalled();
  });
});
