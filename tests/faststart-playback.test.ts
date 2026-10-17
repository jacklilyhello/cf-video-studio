import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));
import worker from "../src/index";
import {
  inspectFaststartObject,
  verifyFaststartVersion,
} from "../src/faststart";
import {
  checkSource,
  createSourceVersion,
  reportSourcePlayback,
  serveSourcePreview,
  verifySourceVersion,
} from "../src/source";
import { serveMedia } from "../src/media";
import { verifyVersionObjects } from "../src/inventory";
import { publishVideo } from "../src/videos";
import {
  createDeletionPlan,
  executeDeletion,
  reconcileStorage,
  storageList,
} from "../src/storage";
import type { Env, Version } from "../src/types";
import { sourceMp4Fixture } from "./source-fixture";
import { fragmentedMp4Fixture } from "./fragmented-fixture";
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
let sequence = 0;
function setup(options: Parameters<typeof sourceMp4Fixture>[0] = {}) {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  for (const file of [
    "0001_initial.sql",
    "0002_imports.sql",
    "0003_deletion_items.sql",
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
        const result = statements.map((s) => s.execute());
        native.exec("COMMIT");
        return result;
      } catch (e) {
        native.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const videoId = `source-video-${++sequence}`,
    key = `videos/${videoId}/source/revision`,
    bytes = sourceMp4Fixture(options);
  const stored = new Map<
    string,
    {
      key: string;
      size: number;
      etag: string;
      uploaded: Date;
      customMetadata: Record<string, string>;
      bytes: Uint8Array;
    }
  >();
  stored.set(key, {
    key,
    size: bytes.length,
    etag: "source-etag",
    uploaded: new Date("2026-10-13T00:00:00Z"),
    customMetadata: {
      upload_id: "upload",
      video_id: videoId,
      source_revision: "revision",
    },
    bytes,
  });
  native
    .prepare(
      "INSERT INTO videos(id,title,source_key,source_size,source_etag,source_revision,source_name,status,created_at,updated_at) VALUES(?,?,?,?,'source-etag','revision','misleading.bin','unprocessed',1,1)",
    )
    .run(videoId, "Source", key, bytes.length);
  native
    .prepare(
      "INSERT INTO objects(key,video_id,category,bytes,etag,state,updated_at) VALUES(?,?,'source',?,'source-etag','present',1)",
    )
    .run(key, videoId, bytes.length);
  native
    .prepare(
      "INSERT INTO uploads(id,video_id,object_key,multipart_id,fingerprint,expected_size,state,reserved_bytes,expires_at,created_at,updated_at) VALUES('upload',?,?,'multipart','fingerprint',?,'complete',0,1,1,1)",
    )
    .run(videoId, key, bytes.length);
  const head = vi.fn(async (k: string) => stored.get(k) ?? null);
  const get = vi.fn(
    async (
      k: string,
      options?: {
        range?: { offset: number; length: number };
        onlyIf?: { etagMatches: string };
      },
    ) => {
      const object = stored.get(k);
      if (!object) return null;
      if (options?.onlyIf?.etagMatches !== object.etag) return { ...object };
      const range = options.range;
      const data = range
        ? object.bytes.slice(range.offset, range.offset + range.length)
        : object.bytes;
      return {
        ...object,
        range,
        body: new Response(new Uint8Array(data).buffer).body!,
      };
    },
  );
  const remove = vi.fn(async (k: string) => {
    stored.delete(k);
  });
  const processor = vi.fn();
  const env = {
    DB: db,
    MEDIA: {
      head,
      get,
      delete: remove,
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({
        objects: [...stored.values()].filter((o) => o.key.startsWith(prefix)),
        truncated: false,
      })),
    },
    PROCESSOR: { get: processor },
  } as unknown as Env;
  const request = (data: unknown) =>
    new Request("https://source-test.example/action", {
      method: "POST",
      body: JSON.stringify(data),
    });
  const confirm = () =>
    createSourceVersion(
      request({
        sourceEtag: "source-etag",
        sourceRevision: "revision",
        attestation: {
          played: true,
          seeked: true,
          audioConfirmed: true,
          durationSeconds: 10,
          seekFromSeconds: 0,
          seekToSeconds: 5,
        },
      }),
      env,
      videoId,
    );
  const version = (id: string) =>
    native
      .prepare("SELECT * FROM versions WHERE id=?")
      .get(id) as unknown as Version;
  function addHls() {
    const prefix = `videos/${videoId}/versions/hls/`;
    native
      .prepare(
        "INSERT INTO versions(id,video_id,prefix,state,mode,quality,manifest,bytes,duration,timeline_id,validation_json,created_at) VALUES('hls',?,?,'verified','probe-remux','source','index.m3u8',12,10,'hls-timeline',?,1)",
      )
      .run(videoId, prefix, JSON.stringify({ actualR2Objects: 2 }));
    for (const [name, size] of [
      ["index.m3u8", 4],
      ["segment-000001.ts", 8],
    ] as const) {
      const k = prefix + name;
      stored.set(k, {
        key: k,
        size,
        etag: name,
        uploaded: new Date(),
        customMetadata: {},
        bytes: new Uint8Array(size),
      });
      native
        .prepare(
          "INSERT INTO objects(key,video_id,version_id,category,bytes,etag,state,updated_at) VALUES(?,?,'hls','hls',?,?,'present',1)",
        )
        .run(k, videoId, size, name);
    }
  }
  return {
    native,
    env,
    videoId,
    key,
    bytes,
    stored,
    head,
    get,
    remove,
    processor,
    request,
    confirm,
    version,
    addHls,
  };
}
// Model already-validated state with synthetic metadata. No sample payload is
// decoded, optimized or presented as actual Container output in these tests.
const fixtureDigest = "a".repeat(64);
const playbackAttestation = {
  played: true,
  seeked: true,
  audioConfirmed: true,
  durationSeconds: 10,
  seekFromSeconds: 0,
  seekToSeconds: 5,
};
function addFaststart(
  f: ReturnType<typeof setup>,
  options: Parameters<typeof sourceMp4Fixture>[0] = {},
) {
  const content = sourceMp4Fixture({ tail: false, ...options });
  const prefix = `videos/${f.videoId}/versions/optimized/`;
  const key = prefix + "optimized.mp4";
  const validation = {
    outputKind: "mp4",
    faststartVerified: true,
    allPacketsDecoded: true,
    packetTimelinesVerified: true,
    codecAndResolutionVerified: true,
    copiedStreamsVerified: true,
    mediaMetadataPreserved: true,
    mp4Structure: {
      compatible: true,
      serverDecoded: false,
      validationBasis: "bounded-iso-bmff-metadata",
      audioCodec: options.audio === false ? null : "mp4a.40.2",
      index: { placement: "before-media" },
    },
    copiedStreams: [
      {
        type: "video",
        packets: 1,
        sha256: fixtureDigest,
        outputPackets: 1,
        outputSha256: fixtureDigest,
      },
      ...(options.audio === false
        ? []
        : [
            {
              type: "audio",
              packets: 1,
              sha256: fixtureDigest,
              outputPackets: 1,
              outputSha256: fixtureDigest,
            },
          ]),
    ],
    durationDifferenceSeconds: 0,
    syncOffsetDifferenceSeconds: 0,
    syncEndOffsetDifferenceSeconds: 0,
    r2PutChecksumsVerified: true,
    completionR2EtagsSizesVerified: true,
    actualR2Objects: 1,
    verifiedAt: Date.now(),
    browserPlaybackAndSeeking: "pending_admin_preview",
  };
  f.native
    .prepare(
      "INSERT INTO versions(id,video_id,prefix,state,mode,quality,manifest,bytes,duration,timeline_id,validation_json,created_at) VALUES('optimized',?,?,'verified','faststart','source','optimized.mp4',?,10,'optimized-timeline',?,1)",
    )
    .run(f.videoId, prefix, content.length, JSON.stringify(validation));
  f.native
    .prepare(
      "INSERT INTO objects(key,video_id,version_id,category,bytes,etag,sha256,state,updated_at) VALUES(?,?,'optimized','mp4',?,'optimized-etag',?,'present',1)",
    )
    .run(key, f.videoId, content.length, fixtureDigest);
  f.stored.set(key, {
    key,
    size: content.length,
    etag: "optimized-etag",
    uploaded: new Date(),
    customMetadata: {},
    bytes: content,
  });
  const version = () => f.version("optimized");
  const publish = (attestation: unknown = playbackAttestation) =>
    publishVideo(
      f.request({ versionId: "optimized", attestation }),
      f.env,
      f.videoId,
    );
  const media = (
    method = "GET",
    headers: HeadersInit = {},
    preview = false,
    name = "optimized.mp4",
  ) =>
    serveMedia(
      new Request("https://faststart.example/media", { method, headers }),
      f.env,
      f.videoId,
      "optimized",
      name,
      preview,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );
  return { key, prefix, content, validation, version, publish, media };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("independent optimized MP4 versions with actual SQLite and synthetic metadata", () => {
  it.each([true, false])(
    "binds copied-stream evidence to actual audio presence %s",
    async (audio) => {
      const f = setup({ audio });
      const r = addFaststart(f, { audio });
      await expect(
        verifyVersionObjects(f.env, r.version()),
      ).resolves.toBeUndefined();
      const evidence = {
        ...r.validation,
        copiedStreams: audio
          ? r.validation.copiedStreams.filter(
              (stream) => stream.type !== "audio",
            )
          : [
              ...r.validation.copiedStreams,
              { ...r.validation.copiedStreams[0], type: "audio" },
            ],
      };
      f.native
        .prepare("UPDATE versions SET validation_json=? WHERE id='optimized'")
        .run(JSON.stringify(evidence));
      await expect(
        verifyVersionObjects(f.env, r.version()),
      ).rejects.toMatchObject({ code: "mp4_unverified" });
    },
  );
  it("requires compatible front-moov structure and never calls a processor", async () => {
    const f = setup();
    const r = addFaststart(f);
    expect(
      await inspectFaststartObject(
        f.env,
        (await f.head(r.key)) as unknown as R2Object,
      ),
    ).toMatchObject({
      compatible: true,
      index: { placement: "before-media" },
      serverDecoded: false,
    });
    expect(f.processor).not.toHaveBeenCalled();
  });
  it("rejects fragmented optimized output before expanding its quoted metadata scan", async () => {
    const f = setup();
    const r = addFaststart(f);
    const originalSource = f.stored.get(f.key)!.bytes;
    const fragmented = fragmentedMp4Fixture({ fragments: 180, index: true });
    const output = f.stored.get(r.key)!;
    output.bytes = fragmented;
    output.size = fragmented.length;
    await expect(
      inspectFaststartObject(f.env, output as unknown as R2Object),
    ).rejects.toMatchObject({ code: "mp4_incomplete" });
    expect(f.get).toHaveBeenCalledTimes(3);
    expect(
      f.get.mock.calls.reduce(
        (bytes, [, options]) => bytes + (options?.range?.length || 0),
        0,
      ),
    ).toBe(24);
    expect(f.stored.get(f.key)!.bytes).toBe(originalSource);
    expect(f.processor).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("supports copy-only mono while preserving original stereo-only admission and rejecting mismatched ASC channels", async () => {
    const f = setup({ channels: 1 });
    const r = addFaststart(f, { channels: 1 });
    expect(
      await inspectFaststartObject(
        f.env,
        f.stored.get(r.key)! as unknown as R2Object,
      ),
    ).toMatchObject({ compatible: true, audioChannels: 1 });
    expect(await (await checkSource(f.env, f.videoId)).json()).toMatchObject({
      source: { compatible: false },
    });
    const mismatch = setup();
    const broken = addFaststart(mismatch, { channels: 1, ascChannels: 2 });
    await expect(
      inspectFaststartObject(
        mismatch.env,
        mismatch.stored.get(broken.key)! as unknown as R2Object,
      ),
    ).rejects.toMatchObject({ code: "mp4_incomplete" });
  });
  it.each([{ tail: true }, { codec: "hvc1" }])(
    "rejects unsupported MP4 layout/codec without weakening HLS proof",
    async (options) => {
      const f = setup();
      const r = addFaststart(f, options);
      await expect(
        verifyVersionObjects(f.env, r.version()),
      ).rejects.toMatchObject({ code: "mp4_incomplete" });
      expect(f.processor).not.toHaveBeenCalled();
    },
  );
  it("previews before attestation but denies unconfirmed public playback and publication", async () => {
    const f = setup();
    const r = addFaststart(f);
    expect((await r.media("GET", { Range: "bytes=0-15" }, true)).status).toBe(
      206,
    );
    await expect(r.media()).rejects.toMatchObject({ status: 404 });
    f.native
      .prepare(
        "UPDATE videos SET published=1,current_version_id='optimized' WHERE id=?",
      )
      .run(f.videoId);
    await expect(r.media()).rejects.toMatchObject({ status: 404 });
  });
  it.each([
    undefined,
    { ...playbackAttestation, audioConfirmed: false },
    { ...playbackAttestation, durationSeconds: 90 },
    { ...playbackAttestation, seekToSeconds: 0 },
  ])(
    "rejects missing or invalid administrator attestation before publication",
    async (attestation) => {
      const f = setup();
      const r = addFaststart(f);
      await expect(
        publishVideo(
          f.request({ versionId: "optimized", attestation }),
          f.env,
          f.videoId,
        ),
      ).rejects.toMatchObject({ code: "mp4_attestation_required" });
      expect(
        f.native
          .prepare("SELECT published FROM videos WHERE id=?")
          .get(f.videoId)?.published,
      ).toBe(0);
    },
  );
  it("publishes only the exact independently generated object after explicit playback confirmation", async () => {
    const f = setup();
    const r = addFaststart(f);
    expect((await r.publish()).status).toBe(200);
    const proof = JSON.parse(r.version().validation_json!);
    expect(proof.administratorAttestation).toMatchObject({
      ...playbackAttestation,
      versionId: "optimized",
      basis: "administrator-browser-playback-and-seek",
    });
    const response = await r.media("GET", { Range: "bytes=0-15" });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Content-Range")).toBe(
      `bytes 0-15/${r.content.length}`,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      r.content.slice(0, 16),
    );
    expect(f.stored.has(f.key)).toBe(true);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.processor).not.toHaveBeenCalled();
  });
  it("serves HEAD, suffix and If-Range with no-store and complete invalid-range headers", async () => {
    const f = setup();
    const r = addFaststart(f);
    await r.publish();
    const head = await r.media("HEAD", { Range: "bytes=-12" });
    expect(head.status).toBe(206);
    expect(head.headers.get("Content-Length")).toBe("12");
    expect(await head.text()).toBe("");
    const invalid = await r.media("GET", {
      Range: `bytes=${r.content.length}-`,
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("Content-Range")).toBe(
      `bytes */${r.content.length}`,
    );
    const stale = await r.media("GET", {
      Range: "bytes=0-15",
      "If-Range": '"older"',
    });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("Content-Length")).toBe(String(r.content.length));
    expect(stale.headers.get("Cache-Control")).toContain("no-store");
  });
  it.each(["index.m3u8", "segment-000001.ts", "source.mp4"])(
    "does not expose optimized MP4 through the wrong media name %s",
    async (name) => {
      const f = setup();
      const r = addFaststart(f);
      await r.publish();
      await expect(r.media("GET", {}, false, name)).rejects.toMatchObject({
        status: 404,
      });
    },
  );
  it("rejects every new request after unpublish before R2 even after a successful range", async () => {
    const f = setup();
    const r = addFaststart(f);
    await r.publish();
    expect((await r.media("GET", { Range: "bytes=0-15" })).status).toBe(206);
    f.native.prepare("UPDATE videos SET published=0 WHERE id=?").run(f.videoId);
    f.get.mockClear();
    f.head.mockClear();
    for (const [method, headers] of [
      ["GET", {}],
      ["HEAD", {}],
      ["GET", { Range: "bytes=0-15" }],
      ["HEAD", { Range: "bytes=-12" }],
    ] as const)
      await expect(r.media(method, headers)).rejects.toMatchObject({
        status: 404,
      });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.head).not.toHaveBeenCalled();
  });
  it("accepts an independent optimized MP4 when planning source deletion without requiring HLS", async () => {
    const f = setup();
    addFaststart(f);
    const result = await (
      await createDeletionPlan(
        f.request({ kind: "source", videoId: f.videoId }),
        f.env,
      )
    ).json();
    expect(result).toMatchObject({
      plan: {
        retainedVersionId: "optimized",
        preservePlayback: true,
        objects: [{ key: f.key }],
      },
    });
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.stored.has(f.key)).toBe(true);
  });
  it("a version deletion inventory contains only the generated output", async () => {
    const f = setup();
    const r = addFaststart(f);
    const result = (await (
      await createDeletionPlan(
        f.request({
          kind: "version",
          videoId: f.videoId,
          versionId: "optimized",
        }),
        f.env,
      )
    ).json()) as { plan: { objects: { key: string }[] } };
    expect(result.plan.objects.map((object) => object.key)).toEqual([r.key]);
    expect(result.plan.objects.some((object) => object.key === f.key)).toBe(
      false,
    );
  });
  it("classifies optimized versions separately and revokes missing-object proof without deleting the source", async () => {
    const f = setup();
    const r = addFaststart(f);
    await r.publish();
    const result = (await (
      await storageList(
        new Request("https://faststart.example/storage?category=current_mp4"),
        f.env,
      )
    ).json()) as { items: unknown[]; summary: Record<string, number> };
    expect(result.items).toHaveLength(1);
    expect(result.summary.current_mp4).toBe(r.content.length);
    f.stored.delete(r.key);
    await reconcileStorage(f.env);
    expect(r.version().state).toBe("objects_missing");
    expect(
      f.native.prepare("SELECT published FROM videos WHERE id=?").get(f.videoId)
        ?.published,
    ).toBe(0);
    expect(f.stored.has(f.key)).toBe(true);
  });
  it("returns native-MP4 kind/name from the actual catalog route", async () => {
    const f = setup();
    const r = addFaststart(f);
    await r.publish();
    const response = await worker.fetch(
      new Request("https://faststart.example/api/videos"),
      f.env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );
    const data = (await response.json()) as { items: unknown[] };
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      mediaKind: "mp4",
      mediaName: "optimized.mp4",
      versionId: "optimized",
    });
  });
  it("bounds stalled R2 identity reads without permitting publication", async () => {
    vi.useFakeTimers();
    const f = setup();
    const r = addFaststart(f);
    f.head.mockImplementationOnce(() => new Promise(() => {}));
    const checked = verifyFaststartVersion(f.env, r.version());
    const assertion = expect(checked).rejects.toMatchObject({
      code: "mp4_check_timeout",
    });
    await vi.advanceTimersByTimeAsync(20000);
    await assertion;
    expect(
      f.native.prepare("SELECT published FROM videos WHERE id=?").get(f.videoId)
        ?.published,
    ).toBe(0);
    expect(f.processor).not.toHaveBeenCalled();
  });
  it("rejects a resolved identity result delivered after the shared deadline", async () => {
    vi.useFakeTimers();
    const f = setup();
    const r = addFaststart(f);
    f.head.mockImplementationOnce(async (key) => {
      vi.setSystemTime(Date.now() + 20001);
      return f.stored.get(key) ?? null;
    });
    await expect(
      verifyFaststartVersion(f.env, r.version()),
    ).rejects.toMatchObject({ code: "mp4_check_timeout" });
    expect(f.processor).not.toHaveBeenCalled();
  });
  it("cancels a late metadata body and never accepts its structure", async () => {
    vi.useFakeTimers();
    const f = setup();
    const r = addFaststart(f);
    const cancel = vi.fn();
    f.get.mockImplementationOnce(async (key) => {
      vi.setSystemTime(Date.now() + 20001);
      return {
        ...f.stored.get(key)!,
        range: { offset: 0, length: 8 },
        body: new ReadableStream({ cancel }),
      };
    });
    await expect(
      inspectFaststartObject(
        f.env,
        f.stored.get(r.key)! as unknown as R2Object,
      ),
    ).rejects.toMatchObject({ code: "mp4_incomplete" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
