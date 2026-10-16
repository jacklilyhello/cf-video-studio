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
import { INSTANCES, processingResourceAmounts } from "../src/billing";
import type { Env } from "../src/types";
const { DatabaseSync } = await import("node:sqlite" as string);
const { readFileSync, readdirSync } = await import("node:fs" as string);
const databases: { close(): void }[] = [];
afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const bounds = (objects: number, seconds = 180) => ({
  mode: "probe-remux" as const,
  maxOutputBytes: 1024 * 1024,
  maxMediaObjects: objects,
  totalTimeoutSeconds: seconds,
});

describe("processing D1 scan and retry allowances", () => {
  it("covers real TaskBridge aggregate scans and indexed writes across initial PUTs and duplicate acknowledgement retries", async () => {
    const at = Date.parse("2026-10-15T12:00:00Z"),
      objects = 128;
    vi.spyOn(Date, "now").mockReturnValue(at);
    const native = new DatabaseSync(":memory:");
    databases.push(native);
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory)
      .filter((name: string) => name.endsWith(".sql"))
      .sort())
      native.exec(readFileSync(new URL(name, directory), "utf8"));
    const resourceAmounts = processingResourceAmounts(
      INSTANCES[0],
      bounds(objects),
    );
    const plan = {
      ...bounds(objects),
      instance: INSTANCES[0],
      resourceAmounts,
    };
    native
      .prepare(
        "INSERT INTO videos(id,title,source_revision,source_name,created_at,updated_at) VALUES('video','Offline D1 fixture','revision','fixture.mp4',?,?)",
      )
      .run(at, at);
    native
      .prepare(
        "INSERT INTO quotes(id,video_id,source_revision,source_etag,mode,quality,period_start,expires_at,state,data_json,created_at) VALUES('quote','video','revision','fixture-etag','probe-remux','source','2026-10-13T00:00:00Z',?,'confirmed',?,?)",
      )
      .run(at + 60000, JSON.stringify(plan), at);
    native
      .prepare(
        "INSERT INTO versions(id,video_id,task_id,prefix,state,mode,quality,timeline_id,created_at) VALUES('version','video','task','videos/video/versions/version/','processing','probe-remux','source','timeline',?)",
      )
      .run(at);
    native
      .prepare(
        "INSERT INTO jobs(id,video_id,version_id,quote_id,state,stage,deadline_at,created_at,updated_at) VALUES('task','video','version','quote','running','uploading',?,?,?)",
      )
      .run(at + 180000, at, at);
    const populations: number[] = [],
      queryPlans: string[][] = [];
    let objectTableChanges = 0;
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
            if (
              sql.includes("SELECT SUM(bytes)") &&
              sql.includes("SELECT COUNT(*)")
            ) {
              // Observe the real table population for the two aggregate scans.
              // This is a logical scan floor, not Cloudflare rows_read or VM steps.
              populations.push(
                Number(
                  native
                    .prepare(
                      "SELECT COUNT(*) AS n FROM objects WHERE version_id='version' AND state IN ('present','uploading')",
                    )
                    .get().n,
                ),
              );
              if (!queryPlans.length)
                queryPlans.push(
                  native
                    .prepare("EXPLAIN QUERY PLAN " + sql)
                    .all(...values)
                    .map((row: { detail: string }) => row.detail),
                );
            }
            const changes = Number(prepared.run(...values).changes);
            if (/^(INSERT INTO|UPDATE) objects/.test(sql))
              objectTableChanges += changes;
            return { success: true, meta: { changes } };
          },
        };
        return statement;
      },
    };
    const payload = new Uint8Array([7]),
      digest = await crypto.subtle.digest("SHA-256", payload),
      checksum = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    const stored = new Map<string, unknown>();
    const media = {
      head: vi.fn(async (key: string) => stored.get(key) ?? null),
      put: vi.fn(async (key: string, body: ReadableStream) => {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        expect(bytes).toEqual(payload);
        const object = {
          size: bytes.byteLength,
          etag: "fixture-etag",
          checksums: { sha256: digest },
        };
        stored.set(key, object);
        return object;
      }),
    };
    const fetcher = vi.fn(() => {
      throw new Error("No external API or Container operation allowed");
    });
    vi.stubGlobal("fetch", fetcher);
    const env = { DB: db, MEDIA: media } as unknown as Env;
    const bridge = new (
      TaskBridge as unknown as new (ctx: unknown, env: Env) => TaskBridge
    )({ props: { taskId: "task" } }, env);
    for (let object = 0; object < objects; object++) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await bridge.fetch(
          new Request(
            `https://task.internal/output/segment-${String(object).padStart(6, "0")}.ts`,
            {
              method: "PUT",
              headers: { "Content-Length": "1", "X-Content-SHA256": checksum },
              body: payload,
            },
          ),
        );
        expect(response.status).toBe(200);
        expect(
          ((await response.json()) as { duplicate: boolean }).duplicate,
        ).toBe(attempt !== 0);
      }
    }
    expect(populations).toHaveLength(objects * 3);
    expect(
      queryPlans[0].filter((detail) => detail.includes("SCALAR SUBQUERY")),
    ).toHaveLength(2);
    expect(
      queryPlans[0].filter((detail) => detail.includes("objects_version")),
    ).toHaveLength(2);
    const aggregateRowVisits = populations.reduce(
      (sum, population) => sum + population * 2,
      0,
    );
    const oldLinearReadAllowance =
      objects * 8 +
      (Math.ceil(180 / 1.5) + 100) * 8 +
      (Math.ceil(180 / 5) + 100) * 4 +
      10000;
    expect(aggregateRowVisits).toBeGreaterThan(oldLinearReadAllowance);
    expect(resourceAmounts.d1RowsRead).toBeGreaterThanOrEqual(
      aggregateRowVisits,
    );
    // Include every objects index in the original migrated schema, rather
    // than treating one INSERT/UPDATE as exactly one billable written row.
    const objectIndexes = native
      .prepare("PRAGMA index_list(objects)")
      .all().length;
    expect(resourceAmounts.d1RowsWritten).toBeGreaterThanOrEqual(
      objectTableChanges * (1 + objectIndexes),
    );
    expect(media.put).toHaveBeenCalledTimes(objects);
    expect(
      native
        .prepare("SELECT COUNT(*) AS n FROM objects WHERE state='present'")
        .get().n,
    ).toBe(objects);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps maximum supported object/time row allowances finite safe integers and covers all modeled attempts", () => {
    const objects = 10000,
      resourceAmounts = processingResourceAmounts(
        INSTANCES[3],
        bounds(objects, 21600),
      );
    expect(Number.isSafeInteger(resourceAmounts.d1RowsRead)).toBe(true);
    expect(Number.isSafeInteger(resourceAmounts.d1RowsWritten)).toBe(true);
    expect(resourceAmounts.d1RowsRead).toBeGreaterThanOrEqual(
      3 * 2 * objects ** 2,
    );
    expect(resourceAmounts.d1RowsWritten).toBeGreaterThanOrEqual(
      3 * 6 * objects,
    );
  });
  it.each([0, 1, 10001, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects an unsafe HLS object bound %s",
    (objects) => {
      expect(() =>
        processingResourceAmounts(INSTANCES[0], bounds(objects)),
      ).toThrow(expect.objectContaining({ code: "invalid_budget" }));
    },
  );
  it.each([0, 59, 21601, 60.5, NaN, Infinity])(
    "rejects an unsafe time bound %s",
    (seconds) => {
      expect(() =>
        processingResourceAmounts(INSTANCES[0], bounds(64, seconds)),
      ).toThrow(expect.objectContaining({ code: "invalid_budget" }));
    },
  );
});
