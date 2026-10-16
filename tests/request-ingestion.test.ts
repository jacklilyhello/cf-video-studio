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
import { login } from "../src/auth";
import {
  body,
  forwardRequestBody,
  readRequestBytes,
  sha256,
} from "../src/http";
import { PART_BYTES } from "../src/uploads";
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
const bytes = new Uint8Array(16).fill(7);
const digest = await sha256(bytes);
const controllers: AbortController[] = [];
function request(
  path: string,
  content?: BodyInit,
  signal?: AbortSignal,
  headers: HeadersInit = {},
  method = "POST",
) {
  return new Request(`https://coordinator${path}`, {
    method,
    headers,
    body: content,
    signal,
    duplex: "half",
  } as RequestInit);
}
function pendingStream() {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const content = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
    cancel,
  });
  const abort = new AbortController();
  controllers.push(abort);
  return { content, stream, cancel, abort };
}
function part(
  content: BodyInit = bytes,
  signal?: AbortSignal,
  uploadId = "upload",
  checksum = digest,
  extra: HeadersInit = {},
) {
  return request(
    `/uploads/${uploadId}/parts/1`,
    content,
    signal,
    {
      "X-Part-SHA256": checksum,
      ...extra,
    },
    "PUT",
  );
}
function setup() {
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
  for (const id of ["upload", "second"]) {
    native
      .prepare(
        "INSERT INTO videos(id,title,source_size,source_revision,source_name,status,created_at,updated_at) VALUES(?,?,16,'revision','source.mp4','uploading',1,1)",
      )
      .run(id, id);
    native
      .prepare(
        "INSERT INTO uploads(id,video_id,object_key,multipart_id,fingerprint,expected_size,state,reserved_bytes,expires_at,created_at,updated_at) VALUES(?,?,?,'multipart','fingerprint',16,'uploading',16,9999999999999,1,1)",
      )
      .run(id, id, `videos/${id}/source/revision`);
    native
      .prepare(
        "INSERT INTO reservations(id,owner_id,kind,amounts_json,state,created_at) VALUES(?,?,'upload',?,'reserved',1)",
      )
      .run(
        id,
        id,
        JSON.stringify({ r2StorageGbMonths: 16 / 1e9, r2ClassA: 4 }),
      );
  }
  const uploadPart = vi.fn(async (_number: number, _content: Uint8Array) => ({
    etag: "fixture-part",
  }));
  const abort = vi.fn(async () => {});
  const head = vi.fn(async () => null);
  const stored = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => stored.get(key),
    put: async (key: string, value: unknown) => {
      stored.set(key, structuredClone(value));
    },
    delete: async (key: string) => stored.delete(key),
    getAlarm: async () => Date.now() + 60000,
    setAlarm: async () => {},
  };
  const env = {
    DB: db,
    MEDIA: { head, resumeMultipartUpload: () => ({ uploadPart, abort }) },
    APP_ENV: "test",
    ADMIN_PASSWORD: "offline-request-fixture-password",
    SESSION_SECRET: "offline-request-fixture-session-key-over-32-characters",
  } as unknown as Env;
  const coordinator = new Coordinator(
    { storage } as unknown as DurableObjectState,
    env,
  );
  env.COORDINATOR = {
    idFromName: () => "admission",
    get: () => ({
      fetch: (input: Request | string, init?: RequestInit) =>
        coordinator.fetch(
          typeof input === "string" ? new Request(input, init) : input,
        ),
    }),
  } as unknown as DurableObjectNamespace;
  return {
    native,
    coordinator,
    uploadPart,
    abort,
    head,
    async outer(path: string, content?: BodyInit, headers: HeadersInit = {}) {
      const signedIn = await login(
        request(
          "/api/admin/login",
          JSON.stringify({ password: env.ADMIN_PASSWORD }),
          undefined,
          { Origin: "https://coordinator" },
        ),
        env,
      );
      const cookie = signedIn.headers.get("Set-Cookie")!.split(";")[0];
      return worker.fetch(
        request(
          path,
          content,
          undefined,
          { Origin: "https://coordinator", Cookie: cookie, ...headers },
          path.includes("/parts/") ? "PUT" : "POST",
        ),
        env,
        {
          waitUntil: (promise: Promise<unknown>) => {
            void promise.catch(() => {});
          },
        } as ExecutionContext,
      );
    },
    rate: () =>
      coordinator.fetch(
        request(
          "/rate",
          JSON.stringify({ key: "local-test", limit: 10, windowMs: 60000 }),
        ),
      ),
    upload: () =>
      native
        .prepare("SELECT state,reserved_bytes FROM uploads WHERE id='upload'")
        .get(),
    reservation: () =>
      native
        .prepare(
          "SELECT state,amounts_json FROM reservations WHERE id='upload'",
        )
        .get(),
  };
}
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("bounded request ingestion outside the Coordinator mutation queue", () => {
  it("closes unused forwarded cancellation input without awaiting its source cancellation", async () => {
    const f = setup();
    const incoming = pendingStream();
    incoming.stream.enqueue(new TextEncoder().encode("{"));
    const response = await f.outer(
      "/api/admin/uploads/upload/cancel",
      incoming.content,
    );
    expect(response.status).toBe(200);
    expect(incoming.cancel).toHaveBeenCalledOnce();
    expect(f.upload()).toMatchObject({ state: "cancelled", reserved_bytes: 0 });
    expect(f.uploadPart).not.toHaveBeenCalled();
    expect((await f.rate()).status).toBe(200);
  });
  it("stops outer forwarding when two occupied slots reject the third body early", async () => {
    const f = setup();
    const a = pendingStream(),
      b = pendingStream(),
      rejected = pendingStream();
    const first = f.coordinator.fetch(part(a.content, a.abort.signal));
    const second = f.coordinator.fetch(part(b.content, b.abort.signal));
    const response = await f.outer(
      "/api/admin/uploads/upload/parts/1",
      rejected.content,
      { "X-Part-SHA256": digest },
    );
    expect(response.status).toBe(429);
    expect(rejected.cancel).toHaveBeenCalledOnce();
    expect(f.uploadPart).not.toHaveBeenCalled();
    expect(f.reservation()?.state).toBe("reserved");
    a.abort.abort();
    b.abort.abort();
    expect((await first).status).toBe(408);
    expect((await second).status).toBe(408);
    expect((await f.rate()).status).toBe(200);
  });
  it("enforces original Content-Length and valid actual bytes in Node 22 before forwarding oversized parts", async () => {
    const f = setup();
    const incoming = pendingStream();
    const rejected = await f.outer(
      "/api/admin/uploads/upload/parts/1",
      incoming.content,
      { "X-Part-SHA256": digest, "Content-Length": String(PART_BYTES + 1) },
    );
    expect(rejected.status).toBe(413);
    expect(incoming.cancel).not.toHaveBeenCalled();
    expect(f.uploadPart).not.toHaveBeenCalled();
    expect(f.reservation()?.state).toBe("reserved");
    const accepted = await f.outer("/api/admin/uploads/upload/parts/1", bytes, {
      "X-Part-SHA256": digest,
      "Content-Length": "16",
    });
    expect(accepted.status).toBe(200);
    expect(f.uploadPart).toHaveBeenCalledOnce();
    expect(
      f.native.prepare("SELECT size,sha256 FROM upload_parts").get(),
    ).toMatchObject({ size: 16, sha256: digest });
  });
  it("supports a bodyless forwarded action and rejects source stream errors without accepting a partial part", async () => {
    const f = setup();
    const incoming = pendingStream();
    incoming.stream.error(new Error("untrusted source failure"));
    const response = await f.outer(
      "/api/admin/uploads/upload/parts/1",
      incoming.content,
      { "X-Part-SHA256": digest },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "body_read_failed" },
    });
    expect(f.uploadPart).not.toHaveBeenCalled();
    expect(f.reservation()?.state).toBe("reserved");
    expect((await f.outer("/api/admin/uploads/upload/cancel")).status).toBe(
      200,
    );
  });
  it("stops forwarding a pending read synchronously even when source cancellation never settles", async () => {
    const incoming = pendingStream();
    const forwarding = forwardRequestBody(
      request("/forward", incoming.content),
    );
    const reader = forwarding.body!.getReader();
    const pending = reader.read();
    await Promise.resolve();
    forwarding.stop();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(incoming.cancel).toHaveBeenCalledOnce();
    expect(() => forwarding.stop()).not.toThrow();
  });
  it("retains all bytes across 100,000 tiny chunks in both reading and forwarding", async () => {
    const chunk = new Uint8Array([7]);
    const source = () => {
      let remaining = 100000;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (remaining-- > 0) controller.enqueue(chunk);
          else controller.close();
        },
      });
    };
    const direct = await readRequestBytes(request("/direct", source()), 100000);
    expect(direct).toHaveLength(100000);
    expect(direct.every((value) => value === 7)).toBe(true);
    const forwarding = forwardRequestBody(request("/forward", source()));
    const forwarded = await readRequestBytes(
      request("/received", forwarding.body!),
      100000,
    );
    expect(forwarded).toEqual(direct);
    forwarding.stop();
  });
  it("allows rate/login admission and real cancellation while a part stream is pending, then rechecks the cancelled state", async () => {
    const f = setup();
    const incoming = pendingStream();
    const pending = f.coordinator.fetch(
      part(incoming.content, incoming.abort.signal),
    );
    expect((await f.rate()).status).toBe(200);
    expect(
      (await f.coordinator.fetch(request("/uploads/upload/cancel"))).status,
    ).toBe(200);
    expect(f.upload()).toMatchObject({ state: "cancelled", reserved_bytes: 0 });
    incoming.stream.enqueue(bytes);
    incoming.stream.close();
    expect((await pending).status).toBe(409);
    expect(f.uploadPart).not.toHaveBeenCalled();
    expect(f.abort).toHaveBeenCalledOnce();
    expect(
      f.native.prepare("SELECT COUNT(*) AS n FROM upload_parts").get()?.n,
    ).toBe(0);
  });
  it("rejects an aborted read without waiting for a stalled stream cancel or releasing ledger reservations", async () => {
    const f = setup();
    const incoming = pendingStream();
    const pending = f.coordinator.fetch(
      part(incoming.content, incoming.abort.signal),
    );
    incoming.abort.abort();
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({
      error: { code: "request_aborted" },
    });
    expect(incoming.cancel).toHaveBeenCalledOnce();
    expect(f.uploadPart).not.toHaveBeenCalled();
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.upload()).toMatchObject({
      state: "uploading",
      reserved_bytes: 16,
    });
    expect(f.reservation()?.state).toBe("reserved");
    expect((await f.coordinator.fetch(part())).status).toBe(200);
  });
  it("expires a part after 30 seconds idle and recovers its slot without changing its upload", async () => {
    vi.useFakeTimers();
    const f = setup();
    const incoming = pendingStream();
    const pending = f.coordinator.fetch(
      part(incoming.content, incoming.abort.signal),
    );
    await vi.advanceTimersByTimeAsync(30000);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({
      error: { code: "body_timeout" },
    });
    expect(f.uploadPart).not.toHaveBeenCalled();
    expect(f.reservation()?.state).toBe("reserved");
    expect((await f.rate()).status).toBe(200);
    expect((await f.coordinator.fetch(part())).status).toBe(200);
  });
  it.each(["actual", "declared"])(
    "rejects %s oversized ingress before R2 or ledger mutation",
    async (kind) => {
      const f = setup();
      const response = await f.coordinator.fetch(
        kind === "actual"
          ? part(new Uint8Array(PART_BYTES + 1))
          : part(bytes, undefined, "upload", digest, {
              "Content-Length": String(PART_BYTES + 1),
            }),
      );
      expect(response.status).toBe(413);
      expect(f.uploadPart).not.toHaveBeenCalled();
      expect(f.abort).not.toHaveBeenCalled();
      expect(f.upload()).toMatchObject({
        state: "uploading",
        reserved_bytes: 16,
      });
      expect(f.reservation()?.state).toBe("reserved");
    },
  );
  it("limits pending ingress to two parts and recovers after both abort", async () => {
    const f = setup();
    const a = pendingStream(),
      b = pendingStream();
    const pendingA = f.coordinator.fetch(part(a.content, a.abort.signal));
    const pendingB = f.coordinator.fetch(part(b.content, b.abort.signal));
    const response = await f.coordinator.fetch(part());
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error: { code: "upload_busy" },
    });
    expect((await f.rate()).status).toBe(200);
    expect(f.uploadPart).not.toHaveBeenCalled();
    a.abort.abort();
    b.abort.abort();
    expect((await pendingA).status).toBe(408);
    expect((await pendingB).status).toBe(408);
    expect((await f.coordinator.fetch(part())).status).toBe(200);
  });
  it("counts mutating and queued buffers in the two slots and never unlocks an unresolved R2 write", async () => {
    const f = setup();
    let entered!: () => void, finish!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.uploadPart.mockImplementationOnce(async () => {
      entered();
      await gate;
      return { etag: "first" };
    });
    const first = f.coordinator.fetch(part());
    await writing;
    const second = f.coordinator.fetch(part(bytes, undefined, "second"));
    expect((await f.coordinator.fetch(part())).status).toBe(429);
    let controlFinished = false;
    const control = f.rate().then((response) => {
      controlFinished = true;
      return response;
    });
    await Promise.resolve();
    expect(controlFinished).toBe(false);
    expect(f.uploadPart).toHaveBeenCalledOnce();
    finish();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await control).status).toBe(200);
    expect(f.uploadPart).toHaveBeenCalledTimes(2);
    expect(
      f.native.prepare("SELECT COUNT(*) AS n FROM upload_parts").get()?.n,
    ).toBe(2);
  });
  it("rechecks the actual final-part length and SHA under the mutation lock", async () => {
    const f = setup();
    expect((await f.coordinator.fetch(part(new Uint8Array(17)))).status).toBe(
      413,
    );
    expect(
      (
        await f.coordinator.fetch(
          part(bytes, undefined, "upload", "a".repeat(64)),
        )
      ).status,
    ).toBe(400);
    expect(f.uploadPart).not.toHaveBeenCalled();
    expect((await f.coordinator.fetch(part())).status).toBe(200);
    expect((await f.coordinator.fetch(part())).status).toBe(200);
    expect(f.uploadPart).toHaveBeenCalledOnce();
    expect(
      f.native.prepare("SELECT size,sha256 FROM upload_parts").get(),
    ).toMatchObject({ size: 16, sha256: digest });
  });
  it("rejects a preloaded part aborted while queued and preserves that upload's reservations", async () => {
    const f = setup();
    let entered!: () => void, finish!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.uploadPart.mockImplementationOnce(async () => {
      entered();
      await gate;
      return { etag: "first" };
    });
    const first = f.coordinator.fetch(part());
    await writing;
    const controller = new AbortController();
    controllers.push(controller);
    const second = f.coordinator.fetch(
      part(bytes, controller.signal, "second"),
    );
    // Let the completed request read enter the mutation queue behind the live write.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    finish();
    expect((await first).status).toBe(200);
    const response = await second;
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({
      error: { code: "request_aborted" },
    });
    expect(f.uploadPart).toHaveBeenCalledOnce();
    expect(
      f.native
        .prepare("SELECT state,reserved_bytes FROM uploads WHERE id='second'")
        .get(),
    ).toMatchObject({ state: "uploading", reserved_bytes: 16 });
    expect(
      f.native.prepare("SELECT state FROM reservations WHERE id='second'").get()
        ?.state,
    ).toBe("reserved");
  });
  it("bounds JSON parsing inside the control queue so a stalled body cannot hold it forever", async () => {
    vi.useFakeTimers();
    const f = setup();
    const incoming = pendingStream();
    const pending = f.coordinator.fetch(
      request("/rate", incoming.content, incoming.abort.signal),
    );
    const following = f.rate();
    await vi.advanceTimersByTimeAsync(10000);
    expect((await pending).status).toBe(408);
    expect((await following).status).toBe(200);
    expect(incoming.cancel).toHaveBeenCalledOnce();
    expect(f.uploadPart).not.toHaveBeenCalled();
    expect(f.reservation()?.state).toBe("reserved");
  });
  it("enforces the overall read deadline despite chunks arriving before each idle deadline", async () => {
    vi.useFakeTimers();
    const incoming = pendingStream();
    const outcome = readRequestBytes(
      request("/body", incoming.content, incoming.abort.signal),
      1024,
      { idleTimeoutMs: 10000, totalTimeoutMs: 25000 },
    ).catch((error: unknown) => error);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(8000);
      incoming.stream.enqueue(new Uint8Array([1]));
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toMatchObject({ status: 408, code: "body_timeout" });
    expect(incoming.cancel).toHaveBeenCalledOnce();
  });
  it("limits a continuously trickling part to the five-minute overall ingress deadline", async () => {
    vi.useFakeTimers();
    const f = setup();
    const incoming = pendingStream();
    const pending = f.coordinator.fetch(
      part(incoming.content, incoming.abort.signal),
    );
    for (let i = 0; i < 14; i++) {
      await vi.advanceTimersByTimeAsync(20000);
      incoming.stream.enqueue(new Uint8Array([7]));
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(20000);
    expect((await pending).status).toBe(408);
    expect(f.uploadPart).not.toHaveBeenCalled();
    expect(f.reservation()?.state).toBe("reserved");
    expect((await f.rate()).status).toBe(200);
  });
  it("preserves JSON validation and rejects errored streams safely", async () => {
    await expect(body(request("/json", "[]"))).rejects.toMatchObject({
      status: 400,
      code: "invalid_json",
    });
    const incoming = pendingStream();
    incoming.stream.error(new Error("untrusted stream error"));
    await expect(
      readRequestBytes(request("/body", incoming.content), 1024),
    ).rejects.toMatchObject({ status: 400, code: "body_read_failed" });
  });
});
