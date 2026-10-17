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

import { Processor } from "../src/processor";
import {
  INSTANCES,
  processingOutputBounds,
  processingResourceAmounts,
} from "../src/billing";
import type { Env } from "../src/types";

interface NativeStatement {
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
const at = Date.parse("2026-10-14T12:00:00Z");
const neverIncurred = [
  "containerCpuSeconds",
  "containerMemoryByteSeconds",
  "containerDiskByteSeconds",
  "containerEgressBytes",
  "r2CurrentBytes",
  "r2StorageGbMonths",
];

// Real Processor.fetch/alarms and original SQLite migrations, with only local
// Container/R2 stubs. No image, FFmpeg, or remote account operation is started.
async function fixture(
  fault?:
    | "image"
    | "bridge"
    | "unknown-stop"
    | "unexpected-running"
    | "image-running",
) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
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
  const output = processingOutputBounds(1024, "faststart", "source", null);
  const instance = INSTANCES[0];
  const plan = {
    mode: "faststart",
    quality: "source",
    sourceKey: "videos/video/source/revision",
    sourceBytes: 1024,
    sourceRevision: "revision",
    sourceEtag: "source-etag",
    ...output,
    totalTimeoutSeconds: 180,
    instance,
    resourceAmounts: processingResourceAmounts(instance, {
      mode: "faststart",
      ...output,
      totalTimeoutSeconds: 180,
    }),
  };
  native
    .prepare(
      "INSERT INTO videos(id,title,source_key,source_size,source_etag,source_revision,source_name,status,created_at,updated_at) VALUES('video','Offline accounting fixture',?,1024,'source-etag','revision','fixture.mp4','unprocessed',?,?)",
    )
    .run(plan.sourceKey, at, at);
  native
    .prepare(
      "INSERT INTO quotes(id,video_id,source_revision,source_etag,mode,quality,period_start,expires_at,state,data_json,created_at) VALUES('quote','video','revision','source-etag','faststart','source','2026-10-13T00:00:00Z',?,'confirmed',?,?)",
    )
    .run(at + 60000, JSON.stringify(plan), at);
  native
    .prepare(
      "INSERT INTO versions(id,video_id,task_id,prefix,state,mode,quality,timeline_id,created_at) VALUES('version','video','task','videos/video/versions/version/','processing','faststart','source','version',?)",
    )
    .run(at);
  native
    .prepare(
      "INSERT INTO jobs(id,video_id,version_id,quote_id,state,stage,created_at,updated_at) VALUES('task','video','version','quote','queued','queued',?,?)",
    )
    .run(at, at);
  native
    .prepare(
      "INSERT INTO reservations(id,owner_id,kind,period_start,amounts_json,state,created_at) VALUES('reservation','task','processing','2026-10-13T00:00:00Z',?,'active',?)",
    )
    .run(JSON.stringify(plan.resourceAmounts), at);
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
        const results = statements.map((statement) => statement.execute());
        native.exec("COMMIT");
        return results;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
  };
  let running = fault === "unexpected-running" || fault === "image-running";
  const container = {
    get running() {
      return running;
    },
    images:
      fault === "image" || fault === "unknown-stop" || fault === "image-running"
        ? {}
        : { processor: "offline-image" },
    start: vi.fn(() => {
      running = true;
    }),
    signal: vi.fn(),
    destroy: vi.fn(async () => {
      running = false;
    }),
    inspect: vi.fn(async () =>
      fault === "unknown-stop"
        ? { image: "unverified-image" }
        : running
          ? { image: "offline-image" }
          : null,
    ),
    interceptOutboundHttp: vi.fn(async () => {
      if (fault === "bridge") throw new Error("Offline bridge failure");
    }),
    setInactivityTimeout: vi.fn(async () => {}),
    monitor: vi.fn(() => new Promise<void>(() => {})),
    getTcpPort: vi.fn(() => ({
      fetch: vi.fn(async () => Response.json({ accepted: true })),
    })),
  };
  const stored = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => stored.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      stored.set(key, structuredClone(value));
    }),
    setAlarm: vi.fn(async (_time: number) => {}),
    deleteAlarm: vi.fn(async () => {}),
  };
  let initialization: Promise<unknown> = Promise.resolve();
  const ctx = {
    id: { toString: () => "offline-do" },
    container,
    storage,
    exports: { TaskBridge: () => ({}) },
    waitUntil: vi.fn(),
    blockConcurrencyWhile(callback: () => Promise<unknown>) {
      initialization = callback();
      return initialization;
    },
  } as unknown as DurableObjectState;
  const env = {
    DB: db,
    MEDIA: { head: vi.fn(async () => ({ size: 1024, etag: "source-etag" })) },
    PROCESSOR: { idFromName: () => ({ toString: () => "offline-do" }) },
    PROCESSING_ENABLED: "true",
  } as unknown as Env;
  let processor = new Processor(ctx, env);
  await initialization;
  return {
    plan,
    native,
    processor,
    container,
    storage,
    stored,
    env,
    clock,
    stopPhysically: () => {
      running = false;
    },
    restart: async () => {
      processor = new Processor(ctx, env);
      await initialization;
      return processor;
    },
    request: (route: string) =>
      processor.fetch(
        new Request(`https://processor/${route}`, {
          method: "POST",
          body: JSON.stringify({ jobId: "task" }),
        }),
      ),
    reservation: () =>
      native
        .prepare("SELECT * FROM reservations WHERE id='reservation'")
        .get()!,
    job: () => native.prepare("SELECT * FROM jobs WHERE id='task'").get()!,
  };
}
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

describe("processing accounting across proven pre-start failure", () => {
  it.each(["unexpected-running", "image-running"] as const)(
    "retains unknown Container estimates for a pre-existing running instance after %s",
    async (fault) => {
      const f = await fixture(fault);
      expect((await f.request("start")).status).toBe(502);
      expect(f.container.start).not.toHaveBeenCalled();
      expect(f.reservation().state).toBe("active");
      expect(JSON.parse(String(f.reservation().amounts_json))).toEqual(
        f.plan.resourceAmounts,
      );
      expect(f.stored.get("lifecycle")).toMatchObject({
        unattributedContainerObserved: { observedAt: at, source: "running" },
      });
      f.clock.mockReturnValue(at + 2000);
      await f.processor.alarm();
      expect(f.container.destroy).toHaveBeenCalledOnce();
      expect(f.job()).toMatchObject({ state: "failed", stop_verified: 1 });
      expect(f.reservation().state).toBe("consumed");
      const amounts = JSON.parse(String(f.reservation().amounts_json));
      for (const [key, amount] of Object.entries(f.plan.resourceAmounts))
        expect(amounts[key], key).toBe(
          ["r2CurrentBytes", "r2StorageGbMonths"].includes(key) ? 0 : amount,
        );
      expect(JSON.parse(String(f.job().consumption_json))).toMatchObject({
        officialRecorded: false,
        wallSeconds: null,
        cpuVcpuSecondsUpper: null,
        memoryGibSecondsUpper: null,
        diskGbSecondsUpper: null,
        containerUsageStatus: "unknown_unattributed_instance",
        source: "unattributed_container_usage_unknown_quote_estimate_retained",
        retainedContainerQuoteIsUsageUpperBound: false,
        networkEgressEstimateBytes: f.plan.resourceAmounts.containerEgressBytes,
      });
      expect(JSON.parse(String(f.job().stop_evidence_json))).toMatchObject({
        running: false,
        inspection: null,
        unattributedContainerObserved: { observedAt: at, source: "running" },
      });
    },
  );

  it("retains non-null inspect evidence across restart even if running was false and later inspection is null", async () => {
    const f = await fixture("unknown-stop");
    expect((await f.request("start")).status).toBe(502);
    expect(f.container.start).not.toHaveBeenCalled();
    expect(f.job()).toMatchObject({
      state: "stop_unverified",
      stop_verified: 0,
    });
    expect(f.reservation().state).toBe("active");
    expect(f.stored.get("lifecycle")).toMatchObject({
      unattributedContainerObserved: { observedAt: at, source: "inspection" },
    });
    f.container.inspect.mockResolvedValue(null);
    const restarted = await f.restart();
    f.clock.mockReturnValue(at + 5000);
    await restarted.alarm();
    expect(f.job()).toMatchObject({ state: "failed", stop_verified: 1 });
    expect(f.reservation().state).toBe("consumed");
    const amounts = JSON.parse(String(f.reservation().amounts_json));
    for (const [key, amount] of Object.entries(f.plan.resourceAmounts))
      expect(amounts[key], key).toBe(
        ["r2CurrentBytes", "r2StorageGbMonths"].includes(key) ? 0 : amount,
      );
    expect(JSON.parse(String(f.job().consumption_json))).toMatchObject({
      wallSeconds: null,
      containerUsageStatus: "unknown_unattributed_instance",
      unattributedContainerObserved: { observedAt: at, source: "inspection" },
    });
    expect(f.container.start).not.toHaveBeenCalled();
  });

  it.each(["image", "bridge"] as const)(
    "retains incurred control/operation estimates after %s failure without a Container start",
    async (fault) => {
      const f = await fixture(fault);
      expect((await f.request("start")).status).toBe(502);
      expect(f.container.start).not.toHaveBeenCalled();
      expect(f.env.MEDIA.head).toHaveBeenCalledOnce();
      expect(f.job()).toMatchObject({ state: "failed", stop_verified: 1 });
      const reservation = f.reservation();
      expect(reservation.state).toBe("consumed");
      const amounts = JSON.parse(String(reservation.amounts_json));
      for (const [key, amount] of Object.entries(f.plan.resourceAmounts))
        expect(amounts[key], key).toBe(
          neverIncurred.includes(key) ? 0 : amount,
        );
      expect(amounts.r2ClassB).toBeGreaterThan(0);
      expect(amounts.d1RowsWritten).toBeGreaterThan(0);
      expect(amounts.doStorageGbMonths).toBeGreaterThan(0);
      const consumption = JSON.parse(String(f.job().consumption_json));
      expect(consumption).toMatchObject({
        officialRecorded: false,
        wallSeconds: 0,
        networkEgressEstimateBytes: 0,
        operationsSource: "retained_quote_bound_not_official_metering",
      });
      // The real finalization SQL/log has already performed database work.
      expect(f.native.prepare("SELECT COUNT(*) AS n FROM logs").get()!.n).toBe(
        1,
      );
    },
  );

  it("retains operations when cancelling a confirmed job before dispatch and keeps repeated verification idempotent", async () => {
    const f = await fixture();
    expect((await f.request("cancel")).status).toBe(200);
    expect(f.container.start).not.toHaveBeenCalled();
    expect(f.job()).toMatchObject({ state: "cancelled", stop_verified: 1 });
    expect(f.reservation().state).toBe("consumed");
    const before = f.reservation();
    const amounts = JSON.parse(String(before.amounts_json));
    expect(amounts.r2ClassA).toBe(f.plan.resourceAmounts.r2ClassA);
    expect(amounts.d1RowsRead).toBe(f.plan.resourceAmounts.d1RowsRead);
    expect(amounts.doRequests).toBe(f.plan.resourceAmounts.doRequests);
    expect(amounts.r2CurrentBytes).toBe(0);
    f.clock.mockReturnValue(at + 10000);
    expect((await f.request("cancel")).status).toBe(200);
    await f.processor.alarm();
    expect(f.reservation()).toEqual(before);
    expect(
      f.native.prepare("SELECT COUNT(*) AS n FROM reservations").get()!.n,
    ).toBe(1);
  });

  it("keeps the entire active reservation until physical absence is proven", async () => {
    const f = await fixture("unknown-stop");
    expect((await f.request("start")).status).toBe(502);
    expect(f.job()).toMatchObject({
      state: "stop_unverified",
      stop_verified: 0,
    });
    expect(f.reservation().state).toBe("active");
    expect(JSON.parse(String(f.reservation().amounts_json))).toEqual(
      f.plan.resourceAmounts,
    );
    expect(f.storage.setAlarm).toHaveBeenCalled();
    f.container.inspect.mockResolvedValue(null);
    f.clock.mockReturnValue(at + 5000);
    await f.processor.alarm();
    expect(f.job()).toMatchObject({ state: "failed", stop_verified: 1 });
    expect(f.reservation().state).toBe("consumed");
    expect(JSON.parse(String(f.reservation().amounts_json)).doRowsWritten).toBe(
      f.plan.resourceAmounts.doRowsWritten,
    );
  });

  it("preserves started-task accounting using observed wall time and retained operation/output bounds", async () => {
    const f = await fixture();
    expect((await f.request("start")).status).toBe(202);
    expect(f.container.start).toHaveBeenCalledOnce();
    f.clock.mockReturnValue(at + 10000);
    f.stopPhysically();
    expect((await f.request("cancel")).status).toBe(200);
    const amounts = JSON.parse(String(f.reservation().amounts_json));
    expect(f.reservation().state).toBe("consumed");
    expect(amounts.containerCpuSeconds).toBe(f.plan.instance.vcpu * 10);
    expect(amounts.containerMemoryByteSeconds).toBe(
      f.plan.instance.memoryBytes * 10,
    );
    expect(amounts.containerDiskByteSeconds).toBe(
      f.plan.instance.diskBytes * 10,
    );
    for (const key of [
      "containerEgressBytes",
      "r2CurrentBytes",
      "r2StorageGbMonths",
      "r2ClassA",
      "d1RowsWritten",
      "doRequests",
    ])
      expect(amounts[key], key).toBe(f.plan.resourceAmounts[key]);
  });
});
