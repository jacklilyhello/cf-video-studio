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
import { TaskBridge } from "../src/processor";
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
const prefix = "videos/video/versions/next/";
const manifest = new TextEncoder().encode(
  "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment-000000.ts\n#EXT-X-ENDLIST\n",
);
// Synthetic bytes test the bridge's object-state transition, not media decoding.
const segment = new Uint8Array([0x47, 0x10, 0x20, 0x30]);
const outputs = [
  { name: "index.m3u8", bytes: manifest },
  { name: "segment-000000.ts", bytes: segment },
];
const hex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
type StoredObject = {
  key: string;
  bytes: Uint8Array;
  size: number;
  etag: string;
  checksums: { sha256: ArrayBuffer };
};

async function setup() {
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
          return { success: true, results: prepared.all(...values) };
        },
        async run() {
          const result = prepared.run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
  };
  const stored = new Map<string, StoredObject>();
  async function object(key: string, bytes: Uint8Array) {
    const checksum = await crypto.subtle.digest(
      "SHA-256",
      new Uint8Array(bytes).buffer,
    );
    return {
      key,
      bytes: bytes.slice(),
      size: bytes.length,
      etag: hex(checksum),
      checksums: { sha256: checksum },
    };
  }
  const protectedObjects = [
    await object("videos/video/source/revision", new Uint8Array([1, 2, 3])),
    await object("videos/video/versions/old/index.m3u8", manifest),
    await object("videos/video/versions/old/segment-000000.ts", segment),
  ];
  for (const entry of protectedObjects) stored.set(entry.key, entry);
  const source = protectedObjects[0];
  native
    .prepare(
      "INSERT INTO videos(id,title,source_key,source_size,source_etag,source_revision,source_name,status,published,current_version_id,created_at,updated_at) VALUES('video','Fixture',?,?,?,'revision','fixture.mp4','ready',1,'old',1,1)",
    )
    .run(source.key, source.size, source.etag);
  native.exec(
    "INSERT INTO versions(id,video_id,prefix,state,mode,quality,timeline_id,created_at) VALUES('old','video','videos/video/versions/old/','verified','probe-remux','source','old-timeline',1)",
  );
  native.exec(
    "INSERT INTO versions(id,video_id,task_id,prefix,state,mode,quality,timeline_id,created_at) VALUES('next','video','task','videos/video/versions/next/','processing','probe-remux','source','next-timeline',1)",
  );
  native
    .prepare(
      "INSERT INTO quotes(id,video_id,source_revision,source_etag,mode,quality,snapshot_id,period_start,expires_at,state,data_json,created_at) VALUES('quote','video','revision',?,'probe-remux','source','snapshot','2026-10-01',?,'confirmed',?,1)",
    )
    .run(
      source.etag,
      Date.now() + 60000,
      JSON.stringify({ maxOutputBytes: 8192, maxMediaObjects: 4 }),
    );
  native
    .prepare(
      "INSERT INTO jobs(id,video_id,version_id,quote_id,state,stage,deadline_at,created_at,updated_at) VALUES('task','video','next','quote','running','uploading',?,1,1)",
    )
    .run(Date.now() + 60000);
  for (const entry of protectedObjects)
    native
      .prepare(
        "INSERT INTO objects(key,video_id,version_id,category,bytes,etag,sha256,state,updated_at) VALUES(?,'video',?,?,?,?,?,'present',1)",
      )
      .run(
        entry.key,
        entry.key === source.key ? null : "old",
        entry.key === source.key ? "source" : "hls",
        entry.size,
        entry.etag,
        hex(entry.checksums.sha256),
      );
  const protectedRows = native
    .prepare(
      "SELECT * FROM objects WHERE version_id='old' OR category='source' ORDER BY key",
    )
    .all();
  const oldVersion = native
    .prepare("SELECT * FROM versions WHERE id='old'")
    .get();
  const fail = new Set<string>();
  const put = vi.fn(
    async (key: string, body: ReadableStream, options: { sha256: string }) => {
      if (fail.has(key)) throw new Error("Simulated R2 write failure");
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const entry = await object(key, bytes);
      if (hex(entry.checksums.sha256) !== options.sha256)
        throw new Error("Checksum mismatch");
      if (stored.has(key)) return null;
      stored.set(key, entry);
      return entry;
    },
  );
  const finish = vi.fn(async (_input: string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual({
      jobId: "task",
      state: "succeeded",
    });
    return Response.json({ stopping: true }, { status: 202 });
  });
  const env = {
    DB: db,
    MEDIA: {
      head: async (key: string) => stored.get(key) ?? null,
      put,
      get: async (key: string) => {
        const entry = stored.get(key);
        return entry
          ? {
              ...entry,
              text: async () => new TextDecoder().decode(entry.bytes),
            }
          : null;
      },
      list: async ({ prefix: scope }: { prefix: string }) => ({
        objects: [...stored.values()].filter((entry) =>
          entry.key.startsWith(scope),
        ),
        truncated: false,
      }),
    },
    PROCESSOR: { idFromName: () => "task", get: () => ({ fetch: finish }) },
  } as unknown as Env;
  const bridge = new TaskBridge(
    { props: { taskId: "task" } } as unknown as ExecutionContext,
    env,
  );
  async function upload(name: string, bytes: Uint8Array) {
    return bridge.fetch(
      new Request(`https://task.internal/output/${name}`, {
        method: "PUT",
        headers: {
          "Content-Length": String(bytes.length),
          "X-Content-SHA256": hex(
            await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
          ),
        },
        body: new Uint8Array(bytes).buffer,
      }),
    );
  }
  async function complete() {
    const objects = await Promise.all(
      outputs.map(async (entry) => ({
        name: entry.name,
        size: entry.bytes.length,
        sha256: hex(await crypto.subtle.digest("SHA-256", entry.bytes)),
      })),
    );
    return bridge.fetch(
      new Request("https://task.internal/complete", {
        method: "POST",
        body: JSON.stringify({
          manifest: "index.m3u8",
          objects,
          durationSeconds: 6,
          validation: {
            allSegmentsDecoded: true,
            playlistDecoded: true,
            keyframeStarts: true,
            codecAndResolutionVerified: true,
          },
        }),
      }),
    );
  }
  function expectProtected() {
    expect(
      native.prepare("SELECT * FROM versions WHERE id='old'").get(),
    ).toEqual(oldVersion);
    expect(
      native
        .prepare(
          "SELECT * FROM objects WHERE version_id='old' OR category='source' ORDER BY key",
        )
        .all(),
    ).toEqual(protectedRows);
    expect(
      native
        .prepare(
          "SELECT published,current_version_id,source_key FROM videos WHERE id='video'",
        )
        .get(),
    ).toEqual({
      published: 1,
      current_version_id: "old",
      source_key: source.key,
    });
    for (const entry of protectedObjects) {
      expect(stored.get(entry.key)?.bytes).toEqual(entry.bytes);
      expect(stored.get(entry.key)?.etag).toBe(entry.etag);
    }
  }
  return {
    native,
    stored,
    fail,
    put,
    finish,
    upload,
    complete,
    expectProtected,
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

describe("HLS bridge upload state in actual SQLite", () => {
  it("completes after each first PUT without requiring a replay", async () => {
    const fixture = await setup();
    for (const entry of outputs) {
      const response = await fixture.upload(entry.name, entry.bytes);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        stored: true,
        duplicate: false,
        name: entry.name,
        bytes: entry.bytes.length,
        sha256: hex(await crypto.subtle.digest("SHA-256", entry.bytes)),
      });
    }
    expect(fixture.put).toHaveBeenCalledTimes(2);
    expect(
      fixture.native
        .prepare("SELECT state FROM objects WHERE version_id='next'")
        .all(),
    ).toEqual([{ state: "present" }, { state: "present" }]);
    const completed = await fixture.complete();
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({
      validated: true,
      publication: "administrator_required",
    });
    expect(fixture.finish).toHaveBeenCalledOnce();
    fixture.expectProtected();
  });

  it("keeps a failed PUT uploading and rejects completion until a real successful retry", async () => {
    const fixture = await setup();
    expect(
      (await fixture.upload(outputs[0].name, outputs[0].bytes)).status,
    ).toBe(200);
    fixture.fail.add(prefix + outputs[1].name);
    expect(
      (await fixture.upload(outputs[1].name, outputs[1].bytes)).status,
    ).toBe(500);
    expect(
      fixture.native
        .prepare("SELECT state FROM objects WHERE key=?")
        .get(prefix + outputs[1].name)?.state,
    ).toBe("uploading");
    expect(fixture.stored.has(prefix + outputs[1].name)).toBe(false);
    const rejected = await fixture.complete();
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "inventory_invalid" });
    expect(fixture.finish).not.toHaveBeenCalled();
    fixture.expectProtected();
    fixture.fail.clear();
    expect(
      (await fixture.upload(outputs[1].name, outputs[1].bytes)).status,
    ).toBe(200);
    expect((await fixture.complete()).status).toBe(200);
    expect(fixture.finish).toHaveBeenCalledOnce();
    fixture.expectProtected();
  });

  it("replays verified objects idempotently, rejects changed contents, and preserves the published source/version", async () => {
    const fixture = await setup();
    for (const entry of outputs) {
      expect((await fixture.upload(entry.name, entry.bytes)).status).toBe(200);
      const replay = await fixture.upload(entry.name, entry.bytes);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({
        stored: true,
        duplicate: true,
        name: entry.name,
        bytes: entry.bytes.length,
        sha256: hex(await crypto.subtle.digest("SHA-256", entry.bytes)),
      });
    }
    const original = fixture.stored.get(prefix + outputs[1].name)!;
    const conflict = await fixture.upload(
      outputs[1].name,
      new Uint8Array([9, 8, 7, 6]),
    );
    expect(conflict.status).toBe(409);
    expect(fixture.stored.get(original.key)).toEqual(original);
    expect(fixture.put).toHaveBeenCalledTimes(2);
    expect((await fixture.complete()).status).toBe(200);
    fixture.expectProtected();
  });
});
