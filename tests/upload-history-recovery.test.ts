import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/billing")>()),
  requireStorageBudget: vi.fn(),
}));
vi.mock("../src/logs", () => ({ log: vi.fn(async () => {}) }));
import { requireStorageBudget } from "../src/billing";
import { completeUpload, createUpload } from "../src/uploads";
import {
  api,
  HISTORY_TIMEOUT_MS,
  historyForTimeline,
  saveWatchProgress,
  type History,
} from "../web/client";
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
  native.exec(
    readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  native.exec(
    readFileSync(
      new URL("../migrations/0004_upload_approvals.sql", import.meta.url),
      "utf8",
    ),
  );

  native.exec(
    readFileSync(
      new URL("../migrations/0007_upload_manual_evidence.sql", import.meta.url),
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
  const sourceKey = "videos/video/source/revision";
  native
    .prepare(
      "INSERT INTO videos(id,title,source_key,source_size,source_etag,source_revision,source_name,status,published,current_version_id,created_at,updated_at) VALUES('video','Keep this title',?,4,'source-etag','revision','sample.mp4','ready',1,'old-version',1,1)",
    )
    .run(sourceKey);
  native.exec(
    "INSERT INTO versions(id,video_id,prefix,state,mode,quality,manifest,bytes,duration,timeline_id,validation_json,created_at) VALUES('old-version','video','videos/video/versions/old-version/','verified','probe-remux','source','index.m3u8',10,60,'old-timeline','{}',1)",
  );
  native
    .prepare(
      "INSERT INTO objects(key,video_id,category,bytes,etag,state,updated_at) VALUES(?,'video','source',4,'source-etag','present',1)",
    )
    .run(sourceKey);
  native
    .prepare(
      "INSERT INTO uploads(id,video_id,object_key,multipart_id,fingerprint,expected_size,state,reserved_bytes,expires_at,created_at,updated_at) VALUES('old-upload','video',?,'old-multipart',?,4,'complete',0,9999999999999,1,1)",
    )
    .run(sourceKey, "a".repeat(64));
  native.exec(
    "INSERT INTO upload_parts VALUES('old-upload',1,4,'part-etag','chunk-sha')",
  );
  const source = {
    key: sourceKey,
    size: 4,
    etag: "source-etag",
    customMetadata: {
      upload_id: "old-upload",
      video_id: "video",
      source_revision: "revision",
    },
  };
  const head = vi.fn(async (_key: string): Promise<unknown> => source);
  const createMultipartUpload = vi.fn(async () => ({
    uploadId: "new-multipart",
  }));
  const remove = vi.fn();
  const resume = vi.fn();
  const env = {
    DB: db,
    MEDIA: {
      head,
      createMultipartUpload,
      delete: remove,
      resumeMultipartUpload: resume,
    },
  } as unknown as Env;
  vi.mocked(requireStorageBudget).mockResolvedValue({
    id: "snapshot",
    periodStart: "2026-10-01",
    project: { storedBytes: 0, reservedBytes: 0, actualBytes: 0 },
    policy: { storageLimitBytes: 10 * 1024 ** 3, monthlySpendLimitUsd: 0 },
  } as Awaited<ReturnType<typeof requireStorageBudget>>);
  return {
    env,
    native,
    head,
    source,
    sourceKey,
    createMultipartUpload,
    remove,
    resume,
  };
}
function request() {
  return new Request("https://one.example/api/admin/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "sample.mp4",
      title: "New upload",
      size: 4,
      fingerprint: "a".repeat(64),
    }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("completed source reuse uses actual objects and preserves successful versions", () => {
  it("reuses a verified current source without new budget or writes to its published video", async () => {
    const { env, native, createMultipartUpload } = setup();
    const created = await createUpload(request(), env);
    expect(
      ((await created.json()) as { upload: { id: string } }).upload.id,
    ).toBe("old-upload");
    expect((await completeUpload(env, "old-upload")).status).toBe(200);
    expect(requireStorageBudget).not.toHaveBeenCalled();
    expect(createMultipartUpload).not.toHaveBeenCalled();
    expect(
      native
        .prepare(
          "SELECT title,status,published,current_version_id,updated_at FROM videos WHERE id='video'",
        )
        .get(),
    ).toMatchObject({
      title: "Keep this title",
      status: "ready",
      published: 1,
      current_version_id: "old-version",
      updated_at: 1,
    });
  });
  it.each([
    "missing-head",
    "deleted-video",
    "removed-source-index",
    "wrong-size",
    "wrong-etag",
    "wrong-metadata",
    "wrong-revision",
  ])(
    "creates a new unique source and new reservation for %s without altering old HLS",
    async (reason) => {
      const {
        env,
        native,
        head,
        source,
        sourceKey,
        createMultipartUpload,
        remove,
        resume,
      } = setup();
      if (reason === "missing-head") head.mockResolvedValue(null);
      if (reason === "deleted-video")
        native.exec(
          "UPDATE videos SET status='deleted',source_key=NULL,source_etag=NULL,source_size=0 WHERE id='video'",
        );
      if (reason === "removed-source-index")
        native.exec(
          "UPDATE objects SET state='deleted' WHERE category='source'",
        );
      if (reason === "wrong-size")
        head.mockResolvedValue({ ...source, size: 5 });
      if (reason === "wrong-revision")
        head.mockResolvedValue({
          ...source,
          customMetadata: {
            ...source.customMetadata,
            source_revision: "another-revision",
          },
        });
      if (reason === "wrong-etag")
        head.mockResolvedValue({ ...source, etag: "changed-etag" });
      if (reason === "wrong-metadata")
        head.mockResolvedValue({
          ...source,
          customMetadata: {
            ...source.customMetadata,
            video_id: "another-video",
          },
        });
      const response = await createUpload(request(), env);
      const result = (await response.json()) as {
        upload: { id: string; object_key: string; video_id: string };
      };
      expect(result.upload.id).not.toBe("old-upload");
      expect(result.upload.object_key).not.toBe(sourceKey);
      expect(result.upload.video_id).not.toBe("video");
      expect(requireStorageBudget).toHaveBeenCalledOnce();
      expect(createMultipartUpload).toHaveBeenCalledOnce();
      expect(remove).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(
        native
          .prepare(
            "SELECT state,prefix,validation_json FROM versions WHERE id='old-version'",
          )
          .get(),
      ).toMatchObject({
        state: "verified",
        prefix: "videos/video/versions/old-version/",
        validation_json: "{}",
      });
      expect(
        native.prepare("SELECT COUNT(*) AS n FROM reservations").get()?.n,
      ).toBe(1);
      const repeated = await createUpload(request(), env);
      expect(
        ((await repeated.json()) as { upload: { id: string } }).upload.id,
      ).toBe(result.upload.id);
      expect(requireStorageBudget).toHaveBeenCalledOnce();
      expect(createMultipartUpload).toHaveBeenCalledOnce();
    },
  );
  it("does not resurrect a deleted video on completed-upload replay", async () => {
    const { env, native, remove, resume } = setup();
    native.exec(
      "UPDATE videos SET status='deleted',source_key=NULL,source_etag=NULL,source_size=0 WHERE id='video'",
    );
    await expect(completeUpload(env, "old-upload")).rejects.toMatchObject({
      code: "completed_source_changed",
      status: 409,
    });
    expect(
      native
        .prepare("SELECT status,source_key FROM videos WHERE id='video'")
        .get(),
    ).toMatchObject({ status: "deleted", source_key: null });
    expect(remove).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
  it("keeps failed verification or unavailable new budget from creating another source", async () => {
    const { env, head, native, createMultipartUpload } = setup();
    head.mockRejectedValueOnce(new Error("R2 unavailable"));
    await expect(createUpload(request(), env)).rejects.toThrow(
      "R2 unavailable",
    );
    expect(requireStorageBudget).not.toHaveBeenCalled();
    head.mockResolvedValue(null);
    vi.mocked(requireStorageBudget).mockRejectedValueOnce(
      new Error("budget unavailable"),
    );
    await expect(createUpload(request(), env)).rejects.toThrow(
      "budget unavailable",
    );
    expect(createMultipartUpload).not.toHaveBeenCalled();
    expect(native.prepare("SELECT COUNT(*) AS n FROM uploads").get()?.n).toBe(
      1,
    );
  });
});

describe("history is optional for playback and remains bound to its timeline", () => {
  it("bounds a stalled history request and preserves the timeout error for retry feedback", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_path: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const outcome = api("/api/history", {}, HISTORY_TIMEOUT_MS).catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(HISTORY_TIMEOUT_MS - 1);
    expect((fetcher.mock.calls[0][1].signal as AbortSignal).aborted).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ code: "request_timeout" });
  });
  it("also bounds a history response whose headers arrive but JSON body stalls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_path: string, options: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"items":'));
                options.signal?.addEventListener(
                  "abort",
                  () =>
                    controller.error(new DOMException("Aborted", "AbortError")),
                  { once: true },
                );
              },
            }),
          ),
      ),
    );
    const outcome = api("/api/history", {}, HISTORY_TIMEOUT_MS).catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(HISTORY_TIMEOUT_MS);
    expect(await outcome).toMatchObject({ code: "request_timeout" });
  });
  it("propagates caller cancellation without leaving a timeout behind", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, options: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            options.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            ),
          ),
      ),
    );
    const controller = new AbortController();
    const outcome = api(
      "/api/history",
      { signal: controller.signal },
      HISTORY_TIMEOUT_MS,
    ).catch((error) => error);
    controller.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("flushes the captured media element with keepalive after the live ref is detached", async () => {
    const fetcher = vi.fn(async (_path: unknown, _options: RequestInit) =>
      Response.json({ saved: true }),
    );
    vi.stubGlobal("fetch", fetcher);
    const captured = { currentTime: 73, duration: 100 };
    const liveRef: { current: typeof captured | null } = { current: captured };
    liveRef.current = null;
    await saveWatchProgress(
      captured,
      {
        videoId: "video",
        timelineId: "original-timeline",
        writeContext: "c".repeat(64),
      },
      7,
      true,
    );
    const options = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(options).toMatchObject({
      credentials: "same-origin",
      keepalive: true,
      method: "POST",
    });
    expect(JSON.parse(options.body as string)).toMatchObject({
      videoId: "video",
      timelineId: "original-timeline",
      position: 73,
      duration: 100,
      playedSeconds: 7,
      writeContext: "c".repeat(64),
    });
    expect(liveRef.current).toBeNull();
  });
  it("drops old-timeline watched state while preserving same-timeline title edits and position", () => {
    const old: History = {
      videoId: "video",
      title: "Updated title",
      position: 73,
      duration: 100,
      watched: true,
      timelineId: "old",
      updatedAt: 1,
    };
    expect(historyForTimeline(old, "new")).toBeUndefined();
    expect(historyForTimeline(old, "old")).toBe(old);
    expect(historyForTimeline(old, "old")?.position).toBe(73);
  });
});
