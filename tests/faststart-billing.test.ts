import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INSTANCES,
  processingOutputBounds,
  processingResourceAmounts,
  quoteProcessing,
  R2_SINGLE_PUT_MAX_BYTES,
  validateQuoteBudget,
} from "../src/billing";
import type { Env, Quote, Video } from "../src/types";

const at = Date.parse("2026-10-14T06:00:00Z");
const video: Video = {
  id: "video",
  title: "Offline fixture",
  source_key: "videos/video/source/revision",
  source_size: 4372373,
  source_etag: "fixture-etag",
  source_revision: "revision",
  source_name: "fixture.mp4",
  status: "unprocessed",
  published: 0,
  current_version_id: null,
  probe_json: null,
  created_at: at,
  updated_at: at,
};
function environment(input = video) {
  const processor = vi.fn(() => {
    throw new Error("No task may start in a billing test");
  });
  const env = {
    APP_ENV: "test",
    PROCESSING_ENABLED: "false",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CF_USAGE_API_TOKEN: "offline-fixture-usage-token",
    MEDIA: {
      head: vi.fn(async () => ({
        key: input.source_key,
        size: input.source_size,
        etag: input.source_etag,
      })),
    },
    PROCESSOR: { idFromName: processor, get: processor },
    DB: {
      prepare(sql: string) {
        const statement = {
          bind: vi.fn(() => statement),
          first: vi.fn(async () =>
            sql.includes("FROM videos")
              ? input
              : sql.includes("task_timeout_seconds")
                ? { value: "180" }
                : sql.includes("FROM objects") || sql.includes("FROM uploads")
                  ? { bytes: 0 }
                  : null,
          ),
          all: vi.fn(async () => ({
            success: true,
            results: sql.includes("FROM settings")
              ? [
                  { key: "storage_limit_bytes", value: String(10 * 1024 ** 3) },
                  { key: "monthly_spend_limit_usd", value: "1000" },
                ]
              : [],
          })),
          run: vi.fn(async () => ({ success: true, meta: { changes: 1 } })),
        };
        return statement;
      },
    },
  } as unknown as Env;
  return { env, processor };
}
function unknownAccount() {
  const fetch = vi.fn(async (url: string) => {
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
    if (url.endsWith("/subscriptions"))
      return Response.json({
        success: true,
        result: [
          { state: "Active", rate_plan: { id: "workers_paid" } },
          { state: "Active", rate_plan: { id: "r2_paid" } },
        ],
      });
    if (url.endsWith("/graphql"))
      return Response.json({ data: { viewer: { accounts: [{}] } } });
    return Response.json({ success: true, result: [] });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function quotePlan(overrides: Record<string, unknown> = {}): Quote {
  const output = processingOutputBounds(
    video.source_size,
    "faststart",
    "source",
    null,
  );
  const plan = {
    mode: "faststart",
    quality: "source",
    sourceKey: video.source_key,
    sourceBytes: video.source_size,
    sourceRevision: video.source_revision,
    sourceEtag: video.source_etag,
    periodStart: "2026-10-13T00:00:00Z",
    instance: INSTANCES[0],
    totalTimeoutSeconds: 180,
    ...output,
    resourceAmounts: processingResourceAmounts(INSTANCES[0], {
      mode: "faststart",
      totalTimeoutSeconds: 180,
      ...output,
    }),
    ...overrides,
  };
  return {
    id: "quote",
    video_id: video.id,
    source_revision: video.source_revision,
    source_etag: video.source_etag!,
    mode: "faststart",
    quality: "source",
    snapshot_id: "snapshot",
    period_start: plan.periodStart,
    expires_at: at + 60000,
    state: "open",
    data_json: JSON.stringify(plan),
    created_at: at,
  };
}
function legacyHlsQuote(
  mode: "probe-remux" | "transcode",
  oldModel: boolean,
): Quote {
  const quote = quotePlan();
  const plan = JSON.parse(quote.data_json);
  const output = processingOutputBounds(video.source_size, mode, "source", 60);
  Object.assign(plan, output, { mode, quality: "source" });
  // Pre-deployment HLS quotes lack the new transport/output identity fields.
  for (const key of [
    "sourceKey",
    "sourceBytes",
    "outputKind",
    "outputName",
    "encoding",
    "maxUploadAttempts",
  ])
    delete plan[key];
  plan.resourceAmounts = processingResourceAmounts(INSTANCES[0], {
    mode,
    totalTimeoutSeconds: 180,
    ...output,
  });
  if (oldModel) {
    plan.resourceAmounts.containerEgressBytes = output.maxOutputBytes * 2;
    plan.resourceAmounts.r2ClassA = output.maxMediaObjects * 2 + 10;
    plan.resourceAmounts.r2ClassB = output.maxMediaObjects * 2 + 10;
    plan.resourceAmounts.doRequests = (Math.ceil(180 / 5) + 100) * 3 + 1000;
  }
  return { ...quote, mode, data_json: JSON.stringify(plan) };
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(at);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("faststart output and included-only billing contract", () => {
  it.each(
    (["faststart", "probe-remux", "transcode"] as const).flatMap((mode) =>
      (["d1RowsRead", "d1RowsWritten"] as const).map((key) => ({ mode, key })),
    ),
  )(
    "rejects a $mode quote with the former linear $key model before account calls or dispatch",
    async ({ mode, key }) => {
      const { env, processor } = environment();
      const fetch = unknownAccount();
      const quote =
        mode === "faststart" ? quotePlan() : legacyHlsQuote(mode, false);
      const plan = JSON.parse(quote.data_json),
        objects = plan.maxMediaObjects,
        events = Math.ceil(plan.totalTimeoutSeconds / 1.5) + 100,
        alarms = Math.ceil(plan.totalTimeoutSeconds / 5) + 100;
      const originalScope = plan.resourceAmounts[key];
      plan.resourceAmounts[key] =
        key === "d1RowsRead"
          ? objects * 8 + events * 8 + alarms * 4 + 10000
          : objects * 4 + events * 4 + 10000;
      expect(plan.resourceAmounts[key]).toBeLessThan(originalScope);
      const stale = { ...quote, data_json: JSON.stringify(plan) },
        before = stale.data_json;
      await expect(validateQuoteBudget(env, stale)).rejects.toMatchObject({
        status: 409,
        code: "quote_changed",
      });
      expect(stale.data_json).toBe(before);
      expect(fetch).not.toHaveBeenCalled();
      expect(processor).not.toHaveBeenCalled();
    },
  );
  it.each(["probe-remux", "transcode"] as const)(
    "rejects a legacy HLS %s quote with the former two-attempt resource model before querying live allowances",
    async (mode) => {
      const { env, processor } = environment();
      const fetch = unknownAccount();
      const oldQuote = legacyHlsQuote(mode, true);
      const oldPlan = JSON.parse(oldQuote.data_json),
        currentPlan = JSON.parse(legacyHlsQuote(mode, false).data_json);
      for (const key of [
        "containerEgressBytes",
        "r2ClassA",
        "r2ClassB",
        "doRequests",
      ])
        expect(currentPlan.resourceAmounts[key]).toBeGreaterThan(
          oldPlan.resourceAmounts[key],
        );
      await expect(validateQuoteBudget(env, oldQuote)).rejects.toMatchObject({
        code: "quote_changed",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(processor).not.toHaveBeenCalled();
      expect(JSON.parse(oldQuote.data_json).resourceAmounts).toEqual(
        oldPlan.resourceAmounts,
      );
    },
  );
  it.each(["probe-remux", "transcode"] as const)(
    "keeps sufficient legacy HLS %s quotes compatible while retaining the real unknown-allowance guard",
    async (mode) => {
      const { env, processor } = environment();
      const fetch = unknownAccount();
      await expect(
        validateQuoteBudget(env, legacyHlsQuote(mode, false)),
      ).rejects.toMatchObject({ code: "budget_unknown" });
      expect(
        fetch.mock.calls.some(([url]) => url.endsWith("/containers/me")),
      ).toBe(true);
      expect(fetch.mock.calls.some(([url]) => url.endsWith("/graphql"))).toBe(
        true,
      );
      expect(processor).not.toHaveBeenCalled();
    },
  );
  it("binds exactly one separately owned MP4 and three copy-only upload attempts without trusting a missing probe", () => {
    expect(
      processingOutputBounds(video.source_size, "faststart", "source", null),
    ).toEqual({
      maxOutputBytes: video.source_size * 2,
      maxMediaObjects: 1,
      outputKind: "mp4",
      outputName: "optimized.mp4",
      encoding: "copy-only",
      maxUploadAttempts: 3,
    });
  });
  it("uses the documented actual PUT boundary and permits larger originals that still fit one output", () => {
    expect(R2_SINGLE_PUT_MAX_BYTES).toBe(5 * 1024 ** 3 - 5 * 1024 ** 2);
    expect(
      processingOutputBounds(3 * 1024 ** 3, "faststart", "source", null)
        .maxOutputBytes,
    ).toBe(R2_SINGLE_PUT_MAX_BYTES);
    expect(
      processingOutputBounds(
        R2_SINGLE_PUT_MAX_BYTES,
        "faststart",
        "source",
        null,
      ).maxOutputBytes,
    ).toBe(R2_SINGLE_PUT_MAX_BYTES);
    expect(() =>
      processingOutputBounds(
        R2_SINGLE_PUT_MAX_BYTES + 1,
        "faststart",
        "source",
        null,
      ),
    ).toThrow(expect.objectContaining({ code: "processing_single_put_limit" }));
  });
  it("rejects an impossible single-object source before account queries without changing upload eligibility", async () => {
    const large = { ...video, source_size: R2_SINGLE_PUT_MAX_BYTES + 1 };
    const { env, processor } = environment(large);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      quoteProcessing(env, large, { mode: "faststart", quality: "source" }),
    ).rejects.toMatchObject({ code: "processing_single_put_limit" });
    expect(fetch).not.toHaveBeenCalled();
    expect(processor).not.toHaveBeenCalled();
    expect(large.source_size).toBe(R2_SINGLE_PUT_MAX_BYTES + 1);
  });
  it.each(["720p", "1080p"])(
    "rejects faststart quality changes to %s without probing or reading cloud APIs",
    async (quality) => {
      const { env } = environment();
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        quoteProcessing(env, video, { mode: "faststart", quality }),
      ).rejects.toMatchObject({ code: "invalid_processing" });
      expect(env.MEDIA.head).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each(["faststart", "probe-remux", "transcode"] as const)(
    "covers all three full uploads plus control traffic for %s",
    (mode) => {
      const output = processingOutputBounds(
        video.source_size,
        mode,
        "source",
        mode === "transcode" ? 60 : null,
      );
      const resources = processingResourceAmounts(INSTANCES[0], {
        mode,
        totalTimeoutSeconds: 180,
        ...output,
      });
      expect(resources.containerEgressBytes).toBeGreaterThan(
        output.maxOutputBytes * 3,
      );
      expect(resources.r2ClassA).toBeGreaterThanOrEqual(
        output.maxMediaObjects * 3 + 2,
      );
      expect(resources.r2ClassB).toBeGreaterThanOrEqual(
        output.maxMediaObjects * 3,
      );
      expect(resources.r2CurrentBytes).toBe(output.maxOutputBytes);
      expect(resources.r2StorageGbMonths).toBe(output.maxOutputBytes / 1e9);
    },
  );
  it("covers both completion and publication structure reads and reserves the whole physical lifetime", () => {
    const output = processingOutputBounds(
      video.source_size,
      "faststart",
      "source",
      null,
    );
    const first = processingResourceAmounts(INSTANCES[0], {
      mode: "faststart",
      totalTimeoutSeconds: 180,
      ...output,
    });
    const longer = processingResourceAmounts(INSTANCES[0], {
      mode: "faststart",
      totalTimeoutSeconds: 360,
      ...output,
    });
    expect(first.r2ClassB).toBeGreaterThanOrEqual(2 * 261 + 3);
    expect(first.containerCpuSeconds).toBe(90);
    expect(first.containerMemoryByteSeconds).toBe(4 * 1024 ** 3 * 180);
    expect(first.containerDiskByteSeconds).toBe(8e9 * 180);
    expect(longer.containerCpuSeconds).toBe(first.containerCpuSeconds * 2);
    expect(longer.containerEgressBytes).toBeGreaterThan(
      first.containerEgressBytes,
    );
    expect(longer.doRequests).toBeGreaterThan(first.doRequests);
    expect(longer.r2StorageGbMonths).toBe(first.r2StorageGbMonths);
  });
  it("keeps unknown account evidence blocked even with a positive dollar setting and no trusted probe", async () => {
    const { env, processor } = environment();
    unknownAccount();
    await expect(
      quoteProcessing(env, video, { mode: "faststart", quality: "source" }),
    ).rejects.toMatchObject({ code: "budget_unknown" });
    expect(processor).not.toHaveBeenCalled();
  });
  it.each([
    { sourceKey: "videos/other/source/revision" },
    { sourceBytes: video.source_size + 1 },
    { outputKind: "hls" },
    { outputName: "index.m3u8" },
    { encoding: "h264-aac" },
    { maxMediaObjects: 2 },
    { maxUploadAttempts: 4 },
    { quality: "720p" },
    { maxOutputBytes: R2_SINGLE_PUT_MAX_BYTES + 1 },
  ])(
    "rejects altered faststart quote identity/scope before account reads: %s",
    async (change) => {
      const { env, processor } = environment();
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        validateQuoteBudget(env, quotePlan(change)),
      ).rejects.toMatchObject({ code: "quote_changed" });
      expect(fetch).not.toHaveBeenCalled();
      expect(processor).not.toHaveBeenCalled();
    },
  );
  it("rejects an omitted required metric or the former two-attempt egress allowance", async () => {
    const { env } = environment();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const baseline = JSON.parse(quotePlan().data_json)
      .resourceAmounts as Record<string, number>;
    const missing = { ...baseline };
    delete missing.r2ClassB;
    const oldEgress = {
      ...baseline,
      containerEgressBytes: video.source_size * 4,
    };
    for (const resourceAmounts of [missing, oldEgress])
      await expect(
        validateQuoteBudget(env, quotePlan({ resourceAmounts })),
      ).rejects.toMatchObject({ code: "quote_changed" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
