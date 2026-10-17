import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {},
}));
import worker from "../src/index";
import { Coordinator } from "../src/coordinator";
import { login } from "../src/auth";
import { createSourceVersion } from "../src/source";
import { publishVideo, readPublicationRevision } from "../src/videos";
import { sha256 } from "../src/http";
import { sourceMp4Fixture } from "./source-fixture";
import type { Env } from "../src/types";

interface NativeStatement {
  get(...values: unknown[]): Record<string, unknown> | undefined;
  all(...values: unknown[]): Record<string, unknown>[];
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
const origin = "https://publication-fixture.example";
const attestation = {
  played: true,
  seeked: true,
  audioConfirmed: true,
  durationSeconds: 10,
  seekFromSeconds: 0,
  seekToSeconds: 5,
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function slowBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const read = deferred();
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      pull() {
        read.resolve();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    read: read.promise,
    finish(value: unknown) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
      controller.close();
    },
  };
}
async function fixture(kind: "hls" | "source" | "faststart" = "hls") {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  for (const file of [
    "0001_initial.sql",
    "0002_imports.sql",
    "0003_deletion_items.sql",
    "0004_upload_approvals.sql",
    "0005_publication_revision.sql",
    "0006_source_structural_checks.sql",
  ])
    native.exec(
      readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
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
          return { results: prepared.all(...values), success: true };
        },
        async run() {
          return statement.execute();
        },
        execute() {
          return {
            meta: { changes: Number(prepared.run(...values).changes) },
            success: true,
          };
        },
      };
      return statement;
    },
    async batch(statements: { execute(): unknown }[]) {
      native.exec("BEGIN IMMEDIATE");
      try {
        const result = statements.map((s) => s.execute());
        native.exec("COMMIT");
        return result;
      } catch (error) {
        native.exec("ROLLBACK");
        throw error;
      }
    },
  };
  // Synthetic metadata and existing validation receipts exercise concurrency,
  // never actual sample decoding, administrator observations or cloud media.
  const sourceKey = "videos/video/source/revision";
  const source = sourceMp4Fixture();
  type Stored = {
    key: string;
    size: number;
    etag: string;
    data: Uint8Array;
    customMetadata: Record<string, string>;
  };
  const stored = new Map<string, Stored>([
    [
      sourceKey,
      {
        key: sourceKey,
        size: source.length,
        etag: "source-etag",
        data: source,
        customMetadata: {
          upload_id: "upload",
          video_id: "video",
          source_revision: "revision",
        },
      },
    ],
  ]);
  native
    .prepare(
      "INSERT INTO videos(id,title,source_key,source_size,source_etag,source_revision,source_name,status,created_at,updated_at) VALUES('video','Synthetic concurrency fixture',?,?,'source-etag','revision','fixture.mp4','ready',1,1)",
    )
    .run(sourceKey, source.length);
  native
    .prepare(
      "INSERT INTO objects(key,video_id,category,bytes,etag,state,updated_at) VALUES(?,'video','source',?,'source-etag','present',1)",
    )
    .run(sourceKey, source.length);
  native
    .prepare(
      "INSERT INTO uploads(id,video_id,object_key,multipart_id,fingerprint,expected_size,state,reserved_bytes,expires_at,created_at,updated_at) VALUES('upload','video',?,'multipart','fixture',?,'complete',0,1,1,1)",
    )
    .run(sourceKey, source.length);
  let blocked:
    | {
        operation: string;
        entered: ReturnType<typeof deferred>;
        released: ReturnType<typeof deferred>;
      }
    | undefined;
  async function pause(operation: string) {
    if (blocked?.operation !== operation) return;
    const gate = blocked;
    blocked = undefined;
    gate.entered.resolve();
    await gate.released.promise;
  }
  const head = vi.fn(async (key: string) => {
    await pause("head");
    const item = stored.get(key);
    return item ? { ...item, checksums: {} } : null;
  });
  const list = vi.fn(async ({ prefix }: { prefix: string }) => {
    await pause("list");
    return {
      objects: [...stored.values()]
        .filter((item) => item.key.startsWith(prefix))
        .map((item) => ({ ...item, checksums: {} })),
      truncated: false,
    };
  });
  const get = vi.fn(
    async (
      key: string,
      options?: {
        onlyIf?: { etagMatches: string };
        range?: { offset: number; length: number };
      },
    ) => {
      await pause("get");
      const item = stored.get(key);
      if (!item) return null;
      if (options?.onlyIf && options.onlyIf.etagMatches !== item.etag)
        return { ...item };
      const range = options?.range;
      const bytes = range
        ? item.data.slice(range.offset, range.offset + range.length)
        : item.data;
      return {
        ...item,
        checksums: {},
        ...(range ? { range } : {}),
        body: new Response(new Uint8Array(bytes)).body!,
        text: async () => new TextDecoder().decode(bytes),
      };
    },
  );
  const env = {
    DB: db,
    MEDIA: { head, list, get },
    APP_ENV: "test",
    ADMIN_PASSWORD: "offline-publication-password",
    SESSION_SECRET: "offline-publication-session-fixture-over-32-characters",
    PROCESSOR: {
      get: vi.fn(() => {
        throw new Error("Processor is outside this test");
      }),
    },
  } as unknown as Env;
  let versionId = "version",
    filename = "index.m3u8";
  const prefix = "videos/video/versions/version/";
  if (kind === "source") {
    const response = await createSourceVersion(
      new Request(origin + "/source-version", {
        method: "POST",
        body: JSON.stringify({
          sourceEtag: "source-etag",
          sourceRevision: "revision",
          attestation,
        }),
      }),
      env,
      "video",
    );
    versionId = ((await response.json()) as { version: { id: string } }).version
      .id;
    filename = "source.mp4";
  } else {
    let validation: Record<string, unknown>, bytes: number;
    if (kind === "hls") {
      const manifest = new TextEncoder().encode(
        "#EXTM3U\n#EXTINF:10,\nsegment-000001.ts\n#EXT-X-ENDLIST\n",
      );
      for (const [name, data] of [
        ["index.m3u8", manifest],
        ["segment-000001.ts", new Uint8Array(4)],
      ] as const) {
        const key = prefix + name;
        stored.set(key, {
          key,
          data,
          size: data.length,
          etag: name,
          customMetadata: {},
        });
        native
          .prepare(
            "INSERT INTO objects(key,video_id,version_id,category,bytes,etag,state,updated_at) VALUES(?,'video',NULL,'hls',?,?,'present',1)",
          )
          .run(key, data.length, name);
      }
      bytes = manifest.length + 4;
      validation = { actualR2Objects: 2 };
    } else {
      filename = "optimized.mp4";
      const data = sourceMp4Fixture({ tail: false });
      bytes = data.length;
      const key = prefix + filename;
      stored.set(key, {
        key,
        data,
        size: bytes,
        etag: "optimized-etag",
        customMetadata: {},
      });
      native
        .prepare(
          "INSERT INTO objects(key,video_id,version_id,category,bytes,etag,sha256,state,updated_at) VALUES(?,'video',NULL,'mp4',?,'optimized-etag',?,'present',1)",
        )
        .run(key, bytes, await sha256(data));
      const hash = "a".repeat(64);
      validation = {
        outputKind: "mp4",
        faststartVerified: true,
        allPacketsDecoded: true,
        packetTimelinesVerified: true,
        codecAndResolutionVerified: true,
        copiedStreamsVerified: true,
        mediaMetadataPreserved: true,
        r2PutChecksumsVerified: true,
        completionR2EtagsSizesVerified: true,
        actualR2Objects: 1,
        verifiedAt: Date.now(),
        durationDifferenceSeconds: 0,
        syncOffsetDifferenceSeconds: 0,
        syncEndOffsetDifferenceSeconds: 0,
        browserPlaybackAndSeeking: "pending_admin_preview",
        mp4Structure: {
          compatible: true,
          serverDecoded: false,
          validationBasis: "bounded-iso-bmff-metadata",
          audioCodec: "mp4a.40.2",
          index: { placement: "before-media" },
        },
        copiedStreams: ["video", "audio"].map((type) => ({
          type,
          packets: 2,
          sha256: hash,
          outputPackets: 2,
          outputSha256: hash,
        })),
        administratorAttestation: {
          ...attestation,
          versionId,
          basis: "administrator-browser-playback-and-seek",
          confirmedAt: Date.now(),
        },
      };
    }
    native
      .prepare(
        "INSERT INTO versions(id,video_id,prefix,state,mode,quality,manifest,bytes,duration,timeline_id,validation_json,created_at) VALUES('version','video',?,'verified',?,'source',?,?,10,'timeline',?,1)",
      )
      .run(
        prefix,
        kind === "hls" ? "probe-remux" : "faststart",
        filename,
        bytes,
        JSON.stringify(validation),
      );
    native
      .prepare("UPDATE objects SET version_id='version' WHERE key LIKE ?")
      .run(prefix + "%");
  }
  native
    .prepare(
      "UPDATE videos SET published=1,current_version_id=? WHERE id='video'",
    )
    .run(versionId);
  const saved = new Map<string, unknown>();
  const storage = {
    async get(key: string) {
      return saved.get(key);
    },
    async put(key: string, value: unknown) {
      saved.set(key, value);
    },
    async getAlarm() {
      return 1;
    },
    async setAlarm() {},
  };
  const coordinator = new Coordinator(
    { storage } as unknown as DurableObjectState,
    env,
  );
  const publishArrival = deferred();
  const dispatch = vi.fn((input: Request | string, init?: RequestInit) => {
    const request =
      typeof input === "string" ? new Request(input, init) : input;
    if (new URL(request.url).pathname.endsWith("/publish"))
      publishArrival.resolve();
    return coordinator.fetch(request);
  });
  env.COORDINATOR = {
    idFromName: () => "admission",
    get: () => ({ fetch: dispatch }),
  } as unknown as DurableObjectNamespace;
  const session = await login(
    new Request(origin + "/api/admin/login", {
      method: "POST",
      headers: { Origin: origin },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    }),
    env,
  );
  const cookie = session.headers.get("Set-Cookie")!.split(";")[0];
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
  } as ExecutionContext;
  const cache = new Map<string, Response>();
  const cacheMatch = vi.fn(async (request: Request) =>
    cache.get(request.url)?.clone(),
  );
  vi.stubGlobal("caches", {
    default: {
      match: cacheMatch,
      async put(request: Request, response: Response) {
        cache.set(request.url, response);
      },
    },
  });
  const post = (path: string, data: unknown = {}, headers: HeadersInit = {}) =>
    worker.fetch(
      new Request(origin + path, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie, ...headers },
        body: data instanceof ReadableStream ? data : JSON.stringify(data),
        duplex: "half",
      } as RequestInit),
      env,
      ctx,
    );
  const publishInput = {
    versionId,
    ...(kind === "faststart"
      ? { attestation: { ...attestation, seekToSeconds: 6 } }
      : {}),
  };
  return {
    native,
    env,
    coordinator,
    dispatch,
    publishArrival: publishArrival.promise,
    get,
    head,
    list,
    cacheMatch,
    post,
    publishInput,
    versionId,
    publish: () => post("/api/admin/videos/video/publish", publishInput),
    unpublish: () => post("/api/admin/videos/video/unpublish"),
    media: () =>
      worker.fetch(
        new Request(`${origin}/media/video/${versionId}/${filename}`),
        env,
        ctx,
      ),
    flush: () => Promise.all(pending.splice(0)),
    video: () =>
      native
        .prepare(
          "SELECT published,current_version_id,publication_revision,status FROM videos WHERE id='video'",
        )
        .get()!,
    proof: () =>
      String(
        native
          .prepare("SELECT validation_json FROM versions WHERE id=?")
          .get(versionId)!.validation_json,
      ),
    pause(operation: "head" | "get" | "list") {
      const gate = { operation, entered: deferred(), released: deferred() };
      blocked = gate;
      return { entered: gate.entered.promise, release: gate.released.resolve };
    },
  };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("publication revocation while validation or admission is pending", () => {
  it.each(["hls", "source", "faststart"] as const)(
    "immediately revokes %s publication during R2 validation, including repeated unpublish, then permits a new explicit publish",
    async (kind) => {
      const f = await fixture(kind);
      expect((await f.media()).status).toBe(200);
      await f.flush();
      const beforeProof = f.proof();
      const gate = f.pause(kind === "hls" ? "list" : "head");
      const publishing = f.publish();
      await gate.entered;
      expect((await f.unpublish()).status).toBe(200);
      expect((await f.unpublish()).status).toBe(200);
      expect(f.video()).toMatchObject({
        published: 0,
        publication_revision: 2,
      });
      f.cacheMatch.mockClear();
      const reads = f.get.mock.calls.length;
      expect((await f.media()).status).toBe(404);
      expect(f.cacheMatch).not.toHaveBeenCalled();
      expect(f.get.mock.calls.length).toBe(reads);
      gate.release();
      const rejected = await publishing;
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({
        error: { code: "publication_revoked" },
      });
      expect(f.video()).toMatchObject({
        published: 0,
        publication_revision: 2,
      });
      expect(f.proof()).toBe(beforeProof);
      expect((await f.media()).status).toBe(404);
      expect(f.cacheMatch).not.toHaveBeenCalled();
      expect((await f.publish()).status).toBe(200);
      expect(f.video()).toMatchObject({
        published: 1,
        publication_revision: 3,
      });
      expect((await f.media()).status).toBe(200);
      if (kind === "faststart")
        expect(
          JSON.parse(f.proof()).administratorAttestation.seekToSeconds,
        ).toBe(6);
    },
  );

  it("revokes an older publish waiting behind the Coordinator queue and replaces untrusted revision headers", async () => {
    const f = await fixture();
    const queued = slowBody();
    const blocking = f.coordinator.fetch(
      new Request("https://internal/rate", {
        method: "POST",
        body: queued.body,
        duplex: "half",
      } as RequestInit),
    );
    await queued.read;
    const publishing = f.post(
      "/api/admin/videos/video/publish",
      f.publishInput,
      { "X-Internal-Publication-Revision": "9000" },
    );
    await f.publishArrival;
    const forwarded = f.dispatch.mock.calls
      .map(([input]) => input)
      .find(
        (input) => input instanceof Request && input.url.endsWith("/publish"),
      ) as Request;
    expect(forwarded.headers.get("X-Internal-Publication-Revision")).toBe("0");
    expect((await f.unpublish()).status).toBe(200);
    queued.finish({ key: "offline-queue", limit: 1, windowMs: 60000 });
    expect((await blocking).status).toBe(200);
    const rejected = await publishing;
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      error: { code: "publication_revoked" },
    });
    expect(f.video()).toMatchObject({ published: 0, publication_revision: 1 });
    expect(f.list).not.toHaveBeenCalled();
  });

  it.each(["outer", "direct"] as const)(
    "captures publication intent before a slow %s body",
    async (route) => {
      const f = await fixture();
      const slow = slowBody();
      const publishing =
        route === "outer"
          ? f.post("/api/admin/videos/video/publish", slow.body)
          : publishVideo(
              new Request(origin + "/publish", {
                method: "POST",
                body: slow.body,
                duplex: "half",
              } as RequestInit),
              f.env,
              "video",
            );
      const outcome = publishing.then(
        (response) => ({ response }),
        (error) => ({ error }),
      );
      await slow.read;
      expect((await f.unpublish()).status).toBe(200);
      slow.finish(f.publishInput);
      const result = await outcome;
      if ("response" in result) {
        expect(result.response.status).toBe(409);
        expect(await result.response.json()).toMatchObject({
          error: { code: "publication_revoked" },
        });
      } else
        expect(result.error).toMatchObject({
          status: 409,
          code: "publication_revoked",
        });
      expect(f.video()).toMatchObject({
        published: 0,
        publication_revision: 1,
      });
      expect(f.list).not.toHaveBeenCalled();
    },
  );

  it.each(["hls", "source", "faststart"] as const)(
    "does not resurrect %s whose proof is revoked while R2 validation waits",
    async (kind) => {
      const f = await fixture(kind);
      const gate = f.pause(kind === "hls" ? "list" : "head");
      const proof = f.proof();
      const publishing = f.publish();
      await gate.entered;
      f.native
        .prepare(
          "UPDATE versions SET state='objects_missing',validation_json=NULL WHERE id=?",
        )
        .run(f.versionId);
      f.native
        .prepare(
          "UPDATE videos SET published=0,status='objects_missing' WHERE id='video'",
        )
        .run();
      gate.release();
      const rejected = await publishing;
      expect(rejected.status).toBe(409);
      expect(f.video()).toMatchObject({
        published: 0,
        status: "objects_missing",
        publication_revision: 0,
      });
      expect(f.proof()).toBe("null");
      expect(proof).not.toBe("null");
    },
  );

  it("refuses missing/deleted/invalid revision before external reads", async () => {
    const f = await fixture();
    await expect(
      readPublicationRevision(f.env, "missing"),
    ).rejects.toMatchObject({ status: 404 });
    f.native
      .prepare("UPDATE videos SET status='deleted' WHERE id='video'")
      .run();
    await expect(readPublicationRevision(f.env, "video")).rejects.toMatchObject(
      { status: 404 },
    );
    // Simulate a corrupt legacy row without asking node:sqlite to convert an
    // out-of-range SQL integer (D1 returns JSON numbers instead).
    f.native.exec("PRAGMA ignore_check_constraints=ON");
    f.native
      .prepare(
        "UPDATE videos SET status='ready',publication_revision=-1 WHERE id='video'",
      )
      .run();
    await expect(readPublicationRevision(f.env, "video")).rejects.toMatchObject(
      { status: 503, code: "publication_revision_invalid" },
    );
    expect(f.list).not.toHaveBeenCalled();
  });
});
