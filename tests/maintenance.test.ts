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
import { cancelExpiredUploads } from "../src/maintenance";
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
  let beforeClaim: (() => void) | undefined;
  let claimPending = false;
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
          if (sql.includes("ON CONFLICT(key) DO UPDATE SET value=")) {
            beforeClaim?.();
            beforeClaim = undefined;
            if (claimPending) return new Promise<never>(() => {});
          }
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
        const results = statements.map((statement) => statement.execute());
        native.exec("COMMIT");
        return results;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const objects = new Map<string, Record<string, unknown>>();
  const failures = new Set<string>();
  const pending = new Set<string>();
  const abort = vi.fn(async (key: string) => {
    if (failures.has(key)) throw new Error("Injected unknown multipart state");
    if (pending.has(key)) await new Promise<never>(() => {});
  });
  const head = vi.fn(async (key: string) => objects.get(key) ?? null);
  const remove = vi.fn();
  const start = vi.fn();
  const evidence = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => evidence.get(key),
    put: async (key: string, value: unknown) => {
      evidence.set(key, structuredClone(value));
    },
    delete: async (key: string) => evidence.delete(key),
  };
  const responses = new Map<string, () => Promise<Response>>();
  let coordinator: Coordinator;
  const requests: { id: string; signal?: AbortSignal | null }[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const id = decodeURIComponent(new URL(input).pathname.split("/")[2]);
    requests.push({ id, signal: init?.signal });
    const response = responses.get(id);
    return response ? response() : coordinator.fetch(new Request(input, init));
  });
  const env = {
    DB: db,
    MEDIA: {
      head,
      delete: remove,
      resumeMultipartUpload: (key: string) => ({ abort: () => abort(key) }),
    },
    COORDINATOR: {
      idFromName: () => "admission",
      get: () => ({ fetch }),
    },
    PROCESSOR: { get: start, idFromName: start },
  } as unknown as Env;
  coordinator = new Coordinator(
    { storage } as unknown as DurableObjectState,
    env,
  );
  const key = (id: string) => `videos/video-${id}/source/revision-${id}`;
  function add(
    id: string,
    options: {
      state?: string;
      multipartId?: string | null;
      expiresAt?: number;
      completedObject?: boolean;
    } = {},
  ) {
    native
      .prepare(
        "INSERT INTO videos(id,title,source_size,source_revision,source_name,status,created_at,updated_at) VALUES(?,?,16,?,?,'uploading',1,1)",
      )
      .run(`video-${id}`, id, `revision-${id}`, `${id}.mp4`);
    native
      .prepare(
        "INSERT INTO uploads(id,video_id,object_key,multipart_id,fingerprint,expected_size,state,reserved_bytes,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,16,?,16,?,1,1)",
      )
      .run(
        id,
        `video-${id}`,
        key(id),
        options.multipartId === undefined
          ? `multipart-${id}`
          : options.multipartId,
        `fingerprint-${id}`,
        options.state ?? "uploading",
        options.expiresAt ?? 1,
      );
    native
      .prepare(
        "INSERT INTO reservations(id,owner_id,kind,amounts_json,state,created_at) VALUES(?,?,'upload',?,'reserved',1)",
      )
      .run(
        `reservation-${id}`,
        id,
        JSON.stringify({ r2StorageGbMonths: 16 / 1e9, r2ClassA: 4 }),
      );
    native
      .prepare(
        "INSERT INTO versions(id,video_id,prefix,state,mode,quality,manifest,bytes,timeline_id,validation_json,created_at) VALUES(?,?,?,'success','probe-remux','source','index.m3u8',12,?,'{\"valid\":true}',1)",
      )
      .run(
        `version-${id}`,
        `video-${id}`,
        `videos/video-${id}/versions/version-${id}/`,
        `timeline-${id}`,
      );
    if (options.completedObject)
      objects.set(key(id), {
        key: key(id),
        size: 16,
        etag: `etag-${id}`,
        customMetadata: {
          upload_id: id,
          video_id: `video-${id}`,
          source_revision: `revision-${id}`,
        },
      });
  }
  const upload = (id: string) =>
    native.prepare("SELECT * FROM uploads WHERE id=?").get(id)!;
  const reservation = (id: string) =>
    native.prepare("SELECT * FROM reservations WHERE owner_id=?").get(id)!;
  const logs = () =>
    native
      .prepare("SELECT * FROM logs WHERE stage='upload_expiry_cleanup'")
      .all();
  const oldVersions = () => native.prepare("SELECT * FROM versions").all();
  return {
    native,
    env,
    add,
    upload,
    reservation,
    key,
    failures,
    pending,
    requests,
    responses,
    abort,
    head,
    remove,
    start,
    logs,
    oldVersions,
    pendingClaim() {
      claimPending = true;
    },
    raceClaim() {
      beforeClaim = () =>
        native
          .prepare(
            "INSERT INTO settings VALUES('upload_cleanup_cursor','other-run',1)",
          )
          .run();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe("fair bounded expiry maintenance through actual SQLite and Coordinator", () => {
  it("advances a durable cursor beyond ten repeatedly unverifiable cancels", async () => {
    const fixture = setup();
    for (let i = 0; i < 10; i++) {
      const id = String(i).padStart(3, "0");
      fixture.add(id, { state: "cancelling" });
      fixture.failures.add(fixture.key(id));
    }
    fixture.add("010");
    const versions = fixture.oldVersions();
    expect(await cancelExpiredUploads(fixture.env)).toMatchObject({
      attempted: 10,
      failed: 10,
      cancelled: 0,
      statuses: { "503": 10 },
    });
    expect(fixture.upload("010").state).toBe("uploading");
    expect(
      fixture.native
        .prepare("SELECT value FROM settings WHERE key='upload_cleanup_cursor'")
        .get()?.value,
    ).toBe("009");
    expect(await cancelExpiredUploads(fixture.env)).toMatchObject({
      attempted: 10,
      cancelled: 1,
      failed: 9,
    });
    expect(fixture.requests[10].id).toBe("010");
    expect(fixture.upload("010")).toMatchObject({
      state: "cancelled",
      reserved_bytes: 0,
    });
    expect(fixture.upload("000").reserved_bytes).toBe(16);
    expect(fixture.reservation("000").state).toBe("reserved");
    expect(fixture.oldVersions()).toEqual(versions);
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("covers completing and known creating/unknown while retaining unknown multipart reservations", async () => {
    const fixture = setup();
    fixture.add("a-completing", { state: "completing" });
    fixture.add("b-unknown", { state: "unknown" });
    fixture.add("c-creating", { state: "creating" });
    fixture.add("d-unknown-id", { state: "unknown", multipartId: null });
    fixture.add("e-creating-id", { state: "creating", multipartId: "" });
    fixture.add("f-uploading-id", { multipartId: null });
    fixture.add("g-not-expired", { expiresAt: Date.now() + 60000 });
    fixture.add("h-complete", { state: "complete" });
    expect(await cancelExpiredUploads(fixture.env)).toMatchObject({
      attempted: 4,
      cancelled: 3,
      failed: 1,
      statuses: { "200": 3, "409": 1 },
    });
    for (const id of ["a-completing", "b-unknown", "c-creating"])
      expect(fixture.upload(id)).toMatchObject({
        state: "cancelled",
        reserved_bytes: 0,
      });
    for (const id of ["d-unknown-id", "e-creating-id", "f-uploading-id"])
      expect(fixture.reservation(id).state).toBe("reserved");
    expect(fixture.requests.map((request) => request.id)).toEqual([
      "a-completing",
      "b-unknown",
      "c-creating",
      "f-uploading-id",
    ]);
    expect(fixture.abort).toHaveBeenCalledTimes(3);
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("records already-completed protection separately and restores the original without deleting HLS", async () => {
    const fixture = setup();
    fixture.add("completed", { state: "completing", completedObject: true });
    const versions = fixture.oldVersions();
    expect(await cancelExpiredUploads(fixture.env)).toMatchObject({
      attempted: 1,
      completedProtected: 1,
      failed: 0,
      cancelled: 0,
      statuses: { "409": 1 },
    });
    expect(fixture.upload("completed").state).toBe("complete");
    expect(
      fixture.native
        .prepare("SELECT source_key,source_etag FROM videos WHERE id=?")
        .get("video-completed"),
    ).toEqual({
      source_key: fixture.key("completed"),
      source_etag: "etag-completed",
    });
    expect(fixture.logs()[0].level).toBe("info");
    expect(fixture.oldVersions()).toEqual(versions);
    expect(fixture.abort).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("summarizes non-2xx without copying response secrets or treating them as a cancellation", async () => {
    const fixture = setup();
    fixture.add("failed");
    fixture.responses.set("failed", async () =>
      Response.json(
        { error: { code: "token=do-not-log", message: "private-object-path" } },
        { status: 503 },
      ),
    );
    expect(await cancelExpiredUploads(fixture.env)).toMatchObject({
      attempted: 1,
      failed: 1,
      cancelled: 0,
      statuses: { "503": 1 },
    });
    expect(fixture.reservation("failed").state).toBe("reserved");
    expect(fixture.upload("failed").reserved_bytes).toBe(16);
    const logs = fixture.logs();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("warn");
    expect(logs[0].details_json).toContain('"failed":1');
    expect(JSON.stringify(logs)).not.toMatch(/do-not-log|private-object-path/);
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("bounds a truly pending Coordinator abort and keeps its unverified reservation", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    fixture.add("pending");
    fixture.pending.add(fixture.key("pending"));
    const versions = fixture.oldVersions();
    const cleanup = cancelExpiredUploads(fixture.env);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fixture.upload("pending").state).toBe("cancelling");
    expect(fixture.logs()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await cleanup).toMatchObject({
      attempted: 1,
      failed: 1,
      timedOut: 1,
      cancelled: 0,
    });
    expect(fixture.requests[0].signal?.aborted).toBe(true);
    expect(fixture.upload("pending").reserved_bytes).toBe(16);
    expect(fixture.reservation("pending").state).toBe("reserved");
    expect(fixture.oldVersions()).toEqual(versions);
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("includes a pending response body in the request timeout and cancels the reader", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    fixture.add("pending-body");
    const cancel = vi.fn();
    fixture.responses.set(
      "pending-body",
      async () => new Response(new ReadableStream({ cancel })),
    );
    const cleanup = cancelExpiredUploads(fixture.env);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await cleanup).toMatchObject({ failed: 1, timedOut: 1 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.reservation("pending-body").state).toBe("reserved");
  });

  it.each([
    { cancelled: true },
    { skipped: true },
    { skipped: true, reason: "not_expired" },
    { skipped: true, notExpired: true, reason: "unknown" },
  ])(
    "does not accept incomplete cancellation/skip evidence %j",
    async (acknowledgement) => {
      const fixture = setup();
      fixture.add("unverified");
      fixture.responses.set("unverified", async () =>
        Response.json(acknowledgement),
      );
      expect(await cancelExpiredUploads(fixture.env)).toMatchObject({
        attempted: 1,
        failed: 1,
        cancelled: 0,
        skipped: 0,
      });
      expect(fixture.reservation("unverified").state).toBe("reserved");
    },
  );

  it("discards a response arriving after timeout without consuming it as cancellation proof", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    fixture.add("late-response");
    let resolve!: (response: Response) => void;
    fixture.responses.set(
      "late-response",
      () => new Promise<Response>((accept) => (resolve = accept)),
    );
    const cleanup = cancelExpiredUploads(fixture.env);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await cleanup).toMatchObject({
      failed: 1,
      timedOut: 1,
      cancelled: 0,
    });
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.logs()).toHaveLength(1);
    expect(fixture.reservation("late-response").state).toBe("reserved");
  });

  it("does not dispatch when the persisted cursor claim has not settled", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    fixture.add("control-pending");
    fixture.pendingClaim();
    const cleanup = cancelExpiredUploads(fixture.env);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await cleanup).toMatchObject({
      attempted: 0,
      controlFailed: true,
    });
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.reservation("control-pending").state).toBe("reserved");
    expect(fixture.logs()[0].level).toBe("warn");
  });

  it("skips a stale overlapping scan when another run moved the durable cursor", async () => {
    const fixture = setup();
    fixture.add("claim-race");
    fixture.raceClaim();
    expect(await cancelExpiredUploads(fixture.env)).toMatchObject({
      attempted: 0,
      controlFailed: false,
    });
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.reservation("claim-race").state).toBe("reserved");
  });
});
