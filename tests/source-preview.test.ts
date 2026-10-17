import { afterEach, describe, expect, it, vi } from "vitest";
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
import { fixtureBoxes, fragmentedMp4Fixture } from "./fragmented-fixture";
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
function setup(
  options: Parameters<typeof sourceMp4Fixture>[0] = {},
  inputBytes?: Uint8Array,
) {
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
    bytes = inputBytes ?? sourceMp4Fixture(options);
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
afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});
async function withFakeClock(run: () => Promise<void>) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  try {
    await run();
  } finally {
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
}
function unchangedSource(f: ReturnType<typeof setup>) {
  expect(f.native.prepare("SELECT COUNT(*) AS n FROM versions").get()?.n).toBe(
    0,
  );
  expect(f.native.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(0);
  expect(
    f.native
      .prepare(
        "SELECT published,current_version_id,source_etag,source_size FROM videos",
      )
      .get(),
  ).toEqual({
    published: 0,
    current_version_id: null,
    source_etag: "source-etag",
    source_size: f.bytes.length,
  });
  expect(f.stored.get(f.key)?.bytes).toEqual(f.bytes);
  expect(f.processor).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
}
describe("bounded original checks with actual SQLite and pending R2 operations", () => {
  it("accepts valid metadata delayed 60 seconds without marking it incompatible", async () =>
    withFakeClock(async () => {
      const f = setup();
      const original = f.get.getMockImplementation()!;
      f.get.mockImplementationOnce(async (...args) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 60000));
        return original(...args);
      });
      const checked = checkSource(f.env, f.videoId);
      await vi.advanceTimersByTimeAsync(60000);
      expect(await (await checked).json()).toMatchObject({
        source: { compatible: true, probe: { serverDecoded: false } },
      });
      const row = f.native
        .prepare("SELECT details_json FROM logs WHERE stage='source_check'")
        .get()!;
      expect(JSON.parse(String(row.details_json))).toMatchObject({
        code: "checked",
        compatible: true,
        elapsedMs: 60000,
        phase: "revalidate",
      });
      unchangedSource(f);
      expect(vi.getTimerCount()).toBe(0);
    }));
  it("includes a pending admission check in the single 90-second deadline", async () =>
    withFakeClock(async () => {
      const f = setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const beforeCheck = vi.fn(() => gate);
      const outcome = checkSource(f.env, f.videoId, { beforeCheck }).catch(
        (error: unknown) => error,
      );
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(89999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await outcome).toMatchObject({
          status: 504,
          code: "source_check_timeout",
          details: {
            phase: "admission",
            elapsedMs: 90000,
            rangeReads: 0,
            metadataBytesRead: 0,
            metadataBytesRequested: 0,
          },
        });
        expect(beforeCheck).toHaveBeenCalledOnce();
        expect(f.head).not.toHaveBeenCalled();
        expect(f.get).not.toHaveBeenCalled();
        unchangedSource(f);
      } finally {
        release();
        await outcome;
        await vi.advanceTimersByTimeAsync(0);
      }
    }));
  it("cancels a late R2 response body even when the clock crosses the deadline before its timer fires", async () =>
    withFakeClock(async () => {
      const f = setup();
      let release!: (value: Awaited<ReturnType<typeof f.get>>) => void;
      const gate = new Promise<Awaited<ReturnType<typeof f.get>>>((resolve) => {
        release = resolve;
      });
      const response = await f.get.getMockImplementation()!(f.key, {
        range: { offset: 0, length: 8 },
        onlyIf: { etagMatches: "source-etag" },
      });
      if (!response || !("body" in response))
        throw new Error("Invalid local R2 fixture");
      const cancel = vi.spyOn(response.body, "cancel");
      f.get.mockImplementationOnce(() => gate);
      const outcome = checkSource(f.env, f.videoId).catch(
        (error: unknown) => error,
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(f.get).toHaveBeenCalledOnce();
        vi.setSystemTime(new Date("2026-10-14T12:01:31Z"));
        release(response);
        await vi.advanceTimersByTimeAsync(0);
        expect(await outcome).toMatchObject({
          status: 504,
          code: "source_check_timeout",
          details: {
            phase: "metadata",
            elapsedMs: 91000,
            rangeReads: 1,
            metadataBytesRead: 0,
            metadataBytesRequested: 8,
          },
        });
        expect(cancel).toHaveBeenCalledOnce();
        unchangedSource(f);
      } finally {
        release(response);
        await outcome;
        await vi.advanceTimersByTimeAsync(0);
      }
    }));
  it("cancels a hanging metadata reader without awaiting an unresponsive underlying cancellation", async () =>
    withFakeClock(async () => {
      const f = setup();
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const body = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel,
      });
      f.get.mockResolvedValueOnce({
        ...f.stored.get(f.key)!,
        range: { offset: 0, length: 8 },
        body,
      });
      const outcome = checkSource(f.env, f.videoId).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(90000);
      expect(await outcome).toMatchObject({
        status: 504,
        code: "source_check_timeout",
        details: {
          phase: "metadata",
          elapsedMs: 90000,
          rangeReads: 1,
          metadataBytesRead: 0,
          metadataBytesRequested: 8,
        },
      });
      expect(cancel).toHaveBeenCalledOnce();
      unchangedSource(f);
      expect(vi.getTimerCount()).toBe(0);
    }));
  it("cancels a delivered R2 body when the deadline crosses between promise continuations", async () =>
    withFakeClock(async () => {
      const f = setup();
      const started = Date.now();
      const response = await f.get.getMockImplementation()!(f.key, {
        range: { offset: 0, length: 8 },
        onlyIf: { etagMatches: "source-etag" },
      });
      if (!response || !("body" in response))
        throw new Error("Invalid local R2 fixture");
      const cancel = vi.spyOn(response.body, "cancel");
      const reader = vi.spyOn(response.body, "getReader");
      f.get.mockImplementationOnce(() => {
        vi.setSystemTime(started + 89999);
        const pending = Promise.resolve(response);
        void pending.then(() => {
          // This continuation runs after get's body-discard check but before
          // the budget's post-race check. No timeout timer has fired yet.
          void Promise.resolve().then(() => vi.setSystemTime(started + 90000));
        });
        return pending;
      });
      const outcome = checkSource(f.env, f.videoId).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(await outcome).toMatchObject({
        status: 504,
        code: "source_check_timeout",
        details: { phase: "metadata", elapsedMs: 90000, metadataBytesRead: 0 },
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(reader).not.toHaveBeenCalled();
      unchangedSource(f);
      expect(vi.getTimerCount()).toBe(0);
    }));
  it("reports a transient metadata read failure as 503 rather than an incompatible MP4", async () => {
    const f = setup();
    f.get.mockRejectedValueOnce(new Error("private upstream failure"));
    await expect(checkSource(f.env, f.videoId)).rejects.toMatchObject({
      status: 503,
      code: "source_read_unverified",
    });
    const row = f.native
      .prepare("SELECT details_json FROM logs WHERE stage='source_check'")
      .get()!;
    expect(JSON.parse(String(row.details_json))).toMatchObject({
      phase: "metadata",
      code: "source_read_unverified",
    });
    expect(JSON.stringify(row)).not.toContain("private upstream failure");
    unchangedSource(f);
  });
});
describe("concurrent fragment metadata cleanup with actual parser and SQLite", () => {
  function indexed() {
    // Synthetic sample payloads are not browser decoding/playback evidence.
    const f = setup(
      {},
      fragmentedMp4Fixture({ index: true, fragments: 12, mdatPadding: 8192 }),
    );
    const offsets = new Set(
      fixtureBoxes(f.bytes)
        .filter((box) => box.type === "moof")
        .map((box) => box.start),
    );
    const isHint = (options: Parameters<typeof f.get>[1]) =>
      options?.range?.length === 4096 && offsets.has(options.range.offset);
    return { ...f, isHint };
  }
  function noProof(f: ReturnType<typeof setup>) {
    expect(
      f.native
        .prepare("SELECT COUNT(*) AS n FROM source_structural_checks")
        .get()?.n,
    ).toBe(0);
    unchangedSource(f);
  }
  it("completes delayed indexed reads with at most eight concurrent exact-identity GETs", async () =>
    withFakeClock(async () => {
      const f = indexed();
      const original = f.get.getMockImplementation()!;
      let active = 0,
        peak = 0;
      f.get.mockImplementation(async (key, options) => {
        expect(options?.onlyIf).toEqual({ etagMatches: "source-etag" });
        if (!f.isHint(options)) return original(key, options);
        peak = Math.max(peak, ++active);
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 1000));
          return await original(key, options);
        } finally {
          active--;
        }
      });
      const checked = checkSource(f.env, f.videoId);
      await vi.advanceTimersByTimeAsync(10000);
      expect(await (await checked).json()).toMatchObject({
        source: {
          compatible: true,
          probe: { fragmented: { fragmentCount: 12 } },
        },
      });
      expect(peak).toBe(8);
      expect(active).toBe(0);
      const details = JSON.parse(
        String(
          f.native
            .prepare("SELECT details_json FROM logs WHERE stage='source_check'")
            .get()!.details_json,
        ),
      );
      expect(details.fragmentReadPlan).toEqual({
        basis: "mfra-hints",
        hintCount: 12,
        indexBytes: expect.any(Number),
        concurrency: 8,
      });
      expect(Object.keys(details.fragmentReadPlan).sort()).toEqual([
        "basis",
        "concurrency",
        "hintCount",
        "indexBytes",
      ]);
      expect(
        f.native
          .prepare("SELECT COUNT(*) AS n FROM source_structural_checks")
          .get()?.n,
      ).toBe(1);
      unchangedSource(f);
      expect(vi.getTimerCount()).toBe(0);
    }));
  it("closes every active metadata reader when a continuation observes the whole-check deadline", async () =>
    withFakeClock(async () => {
      const f = indexed();
      const original = f.get.getMockImplementation()!;
      const streams: {
        cancel: ReturnType<typeof vi.fn>;
        controller: ReadableStreamDefaultController<Uint8Array>;
        bytes: Uint8Array;
      }[] = [];
      f.get.mockImplementation(async (key, options) => {
        if (!f.isHint(options)) return original(key, options);
        const range = options!.range!;
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
          pull: () => new Promise<void>(() => {}),
          cancel,
        });
        streams.push({
          cancel,
          controller,
          bytes: f.bytes.slice(range.offset, range.offset + range.length),
        });
        return { ...f.stored.get(key)!, range, body };
      });
      const outcome = checkSource(f.env, f.videoId).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(streams).toHaveLength(8);
      const requests = f.get.mock.calls.length;
      // Do not fire each reader's own timer: one post-read check must close all
      // readers, including cancellations whose underlying promise never settles.
      vi.setSystemTime(new Date("2026-10-14T12:01:31Z"));
      streams[0].controller.enqueue(streams[0].bytes);
      await vi.advanceTimersByTimeAsync(0);
      expect(await outcome).toMatchObject({
        status: 504,
        code: "source_check_timeout",
      });
      for (const stream of streams)
        expect(stream.cancel).toHaveBeenCalledOnce();
      expect(f.get).toHaveBeenCalledTimes(requests);
      expect(vi.getTimerCount()).toBe(0);
      noProof(f);
    }));
  it("closes acquired readers and discards each late GET once after an early failed hint", async () =>
    withFakeClock(async () => {
      const f = indexed();
      const original = f.get.getMockImplementation()!;
      let failFirst!: (error: Error) => void;
      const failed = new Promise<Awaited<ReturnType<typeof f.get>>>(
        (_resolve, reject) => {
          failFirst = reject;
        },
      );
      const cancels: ReturnType<typeof vi.fn>[] = [];
      const late: {
        release: () => void;
        cancel: ReturnType<typeof vi.spyOn>;
        getReader: ReturnType<typeof vi.spyOn>;
      }[] = [];
      let hints = 0;
      f.get.mockImplementation(async (key, options) => {
        if (!f.isHint(options)) return original(key, options);
        const index = hints++;
        if (index === 0) return failed;
        if (index < 4) {
          const cancel = vi.fn(() => new Promise<void>(() => {}));
          cancels.push(cancel);
          return {
            ...f.stored.get(key)!,
            range: options!.range,
            body: new ReadableStream<Uint8Array>({
              pull: () => new Promise<void>(() => {}),
              cancel,
            }),
          };
        }
        const object = await original(key, options);
        if (!object || !("body" in object))
          throw new Error("Invalid local R2 fixture");
        const cancel = vi.spyOn(object.body, "cancel"),
          getReader = vi.spyOn(object.body, "getReader");
        return new Promise<typeof object>((resolve) => {
          late.push({ release: () => resolve(object), cancel, getReader });
        });
      });
      const outcome = checkSource(f.env, f.videoId).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(hints).toBe(8);
      expect(late).toHaveLength(4);
      failFirst(new Error("private pending GET failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await outcome).toMatchObject({
        status: 503,
        code: "source_read_unverified",
      });
      for (const cancel of cancels) expect(cancel).toHaveBeenCalledOnce();
      const requests = f.get.mock.calls.length;
      for (const item of late) item.release();
      await vi.advanceTimersByTimeAsync(0);
      for (const item of late) {
        expect(item.cancel).toHaveBeenCalledOnce();
        expect(item.getReader).not.toHaveBeenCalled();
      }
      expect(f.get).toHaveBeenCalledTimes(requests);
      expect(vi.getTimerCount()).toBe(0);
      noProof(f);
    }));
});
describe("private original preview and independent source versions with actual SQLite", () => {
  it.each([
    { indexTrafNumber: "global" as const, basis: "global-traf-order" },
    {
      indexTrafNumber: "track-first" as const,
      basis: "track-id-compatibility",
    },
  ])(
    "persists and reuses the fully checked $basis index proof without rescanning",
    async ({ indexTrafNumber, basis }) => {
      const f = setup(
        {},
        fragmentedMp4Fixture({ index: true, indexTrafNumber }),
      );
      const checked = await (await checkSource(f.env, f.videoId)).json();
      expect(checked).toMatchObject({
        source: {
          compatible: true,
          probe: {
            serverDecoded: false,
            fragmented: { randomAccessIndex: { basis, entries: 4 } },
          },
        },
      });
      const proof = f.native
        .prepare(
          "SELECT parser_version,result_json FROM source_structural_checks",
        )
        .get()!;
      expect(proof.parser_version).toBe("iso-bmff-source-v5");
      expect(
        JSON.parse(String(proof.result_json)).fragmented.randomAccessIndex,
      ).toEqual({ basis, entries: 4 });
      vi.resetModules();
      const cold = await import("../src/source");
      f.get.mockClear();
      f.head.mockClear();
      const range = await cold.serveSourcePreview(
        new Request("https://source-test.example/preview", {
          headers: { Range: "bytes=-16" },
        }),
        f.env,
        f.videoId,
      );
      expect(range.status).toBe(206);
      expect(range.headers.get("Cache-Control")).toContain("no-store");
      expect(new Uint8Array(await range.arrayBuffer())).toEqual(
        f.bytes.slice(-16),
      );
      expect(f.get).toHaveBeenCalledExactlyOnceWith(f.key, {
        onlyIf: { etagMatches: "source-etag" },
        range: { offset: f.bytes.length - 16, length: 16 },
      });
      expect(f.head).toHaveBeenCalledExactlyOnceWith(f.key);
      expect(
        f.native.prepare("SELECT probe_json FROM videos").get()?.probe_json,
      ).toBeNull();
      unchangedSource(f);
    },
  );
  it.each([
    {
      name: "unknown basis",
      access: { basis: "unverified-track-guess", entries: 4 },
    },
    {
      name: "fractional entries",
      access: { basis: "global-traf-order", entries: 1.5 },
    },
    {
      name: "entries exceed fragment-track combinations",
      access: { basis: "global-traf-order", entries: 5 },
    },
    {
      name: "empty compatibility claim",
      access: { basis: "track-id-compatibility", entries: 0 },
    },
    {
      name: "single-track compatibility claim",
      access: { basis: "track-id-compatibility", entries: 2 },
      singleTrack: true,
    },
    {
      name: "extra index fields",
      access: { basis: "global-traf-order", entries: 4, decoded: true },
    },
  ])(
    "rejects cached random access evidence with $name and performs a fresh full check",
    async ({ access, singleTrack }) => {
      const f = setup(
        {},
        fragmentedMp4Fixture({
          index: true,
          audio: singleTrack ? false : undefined,
        }),
      );
      await checkSource(f.env, f.videoId);
      const row = f.native
        .prepare("SELECT result_json FROM source_structural_checks")
        .get()!;
      const damaged = JSON.parse(String(row.result_json));
      damaged.fragmented.randomAccessIndex = access;
      f.native
        .prepare("UPDATE source_structural_checks SET result_json=?")
        .run(JSON.stringify(damaged));
      f.get.mockClear();
      const range = await serveSourcePreview(
        new Request("https://source-test.example/preview", {
          headers: { Range: "bytes=0-7" },
        }),
        f.env,
        f.videoId,
      );
      expect(range.status).toBe(206);
      await range.arrayBuffer();
      expect(f.get.mock.calls.length).toBeGreaterThan(1);
      const repaired = JSON.parse(
        String(
          f.native
            .prepare("SELECT result_json FROM source_structural_checks")
            .get()!.result_json,
        ),
      );
      expect(repaired.fragmented.randomAccessIndex).toEqual({
        basis: "global-traf-order",
        entries: singleTrack ? 2 : 4,
      });
      unchangedSource(f);
    },
  );
  it("persists complete fragmented structure proof and serves a cold-worker Range without rescanning", async () => {
    // These are synthetic sample tables/payloads, not decodable video evidence.
    const f = setup({}, fragmentedMp4Fixture());
    const checked = await (await checkSource(f.env, f.videoId)).json();
    expect(checked).toMatchObject({
      source: {
        compatible: true,
        probe: {
          serverDecoded: false,
          fragmented: {
            fragmentCount: 2,
            sampleRangesVerified: true,
            timelinesVerified: true,
          },
        },
      },
    });
    const stored = f.native
      .prepare(
        "SELECT parser_version,result_json FROM source_structural_checks",
      )
      .get()!;
    expect(stored.parser_version).toBe("iso-bmff-source-v5");
    expect(JSON.parse(String(stored.result_json))).toEqual(
      (checked as { source: { probe: unknown } }).source.probe,
    );
    vi.resetModules();
    const cold = await import("../src/source");
    f.get.mockClear();
    f.head.mockClear();
    const response = await cold.serveSourcePreview(
      new Request("https://source-test.example/preview", {
        headers: { Range: "bytes=-16" },
      }),
      f.env,
      f.videoId,
    );
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      f.bytes.slice(-16),
    );
    expect(f.get).toHaveBeenCalledExactlyOnceWith(f.key, {
      onlyIf: { etagMatches: "source-etag" },
      range: { offset: f.bytes.length - 16, length: 16 },
    });
    expect(f.head).toHaveBeenCalledExactlyOnceWith(f.key);
    unchangedSource(f);
  });
  it.each(["cold Worker", "six minutes later"])(
    "reuses persisted structure proof %s while every Range and HEAD rechecks the source",
    async (condition) => {
      const f = setup();
      await checkSource(f.env, f.videoId);
      expect(
        f.native
          .prepare("SELECT COUNT(*) AS n FROM source_structural_checks")
          .get()?.n,
      ).toBe(1);
      let preview = serveSourcePreview;
      if (condition === "cold Worker") {
        vi.resetModules();
        preview = (await import("../src/source")).serveSourcePreview;
      } else {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 6 * 60000);
      }
      f.get.mockClear();
      f.head.mockClear();
      for (const range of ["bytes=0-7", "bytes=-4"]) {
        const response = await preview(
          new Request("https://source-test.example/preview", {
            headers: { Range: range },
          }),
          f.env,
          f.videoId,
        );
        expect(response.status).toBe(206);
        expect(response.headers.get("Cache-Control")).toContain("no-store");
        await response.arrayBuffer();
      }
      const head = await preview(
        new Request("https://source-test.example/preview", {
          method: "HEAD",
          headers: { Range: "bytes=0-7" },
        }),
        f.env,
        f.videoId,
      );
      expect(head.status).toBe(206);
      expect(f.get).toHaveBeenCalledTimes(2);
      expect(f.get.mock.calls.map(([, options]) => options)).toEqual([
        {
          onlyIf: { etagMatches: "source-etag" },
          range: { offset: 0, length: 8 },
        },
        {
          onlyIf: { etagMatches: "source-etag" },
          range: { offset: f.bytes.length - 4, length: 4 },
        },
      ]);
      expect(f.head).toHaveBeenCalledTimes(3);
      expect(
        f.native.prepare("SELECT probe_json FROM videos").get()?.probe_json,
      ).toBeNull();
      unchangedSource(f);
    },
  );
  it.each([
    "invalid JSON",
    "decoded claim",
    "extra fields",
    "invalid fragments",
    "old parser",
    "different source key",
  ])(
    "revalidates a persisted proof with %s rather than using it for Range",
    async (corruption) => {
      const f = setup();
      await checkSource(f.env, f.videoId);
      const stored = f.native
        .prepare("SELECT result_json FROM source_structural_checks")
        .get()!;
      const proof = JSON.parse(String(stored.result_json));
      if (corruption === "old parser")
        f.native.exec(
          "UPDATE source_structural_checks SET parser_version='iso-bmff-source-v2'",
        );
      else if (corruption === "different source key")
        f.native.exec(
          "UPDATE source_structural_checks SET object_key='imports/other-source'",
        );
      else {
        const damaged =
          corruption === "invalid JSON"
            ? "{"
            : JSON.stringify({
                ...proof,
                ...(corruption === "decoded claim"
                  ? { serverDecoded: true }
                  : {}),
                ...(corruption === "extra fields"
                  ? { url: "https://untrusted.invalid/" }
                  : {}),
                ...(corruption === "invalid fragments"
                  ? { fragmented: { sampleRangesVerified: true } }
                  : {}),
              });
        f.native
          .prepare("UPDATE source_structural_checks SET result_json=?")
          .run(damaged);
      }
      f.get.mockClear();
      const response = await serveSourcePreview(
        new Request("https://source-test.example/preview", {
          headers: { Range: "bytes=0-7" },
        }),
        f.env,
        f.videoId,
      );
      expect(response.status).toBe(206);
      await response.arrayBuffer();
      expect(f.get.mock.calls.length).toBeGreaterThan(1);
      const valid = f.native
        .prepare(
          "SELECT result_json FROM source_structural_checks WHERE object_key=? AND parser_version!='iso-bmff-source-v2'",
        )
        .get(f.key)!;
      expect(JSON.parse(String(valid.result_json))).toMatchObject({
        compatible: true,
        serverDecoded: false,
      });
      expect(JSON.parse(String(valid.result_json))).not.toHaveProperty("url");
      expect(JSON.parse(String(valid.result_json))).not.toHaveProperty(
        "fragmented",
      );
      unchangedSource(f);
    },
  );
  it("bounds the persisted JSON payload without altering an existing valid proof", async () => {
    const f = setup();
    await checkSource(f.env, f.videoId);
    const previous = f.native
      .prepare("SELECT result_json FROM source_structural_checks")
      .get();
    expect(() =>
      f.native
        .prepare("UPDATE source_structural_checks SET result_json=?")
        .run(" ".repeat(4097)),
    ).toThrow();
    expect(
      f.native
        .prepare("SELECT result_json FROM source_structural_checks")
        .get(),
    ).toEqual(previous);
  });
  it.each(["network failure", "partial body", "timeout"])(
    "does not reuse an old proof when an explicit fresh check ends with %s",
    async (failure) =>
      withFakeClock(async () => {
        const f = setup();
        await checkSource(f.env, f.videoId);
        const original = f.get.getMockImplementation()!;
        if (failure === "network failure")
          f.get.mockRejectedValueOnce(new Error("untrusted upstream detail"));
        else if (failure === "timeout")
          f.get.mockImplementationOnce(() => new Promise(() => {}));
        else
          f.get.mockImplementationOnce(async (...args) => {
            const object = await original(...args);
            if (!object || !("body" in object))
              throw new Error("Fixture body missing");
            return {
              ...object,
              body: new Response(new Uint8Array([0]).buffer).body!,
            };
          });
        const outcome = checkSource(f.env, f.videoId).catch(
          (error: unknown) => error,
        );
        if (failure === "timeout") await vi.advanceTimersByTimeAsync(90000);
        expect(await outcome).toMatchObject({
          code:
            failure === "timeout"
              ? "source_check_timeout"
              : "source_read_unverified",
        });
        expect(
          f.native
            .prepare("SELECT COUNT(*) AS n FROM source_structural_checks")
            .get()?.n,
        ).toBe(0);
        f.get.mockClear();
        const response = await serveSourcePreview(
          new Request("https://source-test.example/preview", {
            headers: { Range: "bytes=0-7" },
          }),
          f.env,
          f.videoId,
        );
        await response.arrayBuffer();
        expect(f.get.mock.calls.length).toBeGreaterThan(1);
        expect(
          f.native
            .prepare("SELECT COUNT(*) AS n FROM source_structural_checks")
            .get()?.n,
        ).toBe(1);
        unchangedSource(f);
      }),
  );
  it("does not cache an incompatible fresh result or a source changed during final validation", async () => {
    const incompatible = setup();
    await checkSource(incompatible.env, incompatible.videoId);
    const unsupportedBytes = sourceMp4Fixture({ codec: "hvc1" });
    expect(unsupportedBytes.length).toBe(incompatible.bytes.length);
    incompatible.stored.get(incompatible.key)!.bytes = unsupportedBytes;
    expect(
      await (await checkSource(incompatible.env, incompatible.videoId)).json(),
    ).toMatchObject({ source: { compatible: false } });
    expect(
      incompatible.native
        .prepare("SELECT COUNT(*) AS n FROM source_structural_checks")
        .get()?.n,
    ).toBe(0);
    const changed = setup();
    const original = changed.head.getMockImplementation()!;
    changed.head
      .mockImplementationOnce(original)
      .mockImplementationOnce(async (key) => ({
        ...(await original(key))!,
        etag: "changed-after-scan",
      }));
    await expect(
      checkSource(changed.env, changed.videoId),
    ).rejects.toMatchObject({ code: "source_changed" });
    expect(
      changed.native
        .prepare("SELECT COUNT(*) AS n FROM source_structural_checks")
        .get()?.n,
    ).toBe(0);
    unchangedSource(changed);
  });
  it("checks R2 identity and directory state before using a valid persisted proof", async () => {
    for (const mutate of [
      (f: ReturnType<typeof setup>) => {
        f.stored.get(f.key)!.etag = "changed";
      },
      (f: ReturnType<typeof setup>) => {
        f.stored.get(f.key)!.size++;
      },
      (f: ReturnType<typeof setup>) => {
        f.stored.get(f.key)!.customMetadata.source_revision = "changed";
      },
      (f: ReturnType<typeof setup>) => {
        f.native.exec("UPDATE objects SET state='missing'");
      },
      (f: ReturnType<typeof setup>) => {
        f.native.exec("UPDATE uploads SET state='unknown'");
      },
    ]) {
      const f = setup();
      await checkSource(f.env, f.videoId);
      mutate(f);
      f.get.mockClear();
      await expect(
        serveSourcePreview(
          new Request("https://source-test.example/preview", {
            headers: { Range: "bytes=0-7" },
          }),
          f.env,
          f.videoId,
        ),
      ).rejects.toMatchObject({ code: "source_changed" });
      expect(f.get).not.toHaveBeenCalled();
      expect(f.processor).not.toHaveBeenCalled();
    }
  });
  it("checks actual bytes independent of filename/MIME and caches metadata for successive ranges", async () => {
    const f = setup();
    expect(await (await checkSource(f.env, f.videoId)).json()).toMatchObject({
      source: {
        compatible: true,
        probe: { serverDecoded: false, videoCodec: "avc1" },
      },
    });
    const scans = f.get.mock.calls.length;
    for (const range of ["bytes=0-7", "bytes=-4"]) {
      const result = await serveSourcePreview(
        new Request("https://source-test.example/preview", {
          headers: { Range: range },
        }),
        f.env,
        f.videoId,
      );
      expect(result.status).toBe(206);
      await result.arrayBuffer();
    }
    expect(f.get.mock.calls.length - scans).toBe(2);
    expect(f.processor).not.toHaveBeenCalled();
  });
  it("creates no published state and reuses a confirmed version without duplicating objects", async () => {
    const f = setup();
    const first = (await (await f.confirm()).json()) as { version: Version };
    expect(first.version).toMatchObject({
      mode: "source",
      manifest: "source.mp4",
      state: "verified",
      bytes: f.bytes.length,
    });
    expect(JSON.parse(first.version.validation_json!)).toMatchObject({
      kind: "source",
      serverDecoded: false,
      administratorAttestation: {
        basis: "administrator-browser-playback-and-seek",
      },
    });
    expect(
      f.native.prepare("SELECT published,current_version_id FROM videos").get(),
    ).toEqual({ published: 0, current_version_id: null });
    expect(
      ((await (await f.confirm()).json()) as { version: Version }).version.id,
    ).toBe(first.version.id);
    expect(f.native.prepare("SELECT COUNT(*) AS n FROM objects").get()?.n).toBe(
      1,
    );
    await verifyVersionObjects(f.env, first.version);
    expect(f.processor).not.toHaveBeenCalled();
  });
  it.each([
    { sourceEtag: "old" },
    { sourceRevision: "old" },
    {
      attestation: {
        played: true,
        seeked: false,
        audioConfirmed: true,
        durationSeconds: 10,
        seekFromSeconds: 0,
        seekToSeconds: 5,
      },
    },
    {
      attestation: {
        played: true,
        seeked: true,
        audioConfirmed: true,
        durationSeconds: 999,
        seekFromSeconds: 0,
        seekToSeconds: 5,
      },
    },
  ])("rejects stale identity or invalid attestation %s", async (change) => {
    const f = setup();
    await expect(
      createSourceVersion(
        f.request({
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
          ...change,
        }),
        f.env,
        f.videoId,
      ),
    ).rejects.toBeDefined();
    expect(
      f.native.prepare("SELECT COUNT(*) AS n FROM versions").get()?.n,
    ).toBe(0);
  });
  it("keeps unsupported MP4 original intact without creating HLS or source proof", async () => {
    const f = setup({ codec: "hvc1" });
    expect(await (await checkSource(f.env, f.videoId)).json()).toMatchObject({
      source: { compatible: false },
    });
    await expect(f.confirm()).rejects.toMatchObject({
      code: "source_not_supported",
    });
    await expect(
      serveSourcePreview(
        new Request("https://source-test.example/preview"),
        f.env,
        f.videoId,
      ),
    ).rejects.toMatchObject({ code: "source_not_supported" });
    expect(f.stored.has(f.key)).toBe(true);
    expect(f.processor).not.toHaveBeenCalled();
  });
  it("streams full, HEAD, prefix and suffix ranges with exact lengths and If-Range semantics", async () => {
    const f = setup();
    const v = ((await (await f.confirm()).json()) as { version: Version })
      .version;
    await publishVideo(f.request({ versionId: v.id }), f.env, f.videoId);
    const serve = (headers: HeadersInit = {}, method = "GET") =>
      serveMedia(
        new Request("https://source-test.example/media", { method, headers }),
        f.env,
        f.videoId,
        v.id,
        "source.mp4",
        false,
        {} as ExecutionContext,
      );
    let response = await serve();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.bytes);
    const reads = f.get.mock.calls.length;
    response = await serve({ Range: "bytes=0-3" }, "HEAD");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(
      `bytes 0-3/${f.bytes.length}`,
    );
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(f.get.mock.calls).toHaveLength(reads);
    response = await serve({ Range: "bytes=-4", "If-Range": '"source-etag"' });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      f.bytes.slice(-4),
    );
    for (const tag of ['"old"', 'W/"source-etag"', '"9999"']) {
      response = await serve({ Range: "bytes=0-3", "If-Range": tag });
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }
    response = await serve({
      Range: "bytes=0-3",
      "If-Range": "Tue, 13 Oct 2026 00:00:00 GMT",
    });
    expect(response.status).toBe(206);
    await response.body?.cancel();
  });
  it.each([
    "bytes=999999-",
    "bytes=3-1",
    "bytes=-0",
    "bytes=0-1,3-4",
    "bytes=0-999999999999999999999999",
  ])("returns complete 416 headers for invalid range %s", async (range) => {
    const f = setup();
    const result = await serveSourcePreview(
      new Request("https://source-test.example/preview", {
        headers: { Range: range },
      }),
      f.env,
      f.videoId,
    );
    expect(result.status).toBe(416);
    expect(result.headers.get("Content-Range")).toBe(
      `bytes */${f.bytes.length}`,
    );
    expect(result.headers.get("Content-Length")).toBe("0");
  });
  it("denies every fresh public request after unpublish and hides changed-source diagnostics", async () => {
    const f = setup();
    const v = ((await (await f.confirm()).json()) as { version: Version })
      .version;
    await publishVideo(f.request({ versionId: v.id }), f.env, f.videoId);
    const request = (method = "GET") =>
      serveMedia(
        new Request("https://source-test.example/media", {
          method,
          headers: { Range: "bytes=0-3" },
        }),
        f.env,
        f.videoId,
        v.id,
        "source.mp4",
        false,
        {} as ExecutionContext,
      );
    await (await request()).body?.cancel();
    f.native.exec("UPDATE videos SET published=0");
    const getCount = f.get.mock.calls.length;
    for (const method of ["GET", "HEAD"])
      await expect(request(method)).rejects.toMatchObject({
        status: 404,
        code: "media_unavailable",
      });
    expect(f.get.mock.calls).toHaveLength(getCount);
    f.native.exec("UPDATE videos SET published=1");
    f.stored.get(f.key)!.etag = "changed";
    await expect(request()).rejects.toMatchObject({
      status: 404,
      code: "media_unavailable",
    });
    await expect(verifySourceVersion(f.env, v)).rejects.toMatchObject({
      code: "source_changed",
    });
  });
  it("protects completed-upload, object index, metadata revision and ETag identity", async () => {
    for (const mutate of [
      (f: ReturnType<typeof setup>) =>
        f.native.exec("UPDATE uploads SET state='unknown'"),
      (f: ReturnType<typeof setup>) =>
        f.native.exec("UPDATE objects SET state='missing'"),
      (f: ReturnType<typeof setup>) => {
        f.stored.get(f.key)!.customMetadata.source_revision = "other";
      },
      (f: ReturnType<typeof setup>) => {
        f.stored.get(f.key)!.etag = "other";
      },
    ]) {
      const f = setup();
      mutate(f);
      await expect(checkSource(f.env, f.videoId)).rejects.toMatchObject({
        code: "source_changed",
      });
      expect(f.get).not.toHaveBeenCalled();
    }
  });
  it("keeps original dependencies protected even for unpublished source versions and rechecks old deletion plans", async () => {
    const f = setup();
    f.addHls();
    const oldPlan = (
      (await (
        await createDeletionPlan(
          f.request({ videoId: f.videoId, kind: "source" }),
          f.env,
        )
      ).json()) as { plan: { id: string } }
    ).plan;
    await f.confirm();
    await expect(
      createDeletionPlan(
        f.request({ videoId: f.videoId, kind: "source" }),
        f.env,
      ),
    ).rejects.toMatchObject({ code: "source_referenced" });
    await expect(
      executeDeletion(
        f.request({ confirmation: "DELETE_LISTED_OBJECTS" }),
        f.env,
        oldPlan.id,
      ),
    ).rejects.toMatchObject({ code: "source_referenced" });
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.stored.has(f.key)).toBe(true);
  });
  it("deleting a source version removes only its reference, requires unpublish, and never deletes the original", async () => {
    const f = setup();
    const v = ((await (await f.confirm()).json()) as { version: Version })
      .version;
    await publishVideo(f.request({ versionId: v.id }), f.env, f.videoId);
    const plan = (
      (await (
        await createDeletionPlan(
          f.request({ videoId: f.videoId, kind: "version", versionId: v.id }),
          f.env,
        )
      ).json()) as { plan: { id: string; objects: unknown[] } }
    ).plan;
    expect(plan.objects).toEqual([]);
    await expect(
      executeDeletion(
        f.request({ confirmation: "DELETE_LISTED_OBJECTS" }),
        f.env,
        plan.id,
      ),
    ).rejects.toMatchObject({ code: "unpublish_required" });
    expect(
      await (
        await executeDeletion(
          f.request({ confirmation: "DELETE_LISTED_OBJECTS", unpublish: true }),
          f.env,
          plan.id,
        )
      ).json(),
    ).toMatchObject({ state: "complete", releasedBytes: 0 });
    expect(f.version(v.id).state).toBe("deleted");
    expect(f.stored.has(f.key)).toBe(true);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("does not let a source proof satisfy independent HLS requirements", async () => {
    const f = setup();
    const v = ((await (await f.confirm()).json()) as { version: Version })
      .version;
    f.native
      .prepare("UPDATE versions SET state='deleted' WHERE id=?")
      .run(v.id);
    await expect(
      createDeletionPlan(
        f.request({ videoId: f.videoId, kind: "source" }),
        f.env,
      ),
    ).rejects.toMatchObject({ code: "hls_required" });
  });
  it("marks the original as referenced and atomically revokes source playback after external loss", async () => {
    const f = setup();
    f.addHls();
    const v = ((await (await f.confirm()).json()) as { version: Version })
      .version;
    await publishVideo(f.request({ versionId: v.id }), f.env, f.videoId);
    const list = (await (
      await storageList(
        new Request("https://source-test.example/storage"),
        f.env,
      )
    ).json()) as { items: { key: string; referenced: number }[] };
    expect(list.items.find((o) => o.key === f.key)?.referenced).toBe(1);
    f.stored.delete(f.key);
    await reconcileStorage(f.env);
    expect(f.version(v.id)).toMatchObject({
      state: "objects_missing",
      validation_json: null,
    });
    expect(
      f.native.prepare("SELECT published FROM videos").get()?.published,
    ).toBe(0);
    expect(f.version("hls").state).toBe("verified");
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("accepts selected private diagnostics and rejects raw diagnostics without logging them", async () => {
    const f = setup();
    expect(
      (
        await reportSourcePlayback(
          f.request({
            sourceRevision: "revision",
            phase: "error",
            nativeErrorCode: 3,
            networkState: 3,
            readyState: 0,
            currentTime: 1,
            duration: 10,
          }),
          f.env,
          f.videoId,
        )
      ).status,
    ).toBe(202);
    for (const input of [
      { url: "https://private.invalid/?token=private" },
      { message: "private raw message" },
      { phase: ["error"] },
      { duration: null },
    ])
      await expect(
        reportSourcePlayback(
          f.request({ sourceRevision: "revision", phase: "error", ...input }),
          f.env,
          f.videoId,
        ),
      ).rejects.toMatchObject({ code: "invalid_source_report" });
    const logs = f.native
      .prepare("SELECT * FROM logs WHERE stage='source_playback'")
      .all();
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toMatch(/private|http/);
  });
});

describe("private source response preparation diagnostics with actual SQLite", () => {
  async function fixture() {
    const f = setup();
    await checkSource(f.env, f.videoId);
    // A new Worker isolate has its own diagnostic sample window, while the
    // verified structural proof is persisted in the actual SQLite database.
    vi.resetModules();
    const preview = (await import("../src/source")).serveSourcePreview;
    f.get.mockClear();
    f.head.mockClear();
    return { ...f, preview };
  }
  function traces(f: ReturnType<typeof setup>) {
    return f.native
      .prepare(
        "SELECT request_id,details_json FROM logs WHERE stage='source_preview' ORDER BY rowid",
      )
      .all()
      .map((row) => ({
        requestId: row.request_id,
        ...JSON.parse(String(row.details_json)),
      }));
  }
  function failures(f: ReturnType<typeof setup>) {
    return f.native
      .prepare(
        "SELECT details_json FROM logs WHERE stage='source_preview_failed' ORDER BY rowid",
      )
      .all()
      .map((row) => JSON.parse(String(row.details_json)));
  }
  it("records four fixed phases for a 206 without logging request headers, URL or source identity", async () => {
    const f = await fixture();
    const retained: Promise<unknown>[] = [];
    const response = await f.preview(
      new Request("https://source-test.example/private?token=never-log-this", {
        headers: {
          Range: "bytes=0001-0003",
          Cookie: "private-cookie",
          Authorization: "Bearer private-credential",
        },
      }),
      f.env,
      f.videoId,
      {
        requestId: "preview-request",
        waitUntil: (pending) => {
          retained.push(pending);
        },
      },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.bodyUsed).toBe(false);
    await Promise.all(retained);
    expect(traces(f)).toEqual([
      expect.objectContaining({ phase: "request_received" }),
      expect.objectContaining({ phase: "identity_verified" }),
      expect.objectContaining({
        phase: "structure_verified",
        structureProof: "persisted",
      }),
      expect.objectContaining({
        phase: "response_started",
        status: 206,
        contentLength: 3,
        contentRange: {
          kind: "partial",
          start: 1,
          end: 3,
          total: f.bytes.length,
        },
      }),
    ]);
    for (const trace of traces(f))
      expect(trace).toMatchObject({
        requestId: "preview-request",
        method: "GET",
        range: { kind: "single", start: 1, end: 3 },
        elapsedMs: expect.any(Number),
      });
    expect(JSON.stringify(traces(f))).not.toMatch(
      /never-log-this|private-cookie|private-credential|bytes=0001|source-etag|revision|https?:|videos\//,
    );
    expect(f.get).toHaveBeenCalledOnce();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      f.bytes.slice(1, 4),
    );
    unchangedSource(f);
  });
  it("prepares a cached HEAD without an R2 GET, retaining numeric suffix diagnostics", async () => {
    const f = await fixture();
    const response = await f.preview(
      new Request("https://source-test.example/private", {
        method: "HEAD",
        headers: { Range: "bytes=-4" },
      }),
      f.env,
      f.videoId,
    );
    expect(response.status).toBe(206);
    expect(response.body).toBeNull();
    expect(f.head).toHaveBeenCalledOnce();
    expect(f.get).not.toHaveBeenCalled();
    expect(traces(f)).toHaveLength(4);
    expect(traces(f).at(-1)).toMatchObject({
      phase: "response_started",
      method: "HEAD",
      range: { kind: "suffix", suffix: 4 },
      contentLength: 4,
      contentRange: {
        kind: "partial",
        start: f.bytes.length - 4,
        end: f.bytes.length - 1,
        total: f.bytes.length,
      },
    });
    unchangedSource(f);
  });
  it.each([
    "bytes=0-1,token=private-range",
    "bytes=9007199254740992-",
    "bytes=-0",
  ])(
    "classifies invalid Range %s without retaining it or changing the 416 response",
    async (range) => {
      const f = await fixture();
      const response = await f.preview(
        new Request("https://source-test.example/private", {
          headers: { Range: range },
        }),
        f.env,
        f.videoId,
      );
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe(
        `bytes */${f.bytes.length}`,
      );
      expect(f.get).not.toHaveBeenCalled();
      expect(traces(f).at(-1)).toMatchObject({
        range: { kind: "invalid" },
        contentLength: 0,
        contentRange: { kind: "unsatisfied", total: f.bytes.length },
      });
      expect(JSON.stringify(traces(f))).not.toContain(range);
    },
  );
  it("bounds a hanging identity HEAD before any media GET, retaining the failure stage", async () =>
    withFakeClock(async () => {
      const f = await fixture();
      let release!: () => void;
      f.head.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(f.stored.get(f.key)!);
          }),
      );
      const outcome = f
        .preview(
          new Request("https://source-test.example/private"),
          f.env,
          f.videoId,
        )
        .catch((error: unknown) => error);
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(89999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({
        status: 504,
        code: "source_check_timeout",
      });
      expect(f.get).not.toHaveBeenCalled();
      expect(traces(f).map((row) => row.phase)).toEqual(["request_received"]);
      expect(failures(f)).toEqual([
        expect.objectContaining({
          phase: "identity",
          code: "source_check_timeout",
          elapsedMs: 90000,
        }),
      ]);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      unchangedSource(f);
    }));
  it("reports an upstream HEAD failure as unavailable preparation without raw upstream diagnostics", async () => {
    const f = await fixture();
    f.head.mockRejectedValueOnce(
      new Error(
        "private upstream URL https://secret.invalid/?token=credential",
      ),
    );
    await expect(
      f.preview(
        new Request("https://source-test.example/private"),
        f.env,
        f.videoId,
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "source_read_unverified",
    });
    expect(f.get).not.toHaveBeenCalled();
    expect(failures(f)).toEqual([
      expect.objectContaining({
        phase: "identity",
        code: "source_read_unverified",
      }),
    ]);
    expect(JSON.stringify(failures(f))).not.toMatch(
      /private upstream|secret.invalid|credential/,
    );
    unchangedSource(f);
  });
  it("retains verified structure but reports a failed media GET header preparation without claiming a response started", async () => {
    const f = await fixture();
    f.get.mockRejectedValueOnce(
      new Error("private media GET credential failure"),
    );
    await expect(
      f.preview(
        new Request("https://source-test.example/private", {
          headers: { Range: "bytes=0-3" },
        }),
        f.env,
        f.videoId,
      ),
    ).rejects.toMatchObject({ status: 503, code: "source_read_unverified" });
    expect(traces(f).map((row) => row.phase)).toEqual([
      "request_received",
      "identity_verified",
      "structure_verified",
    ]);
    expect(failures(f)).toEqual([
      expect.objectContaining({
        phase: "response",
        code: "source_read_unverified",
      }),
    ]);
    expect(JSON.stringify(failures(f))).not.toContain("credential failure");
    expect(
      f.native
        .prepare("SELECT COUNT(*) AS n FROM source_structural_checks")
        .get()?.n,
    ).toBe(1);
    unchangedSource(f);
  });
  it("cancels a late media body after the bounded response-header preparation wait", async () =>
    withFakeClock(async () => {
      const f = await fixture();
      const original = f.get.getMockImplementation()!;
      const object = await original(f.key, {
        onlyIf: { etagMatches: "source-etag" },
        range: { offset: 0, length: 4 },
      });
      if (!object || !("body" in object))
        throw new Error("Invalid local fixture");
      const cancel = vi.spyOn(object.body, "cancel"),
        getReader = vi.spyOn(object.body, "getReader");
      let release!: () => void;
      f.get.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(object);
          }),
      );
      const outcome = f
        .preview(
          new Request("https://source-test.example/private", {
            headers: { Range: "bytes=0-3" },
          }),
          f.env,
          f.videoId,
        )
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(90000);
      expect(await outcome).toMatchObject({
        status: 504,
        code: "source_check_timeout",
        details: { phase: "response" },
      });
      expect(traces(f).map((row) => row.phase)).toEqual([
        "request_received",
        "identity_verified",
        "structure_verified",
      ]);
      expect(failures(f)).toEqual([
        expect.objectContaining({
          phase: "response",
          code: "source_check_timeout",
        }),
      ]);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledOnce();
      expect(getReader).not.toHaveBeenCalled();
      expect(f.get).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      unchangedSource(f);
    }));
  it("leaves a prepared original stream readable after ninety seconds without reading it for diagnostics", async () =>
    withFakeClock(async () => {
      const f = await fixture();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
        cancel,
      });
      f.get.mockResolvedValueOnce({
        ...f.stored.get(f.key)!,
        range: { offset: 0, length: 4 },
        body,
      });
      const response = await f.preview(
        new Request("https://source-test.example/private", {
          headers: { Range: "bytes=0-3" },
        }),
        f.env,
        f.videoId,
      );
      expect(response.status).toBe(206);
      expect(response.bodyUsed).toBe(false);
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100000);
      expect(cancel).not.toHaveBeenCalled();
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      controller.close();
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3, 4]),
      );
      expect(cancel).not.toHaveBeenCalled();
      expect(traces(f).at(-1)).toMatchObject({
        phase: "response_started",
        elapsedMs: 0,
      });
      unchangedSource(f);
    }));
  it("does not wait for diagnostic D1 writes before returning or failing preparation", async () => {
    const f = await fixture();
    const retained: Promise<unknown>[] = [];
    const original = f.env.DB;
    const env = {
      ...f.env,
      DB: {
        prepare(sql: string) {
          if (!sql.startsWith("INSERT INTO logs")) return original.prepare(sql);
          const statement = {
            bind() {
              return statement;
            },
            run() {
              return new Promise(() => {});
            },
          };
          return statement;
        },
      },
    } as unknown as Env;
    const options = {
      waitUntil: (pending: Promise<unknown>) => {
        retained.push(pending);
      },
    };
    expect(
      (
        await f.preview(
          new Request("https://source-test.example/private", {
            method: "HEAD",
          }),
          env,
          f.videoId,
          options,
        )
      ).status,
    ).toBe(200);
    expect(retained).toHaveLength(4);
    f.head.mockRejectedValueOnce(new Error("upstream failure"));
    await expect(
      f.preview(
        new Request("https://source-test.example/private", { method: "HEAD" }),
        env,
        f.videoId,
        options,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(retained).toHaveLength(6); // request_received plus preserved failure log
    unchangedSource(f);
  });
  it("samples at most twelve traces per video per minute without restricting access or suppressing failures", async () =>
    withFakeClock(async () => {
      const f = await fixture();
      const request = () =>
        new Request("https://source-test.example/private", { method: "HEAD" });
      for (let n = 0; n < 13; n++)
        expect((await f.preview(request(), f.env, f.videoId)).status).toBe(200);
      expect(traces(f)).toHaveLength(48);
      expect(f.head).toHaveBeenCalledTimes(13);
      f.head.mockRejectedValueOnce(new Error("upstream failure"));
      await expect(
        f.preview(request(), f.env, f.videoId),
      ).rejects.toMatchObject({ status: 503 });
      expect(traces(f)).toHaveLength(48);
      expect(failures(f)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60000);
      expect((await f.preview(request(), f.env, f.videoId)).status).toBe(200);
      expect(traces(f)).toHaveLength(52);
      expect(f.get).not.toHaveBeenCalled();
      unchangedSource(f);
    }));
  it("bounds active sampling counters without evicting them or denying the thirty-third video", async () => {
    const f = await fixture();
    const fixtures = [f];
    for (let n = 1; n < 33; n++) {
      const next = setup();
      await checkSource(next.env, next.videoId);
      fixtures.push({ ...next, preview: f.preview });
    }
    for (const item of fixtures)
      expect(
        (
          await f.preview(
            new Request("https://source-test.example/private", {
              method: "HEAD",
            }),
            item.env,
            item.videoId,
          )
        ).status,
      ).toBe(200);
    expect(
      fixtures.slice(0, 32).every((item) => traces(item).length === 4),
    ).toBe(true);
    expect(traces(fixtures[32])).toHaveLength(0);
    expect(
      (
        await f.preview(
          new Request("https://source-test.example/private", {
            method: "HEAD",
          }),
          f.env,
          f.videoId,
        )
      ).status,
    ).toBe(200);
    expect(traces(f)).toHaveLength(8);
  });
  it("does not add private stream diagnostics to published anonymous source media", async () => {
    const f = await fixture();
    const version = ((await (await f.confirm()).json()) as { version: Version })
      .version;
    await publishVideo(f.request({ versionId: version.id }), f.env, f.videoId);
    const response = await serveMedia(
      new Request("https://source-test.example/media", {
        headers: { Range: "bytes=0-3" },
      }),
      f.env,
      f.videoId,
      version.id,
      "source.mp4",
      false,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(206);
    expect(traces(f)).toHaveLength(0);
    expect(failures(f)).toHaveLength(0);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      f.bytes.slice(0, 4),
    );
  });
});

describe("explicit cached preview preparation with actual SQLite", () => {
  function readSource(response: Response) {
    return response.json() as Promise<{
      source: {
        compatible: boolean;
        preparation: {
          structureProof: "persisted" | "fresh";
          elapsedMs: number;
        };
        probe: { serverDecoded: boolean };
      };
    }>;
  }

  function latestCheck(f: ReturnType<typeof setup>) {
    const row = f.native
      .prepare(
        "SELECT details_json FROM logs WHERE stage='source_check' ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    return JSON.parse(String(row?.details_json || "{}"));
  }

  it("reuses an exact persisted proof across module instances after a fresh HEAD, without metadata GETs", async () => {
    const f = setup();
    await checkSource(f.env, f.videoId);
    const proof = f.native
      .prepare("SELECT result_json,verified_at FROM source_structural_checks")
      .get();
    f.head.mockClear();
    f.get.mockClear();
    vi.resetModules();
    const { checkSource: coldCheck } = await import("../src/source");
    const result = await readSource(
      await coldCheck(f.env, f.videoId, { fresh: false }),
    );
    expect(result.source).toMatchObject({
      videoId: f.videoId,
      compatible: true,
      preparation: { structureProof: "persisted" },
      probe: { serverDecoded: false },
    });
    expect(Number.isSafeInteger(result.source.preparation.elapsedMs)).toBe(
      true,
    );
    expect(result.source.preparation.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(f.head).toHaveBeenCalledExactlyOnceWith(f.key);
    expect(f.get).not.toHaveBeenCalled();
    expect(
      f.native
        .prepare("SELECT result_json,verified_at FROM source_structural_checks")
        .get(),
    ).toEqual(proof);
    expect(latestCheck(f)).toMatchObject({
      code: "checked",
      structureProof: "persisted",
      rangeReads: 0,
      metadataBytesRead: 0,
    });
    expect(
      f.native.prepare("SELECT COUNT(*) AS n FROM versions").get()?.n,
    ).toBe(0);
    unchangedSource(f);
  });

  it("persists and reuses native edit proof after presentation coverage validation", async () => {
    const f = setup({
      edit: true,
      editMediaTime: 20,
      audioEditDurationTicks: 9800,
      composition: [{ count: 2, offset: 20 }],
    });
    await checkSource(f.env, f.videoId);
    f.get.mockClear();
    const result = await readSource(
      await checkSource(f.env, f.videoId, { fresh: false }),
    );
    expect(result.source.preparation.structureProof).toBe("persisted");
    expect(f.get).not.toHaveBeenCalled();
    const stored = f.native
      .prepare("SELECT result_json FROM source_structural_checks")
      .get()!;
    expect(JSON.parse(String(stored.result_json)).nativeEdits).toEqual([
      { track: "video", mediaStartSeconds: 0.02, durationSeconds: 10 },
      { track: "audio", mediaStartSeconds: 0.02, durationSeconds: 9.8 },
    ]);
    unchangedSource(f);
  });

  it("persists a leading empty edit with its movie offset and reuses unchanged source bytes", async () => {
    const f = setup({
      edit: true,
      movieDurationTicks: 10040,
      videoEmptyEditDurationTicks: 40,
      editMediaTime: 20,
      audioEditDurationTicks: 9800,
      composition: [{ count: 2, offset: 20 }],
    });
    await checkSource(f.env, f.videoId);
    f.get.mockClear();
    const result = await readSource(
      await checkSource(f.env, f.videoId, { fresh: false }),
    );
    expect(result.source.preparation.structureProof).toBe("persisted");
    expect(f.get).not.toHaveBeenCalled();
    const stored = f.native
      .prepare(
        "SELECT parser_version,result_json FROM source_structural_checks",
      )
      .get()!;
    expect(stored.parser_version).toBe("iso-bmff-source-v5");
    expect(JSON.parse(String(stored.result_json)).nativeEdits).toEqual([
      {
        track: "video",
        mediaStartSeconds: 0.02,
        durationSeconds: 10,
        movieStartSeconds: 0.04,
      },
      { track: "audio", mediaStartSeconds: 0.02, durationSeconds: 9.8 },
    ]);
    unchangedSource(f);
  });

  it.each([-0.01, 0, 0.2])(
    "rescans an invalid persisted movie edit offset (%s)",
    async (movieStartSeconds) => {
      const f = setup({
        edit: true,
        movieDurationTicks: 10040,
        videoEmptyEditDurationTicks: 40,
      });
      await checkSource(f.env, f.videoId);
      const stored = f.native
        .prepare("SELECT result_json FROM source_structural_checks")
        .get()!;
      const proof = JSON.parse(String(stored.result_json));
      proof.nativeEdits[0].movieStartSeconds = movieStartSeconds;
      f.native
        .prepare("UPDATE source_structural_checks SET result_json=?")
        .run(JSON.stringify(proof));
      f.get.mockClear();
      const result = await readSource(
        await checkSource(f.env, f.videoId, { fresh: false }),
      );
      expect(result.source.preparation.structureProof).toBe("fresh");
      expect(f.get).toHaveBeenCalled();
      unchangedSource(f);
    },
  );

  it("rescans a persisted proof that claims an audio edit without an audio track", async () => {
    const f = setup({ audio: false });
    await checkSource(f.env, f.videoId);
    const row = f.native
      .prepare("SELECT result_json FROM source_structural_checks")
      .get()!;
    const proof = JSON.parse(String(row.result_json));
    proof.nativeEdits = [
      { track: "audio", mediaStartSeconds: 0, durationSeconds: 10 },
    ];
    f.native
      .prepare("UPDATE source_structural_checks SET result_json=?")
      .run(JSON.stringify(proof));
    f.get.mockClear();
    const result = await readSource(
      await checkSource(f.env, f.videoId, { fresh: false }),
    );
    expect(result.source.preparation.structureProof).toBe("fresh");
    expect(f.get).toHaveBeenCalled();
    const repaired = f.native
      .prepare("SELECT result_json FROM source_structural_checks")
      .get()!;
    expect(JSON.parse(String(repaired.result_json))).not.toHaveProperty(
      "nativeEdits",
    );
    unchangedSource(f);
  });

  it("reports the actual server preparation wait including admission and identity rather than a decode claim", async () =>
    withFakeClock(async () => {
      const f = setup();
      await checkSource(f.env, f.videoId);
      f.head.mockClear();
      f.get.mockClear();
      const head = f.head.getMockImplementation()!;
      f.head.mockImplementation(async (key) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return head(key);
      });
      const pending = checkSource(f.env, f.videoId, {
        fresh: false,
        beforeCheck: () => new Promise((resolve) => setTimeout(resolve, 10)),
      });
      await vi.advanceTimersByTimeAsync(30);
      const result = await readSource(await pending);
      expect(result.source.preparation).toEqual({
        structureProof: "persisted",
        elapsedMs: 30,
      });
      expect(latestCheck(f)).toMatchObject({
        structureProof: "persisted",
        elapsedMs: 30,
      });
      expect(result.source.probe.serverDecoded).toBe(false);
      expect(f.get).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }));

  it.each([
    "missing object",
    "different ETag",
    "wrong revision metadata",
    "missing directory object",
    "unverified upload",
  ])("rejects %s before reusing a stored proof", async (change) => {
    const f = setup();
    await checkSource(f.env, f.videoId);
    if (change === "missing object") f.stored.delete(f.key);
    if (change === "different ETag") f.stored.get(f.key)!.etag = "changed";
    if (change === "wrong revision metadata")
      f.stored.get(f.key)!.customMetadata.source_revision = "changed";
    if (change === "missing directory object")
      f.native.exec("UPDATE objects SET state='missing'");
    if (change === "unverified upload")
      f.native.exec("UPDATE uploads SET state='unknown'");
    f.get.mockClear();
    await expect(
      checkSource(f.env, f.videoId, { fresh: false }),
    ).rejects.toMatchObject({ code: "source_changed" });
    expect(f.get).not.toHaveBeenCalled();
    expect(latestCheck(f)).not.toHaveProperty("structureProof");
    expect(f.processor).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it.each(["HEAD", "proof lookup"])(
    "does not turn a failed %s into a reused compatible result",
    async (failure) => {
      const f = setup();
      await checkSource(f.env, f.videoId);
      f.get.mockClear();
      if (failure === "HEAD")
        f.head.mockRejectedValueOnce(new Error("fixture read unavailable"));
      else {
        const prepare = f.env.DB.prepare.bind(f.env.DB);
        vi.spyOn(f.env.DB, "prepare").mockImplementation((sql) => {
          if (sql.startsWith("SELECT state,result_json,verified_at"))
            throw new Error("fixture read unavailable");
          return prepare(sql);
        });
      }
      await expect(
        checkSource(f.env, f.videoId, { fresh: false }),
      ).rejects.toThrow("fixture read unavailable");
      expect(f.get).not.toHaveBeenCalled();
      expect(latestCheck(f)).toMatchObject({ code: "source_read_unverified" });
      expect(latestCheck(f)).not.toHaveProperty("structureProof");
      expect(
        f.native.prepare("SELECT COUNT(*) AS n FROM versions").get()?.n,
      ).toBe(0);
      unchangedSource(f);
    },
  );

  it.each(["missing", "malformed", "old parser", "incompatible claim"])(
    "falls back to complete validation for a %s proof",
    async (invalid) => {
      const f = setup();
      await checkSource(f.env, f.videoId);
      if (invalid === "missing")
        f.native.exec("DELETE FROM source_structural_checks");
      if (invalid === "malformed")
        f.native.exec("UPDATE source_structural_checks SET result_json='{' ");
      if (invalid === "old parser")
        f.native.exec(
          "UPDATE source_structural_checks SET parser_version='iso-bmff-source-v2'",
        );
      if (invalid === "incompatible claim")
        f.native.exec(
          "UPDATE source_structural_checks SET result_json=json_set(result_json,'$.compatible',json('false'))",
        );
      f.head.mockClear();
      f.get.mockClear();
      const result = await readSource(
        await checkSource(f.env, f.videoId, { fresh: false }),
      );
      expect(result.source).toMatchObject({
        compatible: true,
        preparation: { structureProof: "fresh" },
      });
      expect(f.get.mock.calls.length).toBeGreaterThan(0);
      expect(f.head).toHaveBeenCalledTimes(2);
      expect(latestCheck(f)).toMatchObject({ structureProof: "fresh" });
      unchangedSource(f);
    },
  );

  it("does not describe incompatible inspection as a reusable proof", async () => {
    const f = setup({ codec: "hvc1" });
    const result = await readSource(
      await checkSource(f.env, f.videoId, { fresh: false }),
    );
    expect(result.source.compatible).toBe(false);
    expect(result.source).not.toHaveProperty("preparation");
    expect(latestCheck(f)).not.toHaveProperty("structureProof");
    expect(
      f.native
        .prepare("SELECT COUNT(*) AS n FROM source_structural_checks")
        .get()?.n,
    ).toBe(0);
    unchangedSource(f);
  });

  it("keeps legacy checks fresh and version creation independently fresh despite a warm proof", async () => {
    const f = setup();
    await checkSource(f.env, f.videoId);
    f.get.mockClear();
    const checked = await readSource(await checkSource(f.env, f.videoId));
    expect(checked.source.preparation.structureProof).toBe("fresh");
    expect(f.get.mock.calls.length).toBeGreaterThan(0);
    unchangedSource(f);
    f.get.mockClear();
    await f.confirm();
    expect(f.get.mock.calls.length).toBeGreaterThan(0);
    expect(
      f.native.prepare("SELECT COUNT(*) AS n FROM versions").get()?.n,
    ).toBe(1);
    expect(
      f.native.prepare("SELECT published,current_version_id FROM videos").get(),
    ).toEqual({ published: 0, current_version_id: null });
    expect(f.stored.get(f.key)?.bytes).toEqual(f.bytes);
    expect(f.processor).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it("cannot reuse the prior proof after an explicit fresh inspection fails", async () => {
    const f = setup();
    await checkSource(f.env, f.videoId);
    f.get.mockRejectedValueOnce(new Error("fixture range unavailable"));
    await expect(
      checkSource(f.env, f.videoId, { fresh: true }),
    ).rejects.toMatchObject({ code: "source_read_unverified" });
    expect(
      f.native
        .prepare("SELECT COUNT(*) AS n FROM source_structural_checks")
        .get()?.n,
    ).toBe(0);
    f.get.mockClear();
    const result = await readSource(
      await checkSource(f.env, f.videoId, { fresh: false }),
    );
    expect(result.source.preparation.structureProof).toBe("fresh");
    expect(f.get.mock.calls.length).toBeGreaterThan(0);
    unchangedSource(f);
  });

  async function routed() {
    vi.doMock("cloudflare:workers", () => ({
      DurableObject: class {},
      WorkerEntrypoint: class {},
    }));
    const [{ default: worker }, { login }] = await Promise.all([
      import("../src/index"),
      import("../src/auth"),
    ]);
    const f = setup();
    await checkSource(f.env, f.videoId);
    const coordinate = vi.fn(async () => Response.json({ allowed: true }));
    f.env.APP_ENV = "test";
    f.env.ADMIN_PASSWORD = "offline-test-password";
    f.env.SESSION_SECRET = "offline-test-session-secret-longer-than-32";
    f.env.COORDINATOR = {
      idFromName: () => "admission",
      get: () => ({ fetch: coordinate }),
    } as unknown as DurableObjectNamespace;
    const origin = "https://source-test.example";
    const session = await login(
      new Request(`${origin}/api/admin/login`, {
        method: "POST",
        headers: { Origin: origin },
        body: JSON.stringify({ password: f.env.ADMIN_PASSWORD }),
      }),
      f.env,
    );
    const cookie = session.headers.get("Set-Cookie")!.split(";")[0];
    coordinate.mockClear();
    f.get.mockClear();
    f.head.mockClear();
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as unknown as ExecutionContext;
    return {
      ...f,
      coordinate,
      fetch: async (query: string, authenticated = true) => {
        const response = await worker.fetch(
          new Request(`${origin}/api/admin/source/${f.videoId}/check${query}`, {
            headers: authenticated ? { Cookie: cookie } : {},
          }),
          f.env,
          ctx,
        );
        await Promise.allSettled(pending.splice(0));
        return response;
      },
    };
  }

  it("only accepts explicit reuse=1 while the authenticated legacy route remains fresh", async () => {
    const f = await routed();
    const cached = await f.fetch("?reuse=1");
    expect(cached.status).toBe(200);
    expect(await cached.json()).toMatchObject({
      source: { preparation: { structureProof: "persisted" } },
    });
    expect(cached.headers.get("Cache-Control")).toContain("no-store");
    expect(f.head).toHaveBeenCalledTimes(1);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.coordinate).toHaveBeenCalledOnce();
    const fresh = await f.fetch("");
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({
      source: { preparation: { structureProof: "fresh" } },
    });
    expect(f.get.mock.calls.length).toBeGreaterThan(0);
    expect(f.coordinate).toHaveBeenCalledTimes(2);
    unchangedSource(f);
  });

  it.each(["?reuse=0", "?reuse=true", "?reuse=", "?reuse=1&reuse=1"])(
    "rejects ambiguous/invalid %s before rate, identity or storage work",
    async (query) => {
      const f = await routed();
      const response = await f.fetch(query);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "invalid_source_reuse" },
      });
      expect(f.coordinate).not.toHaveBeenCalled();
      expect(f.head).not.toHaveBeenCalled();
      expect(f.get).not.toHaveBeenCalled();
      unchangedSource(f);
    },
  );

  it.each(["?reuse=1", "?reuse=invalid"])(
    "requires administrator authentication before interpreting %s",
    async (query) => {
      const f = await routed();
      const response = await f.fetch(query, false);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "login_required" },
      });
      expect(f.coordinate).not.toHaveBeenCalled();
      expect(f.head).not.toHaveBeenCalled();
      expect(f.get).not.toHaveBeenCalled();
      unchangedSource(f);
    },
  );
});
