import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));
import worker from "../src/index";
import { login } from "../src/auth";
import { cancelUpload } from "../src/uploads";
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
type Listed = {
  id: string;
  name: string;
  title: string;
  uploadedBytes: number;
  state: string;
  parts: { number: number; size: number }[];
};
type Page = {
  items: Listed[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  nextPage: number | null;
  status: string;
};
const origin = "https://uploads-test.example";

async function setup(unfinishedCount: number, completedCount = 0) {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  native.exec(
    readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  const queriedPartIds: string[] = [];
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
          if (sql.startsWith("SELECT number,size,etag,sha256 FROM upload_parts"))
            queriedPartIds.push(String(values[0]));
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
  function add(index: number, state: string) {
    const id = `${state}-${String(index).padStart(4, "0")}`;
    const videoId = `video-${id}`;
    native
      .prepare(
        "INSERT INTO videos(id,title,source_size,source_revision,source_name,status,created_at,updated_at) VALUES(?,?,16,?,?,'uploading',1,1)",
      )
      .run(videoId, `Title ${id}`, `revision-${id}`, `original-${id}.mp4`);
    native
      .prepare(
        "INSERT INTO uploads(id,video_id,object_key,multipart_id,fingerprint,expected_size,state,reserved_bytes,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,16,?,16,9999999999999,?,1)",
      )
      .run(
        id,
        videoId,
        `videos/${videoId}/source/revision-${id}`,
        `multipart-${id}`,
        `fingerprint-${id}`,
        state,
        state === "complete" ? 1000 + index : 1,
      );
    native
      .prepare("INSERT INTO upload_parts VALUES(?,1,8,'part-etag',?)")
      .run(id, "a".repeat(64));
  }
  for (let i = 0; i < unfinishedCount; i++) add(i, "uploading");
  for (let i = 0; i < completedCount; i++) add(i, "complete");
  const abort = vi.fn(async () => {});
  const head = vi.fn(async () => null);
  const start = vi.fn();
  const env = {
    DB: db,
    APP_ENV: "test",
    ADMIN_PASSWORD: "test-only-upload-list-password",
    SESSION_SECRET:
      "test-only-upload-list-session-secret-at-least-32-characters",
    MEDIA: { head, resumeMultipartUpload: () => ({ abort }) },
    PROCESSOR: { get: start },
    COORDINATOR: {
      idFromName: () => "admission",
      get: () => ({
        fetch: async (input: Request | string) => {
          const url = new URL(typeof input === "string" ? input : input.url);
          const match = /^\/uploads\/([^/]+)\/cancel$/.exec(url.pathname);
          return match
            ? cancelUpload(env, match[1])
            : Response.json({ allowed: true });
        },
      }),
    },
  } as unknown as Env;
  const auth = await login(
    new Request(`${origin}/api/admin/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    }),
    env,
  );
  const cookie = auth.headers.get("Set-Cookie")!.split(";")[0];
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
  const get = (query = "", authenticated = true) =>
    worker.fetch(
      new Request(`${origin}/api/admin/uploads${query}`, {
        headers: authenticated ? { Cookie: cookie } : {},
      }),
      env,
      ctx,
    );
  return { native, env, get, cookie, ctx, queriedPartIds, abort, head, start };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe("authenticated, bounded unfinished-upload discovery", () => {
  it("keeps an older unfinished upload visible behind more than 200 newer completed uploads", async () => {
    const { get, queriedPartIds, head, start } = await setup(1, 250);
    const response = await get();
    expect(response.status).toBe(200);
    const result = (await response.json()) as Page;
    expect(result).toMatchObject({
      page: 1,
      pageSize: 50,
      total: 1,
      hasMore: false,
      nextPage: null,
      status: "unfinished",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "uploading-0000",
      name: "original-uploading-0000.mp4",
      title: "Title uploading-0000",
      uploadedBytes: 8,
      state: "uploading",
      parts: [{ number: 1, size: 8 }],
    });
    expect(queriedPartIds).toEqual(["uploading-0000"]);
    expect(head).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it("reaches every unfinished task across all pages and cancels an oldest task with its ID alone", async () => {
    const { get, env, cookie, ctx, abort, start } = await setup(205, 250);
    const seen = new Set<string>();
    let oldest = "";
    for (let page = 1; page <= 5; page++) {
      const response = await get(`?page=${page}`);
      const result = (await response.json()) as Page;
      expect(result.total).toBe(205);
      expect(result.page).toBe(page);
      expect(result.items.length).toBe(page < 5 ? 50 : 5);
      expect(result.hasMore).toBe(page < 5);
      expect(result.nextPage).toBe(page < 5 ? page + 1 : null);
      for (const item of result.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      oldest = result.items.at(-1)!.id;
    }
    expect(seen.size).toBe(205);
    expect(oldest).toBe("uploading-0000");
    const cancelled = await worker.fetch(
      new Request(`${origin}/api/admin/uploads/${oldest}/cancel`, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      env,
      ctx,
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      cancelled: true,
      abortVerified: true,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    const after = (await (await get("?page=5")).json()) as Page;
    expect(after.total).toBe(204);
    expect(after.items.some((item) => item.id === oldest)).toBe(false);
  });
  it("does not load completed parts even when the completed list is explicitly requested", async () => {
    const { get, queriedPartIds } = await setup(1, 250);
    const result = (await (await get("?status=complete")).json()) as Page;
    expect(result.total).toBe(250);
    expect(result.items).toHaveLength(50);
    expect(
      result.items.every(
        (item) =>
          item.state === "complete" &&
          item.parts.length === 0 &&
          item.uploadedBytes === 8,
      ),
    ).toBe(true);
    expect(queriedPartIds).toEqual([]);
  });
  it.each([
    ["-1", 1],
    ["2.9", 2],
    ["not-a-number", 1],
    ["Infinity", 5],
    ["1000000000", 5],
  ])("bounds page=%s to the available page %s", async (query, expected) => {
    const { get } = await setup(205);
    const result = (await (await get(`?page=${query}`)).json()) as Page;
    expect(result.page).toBe(expected);
    expect(result.pageSize).toBe(50);
    expect(result.items.length).toBeLessThanOrEqual(50);
  });
  it("returns a bounded empty page and refuses unrecognized state filters or missing sessions", async () => {
    const { get } = await setup(0);
    const empty = (await (await get("?page=99999")).json()) as Page;
    expect(empty).toMatchObject({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
      hasMore: false,
      nextPage: null,
    });
    const invalid = await get("?status=not-allowed");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "invalid_upload_status" },
    });
    expect((await get("", false)).status).toBe(401);
  });
});
