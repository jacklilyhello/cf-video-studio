import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import type { ResourceUsageSnapshot } from "../src/resource-usage";
const { DatabaseSync } = await import("node:sqlite" as string);
const { readFileSync, readdirSync } = await import("node:fs" as string);
const databases: { close(): void }[] = [];
const at = Date.parse("2026-10-15T12:00:00Z"),
  account = "a".repeat(32),
  coordinator = "c".repeat(32),
  processor = "d".repeat(32);
let resourceUsage: typeof import("../src/resource-usage").resourceUsage;
let collectResourceUsage: typeof import("../src/resource-usage").collectResourceUsage;
let allocateTaskConsumption: typeof import("../src/resource-usage").allocateTaskConsumption;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  vi.resetModules();
  ({ resourceUsage, collectResourceUsage, allocateTaskConsumption } =
    await import("../src/resource-usage"));
});
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup() {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(directory)
    .filter((value: string) => value.endsWith(".sql"))
    .sort())
    native.exec(readFileSync(new URL(file, directory), "utf8"));
  native.exec(`INSERT INTO videos(id,title,source_revision,source_name,created_at,updated_at) VALUES('fixture','Usage fixture','revision','fixture.mp4',${at},${at});
    INSERT INTO objects(key,video_id,category,bytes,state,updated_at) VALUES('source','fixture','source',2000,'present',${at}),('segment','fixture','segment',100,'present',${at}),('missing','fixture','source',500,'missing',${at});
    INSERT INTO objects(key,category,bytes,state,updated_at) VALUES('logo','branding',10,'present',${at});
    INSERT INTO uploads(id,video_id,object_key,fingerprint,expected_size,state,reserved_bytes,expires_at,created_at,updated_at) VALUES('upload','fixture','pending','fingerprint',400,'unknown',400,${at + 1000},${at},${at});
    INSERT INTO reservations(id,owner_id,kind,amounts_json,state,created_at) VALUES('active','fixture','processing','{"r2CurrentBytes":300}','active',${at}),('released','fixture','processing','{"r2CurrentBytes":500}','released',${at});
    INSERT INTO logs(id,level,stage,message,created_at) VALUES('safe-log','error','fixture','Synthetic test',${at});`);
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      let values: unknown[] = [];
      const statement = {
        bind(...input: unknown[]) {
          values = input;
          return statement;
        },
        async first() {
          return native.prepare(sql).get(...values) ?? null;
        },
        async run() {
          const result = native.prepare(sql).run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
        async all() {
          return { success: true, results: native.prepare(sql).all(...values) };
        },
      };
      return statement;
    },
    async batch(input: { all(): Promise<unknown> }[]) {
      return Promise.all(input.map((statement) => statement.all()));
    },
  };
  const neverStart = vi.fn(() => {
    throw new Error("Must never start or wake processing for statistics");
  });
  const env = {
    DB: db,
    CF_USAGE_API_TOKEN: "fictional-readonly-unit-fixture",
    CLOUDFLARE_ACCOUNT_ID: account,
    APP_ENV: "test",
    PROCESSING_ENABLED: "false",
    RESOURCE_WORKER_NAME: "fixture-test",
    RESOURCE_D1_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
    RESOURCE_R2_BUCKET: "fixture-test",
    RESOURCE_DO_NAMESPACES: JSON.stringify([
      { id: coordinator, name: "Coordinator" },
      { id: processor, name: "Processor" },
    ]),
    RESOURCE_CONTAINER_APPLICATION_ID: processor,
    RESOURCE_WORKER_TAG: "b".repeat(32),
    PROCESSOR: { get: neverStart },
    COORDINATOR: { get: neverStart },
    MEDIA: { list: neverStart, head: neverStart },
  } as unknown as Env;
  return { env, native, statements, neverStart };
}
function upstream(
  options: {
    fail?: Set<string>;
    failBilling?: Set<string>;
    billingStart?: string;
    empty?: Set<string>;
    wrongAccount?: boolean;
    omitCpu?: boolean;
    omitBillingCpu?: boolean;
    requests?: number;
    anchor?: string | null;
    containers?: Record<string, number>;
    buildPages?: number;
    capped?: boolean;
  } = {},
) {
  const calls: { url: string; query?: string }[] = [];
  const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input),
      query = init?.body
        ? (JSON.parse(String(init.body)).query as string)
        : undefined;
    calls.push({ url, query });
    expect(new Headers(init?.headers).get("Authorization")).toMatch(
      /^Bearer fictional-readonly-unit-fixture/,
    );
    if (url.includes("billable-usage/info"))
      return Response.json({
        success: true,
        result: {
          covered: options.anchor !== null,
          subscriptions:
            options.anchor === null
              ? []
              : [
                  {
                    billing_cycle_anchor_timestamp:
                      options.anchor || "2024-07-13T00:00:00Z",
                  },
                ],
        },
      });
    if (url.includes("/builds/workers/"))
      return Response.json({
        success: true,
        result: [
          {
            build_uuid: "11111111-1111-4111-8111-111111111111",
            build_outcome: "success",
            created_on: "2026-10-15T10:00:00Z",
            stopped_on: "2026-10-15T10:02:00Z",
          },
          {
            build_uuid: "22222222-2222-4222-8222-222222222222",
            build_outcome: "fail",
            created_on: "2026-10-15T11:00:00Z",
            stopped_on: "2026-10-15T11:00:30Z",
          },
        ],
        result_info: {
          page: 1,
          per_page: 100,
          total_count: 25,
          total_pages: options.buildPages ?? 2,
        },
      });
    if (url.includes("/d1/database/"))
      return Response.json({ success: true, result: { file_size: 8192 } });
    const node = query!.match(
      /\b(workersInvocationsAdaptive|d1AnalyticsAdaptiveGroups|r2OperationsAdaptiveGroups|r2StorageAdaptiveGroups|durableObjectsInvocationsAdaptiveGroups|durableObjectsPeriodicGroups|durableObjectsSqlStorageGroups|containersUsageAdaptiveGroups)\(/,
    )![1];
    const billingWindow =
      query!.includes(
        `datetime_geq:"${options.billingStart || "2026-10-13T00:00:00.000Z"}"`,
      ) &&
      query!.includes(`datetime_lt:"${new Date(Date.now()).toISOString()}"`);
    if (
      options.fail?.has(node) ||
      (billingWindow && options.failBilling?.has(node))
    )
      return Response.json(
        {
          success: false,
          errors: [
            {
              code: 10000,
              message: "Never retain upstream credential or internal detail",
            },
          ],
        },
        { status: 403 },
      );
    let data: Record<string, unknown>[] = [];
    const primary = query!.includes(`namespaceId:"${coordinator}"`);
    if (node === "workersInvocationsAdaptive")
      data = [
        {
          sum: {
            requests: options.requests ?? 200,
            errors: 3,
            ...(options.omitCpu || (billingWindow && options.omitBillingCpu)
              ? {}
              : { cpuTimeUs: 2_000_000 }),
          },
        },
      ];
    if (node === "d1AnalyticsAdaptiveGroups")
      data = [
        {
          sum: {
            rowsRead: 1000,
            rowsWritten: 20,
            readQueries: 12,
            writeQueries: 3,
          },
        },
      ];
    if (node === "r2OperationsAdaptiveGroups")
      data = [{ sum: { requests: 30 } }];
    if (node === "containersUsageAdaptiveGroups" && options.containers)
      data = [{ sum: options.containers }];
    if (node === "r2StorageAdaptiveGroups")
      data = [
        {
          dimensions: {
            datetime: "2026-10-15T11:50:00Z",
            storageClass: "Standard",
          },
          max: { payloadSize: 2200 },
        },
        {
          dimensions: {
            datetime: "2026-10-15T11:49:00Z",
            storageClass: "InfrequentAccess",
          },
          max: { payloadSize: 10 },
        },
        {
          dimensions: {
            datetime: "2026-10-15T11:48:00Z",
            storageClass: "Standard",
          },
          max: { payloadSize: 2100 },
        },
      ];
    if (node === "durableObjectsInvocationsAdaptiveGroups" && primary)
      data = [{ sum: { requests: 8 } }];
    if (node === "durableObjectsPeriodicGroups" && primary)
      data = [{ sum: { duration: 24.5, rowsRead: 10, rowsWritten: 2 } }];
    if (node === "durableObjectsSqlStorageGroups" && primary)
      data = [
        {
          dimensions: { datetime: "2026-10-15T11:45:00Z" },
          max: { storedBytes: 16384 },
        },
      ];
    if (options.capped && node === "workersInvocationsAdaptive")
      data = Array.from({ length: 100 }, () => ({
        sum: { requests: 1, errors: 0, cpuTimeUs: 1 },
      }));
    if (options.empty?.has(node)) data = [];
    return Response.json({
      data: {
        viewer: {
          accounts: [
            {
              accountTag: options.wrongAccount ? "f".repeat(32) : account,
              [node]: data,
            },
          ],
        },
      },
      errors: null,
    });
  });
  vi.stubGlobal("fetch", fake);
  return { calls, fake };
}
function card(snapshot: ResourceUsageSnapshot, key: string) {
  return snapshot.cards.find((item) => item.key === key)!;
}
function value(snapshot: ResourceUsageSnapshot, key: string, metric: string) {
  return card(snapshot, key).metrics.find((item) => item.key === metric)?.value;
}

describe("project resource usage without manual evidence or account balance invention", () => {
  it("scopes every official query and durably collects usage without Container calls", async () => {
    const s = setup(),
      api = upstream(),
      result = await resourceUsage(s.env);
    expect(result.cards.map((item) => item.key)).toEqual([
      "r2",
      "d1",
      "workers",
      "do",
      "containers",
      "builds",
      "logs",
    ]);
    expect(value(result, "r2", "registeredBytes")).toBe(2110);
    expect(value(result, "r2", "sourceBytes")).toBe(2000);
    expect(value(result, "r2", "generatedBytes")).toBe(100);
    expect(value(result, "r2", "brandingBytes")).toBe(10);
    expect(card(result, "r2").limit).toEqual({
      usedBytes: 2110,
      reservedBytes: 700,
      limitBytes: 10737418240,
    });
    expect(value(result, "d1", "rowsRead")).toBe(1000);
    expect(value(result, "d1", "readQueries")).toBe(12);
    expect(value(result, "d1", "databaseBytes")).toBe(8192);
    expect(value(result, "workers", "cpuTimeUs")).toBe(2000);
    expect(value(result, "containers", "ownedStarts")).toBe(0);
    expect(card(result, "containers").diagnostics[0].state).toBe("empty");
    expect(value(result, "logs", "applicationLogs")).toBe(1);
    expect(card(result, "logs").notes.join()).toContain(
      "不是 Cloudflare 平台计费日志量",
    );
    expect(value(result, "builds", "buildCount")).toBe(2);
    expect(value(result, "builds", "buildWallSeconds")).toBe(150);
    expect(
      card(result, "builds").metrics.find(
        (item) => item.key === "buildWallSeconds",
      )?.note,
    ).toContain("不是官方计费");
    for (const call of api.calls) {
      if (call.query) {
        expect(call.query).toContain(`accountTag:"${account}"`);
        if (call.query.includes("workersInvocationsAdaptive("))
          expect(call.query).toContain('scriptName:"fixture-test"');
        if (call.query.includes("d1AnalyticsAdaptiveGroups("))
          expect(call.query).toContain(
            `databaseId:"${s.env.RESOURCE_D1_DATABASE_ID}"`,
          );
        if (call.query.includes("r2"))
          expect(call.query).toContain('bucketName:"fixture-test"');
        if (call.query.includes("durableObjects"))
          expect(call.query).toMatch(/namespaceId:"[cd]{32}"/);
        if (call.query.includes("containersUsage"))
          expect(call.query).toContain(`applicationId:"${processor}"`);
        expect(call.query).not.toContain("quantiles");
      }
      expect(call.url).not.toMatch(
        /\/user\/|\/billing\/|\/r2\/buckets\?|\/workers\/scripts$/,
      );
    }
    expect(
      api.calls.filter((call) => call.url.includes("/builds/workers/"))[0].url,
    ).toContain(`/${"b".repeat(32)}/builds?page=1&per_page=100`);
    expect(
      s.statements.some((sql) =>
        sql.includes("INSERT INTO resource_usage_daily"),
      ),
    ).toBe(true);
    expect(
      s.statements
        .filter((sql) => /^(INSERT|UPDATE|DELETE)/i.test(sql.trim()))
        .every((sql) => /resource_usage_/.test(sql)),
    ).toBe(true);
    expect(s.neverStart).not.toHaveBeenCalled();
    for (const item of result.cards) {
      expect(item.links.length).toBeGreaterThan(0);
      expect(item.links[0].url).toContain(
        `https://dash.cloudflare.com/${account}`,
      );
    }
    expect(JSON.stringify(result)).not.toMatch(
      /fictional-readonly|Never retain upstream|manualEvidence|manual_usage|freeRemaining/,
    );
  });
  it("uses per-storage-class latest R2 snapshots instead of max across classes or stale duplicates", async () => {
    const s = setup();
    upstream();
    const result = await resourceUsage(s.env);
    expect(value(result, "r2", "bucketPayload-Standard")).toBe(2200);
    expect(value(result, "r2", "bucketPayload-InfrequentAccess")).toBe(10);
    expect(
      card(result, "r2").metrics.filter((item) =>
        item.key.startsWith("bucketPayload-"),
      ).length,
    ).toBe(2);
    expect(
      card(result, "r2").metrics.find(
        (item) => item.key === "bucketPayload-Standard",
      )?.observedAt,
    ).toBe(Date.parse("2026-10-15T11:50:00Z"));
  });
  it("isolates missing permissions from other successful sources and never records empty official results as zero", async () => {
    const s = setup();
    upstream({
      fail: new Set(["d1AnalyticsAdaptiveGroups"]),
      empty: new Set(["r2StorageAdaptiveGroups"]),
    });
    const result = await resourceUsage(s.env);
    expect(value(result, "workers", "requests")).toBe(200);
    expect(value(result, "d1", "databaseBytes")).toBe(8192);
    expect(value(result, "d1", "rowsRead")).toBeUndefined();
    expect(card(result, "d1").diagnostics[0]).toMatchObject({
      state: "restricted",
      httpStatus: 403,
      codes: [10000],
    });
    expect(value(result, "r2", "registeredBytes")).toBe(2110);
    expect(
      card(result, "r2").diagnostics.some((item) => item.state === "empty"),
    ).toBe(true);
    expect(
      card(result, "containers").metrics.some(
        (item) => item.source === "official",
      ),
    ).toBe(false);
    expect(
      card(result, "do").diagnostics.filter((item) => item.state === "empty")
        .length,
    ).toBe(3);
  });
  it("omits a missing CPU sum instead of substituting request duration or quantile CPU", async () => {
    const s = setup();
    upstream({ omitCpu: true });
    const result = await resourceUsage(s.env);
    expect(value(result, "workers", "requests")).toBe(200);
    expect(value(result, "workers", "cpuTimeUs")).toBeUndefined();
    expect(card(result, "workers").diagnostics[0].state).toBe("partial");
  });
  it("deduplicates concurrent collection and enforces hourly collection and a 30-second refresh floor", async () => {
    const s = setup(),
      api = upstream();
    const [first, second] = await Promise.all([
      resourceUsage(s.env),
      resourceUsage(s.env),
    ]);
    expect(first.cards).toEqual(second.cards);
    const count = api.fake.mock.calls.length;
    await resourceUsage(s.env, { refresh: true });
    expect(api.fake.mock.calls.length).toBe(count);
    vi.setSystemTime(at + 31_000);
    await resourceUsage(s.env);
    expect(api.fake.mock.calls.length).toBe(count);
    await resourceUsage(s.env, { refresh: true });
    expect(api.fake.mock.calls.length).toBeGreaterThan(count);
    const updated = api.fake.mock.calls.length;
    vi.setSystemTime(at + 301_000);
    await resourceUsage(s.env);
    expect(api.fake.mock.calls.length).toBe(updated);
    vi.setSystemTime(at + 3632_000);
    await resourceUsage(s.env);
    expect(api.fake.mock.calls.length).toBeGreaterThan(updated);
  });
  it("retains per-source last-good data and original timestamps beyond 6 hours", async () => {
    const s = setup();
    upstream();
    await resourceUsage(s.env);
    vi.setSystemTime(at + 31_000);
    upstream({ fail: new Set(["workersInvocationsAdaptive"]) });
    const stale = await resourceUsage(s.env, { refresh: true });
    expect(value(stale, "workers", "requests")).toBe(200);
    expect(
      card(stale, "workers").metrics.find((item) => item.key === "requests")
        ?.observedAt,
    ).toBe(at);
    expect(
      card(stale, "workers").diagnostics.some(
        (item) => item.state === "stale" && item.dataAt === at,
      ),
    ).toBe(true);
    vi.setSystemTime(at + 6 * 3600_000 + 1);
    const expired = await resourceUsage(s.env, { refresh: true });
    expect(value(expired, "workers", "requests")).toBe(200);
    expect(value(expired, "r2", "registeredBytes")).toBe(2110);
  });
  it("does not reuse test statistics for another environment or resource and rejects mismatched returned account scope", async () => {
    const s = setup(),
      api = upstream();
    await resourceUsage(s.env);
    const count = api.fake.mock.calls.length;
    const production = await resourceUsage({
      ...s.env,
      APP_ENV: "production",
      RESOURCE_WORKER_NAME: "fixture-production",
    });
    expect(production.environment).toBe("production");
    expect(api.fake.mock.calls.length).toBeGreaterThan(count);
    expect(
      api.calls.some((call) =>
        call.query?.includes('scriptName:"fixture-production"'),
      ),
    ).toBe(true);
    vi.setSystemTime(at + 31_000);
    upstream({ wrongAccount: true });
    const mismatch = await resourceUsage(
      {
        ...s.env,
        CF_USAGE_API_TOKEN: "fictional-readonly-unit-fixture" + "-new",
      },
      { refresh: true },
    );
    expect(
      card(mismatch, "workers").metrics.some(
        (item) => item.source === "official",
      ),
    ).toBe(true);
    expect(card(mismatch, "workers").diagnostics[0].state).toBe("unavailable");
  });
  it("shows existing records and valid official product links when read credentials or some resource identifiers are absent", async () => {
    const s = setup(),
      api = upstream();
    const result = await resourceUsage({
      ...s.env,
      CF_USAGE_API_TOKEN: undefined,
      RESOURCE_DO_NAMESPACES: '[{"id":"invalid","name":"Other"}]',
      RESOURCE_WORKER_NAME: "bad/name",
    });
    expect(api.fake).not.toHaveBeenCalled();
    expect(value(result, "r2", "registeredBytes")).toBe(2110);
    expect(value(result, "containers", "ownedStarts")).toBe(0);
    expect(card(result, "do").diagnostics[0].state).toBe("unconfigured");
    expect(card(result, "workers").links[0].url).toBe(
      `https://dash.cloudflare.com/${account}/workers-and-pages`,
    );
  });
  it("labels observed task wall time and capacity products as estimates, never official Container CPU", async () => {
    const s = setup();
    s.native
      .exec(`INSERT INTO versions(id,video_id,prefix,state,mode,quality,timeline_id,created_at) VALUES('version','fixture','output','failed','faststart','source','timeline',${at});
      INSERT INTO quotes(id,video_id,source_revision,source_etag,mode,quality,period_start,expires_at,data_json,created_at) VALUES('quote','fixture','r','e','faststart','source','2026-10-01',${at + 1000},'{}',${at});
      INSERT INTO jobs(id,video_id,version_id,quote_id,state,stage,started_at,finished_at,stop_verified,consumption_json,created_at,updated_at) VALUES('job','fixture','version','quote','failed','failed',${at - 10000},${at},1,'{"wallSeconds":10,"cpuVcpuSecondsUpper":40}',${at - 10000},${at});`);
    upstream();
    const result = await resourceUsage(s.env);
    expect(value(result, "containers", "ownedStarts")).toBeUndefined();
    expect(value(result, "containers", "dispatched")).toBe(1);
    expect(value(result, "containers", "wallSeconds")).toBe(10);
    expect(value(result, "containers", "cpuUpper")).toBe(40);
    expect(
      card(result, "containers").metrics.find((item) => item.key === "cpuUpper")
        ?.source,
    ).toBe("estimate");
    expect(
      card(result, "containers").metrics.find((item) => item.key === "cpuUpper")
        ?.note,
    ).toContain("不是实际 CPU");
  });
  it("ignores retired upload-approval reservations while retaining actual upload and processing reservations", async () => {
    const s = setup();
    for (const [id, state, expires] of [
      ["confirmed", "confirmed", at + 1000],
      ["expired", "confirmed", at - 1],
      ["prepared", "prepared", at + 1000],
    ] as const) {
      s.native
        .prepare(
          "INSERT INTO upload_approvals(id,scope_hash,state,total_bytes,additional_bytes,reasons_json,expires_at,created_at) VALUES(?,?,?,600,600,'[]',?,?)",
        )
        .run(id, id, state, expires, at);
      s.native
        .prepare(
          "INSERT INTO upload_approval_files(id,approval_id,name,title,expected_size,fingerprint,reserved_bytes) VALUES(?,?,?,?,600,?,600)",
        )
        .run(id, id, id, "fixture", "f".repeat(64));
    }
    upstream();
    const result = await resourceUsage(s.env);
    expect(card(result, "r2").limit?.reservedBytes).toBe(700);
    expect(value(result, "r2", "uploadReservedBytes")).toBe(700);
    expect(
      s.statements.some((sql: string) => sql.includes("upload_approval_files")),
    ).toBe(false);
  });
  it("excludes unverified running checkpoints from stopped-task duration estimates", async () => {
    const s = setup();
    s.native
      .exec(`INSERT INTO versions(id,video_id,prefix,state,mode,quality,timeline_id,created_at) VALUES('version','fixture','output','processing','faststart','source','timeline',${at});
      INSERT INTO quotes(id,video_id,source_revision,source_etag,mode,quality,period_start,expires_at,data_json,created_at) VALUES('quote','fixture','r','e','faststart','source','2026-10-01',${at + 1000},'{}',${at});
      INSERT INTO jobs(id,video_id,version_id,quote_id,state,stage,started_at,stop_verified,consumption_json,created_at,updated_at) VALUES('job','fixture','version','quote','running','running',${at - 10000},0,'{"wallSeconds":10,"cpuVcpuSecondsUpper":40}',${at - 10000},${at});`);
    upstream();
    const result = await resourceUsage(s.env);
    expect(value(result, "containers", "unresolved")).toBe(1);
    expect(value(result, "containers", "wallSeconds")).toBeUndefined();
    expect(value(result, "containers", "cpuUpper")).toBeUndefined();
  });
});

describe("billing-period recorded usage fallback", () => {
  it("falls back to the 600 recorded billing-period requests when only the full-period query fails", async () => {
    const s = setup();
    upstream({ failBilling: new Set(["workersInvocationsAdaptive"]) });
    await collectResourceUsage(s.env);
    expect(
      s.native
        .prepare(
          "SELECT observed_at FROM resource_usage_latest WHERE source='workers' AND kind='billing'",
        )
        .get().observed_at,
    ).toBe(0);
    expect(
      value(
        await resourceUsage(s.env, { range: "all" }),
        "workers",
        "requests",
      ),
    ).toBe(600);
    const billing = await resourceUsage(s.env, { range: "billing" });
    expect(billing.period.start).toBe("2026-10-13T00:00:00.000Z");
    expect(value(billing, "workers", "requests")).toBe(600);
    const requests = card(billing, "workers").metrics.find(
      (item) => item.key === "requests",
    )!;
    expect(requests.note).toContain("本账期已记录用量");
    expect(requests.label).toContain("本账期已记录用量");
    expect(requests.coverage).toEqual({
      kind: "daily-ledger",
      rangeStart: Date.parse("2026-10-13T00:00:00Z"),
      rangeEnd: at,
      intervals: [{ start: Date.parse("2026-10-13T00:00:00Z"), end: at }],
      gapMilliseconds: 0,
    });
    expect(requests.observedAt).toBe(at);
    expect(value(await resourceUsage(s.env), "workers", "requests")).toBe(200);
    expect(value(billing, "r2", "bucketPayload-Standard")).toBe(2200);
    expect(value(billing, "r2", "registeredBytes")).toBe(2110);
    expect(s.neverStart).not.toHaveBeenCalled();
  });
  it("prefers each available official billing field including zero and falls back only for missing fields", async () => {
    const s = setup();
    upstream({ requests: 0, omitBillingCpu: true });
    await collectResourceUsage(s.env);
    const result = await resourceUsage(s.env, { range: "billing" });
    const workers = card(result, "workers");
    expect(value(result, "workers", "requests")).toBe(0);
    expect(value(result, "workers", "errors")).toBe(3);
    expect(value(result, "workers", "cpuTimeUs")).toBe(6000);
    expect(
      workers.metrics.find((item) => item.key === "requests")?.coverage,
    ).toMatchObject({ kind: "billing-snapshot", gapMilliseconds: 0 });
    expect(
      workers.metrics.find((item) => item.key === "cpuTimeUs")?.coverage,
    ).toMatchObject({ kind: "daily-ledger", gapMilliseconds: 0 });
    expect(
      workers.metrics.filter((item) => item.key === "requests"),
    ).toHaveLength(1);
    expect(
      workers.metrics.filter((item) => item.key === "cpuTimeUs"),
    ).toHaveLength(1);
  });
  it("keeps repeated collection and late upward or downward corrections idempotent, then selects recovered official data", async () => {
    const s = setup();
    const failed = new Set(["workersInvocationsAdaptive"]);
    upstream({ failBilling: failed });
    await collectResourceUsage(s.env);
    for (const [offset, requests, expected] of [
      [31_000, 350, 900],
      [62_000, 100, 400],
    ]) {
      vi.setSystemTime(at + offset);
      upstream({ failBilling: failed, requests });
      await collectResourceUsage(s.env, { force: true });
      const first = await resourceUsage(s.env, { range: "billing" });
      const second = await resourceUsage(s.env, { range: "billing" });
      expect(value(first, "workers", "requests")).toBe(expected);
      expect(card(second, "workers").metrics).toEqual(
        card(first, "workers").metrics,
      );
    }
    vi.setSystemTime(at + 93_000);
    upstream({ requests: 700 });
    await collectResourceUsage(s.env, { force: true });
    const recovered = await resourceUsage(s.env, { range: "billing" });
    expect(value(recovered, "workers", "requests")).toBe(700);
    expect(
      card(recovered, "workers").metrics.find((item) => item.key === "requests")
        ?.coverage?.kind,
    ).toBe("billing-snapshot");
    expect(s.neverStart).not.toHaveBeenCalled();
  });
  it("retains a usable same-cycle official snapshot on failure without adding the newer daily totals", async () => {
    const s = setup();
    upstream();
    await collectResourceUsage(s.env);
    vi.setSystemTime(at + 31_000);
    upstream({
      requests: 350,
      failBilling: new Set(["workersInvocationsAdaptive"]),
    });
    await collectResourceUsage(s.env, { force: true });
    const result = await resourceUsage(s.env, { range: "billing" });
    expect(value(result, "workers", "requests")).toBe(200);
    const requests = card(result, "workers").metrics.find(
      (item) => item.key === "requests",
    )!;
    expect(requests.observedAt).toBe(at);
    expect(requests.coverage).toMatchObject({
      kind: "billing-snapshot",
      gapMilliseconds: 31_000,
    });
    expect(requests.note).toContain("覆盖不完整");
  });
  it("tracks each field's missing days and preserved partial-day end without erasing the available fields", async () => {
    const s = setup();
    upstream({ failBilling: new Set(["workersInvocationsAdaptive"]) });
    await collectResourceUsage(s.env);
    const today = Date.parse("2026-10-15T00:00:00Z"),
      yesterday = today - 86400_000;
    s.native
      .prepare(
        "UPDATE resource_usage_daily SET result_json=json_remove(result_json,'$.metrics[2]') WHERE source='workers' AND day_start=?",
      )
      .run(yesterday);
    s.native
      .prepare(
        "UPDATE resource_usage_daily SET result_json=json_set(result_json,'$.metrics[2].observedAt',?) WHERE source='workers' AND day_start=?",
      )
      .run(today + 6 * 3600_000, today);
    const result = await resourceUsage(s.env, { range: "billing" });
    expect(value(result, "workers", "requests")).toBe(600);
    expect(value(result, "workers", "errors")).toBe(9);
    expect(value(result, "workers", "cpuTimeUs")).toBe(4000);
    expect(
      card(result, "workers").metrics.find((item) => item.key === "requests")
        ?.coverage?.gapMilliseconds,
    ).toBe(0);
    expect(
      card(result, "workers").metrics.find((item) => item.key === "cpuTimeUs")
        ?.coverage,
    ).toMatchObject({
      kind: "daily-ledger",
      gapMilliseconds: 30 * 3600_000,
      intervals: [
        { start: today - 2 * 86400_000, end: yesterday },
        { start: today, end: today + 6 * 3600_000 },
      ],
    });
    expect(
      card(result, "workers").diagnostics.some(
        (item) => item.state === "partial",
      ),
    ).toBe(true);
  });
  it("shows genuine recorded zero while leaving an entirely missing field unknown", async () => {
    const s = setup();
    upstream({
      requests: 0,
      omitCpu: true,
      failBilling: new Set(["workersInvocationsAdaptive"]),
    });
    await collectResourceUsage(s.env);
    const result = await resourceUsage(s.env, { range: "billing" });
    expect(value(result, "workers", "requests")).toBe(0);
    expect(value(result, "workers", "cpuTimeUs")).toBeUndefined();
  });
  it("reports an exact missing-day interval rather than implying a complete period", async () => {
    const s = setup();
    upstream({ failBilling: new Set(["workersInvocationsAdaptive"]) });
    await collectResourceUsage(s.env);
    const missing = Date.parse("2026-10-14T00:00:00Z");
    s.native
      .prepare(
        "DELETE FROM resource_usage_daily WHERE source='workers' AND day_start=?",
      )
      .run(missing);
    const result = await resourceUsage(s.env, { range: "billing" });
    expect(value(result, "workers", "requests")).toBe(400);
    const requests = card(result, "workers").metrics.find(
      (item) => item.key === "requests",
    )!;
    expect(requests.coverage).toMatchObject({
      gapMilliseconds: 86400_000,
      intervals: [
        { start: missing - 86400_000, end: missing },
        { start: missing + 86400_000, end: at },
      ],
    });
    expect(requests.note).toContain("覆盖不完整");
    expect(requests.note).toContain("24.00 小时");
  });
  it("excludes the crossing first-day total at a non-midnight anchor instead of prorating it", async () => {
    const s = setup();
    const start = Date.parse("2026-10-13T04:05:06Z");
    upstream({
      anchor: "2024-07-13T04:05:06Z",
      billingStart: new Date(start).toISOString(),
      failBilling: new Set(["workersInvocationsAdaptive"]),
    });
    await collectResourceUsage(s.env);
    const result = await resourceUsage(s.env, { range: "billing" });
    expect(result.period.start).toBe(new Date(start).toISOString());
    expect(value(result, "workers", "requests")).toBe(400);
    expect(
      card(result, "workers").metrics.find((item) => item.key === "requests")
        ?.coverage,
    ).toMatchObject({
      rangeStart: start,
      gapMilliseconds: Date.parse("2026-10-14T00:00:00Z") - start,
      intervals: [{ start: Date.parse("2026-10-14T00:00:00Z"), end: at }],
    });
  });
  it("rejects old-cycle snapshots and daily records while still using current-cycle daily records", async () => {
    const s = setup();
    upstream();
    await collectResourceUsage(s.env);
    s.native
      .prepare(
        "UPDATE resource_usage_latest SET range_start=? WHERE source='workers' AND kind='billing'",
      )
      .run(Date.parse("2026-09-13T00:00:00Z"));
    s.native
      .prepare(
        "INSERT INTO resource_usage_daily SELECT scope,source,?, ?, result_json,observed_at FROM resource_usage_daily WHERE source='workers' ORDER BY day_start LIMIT 1",
      )
      .run(
        Date.parse("2026-10-12T00:00:00Z"),
        Date.parse("2026-10-13T00:00:00Z"),
      );
    const result = await resourceUsage(s.env, { range: "billing" });
    expect(value(result, "workers", "requests")).toBe(600);
    expect(
      card(result, "workers").diagnostics.some(
        (item) => item.state === "stale" && item.note.includes("另一账期"),
      ),
    ).toBe(true);
    expect(
      value(
        await resourceUsage(s.env, { range: "all" }),
        "workers",
        "requests",
      ),
    ).toBe(800);
  });
  it.each([
    { APP_ENV: "production" },
    { RESOURCE_WORKER_NAME: "fixture-other" },
    { RESOURCE_R2_BUCKET: "fixture-other" },
  ])(
    "isolates saved daily fallback when the environment or resource scope changes (%j)",
    async (change) => {
      const s = setup();
      upstream({ failBilling: new Set(["workersInvocationsAdaptive"]) });
      await collectResourceUsage(s.env);
      upstream({ fail: new Set(["workersInvocationsAdaptive"]) });
      const other = await resourceUsage(
        { ...s.env, ...change },
        { range: "billing" },
      );
      expect(value(other, "workers", "requests")).toBeUndefined();
      expect(
        value(
          await resourceUsage(s.env, { range: "billing" }),
          "workers",
          "requests",
        ),
      ).toBe(600);
      expect(s.neverStart).not.toHaveBeenCalled();
    },
  );
  it("keeps allowance, processing and budget settings outside the fallback", async () => {
    const s = setup();
    s.native.exec(
      "UPDATE settings SET value='7.5' WHERE key='monthly_spend_limit_usd'",
    );
    const settings = s.native
      .prepare("SELECT * FROM settings ORDER BY key")
      .all();
    upstream({ failBilling: new Set(["workersInvocationsAdaptive"]) });
    const result = await resourceUsage(s.env, { range: "billing" });
    expect(result.policy).toEqual({
      processingEnabled: false,
      monthlyIncrementalBudgetUsd: 7.5,
    });
    expect(
      s.native.prepare("SELECT * FROM settings ORDER BY key").all(),
    ).toEqual(settings);
    expect(
      s.statements
        .filter((sql) => /^(INSERT|UPDATE|DELETE)/i.test(sql.trim()))
        .every((sql) => /resource_usage_/.test(sql)),
    ).toBe(true);
    expect(s.neverStart).not.toHaveBeenCalled();
  });
});

describe("continuous durable resource accounting", () => {
  it("uses acquisition time for a delayed scheduled lease and excludes a second isolate without changing the data window", async () => {
    const s = setup(),
      normal = upstream().fake;
    const scheduledAt = at - 40_000;
    let started!: () => void,
      release!: () => void,
      held = false;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const query = init?.body
          ? (JSON.parse(String(init.body)).query as string)
          : "";
        if (!held && query.includes("workersInvocationsAdaptive(")) {
          held = true;
          expect(query).toContain(
            `datetime_lt:"${new Date(scheduledAt).toISOString()}"`,
          );
          started();
          await gate;
        }
        return normal(input, init);
      }),
    );
    const first = collectResourceUsage(s.env, { at: scheduledAt });
    await began;
    const leased = s.native
      .prepare("SELECT checked_at,lease_until FROM resource_usage_state")
      .get();
    vi.resetModules();
    const independent = await import("../src/resource-usage");
    const secondFetch = vi.fn(normal);
    vi.stubGlobal("fetch", secondFetch);
    // Module isolates share this test's global fetch. Distinct mock credentials
    // identify the caller without changing the stable resource scope.
    const secondEnv = {
      ...s.env,
      CF_USAGE_API_TOKEN: `${s.env.CF_USAGE_API_TOKEN}-second-isolate`,
    };
    await independent.collectResourceUsage(secondEnv);
    const secondCallsWhileFirstRunning = secondFetch.mock.calls.filter(
      ([, init]) =>
        new Headers(init?.headers).get("Authorization") ===
        `Bearer ${secondEnv.CF_USAGE_API_TOKEN}`,
    ).length;
    const afterSecond = s.native
      .prepare("SELECT checked_at,lease_until FROM resource_usage_state")
      .get();
    release();
    await first;
    expect(leased).toMatchObject({
      checked_at: scheduledAt,
      lease_until: at + 35_000,
    });
    expect(secondCallsWhileFirstRunning).toBe(0);
    expect(afterSecond).toEqual(leased);
    const saved = s.native
      .prepare(
        "SELECT range_end,observed_at FROM resource_usage_latest WHERE source='workers' AND kind='24h'",
      )
      .get();
    expect(saved).toMatchObject({
      range_end: scheduledAt,
      observed_at: scheduledAt,
    });
    expect(
      s.native.prepare("SELECT lease_until FROM resource_usage_state").get()
        .lease_until,
    ).toBe(0);
    expect(s.neverStart).not.toHaveBeenCalled();
  });
  it("recovers a lease expired at acquisition even if it was still active at the delayed scheduled time", async () => {
    const s = setup();
    upstream();
    await collectResourceUsage(s.env);
    s.native
      .prepare("UPDATE resource_usage_state SET checked_at=0,lease_until=?")
      .run(at - 10_000);
    const api = upstream();
    await collectResourceUsage(s.env, { at: at - 40_000 });
    expect(api.fake).toHaveBeenCalled();
    expect(
      s.native
        .prepare("SELECT checked_at,lease_until FROM resource_usage_state")
        .get(),
    ).toMatchObject({
      checked_at: at - 40_000,
      lease_until: 0,
    });
  });
  it("returns the first GET before upstream completion and retains collection after the browser cancels its request", async () => {
    const s = setup(),
      normal = upstream().fake;
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        started();
        await gate;
        // A page's AbortSignal must not own background collection.
        expect(init?.signal?.aborted).toBe(false);
        return normal(input, init);
      }),
    );
    const background: Promise<void>[] = [];
    const browser = new AbortController();
    const request = new Request(
      "https://fixture.test/api/admin/resource-usage",
      { signal: browser.signal },
    );
    const response = Response.json(
      await resourceUsage(s.env, {
        waitUntil: (p) => {
          background.push(p);
        },
      }),
    );
    browser.abort();
    expect(request.signal.aborted).toBe(true);
    const first = (await response.json()) as ResourceUsageSnapshot;
    expect(value(first, "r2", "registeredBytes")).toBe(2110);
    expect(value(first, "workers", "requests")).toBeUndefined();
    expect(first.collection?.status).toMatch(/pending|collecting/);
    expect(first.collection?.scope).toContain("test / fixture-test");
    expect(background).toHaveLength(1);
    await began;
    release();
    await Promise.all(background);
    const saved = await resourceUsage(s.env);
    expect(value(saved, "workers", "requests")).toBe(200);
    expect(
      s.native.prepare("SELECT COUNT(*) n FROM resource_usage_daily").get().n,
    ).toBeGreaterThan(0);
    expect(s.neverStart).not.toHaveBeenCalled();
  });
  it("returns existing rolling data immediately during refresh and saves the confirmed anchor before later queries finish", async () => {
    const s = setup();
    upstream();
    await collectResourceUsage(s.env);
    vi.setSystemTime(at + 31_000);
    const normal = upstream({ anchor: "2024-07-13T00:00:00Z" }).fake;
    let started!: () => void, release!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.native.exec(
      "UPDATE resource_usage_state SET anchor=NULL,anchor_checked_at=NULL",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/graphql")) {
          started();
          await gate;
        }
        return normal(input, init);
      }),
    );
    const background: Promise<void>[] = [];
    const result = await resourceUsage(s.env, {
      refresh: true,
      waitUntil: (p) => {
        background.push(p);
      },
    });
    expect(value(result, "workers", "requests")).toBe(200);
    expect(
      card(result, "workers").metrics.find((m) => m.key === "requests")
        ?.observedAt,
    ).toBe(at);
    await began;
    const state = s.native.prepare("SELECT * FROM resource_usage_state").get();
    expect(state.anchor).toBe("2024-07-13T00:00:00Z");
    expect(state.anchor_checked_at).toBe(at + 31_000);
    expect(state.checked_at).toBe(at + 31_000);
    expect(state.lease_until).toBe(at + 66_000);
    expect(
      JSON.parse(state.diagnostics_json).find(
        (d: { source: string }) => d.source === "持续采集",
      ).state,
    ).toBe("partial");
    release();
    await Promise.all(background);
  });
  it("bounds an uncooperative upstream by the total deadline, releases its lease and reports incomplete collection without invented daily zeros", async () => {
    const s = setup(),
      normal = upstream().fake;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/graphql")) {
          started();
          return new Promise<Response>(() => {});
        }
        return normal(input, init);
      }),
    );
    const background: Promise<void>[] = [];
    await resourceUsage(s.env, {
      waitUntil: (p) => {
        background.push(p);
      },
    });
    await began;
    await vi.advanceTimersByTimeAsync(25_001);
    await Promise.all(background);
    const state = s.native.prepare("SELECT * FROM resource_usage_state").get();
    expect(state.lease_until).toBe(0);
    expect(state.anchor).not.toBeNull();
    expect(
      JSON.parse(state.diagnostics_json).find(
        (d: { source: string }) => d.source === "持续采集",
      ),
    ).toMatchObject({ state: "unavailable" });
    expect(
      s.native.prepare("SELECT COUNT(*) n FROM resource_usage_daily").get().n,
    ).toBe(0);
    const result = await resourceUsage(s.env);
    expect(result.collection?.status).toBe("partial");
    expect(result.collection?.retryAt).toBe(at + 30_000);
    expect(value(result, "workers", "requests")).toBeUndefined();
    // Failure retries are permitted after the floor, rather than blocked for an hour.
    vi.setSystemTime(at + 31_000);
    upstream({ requests: 900 });
    await collectResourceUsage(s.env);
    expect(value(await resourceUsage(s.env), "workers", "requests")).toBe(900);
  });
  it("recovers an expired isolate lease without waiting an hour", async () => {
    const s = setup();
    upstream();
    await collectResourceUsage(s.env);
    s.native
      .prepare("UPDATE resource_usage_state SET lease_until=?")
      .run(at + 35_000);
    vi.resetModules();
    const fresh = await import("../src/resource-usage");
    vi.setSystemTime(at + 36_000);
    const api = upstream({ requests: 900 });
    await fresh.collectResourceUsage(s.env);
    expect(api.fake).toHaveBeenCalled();
    expect(value(await fresh.resourceUsage(s.env), "workers", "requests")).toBe(
      900,
    );
    expect(
      s.native.prepare("SELECT lease_until FROM resource_usage_state").get()
        .lease_until,
    ).toBe(0);
  });
  it("replaces an expired in-memory flight even if its original deadline timer has not run", async () => {
    const s = setup();
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        started();
        return new Promise<Response>(() => {});
      }),
    );
    const old = collectResourceUsage(s.env);
    await began;
    // Isolate suspension can advance the clock before its old timer executes.
    vi.setSystemTime(at + 36_000);
    upstream({ requests: 900 });
    await collectResourceUsage(s.env);
    await old;
    expect(value(await resourceUsage(s.env), "workers", "requests")).toBe(900);
    expect(
      s.native
        .prepare("SELECT checked_at,lease_until FROM resource_usage_state")
        .get(),
    ).toMatchObject({
      checked_at: at + 36_000,
      lease_until: 0,
    });
  });
  it("persists today's ledger before slow rolling reads and resumes billing/history from a durable phase after timeout", async () => {
    const s = setup();
    const slow = () => {
      const normal = upstream({ buildPages: 5 }).fake;
      let started!: () => void;
      const began = new Promise<void>((resolve) => {
        started = resolve;
      });
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input),
            query = init?.body
              ? (JSON.parse(String(init.body)).query as string)
              : "";
          calls.push(query || url);
          const delay = url.includes("/builds/workers/")
            ? 5000
            : query.includes('datetime_geq:"2026-10-15T00:00:00.000Z"')
              ? 9000
              : 0;
          if (delay) {
            started();
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
          }
          return normal(input, init);
        }),
      );
      return { began, calls };
    };
    const first = slow();
    const attempt = collectResourceUsage(s.env);
    await first.began;
    await vi.advanceTimersByTimeAsync(25_001);
    await attempt;
    const today = Math.floor(at / 86400_000) * 86400_000;
    expect(
      s.native
        .prepare(
          "SELECT COUNT(*) n FROM resource_usage_daily WHERE source='workers' AND day_start=?",
        )
        .get(today).n,
    ).toBe(1);
    const state = s.native
      .prepare("SELECT diagnostics_json FROM resource_usage_state")
      .get();
    expect(
      JSON.parse(state.diagnostics_json).find(
        (d: { source: string }) => d.source === "持续采集",
      ),
    ).toMatchObject({ state: "unavailable", nextPhase: 1 });
    // Successful sources are saved even when Builds prevents the rolling stage finishing.
    expect(value(await resourceUsage(s.env), "workers", "requests")).toBe(200);
    vi.resetModules();
    const fresh = await import("../src/resource-usage");
    vi.setSystemTime(at + 31_000);
    const second = slow();
    const resumed = fresh.collectResourceUsage(s.env);
    await second.began;
    await vi.advanceTimersByTimeAsync(25_001);
    await resumed;
    const billingCall = second.calls.findIndex((query) =>
      query.includes('datetime_geq:"2026-10-13T00:00:00.000Z"'),
    );
    const buildsCall = second.calls.findIndex((query) =>
      query.includes("/builds/workers/"),
    );
    expect(billingCall).toBeGreaterThan(-1);
    expect(billingCall).toBeLessThan(buildsCall);
    expect(
      s.native
        .prepare(
          "SELECT COUNT(*) n FROM resource_usage_latest WHERE kind='billing' AND source='workers'",
        )
        .get().n,
    ).toBe(1);
    expect(
      s.native
        .prepare(
          "SELECT COUNT(*) n FROM resource_usage_daily WHERE source='workers'",
        )
        .get().n,
    ).toBe(3);
    expect((await fresh.resourceUsage(s.env)).collection?.status).toBe(
      "partial",
    );
  });
  it("fairly rotates all four starting phases across repeated slow attempts instead of starving odd phases", async () => {
    const s = setup(),
      normal = upstream({ buildPages: 1 }).fake;
    let started = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/graphql")) {
          started();
          await new Promise<void>((resolve) => setTimeout(resolve, 9000));
        }
        return normal(input, init);
      }),
    );
    const cursors: number[] = [];
    for (let round = 0; round < 4; round++) {
      vi.setSystemTime(at + round * 31_000);
      const began = new Promise<void>((resolve) => {
        started = resolve;
      });
      const attempt = collectResourceUsage(s.env, { force: true });
      await began;
      await vi.advanceTimersByTimeAsync(25_001);
      await attempt;
      const state = s.native
        .prepare("SELECT diagnostics_json FROM resource_usage_state")
        .get();
      cursors.push(
        JSON.parse(state.diagnostics_json).find(
          (d: { source: string }) => d.source === "持续采集",
        ).nextPhase,
      );
    }
    expect(cursors).toEqual([1, 2, 3, 0]);
    expect(
      s.native
        .prepare(
          "SELECT COUNT(*) n FROM resource_usage_latest WHERE source='workers' AND kind='billing'",
        )
        .get().n,
    ).toBe(1);
    const today = Math.floor(at / 86400_000) * 86400_000;
    const days = s.native
      .prepare(
        "SELECT day_start FROM resource_usage_daily WHERE source='workers' ORDER BY day_start",
      )
      .all()
      .map((row: { day_start: number }) => row.day_start);
    expect(days).toContain(today);
    expect(days).toContain(today - 86400_000);
    expect(days.some((day: number) => day <= today - 2 * 86400_000)).toBe(true);
    expect(s.neverStart).not.toHaveBeenCalled();
  });
  it("rejects a late old batch after timeout and does not clear a newer owner's lease", async () => {
    const s = setup();
    upstream();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const batch = s.env.DB.batch.bind(s.env.DB);
    let first = true;
    s.env.DB.batch = (async (statements: D1PreparedStatement[]) => {
      if (first) {
        first = false;
        started();
        await gate;
      }
      return batch(statements);
    }) as typeof s.env.DB.batch;
    const old = collectResourceUsage(s.env);
    await began;
    const newLease = at + 100_000;
    s.native
      .prepare(
        "UPDATE resource_usage_state SET lease_until=?,checked_at=?,diagnostics_json=?",
      )
      .run(newLease, at + 36_000, '[{"source":"new owner","state":"partial"}]');
    await vi.advanceTimersByTimeAsync(25_001);
    await old;
    expect(
      s.native.prepare("SELECT lease_until FROM resource_usage_state").get()
        .lease_until,
    ).toBe(newLease);
    release();
    // Let the uncooperative DB operation complete after the cancelled task has returned.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      s.native.prepare("SELECT COUNT(*) n FROM resource_usage_latest").get().n,
    ).toBe(0);
    expect(
      s.native.prepare("SELECT COUNT(*) n FROM resource_usage_builds").get().n,
    ).toBe(0);
    expect(
      s.native
        .prepare("SELECT diagnostics_json FROM resource_usage_state")
        .get().diagnostics_json,
    ).toContain("new owner");
  });
  it("bounds this project's complete collection including five Builds pages to 50 external calls", async () => {
    const s = setup(),
      api = upstream({ buildPages: 5 });
    await collectResourceUsage(s.env);
    expect(api.calls).toHaveLength(50);
    expect(s.neverStart).not.toHaveBeenCalled();
  });
  it("upserts fixed days, never adds overlapping rolling 24h totals, and replaces late revisions", async () => {
    const s = setup();
    upstream();
    await collectResourceUsage(s.env);
    const first = s.native
      .prepare(
        "SELECT COUNT(*) n FROM resource_usage_daily WHERE source='workers'",
      )
      .get().n;
    expect(first).toBe(3);
    vi.setSystemTime(at + 31_000);
    upstream({ requests: 350 });
    await collectResourceUsage(s.env, { force: true });
    const rows = s.native
      .prepare(
        "SELECT day_start,result_json FROM resource_usage_daily WHERE source='workers' ORDER BY day_start",
      )
      .all();
    expect(rows.length).toBe(4);
    expect(
      JSON.parse(rows.at(-1).result_json).metrics.find(
        (m: Record<string, unknown>) => m.key === "requests",
      ).value,
    ).toBe(350);
    const all = await resourceUsage(s.env, { range: "all" });
    expect(value(all, "workers", "requests")).toBe(3 * 350 + 200);
    expect(value(await resourceUsage(s.env), "workers", "requests")).toBe(350);
    expect(value(all, "r2", "registeredBytes")).toBe(2110);
    expect(value(all, "r2", "bucketPayload-Standard")).toBe(2200);
    expect(s.neverStart).not.toHaveBeenCalled();
  });
  it("continues collection without page visits and survives a new isolate and log cleanup", async () => {
    const s = setup(),
      api = upstream();
    await collectResourceUsage(s.env);
    const n = api.fake.mock.calls.length;
    s.native.exec("DELETE FROM logs");
    vi.resetModules();
    const fresh = await import("../src/resource-usage");
    const result = await fresh.resourceUsage(s.env, { range: "all" });
    expect(value(result, "workers", "requests")).toBe(600);
    expect(value(result, "logs", "applicationLogs")).toBe(0);
    expect(api.fake.mock.calls.length).toBe(n);
    expect(result.collection?.coverageStart).toBe(
      Math.floor(at / 86400_000) * 86400_000 - 2 * 86400_000,
    );
  });
  it("uses the actual midmonth subscription anchor, clamps month ends and rejects stale prior-cycle values", async () => {
    const s = setup();
    const api = upstream({ anchor: "2024-01-31T04:05:06Z" });
    await collectResourceUsage(s.env);
    const result = await resourceUsage(s.env, { range: "billing" });
    expect(result.period.start).toBe("2026-09-30T04:05:06.000Z");
    expect(
      api.calls.some((call) =>
        call.query?.includes('datetime_geq:"2026-09-30T04:05:06.000Z"'),
      ),
    ).toBe(true);
    expect(value(result, "workers", "requests")).toBe(200);
    vi.setSystemTime(Date.parse("2026-10-31T04:05:07Z"));
    upstream({
      fail: new Set(["workersInvocationsAdaptive"]),
      anchor: "2024-01-31T04:05:06Z",
    });
    const next = await resourceUsage(s.env, {
      range: "billing",
      refresh: true,
    });
    expect(next.period.start).toBe("2026-10-31T04:05:06.000Z");
    expect(value(next, "workers", "requests")).toBeUndefined();
    expect(
      card(next, "workers").diagnostics.some((d) =>
        d.note.includes("另一账期"),
      ),
    ).toBe(true);
  });
  it("rechecks a transiently unavailable billing anchor after the retry floor instead of caching unknown for a day", async () => {
    const s = setup(),
      normal = upstream().fake;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes("billable-usage/info")
          ? Promise.resolve(
              Response.json(
                { success: false, errors: [{ code: 10000 }] },
                { status: 503 },
              ),
            )
          : normal(input, init),
      ),
    );
    await collectResourceUsage(s.env);
    expect(
      s.native.prepare("SELECT anchor FROM resource_usage_state").get().anchor,
    ).toBeNull();
    vi.setSystemTime(at + 31_000);
    const retry = upstream();
    await collectResourceUsage(s.env, { force: true });
    expect(
      retry.calls.some((call) => call.url.includes("billable-usage/info")),
    ).toBe(true);
    expect(
      s.native.prepare("SELECT anchor FROM resource_usage_state").get().anchor,
    ).toBe("2024-07-13T00:00:00Z");
    expect(
      value(
        await resourceUsage(s.env, { range: "billing" }),
        "workers",
        "requests",
      ),
    ).toBe(200);
  });
  it("leaves an unconfirmed billing period unknown and exposes actual range gaps instead of invented zeros", async () => {
    const s = setup();
    upstream({ anchor: null });
    await collectResourceUsage(s.env);
    const billing = await resourceUsage(s.env, { range: "billing" });
    expect(billing.period.label).toContain("暂未确认");
    expect(value(billing, "workers", "requests")).toBeUndefined();
    const missingDay = Math.floor(at / 86400_000) * 86400_000 - 86400_000;
    s.native
      .prepare(
        "DELETE FROM resource_usage_daily WHERE source='workers' AND day_start=?",
      )
      .run(missingDay);
    const all = await resourceUsage(s.env, { range: "all" });
    expect(value(all, "workers", "requests")).toBe(400);
    expect(
      card(all, "workers").metrics.find((m) => m.key === "requests")?.note,
    ).toContain("24.0 小时");
    expect(
      card(all, "workers").diagnostics.some((d) => d.state === "partial"),
    ).toBe(true);
  });
  it("preserves fixed-window last-good totals on API failures and keeps test and production ledgers separate", async () => {
    const s = setup();
    upstream();
    await collectResourceUsage(s.env);
    vi.setSystemTime(at + 31_000);
    upstream({ fail: new Set(["workersInvocationsAdaptive"]) });
    await collectResourceUsage(s.env, { force: true });
    const all = await resourceUsage(s.env, { range: "all" });
    expect(value(all, "workers", "requests")).toBe(600);
    upstream({ requests: 900 });
    const prod = await resourceUsage(
      {
        ...s.env,
        APP_ENV: "production",
        RESOURCE_WORKER_NAME: "fixture-production",
      },
      { range: "all" },
    );
    expect(value(prod, "workers", "requests")).toBe(2700);
    expect(
      value(
        await resourceUsage(s.env, { range: "all" }),
        "workers",
        "requests",
      ),
    ).toBe(600);
  });
  it("deduplicates paginated build IDs rather than summing repeated list snapshots", async () => {
    const s = setup();
    upstream();
    await collectResourceUsage(s.env);
    vi.setSystemTime(at + 31_000);
    await collectResourceUsage(s.env, { force: true });
    expect(
      s.native.prepare("SELECT COUNT(*) n FROM resource_usage_builds").get().n,
    ).toBe(2);
    expect(
      value(
        await resourceUsage(s.env, { range: "all" }),
        "builds",
        "buildCount",
      ),
    ).toBe(2);
    expect(
      value(
        await resourceUsage(s.env, { range: "all" }),
        "builds",
        "buildWallSeconds",
      ),
    ).toBe(150);
  });
  it("retains partially missing fields with their own original coverage instead of reporting zero", async () => {
    const s = setup();
    upstream();
    await collectResourceUsage(s.env);
    vi.setSystemTime(at + 3600_000);
    upstream({ omitCpu: true });
    const recent = await resourceUsage(s.env, { refresh: true });
    expect(value(recent, "workers", "cpuTimeUs")).toBe(2000);
    expect(
      card(recent, "workers").metrics.find((m) => m.key === "cpuTimeUs")
        ?.observedAt,
    ).toBe(at);
    const all = await resourceUsage(s.env, { range: "all" });
    expect(value(all, "workers", "cpuTimeUs")).toBe(6000);
    expect(
      card(all, "workers").metrics.find((m) => m.key === "cpuTimeUs")?.note,
    ).toContain("1.0 小时");
    expect(
      card(all, "workers").metrics.find((m) => m.key === "requests")?.note,
    ).toContain("0.0 小时");
  });
  it("does not extrapolate a previously known cycle after an authoritative catalog loses a unique cycle", async () => {
    const s = setup();
    upstream();
    await collectResourceUsage(s.env);
    vi.setSystemTime(at + 86400_000 + 1);
    upstream({ anchor: null });
    const result = await resourceUsage(s.env, {
      refresh: true,
      range: "billing",
    });
    expect(result.period.label).toContain("暂未确认");
    expect(value(result, "workers", "requests")).toBeUndefined();
  });
  it("splits memory, disk and CPU capacity time across exact range boundaries without defaulting absent fields", () => {
    const split = Date.parse("2026-10-15T00:00:00Z");
    const entry = {
      started_at: split - 3600_000,
      ended_at: split + 3600_000,
      consumption_json: JSON.stringify({
        wallSeconds: 7200,
        cpuVcpuSecondsUpper: 28800,
        memoryGibSecondsUpper: 57600,
        diskGbSecondsUpper: 144000,
      }),
    };
    const left = allocateTaskConsumption(entry, split - 86400_000, split),
      right = allocateTaskConsumption(entry, split, split + 86400_000);
    expect(left).toEqual({
      wallSeconds: 3600,
      cpuVcpuSecondsUpper: 14400,
      memoryGibSecondsUpper: 28800,
      diskGbSecondsUpper: 72000,
    });
    expect(right).toEqual(left);
    expect(left.memoryGibSecondsUpper + right.memoryGibSecondsUpper).toBe(
      57600,
    );
    expect(
      allocateTaskConsumption(
        {
          ...entry,
          consumption_json: '{"wallSeconds":7200,"memoryGibSecondsUpper":null}',
        },
        split,
        split + 86400_000,
      ),
    ).toEqual({ wallSeconds: 3600 });
  });
  it("retains reliable stopped-task memory and disk after detailed task removal and prefers official values", async () => {
    const s = setup();
    s.native
      .exec(`INSERT INTO versions(id,video_id,prefix,state,mode,quality,timeline_id,created_at) VALUES('version','fixture','output','failed','faststart','source','timeline',${at});
      INSERT INTO quotes(id,video_id,source_revision,source_etag,mode,quality,period_start,expires_at,data_json,created_at) VALUES('quote','fixture','r','e','faststart','source','2026-10-01',${at + 1000},'{}',${at});
      INSERT INTO jobs(id,video_id,version_id,quote_id,state,stage,started_at,finished_at,stop_verified,consumption_json,created_at,updated_at) VALUES('job','fixture','version','quote','failed','failed',${at - 10000},${at},1,'{"wallSeconds":10,"cpuVcpuSecondsUpper":40,"memoryGibSecondsUpper":80,"diskGbSecondsUpper":200}',${at - 10000},${at});`);
    upstream();
    await collectResourceUsage(s.env);
    const estimated = await resourceUsage(s.env);
    expect(value(estimated, "containers", "memoryUpper")).toBe(80);
    expect(value(estimated, "containers", "diskUpper")).toBe(200);
    expect(
      card(estimated, "containers").metrics.find((m) => m.key === "memoryUpper")
        ?.unit,
    ).toBe("gib-seconds");
    expect(
      card(estimated, "containers").metrics.find((m) => m.key === "diskUpper")
        ?.unit,
    ).toBe("gb-seconds");
    s.native.exec("DELETE FROM jobs");
    expect(
      value(
        await resourceUsage(s.env, { range: "all" }),
        "containers",
        "memoryUpper",
      ),
    ).toBe(80);
    vi.setSystemTime(at + 31_000);
    upstream({
      containers: {
        cpuTimeSec: 3,
        allocatedMemory: 1024 ** 3 * 5,
        allocatedDisk: 1e9 * 7,
        txBytes: 9,
      },
    });
    const official = await resourceUsage(s.env, { refresh: true });
    expect(value(official, "containers", "allocatedMemory")).toBe(5);
    expect(value(official, "containers", "allocatedDisk")).toBe(7);
    expect(value(official, "containers", "memoryUpper")).toBeUndefined();
    expect(value(official, "containers", "diskUpper")).toBeUndefined();
  });
});

describe("resource-accounting correction safety", () => {
  it("does not replace a full successful counter window with a capped response, nor publish a first capped total", async () => {
    const s = setup();
    upstream();
    await collectResourceUsage(s.env);
    vi.setSystemTime(at + 31000);
    upstream({ capped: true });
    const kept = await resourceUsage(s.env, { refresh: true });
    expect(value(kept, "workers", "requests")).toBe(200);
    expect(
      card(kept, "workers").metrics.find((m) => m.key === "requests")?.note,
    ).toContain("统计范围");
    expect(
      card(kept, "workers").diagnostics.some((d) => d.state === "partial"),
    ).toBe(true);
    expect(
      value(
        await resourceUsage(s.env, { range: "all" }),
        "workers",
        "requests",
      ),
    ).toBe(600);
    const fresh = await resourceUsage({
      ...s.env,
      APP_ENV: "production",
      RESOURCE_WORKER_NAME: "fixture-production",
    });
    expect(value(fresh, "workers", "requests")).toBeUndefined();
  });
  it("does not load the entire historical JSON ledger for near-24h or billing dashboard reads", async () => {
    const s = setup();
    upstream();
    await collectResourceUsage(s.env);
    s.statements.length = 0;
    await resourceUsage(s.env);
    expect(
      s.statements.some((sql: string) =>
        sql.startsWith("SELECT source,day_start,covered_end,result_json"),
      ),
    ).toBe(false);
    await resourceUsage(s.env, { range: "billing" });
    const dailyReads = s.statements.filter((sql: string) =>
      sql.startsWith("SELECT source,day_start,covered_end,result_json"),
    );
    expect(dailyReads).toHaveLength(1);
    expect(dailyReads[0]).toContain(
      "WHERE scope=? AND day_start>=? AND day_start<?",
    );
    const plan = s.native
      .prepare(`EXPLAIN QUERY PLAN ${dailyReads[0]}`)
      .all("scope-fixture", Date.parse("2026-10-13T00:00:00Z"), at);
    expect(
      plan.some((row: { detail: string }) =>
        row.detail.includes(
          "USING INDEX resource_usage_daily_time (scope=? AND day_start>? AND day_start<?)",
        ),
      ),
    ).toBe(true);
    expect(
      s.statements.some((sql: string) =>
        sql.includes(
          "FROM resource_usage_jobs WHERE scope=? AND ended_at>=? AND started_at<?",
        ),
      ),
    ).toBe(true);
    expect(
      s.statements.some((sql: string) =>
        sql.includes(
          "FROM resource_usage_builds WHERE scope=? AND started_at>=? AND started_at<?",
        ),
      ),
    ).toBe(true);
  });
  it("avoids permanent task coverage scans for short ranges while preserving cumulative coverage and daily collection metadata", async () => {
    const s = setup();
    upstream();
    await collectResourceUsage(s.env);
    const scope = s.native
      .prepare("SELECT scope FROM resource_usage_state")
      .get().scope;
    const old = at - 400 * 86400_000;
    s.native
      .prepare(
        "INSERT INTO resource_usage_jobs(scope,job_id,started_at,ended_at,consumption_json,observed_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        scope,
        "historical-retained-task",
        old,
        old + 60_000,
        '{"wallSeconds":60}',
        at,
      );
    s.native
      .prepare(
        "INSERT INTO resource_usage_jobs(scope,job_id,started_at,ended_at,consumption_json,observed_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        scope,
        "older-invalidated-task",
        old - 86400_000,
        old,
        '{"wallSeconds":86400,"reliability":"invalidated"}',
        at,
      );
    s.statements.length = 0;
    for (const range of ["24h", "billing"] as const) {
      const result = await resourceUsage(s.env, { range });
      expect(result.period.start).toBe(
        new Date(
          range === "24h" ? at - 86400_000 : Date.parse("2026-10-13T00:00:00Z"),
        ).toISOString(),
      );
      expect(result.collection?.coverageStart).toBe(
        Date.parse("2026-10-13T00:00:00Z"),
      );
    }
    expect(s.statements.some((sql) => sql.includes("MIN(started_at)"))).toBe(
      false,
    );
    const taskReads = s.statements.filter((sql) =>
      sql.includes("FROM resource_usage_jobs"),
    );
    expect(taskReads).toHaveLength(2);
    for (const sql of taskReads) {
      expect(sql).toContain("WHERE scope=? AND ended_at>=? AND started_at<?");
      const plan = s.native
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(scope, Date.parse("2026-10-13T00:00:00Z"), at);
      expect(
        plan.some((row: { detail: string }) =>
          row.detail.includes(
            "USING INDEX resource_usage_jobs_time (scope=? AND ended_at>?)",
          ),
        ),
      ).toBe(true);
    }
    const dailyMinimum = s.statements.find((sql) =>
      sql.includes("MIN(day_start)"),
    )!;
    const dayPlan = s.native
      .prepare(`EXPLAIN QUERY PLAN ${dailyMinimum}`)
      .all(scope);
    expect(
      dayPlan.some((row: { detail: string }) =>
        row.detail.includes(
          "USING COVERING INDEX resource_usage_daily_time (scope=?)",
        ),
      ),
    ).toBe(true);
    s.statements.length = 0;
    const cumulative = await resourceUsage(s.env, { range: "all" });
    expect(cumulative.period.start).toBe(new Date(old).toISOString());
    expect(cumulative.collection?.coverageStart).toBe(
      Date.parse("2026-10-13T00:00:00Z"),
    );
    expect(value(cumulative, "containers", "wallSeconds")).toBe(60);
    expect(
      s.statements.some((sql) =>
        sql.includes("MIN(started_at) FROM resource_usage_jobs"),
      ),
    ).toBe(true);
  });
  it.each(["stop", "ownership", "missing duration"])(
    "withdraws a previously retained estimate after a %s correction without erasing historical values",
    async (change) => {
      const s = setup();
      s.native
        .exec(`INSERT INTO versions(id,video_id,prefix,state,mode,quality,timeline_id,created_at) VALUES('version','fixture','output','failed','faststart','source','timeline',${at});
      INSERT INTO quotes(id,video_id,source_revision,source_etag,mode,quality,period_start,expires_at,data_json,created_at) VALUES('quote','fixture','r','e','faststart','source','2026-10-01',${at + 1000},'{}',${at});
      INSERT INTO jobs(id,video_id,version_id,quote_id,state,stage,started_at,finished_at,stop_verified,consumption_json,created_at,updated_at) VALUES('job','fixture','version','quote','failed','failed',${at - 10000},${at},1,'{"wallSeconds":10,"memoryGibSecondsUpper":80}',${at - 10000},${at});`);
      upstream();
      await collectResourceUsage(s.env);
      expect(
        value(await resourceUsage(s.env), "containers", "memoryUpper"),
      ).toBe(80);
      vi.setSystemTime(at + 31000);
      if (change === "stop")
        s.native
          .prepare(
            "UPDATE jobs SET stop_verified=0,updated_at=? WHERE id='job'",
          )
          .run(at + 31000);
      else
        s.native
          .prepare(
            "UPDATE jobs SET consumption_json=?,updated_at=? WHERE id='job'",
          )
          .run(
            change === "ownership"
              ? '{"wallSeconds":10,"memoryGibSecondsUpper":80,"unattributedContainerObserved":true}'
              : '{"memoryGibSecondsUpper":80}',
            at + 31000,
          );
      await collectResourceUsage(s.env, { force: true });
      expect(
        value(await resourceUsage(s.env), "containers", "memoryUpper"),
      ).toBeUndefined();
      expect(
        value(
          await resourceUsage(s.env, { range: "all" }),
          "containers",
          "memoryUpper",
        ),
      ).toBeUndefined();
      const saved = JSON.parse(
        s.native
          .prepare(
            "SELECT consumption_json FROM resource_usage_jobs WHERE job_id='job'",
          )
          .get().consumption_json,
      );
      expect(saved).toMatchObject({
        memoryGibSecondsUpper: 80,
        reliability: "invalidated",
      });
    },
  );
});
