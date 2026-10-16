import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyVersionObjects } from "../src/inventory";
import {
  cancelDeletionPlan,
  createDeletionPlan,
  getDeletionPlan,
  listDeletionPlans,
  executeDeletion,
  reconcileStorage,
  storageList,
} from "../src/storage";
import { sourceMp4Fixture } from "./source-fixture";
import { publishVideo } from "../src/videos";
import type { Env, Version } from "../src/types";

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
const prefix = "videos/video/versions/version/";
const sourceKey = "videos/video/source/revision";
const missingSegment = prefix + "segment-000002.ts";

function setup() {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  for (const file of [
    "0001_initial.sql",
    "0002_imports.sql",
    "0003_deletion_items.sql",
    "0005_publication_revision.sql",
  ])
    native.exec(
      readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
    );
  let failNext: ((sql: string) => boolean) | undefined;
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
          if (failNext?.(sql)) {
            failNext = undefined;
            throw new Error("Injected D1 failure");
          }
          const result = prepared.run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
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
  const manifest =
    "#EXTM3U\n#EXTINF:6,\nsegment-000001.ts\n#EXTINF:6,\nsegment-000002.ts\n#EXT-X-ENDLIST\n";
  // Synthetic inventory tests do not claim actual media decoding or cloud R2 access.
  const stored = new Map([
    [sourceKey, { key: sourceKey, size: 4, etag: "source-etag" }],
    [
      prefix + "index.m3u8",
      {
        key: prefix + "index.m3u8",
        size: new TextEncoder().encode(manifest).length,
        etag: "manifest-etag",
      },
    ],
    [
      prefix + "segment-000001.ts",
      { key: prefix + "segment-000001.ts", size: 10, etag: "first-etag" },
    ],
    [missingSegment, { key: missingSegment, size: 10, etag: "second-etag" }],
  ]);
  const totalBytes = [...stored.values()].reduce((sum, o) => sum + o.size, 0);
  native
    .prepare(
      "INSERT INTO videos(id,title,source_key,source_size,source_etag,source_revision,source_name,status,published,current_version_id,created_at,updated_at) VALUES('video','Video',?,4,'source-etag','revision','video.mp4','ready',1,'version',1,1)",
    )
    .run(sourceKey);
  native
    .prepare(
      "INSERT INTO versions(id,video_id,prefix,state,mode,quality,manifest,bytes,duration,timeline_id,validation_json,created_at) VALUES('version','video',?,'verified','probe-remux','source','index.m3u8',?,12,'timeline',?,1)",
    )
    .run(
      prefix,
      totalBytes - 4,
      JSON.stringify({
        actualR2Objects: 3,
        segmentCount: 2,
        allSegmentsDecoded: true,
        playlistDecoded: true,
        keyframeStarts: true,
        codecAndResolutionVerified: true,
        r2PutChecksumsVerified: true,
        completionR2EtagsSizesVerified: true,
      }),
    );
  for (const object of stored.values())
    native
      .prepare(
        "INSERT INTO objects(key,video_id,version_id,category,bytes,etag,state,updated_at) VALUES(?,'video',?,?,?,?,'present',1)",
      )
      .run(
        object.key,
        object.key === sourceKey ? null : "version",
        object.key === sourceKey ? "source" : "hls",
        object.size,
        object.etag,
      );
  const remove = vi.fn(async (key: string) => {
    stored.delete(key);
  });
  const env = {
    DB: db,
    MEDIA: {
      head: vi.fn(async (key: string) => stored.get(key) ?? null),
      list: vi.fn(async ({ prefix: requestedPrefix }: { prefix: string }) => ({
        objects: [...stored.values()].filter((o) =>
          o.key.startsWith(requestedPrefix),
        ),
        truncated: false,
      })),
      delete: remove,
    },
  } as unknown as Env;
  const version = () =>
    native
      .prepare("SELECT * FROM versions WHERE id='version'")
      .get() as unknown as Version;
  return {
    native,
    env,
    stored,
    remove,
    totalBytes,
    version,
    fail(sqlFragment: string) {
      failNext = (sql) => sql.includes(sqlFragment);
    },
  };
}
function request(data: unknown) {
  return new Request("https://storage-test.example/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
async function plan(env: Env, kind: string) {
  const response = await createDeletionPlan(
    request({ videoId: "video", kind, versionId: "version" }),
    env,
  );
  return ((await response.json()) as { plan: { id: string } }).plan;
}
function confirmation() {
  return request({ confirmation: "DELETE_LISTED_OBJECTS", unpublish: true });
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe("storage categories reflect immutable version outcomes", () => {
  async function list(env: Env, query = "") {
    return (await (
      await storageList(
        new Request(`https://storage-test.example/api/admin/storage${query}`),
        env,
      )
    ).json()) as {
      items: { key: string; category: string; bytes: number }[];
      total: number;
      summary: Record<string, number>;
    };
  }
  it.each(["failed", "cancelled", "timed_out", "needs_confirmation"])(
    "classifies present %s output consistently without reclassifying the source",
    async (state) => {
      const { native, env, totalBytes, version } = setup();
      native
        .prepare("UPDATE versions SET state=? WHERE id='version'")
        .run(state);
      const all = await list(env);
      const failed = await list(env, "?category=failed_output");
      expect(all.items.find((item) => item.key === sourceKey)?.category).toBe(
        "source",
      );
      expect(failed.total).toBe(3);
      expect(
        failed.items.every((item) => item.category === "failed_output"),
      ).toBe(true);
      expect(failed.items.reduce((bytes, item) => bytes + item.bytes, 0)).toBe(
        totalBytes - 4,
      );
      expect(all.summary).toEqual({
        source: 4,
        failed_output: totalBytes - 4,
        incomplete_uploads: 0,
      });
      expect(failed.summary).toEqual(all.summary);
      expect((await list(env, "?category=hls")).total).toBe(0);
      // Classification is read-only; failure does not grant a deletion or
      // rewrite the persisted object category or original version outcome.
      expect(version().state).toBe(state);
      expect(
        native
          .prepare("SELECT category FROM objects WHERE key=?")
          .get(missingSegment)?.category,
      ).toBe("hls");
      expect(env.MEDIA.head).not.toHaveBeenCalled();
      expect(env.MEDIA.delete).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["verified", true, "current_hls"],
    ["verified", false, "historical_hls"],
    ["processing", true, "hls"],
  ] as const)(
    "preserves %s/current=%s output as %s",
    async (state, current, category) => {
      const { native, env, totalBytes } = setup();
      native
        .prepare("UPDATE versions SET state=? WHERE id='version'")
        .run(state);
      if (!current)
        native.exec("UPDATE videos SET current_version_id=NULL,published=0");
      const filtered = await list(env, `?category=${category}`);
      expect(filtered.total).toBe(3);
      expect(filtered.items.every((item) => item.category === category)).toBe(
        true,
      );
      expect(filtered.summary).toEqual({
        source: 4,
        [category]: totalBytes - 4,
        incomplete_uploads: 0,
      });
      expect((await list(env, "?category=failed_output")).total).toBe(0);
    },
  );
  it("uses the same categories for mixed inventories, filters and byte totals", async () => {
    const { native, env, totalBytes } = setup();
    const terminal = ["failed", "cancelled", "timed_out", "needs_confirmation"];
    for (const [index, state] of [
      ...terminal,
      "verified",
      "processing",
    ].entries()) {
      const id = `extra-${state}`;
      native
        .prepare(
          "INSERT INTO versions(id,video_id,prefix,state,mode,quality,timeline_id,created_at) VALUES(?,'video',?,?,'probe-remux','source',?,1)",
        )
        .run(id, `videos/video/versions/${id}/`, state, `timeline-${id}`);
      native
        .prepare(
          "INSERT INTO objects(key,video_id,version_id,category,bytes,etag,state,updated_at) VALUES(?,'video',?,'hls',?,'synthetic-etag','present',1)",
        )
        .run(`videos/video/versions/${id}/segment-000001.ts`, id, index + 1);
    }
    // A successful source playback version owns a reference, not another copy
    // of the original. It must not contribute generated/failed output bytes.
    native.exec(
      "INSERT INTO versions(id,video_id,prefix,state,mode,quality,manifest,timeline_id,created_at) VALUES('source-version','video','videos/video/versions/source-version/','verified','source','source','source.mp4','source-timeline',1)",
    );
    const all = await list(env);
    expect(all.summary).toEqual({
      source: 4,
      current_hls: totalBytes - 4,
      failed_output: 10,
      historical_hls: 5,
      hls: 6,
      incomplete_uploads: 0,
    });
    for (const [category, bytes] of Object.entries(all.summary)) {
      if (category === "incomplete_uploads") continue;
      const filtered = await list(env, `?category=${category}`);
      expect(filtered.total).toBe(filtered.items.length);
      expect(filtered.items.every((item) => item.category === category)).toBe(
        true,
      );
      expect(filtered.items.reduce((sum, item) => sum + item.bytes, 0)).toBe(
        bytes,
      );
      expect(filtered.summary).toEqual(all.summary);
    }
    const searched = await list(
      env,
      "?category=failed_output&q=extra-cancelled",
    );
    expect(searched.total).toBe(1);
    expect(searched.items[0]).toMatchObject({
      category: "failed_output",
      bytes: 2,
    });
    expect(searched.summary).toEqual(all.summary);
  });
});

describe("independent HLS proof cannot shrink after storage loss", () => {
  it("accepts the intact original inventory for publishing and a source-deletion plan", async () => {
    const { env, version, stored, remove } = setup();
    await verifyVersionObjects(env, version());
    expect(
      (await publishVideo(request({ versionId: "version" }), env, "video"))
        .status,
    ).toBe(200);
    await plan(env, "source");
    expect(stored.has(sourceKey)).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });
  it("invalidates and unpublishes a reconciled missing segment, preserving the source even under an older plan", async () => {
    const { native, env, stored, remove, version } = setup();
    const sourcePlan = await plan(env, "source");
    stored.delete(missingSegment);
    expect(await (await reconcileStorage(env)).json()).toMatchObject({
      missing: 1,
    });
    expect(
      native
        .prepare("SELECT state FROM objects WHERE key=?")
        .get(missingSegment)?.state,
    ).toBe("missing");
    expect(version()).toMatchObject({
      state: "objects_missing",
      validation_json: null,
    });
    expect(
      native
        .prepare("SELECT published,status FROM videos WHERE id='video'")
        .get(),
    ).toMatchObject({ published: 0, status: "objects_missing" });
    await expect(
      publishVideo(request({ versionId: "version" }), env, "video"),
    ).rejects.toMatchObject({ code: "version_unverified" });
    await expect(plan(env, "source")).rejects.toMatchObject({
      code: "hls_required",
    });
    await expect(
      executeDeletion(confirmation(), env, sourcePlan.id),
    ).rejects.toMatchObject({ code: "hls_required" });
    expect(stored.has(sourceKey)).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });
  it.each(["missing", "deleted", "uploading", "failed"])(
    "rejects an independently recorded %s object even before reconciliation invalidates its version",
    async (state) => {
      const { native, env, stored, version, remove } = setup();
      native
        .prepare("UPDATE objects SET state=? WHERE key=?")
        .run(state, missingSegment);
      if (state === "missing" || state === "deleted")
        stored.delete(missingSegment);
      await expect(verifyVersionObjects(env, version())).rejects.toMatchObject({
        code: "hls_incomplete",
      });
      await expect(
        publishVideo(request({ versionId: "version" }), env, "video"),
      ).rejects.toMatchObject({ code: "hls_incomplete" });
      await expect(plan(env, "source")).rejects.toMatchObject({
        code: "hls_incomplete",
      });
      expect(stored.has(sourceKey)).toBe(true);
      expect(remove).not.toHaveBeenCalled();
    },
  );
  it("rejects removal of both the missing R2 object and its inventory row against the original validated count", async () => {
    const { native, env, stored, version } = setup();
    native.prepare("DELETE FROM objects WHERE key=?").run(missingSegment);
    stored.delete(missingSegment);
    await expect(verifyVersionObjects(env, version())).rejects.toMatchObject({
      code: "hls_incomplete",
    });
    await expect(plan(env, "source")).rejects.toMatchObject({
      code: "hls_incomplete",
    });
  });
  it("rejects shrinking indexed and actual bytes against the original validated total", async () => {
    const { native, env, stored, version } = setup();
    native
      .prepare("UPDATE objects SET bytes=1 WHERE key=?")
      .run(missingSegment);
    stored.get(missingSegment)!.size = 1;
    await expect(verifyVersionObjects(env, version())).rejects.toMatchObject({
      code: "hls_incomplete",
    });
  });
  it.each(["{}", "malformed JSON", '{"actualR2Objects":"3"}'])(
    "refuses a version without a valid original object-count proof: %s",
    async (validation) => {
      const { native, env, version } = setup();
      native
        .prepare("UPDATE versions SET validation_json=? WHERE id='version'")
        .run(validation);
      await expect(verifyVersionObjects(env, version())).rejects.toMatchObject({
        code: "hls_incomplete",
      });
    },
  );
  it("invalidates missing rows left by earlier reconciliation even if this page finds no new missing objects", async () => {
    const { native, env, stored, version } = setup();
    native
      .prepare("UPDATE objects SET state='missing' WHERE key=?")
      .run(missingSegment);
    stored.delete(missingSegment);
    expect(await (await reconcileStorage(env)).json()).toMatchObject({
      missing: 0,
    });
    expect(version()).toMatchObject({
      state: "objects_missing",
      validation_json: null,
    });
    expect(
      native.prepare("SELECT published FROM videos WHERE id='video'").get()
        ?.published,
    ).toBe(0);
  });
  it("rolls back all reconciliation changes on D1 failure while the independent inventory check still refuses missing media", async () => {
    const { native, env, stored, version, fail } = setup();
    stored.delete(missingSegment);
    fail("UPDATE versions SET state=CASE");
    await expect(reconcileStorage(env)).rejects.toThrow("Injected D1 failure");
    expect(
      native
        .prepare("SELECT state FROM objects WHERE key=?")
        .get(missingSegment)?.state,
    ).toBe("present");
    expect(version().state).toBe("verified");
    expect(
      native.prepare("SELECT published FROM videos WHERE id='video'").get()
        ?.published,
    ).toBe(1);
    await expect(verifyVersionObjects(env, version())).rejects.toMatchObject({
      code: "objects_changed",
    });
    await reconcileStorage(env);
    expect(version()).toMatchObject({
      state: "objects_missing",
      validation_json: null,
    });
  });
});

describe("deletion completion commits directory cleanup atomically", () => {
  it("keeps a failed R2 source removal partial and retries the same confirmed object without changing the HLS", async () => {
    const { native, env, stored, remove, version } = setup();
    const deletionPlan = await plan(env, "source");
    remove.mockRejectedValueOnce(new Error("Injected R2 deletion failure"));
    expect(
      await (
        await executeDeletion(confirmation(), env, deletionPlan.id)
      ).json(),
    ).toMatchObject({ state: "partial", releasedBytes: 0, remainingCount: 1 });
    expect(stored.has(sourceKey)).toBe(true);
    expect(
      native.prepare("SELECT source_key FROM videos WHERE id='video'").get()
        ?.source_key,
    ).toBe(sourceKey);
    expect(version().state).toBe("verified");
    expect(
      await (
        await executeDeletion(confirmation(), env, deletionPlan.id)
      ).json(),
    ).toMatchObject({ state: "complete", releasedBytes: 4 });
    expect(version().state).toBe("verified");
    expect(remove).toHaveBeenCalledTimes(2);
  });
  it("uses durable removal evidence after the per-object D1 update fails, counting the actual freed bytes once", async () => {
    const { env, stored, remove, fail } = setup();
    const evidence = new Map<string, unknown>();
    const receipts = {
      get: async (key: string) => evidence.get(key),
      put: async (key: string, value: unknown) => {
        evidence.set(key, value);
      },
      delete: async (key: string) => evidence.delete(key),
    } as unknown as DurableObjectStorage;
    const deletionPlan = await plan(env, "source");
    fail("UPDATE deletion_items SET state='deleted'");
    expect(
      await (
        await executeDeletion(confirmation(), env, deletionPlan.id, receipts)
      ).json(),
    ).toMatchObject({ state: "partial", releasedBytes: 0 });
    expect(stored.has(sourceKey)).toBe(false);
    expect(evidence.size).toBe(1);
    expect(
      await (
        await executeDeletion(confirmation(), env, deletionPlan.id, receipts)
      ).json(),
    ).toMatchObject({ state: "complete", releasedBytes: 4 });
    expect(evidence.size).toBe(0);
    expect(remove).toHaveBeenCalledOnce();
    expect(
      await (
        await executeDeletion(confirmation(), env, deletionPlan.id, receipts)
      ).json(),
    ).toMatchObject({ state: "complete", releasedBytes: 4 });
    expect(remove).toHaveBeenCalledOnce();
  });
  it.each(["source", "version", "video", "failed"])(
    "retries %s finalization after its final plan write fails, without deleting or releasing twice",
    async (kind) => {
      const { native, env, stored, remove, totalBytes, version, fail } =
        setup();
      if (kind === "failed")
        native.exec(
          "UPDATE videos SET current_version_id=NULL,published=0; UPDATE versions SET state='failed'",
        );
      const deletionPlan = await plan(env, kind);
      fail("state=?,failure_json=?");
      await expect(
        executeDeletion(confirmation(), env, deletionPlan.id),
      ).rejects.toThrow("Injected D1 failure");
      expect(
        native
          .prepare("SELECT state FROM deletion_plans WHERE id=?")
          .get(deletionPlan.id)?.state,
      ).toBe("running");
      expect(
        native.prepare("SELECT source_key FROM videos WHERE id='video'").get()
          ?.source_key,
      ).toBe(sourceKey);
      expect(version().state).toBe(kind === "source" ? "verified" : "deleting");
      const removedOnce = remove.mock.calls.length;
      const released =
        kind === "source" ? 4 : kind === "video" ? totalBytes : totalBytes - 4;
      const result = await (
        await executeDeletion(confirmation(), env, deletionPlan.id)
      ).json();
      expect(result).toMatchObject({
        state: "complete",
        releasedBytes: released,
      });
      expect(remove).toHaveBeenCalledTimes(removedOnce);
      expect(
        await (
          await executeDeletion(confirmation(), env, deletionPlan.id)
        ).json(),
      ).toMatchObject({ state: "complete", releasedBytes: released });
      expect(remove).toHaveBeenCalledTimes(removedOnce);
      expect(
        native
          .prepare(
            "SELECT SUM(released_bytes) AS n FROM deletion_items WHERE plan_id=?",
          )
          .get(deletionPlan.id)?.n,
      ).toBe(released);
      if (kind === "video") {
        expect(stored.size).toBe(0);
        expect(
          native
            .prepare(
              "SELECT source_key,current_version_id,published,status FROM videos WHERE id='video'",
            )
            .get(),
        ).toMatchObject({
          source_key: null,
          current_version_id: null,
          published: 0,
          status: "deleted",
        });
      } else if (kind === "source") {
        expect(stored.has(sourceKey)).toBe(false);
        expect(version().state).toBe("verified");
      } else {
        expect(stored.has(sourceKey)).toBe(true);
        expect(version().state).toBe("deleted");
        expect(
          native
            .prepare(
              "SELECT current_version_id,published FROM videos WHERE id='video'",
            )
            .get(),
        ).toMatchObject({ current_version_id: null, published: 0 });
      }
    },
  );
  it.each([
    "UPDATE videos SET source_key=NULL",
    "UPDATE videos SET published=0,current_version_id=NULL,status='deleted'",
    "UPDATE versions SET state='deleted' WHERE video_id=?",
  ])(
    "keeps a whole-video deletion recoverable when finalization fails at %s",
    async (sql) => {
      const { native, env, version, fail, totalBytes } = setup();
      const deletionPlan = await plan(env, "video");
      fail(sql);
      await expect(
        executeDeletion(confirmation(), env, deletionPlan.id),
      ).rejects.toThrow("Injected D1 failure");
      expect(
        native
          .prepare("SELECT state FROM deletion_plans WHERE id=?")
          .get(deletionPlan.id)?.state,
      ).toBe("running");
      expect(
        native
          .prepare(
            "SELECT source_key,current_version_id,status FROM videos WHERE id='video'",
          )
          .get(),
      ).toMatchObject({
        source_key: sourceKey,
        current_version_id: "version",
        status: "ready",
      });
      expect(version().state).toBe("deleting");
      expect(
        await (
          await executeDeletion(confirmation(), env, deletionPlan.id)
        ).json(),
      ).toMatchObject({ state: "complete", releasedBytes: totalBytes });
      expect(
        native
          .prepare(
            "SELECT source_key,current_version_id,status FROM videos WHERE id='video'",
          )
          .get(),
      ).toMatchObject({
        source_key: null,
        current_version_id: null,
        status: "deleted",
      });
    },
  );
});

describe("video-centred deletion confirmation and exact recovery", () => {
  function sourceReference(native: NativeDatabase, id = "direct") {
    native
      .prepare(
        "INSERT INTO versions(id,video_id,prefix,state,mode,quality,bytes,timeline_id,validation_json,created_at) VALUES(?,'video',?,'verified','source','source',4,'timeline','{}',1)",
      )
      .run(id, `videos/video/versions/${id}/`);
    native
      .prepare(
        "UPDATE videos SET current_version_id=?,published=1 WHERE id='video'",
      )
      .run(id);
  }
  function sourceOnly(f: ReturnType<typeof setup>) {
    f.native.exec(
      "DELETE FROM objects WHERE version_id='version'; DELETE FROM versions; UPDATE videos SET current_version_id=NULL,published=0",
    );
    for (const key of f.stored.keys())
      if (key !== sourceKey) f.stored.delete(key);
  }
  async function sourcePlan(env: Env, preservePlayback: boolean) {
    return (
      (await (
        await createDeletionPlan(
          request({
            kind: "source",
            videoId: "video",
            preservePlayback,
            removeDependencies: true,
          }),
          env,
        )
      ).json()) as {
        plan: {
          id: string;
          retainedVersionId: string | null;
          requiresUnpublish: boolean;
        };
      }
    ).plan;
  }
  it("deletes a complete source-only video without any HLS prerequisite and preserves unrelated files", async () => {
    const f = setup();
    sourceOnly(f);
    f.stored.set("videos/other/source/file", {
      key: "videos/other/source/file",
      size: 99,
      etag: "other",
    });
    const created = await plan(f.env, "video");
    expect(
      await (await executeDeletion(confirmation(), f.env, created.id)).json(),
    ).toMatchObject({ state: "complete", releasedBytes: 4 });
    expect(f.stored.has(sourceKey)).toBe(false);
    expect(f.stored.has("videos/other/source/file")).toBe(true);
    expect(
      f.native
        .prepare("SELECT status,source_key FROM videos WHERE id='video'")
        .get(),
    ).toMatchObject({ status: "deleted", source_key: null });
  });
  it("allows source deletion with explicitly removed direct-play dependencies and unpublishes before removal", async () => {
    const f = setup();
    sourceOnly(f);
    sourceReference(f.native);
    const created = await sourcePlan(f.env, false);
    expect(created.requiresUnpublish).toBe(true);
    await expect(
      executeDeletion(
        request({
          confirmation: "DELETE_LISTED_OBJECTS",
          removeDependencies: true,
        }),
        f.env,
        created.id,
      ),
    ).rejects.toMatchObject({ code: "unpublish_required" });
    await expect(
      executeDeletion(confirmation(), f.env, created.id),
    ).rejects.toMatchObject({ code: "source_referenced" });
    expect(f.remove).not.toHaveBeenCalled();
    expect(
      await (
        await executeDeletion(
          request({
            confirmation: "DELETE_LISTED_OBJECTS",
            removeDependencies: true,
            unpublish: true,
          }),
          f.env,
          created.id,
        )
      ).json(),
    ).toMatchObject({ state: "complete", releasedBytes: 4 });
    expect(
      f.native
        .prepare(
          "SELECT published,current_version_id,source_key FROM videos WHERE id='video'",
        )
        .get(),
    ).toMatchObject({
      published: 0,
      current_version_id: null,
      source_key: null,
    });
    expect(
      f.native.prepare("SELECT state FROM versions WHERE id='direct'").get()
        ?.state,
    ).toBe("deleted");
  });
  it("preserves playback with an independently validated MP4, including switching away from the source", async () => {
    const f = setup();
    sourceOnly(f);
    sourceReference(f.native);
    const content = sourceMp4Fixture({ tail: false });
    const key = "videos/video/versions/optimized/optimized.mp4";
    const digest = "a".repeat(64);
    const validation = {
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
      administratorAttestation: {
        basis: "administrator-browser-playback-and-seek",
        versionId: "optimized",
        confirmedAt: Date.now(),
        played: true,
        seeked: true,
        audioConfirmed: true,
        durationSeconds: 10,
        seekFromSeconds: 0,
        seekToSeconds: 5,
      },
      syncOffsetDifferenceSeconds: 0,
      syncEndOffsetDifferenceSeconds: 0,
      mp4Structure: {
        compatible: true,
        serverDecoded: false,
        validationBasis: "bounded-iso-bmff-metadata",
        audioCodec: "mp4a.40.2",
        index: { placement: "before-media" },
      },
      copiedStreams: ["video", "audio"].map((type) => ({
        type,
        packets: 1,
        outputPackets: 1,
        sha256: digest,
        outputSha256: digest,
      })),
    };
    f.native
      .prepare(
        "INSERT INTO versions(id,video_id,prefix,state,mode,quality,manifest,bytes,duration,timeline_id,validation_json,created_at) VALUES('optimized','video','videos/video/versions/optimized/','verified','faststart','source','optimized.mp4',?,10,'timeline',?,1)",
      )
      .run(content.length, JSON.stringify(validation));
    f.native
      .prepare(
        "INSERT INTO objects(key,video_id,version_id,category,bytes,etag,sha256,state,updated_at) VALUES(?,'video','optimized','mp4',?,'optimized',?,'present',1)",
      )
      .run(key, content.length, digest);
    f.stored.set(key, { key, size: content.length, etag: "optimized" });
    f.env.MEDIA.get = vi.fn(
      async (
        requested: string,
        options: { range: { offset: number; length: number } },
      ) => {
        const head = f.stored.get(requested);
        if (!head) return null;
        const { offset, length } = options.range;
        return {
          ...head,
          range: { offset, length },
          body: new Response(content.slice(offset, offset + length)).body,
        };
      },
    ) as unknown as R2Bucket["get"];
    const created = await sourcePlan(f.env, true);
    expect(created).toMatchObject({
      retainedVersionId: "optimized",
      requiresUnpublish: false,
    });
    expect(
      await (
        await executeDeletion(
          request({
            confirmation: "DELETE_LISTED_OBJECTS",
            removeDependencies: true,
          }),
          f.env,
          created.id,
        )
      ).json(),
    ).toMatchObject({ state: "complete", releasedBytes: 4 });
    expect(
      f.native
        .prepare(
          "SELECT published,current_version_id,publication_revision,source_key FROM videos WHERE id='video'",
        )
        .get(),
    ).toMatchObject({
      published: 1,
      current_version_id: "optimized",
      publication_revision: 1,
      source_key: null,
    });
    expect(f.stored.has(key)).toBe(true);
    expect(
      f.native.prepare("SELECT state FROM versions WHERE id='optimized'").get()
        ?.state,
    ).toBe("verified");
  });
  it("refuses new direct-play dependencies rather than expanding an earlier source confirmation", async () => {
    const f = setup();
    sourceOnly(f);
    const created = await sourcePlan(f.env, false);
    sourceReference(f.native, "later");
    await expect(
      executeDeletion(
        request({
          confirmation: "DELETE_LISTED_OBJECTS",
          removeDependencies: true,
          unpublish: true,
        }),
        f.env,
        created.id,
      ),
    ).rejects.toMatchObject({ code: "source_referenced" });
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("refuses new video versions rather than removing records outside the original confirmation", async () => {
    const f = setup();
    const created = await plan(f.env, "video");
    sourceReference(f.native, "later");
    await expect(
      executeDeletion(confirmation(), f.env, created.id),
    ).rejects.toMatchObject({ code: "metadata_changed" });
    expect(f.remove).not.toHaveBeenCalled();
    expect(
      f.native.prepare("SELECT state FROM versions WHERE id='later'").get()
        ?.state,
    ).toBe("verified");
  });
  it("continues a partially failed exact range without deleting newly appeared objects", async () => {
    const f = setup();
    const created = await plan(f.env, "video");
    f.remove.mockRejectedValueOnce(new Error("R2 unavailable"));
    expect(
      await (await executeDeletion(confirmation(), f.env, created.id)).json(),
    ).toMatchObject({ state: "partial" });
    const newKey = "videos/video/versions/version/new-segment.ts";
    f.stored.set(newKey, { key: newKey, size: 27, etag: "new" });
    const result = await (
      await executeDeletion(confirmation(), f.env, created.id)
    ).json();
    expect(result).toMatchObject({
      state: "partial",
      remainingCount: 0,
      failures: [
        { key: newKey, error: "unconfirmed_new_object_requires_new_plan" },
      ],
    });
    expect(f.stored.has(newKey)).toBe(true);
    expect(
      f.native.prepare("SELECT status FROM videos WHERE id='video'").get()
        ?.status,
    ).not.toBe("deleted");
  });
  it("hides an obsolete partial deletion after a separately confirmed replacement finishes the video", async () => {
    const f = setup();
    const original = await plan(f.env, "video");
    f.remove.mockRejectedValueOnce(new Error("R2 unavailable"));
    await executeDeletion(confirmation(), f.env, original.id);
    const newKey = "videos/video/versions/version/new-segment.ts";
    f.stored.set(newKey, { key: newKey, size: 27, etag: "new" });
    expect(
      await (await executeDeletion(confirmation(), f.env, original.id)).json(),
    ).toMatchObject({ state: "partial", remainingCount: 0 });
    const replacement = await plan(f.env, "video");
    expect(
      await (
        await executeDeletion(confirmation(), f.env, replacement.id)
      ).json(),
    ).toMatchObject({ state: "complete" });
    const listed = (await (
      await listDeletionPlans(
        new Request("https://storage-test.example/plans"),
        f.env,
      )
    ).json()) as { items: { id: string }[] };
    expect(listed.items.some((item) => item.id === original.id)).toBe(false);
    expect(
      await (await getDeletionPlan(f.env, original.id)).json(),
    ).toMatchObject({ plan: { noAction: true } });
  });
  it("blocks active uploads for source and version deletion, then rechecks before executing an older plan", async () => {
    const f = setup();
    const created = await plan(f.env, "version");
    f.native
      .prepare(
        "INSERT INTO uploads(id,video_id,object_key,fingerprint,expected_size,state,reserved_bytes,expires_at,created_at,updated_at) VALUES('pending-upload','video','videos/video/source/new','f',10,'uploading',10,9999999999999,1,1)",
      )
      .run();
    for (const kind of ["source", "version", "video"])
      await expect(plan(f.env, kind)).rejects.toMatchObject({
        code: "upload_active",
        message: expect.stringContaining("pending-upload"),
      });
    await expect(
      executeDeletion(confirmation(), f.env, created.id),
    ).rejects.toMatchObject({ code: "upload_active" });
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("cancels expired confirmation without deleting files and hides old empty no-op requests", async () => {
    const f = setup();
    const created = await plan(f.env, "video");
    f.native
      .prepare("UPDATE deletion_plans SET expires_at=1 WHERE id=?")
      .run(created.id);
    expect(
      await (await getDeletionPlan(f.env, created.id)).json(),
    ).toMatchObject({ plan: { expired: true } });
    await expect(
      executeDeletion(confirmation(), f.env, created.id),
    ).rejects.toMatchObject({ code: "plan_expired" });
    expect(
      await (await cancelDeletionPlan(f.env, created.id)).json(),
    ).toMatchObject({ state: "cancelled", filesDeleted: false });
    f.native
      .prepare(
        "INSERT INTO deletion_plans(id,video_id,kind,scope_json,fingerprint,state,expires_at,created_at,updated_at) VALUES('empty','video','failed','{}','unused','pending',1,1,1)",
      )
      .run();
    expect(await (await getDeletionPlan(f.env, "empty")).json()).toMatchObject({
      plan: { noAction: true },
    });
    expect(
      await (
        await listDeletionPlans(
          new Request("https://storage-test.example/plans"),
          f.env,
        )
      ).json(),
    ).toMatchObject({ items: [], total: 0 });
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("treats source playback as metadata only, removes the record, and never deletes its shared file", async () => {
    const f = setup();
    sourceOnly(f);
    sourceReference(f.native);
    const created = (
      (await (
        await createDeletionPlan(
          request({ kind: "version", videoId: "video", versionId: "direct" }),
          f.env,
        )
      ).json()) as {
        plan: {
          id: string;
          objects: unknown[];
          sourceReferenceOnly: boolean;
          totalBytes: number;
        };
      }
    ).plan;
    expect(created).toMatchObject({
      objects: [],
      sourceReferenceOnly: true,
      totalBytes: 0,
    });
    expect(
      await (await executeDeletion(confirmation(), f.env, created.id)).json(),
    ).toMatchObject({ state: "complete", releasedBytes: 0 });
    expect(f.stored.has(sourceKey)).toBe(true);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("clears a missing original only after confirmation and does not claim storage was freed", async () => {
    const f = setup();
    sourceOnly(f);
    f.stored.delete(sourceKey);
    const created = await sourcePlan(f.env, false);
    expect(
      f.native.prepare("SELECT source_key FROM videos WHERE id='video'").get()
        ?.source_key,
    ).toBe(sourceKey);
    expect(
      await (await executeDeletion(confirmation(), f.env, created.id)).json(),
    ).toMatchObject({ state: "complete", releasedBytes: 0 });
    expect(
      f.native.prepare("SELECT source_key FROM videos WHERE id='video'").get()
        ?.source_key,
    ).toBe(null);
    expect(
      f.native.prepare("SELECT state FROM objects WHERE key=?").get(sourceKey)
        ?.state,
    ).toBe("deleted");
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("synchronizes missing generated files without claiming their historical bytes were newly freed", async () => {
    const f = setup();
    for (const key of f.stored.keys())
      if (key !== sourceKey) f.stored.delete(key);
    const created = (
      (await (
        await createDeletionPlan(
          request({ kind: "version", videoId: "video", versionId: "version" }),
          f.env,
        )
      ).json()) as {
        plan: {
          id: string;
          totalBytes: number;
          objects: { missing: boolean }[];
        };
      }
    ).plan;
    expect(created.totalBytes).toBe(0);
    expect(created.objects.every((object) => object.missing)).toBe(true);
    expect(
      await (await executeDeletion(confirmation(), f.env, created.id)).json(),
    ).toMatchObject({ state: "complete", releasedBytes: 0 });
    expect(
      f.native
        .prepare(
          "SELECT COUNT(*) AS n FROM objects WHERE version_id='version' AND state!='deleted'",
        )
        .get()?.n,
    ).toBe(0);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.stored.has(sourceKey)).toBe(true);
  });
  it("requires a new confirmation if a previously missing file reappears, even with the same original identity", async () => {
    const f = setup();
    const source = f.stored.get(sourceKey)!;
    f.stored.delete(sourceKey);
    const created = await sourcePlan(f.env, false);
    f.stored.set(sourceKey, source);
    await expect(
      executeDeletion(confirmation(), f.env, created.id),
    ).rejects.toMatchObject({ code: "objects_changed" });
    expect(f.stored.has(sourceKey)).toBe(true);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("groups physical storage by video and generated version rather than returning HLS segments as the main list", async () => {
    const f = setup();
    sourceReference(f.native);
    const listed = await (
      await storageList(
        new Request("https://storage-test.example/storage?view=videos"),
        f.env,
      )
    ).json();
    expect(listed).toMatchObject({
      total: 1,
      items: [
        {
          id: "video",
          title: "Video",
          sourceBytes: 4,
          generatedBytes: f.totalBytes - 4,
          versions: expect.arrayContaining([
            {
              id: "direct",
              videoId: "video",
              mode: "source",
              state: "verified",
              quality: "source",
              createdAt: 1,
              bytes: 0,
              fileCount: 0,
              current: true,
              usesSource: true,
            },
          ]),
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain("segment-000001.ts");
  });
});
