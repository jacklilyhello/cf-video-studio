import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
import {
  TaskBridge,
  safeOutputName,
  validFaststartValidation,
} from "../src/processor";
import { sourceMp4Fixture } from "./source-fixture";
import type { Env } from "../src/types";

interface Statement {
  get(...values: unknown[]): Record<string, unknown> | undefined;
  all(...values: unknown[]): Record<string, unknown>[];
  run(...values: unknown[]): { changes: number | bigint };
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
const { DatabaseSync } = (await import("node:sqlite" as string)) as {
  DatabaseSync: new (path: string) => Database;
};
const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: URL, encoding: string): string;
};
const databases: Database[] = [];
const prefix = "videos/video/versions/version/";
const sourceKey = "videos/video/source/revision";
const sha = "a".repeat(64);
const validation = () => ({
  outputKind: "mp4",
  faststartVerified: true,
  allPacketsDecoded: true,
  packetTimelinesVerified: true,
  codecAndResolutionVerified: true,
  copiedStreamsVerified: true,
  mediaMetadataPreserved: true,
  copiedStreams: [
    {
      type: "video",
      packets: 2,
      sha256: sha,
      outputPackets: 2,
      outputSha256: sha,
    },
    {
      type: "audio",
      packets: 2,
      sha256: sha,
      outputPackets: 2,
      outputSha256: sha,
    },
  ],
  durationDifferenceSeconds: 0,
  syncOffsetDifferenceSeconds: 0,
  syncEndOffsetDifferenceSeconds: 0,
  browserPlaybackAndSeeking: "pending_admin_preview",
});
async function digest(bytes: Uint8Array) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
async function fixture(mode = "faststart") {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  native.exec(
    readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
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
          return { results: prepared.all(...values), success: true };
        },
        async run() {
          return {
            meta: { changes: Number(prepared.run(...values).changes) },
            success: true,
          };
        },
      };
      return statement;
    },
  };
  // Synthetic structural media only; container decode/copy flags below are
  // fixture receipts, never evidence that these sample bytes actually decode.
  const source = sourceMp4Fixture();
  const optimized = sourceMp4Fixture({ tail: false });
  const checksum = await digest(optimized);
  const plan = {
    mode,
    quality: "source",
    encoding: "copy-only",
    sourceKey,
    sourceBytes: source.length,
    sourceRevision: "revision",
    sourceEtag: "source-etag",
    outputKind: mode === "faststart" ? "mp4" : "hls",
    outputName: mode === "faststart" ? "optimized.mp4" : "index.m3u8",
    maxUploadAttempts: 3,
    maxMediaObjects: mode === "faststart" ? 1 : 100,
    maxOutputBytes: 100000,
  };
  native
    .prepare(
      "INSERT INTO videos(id,title,source_key,source_size,source_etag,source_revision,source_name,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'ready',1,1)",
    )
    .run(
      "video",
      "video",
      sourceKey,
      source.length,
      "source-etag",
      "revision",
      "input.mp4",
    );
  native
    .prepare(
      "INSERT INTO versions(id,video_id,task_id,prefix,state,mode,quality,timeline_id,created_at) VALUES('version','video','task',?,'processing',?,'source','timeline',1)",
    )
    .run(prefix, mode);
  native
    .prepare(
      "INSERT INTO quotes(id,video_id,source_revision,source_etag,mode,quality,period_start,expires_at,state,data_json,created_at) VALUES('quote','video','revision','source-etag',?,'source','period',?,'confirmed',?,1)",
    )
    .run(mode, Date.now() + 60000, JSON.stringify(plan));
  native
    .prepare(
      "INSERT INTO jobs(id,video_id,version_id,quote_id,state,stage,deadline_at,created_at,updated_at) VALUES('task','video','version','quote','running','uploading',?,1,1)",
    )
    .run(Date.now() + 60000);
  native
    .prepare(
      "INSERT INTO reservations(id,owner_id,kind,amounts_json,state,created_at) VALUES('reserve','task','processing','{}','active',1)",
    )
    .run();
  const stored = new Map<
    string,
    { data: Uint8Array; etag: string; checksum?: string }
  >([[sourceKey, { data: source, etag: "source-etag" }]]);
  const metadata = (
    key: string,
    item: { data: Uint8Array; etag: string; checksum?: string },
  ) => ({
    key,
    size: item.data.length,
    etag: item.etag,
    httpEtag: `"${item.etag}"`,
    checksums: item.checksum
      ? {
          sha256: Uint8Array.from(item.checksum.match(/../g)!, (n) =>
            parseInt(n, 16),
          ).buffer,
        }
      : {},
  });
  const media = {
    head: vi.fn(async (key: string) =>
      stored.has(key) ? metadata(key, stored.get(key)!) : null,
    ),
    list: vi.fn(async () => ({
      objects: [...stored]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, item]) => metadata(key, item)),
      truncated: false,
    })),
    get: vi.fn(
      async (
        key: string,
        options?: {
          onlyIf?: { etagMatches: string };
          range?: { offset: number; length: number };
        },
      ) => {
        const item = stored.get(key);
        if (!item) return null;
        if (options?.onlyIf && options.onlyIf.etagMatches !== item.etag)
          return metadata(key, item);
        const range = options?.range;
        const data = range
          ? item.data.slice(range.offset, range.offset + range.length)
          : item.data;
        return {
          ...metadata(key, item),
          ...(range ? { range } : {}),
          body: new Response(new Uint8Array(data)).body!,
          text: async () => new TextDecoder().decode(data),
        };
      },
    ),
    put: vi.fn(
      async (
        key: string,
        stream: ReadableStream,
        options: { sha256: string },
      ) => {
        const data = new Uint8Array(await new Response(stream).arrayBuffer());
        const actual = await digest(data);
        if (actual !== options.sha256) throw new Error("R2 checksum rejected");
        stored.set(key, { data, etag: "output-etag", checksum: actual });
        return metadata(key, stored.get(key)!);
      },
    ),
  };
  const finish = vi.fn(async () => Response.json({ finishing: true }));
  const env = {
    DB: db,
    MEDIA: media,
    PROCESSOR: { idFromName: () => "task", get: () => ({ fetch: finish }) },
  } as unknown as Env;
  const bridge = new TaskBridge({ props: { taskId: "task" } } as never, env);
  const put = (
    name = "optimized.mp4",
    content = optimized,
    contentHash = checksum,
  ) =>
    bridge.fetch(
      new Request(`http://task.internal/output/${name}`, {
        method: "PUT",
        body: content,
        headers: {
          "Content-Length": String(content.length),
          "X-Content-SHA256": contentHash,
        },
      }),
    );
  const complete = (change: Record<string, unknown> = {}) =>
    bridge.fetch(
      new Request("http://task.internal/complete", {
        method: "POST",
        body: JSON.stringify({
          manifest: "optimized.mp4",
          objects: [
            { name: "optimized.mp4", size: optimized.length, sha256: checksum },
          ],
          durationSeconds: 10,
          validation: validation(),
          ...change,
        }),
      }),
    );
  return {
    native,
    env,
    media,
    stored,
    optimized,
    checksum,
    finish,
    put,
    complete,
  };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe("faststart task-scoped MP4 bridge", () => {
  it("keeps HLS and MP4 paths disjoint, rejects source/unknown modes", () => {
    expect(safeOutputName("optimized.mp4", "faststart")).toBe(true);
    for (const name of [
      "index.m3u8",
      "segment-000001.ts",
      "../optimized.mp4",
      "source.mp4",
    ])
      expect(safeOutputName(name, "faststart")).toBe(false);
    for (const mode of ["probe-remux", "transcode", "source", "unknown"])
      expect(safeOutputName("optimized.mp4", mode)).toBe(false);
  });
  it("only writes immutable version-owned mp4 and accepts matching duplicate receipts", async () => {
    const f = await fixture();
    expect((await f.put()).status).toBe(200);
    expect(await (await f.put()).json()).toMatchObject({
      stored: true,
      duplicate: true,
      name: "optimized.mp4",
    });
    expect(f.media.put).toHaveBeenCalledTimes(1);
    expect(f.media.put.mock.calls[0][2]).toMatchObject({
      httpMetadata: { contentType: "video/mp4" },
    });
    expect(
      f.native
        .prepare(
          "SELECT category,state FROM objects WHERE version_id='version'",
        )
        .get(),
    ).toEqual({ category: "mp4", state: "present" });
    const source = f.stored.get(sourceKey)!;
    const changed = f.optimized.slice();
    changed[changed.length - 1] ^= 1;
    expect(
      (await f.put("optimized.mp4", changed, await digest(changed))).status,
    ).toBe(409);
    expect(f.stored.get(sourceKey)).toBe(source);
    expect(f.finish).not.toHaveBeenCalled();
  });
  it.each(["index.m3u8", "segment-000001.ts", "source.mp4"])(
    "denies %s for faststart without R2 mutation",
    async (name) => {
      const f = await fixture();
      expect((await f.put(name)).status).toBe(403);
      expect(f.media.put).not.toHaveBeenCalled();
    },
  );
  it("denies optimized MP4 on an HLS task", async () => {
    const f = await fixture("probe-remux");
    expect((await f.put()).status).toBe(403);
    expect(f.media.put).not.toHaveBeenCalled();
  });
  it("checks actual R2 ranges and persists proof, leaving verification/budget to stop supervision", async () => {
    const f = await fixture();
    await f.put();
    expect((await f.complete()).status).toBe(200);
    const version = f.native
      .prepare(
        "SELECT state,manifest,bytes,validation_json FROM versions WHERE id='version'",
      )
      .get()!;
    expect(version).toMatchObject({
      state: "processing",
      manifest: "optimized.mp4",
      bytes: f.optimized.length,
    });
    expect(JSON.parse(String(version.validation_json))).toMatchObject({
      ...validation(),
      actualR2Objects: 1,
      r2PutChecksumsVerified: true,
      completionR2EtagsSizesVerified: true,
      mp4Structure: { compatible: true, index: { placement: "before-media" } },
    });
    expect(f.media.get).toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledOnce();
    expect(
      f.native.prepare("SELECT stop_verified FROM jobs WHERE id='task'").get(),
    ).toEqual({ stop_verified: 0 });
    expect(
      f.native
        .prepare("SELECT state FROM reservations WHERE id='reserve'")
        .get(),
    ).toEqual({ state: "active" });
  });
  it.each([
    {},
    { manifest: "index.m3u8" },
    { objects: [] },
    {
      objects: [
        { name: "optimized.mp4", size: 1, sha256: sha },
        { name: "optimized.mp4", size: 1, sha256: sha },
      ],
    },
  ])("rejects incomplete/wrong completion contract %j", async (change) => {
    const f = await fixture();
    await f.put();
    expect(
      (
        await f.complete(
          Object.keys(change).length
            ? change
            : {
                validation: {
                  allSegmentsDecoded: true,
                  playlistDecoded: true,
                  keyframeStarts: true,
                  codecAndResolutionVerified: true,
                },
              },
        )
      ).status,
    ).toBe(409);
    expect(f.finish).not.toHaveBeenCalled();
  });
  it.each([
    "faststartVerified",
    "allPacketsDecoded",
    "packetTimelinesVerified",
    "codecAndResolutionVerified",
    "copiedStreamsVerified",
    "mediaMetadataPreserved",
  ])("requires independent %s evidence", async (key) => {
    const f = await fixture();
    await f.put();
    expect(
      (await f.complete({ validation: { ...validation(), [key]: false } }))
        .status,
    ).toBe(409);
    expect(f.finish).not.toHaveBeenCalled();
  });
  it("rejects nonfinite/out-of-bounds offsets and malformed copy stream receipts", () => {
    expect(validFaststartValidation(validation())).toBe(true);
    for (const value of [NaN, Infinity, null, "0", 0.251])
      expect(
        validFaststartValidation({
          ...validation(),
          durationDifferenceSeconds: value,
        }),
      ).toBe(false);
    for (const copiedStreams of [
      [],
      [
        {
          type: "audio",
          packets: 2,
          sha256: sha,
          outputPackets: 2,
          outputSha256: sha,
        },
      ],
      [{ ...validation().copiedStreams[0], packets: 0 }],
      [{ ...validation().copiedStreams[0], outputPackets: 1 }],
      [{ ...validation().copiedStreams[0], outputSha256: "b".repeat(64) }],
      [validation().copiedStreams[0], validation().copiedStreams[0]],
    ])
      expect(validFaststartValidation({ ...validation(), copiedStreams })).toBe(
        false,
      );
  });
  it.each(["etag", "size", "extra", "category", "uploading", "checksum"])(
    "rejects actual/indexed inventory mismatch: %s",
    async (reason) => {
      const f = await fixture();
      await f.put();
      if (reason === "etag")
        f.stored.get(prefix + "optimized.mp4")!.etag = "changed";
      if (reason === "size")
        f.stored.get(prefix + "optimized.mp4")!.data = f.optimized.slice(1);
      if (reason === "extra")
        f.stored.set(prefix + "extra.mp4", {
          data: f.optimized,
          etag: "extra",
        });
      if (reason === "checksum")
        f.stored.get(prefix + "optimized.mp4")!.checksum = "b".repeat(64);
      if (reason === "category")
        f.native
          .prepare(
            "UPDATE objects SET category='hls' WHERE version_id='version'",
          )
          .run();
      if (reason === "uploading")
        f.native
          .prepare(
            "UPDATE objects SET state='uploading' WHERE version_id='version'",
          )
          .run();
      expect((await f.complete()).status).toBe(409);
      expect(f.finish).not.toHaveBeenCalled();
    },
  );
  it("rejects a tail moov despite a claimed successful faststart receipt", async () => {
    const f = await fixture();
    const tail = sourceMp4Fixture();
    const checksum = await digest(tail);
    await f.put("optimized.mp4", tail, checksum);
    expect(
      (
        await f.complete({
          objects: [
            { name: "optimized.mp4", size: tail.length, sha256: checksum },
          ],
        })
      ).status,
    ).toBe(409);
    expect(f.finish).not.toHaveBeenCalled();
  });
  it("requires audio copy evidence when the actual MP4 contains audio", async () => {
    const f = await fixture();
    await f.put();
    expect(
      (
        await f.complete({
          validation: {
            ...validation(),
            copiedStreams: [validation().copiedStreams[0]],
          },
        })
      ).status,
    ).toBe(409);
    expect(f.finish).not.toHaveBeenCalled();
  });
  it.each(["source", "cancel", "deadline", "atomic-cancel"])(
    "refuses late completion after %s changes during real structure reads",
    async (reason) => {
      const f = await fixture();
      await f.put();
      const get = f.media.get.getMockImplementation()!;
      let changed = false;
      f.media.get.mockImplementation(async (...args) => {
        if (!changed) {
          changed = true;
          if (reason === "cancel")
            f.native
              .prepare("UPDATE jobs SET state='stopping' WHERE id='task'")
              .run();
          if (reason === "deadline")
            f.native
              .prepare("UPDATE jobs SET deadline_at=1 WHERE id='task'")
              .run();
          if (reason === "source") f.stored.get(sourceKey)!.etag = "changed";
        }
        return get(...args);
      });
      if (reason === "atomic-cancel") {
        f.native.exec(
          "CREATE TRIGGER cancel_before_complete BEFORE UPDATE OF manifest ON versions BEGIN UPDATE jobs SET state='stopping' WHERE id='task'; SELECT RAISE(IGNORE); END;",
        );
      }
      expect((await f.complete()).status).toBe(409);
      expect(f.finish).not.toHaveBeenCalled();
      expect(
        f.native
          .prepare("SELECT manifest FROM versions WHERE id='version'")
          .get(),
      ).toEqual({ manifest: null });
    },
  );
});
