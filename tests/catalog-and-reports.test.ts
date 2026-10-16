import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));
import worker from "../src/index";
import { login } from "../src/auth";
import type { Env } from "../src/types";

interface Statement {
  all(...values: unknown[]): Record<string, unknown>[];
  get(...values: unknown[]): Record<string, unknown> | undefined;
  run(...values: unknown[]): unknown;
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
const origin = "https://catalog-test.example";
async function setup(count = 1) {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  native.exec(
    readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  for (let i = 0; i < count; i++) {
    const id = `video-${String(i).padStart(3, "0")}`;
    native
      .prepare(
        "INSERT INTO videos(id,title,source_revision,source_name,status,published,current_version_id,created_at,updated_at) VALUES(?,?,?,'fixture.mp4','ready',1,?,1,?)",
      )
      .run(id, `Title ${i}`, `source-${i}`, `version-${i}`, i + 1);
    native
      .prepare(
        "INSERT INTO versions(id,video_id,prefix,state,mode,quality,duration,timeline_id,created_at) VALUES(?,?,?,'verified','probe-remux','source',60,?,1)",
      )
      .run(`version-${i}`, id, `fixture/${i}/`, `timeline-${i}`);
  }
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
          return prepared.run(...values);
        },
      };
      return statement;
    },
  };
  let rateStatus = 200;
  const rates: { key: string; limit: number; windowMs: number }[] = [];
  const start = vi.fn();
  const env = {
    DB: db,
    APP_ENV: "test",
    ADMIN_PASSWORD: "test-only-catalog-administrator",
    SESSION_SECRET: "test-only-catalog-session-secret-at-least-32-characters",
    PROCESSOR: { get: start },
    COORDINATOR: {
      idFromName: () => "admission",
      get: () => ({
        fetch: async (input: Request | string, init?: RequestInit) => {
          rates.push(
            typeof input === "string"
              ? JSON.parse(String(init?.body))
              : await input.json(),
          );
          return Response.json({}, { status: rateStatus });
        },
      }),
    },
  } as unknown as Env;
  const auth = await login(
    new Request(origin + "/api/admin/login", {
      method: "POST",
      headers: { Origin: origin },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    }),
    env,
  );
  rates.length = 0;
  const cookie = auth.headers.get("Set-Cookie")!.split(";")[0];
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  } as unknown as ExecutionContext;
  const get = (path: string, admin = false) =>
    worker.fetch(
      new Request(origin + path, {
        headers: admin ? { Cookie: cookie } : {},
      }),
      env,
      ctx,
    );
  const report = (data: unknown, reportOrigin = origin) =>
    worker.fetch(
      new Request(origin + "/api/report", {
        method: "POST",
        headers: { Origin: reportOrigin, "CF-Connecting-IP": "192.0.2.1" },
        body: JSON.stringify(data),
      }),
      env,
      ctx,
    );
  return {
    native,
    env,
    get,
    report,
    rates,
    start,
    pending,
    denyRate: () => {
      rateStatus = 429;
    },
  };
}
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

describe("actual catalog SQL and shrinking result pages", () => {
  it("filters publication separately from processing status, combined with title search", async () => {
    const s = await setup(3);
    s.native.exec("UPDATE videos SET published=0 WHERE id='video-002'");
    const published = (await (
      await s.get("/api/admin/videos?status=published", true)
    ).json()) as { items: { id: string }[]; total: number };
    expect(published.total).toBe(2);
    expect(published.items.map((v) => v.id)).toEqual([
      "video-001",
      "video-000",
    ]);
    const ready = (await (
      await s.get("/api/admin/videos?status=ready", true)
    ).json()) as { total: number };
    expect(ready.total).toBe(3);
    const searched = (await (
      await s.get("/api/admin/videos?status=published&q=Title%200", true)
    ).json()) as { total: number };
    expect(searched.total).toBe(1);
    expect(s.start).not.toHaveBeenCalled();
  });
  it("returns the surviving last page after an administrator removes the last item", async () => {
    const s = await setup(21);
    const before = (await (
      await s.get("/api/admin/videos?page=2", true)
    ).json()) as { page: number; items: { id: string }[] };
    expect(before.page).toBe(2);
    expect(before.items).toHaveLength(1);
    s.native
      .prepare("UPDATE videos SET status='deleted' WHERE id=?")
      .run(before.items[0].id);
    const after = (await (
      await s.get("/api/admin/videos?page=2", true)
    ).json()) as { page: number; total: number; items: unknown[] };
    expect(after).toMatchObject({ page: 1, total: 20 });
    expect(after.items).toHaveLength(20);
  });
  it("clamps the public last page after unpublication and bounds an empty catalog", async () => {
    const s = await setup(25);
    const before = (await (await s.get("/api/videos?page=3")).json()) as {
      items: { id: string }[];
    };
    expect(before.items).toHaveLength(1);
    s.native
      .prepare("UPDATE videos SET published=0 WHERE id=?")
      .run(before.items[0].id);
    const after = (await (await s.get("/api/videos?page=3")).json()) as {
      page: number;
      total: number;
      items: unknown[];
    };
    expect(after).toMatchObject({ page: 2, total: 24 });
    expect(after.items).toHaveLength(12);
    s.native.exec("UPDATE videos SET published=0");
    expect(await (await s.get("/api/videos?page=999999")).json()).toMatchObject(
      { page: 1, total: 0, items: [] },
    );
  });
});

const valid = {
  code: "playback_native_error",
  videoId: "video-000",
  versionId: "version-0",
  nativeErrorCode: 3,
};
describe("bounded write-only playback diagnostics", () => {
  it("stores only known context and enums, correlating the server request ID", async () => {
    const s = await setup();
    const result = await s.report(valid);
    expect(result.status).toBe(202);
    const row = s.native.prepare("SELECT * FROM logs").get()!;
    expect(row.request_id).toBe(result.headers.get("X-Request-ID"));
    expect(row).toMatchObject({
      video_id: "video-000",
      stage: "visitor_report",
      level: "warn",
      message: "playback_native_error",
    });
    expect(JSON.parse(String(row.details_json))).toEqual({
      versionId: "version-0",
      nativeErrorCode: 3,
    });
    expect(s.rates.map((r) => [r.limit, r.windowMs])).toEqual([
      [100, 60000],
      [5, 60000],
      [1000, 86400000],
    ]);
    expect(s.start).not.toHaveBeenCalled();
    expect((await s.get("/api/admin/logs")).status).toBe(401);
    const admin = (await (await s.get("/api/admin/logs", true)).json()) as {
      items: unknown[];
    };
    expect(admin.items).toHaveLength(1);
  });
  it.each([
    { ...valid, url: "https://private.invalid/?token=synthetic-do-not-log" },
    { ...valid, message: "synthetic private error" },
    { ...valid, stack: "synthetic stack" },
    { ...valid, code: "arbitrary_message" },
    { ...valid, nativeErrorCode: 9 },
    { ...valid, nativeErrorCode: "3" },
    { ...valid, hlsErrorType: "networkError" },
    { ...valid, videoId: "../unsafe" },
    {
      code: "playback_hls_fatal",
      videoId: "video-000",
      versionId: "version-0",
      hlsErrorType: "https://unsafe.invalid",
    },
  ])(
    "rejects unsafe or unsupported fields without persisting them",
    async (input) => {
      const s = await setup();
      expect((await s.report(input)).status).toBe(400);
      expect(s.native.prepare("SELECT COUNT(*) AS n FROM logs").get()?.n).toBe(
        0,
      );
    },
  );
  it("does not reveal or persist unknown context, but accepts known removed versions", async () => {
    const s = await setup();
    expect((await s.report({ ...valid, versionId: "unknown" })).status).toBe(
      202,
    );
    expect(s.native.prepare("SELECT COUNT(*) AS n FROM logs").get()?.n).toBe(0);
    s.native.exec(
      "UPDATE videos SET published=0; UPDATE versions SET state='deleted'",
    );
    expect((await s.report(valid)).status).toBe(202);
    expect(s.native.prepare("SELECT COUNT(*) AS n FROM logs").get()?.n).toBe(1);
  });
  it("keeps same-origin, size and rate protections ahead of diagnostic writes", async () => {
    const s = await setup();
    expect((await s.report(valid, "https://foreign.example")).status).toBe(403);
    expect((await s.report({ ...valid, extra: "x".repeat(2048) })).status).toBe(
      413,
    );
    s.denyRate();
    expect((await s.report(valid)).status).toBe(429);
    expect(s.native.prepare("SELECT COUNT(*) AS n FROM logs").get()?.n).toBe(0);
  });
});

describe("published original playback descriptors with actual SQLite routing", () => {
  async function sourceDetail() {
    const [{ sourceMp4Fixture }, { inspectSourceMp4 }] = await Promise.all([
      import("./source-fixture"),
      import("../src/source-mp4"),
    ]);
    const f = await setup(2);
    const bytes = sourceMp4Fixture();
    const probe = await inspectSourceMp4(bytes.length, async (offset, length) =>
      bytes.slice(offset, offset + length),
    );
    expect(probe.compatible).toBe(true);
    const validation = {
      kind: "source",
      schemaVersion: 1,
      serverDecoded: false,
      source: {
        key: "videos/video-000/source/private-object-path",
        bytes: bytes.length,
        etag: "source-etag",
        revision: "private-source-revision",
      },
      probe,
      administratorAttestation: {
        basis: "administrator-browser-playback-and-seek",
        confirmedAt: 1,
        played: true,
        seeked: true,
        audioConfirmed: true,
        durationSeconds: 10,
        seekFromSeconds: 1,
        seekToSeconds: 5,
      },
      token: "synthetic-private-value",
    };
    f.native
      .prepare(
        "UPDATE videos SET source_key=?,source_size=?,source_etag=?,source_revision=? WHERE id='video-000'",
      )
      .run(
        validation.source.key,
        bytes.length,
        validation.source.etag,
        validation.source.revision,
      );
    f.native
      .prepare(
        "UPDATE versions SET mode='source',manifest='source.mp4',bytes=?,duration=10,validation_json=? WHERE id='version-0'",
      )
      .run(bytes.length, JSON.stringify(validation));
    const head = vi.fn(() => {
      throw new Error("Public detail must not HEAD media");
    });
    const get = vi.fn(() => {
      throw new Error("Public detail must not GET media");
    });
    f.env.MEDIA = { head, get } as unknown as R2Bucket;
    return { ...f, bytes, validation, head, mediaGet: get };
  }

  it("returns only bounded whitelisted structure and identity fields for the selected published source version", async () => {
    const f = await sourceDetail();
    const response = await f.get("/api/videos/video-000");
    expect(response.status).toBe(200);
    const value = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual(
      [
        "id",
        "title",
        "duration",
        "versionId",
        "timelineId",
        "updatedAt",
        "mediaKind",
        "mediaName",
        "sourcePlayback",
      ].sort(),
    );
    expect(value).toMatchObject({
      id: "video-000",
      versionId: "version-0",
      mediaKind: "source",
      mediaName: "source.mp4",
      sourcePlayback: {
        bytes: f.bytes.length,
        etag: "source-etag",
        probe: f.validation.probe,
      },
    });
    expect(Object.keys(value.sourcePlayback as object).sort()).toEqual([
      "bytes",
      "etag",
      "probe",
    ]);
    expect(JSON.stringify(value)).not.toMatch(
      /private-object-path|private-source-revision|administratorAttestation|synthetic-private-value|validation_json|sourceEtag|selectedValidation/,
    );
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(f.head).not.toHaveBeenCalled();
    expect(f.mediaGet).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.rates).toHaveLength(0);
    const catalog = (await (await f.get("/api/videos")).json()) as {
      items: Record<string, unknown>[];
    };
    expect(catalog.items.every((video) => !video.sourcePlayback)).toBe(true);
  });

  it.each(["probe-remux", "transcode", "faststart"])(
    "does not expose an original descriptor for %s even if private source validation exists",
    async (mode) => {
      const f = await sourceDetail();
      f.native
        .prepare("UPDATE versions SET mode=? WHERE id='version-0'")
        .run(mode);
      const response = await f.get("/api/videos/video-000");
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty("sourcePlayback");
      expect(f.head).not.toHaveBeenCalled();
      expect(f.mediaGet).not.toHaveBeenCalled();
    },
  );

  it.each([
    "unpublished",
    "unverified version",
    "no selected version",
    "other video version",
  ])(
    "keeps %s unavailable before returning any source descriptor",
    async (change) => {
      const f = await sourceDetail();
      if (change === "unpublished")
        f.native.exec("UPDATE videos SET published=0 WHERE id='video-000'");
      if (change === "unverified version")
        f.native.exec(
          "UPDATE versions SET state='failed' WHERE id='version-0'",
        );
      if (change === "no selected version")
        f.native.exec(
          "UPDATE videos SET current_version_id=NULL WHERE id='video-000'",
        );
      if (change === "other video version")
        f.native.exec(
          "UPDATE videos SET current_version_id='version-0' WHERE id='video-001'",
        );
      const response = await f.get(
        `/api/videos/${change === "other video version" ? "video-001" : "video-000"}`,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: "video_unavailable" },
      });
      expect(f.head).not.toHaveBeenCalled();
      expect(f.mediaGet).not.toHaveBeenCalled();
    },
  );

  it.each([
    "malformed JSON",
    "oversized envelope",
    "oversized probe",
    "wrong kind",
    "wrong schema",
    "decoded claim",
    "incompatible probe",
    "incomplete probe",
    "probe extra field",
    "source size mismatch",
    "version duration mismatch",
    "changed source key",
    "changed source ETag",
    "changed source revision",
    "changed source bytes",
    "unsafe ETag",
  ])(
    "omits an advisory descriptor with %s without leaking raw validation",
    async (invalid) => {
      const f = await sourceDetail();
      let validation: unknown = structuredClone(f.validation);
      const record = validation as typeof f.validation;
      if (invalid === "wrong kind") record.kind = "hls";
      if (invalid === "wrong schema") record.schemaVersion = 99;
      if (invalid === "decoded claim") record.serverDecoded = true;
      if (invalid === "incompatible probe") record.probe.compatible = false;
      if (invalid === "incomplete probe") delete record.probe.index;
      if (invalid === "probe extra field")
        Object.assign(record.probe, { sourceKey: "synthetic-private-value" });
      if (invalid === "oversized probe")
        Object.assign(record.probe, { padding: "x".repeat(4096) });
      if (invalid === "source size mismatch") record.source.bytes++;
      if (invalid === "unsafe ETag") {
        record.source.etag = '"unsafe-tag"';
        f.native
          .prepare("UPDATE videos SET source_etag=? WHERE id='video-000'")
          .run(record.source.etag);
      }
      if (invalid === "version duration mismatch")
        f.native.exec("UPDATE versions SET duration=11 WHERE id='version-0'");
      if (invalid === "changed source key")
        f.native.exec(
          "UPDATE videos SET source_key='imports/changed-private-path' WHERE id='video-000'",
        );
      if (invalid === "changed source ETag")
        f.native.exec(
          "UPDATE videos SET source_etag='changed' WHERE id='video-000'",
        );
      if (invalid === "changed source revision")
        f.native.exec(
          "UPDATE videos SET source_revision='changed' WHERE id='video-000'",
        );
      if (invalid === "changed source bytes")
        f.native.exec(
          "UPDATE videos SET source_size=source_size+1 WHERE id='video-000'",
        );
      let raw = JSON.stringify(validation);
      if (invalid === "malformed JSON") raw = "{";
      if (invalid === "oversized envelope") raw = raw + " ".repeat(8192);
      f.native
        .prepare("UPDATE versions SET validation_json=? WHERE id='version-0'")
        .run(raw);
      const response = await f.get("/api/videos/video-000");
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).not.toHaveProperty("sourcePlayback");
      expect(JSON.stringify(result)).not.toMatch(
        /synthetic-private-value|private-path|validation_json|sourceEtag/,
      );
      expect(f.head).not.toHaveBeenCalled();
      expect(f.mediaGet).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
    },
  );
});
