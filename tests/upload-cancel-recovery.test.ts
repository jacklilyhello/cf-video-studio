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
const sourceKey = "videos/video/source/revision";
const receiptKey = "upload-abort:upload";

function setup() {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  for (const filename of [
    "0001_initial.sql",
    "0002_imports.sql",
    "0003_deletion_items.sql",
  ])
    native.exec(
      readFileSync(
        new URL(`../migrations/${filename}`, import.meta.url),
        "utf8",
      ),
    );
  let failNextSql: string | undefined;
  let loseNextBatchResponse = false;
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
          if (failNextSql && sql.includes(failNextSql)) {
            failNextSql = undefined;
            throw new Error("Injected D1 write failure");
          }
          const result = prepared.run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
    async batch(statements: { execute(): unknown }[]) {
      native.exec("BEGIN IMMEDIATE");
      let results: unknown[];
      try {
        results = statements.map((statement) => statement.execute());
        native.exec("COMMIT");
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
      if (loseNextBatchResponse) {
        loseNextBatchResponse = false;
        throw new Error("Injected lost D1 commit response");
      }
      return results;
    },
  };
  native
    .prepare(
      "INSERT INTO videos(id,title,source_size,source_revision,source_name,status,created_at,updated_at) VALUES('video','Video',16,'revision','source.mp4','uploading',1,1)",
    )
    .run();
  native
    .prepare(
      "INSERT INTO uploads(id,video_id,object_key,multipart_id,fingerprint,expected_size,state,reserved_bytes,expires_at,created_at,updated_at) VALUES('upload','video',?,'multipart','fingerprint',16,'uploading',16,9999999999999,1,1)",
    )
    .run(sourceKey);
  native
    .prepare(
      "INSERT INTO reservations(id,owner_id,kind,amounts_json,state,created_at) VALUES('reservation','upload','upload',?,'reserved',1)",
    )
    .run(
      JSON.stringify({
        r2StorageGbMonths: 16 / 1e9,
        r2ClassA: 4,
        r2ClassB: 2,
        d1RowsRead: 100,
        d1RowsWritten: 100,
      }),
    );
  const completedObject = {
    key: sourceKey,
    size: 16,
    etag: "completed-source",
    customMetadata: {
      upload_id: "upload",
      video_id: "video",
      source_revision: "revision",
    },
  };
  let source: typeof completedObject | null = null;
  let aborted = false;
  const abort = vi.fn(async () => {
    if (aborted) throw new Error("Multipart no longer exists");
    aborted = true;
  });
  const head = vi.fn(async () => source);
  const remove = vi.fn();
  const evidence = new Map<string, Record<string, unknown>>();
  const receiptDeletes: string[] = [];
  const storage = {
    get: vi.fn(async (key: string) => {
      const value = evidence.get(key);
      return value === undefined ? undefined : structuredClone(value);
    }),
    put: vi.fn(async (key: string, value: Record<string, unknown>) => {
      evidence.set(key, structuredClone(value));
    }),
    delete: vi.fn(async (key: string) => {
      receiptDeletes.push(
        String(
          native.prepare("SELECT state FROM uploads WHERE id='upload'").get()
            ?.state,
        ),
      );
      return evidence.delete(key);
    }),
  };
  const env = {
    DB: db,
    MEDIA: {
      head,
      delete: remove,
      resumeMultipartUpload: vi.fn(() => ({ abort })),
    },
  } as unknown as Env;
  const coordinator = () =>
    new Coordinator({ storage } as unknown as DurableObjectState, env);
  const cancel = (instance = coordinator()) =>
    instance.fetch(
      new Request("https://coordinator/uploads/upload/cancel", {
        method: "POST",
      }),
    );
  const upload = () =>
    native
      .prepare(
        "SELECT state,reserved_bytes,error FROM uploads WHERE id='upload'",
      )
      .get();
  const reservation = () => {
    const row = native
      .prepare(
        "SELECT state,amounts_json FROM reservations WHERE id='reservation'",
      )
      .get()!;
    return {
      state: row.state,
      amounts: JSON.parse(row.amounts_json as string),
    };
  };
  return {
    native,
    env,
    cancel,
    coordinator,
    upload,
    reservation,
    evidence,
    storage,
    abort,
    head,
    remove,
    receiptDeletes,
    failFinalization() {
      failNextSql = "UPDATE reservations SET state='consumed'";
    },
    loseCommitResponse() {
      loseNextBatchResponse = true;
    },
    completeSource() {
      source = completedObject;
      return source;
    },
    underlyingAlreadyAborted() {
      aborted = true;
    },
  };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe("Coordinator durable upload-cancellation recovery with actual SQLite", () => {
  it("survives an abort success followed by a D1 rollback and a Coordinator restart without aborting again", async () => {
    const fixture = setup();
    fixture.failFinalization();
    expect((await fixture.cancel()).status).toBe(503);
    expect(fixture.upload()).toMatchObject({
      state: "cancelling",
      reserved_bytes: 16,
    });
    expect(fixture.reservation()).toMatchObject({
      state: "reserved",
      amounts: { r2StorageGbMonths: 16 / 1e9 },
    });
    expect(fixture.evidence.get(receiptKey)).toMatchObject({
      version: 1,
      uploadId: "upload",
      videoId: "video",
      objectKey: sourceKey,
      multipartId: "multipart",
      expectedBytes: 16,
      sourceRevision: "revision",
      abortVerified: true,
      objectAbsent: true,
    });
    expect(fixture.storage.delete).not.toHaveBeenCalled();
    expect((await fixture.cancel(fixture.coordinator())).status).toBe(200);
    expect(fixture.abort).toHaveBeenCalledOnce();
    expect(fixture.upload()).toMatchObject({
      state: "cancelled",
      reserved_bytes: 0,
      error: null,
    });
    expect(fixture.reservation()).toEqual({
      state: "consumed",
      amounts: {
        r2ClassA: 4,
        r2ClassB: 2,
        d1RowsRead: 100,
        d1RowsWritten: 100,
      },
    });
    expect(fixture.evidence.size).toBe(0);
    expect(fixture.receiptDeletes).toEqual(["cancelled"]);
    expect(fixture.remove).not.toHaveBeenCalled();
  });
  it.each([
    ["version", 2],
    ["uploadId", "other"],
    ["videoId", "other"],
    ["objectKey", "imports/other"],
    ["multipartId", "other"],
    ["expectedBytes", 15],
    ["sourceRevision", "other"],
    ["abortVerified", false],
    ["objectAbsent", false],
    ["verifiedAt", 0],
    ["verifiedAt", Number.MAX_SAFE_INTEGER],
  ])(
    "does not release a reservation using a receipt with mismatched %s",
    async (field, value) => {
      const fixture = setup();
      fixture.failFinalization();
      await fixture.cancel();
      fixture.evidence.get(receiptKey)![field as string] = value;
      expect((await fixture.cancel()).status).toBe(503);
      expect(fixture.upload()).toMatchObject({
        state: "cancelling",
        reserved_bytes: 16,
      });
      expect(fixture.reservation().state).toBe("reserved");
      expect(fixture.abort).toHaveBeenCalledOnce();
      expect(fixture.storage.delete).not.toHaveBeenCalled();
    },
  );
  it("rejects a receipt after the source revision in D1 changes", async () => {
    const fixture = setup();
    fixture.failFinalization();
    await fixture.cancel();
    fixture.native.exec(
      "UPDATE videos SET source_revision='new-revision' WHERE id='video'",
    );
    expect((await fixture.cancel()).status).toBe(503);
    expect(fixture.upload()?.reserved_bytes).toBe(16);
    expect(fixture.abort).toHaveBeenCalledOnce();
  });
  it.each(["initial recheck", "after receipt read"])(
    "protects an object that appears on %s rather than cancelling or deleting it",
    async (phase) => {
      const fixture = setup();
      fixture.failFinalization();
      await fixture.cancel();
      fixture.completeSource();
      if (phase === "after receipt read")
        fixture.head.mockResolvedValueOnce(null);
      const response = await fixture.cancel();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "already_complete" },
      });
      expect(fixture.upload()).toMatchObject({
        state: "complete",
        reserved_bytes: 0,
      });
      expect(
        fixture.native
          .prepare("SELECT source_key,source_etag FROM videos WHERE id='video'")
          .get(),
      ).toMatchObject({
        source_key: sourceKey,
        source_etag: "completed-source",
      });
      expect(fixture.reservation()).toMatchObject({
        state: "consumed",
        amounts: { r2StorageGbMonths: 16 / 1e9 },
      });
      expect(fixture.remove).not.toHaveBeenCalled();
      expect(fixture.abort).toHaveBeenCalledOnce();
      expect(fixture.storage.delete).not.toHaveBeenCalled();
    },
  );
  it("never treats an unknown abort or an absent object without a receipt as verified cancellation", async () => {
    const fixture = setup();
    fixture.underlyingAlreadyAborted();
    expect((await fixture.cancel()).status).toBe(503);
    expect(fixture.upload()).toMatchObject({
      state: "cancelling",
      reserved_bytes: 16,
    });
    expect(fixture.reservation().state).toBe("reserved");
    expect(fixture.evidence.size).toBe(0);
    expect(fixture.storage.put).not.toHaveBeenCalled();
  });
  it("protects a completed object observed after a fresh abort and does not write an absence receipt", async () => {
    const fixture = setup();
    fixture.completeSource();
    fixture.head.mockResolvedValueOnce(null);
    const response = await fixture.cancel();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "already_complete" },
    });
    expect(fixture.upload()?.state).toBe("complete");
    expect(fixture.reservation().amounts.r2StorageGbMonths).toBe(16 / 1e9);
    expect(fixture.storage.put).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });
  it("does not issue an abort or release storage when reading durable evidence fails", async () => {
    const fixture = setup();
    fixture.storage.get.mockRejectedValueOnce(
      new Error("Receipt read unavailable"),
    );
    expect((await fixture.cancel()).status).toBe(503);
    expect(fixture.upload()?.reserved_bytes).toBe(16);
    expect(fixture.reservation().state).toBe("reserved");
    expect(fixture.abort).not.toHaveBeenCalled();
    expect(fixture.storage.put).not.toHaveBeenCalled();
  });
  it("does not persist successful absence evidence when the post-abort HEAD fails", async () => {
    const fixture = setup();
    fixture.head
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("R2 HEAD unavailable"));
    expect((await fixture.cancel()).status).toBe(503);
    expect(fixture.upload()?.reserved_bytes).toBe(16);
    expect(fixture.reservation().state).toBe("reserved");
    expect(fixture.abort).toHaveBeenCalledOnce();
    expect(fixture.storage.put).not.toHaveBeenCalled();
  });
  it("retains the reservation if saving the receipt fails after the verified abort", async () => {
    const fixture = setup();
    fixture.storage.put.mockRejectedValueOnce(
      new Error("Receipt storage unavailable"),
    );
    expect((await fixture.cancel()).status).toBe(503);
    expect(fixture.upload()?.reserved_bytes).toBe(16);
    expect(fixture.reservation().state).toBe("reserved");
    expect(fixture.evidence.size).toBe(0);
    expect((await fixture.cancel()).status).toBe(503);
    expect(fixture.upload()?.reserved_bytes).toBe(16);
    expect(fixture.storage.delete).not.toHaveBeenCalled();
  });
  it("can recover a saved receipt whose acknowledgement was lost, while the failed first response releases nothing", async () => {
    const fixture = setup();
    fixture.storage.put.mockImplementationOnce(async (key, value) => {
      fixture.evidence.set(key, structuredClone(value));
      throw new Error("Lost receipt write response");
    });
    expect((await fixture.cancel()).status).toBe(503);
    expect(fixture.upload()?.reserved_bytes).toBe(16);
    expect((await fixture.cancel()).status).toBe(200);
    expect(fixture.abort).toHaveBeenCalledOnce();
    expect(fixture.upload()?.reserved_bytes).toBe(0);
  });
  it("keeps receipt evidence when a committed D1 response is lost and clears it only after replay reads cancelled", async () => {
    const fixture = setup();
    fixture.loseCommitResponse();
    expect((await fixture.cancel()).status).toBe(503);
    expect(fixture.upload()).toMatchObject({
      state: "cancelled",
      reserved_bytes: 0,
      error: null,
    });
    expect(fixture.evidence.size).toBe(1);
    expect(fixture.storage.delete).not.toHaveBeenCalled();
    expect((await fixture.cancel()).status).toBe(200);
    expect(fixture.evidence.size).toBe(0);
    expect(fixture.receiptDeletes).toEqual(["cancelled"]);
    expect(fixture.abort).toHaveBeenCalledOnce();
  });
  it("serializes two cancellations and keeps incurred operation reservations consumed once", async () => {
    const fixture = setup();
    const coordinator = fixture.coordinator();
    const responses = await Promise.all([
      fixture.cancel(coordinator),
      fixture.cancel(coordinator),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(fixture.abort).toHaveBeenCalledOnce();
    expect(fixture.storage.put).toHaveBeenCalledOnce();
    expect(fixture.reservation()).toEqual({
      state: "consumed",
      amounts: {
        r2ClassA: 4,
        r2ClassB: 2,
        d1RowsRead: 100,
        d1RowsWritten: 100,
      },
    });
    expect(
      fixture.native.prepare("SELECT COUNT(*) AS n FROM reservations").get()?.n,
    ).toBe(1);
    expect(
      fixture.native
        .prepare(
          "SELECT COUNT(*) AS n FROM logs WHERE stage='upload_abort_verified'",
        )
        .get()?.n,
    ).toBe(1);
    expect(fixture.receiptDeletes.every((state) => state === "cancelled")).toBe(
      true,
    );
  });
  it("treats receipt-cleanup failure as successful cancellation and retries only cleanup", async () => {
    const fixture = setup();
    fixture.storage.delete.mockRejectedValueOnce(
      new Error("Receipt cleanup unavailable"),
    );
    expect((await fixture.cancel()).status).toBe(200);
    expect(fixture.evidence.size).toBe(1);
    expect((await fixture.cancel()).status).toBe(200);
    expect(fixture.evidence.size).toBe(0);
    expect(fixture.abort).toHaveBeenCalledOnce();
  });
});
