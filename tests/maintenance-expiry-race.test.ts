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
const at = 1000;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Actual Coordinator queue, part/cancel handlers and original SQLite schema.
// R2 is a controlled local stub; no real object is uploaded or deleted.
function setup() {
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  for (const filename of [
    "0001_initial.sql",
    "0002_imports.sql",
    "0003_deletion_items.sql",
    "0004_upload_approvals.sql",
  ])
    native.exec(
      readFileSync(
        new URL(`../migrations/${filename}`, import.meta.url),
        "utf8",
      ),
    );
  native
    .prepare(
      "INSERT INTO videos(id,title,source_size,source_revision,source_name,status,created_at,updated_at) VALUES('video','Offline expiry fixture',16,'revision','fixture.mp4','uploading',1,1)",
    )
    .run();
  native
    .prepare(
      "INSERT INTO uploads(id,video_id,object_key,multipart_id,fingerprint,expected_size,state,reserved_bytes,expires_at,created_at,updated_at) VALUES('upload','video','videos/video/source/revision','multipart','offline',16,'uploading',16,1001,1,1)",
    )
    .run();
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
          return { results: prepared.all(...values) };
        },
        async run() {
          return statement.execute();
        },
        execute() {
          return { meta: { changes: Number(prepared.run(...values).changes) } };
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
  const partStarted = deferred<void>();
  const finishPart = deferred<void>();
  const cancellationQueued = deferred<void>();
  const abort = vi.fn(async () => {});
  const head = vi.fn(async () => null);
  const remove = vi.fn();
  const stored = new Map<string, unknown>();
  const storage = {
    async get(key: string) {
      return stored.get(key);
    },
    async put(key: string, value: unknown) {
      stored.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return stored.delete(key);
    },
  };
  const paths: string[] = [];
  let coordinator: Coordinator;
  const env = {
    DB: db,
    MEDIA: {
      head,
      delete: remove,
      resumeMultipartUpload: () => ({
        abort,
        async uploadPart() {
          partStarted.resolve();
          await finishPart.promise;
          return { etag: "offline-part" };
        },
      }),
    },
    COORDINATOR: {
      idFromName: () => "admission",
      get: () => ({
        fetch(input: string, init: RequestInit) {
          paths.push(new URL(input).pathname);
          const response = coordinator.fetch(new Request(input, init));
          cancellationQueued.resolve();
          return response;
        },
      }),
    },
  } as unknown as Env;
  coordinator = new Coordinator(
    { storage } as unknown as DurableObjectState,
    env,
  );
  const request = (route: string) =>
    coordinator.fetch(
      new Request(`https://internal/uploads/upload/${route}`, {
        method: "POST",
      }),
    );
  return {
    env,
    native,
    clock,
    coordinator,
    paths,
    request,
    abort,
    head,
    remove,
    partStarted: partStarted.promise,
    finishPart: () => finishPart.resolve(),
    cancellationQueued: cancellationQueued.promise,
    upload: () =>
      native.prepare("SELECT * FROM uploads WHERE id='upload'").get()!,
    reservation: () =>
      native
        .prepare("SELECT * FROM reservations WHERE id='reservation'")
        .get()!,
  };
}
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

describe("expiry cancellation rechecks under the real Coordinator queue", () => {
  it("does not abort a part that entered before expiry and renewed the upload before queued maintenance ran", async () => {
    const f = setup();
    const body = new Uint8Array(16);
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
    ]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    const part = f.coordinator.fetch(
      new Request("https://internal/uploads/upload/parts/1", {
        method: "PUT",
        body,
        headers: { "X-Part-SHA256": hash },
      }),
    );
    await f.partStarted;
    f.clock.mockReturnValue(at + 1000);
    const cleanup = cancelExpiredUploads(f.env);
    await f.cancellationQueued;
    f.finishPart();
    expect((await part).status).toBe(200);
    const summary = await cleanup;
    expect(f.upload().expires_at).toBeGreaterThan(Date.now());
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.upload()).toMatchObject({
      state: "uploading",
      reserved_bytes: 16,
    });
    expect(f.reservation().state).toBe("reserved");
    expect(summary).toMatchObject({
      attempted: 1,
      skipped: 1,
      cancelled: 0,
      failed: 0,
      timedOut: 0,
      statuses: { "200": 1 },
    });
    expect(f.paths).toEqual(["/uploads/upload/expire"]);
    expect(
      f.native.prepare("SELECT COUNT(*) AS n FROM upload_parts").get()!.n,
    ).toBe(1);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it.each([at, at + 1])(
    "returns explicit not-expired proof at the fresh deadline %s without R2 or ledger mutation",
    async (expiresAt) => {
      const f = setup();
      f.native
        .prepare("UPDATE uploads SET expires_at=? WHERE id='upload'")
        .run(expiresAt);
      const before = f.reservation();
      const response = await f.request("expire");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        skipped: true,
        notExpired: true,
        reason: "not_expired",
      });
      expect(f.reservation()).toEqual(before);
      expect(f.abort).not.toHaveBeenCalled();
      expect(f.head).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["complete", "multipart"],
    ["cancelled", "multipart"],
    ["expired", "multipart"],
    ["unknown", null],
    ["creating", ""],
  ])(
    "does not turn a stale %s selection into a manual cancellation",
    async (state, multipartId) => {
      const f = setup();
      f.native
        .prepare(
          "UPDATE uploads SET state=?,multipart_id=?,expires_at=1 WHERE id='upload'",
        )
        .run(state, multipartId);
      const before = f.reservation();
      const response = await f.request("expire");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        skipped: true,
        reason: "not_eligible",
      });
      expect(f.upload().state).toBe(state);
      expect(f.reservation()).toEqual(before);
      expect(f.abort).not.toHaveBeenCalled();
      expect(f.head).not.toHaveBeenCalled();
    },
  );

  it("still lets an explicit administrator cancellation abort an unexpired multipart", async () => {
    const f = setup();
    const response = await f.request("cancel");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      cancelled: true,
      abortVerified: true,
    });
    expect(f.abort).toHaveBeenCalledOnce();
    expect(f.upload()).toMatchObject({ state: "cancelled", reserved_bytes: 0 });
    expect(f.reservation().state).toBe("consumed");
  });

  it("retains an upload whose deadline cannot be read as a timestamp", async () => {
    const f = setup();
    f.native
      .prepare("UPDATE uploads SET expires_at='unverified' WHERE id='upload'")
      .run();
    const before = f.reservation();
    const response = await f.request("expire");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "abort_unverified" },
    });
    expect(f.upload().state).toBe("uploading");
    expect(f.reservation()).toEqual(before);
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.head).not.toHaveBeenCalled();
  });
});
