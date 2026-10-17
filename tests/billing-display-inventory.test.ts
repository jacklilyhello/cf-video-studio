import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUsage,
  INSTANCES,
  processingResourceAmounts,
  quoteProcessing,
  validateQuoteBudget,
  type UsageSnapshot,
} from "../src/billing";

import type { Env, Quote, Video } from "../src/types";
const { DatabaseSync } = await import("node:sqlite" as string);
const { readFileSync, readdirSync } = await import("node:fs" as string);
const at = Date.parse("2026-10-15T08:00:00Z"),
  account = "a".repeat(32);
const databases: { close(): void }[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
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
  for (const name of readdirSync(directory)
    .filter((name: string) => name.endsWith(".sql"))
    .sort())
    native.exec(readFileSync(new URL(name, directory), "utf8"));
  native
    .prepare(
      "INSERT INTO videos(id,title,source_key,source_size,source_etag,source_revision,source_name,status,created_at,updated_at) VALUES('video','Offline billing fixture','videos/video/source/revision',1024,'source-etag','revision','fixture.mp4','unprocessed',?,?)",
    )
    .run(at, at);
  native
    .prepare(
      "INSERT INTO objects(key,video_id,category,bytes,etag,state,updated_at) VALUES('videos/video/source/revision','video','source',1024,'source-etag','present',?)",
    )
    .run(at);
  native
    .prepare("UPDATE settings SET value='60' WHERE key='task_timeout_seconds'")
    .run();
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
          return {
            success: true,
            meta: { changes: Number(prepared.run(...values).changes) },
          };
        },
      };
      return statement;
    },
  };
  const env = {
    DB: db,
    MEDIA: {
      head: vi.fn(async () => ({ size: 1024, etag: "source-etag" })),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    },
    APP_ENV: "test",
    PROCESSING_ENABLED: "false",
    CLOUDFLARE_ACCOUNT_ID: account,
    CF_USAGE_API_TOKEN: "offline-readonly-fixture",
  } as unknown as Env;
  return {
    native,
    env,
    video: native
      .prepare("SELECT * FROM videos WHERE id='video'")
      .get() as Video,
  };
}
type FixtureOptions = {
  noPeriod?: boolean;
  failGraph?: boolean;
  d1?: (page: number) => object;
  r2?: (cursor: string | null) => object;
  r2Scopes?: (jurisdiction: string, cursor: string | null) => object | Response;
  namespaces?: object;
  graph?: Record<string, unknown[]>;
};
function cloud(options: FixtureOptions = {}) {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/billable-usage/info"))
      return Response.json(
        options.noPeriod
          ? { success: false }
          : {
              success: true,
              result: {
                covered: true,
                subscriptions: [
                  { billing_cycle_anchor_timestamp: "2024-07-13T00:00:00Z" },
                ],
              },
            },
      );
    if (url.pathname.endsWith("/billable-usage"))
      return Response.json({ success: true, result: [] });
    if (url.pathname.endsWith("/subscriptions"))
      return Response.json({
        success: true,
        result: [
          { state: "Paid", rate_plan: { id: "workers_paid" } },
          { state: "Paid", rate_plan: { id: "r2_paid" } },
        ],
      });
    if (url.pathname.endsWith("/r2/buckets")) {
      const jurisdiction =
          new Headers(init?.headers).get("cf-r2-jurisdiction") || "missing",
        response =
          options.r2Scopes?.(jurisdiction, url.searchParams.get("cursor")) ??
          (jurisdiction !== "default"
            ? { success: true, result: { buckets: [] } }
            : (options.r2?.(url.searchParams.get("cursor")) ?? {
                success: true,
                result: {
                  buckets: [
                    {
                      name: "fixture-bucket",
                      creation_date: "2026-10-14T00:00:00Z",
                    },
                  ],
                },
              }));
      return response instanceof Response ? response : Response.json(response);
    }
    if (url.pathname.endsWith("/d1/database"))
      return Response.json(
        options.d1?.(Number(url.searchParams.get("page"))) ?? {
          success: true,
          result: [{ uuid: "fixture-db" }],
          result_info: { page: 1, per_page: 1000, count: 1, total_count: 1 },
        },
      );
    if (url.pathname.endsWith("/workers/durable_objects/namespaces"))
      return Response.json(
        options.namespaces ?? {
          success: true,
          result: [{ id: "fixture-namespace" }, { id: "missing-namespace" }],
          result_info: { page: 1, per_page: 1000, count: 2, total_count: 2 },
        },
      );
    if (url.pathname.endsWith("/r2/metrics"))
      return Response.json({
        success: true,
        result: {
          standard: {
            published: { payloadSize: 1000, metadataSize: 10 },
            uploaded: { payloadSize: 0, metadataSize: 0 },
          },
          infrequentAccess: {
            published: { payloadSize: 0, metadataSize: 0 },
            uploaded: { payloadSize: 0, metadataSize: 0 },
          },
        },
      });
    if (url.pathname.endsWith("/containers/me"))
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
    if (url.pathname === "/client/v4/graphql") {
      if (options.failGraph)
        return Response.json(
          { errors: [{ message: "private-provider-body-must-not-escape" }] },
          { status: 502 },
        );
      const query = JSON.parse(String(init?.body)).query as string;
      const node = query.match(/\{(\w+)\(limit:/)?.[1] ?? "settings";
      const defaults: Record<string, unknown[]> = {
        workersInvocationsAdaptive: [
          { sum: { requests: 37, cpuTimeUs: 1000000 } },
        ],
        durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 13 } }],
        durableObjectsPeriodicGroups: [
          {
            sum: {
              duration: 2,
              rowsRead: 11,
              rowsWritten: 7,
              inboundWebsocketMsgCount: 0,
            },
          },
        ],
        d1StorageAdaptiveGroups: [
          {
            dimensions: { databaseId: "fixture-db", date: "2026-10-15" },
            max: { databaseSizeBytes: 4096 },
          },
        ],
        durableObjectsSqlStorageGroups: [
          {
            dimensions: {
              namespaceId: "fixture-namespace",
              date: "2026-10-15",
            },
            max: { storedBytes: 8192 },
          },
        ],
        r2StorageAdaptiveGroups: [
          {
            dimensions: {
              bucketName: "fixture-bucket",
              storageClass: "Standard",
              datetime: "2026-10-15T07:55:00Z",
              date: "2026-10-15",
            },
            max: {
              payloadSize: 1000,
              metadataSize: 10,
              objectCount: 1,
              uploadCount: 2,
            },
          },
        ],
      };
      return Response.json({
        data: {
          viewer: {
            accounts: [
              { [node]: options.graph?.[node] ?? defaults[node] ?? [] },
            ],
          },
        },
      });
    }
    throw new Error("Unexpected product endpoint");
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const amounts = () =>
  processingResourceAmounts(INSTANCES[0], {
    mode: "faststart",
    maxOutputBytes: 2048,
    maxMediaObjects: 1,
    totalTimeoutSeconds: 60,
  });
describe("display observations are independent from trusted admission", () => {
  it("shows Workers/DO observations despite missing processing metrics and reports empty Containers as unknown", async () => {
    cloud();
    const f = setup(),
      snapshot = await getUsage(f.env);
    expect(
      snapshot.resources.find((r) => r.key === "workersRequests")?.display,
    ).toMatchObject({
      value: 37,
      status: "ok-data",
      basis: "analytics-estimate",
      stale: false,
    });
    expect(
      snapshot.resources.find((r) => r.key === "workersCpuMilliseconds")
        ?.display?.value,
    ).toBe(1000);
    expect(
      snapshot.resources.find((r) => r.key === "doRequests")?.display?.value,
    ).toBe(13);
    expect(
      snapshot.resources.find((r) => r.key === "containerCpuSeconds"),
    ).toMatchObject({
      officialRecorded: null,
      unbilledEstimate: null,
      budgetUsable: false,
      display: { value: null, status: "ok-empty", admissionUnconfirmed: true },
    });
    expect(snapshot.processingAllowed).toBe(false);
  });
  it("queries a clearly labelled 24h display interval when subscription period discovery fails", async () => {
    const fetcher = cloud({ noPeriod: true });
    const snapshot = await getUsage(setup().env);
    expect(snapshot.periodStart).toBeNull();
    expect(
      snapshot.resources.find((r) => r.key === "workersRequests")?.display,
    ).toMatchObject({ value: 37, periodStart: "2026-10-14T08:00:00.000Z" });
    expect(
      fetcher.mock.calls.some(([, init]) =>
        String(init?.body).includes("workersInvocationsAdaptive"),
      ),
    ).toBe(true);
    expect(snapshot.storageAllowed).toBe(false);
    expect(snapshot.processingAllowed).toBe(false);
  });
  it("retains last successful values in actual SQLite without borrowing their automatic allowance", async () => {
    const f = setup();
    cloud();
    await getUsage(f.env);
    vi.setSystemTime(at + 60000);
    cloud({ failGraph: true });
    const snapshot = await getUsage(f.env),
      worker = snapshot.resources.find((r) => r.key === "workersRequests")!;
    expect(worker.display).toMatchObject({
      value: 37,
      basis: "last-good",
      stale: true,
      fetchedAt: at,
      status: "temporary-failure",
    });
    expect(worker.unbilledEstimate).toBeNull();
    expect(worker.budgetUsable).toBe(false);
    expect(worker.remaining).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain("private-provider-body");
  });
  it("does not automatically retry restricted Billing V2 or fabricate a fresh HTTP failure", async () => {
    const fetcher = cloud();
    const snapshot = await getUsage(setup().env);
    expect(
      fetcher.mock.calls.some(([url]) => url.endsWith("/billable/usage")),
    ).toBe(false);
    expect(
      snapshot.sources.find((source) => source.name.startsWith("Billing V2")),
    ).toMatchObject({
      automatic: false,
      displayStatus: "automatic-unavailable",
      httpStatus: null,
      errorCodes: [],
    });
    expect(
      snapshot.sources.find((source) => source.name.startsWith("Billing V2")),
    ).not.toHaveProperty("fetchedAt");
  });
});
describe("bounded account inventories and current statistics", () => {
  it("matches D1 current inventory to storage observations without declaring historical storage admission complete", async () => {
    cloud();
    const snapshot = await getUsage(setup().env);
    expect(
      snapshot.inventories?.find((item) => item.product === "d1"),
    ).toMatchObject({
      complete: true,
      listed: 1,
      matched: 1,
      missing: 0,
      currentBytes: 4096,
    });
    expect(
      snapshot.resources.find((r) => r.key === "d1StorageGbMonths")
        ?.budgetUsable,
    ).toBe(false);
    expect(
      snapshot.inventories?.find((item) => item.product === "do"),
    ).toMatchObject({
      complete: true,
      listed: 2,
      matched: 1,
      missing: 1,
      currentBytes: 8192,
      status: "delayed-incomplete",
    });
  });
  it("fetches a second D1 page and rejects neither its matching resource nor the existing observations", async () => {
    const fetcher = cloud({
      d1: (page) => ({
        success: true,
        result:
          page === 1
            ? Array.from({ length: 1000 }, (_, i) => ({ uuid: `db-${i}` }))
            : [{ uuid: "fixture-db" }],
        result_info: {
          page,
          per_page: 1000,
          count: page === 1 ? 1000 : 1,
          total_count: 1001,
        },
      }),
    });
    const snapshot = await getUsage(setup().env);
    expect(
      snapshot.inventories?.find((item) => item.product === "d1"),
    ).toMatchObject({
      complete: true,
      listed: 1001,
      pages: 2,
      matched: 1,
      missing: 1000,
    });
    expect(
      fetcher.mock.calls.filter(([url]) => url.includes("/d1/database?"))
        .length,
    ).toBe(2);
  });
  it.each([
    undefined,
    { page: 1, per_page: 1000, total_count: 2 },
    { page: 2, per_page: 1000, total_count: 1 },
  ])(
    "keeps malformed or missing D1 pagination metadata incomplete",
    async (metadata) => {
      cloud({
        d1: () => ({
          success: true,
          result: [{ uuid: "fixture-db" }],
          result_info: metadata,
        }),
      });
      expect(
        (await getUsage(setup().env)).inventories?.find(
          (item) => item.product === "d1",
        )?.complete,
      ).toBe(false);
    },
  );
  it("follows R2 cursors and exposes explicit multipart/class data, without zeroing a new bucket missing from analytics", async () => {
    const fetcher = cloud({
      r2: (cursor) =>
        cursor
          ? {
              success: true,
              result: {
                buckets: [
                  { name: "new-bucket", creation_date: "2026-10-15T07:00:00Z" },
                ],
              },
            }
          : {
              success: true,
              result: { buckets: [{ name: "fixture-bucket" }] },
              result_info: { cursor: "opaque-next-cursor" },
            },
    });
    const snapshot = await getUsage(setup().env),
      inventory = snapshot.inventories?.find((item) => item.product === "r2");
    expect(inventory).toMatchObject({
      complete: true,
      pages: 6,
      listed: 2,
      matched: 1,
      missing: 1,
      newlyCreated: 1,
      emptyConfirmed: 0,
      pendingMultipartUploads: 2,
      status: "delayed-incomplete",
    });
    expect(inventory?.classes?.[1]).toMatchObject({
      name: "InfrequentAccess",
      publishedBytes: 0,
      uploadedBytes: 0,
    });
    expect(
      fetcher.mock.calls.some(([url]) =>
        url.includes("cursor=opaque-next-cursor"),
      ),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("opaque-next-cursor");
  });
  it.each([
    {
      scenario: "nonempty Standard with empty IA",
      standardBytes: 1024,
      includeIa: true,
      expected: 0,
    },
    {
      scenario: "both classes empty, excluding an unlisted bucket",
      standardBytes: 0,
      includeIa: true,
      expected: 1,
    },
    {
      scenario: "only Standard observed empty",
      standardBytes: 0,
      includeIa: false,
      expected: 0,
    },
  ])(
    "counts empty R2 buckets once: $scenario",
    async ({ standardBytes, includeIa, expected }) => {
      const row = (
        bucketName: string,
        storageClass: string,
        payloadSize = 0,
      ) => ({
        dimensions: {
          bucketName,
          storageClass,
          datetime: "2026-10-15T07:55:00Z",
          date: "2026-10-15",
        },
        max: {
          payloadSize,
          metadataSize: 0,
          objectCount: payloadSize ? 1 : 0,
          uploadCount: 0,
        },
      });
      cloud({
        graph: {
          r2StorageAdaptiveGroups: [
            row("fixture-bucket", "Standard", standardBytes),
            ...(includeIa ? [row("fixture-bucket", "InfrequentAccess")] : []),
            row("unlisted-bucket", "Standard"),
            row("unlisted-bucket", "InfrequentAccess"),
          ],
        },
      });
      const snapshot = await getUsage(setup().env);
      expect(
        snapshot.inventories?.find((item) => item.product === "r2"),
      ).toMatchObject({
        listed: 1,
        emptyConfirmed: expected,
        unmatchedObserved: 1,
      });
      expect(snapshot.processingAllowed).toBe(false);
    },
  );
  it.each(["same-cursor", "duplicate-row"])(
    "fails closed on repeated R2 pagination %s",
    async (mode) => {
      cloud({
        r2: (cursor) => ({
          success: true,
          result: {
            buckets: [
              {
                name:
                  cursor && mode === "same-cursor"
                    ? "second-bucket"
                    : "fixture-bucket",
              },
            ],
          },
          result_info: { cursor: "repeat" },
        }),
      });
      const snapshot = await getUsage(setup().env);
      expect(
        snapshot.inventories?.find((item) => item.product === "r2")?.complete,
      ).toBe(false);
      expect(snapshot.processingAllowed).toBe(false);
    },
  );
  it("limits cursor pagination to ten requests and preserves a bounded partial census", async () => {
    let page = 0;
    const fetcher = cloud({
      r2: () => ({
        success: true,
        result: { buckets: [{ name: `bucket-${++page}` }] },
        result_info: { cursor: `cursor-${page}` },
      }),
    });
    const snapshot = await getUsage(setup().env);
    expect(
      snapshot.inventories?.find((item) => item.product === "r2"),
    ).toMatchObject({ complete: false, pages: 14, listed: 10 });
    expect(
      fetcher.mock.calls.filter(([url]) => url.includes("/r2/buckets?")).length,
    ).toBe(14);
  });
});
describe("quote estimates do not require manual evidence", () => {
  it("returns a scoped estimate without claiming execution permission or creating a job", async () => {
    cloud();
    const f = setup();
    const draft = await quoteProcessing(f.env, f.video, {
      mode: "faststart",
      quality: "source",
    });
    expect(draft.executionAllowed).toBe(false);
    expect(draft.executionBlockers.length).toBeGreaterThan(0);
    expect(draft.feePolicy).toBe("verified-included-only");
    expect(draft.executionNextStep).toContain("这一个任务");
    expect(draft.executionNextStep).toContain("无需手工抄录");
    expect(draft.estimatedSeconds).toBeNull();
    expect(draft.costUpperUsd).toBeGreaterThan(0);
    expect(draft.costBreakdown).toBeDefined();
    const componentSum = draft.costBreakdown!.reduce(
      (sum, line) => sum + line.upperUsd,
      0,
    );
    expect(Math.ceil(componentSum * 10000) / 10000).toBe(draft.costUpperUsd);
    expect(draft).not.toHaveProperty("manualEvidenceIds");
    expect(draft).not.toHaveProperty("manualBudget");
    const q = {
      id: "quote",
      video_id: "video",
      source_revision: "revision",
      source_etag: "source-etag",
      mode: "faststart",
      quality: "source",
      period_start: draft.periodStart,
      expires_at: draft.expiresAt,
      state: "open",
      data_json: JSON.stringify(draft),
    } as Quote;
    await expect(validateQuoteBudget(f.env, q)).rejects.toMatchObject({
      code: "quote_requires_review",
    });
    expect(f.native.prepare("SELECT COUNT(*) AS n FROM jobs").get().n).toBe(0);
  });
  it("requires explicit regeneration for an old manual quote before any API call", async () => {
    const f = setup(),
      fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const q = {
      state: "open",
      expires_at: at + 60000,
      data_json: JSON.stringify({ manualEvidenceIds: ["old"] }),
    } as Quote;
    await expect(validateQuoteBudget(f.env, q)).rejects.toMatchObject({
      code: "quote_changed",
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      quoteProcessing(f.env, f.video, {
        mode: "faststart",
        quality: "source",
        manualEvidenceIds: ["old"],
      }),
    ).rejects.toMatchObject({ code: "quote_changed" });
  });
});
describe("R2 jurisdiction and class scope boundaries", () => {
  const bucketResponse = (buckets: object[], cursor?: string) => ({
    success: true,
    result: { buckets },
    ...(cursor ? { result_info: { cursor } } : {}),
  });
  const storageRow = (bucketName: string, payloadSize: number) => ({
    dimensions: {
      bucketName,
      storageClass: "Standard",
      datetime: "2026-10-15T07:55:00Z",
      date: "2026-10-15",
    },
    max: { payloadSize, metadataSize: 0, objectCount: 1, uploadCount: 0 },
  });
  const deniedScope = (jurisdiction: string) =>
    jurisdiction === "fedramp"
      ? Response.json(
          { success: false, errors: [{ code: 10003 }] },
          { status: 403 },
        )
      : jurisdiction === "fedramp-high"
        ? new Response("private-provider-error", { status: 400 })
        : bucketResponse(
            jurisdiction === "default" ? [{ name: "fixture-bucket" }] : [],
          );
  it("keeps same-named default and EU buckets distinct and matches only documented GraphQL canonical names", async () => {
    const fetcher = cloud({
      r2Scopes: (jurisdiction) =>
        bucketResponse(
          ["default", "eu"].includes(jurisdiction)
            ? [{ name: "fixture-bucket", jurisdiction }]
            : [],
        ),
      graph: {
        r2StorageAdaptiveGroups: [
          storageRow("fixture-bucket", 1024),
          storageRow("eu_fixture-bucket", 2048),
        ],
      },
    });
    const snapshot = await getUsage(setup().env),
      inventory = snapshot.inventories!.find((item) => item.product === "r2")!;
    expect(inventory).toMatchObject({
      complete: true,
      pages: 5,
      listed: 2,
      matched: 2,
      missing: 0,
      unmatchedObserved: 0,
      currentBytes: 3072,
    });
    expect(
      inventory.scopes?.map((scope) => [
        scope.jurisdiction,
        scope.listed,
        scope.status,
      ]),
    ).toEqual([
      ["default", 1, "ok-data"],
      ["eu", 1, "ok-data"],
      ["us", 0, "ok-empty"],
      ["fedramp", 0, "ok-empty"],
      ["fedramp-high", 0, "ok-empty"],
    ]);
    expect(
      fetcher.mock.calls
        .filter(([url]) => url.includes("/r2/buckets?"))
        .map(([, init]) => new Headers(init?.headers).get("cf-r2-jurisdiction"))
        .sort(),
    ).toEqual(["default", "eu", "fedramp", "fedramp-high", "us"]);
    expect(JSON.stringify(snapshot)).not.toContain("eu_fixture-bucket");
  });
  it("keeps identical cursor strings independent between jurisdictions", async () => {
    cloud({
      r2Scopes: (jurisdiction, cursor) =>
        ["default", "eu"].includes(jurisdiction)
          ? bucketResponse(
              [{ name: cursor ? "second-bucket" : "fixture-bucket" }],
              cursor ? undefined : "shared-cursor",
            )
          : bucketResponse([]),
    });
    const inventory = (await getUsage(setup().env)).inventories!.find(
      (item) => item.product === "r2",
    )!;
    expect(inventory).toMatchObject({ complete: true, pages: 7, listed: 4 });
    expect(
      inventory.scopes
        ?.filter((scope) => ["default", "eu"].includes(scope.jurisdiction))
        .map((scope) => scope.pages),
    ).toEqual([2, 2]);
  });
  it("rejects an explicit jurisdiction echo mismatch without hiding another successful scope", async () => {
    cloud({
      r2Scopes: (jurisdiction) =>
        bucketResponse(
          jurisdiction === "eu"
            ? [{ name: "fixture-bucket", jurisdiction: "default" }]
            : jurisdiction === "default"
              ? [{ name: "fixture-bucket" }]
              : [],
        ),
    });
    const inventory = (await getUsage(setup().env)).inventories!.find(
      (item) => item.product === "r2",
    )!;
    expect(inventory).toMatchObject({ complete: false, listed: 1 });
    expect(
      inventory.scopes?.find((scope) => scope.jurisdiction === "eu"),
    ).toMatchObject({
      complete: false,
      status: "delayed-incomplete",
      listed: 0,
    });
  });
  it("retains default observations while pausing only proven restricted scopes with their original attempt time", async () => {
    const f = setup(),
      firstFetch = cloud({ r2Scopes: deniedScope }),
      first = await getUsage(f.env);
    const before = first.inventories!.find((item) => item.product === "r2")!;
    expect(before).toMatchObject({
      complete: false,
      listed: 1,
      currentBytes: 1010,
    });
    expect(
      before.scopes?.find((scope) => scope.jurisdiction === "fedramp"),
    ).toMatchObject({
      status: "permissions",
      complete: false,
      httpStatus: 403,
      errorCodes: [10003],
      automatic: true,
    });
    expect(
      before.scopes?.find((scope) => scope.jurisdiction === "fedramp-high"),
    ).toMatchObject({
      complete: false,
      httpStatus: 400,
      status: "delayed-incomplete",
    });
    expect(
      firstFetch.mock.calls.filter(([url]) => url.includes("/r2/buckets?"))
        .length,
    ).toBe(5);
    vi.setSystemTime(at + 60000);
    const secondFetch = cloud({ r2Scopes: deniedScope }),
      second = await getUsage(f.env),
      inventory = second.inventories!.find((item) => item.product === "r2")!;
    expect(
      secondFetch.mock.calls.filter(([url]) => url.includes("/r2/buckets?"))
        .length,
    ).toBe(3);
    expect(
      inventory.scopes?.find((scope) => scope.jurisdiction === "fedramp"),
    ).toMatchObject({
      automatic: false,
      fetchedAt: at,
      pages: 0,
      complete: false,
    });
    expect(
      second.resources.find((resource) => resource.key === "r2CurrentBytes")
        ?.budgetUsable,
    ).toBe(false);
    const cached = JSON.parse(
      f.native
        .prepare(
          "SELECT value FROM settings WHERE key='r2_inventory_restricted_cache_v1'",
        )
        .get().value,
    );
    expect(cached.credentialHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(second)).not.toContain(cached.credentialHash);
    expect(JSON.stringify(second)).not.toContain("private-provider-error");
    expect(JSON.stringify(cached)).not.toContain(f.env.CF_USAGE_API_TOKEN);
  });
  it("retries restricted scopes only on an explicit refresh and removes a restriction after success", async () => {
    const f = setup();
    cloud({ r2Scopes: deniedScope });
    await getUsage(f.env);
    const fetcher = cloud(),
      snapshot = await getUsage(f.env, { refreshRestrictedR2: true });
    expect(
      fetcher.mock.calls.filter(([url]) => url.includes("/r2/buckets?")).length,
    ).toBe(5);
    expect(
      snapshot.inventories?.find((item) => item.product === "r2")?.complete,
    ).toBe(true);
    expect(
      JSON.parse(
        f.native
          .prepare(
            "SELECT value FROM settings WHERE key='r2_inventory_restricted_cache_v1'",
          )
          .get().value,
      ).entries,
    ).toEqual([]);
  });
  it.each(["token", "account", "environment"])(
    "does not reuse a restricted-scope cache after changing %s",
    async (change) => {
      const f = setup();
      cloud({ r2Scopes: deniedScope });
      await getUsage(f.env);
      if (change === "token")
        f.env.CF_USAGE_API_TOKEN = "different-offline-token";
      else if (change === "account")
        f.env.CLOUDFLARE_ACCOUNT_ID = "b".repeat(32);
      else f.env.APP_ENV = "production";
      const fetcher = cloud({ r2Scopes: deniedScope });
      await getUsage(f.env);
      expect(
        fetcher.mock.calls.filter(([url]) => url.includes("/r2/buckets?"))
          .length,
      ).toBe(5);
    },
  );
  it("does not pause a transient server failure", async () => {
    const f = setup(),
      options = {
        r2Scopes: (jurisdiction: string) =>
          jurisdiction === "fedramp"
            ? Response.json({ success: false }, { status: 500 })
            : bucketResponse(
                jurisdiction === "default" ? [{ name: "fixture-bucket" }] : [],
              ),
      };
    cloud(options);
    await getUsage(f.env);
    const fetcher = cloud(options),
      snapshot = await getUsage(f.env);
    expect(
      fetcher.mock.calls.filter(([url]) => url.includes("/r2/buckets?")).length,
    ).toBe(5);
    expect(
      snapshot.inventories
        ?.find((item) => item.product === "r2")
        ?.scopes?.find((scope) => scope.jurisdiction === "fedramp"),
    ).toMatchObject({
      automatic: true,
      status: "temporary-failure",
      complete: false,
    });
  });
  it("does not pause an entire jurisdiction because a later pagination request was rejected", async () => {
    const f = setup(),
      options = {
        r2Scopes: (jurisdiction: string, cursor: string | null) =>
          jurisdiction === "fedramp"
            ? cursor
              ? Response.json({ success: false }, { status: 400 })
              : bucketResponse([{ name: "fixture-bucket" }], "next-page")
            : bucketResponse(
                jurisdiction === "default" ? [{ name: "fixture-bucket" }] : [],
              ),
      };
    cloud(options);
    await getUsage(f.env);
    const fetcher = cloud(options),
      snapshot = await getUsage(f.env);
    expect(
      fetcher.mock.calls.filter(
        ([url, init]) =>
          url.includes("/r2/buckets?") &&
          new Headers(init?.headers).get("cf-r2-jurisdiction") === "fedramp",
      ).length,
    ).toBe(2);
    expect(
      snapshot.inventories
        ?.find((item) => item.product === "r2")
        ?.scopes?.find((scope) => scope.jurisdiction === "fedramp"),
    ).toMatchObject({ automatic: true, complete: false, listed: 1, pages: 2 });
  });
  it("retains account class observations without converting an incomplete census into an allowance", async () => {
    cloud({ r2Scopes: deniedScope });
    const snapshot = await getUsage(setup().env);
    expect(
      snapshot.inventories!.find((item) => item.product === "r2"),
    ).toMatchObject({
      complete: false,
      classScope: { scope: "account", complete: true },
    });
    expect(snapshot.processingAllowed).toBe(false);
  });
});
