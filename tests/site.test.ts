import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SITE_SETTINGS,
  MAX_SITE_LOGO_BYTES,
  deleteSiteLogo,
  getSite,
  patchSite,
  prepareSiteLogo,
  putSiteLogo,
  readSiteSettings,
  serveSiteLogo,
} from "../src/site";
import { sha256 } from "../src/http";
import { storageList } from "../src/storage";
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
const { deflateSync } = (await import("node:zlib" as string)) as {
  deflateSync(bytes: Uint8Array): Uint8Array;
};
const databases: NativeDatabase[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
});

function concat(...values: Uint8Array[]) {
  const bytes = new Uint8Array(values.reduce((n, b) => n + b.length, 0));
  let p = 0;
  for (const value of values) {
    bytes.set(value, p);
    p += value.length;
  }
  return bytes;
}
function be32(value: number) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value);
  return b;
}
function crc(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let n = 0; n < 8; n++)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return be32((value ^ 0xffffffff) >>> 0);
}
function chunk(type: string, data = new Uint8Array()) {
  const content = concat(new TextEncoder().encode(type), data);
  return concat(be32(data.length), content, crc(content));
}
function png(width = 32, height = 32, shade = 0, extra?: Uint8Array) {
  const header = concat(
    be32(width),
    be32(height),
    new Uint8Array([8, 6, 0, 0, 0]),
  );
  const raw = extra ?? new Uint8Array((width * 4 + 1) * height);
  if (!extra)
    for (let row = 0; row < height; row++)
      raw.fill(shade, row * (width * 4 + 1) + 1, (row + 1) * (width * 4 + 1));
  return concat(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND"),
  );
}
function jpeg() {
  const marker = (type: number, data: Uint8Array) =>
    concat(
      new Uint8Array([
        255,
        type,
        (data.length + 2) >> 8,
        (data.length + 2) & 255,
      ]),
      data,
    );
  const counts = new Uint8Array(16);
  counts[0] = 1;
  // Synthetic constant-color baseline JPEG, one DC-zero/EOB code per block.
  return concat(
    new Uint8Array([255, 216]),
    marker(219, concat(new Uint8Array([0]), new Uint8Array(64).fill(1))),
    marker(
      192,
      new Uint8Array([8, 0, 32, 0, 32, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0]),
    ),
    marker(
      196,
      concat(
        new Uint8Array([0]),
        counts,
        new Uint8Array([0, 16]),
        counts,
        new Uint8Array([0]),
      ),
    ),
    marker(218, new Uint8Array([3, 1, 0, 2, 0, 3, 0, 0, 63, 0])),
    new Uint8Array(12),
    new Uint8Array([255, 217]),
  );
}
function upload(bytes: Uint8Array, type = "image/png") {
  return new Request("https://fixture.example/api/admin/site/logo", {
    method: "POST",
    headers: { "Content-Type": type },
    body: bytes as BodyInit,
  });
}
function patch(value: unknown) {
  return new Request("https://fixture.example/api/admin/site", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}
function setup(limit = 10 * 1024 ** 3) {
  const native = new DatabaseSync(":memory:");
  databases.push(native);
  for (const file of [
    "0001_initial.sql",
    "0002_imports.sql",
    "0003_deletion_items.sql",
    "0004_upload_approvals.sql",
    "0005_publication_revision.sql",
  ])
    native.exec(
      readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
    );
  native
    .prepare("UPDATE settings SET value=? WHERE key='storage_limit_bytes'")
    .run(String(limit));
  native.exec(
    "INSERT INTO videos(id,title,source_revision,source_name,status,created_at,updated_at) VALUES('kept','Original','revision','original.mp4','ready',1,1); INSERT INTO versions(id,video_id,prefix,state,mode,quality,timeline_id,created_at) VALUES('hls','kept','videos/kept/versions/hls/','verified','probe-remux','source','timeline',1);",
  );
  let beforeReservation: (() => void) | undefined,
    failSetting = false;
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
          if (sql.startsWith("INSERT INTO reservations") && beforeReservation) {
            const action = beforeReservation;
            beforeReservation = undefined;
            action();
          }
          if (failSetting && sql.startsWith("INSERT INTO settings"))
            throw new Error("Injected D1 failure");
          const result = prepared.run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
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
  const stored = new Map<string, { bytes: Uint8Array; etag: string }>();
  let losePutAck = false,
    failPut = false,
    unknownList = false;
  const meta = (key: string) => {
    const item = stored.get(key);
    return item
      ? {
          key,
          size: item.bytes.length,
          etag: item.etag,
          uploaded: new Date(),
          httpMetadata: {},
          customMetadata: {},
        }
      : null;
  };
  const media = {
    head: vi.fn(async (key: string) => meta(key)),
    get: vi.fn(
      async (key: string, options?: { onlyIf?: { etagMatches?: string } }) => {
        const object = meta(key),
          item = stored.get(key);
        if (!object || !item) return null;
        if (
          options?.onlyIf?.etagMatches &&
          options.onlyIf.etagMatches !== object.etag
        )
          return object;
        return {
          ...object,
          body: new Response(new Uint8Array(item.bytes)).body!,
        };
      },
    ),
    list: vi.fn(async () =>
      unknownList
        ? { objects: [], truncated: true }
        : {
            objects: [...stored.keys()].map((key) => meta(key)),
            truncated: false,
          },
    ),
    put: vi.fn(
      async (
        key: string,
        bytes: Uint8Array,
        options: { sha256: string; onlyIf: Headers },
      ) => {
        if (failPut) throw new Error("Injected put failure");
        expect(options.onlyIf.get("If-None-Match")).toBe("*");
        expect(await sha256(bytes)).toBe(options.sha256);
        if (!stored.has(key))
          stored.set(key, {
            bytes: new Uint8Array(bytes),
            etag: options.sha256.slice(0, 32),
          });
        if (losePutAck) {
          losePutAck = false;
          throw new Error("Lost acknowledgement after persisted write");
        }
        return meta(key);
      },
    ),
    delete: vi.fn(() => {
      throw new Error("No Logo deletion is authorized");
    }),
  };
  const env = {
    DB: db,
    MEDIA: media,
    PROCESSOR: {
      get: vi.fn(() => {
        throw new Error("No Container calls");
      }),
    },
  } as unknown as Env;
  return {
    env,
    native,
    stored,
    media,
    beforeReservation(action: () => void) {
      beforeReservation = action;
    },
    failSetting() {
      failSetting = true;
    },
    losePutAck() {
      losePutAck = true;
    },
    failPut() {
      failPut = true;
    },
    unknownList() {
      unknownList = true;
    },
  };
}

describe("site settings and actual bounded image validation", () => {
  it("returns only safe public defaults and changes settings without changing videos", async () => {
    const f = setup();
    expect(await (await getSite(f.env)).json()).toEqual({
      name: "Video Hub",
      logoUrl: null,
      searchIndexing: false,
      updatedAt: 0,
    });
    expect(await readSiteSettings(f.env)).toEqual(DEFAULT_SITE_SETTINGS);
    await patchSite(
      patch({ name: "  Moonwater  ", searchIndexing: true }),
      f.env,
    );
    expect(await (await getSite(f.env)).json()).toMatchObject({
      name: "Moonwater",
      searchIndexing: true,
    });
    await patchSite(patch({ name: "  " }), f.env);
    expect((await readSiteSettings(f.env)).name).toBe("Video Hub");
    expect(f.native.prepare("SELECT title FROM videos").get()).toEqual({
      title: "Original",
    });
    expect(f.media.put).not.toHaveBeenCalled();
  });
  it.each([
    { name: "x".repeat(61) },
    { name: null },
    { name: "bad\nname" },
    { searchIndexing: "true" },
    { searchIndexing: 1 },
    { logoUrl: "https://evil.example/logo.svg" },
    {},
  ])("rejects malformed settings %j", async (value) => {
    const f = setup();
    await expect(patchSite(patch(value), f.env)).rejects.toMatchObject({
      status: 400,
    });
    expect(await readSiteSettings(f.env)).toEqual(DEFAULT_SITE_SETTINGS);
  });
  it("refuses malformed persisted arbitrary Logo paths", async () => {
    const f = setup();
    f.native
      .prepare("INSERT INTO settings VALUES('site_branding_json',?,1)")
      .run(
        JSON.stringify({
          ...DEFAULT_SITE_SETTINGS,
          logo: {
            hash: "https://evil.example/a",
            ext: "svg",
            width: 32,
            height: 32,
            bytes: 20,
            etag: "x",
          },
        }),
      );
    await expect(readSiteSettings(f.env)).rejects.toMatchObject({
      code: "site_unavailable",
    });
    expect(f.media.get).not.toHaveBeenCalled();
  });
  it("validates PNG CRC/deflate scanlines and baseline JPEG structure, not names", async () => {
    const p = await prepareSiteLogo(upload(png()));
    expect(p).toMatchObject({ width: 32, height: 32, ext: "png" });
    expect(p.hash).toBe(await sha256(p.bytes));
    expect(await prepareSiteLogo(upload(jpeg(), "image/jpeg"))).toMatchObject({
      width: 32,
      height: 32,
      ext: "jpg",
    });
  });
  it.each(["image/svg+xml", "text/html", "application/octet-stream"])(
    "rejects MIME %s without accepting SVG/HTML",
    async (type) => {
      await expect(
        prepareSiteLogo(upload(new TextEncoder().encode("<svg/>"), type)),
      ).rejects.toMatchObject({ status: 415 });
    },
  );
  it("rejects mismatched MIME, corrupt CRC, incomplete JPEG and trailing polyglots", async () => {
    const bad = png();
    bad[bad.length - 1] ^= 1;
    for (const request of [
      upload(jpeg()),
      upload(png(), "image/jpeg"),
      upload(bad),
      upload(jpeg().slice(0, -2), "image/jpeg"),
      upload(concat(png(), new TextEncoder().encode("<html>"))),
      upload(concat(jpeg(), new Uint8Array([1])), "image/jpeg"),
    ])
      await expect(prepareSiteLogo(request)).rejects.toMatchObject({
        code: "invalid_logo",
      });
  });
  it("bounds actual compressed output, filter bytes and dimensions", async () => {
    await expect(prepareSiteLogo(upload(png(31, 32)))).rejects.toMatchObject({
      code: "logo_dimensions",
    });
    await expect(
      prepareSiteLogo(upload(png(2048, 2048))),
    ).rejects.toMatchObject({ code: "logo_dimensions" });
    await expect(
      prepareSiteLogo(upload(png(32, 32, 0, new Uint8Array(32 * 129 + 100)))),
    ).rejects.toMatchObject({ code: "invalid_logo" });
    const raw = new Uint8Array(32 * 129);
    raw[0] = 5;
    await expect(
      prepareSiteLogo(upload(png(32, 32, 0, raw))),
    ).rejects.toMatchObject({ code: "invalid_logo" });
    await expect(
      prepareSiteLogo(upload(new Uint8Array(MAX_SITE_LOGO_BYTES + 1))),
    ).rejects.toMatchObject({ status: 413 });
  });
});

describe("Logo immutable storage, shared capacity and current-reference delivery", () => {
  it("registers only content-addressed branding and serves current GET/HEAD with safe headers", async () => {
    const f = setup(),
      prepared = await prepareSiteLogo(upload(png()));
    const result = (await (await putSiteLogo(f.env, prepared)).json()) as {
      logoUrl: string;
    };
    expect(result.logoUrl).toBe(`/site-logo/${prepared.hash}.png`);
    const object = f.native.prepare("SELECT * FROM objects").get();
    expect(object).toMatchObject({
      key: `site/branding/${prepared.hash}.png`,
      category: "branding",
      video_id: null,
      version_id: null,
      bytes: prepared.bytes.length,
      sha256: prepared.hash,
      state: "present",
    });
    expect(
      f.native.prepare("SELECT state,amounts_json FROM reservations").get(),
    ).toEqual({ state: "released", amounts_json: "{}" });
    const response = await serveSiteLogo(
      new Request("https://fixture.example" + result.logoUrl),
      f.env,
      prepared.hash,
      "png",
    );
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await sha256(await response.arrayBuffer())).toBe(prepared.hash);
    const gets = f.media.get.mock.calls.length;
    expect(
      (
        await serveSiteLogo(
          new Request("https://fixture.example" + result.logoUrl, {
            method: "HEAD",
          }),
          f.env,
          prepared.hash,
          "png",
        )
      ).body,
    ).toBeNull();
    expect(f.media.get).toHaveBeenCalledTimes(gets);
    expect(
      Object.keys((await (await getSite(f.env)).json()) as object).sort(),
    ).toEqual(["logoUrl", "name", "searchIndexing", "updatedAt"]);
    expect(
      f.native.prepare("SELECT COUNT(*) AS n FROM versions").get(),
    ).toEqual({ n: 1 });
    const inventory = (await (
      await storageList(
        new Request(
          "https://fixture.example/api/admin/storage?category=branding",
        ),
        f.env,
      )
    ).json()) as {
      total: number;
      items: { category: string }[];
      summary: Record<string, number>;
    };
    expect(inventory.total).toBe(1);
    expect(inventory.items[0].category).toBe("branding");
    expect(inventory.summary.branding).toBe(prepared.bytes.length);
    expect(inventory.summary.failed_output).toBeUndefined();
  });
  it("deduplicates replacements and restoring defaults never deletes stored media", async () => {
    const f = setup(),
      a = await prepareSiteLogo(upload(png())),
      b = await prepareSiteLogo(upload(png(32, 32, 3)));
    await putSiteLogo(f.env, a);
    await putSiteLogo(f.env, a);
    expect(f.media.put).toHaveBeenCalledTimes(1);
    await putSiteLogo(f.env, b);
    expect(f.stored.size).toBe(2);
    await expect(
      serveSiteLogo(
        new Request("https://fixture.example"),
        f.env,
        a.hash,
        "png",
      ),
    ).rejects.toMatchObject({ status: 404 });
    await deleteSiteLogo(f.env);
    expect((await readSiteSettings(f.env)).logo).toBeNull();
    expect(f.stored.size).toBe(2);
    expect(f.media.delete).not.toHaveBeenCalled();
    await expect(
      serveSiteLogo(
        new Request("https://fixture.example"),
        f.env,
        b.hash,
        "png",
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("blocks actual unregistered R2 occupancy and live upload/processing reservations while ignoring retired approvals", async () => {
    const prepared = await prepareSiteLogo(upload(png()));
    for (const kind of ["physical", "upload", "approval", "processing"]) {
      const f = setup(prepared.bytes.length + 99);
      if (kind === "physical")
        f.stored.set("videos/kept/unregistered", {
          bytes: new Uint8Array(100),
          etag: "a".repeat(32),
        });
      if (kind === "upload")
        f.native.exec(
          "INSERT INTO uploads VALUES('u','kept','videos/kept/upload','multipart','fingerprint',100,'uploading',100,9999999999999,1,1,NULL)",
        );
      if (kind === "approval")
        f.native.exec(
          "INSERT INTO upload_approvals(id,scope_hash,state,total_bytes,additional_bytes,reasons_json,expires_at,created_at) VALUES('a','scope','confirmed',100,100,'[]',9999999999999,1); INSERT INTO upload_approval_files(id,approval_id,name,title,expected_size,fingerprint,reserved_bytes) VALUES('f','a','x','x',100,'" +
            "a".repeat(64) +
            "',100)",
        );
      if (kind === "processing")
        f.native.exec(
          "INSERT INTO reservations(id,owner_id,kind,amounts_json,state,created_at) VALUES('processing','job','processing','{\"r2CurrentBytes\":100}','active',1)",
        );
      if (kind === "approval") {
        expect((await putSiteLogo(f.env, prepared)).status).toBe(200);
        continue;
      }
      await expect(putSiteLogo(f.env, prepared)).rejects.toMatchObject({
        code: "storage_limit",
      });
      expect(f.media.put).not.toHaveBeenCalled();
      expect((await readSiteSettings(f.env)).logo).toBeNull();
    }
  });
  it("atomically rejects a lower limit or new upload reservation after the census", async () => {
    const prepared = await prepareSiteLogo(upload(png()));
    for (const change of ["limit", "upload"]) {
      const f = setup(prepared.bytes.length + 99);
      f.beforeReservation(() =>
        change === "limit"
          ? f.native
              .prepare(
                "UPDATE settings SET value='1' WHERE key='storage_limit_bytes'",
              )
              .run()
          : f.native.exec(
              "INSERT INTO uploads VALUES('u','kept','videos/kept/upload','m','f',100,'uploading',100,9999999999999,1,1,NULL)",
            ),
      );
      await expect(putSiteLogo(f.env, prepared)).rejects.toMatchObject({
        code: "storage_limit",
      });
      expect(f.media.put).not.toHaveBeenCalled();
    }
  });
  it("retains one reservation after an unknown PUT then verifies the persisted object on retry", async () => {
    const f = setup(),
      prepared = await prepareSiteLogo(upload(png()));
    f.losePutAck();
    await expect(putSiteLogo(f.env, prepared)).rejects.toThrow();
    expect(
      f.native.prepare("SELECT state,amounts_json FROM reservations").get(),
    ).toEqual({
      state: "active",
      amounts_json: JSON.stringify({ r2CurrentBytes: prepared.bytes.length }),
    });
    expect((await readSiteSettings(f.env)).logo).toBeNull();
    await putSiteLogo(f.env, prepared);
    expect(f.media.put).toHaveBeenCalledTimes(1);
    expect(
      f.native.prepare("SELECT COUNT(*) AS n FROM reservations").get(),
    ).toEqual({ n: 1 });
    expect(f.native.prepare("SELECT state FROM reservations").get()).toEqual({
      state: "released",
    });
  });
  it("does not overwrite changed hash content or release an unresolved failed write", async () => {
    const prepared = await prepareSiteLogo(upload(png())),
      f = setup();
    f.stored.set(`site/branding/${prepared.hash}.png`, {
      bytes: new Uint8Array(prepared.bytes.length),
      etag: "a".repeat(32),
    });
    await expect(putSiteLogo(f.env, prepared)).rejects.toMatchObject({
      code: "logo_storage_unverified",
    });
    expect(f.media.put).not.toHaveBeenCalled();
    expect((await readSiteSettings(f.env)).logo).toBeNull();
    const g = setup();
    g.failPut();
    await expect(putSiteLogo(g.env, prepared)).rejects.toThrow();
    expect(g.native.prepare("SELECT state FROM reservations").get()).toEqual({
      state: "active",
    });
    expect(g.media.delete).not.toHaveBeenCalled();
  });
  it("bounds a genuinely pending PUT while retaining capacity and the prior site reference", async () => {
    const f = setup(),
      prepared = await prepareSiteLogo(upload(png()));
    vi.useFakeTimers();
    f.media.put.mockImplementationOnce(() => new Promise<never>(() => {}));
    const outcome = putSiteLogo(f.env, prepared).then(
      () => null,
      (error) => error,
    );
    await vi.waitFor(() => expect(f.media.put).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5001);
    expect(await outcome).toMatchObject({
      status: 503,
      code: "logo_storage_unverified",
    });
    expect(
      f.native.prepare("SELECT state,amounts_json FROM reservations").get(),
    ).toEqual({
      state: "active",
      amounts_json: JSON.stringify({ r2CurrentBytes: prepared.bytes.length }),
    });
    expect((await readSiteSettings(f.env)).logo).toBeNull();
    expect(f.media.delete).not.toHaveBeenCalled();
  });
  it("cancels a late deduplication GET body after its bounded timeout", async () => {
    const f = setup(),
      prepared = await prepareSiteLogo(upload(png()));
    await putSiteLogo(f.env, prepared);
    f.media.get.mockClear();
    let deliver!: (value: Awaited<ReturnType<typeof f.media.get>>) => void;
    f.media.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    vi.useFakeTimers();
    const outcome = putSiteLogo(f.env, prepared).then(
      () => null,
      (error) => error,
    );
    await vi.waitFor(() => expect(f.media.get).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5001);
    expect(await outcome).toMatchObject({ code: "logo_storage_unverified" });
    const body = new Response(new Uint8Array(prepared.bytes)).body!,
      cancel = vi.spyOn(body, "cancel");
    deliver({
      key: `site/branding/${prepared.hash}.png`,
      size: prepared.bytes.length,
      etag: prepared.hash.slice(0, 32),
      uploaded: new Date(),
      httpMetadata: {},
      customMetadata: {},
      body,
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(f.media.put).toHaveBeenCalledTimes(1);
  });
  it("cancels an already delivered GET body when its identity disagrees with HEAD", async () => {
    const f = setup(),
      prepared = await prepareSiteLogo(upload(png())),
      key = `site/branding/${prepared.hash}.png`;
    f.stored.set(key, {
      bytes: prepared.bytes,
      etag: prepared.hash.slice(0, 32),
    });
    const body = new Response(new Uint8Array(prepared.bytes)).body!,
      cancel = vi.spyOn(body, "cancel");
    f.media.get.mockResolvedValueOnce({
      key,
      size: prepared.bytes.length,
      etag: "b".repeat(32),
      uploaded: new Date(),
      httpMetadata: {},
      customMetadata: {},
      body,
    });
    await expect(putSiteLogo(f.env, prepared)).rejects.toMatchObject({
      code: "logo_storage_unverified",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.media.put).not.toHaveBeenCalled();
    expect((await readSiteSettings(f.env)).logo).toBeNull();
  });
  it("preserves old settings and held capacity if final D1 registration rolls back", async () => {
    const f = setup(),
      prepared = await prepareSiteLogo(upload(png()));
    await patchSite(patch({ name: "Retained" }), f.env);
    f.failSetting();
    await expect(putSiteLogo(f.env, prepared)).rejects.toThrow();
    expect(await readSiteSettings(f.env)).toMatchObject({
      name: "Retained",
      logo: null,
    });
    expect(f.native.prepare("SELECT COUNT(*) AS n FROM objects").get()).toEqual(
      { n: 0 },
    );
    expect(f.native.prepare("SELECT state FROM reservations").get()).toEqual({
      state: "active",
    });
    expect(f.stored.size).toBe(1);
  });
  it("fails closed on incomplete census or malformed reservation ledger", async () => {
    const prepared = await prepareSiteLogo(upload(png())),
      f = setup();
    f.unknownList();
    await expect(putSiteLogo(f.env, prepared)).rejects.toMatchObject({
      code: "storage_unknown",
    });
    expect(f.media.put).not.toHaveBeenCalled();
    const g = setup();
    g.native.exec(
      "INSERT INTO reservations(id,owner_id,kind,amounts_json,state,created_at) VALUES('bad','bad','processing','{\"r2CurrentBytes\":-1}','active',1)",
    );
    await expect(putSiteLogo(g.env, prepared)).rejects.toMatchObject({
      code: "storage_unknown",
    });
    expect(g.media.put).not.toHaveBeenCalled();
  });
  it("refuses untrusted prepared payloads, arbitrary keys and stale R2 objects", async () => {
    const f = setup(),
      prepared = await prepareSiteLogo(upload(png()));
    await expect(
      putSiteLogo(f.env, { ...prepared, hash: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "invalid_logo" });
    await putSiteLogo(f.env, prepared);
    await expect(
      serveSiteLogo(
        new Request("https://fixture.example"),
        f.env,
        "../video",
        "png",
      ),
    ).rejects.toMatchObject({ status: 404 });
    f.stored.get(`site/branding/${prepared.hash}.png`)!.etag = "b".repeat(32);
    await expect(
      serveSiteLogo(
        new Request("https://fixture.example"),
        f.env,
        prepared.hash,
        "png",
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
