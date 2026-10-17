import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  billingPeriod,
  getUsage,
  INSTANCES,
  quoteProcessing,
  requireStorageBudget,
  validateQuoteBudget,
} from "../src/billing";
import type { Env, Quote, Video } from "../src/types";

const at = Date.parse("2026-10-13T13:00:00Z");
const accountId = "a".repeat(32);
type ConfidenceFixtureResponse = {
  data: {
    viewer: {
      accounts: Record<
        string,
        { confidence: { sum: Record<string, { isValid?: unknown }> } }[]
      >[];
    };
  };
};
function environment(
  options: {
    stored?: number;
    reserved?: number;
    reservations?: string[];
    reservationRows?: Record<string, unknown>[];
    job?: { finished_at: number; stop_verified: number };
  } = {},
): Env {
  const db = {
    prepare(sql: string) {
      const statement = {
        bind: vi.fn(() => statement),
        all: vi.fn(async () => ({
          success: true,
          results: sql.includes("FROM settings")
            ? [
                { key: "storage_limit_bytes", value: "10737418240" },
                { key: "monthly_spend_limit_usd", value: "0" },
              ]
            : sql.includes("SELECT bytes FROM objects")
              ? [{ bytes: options.stored || 0 }]
              : sql.includes("SELECT reserved_bytes FROM uploads")
                ? [{ reserved_bytes: options.reserved || 0 }]
                : sql.includes("FROM reservations")
                  ? options.reservationRows ||
                    (options.reservations || []).map((amounts_json) => ({
                      amounts_json,
                    }))
                  : [],
        })),
        first: vi.fn(async () =>
          sql.includes("storage_limit_bytes")
            ? { value: "10737418240" }
            : sql.includes("FROM objects")
              ? { bytes: options.stored || 0 }
              : sql.includes("FROM uploads")
                ? { bytes: options.reserved || 0 }
                : sql.includes("FROM jobs")
                  ? options.job || null
                  : sql.includes("task_timeout_seconds")
                    ? { value: "1800" }
                    : null,
        ),
        run: vi.fn(async () => ({ success: true, meta: { changes: 1 } })),
      };
      return statement;
    },
  };
  return {
    DB: db,
    MEDIA: {
      head: vi.fn(async () => ({ size: 1024, etag: "source-etag" })),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    },
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CF_USAGE_API_TOKEN: "usage-test-value",
  } as unknown as Env;
}
function mockCloudflare(
  overrides: {
    billingRows?: Record<string, unknown>[];
    failGraph?: boolean;
    leakedError?: boolean;
  } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/billable-usage/info"))
        return Response.json({
          success: true,
          result: {
            covered: true,
            subscriptions: [
              {
                billing_cycle_anchor_timestamp: "2024-07-13T00:00:00Z",
                start_timestamp: "2024-06-13T00:00:00Z",
                end_timestamp: null,
              },
            ],
          },
        });
      if (url.endsWith("/billable-usage"))
        return Response.json({
          success: true,
          result: overrides.billingRows || [
            {
              ServiceName: "R2 Data Storage (First 10GB-Month included)",
              BillingPeriodStart: "2026-09-13T00:00:00Z",
              ChargePeriodStart: "2026-09-13T00:00:00Z",
              ChargePeriodEnd: "2026-10-13T00:00:00Z",
              ConsumedQuantity: 0.6,
              ConsumedUnit: "GB-months",
              PricingQuantity: 0,
            },
          ],
        });
      if (url.endsWith("/billable/usage"))
        return Response.json(
          {
            success: false,
            errors: [
              {
                code: 1171,
                message: overrides.leakedError ? "sensitive-test-body" : "",
              },
            ],
          },
          { status: 403 },
        );
      if (url.endsWith("/subscriptions"))
        return Response.json({
          success: true,
          result: [
            {
              state: "Paid",
              rate_plan: { id: "workers_paid" },
              client_secrets: "sensitive-test-body",
            },
            { state: "Paid", rate_plan: { id: "r2_paid" } },
          ],
        });
      if (url.includes("/r2/buckets?"))
        return Response.json({
          success: true,
          result: {
            buckets:
              new Headers(init?.headers).get("cf-r2-jurisdiction") === "default"
                ? [{ name: "configured-test" }]
                : [],
          },
        });
      if (url.endsWith("/r2/metrics"))
        return Response.json({
          success: true,
          result: {
            standard: {
              published: { payloadSize: 1e6, metadataSize: 0 },
              uploaded: { payloadSize: 0, metadataSize: 0 },
            },
            infrequentAccess: {
              published: { payloadSize: 0, metadataSize: 0 },
              uploaded: { payloadSize: 0, metadataSize: 0 },
            },
          },
        });
      if (url.endsWith("/graphql")) {
        if (overrides.failGraph)
          return Response.json({
            errors: [{ message: "sensitive-test-body" }],
          });
        const query = String(JSON.parse(String(init?.body)).query);
        const node = query.match(/\{(\w+)\(limit:/)?.[1] || "";
        return Response.json({
          data: { viewer: { accounts: [{ [node]: [] }] } },
          errors: null,
        });
      }
      throw new Error("unexpected endpoint");
    }),
  );
}
function mockCoveredStorage(
  options: {
    r2Daily?: Record<string, unknown>[];
    r2Current?: Record<string, unknown>[];
    d1Daily?: Record<string, unknown>[];
    buckets?: string[];
  } = {},
) {
  const names = [
    "R2 Data Storage (First 10GB-Month included)",
    "R2 Storage Class A Operations (First 1M included)",
    "R2 Storage Class B Operations (First 10M included)",
    "D1 - Rows Read (first 25 billion included)",
    "D1 - Rows Written (first 50 million included)",
    "D1 - Storage GB-mo (first 5GB included)",
  ];
  mockCloudflare({
    billingRows: names.map((ServiceName) => ({
      ServiceName,
      BillingPeriodStart: "2026-10-13T00:00:00Z",
      ChargePeriodStart: "2026-10-13T00:00:00Z",
      ChargePeriodEnd: "2026-10-13T12:00:00Z",
      ConsumedQuantity: 0,
    })),
  });
  const original = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes("/r2/buckets?") &&
        options.buckets &&
        new Headers(init?.headers).get("cf-r2-jurisdiction") === "default"
      )
        return Response.json({
          success: true,
          result: { buckets: options.buckets.map((name) => ({ name })) },
        });
      if (!url.endsWith("/graphql")) return original(url, init);
      const query = String(JSON.parse(String(init?.body)).query);
      const node = query.match(/\{(\w+)\(limit:/)?.[1] || "";
      const graph: Record<string, unknown[]> = {
        r2OperationsAdaptiveGroups: [
          {
            sum: { requests: 0 },
            confidence: {
              sum: {
                requests: {
                  estimate: 0,
                  lower: 0,
                  upper: 0,
                  sampleSize: 1,
                  isValid: true,
                },
              },
            },
          },
        ],
        d1AnalyticsAdaptiveGroups: [
          {
            sum: { rowsRead: 0, rowsWritten: 0 },
            confidence: {
              sum: {
                rowsRead: {
                  estimate: 0,
                  lower: 0,
                  upper: 0,
                  sampleSize: 1,
                  isValid: true,
                },
                rowsWritten: {
                  estimate: 0,
                  lower: 0,
                  upper: 0,
                  sampleSize: 1,
                  isValid: true,
                },
              },
            },
          },
        ],
        r2StorageAdaptiveGroups: [
          {
            dimensions: {
              bucketName: "configured-test",
              storageClass: "Standard",
              date: "2026-10-13",
              datetime: "2026-10-13T12:55:00Z",
            },
            max: { payloadSize: 1e6, metadataSize: 0 },
          },
        ],
        d1StorageAdaptiveGroups: [
          {
            dimensions: { databaseId: "configured-db", date: "2026-10-13" },
            max: { databaseSizeBytes: 1e6 },
          },
        ],
      };
      if (node === "r2StorageAdaptiveGroups") {
        const replacement = query.includes(
          "dimensions{bucketName storageClass date}",
        )
          ? options.r2Daily
          : options.r2Current;
        if (replacement) graph[node] = replacement;
      }
      if (node === "d1StorageAdaptiveGroups" && options.d1Daily)
        graph[node] = options.d1Daily;
      return Response.json({
        data: { viewer: { accounts: [{ [node]: graph[node] || [] }] } },
        errors: null,
      });
    }),
  );
}
function containerAnalytics(
  options: {
    settings?: Record<string, unknown>;
    data?: Record<string, unknown>[];
    billingRows?: Record<string, unknown>[];
  } = {},
) {
  mockCloudflare({ billingRows: options.billingRows });
  const original = globalThis.fetch;
  const sum = {
    cpuTimeSec: 10,
    allocatedMemory: 100,
    allocatedDisk: 1000,
    txBytes: 10000,
  };
  const data = options.data || [
    {
      sum,
      confidence: {
        sum: Object.fromEntries(
          Object.entries(sum).map(([key, estimate]) => [
            key,
            {
              estimate,
              lower: estimate * 0.9,
              upper: estimate * 1.1,
              sampleSize: 10,
              isValid: true,
            },
          ]),
        ),
      },
    },
  ];
  const settings = {
    enabled: true,
    maxDuration: 32 * 86400,
    notOlderThan: 32 * 86400,
    maxPageSize: 10000,
    availableFields: Object.keys(sum).map((field) => `sum_${field}`),
    ...options.settings,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/graphql")) return original(url, init);
      const query = String(JSON.parse(String(init?.body)).query);
      const result = query.includes("settings{containersUsageAdaptiveGroups")
        ? { settings: { containersUsageAdaptiveGroups: settings } }
        : query.includes("containersUsageAdaptiveGroups(limit:")
          ? { containersUsageAdaptiveGroups: data }
          : null;
      return result
        ? Response.json({
            data: { viewer: { accounts: [result] } },
            errors: null,
          })
        : original(url, init);
    }),
  );
}
function durableObjectAnalytics(
  options: {
    periodic?: Record<string, unknown>[];
    settings?: Record<string, unknown>;
  } = {},
) {
  containerAnalytics();
  const original = globalThis.fetch;
  const periodicSum = {
    duration: 100,
    rowsRead: 10,
    rowsWritten: 20,
    inboundWebsocketMsgCount: 30,
  };
  const periodic = options.periodic || [
    {
      sum: periodicSum,
      confidence: {
        sum: Object.fromEntries(
          Object.entries(periodicSum).map(([key, estimate]) => [
            key,
            {
              estimate,
              lower: estimate * 0.9,
              upper: estimate * 1.1,
              sampleSize: 10,
              isValid: true,
            },
          ]),
        ),
      },
    },
  ];
  const limits = {
    enabled: true,
    maxDuration: 32 * 86400,
    notOlderThan: 90 * 86400,
    maxPageSize: 10000,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/graphql")) return original(url, init);
      const query = String(JSON.parse(String(init?.body)).query);
      if (query.includes("settings{containersUsageAdaptiveGroups")) {
        const response = await original(url, init);
        const body = (await response.json()) as {
          data: {
            viewer: { accounts: { settings: Record<string, unknown> }[] };
          };
        };
        Object.assign(body.data.viewer.accounts[0].settings, {
          durableObjectsInvocationsAdaptiveGroups: {
            ...limits,
            availableFields: ["sum_requests"],
          },
          durableObjectsPeriodicGroups: {
            ...limits,
            availableFields: Object.keys(periodicSum).map(
              (field) => `sum_${field}`,
            ),
            ...options.settings,
          },
        });
        return Response.json(body);
      }
      const node = query.match(/\{(\w+)\(limit:/)?.[1] || "";
      const graph: Record<string, unknown[]> = {
        durableObjectsInvocationsAdaptiveGroups: [
          {
            sum: { requests: 5 },
            confidence: {
              sum: {
                requests: {
                  estimate: 5,
                  lower: 4,
                  upper: 6,
                  sampleSize: 5,
                  isValid: true,
                },
              },
            },
          },
        ],
        durableObjectsPeriodicGroups: periodic,
        durableObjectsSqlStorageGroups: [
          {
            dimensions: { namespaceId: "namespace-a", date: "2026-10-13" },
            max: { storedBytes: 2e6 },
          },
          {
            dimensions: { namespaceId: "namespace-b", date: "2026-10-13" },
            max: { storedBytes: 3e6 },
          },
        ],
      };
      return node in graph
        ? Response.json({
            data: { viewer: { accounts: [{ [node]: graph[node] }] } },
            errors: null,
          })
        : original(url, init);
    }),
  );
}
const video: Video = {
  id: "video",
  title: "test",
  source_key: "original/video",
  source_size: 1024,
  source_etag: "source-etag",
  source_revision: "revision",
  source_name: "file.mp4",
  status: "unprocessed",
  published: 0,
  current_version_id: null,
  probe_json: null,
  created_at: at,
  updated_at: at,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("billing periods", () => {
  it("uses the actual account anchor rather than a calendar month", () =>
    expect(billingPeriod("2024-07-13T00:00:00Z", at)).toEqual({
      start: "2026-10-13T00:00:00.000Z",
      end: "2026-11-13T00:00:00.000Z",
    }));
  it("clamps month end and restores the original anchor in the following month", () =>
    expect(
      billingPeriod("2024-01-31T00:00:00Z", Date.parse("2026-02-28T12:00:00Z")),
    ).toEqual({
      start: "2026-02-28T00:00:00.000Z",
      end: "2026-03-31T00:00:00.000Z",
    }));
  it("rejects invalid and future anchors", () => {
    expect(billingPeriod("invalid", at)).toBeNull();
    expect(billingPeriod("2027-01-01", at)).toBeNull();
  });
});
describe("consumption reconciliation", () => {
  it("retains consumption when charge rows overlap the verified stop but no complete-through watermark exists", async () => {
    vi.setSystemTime(Date.parse("2026-10-15T13:00:00Z"));
    mockCloudflare({
      billingRows: [
        {
          ServiceName: "Container vCPU (First 375 vCPU-minutes included)",
          BillingPeriodStart: "2026-10-13T00:00:00Z",
          ChargePeriodStart: "2026-10-13T00:00:00Z",
          ChargePeriodEnd: "2026-10-15T12:00:00Z",
          ConsumedQuantity: 20,
        },
      ],
    });
    const env = environment({
      reservationRows: [
        {
          id: "reservation",
          owner_id: "job",
          kind: "processing",
          state: "consumed",
          period_start: "2026-10-13T00:00:00.000Z",
          amounts_json:
            '{"containerCpuSeconds":5,"containerDiskByteSeconds":100}',
        },
      ],
      job: {
        finished_at: Date.parse("2026-10-13T10:00:00Z"),
        stop_verified: 1,
      },
    });
    const queries = vi.spyOn(env.DB, "prepare");
    const snapshot = await getUsage(env);
    expect(
      snapshot.resources.find((r) => r.key === "containerCpuSeconds")?.reserved,
    ).toBe(5);
    expect(
      snapshot.resources.find((r) => r.key === "containerDiskByteSeconds")
        ?.reserved,
    ).toBe(100);
    expect(
      queries.mock.calls.some(([sql]) => sql.startsWith("UPDATE reservations")),
    ).toBe(false);
    expect(
      snapshot.resources.find((r) => r.key === "containerCpuSeconds"),
    ).toMatchObject({
      recordedStart: "2026-10-13T00:00:00.000Z",
      recordedEnd: "2026-10-15T12:00:00.000Z",
      sourceCompleteThrough: null,
      coverageStart: null,
      coverageEnd: null,
      budgetUsable: false,
    });
  });
  it("keeps reservations when stopping is not verified", async () => {
    mockCloudflare();
    const snapshot = await getUsage(
      environment({
        reservationRows: [
          {
            id: "reservation",
            owner_id: "job",
            kind: "processing",
            state: "consumed",
            period_start: "2026-09-13T00:00:00.000Z",
            amounts_json: '{"containerCpuSeconds":5}',
          },
        ],
        job: { finished_at: at - 2 * 86400000, stop_verified: 0 },
      }),
    );
    expect(
      snapshot.resources.find((r) => r.key === "containerCpuSeconds")?.reserved,
    ).toBe(5);
    expect(snapshot.priorPeriodUnreconciled).toEqual({});
  });
  it("retains prior-cycle incurred usage without deducting it from a verified new cycle", async () => {
    mockCloudflare();
    const snapshot = await getUsage(
      environment({
        reservationRows: [
          {
            id: "reservation",
            owner_id: "job",
            kind: "processing",
            state: "consumed",
            period_start: "2026-09-13T00:00:00.000Z",
            amounts_json: '{"containerCpuSeconds":5}',
          },
        ],
        job: { finished_at: at - 2 * 86400000, stop_verified: 1 },
      }),
    );
    expect(
      snapshot.resources.find((r) => r.key === "containerCpuSeconds")?.reserved,
    ).toBe(0);
    expect(snapshot.priorPeriodUnreconciled.containerCpuSeconds).toBe(5);
  });
});
describe("account usage coverage", () => {
  it("preserves historical official usage and never treats empty current datasets as zero", async () => {
    mockCloudflare();
    const snapshot = await getUsage(environment());
    expect(snapshot.periodStart).toBe("2026-10-13T00:00:00.000Z");
    expect(snapshot.historical[0].quantity).toBe(0.6);
    const r2 = snapshot.resources.find((r) => r.key === "r2StorageGbMonths")!;
    expect(r2.officialRecorded).toBeNull();
    expect(r2.remaining).toBeNull();
    expect(r2.unbilledEstimate).toBeNull();
    expect(snapshot.storageAllowed).toBe(false);
    expect(snapshot.processingAllowed).toBe(false);
    expect(
      snapshot.sources.find((s) => s.name.startsWith("Billing V2")),
    ).toMatchObject({
      status: "restricted",
      httpStatus: null,
      errorCodes: [],
      displayStatus: "automatic-unavailable",
      automatic: false,
    });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url).endsWith("/billable/usage")),
    ).toBe(false);
  });
  it("uses consumed quantity rather than zero billed/pricing quantity", async () => {
    mockCloudflare({
      billingRows: [
        {
          ServiceName:
            "Container Memory, per GiB-Second (First 25 GiB-hours included)",
          BillingPeriodStart: "2026-10-13T00:00:00Z",
          ChargePeriodStart: "2026-10-13T00:00:00Z",
          ChargePeriodEnd: "2026-10-13T12:00:00Z",
          ConsumedQuantity: 100,
          PricingQuantity: 0,
          BilledCost: 0,
        },
      ],
    });
    const snapshot = await getUsage(environment());
    expect(
      snapshot.resources.find((r) => r.key === "containerMemoryByteSeconds")
        ?.officialRecorded,
    ).toBe(100 * 1024 ** 3);
    expect(snapshot.processingAllowed).toBe(false);
  });
  it("keeps unverified stops and consumed reservations, with uploads separate from current storage", async () => {
    mockCloudflare();
    const snapshot = await getUsage(
      environment({
        reserved: 123,
        reservations: [
          JSON.stringify({ r2CurrentBytes: 456, containerCpuSeconds: 50 }),
        ],
      }),
    );
    expect(snapshot.project.reservedBytes).toBe(579);
    expect(
      snapshot.resources.find((r) => r.key === "containerCpuSeconds")?.reserved,
    ).toBe(50);
  });
  it("fails closed on malformed reservation amounts", async () => {
    mockCloudflare();
    expect(
      (
        await getUsage(
          environment({ reservations: ['{"r2CurrentBytes":-10}'] }),
        )
      ).storageAllowed,
    ).toBe(false);
  });
  it("omits upstream error bodies and subscription client secrets from stored responses", async () => {
    mockCloudflare({ failGraph: true, leakedError: true });
    const snapshot = await getUsage(environment());
    expect(JSON.stringify(snapshot)).not.toContain("sensitive-test-body");
    expect(JSON.stringify(snapshot)).not.toContain("usage-test-value");
  });
  it("never falls back to another credential if runtime token is missing", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const env = environment();
    delete env.CF_USAGE_API_TOKEN;
    expect((await getUsage(env)).storageAllowed).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
describe("Containers analytics evidence", () => {
  it("retains consumed reservations even when valid analytics bounds and overlapping billing rows are available", async () => {
    vi.setSystemTime(Date.parse("2026-10-15T13:00:00Z"));
    containerAnalytics({
      billingRows: [
        {
          ServiceName: "Container vCPU (First 375 vCPU-minutes included)",
          BillingPeriodStart: "2026-10-13T00:00:00Z",
          ChargePeriodStart: "2026-10-13T00:00:00Z",
          ChargePeriodEnd: "2026-10-15T12:00:00Z",
          ConsumedQuantity: 3,
        },
      ],
    });
    const env = environment({
      reservationRows: [
        {
          id: "reservation",
          owner_id: "job",
          kind: "processing",
          state: "consumed",
          period_start: "2026-10-13T00:00:00.000Z",
          amounts_json: '{"containerCpuSeconds":5}',
        },
      ],
      job: {
        finished_at: Date.parse("2026-10-13T10:00:00Z"),
        stop_verified: 1,
      },
    });
    const queries = vi.spyOn(env.DB, "prepare");
    const cpu = (await getUsage(env)).resources.find(
      (r) => r.key === "containerCpuSeconds",
    )!;
    expect(cpu).toMatchObject({
      budgetUsable: true,
      remainingIsEstimate: true,
      reserved: 5,
      officialRecorded: 3,
      unbilledEstimate: 8,
      remaining: 22500 - 11 - 5,
      sourceCompleteThrough: null,
    });
    expect(
      queries.mock.calls.some(([sql]) => sql.startsWith("UPDATE reservations")),
    ).toBe(false);
  });
  it("labels a queryable full-cycle nonempty confidence upper bound as estimated admission evidence", async () => {
    containerAnalytics();
    const snapshot = await getUsage(environment());
    const cpu = snapshot.resources.find(
      (r) => r.key === "containerCpuSeconds",
    )!;
    expect(cpu).toMatchObject({
      officialRecorded: null,
      unbilledEstimate: 11,
      recordedStart: null,
      recordedEnd: null,
      sourceCompleteThrough: null,
      requestedStart: "2026-10-13T00:00:00.000Z",
      requestedEnd: "2026-10-13T13:00:00.000Z",
      budgetUsable: true,
      remainingIsEstimate: true,
      confidenceLevel: 0.99,
      safetyHeadroom: 1125,
      remaining: 22500 - 11,
    });
    expect(
      snapshot.sources.find(
        (s) => s.name === "GraphQL containersUsageAdaptiveGroups",
      ),
    ).toMatchObject({
      requestedStart: cpu.requestedStart,
      requestedEnd: cpu.requestedEnd,
    });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.coverageEnd).toBeNull();
    expect(snapshot.processingAllowed).toBe(false); // Other required resources remain unknown.
  });
  it("keeps charge dates separate without requiring consumption on the first instant of the billing period", async () => {
    containerAnalytics({
      billingRows: [
        {
          ServiceName: "Container vCPU (First 375 vCPU-minutes included)",
          BillingPeriodStart: "2026-10-13T00:00:00Z",
          ChargePeriodStart: "2026-10-13T01:00:00Z",
          ChargePeriodEnd: "2026-10-13T02:00:00Z",
          ConsumedQuantity: 3,
        },
      ],
    });
    const cpu = (await getUsage(environment())).resources.find(
      (r) => r.key === "containerCpuSeconds",
    )!;
    expect(cpu).toMatchObject({
      officialRecorded: 3,
      unbilledEstimate: 8,
      recordedStart: "2026-10-13T01:00:00.000Z",
      recordedEnd: "2026-10-13T02:00:00.000Z",
      coverageStart: "2026-10-13T00:00:00.000Z",
      sourceCompleteThrough: null,
      budgetUsable: true,
      remainingIsEstimate: true,
    });
  });
  it("does not turn a successful empty result into zero even when the dataset is queryable", async () => {
    containerAnalytics({ data: [] });
    const snapshot = await getUsage(environment());
    expect(
      snapshot.resources.find((r) => r.key === "containerCpuSeconds"),
    ).toMatchObject({
      officialRecorded: null,
      unbilledEstimate: null,
      remaining: null,
      budgetUsable: false,
      sourceCompleteThrough: null,
    });
    expect(snapshot.processingAllowed).toBe(false);
  });
  it.each([
    { enabled: false },
    { notOlderThan: 3600 },
    { maxDuration: 3600 },
    { maxPageSize: 100 },
    { availableFields: ["sum_cpuTimeSec"] },
  ])(
    "rejects estimates when full-period availability is not proven: %j",
    async (settings) => {
      containerAnalytics({ settings });
      const cpu = (await getUsage(environment())).resources.find(
        (r) => r.key === "containerCpuSeconds",
      )!;
      expect(cpu.unbilledEstimate).toBe(10);
      expect(cpu.budgetUsable).toBe(false);
      expect(cpu.remaining).toBeNull();
    },
  );
  it.each([
    null,
    { estimate: 10, lower: 9, upper: 11, sampleSize: 10 },
    { estimate: 10, lower: 9, upper: 11, sampleSize: 10, isValid: false },
    { estimate: 10, lower: 9, upper: 11, sampleSize: 0, isValid: true },
    { estimate: 10, lower: 9, upper: 9, sampleSize: 10, isValid: true },
    { estimate: 9, lower: 8, upper: 11, sampleSize: 10, isValid: true },
    { estimate: 10, lower: 9, upper: null, sampleSize: 10, isValid: true },
  ])(
    "rejects missing or inconsistent confidence evidence: %j",
    async (bound) => {
      containerAnalytics({
        data: [
          {
            sum: { cpuTimeSec: 10 },
            confidence: { sum: { cpuTimeSec: bound } },
          },
        ],
      });
      const cpu = (await getUsage(environment())).resources.find(
        (r) => r.key === "containerCpuSeconds",
      )!;
      expect(cpu.budgetUsable).toBe(false);
      expect(cpu.remaining).toBeNull();
      expect(cpu.sourceCompleteThrough).toBeNull();
    },
  );
  it("keeps the observed confidence width as headroom when wider than five percent of included quota", async () => {
    containerAnalytics({
      data: [
        {
          sum: { cpuTimeSec: 100 },
          confidence: {
            sum: {
              cpuTimeSec: {
                estimate: 100,
                lower: 0,
                upper: 20000,
                sampleSize: 10,
                isValid: true,
              },
            },
          },
        },
      ],
    });
    const snapshot = await getUsage(environment());
    const cpu = snapshot.resources.find(
      (r) => r.key === "containerCpuSeconds",
    )!;
    expect(cpu.budgetUsable).toBe(true);
    expect(cpu.safetyHeadroom).toBe(20000);
    expect(cpu.remaining).toBe(2500);
    expect(cpu.remaining! < cpu.safetyHeadroom).toBe(true);
    expect(snapshot.processingAllowed).toBe(false);
  });
});
describe("Durable Objects analytics evidence", () => {
  it("uses valid periodic bounds and includes inbound WebSocket messages in conservative requests", async () => {
    durableObjectAnalytics();
    const snapshot = await getUsage(environment());
    const find = (key: string) =>
      snapshot.resources.find((r) => r.key === key)!;
    expect(find("doRequests")).toMatchObject({
      budgetUsable: true,
      remainingIsEstimate: true,
      unbilledEstimate: 39,
      confidenceLevel: null,
      sourceCompleteThrough: null,
    });
    expect(find("doRequests").source).toContain("无联合 99%");
    expect(find("doDurationGbSeconds").unbilledEstimate).toBeCloseTo(110);
    expect(find("doRowsRead")).toMatchObject({
      budgetUsable: true,
      confidenceLevel: 0.99,
      unbilledEstimate: 11,
    });
    expect(find("doRowsWritten")).toMatchObject({
      budgetUsable: true,
      confidenceLevel: 0.99,
      unbilledEstimate: 22,
    });
    expect(find("doStorageGbMonths").unbilledEstimate).toBeCloseTo(
      5e6 / 1e9 / 30,
    );
    expect(find("doStorageGbMonths")).toMatchObject({
      budgetUsable: false,
      projectedFuture: null,
      remaining: null,
    });
    expect(snapshot.processingAllowed).toBe(false);
    const queries = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) => String(init?.body));
    expect(
      queries.some(
        (q) =>
          q.includes("durableObjectsSqlStorageGroups") &&
          q.includes("namespaceId date"),
      ),
    ).toBe(true);
    expect(
      queries.some(
        (q) => q.includes("confidence(level:0.99)") && q.includes("isValid"),
      ),
    ).toBe(true);
  });
  it("requires current-cycle periodic data to cover WebSocket request dimensions", async () => {
    durableObjectAnalytics({ periodic: [] });
    const snapshot = await getUsage(environment());
    expect(
      snapshot.resources.find((r) => r.key === "doRequests"),
    ).toMatchObject({
      budgetUsable: false,
      unbilledEstimate: null,
      remaining: null,
    });
  });
  it("rejects periodic candidates when account query limits do not cover the billing period", async () => {
    durableObjectAnalytics({ settings: { maxDuration: 60 } });
    const snapshot = await getUsage(environment());
    for (const key of [
      "doRequests",
      "doDurationGbSeconds",
      "doRowsRead",
      "doRowsWritten",
    ])
      expect(snapshot.resources.find((r) => r.key === key)?.budgetUsable).toBe(
        false,
      );
  });
  it.each([
    [
      "durableObjectsInvocationsAdaptiveGroups",
      "requests",
      "doRequests",
      false,
    ],
    [
      "durableObjectsInvocationsAdaptiveGroups",
      "requests",
      "doRequests",
      undefined,
    ],
    ["durableObjectsPeriodicGroups", "duration", "doDurationGbSeconds", false],
    [
      "durableObjectsPeriodicGroups",
      "duration",
      "doDurationGbSeconds",
      undefined,
    ],
    ["durableObjectsPeriodicGroups", "rowsRead", "doRowsRead", false],
    ["durableObjectsPeriodicGroups", "rowsRead", "doRowsRead", undefined],
    ["durableObjectsPeriodicGroups", "rowsWritten", "doRowsWritten", false],
    ["durableObjectsPeriodicGroups", "rowsWritten", "doRowsWritten", undefined],
    [
      "durableObjectsPeriodicGroups",
      "inboundWebsocketMsgCount",
      "doRequests",
      false,
    ],
    [
      "durableObjectsPeriodicGroups",
      "inboundWebsocketMsgCount",
      "doRequests",
      undefined,
    ],
  ])(
    "rejects %s.%s (%s) when validity is %s",
    async (node, field, key, valid) => {
      durableObjectAnalytics();
      const original = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const response = await original(url, init);
          if (
            url.endsWith("/graphql") &&
            String(init?.body).includes(`${node}(limit:`)
          ) {
            const body = (await response.json()) as ConfidenceFixtureResponse;
            const bound =
              body.data.viewer.accounts[0][String(node)][0].confidence.sum[
                String(field)
              ];
            if (valid === undefined) delete bound.isValid;
            else bound.isValid = valid;
            return Response.json(body);
          }
          return response;
        }),
      );
      const resource = (await getUsage(environment())).resources.find(
        (r) => r.key === key,
      )!;
      expect(resource.budgetUsable).toBe(false);
      expect(resource.remaining).toBeNull();
      expect(resource.confidenceLevel).toBeNull();
    },
  );
});
describe("storage history completeness", () => {
  const peak = (bucketName: string, date: string) => ({
    dimensions: {
      bucketName,
      storageClass: "Standard",
      date,
      datetime: `${date}T12:55:00Z`,
    },
    max: { payloadSize: 1e6, metadataSize: 0 },
  });
  it("rejects a bucket's missing historical day even when the combined account dates are continuous", async () => {
    vi.setSystemTime(Date.parse("2026-10-14T13:00:00Z"));
    mockCoveredStorage({
      buckets: ["bucket-a", "bucket-b"],
      r2Daily: [
        peak("bucket-a", "2026-10-13"),
        peak("bucket-a", "2026-10-14"),
        peak("bucket-b", "2026-10-14"),
      ],
      r2Current: [
        peak("bucket-a", "2026-10-14"),
        peak("bucket-b", "2026-10-14"),
      ],
    });
    const snapshot = await getUsage(environment());
    expect(
      snapshot.resources.find((r) => r.key === "r2CurrentBytes")?.budgetUsable,
    ).toBe(true);
    const cumulative = snapshot.resources.find(
      (r) => r.key === "r2StorageGbMonths",
    )!;
    expect(cumulative.unbilledEstimate).toBeCloseTo(3e6 / 1e9 / 30);
    expect(cumulative.budgetUsable).toBe(false);
    expect(cumulative.remaining).toBeNull();
    expect(snapshot.storageAllowed).toBe(false);
  });
  it("requires every current bucket/class snapshot key to have its own daily history", async () => {
    mockCoveredStorage({
      buckets: ["bucket-a", "bucket-b"],
      r2Daily: [peak("bucket-a", "2026-10-13")],
      r2Current: [
        peak("bucket-a", "2026-10-13"),
        peak("bucket-b", "2026-10-13"),
      ],
    });
    const snapshot = await getUsage(environment());
    expect(
      snapshot.resources.find((r) => r.key === "r2CurrentBytes")?.budgetUsable,
    ).toBe(true);
    expect(
      snapshot.resources.find((r) => r.key === "r2StorageGbMonths"),
    ).toMatchObject({ budgetUsable: false, remaining: null });
    expect(snapshot.storageAllowed).toBe(false);
  });
  it("accepts the R2 component when each current pair has every required day, without bypassing D1 completeness", async () => {
    vi.setSystemTime(Date.parse("2026-10-14T13:00:00Z"));
    mockCoveredStorage({
      buckets: ["bucket-a", "bucket-b"],
      r2Daily: [
        peak("bucket-a", "2026-10-13"),
        peak("bucket-b", "2026-10-13"),
        peak("bucket-a", "2026-10-14"),
        peak("bucket-b", "2026-10-14"),
      ],
      r2Current: [
        peak("bucket-a", "2026-10-14"),
        peak("bucket-b", "2026-10-14"),
      ],
    });
    const snapshot = await getUsage(environment());
    expect(
      snapshot.resources.find((r) => r.key === "r2StorageGbMonths")
        ?.budgetUsable,
    ).toBe(true);
    expect(snapshot.storageAllowed).toBe(false);
  });
  it.each(["bucketName", "storageClass", "date"])(
    "retains observed peaks but rejects a missing historical %s",
    async (field) => {
      const row = peak("configured-test", "2026-10-13");
      const dimensions: Record<string, unknown> = { ...row.dimensions };
      delete dimensions[field];
      mockCoveredStorage({ r2Daily: [{ ...row, dimensions }] });
      const cumulative = (await getUsage(environment())).resources.find(
        (r) => r.key === "r2StorageGbMonths",
      )!;
      expect(cumulative.unbilledEstimate).toBeGreaterThan(0);
      expect(cumulative.budgetUsable).toBe(false);
      expect(cumulative.remaining).toBeNull();
    },
  );
  it("keeps D1 storage unknown without a complete database census even when all observed databases have daily peaks", async () => {
    mockCoveredStorage({
      d1Daily: [
        {
          dimensions: { databaseId: "database-a", date: "2026-10-13" },
          max: { databaseSizeBytes: 1e6 },
        },
        {
          dimensions: { databaseId: "database-b", date: "2026-10-13" },
          max: { databaseSizeBytes: 2e6 },
        },
      ],
    });
    const snapshot = await getUsage(environment());
    const storage = snapshot.resources.find(
      (r) => r.key === "d1StorageGbMonths",
    )!;
    expect(storage.unbilledEstimate).toBeCloseTo(3e6 / 1e9 / 30);
    expect(storage).toMatchObject({
      budgetUsable: false,
      remaining: null,
      projectedFuture: null,
      sourceCompleteThrough: null,
    });
    expect(snapshot.storageAllowed).toBe(false);
    await expect(
      requireStorageBudget(environment(), 1024),
    ).resolves.toMatchObject({ storageAllowed: true });
  });
});
describe("admission and source binding", () => {
  it.each([
    ["r2OperationsAdaptiveGroups", "requests", "r2ClassA", false],
    ["r2OperationsAdaptiveGroups", "requests", "r2ClassB", undefined],
    ["d1AnalyticsAdaptiveGroups", "rowsRead", "d1RowsRead", false],
    ["d1AnalyticsAdaptiveGroups", "rowsRead", "d1RowsRead", undefined],
    ["d1AnalyticsAdaptiveGroups", "rowsWritten", "d1RowsWritten", false],
    ["d1AnalyticsAdaptiveGroups", "rowsWritten", "d1RowsWritten", undefined],
  ])(
    "keeps account usage unknown but allows project upload with %s.%s (%s), validity %s",
    async (node, field, key, valid) => {
      mockCoveredStorage();
      const original = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const response = await original(url, init);
          if (
            url.endsWith("/graphql") &&
            String(init?.body).includes(`${node}(limit:`)
          ) {
            const body = (await response.json()) as ConfidenceFixtureResponse;
            const bound =
              body.data.viewer.accounts[0][String(node)][0].confidence.sum[
                String(field)
              ];
            if (valid === undefined) delete bound.isValid;
            else bound.isValid = valid;
            return Response.json(body);
          }
          return response;
        }),
      );
      const snapshot = await getUsage(environment());
      expect(snapshot.resources.find((r) => r.key === key)).toMatchObject({
        budgetUsable: false,
        confidenceLevel: null,
        remaining: null,
      });
      expect(snapshot.storageAllowed).toBe(false);
      await expect(
        requireStorageBudget(environment(), 1024),
      ).resolves.toMatchObject({ storageAllowed: true });
    },
  );
  it("preserves partial account evidence without blocking ordinary project upload", async () => {
    mockCoveredStorage();
    const snapshot = await getUsage(environment());
    expect(snapshot.storageAllowed).toBe(false);
    expect(snapshot.policy.monthlySpendLimitUsd).toBe(0);
    expect(
      snapshot.resources.find((r) => r.key === "r2StorageGbMonths")
        ?.budgetUsable,
    ).toBe(true);
    expect(
      snapshot.resources.find((r) => r.key === "r2StorageGbMonths")!
        .projectedFuture,
    ).toBeGreaterThan(0);
    expect(
      snapshot.resources.find((r) => r.key === "d1StorageGbMonths"),
    ).toMatchObject({
      budgetUsable: false,
      remaining: null,
      projectedFuture: null,
    });
    expect(snapshot.processingAllowed).toBe(false);
    await expect(
      requireStorageBudget(environment(), 1024),
    ).resolves.toMatchObject({ storageAllowed: true });
  });
  it("uses labelled analytics upper bounds when current official records are delayed", async () => {
    mockCoveredStorage();
    const original = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url.endsWith("/billable-usage")
          ? Response.json({ success: true, result: [] })
          : original(url, init),
      ),
    );
    const snapshot = await getUsage(environment());
    const resource = snapshot.resources.find((r) => r.key === "r2ClassA")!;
    expect(resource.officialRecorded).toBeNull();
    expect(resource.remainingIsEstimate).toBe(true);
    expect(resource.confidenceLevel).toBe(0.99);
    expect(snapshot.storageAllowed).toBe(false);
    expect(snapshot.processingAllowed).toBe(false);
  });
  it("keeps partial account storage unknown without blocking project upload", async () => {
    mockCoveredStorage();
    const original = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url.includes("/r2/buckets?")
          ? Response.json({
              success: true,
              result: {
                buckets: [
                  { name: "configured-test" },
                  { name: "missing-from-gauge" },
                ],
              },
            })
          : original(url, init),
      ),
    );
    await expect(
      requireStorageBudget(environment(), 1024),
    ).resolves.toMatchObject({ storageAllowed: true });
  });
  it("does not require complete account storage class evidence for ordinary upload", async () => {
    mockCoveredStorage();
    const original = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url.endsWith("/r2/metrics")
          ? Response.json({
              success: true,
              result: {
                standard: {
                  published: { payloadSize: 1e6, metadataSize: 0 },
                  uploaded: { payloadSize: 0, metadataSize: 0 },
                },
                infrequentAccess: {
                  published: { payloadSize: 1, metadataSize: 0 },
                  uploaded: { payloadSize: 0, metadataSize: 0 },
                },
              },
            })
          : original(url, init),
      ),
    );
    await expect(
      requireStorageBudget(environment(), 1024),
    ).resolves.toMatchObject({ storageAllowed: true });
  });
  it("counts existing project objects and queued files before reserving another upload", async () => {
    mockCoveredStorage();
    await expect(
      requireStorageBudget(
        environment({ stored: 10 * 1024 ** 3, reserved: 1024 }),
        1,
      ),
    ).rejects.toMatchObject({ code: "storage_limit" });
  });
  it("keeps account allowance separate from the project 10 GiB upload limit", async () => {
    mockCoveredStorage();
    const snapshot = await getUsage(environment());
    const account = snapshot.resources.find((r) => r.key === "r2CurrentBytes")!;
    expect(account.included).toBe(10e9);
    expect(account.remaining! - account.safetyHeadroom).toBeLessThan(10e9);
    expect(snapshot.policy.storageLimitBytes).toBe(10 * 1024 ** 3);
    await expect(
      requireStorageBudget(environment(), 10e9),
    ).resolves.toMatchObject({ storageAllowed: true });
  });
  it("allows upload with unknown account coverage and makes no source/container request", async () => {
    mockCloudflare();
    const env = environment();
    await expect(requireStorageBudget(env, 1024)).resolves.toMatchObject({
      storageAllowed: true,
    });
    expect(env.MEDIA.head).not.toHaveBeenCalled();
  });
  it("enforces the hard 20 GiB size separately from storage budget", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      requireStorageBudget(environment(), 20 * 1024 ** 3 + 1),
    ).rejects.toMatchObject({ code: "upload_size" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("verifies actual source etag before requesting a quote", async () => {
    const env = environment();
    vi.mocked(env.MEDIA.head).mockResolvedValue({
      size: 1024,
      etag: "changed",
    } as R2Object);
    await expect(
      quoteProcessing(env, video, { mode: "probe-remux", quality: "source" }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });
  it("requires a confirmed probe for transcode and rejects upscaling", async () => {
    await expect(
      quoteProcessing(environment(), video, {
        mode: "transcode",
        quality: "720p",
      }),
    ).rejects.toMatchObject({ code: "probe_required" });
    await expect(
      quoteProcessing(
        environment(),
        {
          ...video,
          probe_json: JSON.stringify({
            durationSeconds: 60,
            width: 640,
            height: 480,
          }),
        },
        { mode: "transcode", quality: "720p" },
      ),
    ).rejects.toMatchObject({ code: "upscale_denied" });
  });
  it("fails closed if the runtime token cannot read current account capacity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { success: false, errors: [{ code: 10000 }] },
          { status: 403 },
        ),
      ),
    );
    await expect(
      quoteProcessing(environment(), video, {
        mode: "probe-remux",
        quality: "source",
      }),
    ).rejects.toMatchObject({ code: "capacity_unknown" });
  });
  it("does not confuse published instance sizes with actual account support", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          success: true,
          result: {
            limits: {
              vcpu_per_deployment: 0.25,
              memory_mib_per_deployment: 1024,
              disk_mb_per_deployment: 4000,
            },
          },
        }),
      ),
    );
    await expect(
      quoteProcessing(environment(), video, {
        mode: "probe-remux",
        quality: "source",
      }),
    ).rejects.toMatchObject({ code: "processing_resources" });
  });
  it("does not equate upload capacity with container disk capacity", async () => {
    const env = environment();
    const big = { ...video, source_size: 10 * 1024 ** 3 };
    vi.mocked(env.MEDIA.head).mockResolvedValue({
      size: big.source_size,
      etag: "source-etag",
    } as R2Object);
    await expect(
      quoteProcessing(env, big, { mode: "probe-remux", quality: "source" }),
    ).rejects.toMatchObject({ code: "processing_resources" });
    expect(INSTANCES.every((i) => i.diskBytes <= 20e9)).toBe(true);
    expect(INSTANCES[0].memoryBytes).toBe(4 * 1024 ** 3);
  });
  it("rejects expired/consumed quotes before any API read or task start", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      validateQuoteBudget(environment(), {
        expires_at: at - 1,
        state: "open",
      } as Quote),
    ).rejects.toMatchObject({ code: "quote_expired" });
    await expect(
      validateQuoteBudget(environment(), {
        expires_at: at + 1,
        state: "consumed",
      } as Quote),
    ).rejects.toMatchObject({ code: "quote_expired" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
