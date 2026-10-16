import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/billing", async (original) => ({
  ...(await original<typeof import("../src/billing")>()),
  quoteProcessing: vi.fn(),
  validateQuoteBudget: vi.fn(),
}));
vi.mock("../src/logs", () => ({ log: vi.fn(async () => {}) }));
import {
  INSTANCES,
  processingOutputBounds,
  processingResourceAmounts,
  quoteProcessing,
  validateQuoteBudget,
  type QuoteDraft,
  type UsageSnapshot,
} from "../src/billing";
import { createQuote, confirmProcessing } from "../src/jobs";
import { HttpError } from "../src/http";
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
const at = Date.parse("2026-10-14T06:00:00Z");
const sourceKey = "videos/video/source/revision";
function draft(): QuoteDraft {
  const output = processingOutputBounds(4372373, "faststart", "source", null);
  return {
    executionAllowed: true,
    executionBlockers: [],
    approvalPolicyVersion: 3,
    feePolicy: "verified-included-only",
    executionNextStep: "确认仅此任务",
    mode: "faststart",
    quality: "source",
    snapshotId: "offline-snapshot",
    periodStart: "2026-10-13T00:00:00Z",
    sourceRevision: "revision",
    sourceEtag: "fixture-etag",
    sourceKey,
    sourceBytes: 4372373,
    instance: INSTANCES[0],
    accountCapacity: {
      vcpu: 4,
      memoryBytes: 12 * 1024 ** 3,
      diskBytes: 20e9,
      checkedAt: at,
    },
    ...output,
    totalTimeoutSeconds: 180,
    resourceAmounts: processingResourceAmounts(INSTANCES[0], {
      mode: "faststart",
      totalTimeoutSeconds: 180,
      ...output,
    }),
    costUpperUsd: 1,
    expiresAt: at + 60000,
    codec: "copy-only fixture",
    audio: "copy-only fixture",
    estimatedSeconds: [0, 180],
    warnings: ["Offline job contract fixture; not an actual account quote."],
  };
}
function setup(probe: Record<string, unknown> | null = null) {
  vi.spyOn(Date, "now").mockReturnValue(at);
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  for (const migration of [
    "0001_initial.sql",
    "0002_imports.sql",
    "0003_deletion_items.sql",
    "0004_upload_approvals.sql",
  ])
    native.exec(
      readFileSync(
        new URL(`../migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  native
    .prepare(
      "INSERT INTO videos(id,title,source_key,source_size,source_etag,source_revision,source_name,status,probe_json,created_at,updated_at) VALUES('video','Offline fixture',?,4372373,'fixture-etag','revision','fixture.mp4','unprocessed',?,1,1)",
    )
    .run(sourceKey, probe ? JSON.stringify(probe) : null);
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
  const env = {
    DB: db,
    APP_ENV: "test",
    PROCESSING_ENABLED: "true",
    PROCESSOR: {
      idFromName: () => "offline-task",
      get: () => ({ fetch: dispatch }),
    },
  } as unknown as Env;
  vi.mocked(quoteProcessing).mockResolvedValue(draft());
  vi.mocked(validateQuoteBudget).mockResolvedValue({
    id: "offline-snapshot",
    periodStart: "2026-10-13T00:00:00Z",
    periodEnd: "2026-11-13T00:00:00Z",
    project: {
      storedBytes: 0,
      actualBytes: 0,
      reservedBytes: 0,
      ledgerValid: true,
    },
    policy: { storageLimitBytes: 10 * 1024 ** 3, monthlySpendLimitUsd: 0 },
  } as UsageSnapshot);
  return { native, env, dispatch };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
describe("faststart quote and job binding using actual SQLite and mocked account admission", () => {
  it.each([
    null,
    {
      durationSeconds: 60,
      width: 640,
      height: 480,
      videoCodec: "h264",
      audioCodec: "aac",
    },
  ])(
    "persists exact copy-only scope and any existing probe without starting a task: %s",
    async (probe) => {
      const f = setup(probe);
      const response = await createQuote(f.env, "video", {
        mode: "faststart",
        quality: "source",
      });
      expect(response.status).toBe(201);
      const { quote } = (await response.json()) as {
        quote: QuoteDraft & { id: string; probe?: unknown };
      };
      expect(quote).toMatchObject({
        mode: "faststart",
        quality: "source",
        outputKind: "mp4",
        outputName: "optimized.mp4",
        encoding: "copy-only",
        maxMediaObjects: 1,
        maxUploadAttempts: 3,
        sourceKey,
        sourceBytes: 4372373,
      });
      expect(quote.probe).toEqual(probe ?? undefined);
      const saved = f.native
        .prepare("SELECT mode,quality,data_json FROM quotes WHERE id=?")
        .get(quote.id)!;
      expect(saved).toMatchObject({ mode: "faststart", quality: "source" });
      expect(JSON.parse(saved.data_json as string)).toMatchObject({
        sourceKey,
        maxMediaObjects: 1,
        maxUploadAttempts: 3,
      });
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(
        f.native.prepare("SELECT COUNT(*) AS n FROM reservations").get()?.n,
      ).toBe(0);
    },
  );
  it("atomically creates one independent version/reservation and dispatches once under concurrent confirmation replay", async () => {
    const f = setup();
    const created = await createQuote(f.env, "video", {
      mode: "faststart",
      quality: "source",
    });
    const { quote } = (await created.json()) as { quote: { id: string } };
    const results = await Promise.all([
      confirmProcessing(f.env, quote.id),
      confirmProcessing(f.env, quote.id),
    ]);
    expect(
      results.every(
        (response) => response.status === 200 || response.status === 202,
      ),
    ).toBe(true);
    const job = f.native.prepare("SELECT * FROM jobs").get()!;
    const version = f.native.prepare("SELECT * FROM versions").get()!;
    expect(version).toMatchObject({
      mode: "faststart",
      quality: "source",
      state: "processing",
      task_id: job.id,
      manifest: null,
    });
    expect(version.prefix).toBe(`videos/video/versions/${version.id}/`);
    expect(
      f.native
        .prepare(
          "SELECT published,current_version_id,source_key,source_etag FROM videos",
        )
        .get(),
    ).toEqual({
      published: 0,
      current_version_id: null,
      source_key: sourceKey,
      source_etag: "fixture-etag",
    });
    expect(f.native.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(1);
    expect(
      f.native.prepare("SELECT COUNT(*) AS n FROM reservations").get()?.n,
    ).toBe(1);
    const reservation = f.native
      .prepare("SELECT state,amounts_json FROM reservations")
      .get()!;
    expect(reservation.state).toBe("active");
    expect(JSON.parse(reservation.amounts_json as string)).toEqual(
      draft().resourceAmounts,
    );
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect((await confirmProcessing(f.env, quote.id)).status).toBe(200);
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("cannot confirm faststart with processing disabled or unknown account evidence", async () => {
    const f = setup();
    const created = await createQuote(f.env, "video", {
      mode: "faststart",
      quality: "source",
    });
    const { quote } = (await created.json()) as { quote: { id: string } };
    f.env.PROCESSING_ENABLED = "false";
    await expect(confirmProcessing(f.env, quote.id)).rejects.toMatchObject({
      code: "processing_disabled",
    });
    expect(validateQuoteBudget).not.toHaveBeenCalled();
    f.env.PROCESSING_ENABLED = "true";
    vi.mocked(validateQuoteBudget).mockRejectedValue(
      new HttpError(503, "budget_unknown", "Offline unknown account evidence"),
    );
    await expect(confirmProcessing(f.env, quote.id)).rejects.toMatchObject({
      code: "budget_unknown",
    });
    expect(f.native.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(0);
    expect(
      f.native.prepare("SELECT COUNT(*) AS n FROM reservations").get()?.n,
    ).toBe(0);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
