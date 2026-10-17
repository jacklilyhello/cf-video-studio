import { afterEach, describe, expect, it, vi } from "vitest";
import { isAdmin, login, visitor, visitorIdentity } from "../src/auth";
import { sameOrigin, sha256 } from "../src/http";
import { parseRange, safeMediaName, serveMedia } from "../src/media";
import { completeUpload, putPart } from "../src/uploads";
import type { Env, Upload } from "../src/types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function authEnv(): Env {
  return {
    ADMIN_PASSWORD: "test-only-administrator-password",
    SESSION_SECRET: "test-only-session-secret-at-least-32-characters",
    COORDINATOR: {
      idFromName: () => "singleton",
      get: () => ({
        fetch: vi.fn(async () => Response.json({ allowed: true })),
      }),
    },
  } as unknown as Env;
}
function writeRequest(
  path: string,
  value?: unknown,
  origin = "https://one.example",
) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
}
function cookie(response: Response) {
  return response.headers.get("Set-Cookie")!.split(";")[0];
}

describe("host-only password sessions", () => {
  it("binds sessions to the issuing host, rejects tampering, and invalidates on password rotation", async () => {
    const env = authEnv();
    const response = await login(
      writeRequest("/api/admin/login", { password: env.ADMIN_PASSWORD }),
      env,
    );
    const header = response.headers.get("Set-Cookie")!;
    expect(header).toContain("__Host-vh_admin=");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(header).not.toContain("Domain=");
    const value = cookie(response);
    expect(
      await isAdmin(
        new Request("https://one.example/api/admin/videos", {
          headers: { Cookie: value },
        }),
        env,
      ),
    ).toBe(true);
    expect(
      await isAdmin(
        new Request("https://two.example/api/admin/videos", {
          headers: { Cookie: value },
        }),
        env,
      ),
    ).toBe(false);
    expect(
      await isAdmin(
        new Request("https://one.example/api/admin/videos", {
          headers: { Cookie: value.slice(0, -4) + "fake" },
        }),
        env,
      ),
    ).toBe(false);
    expect(
      await isAdmin(
        new Request("https://one.example/api/admin/videos", {
          headers: { Cookie: value },
        }),
        { ...env, ADMIN_PASSWORD: "rotated-test-only-password" },
      ),
    ).toBe(false);
    expect(
      await isAdmin(
        new Request("https://one.example/api/admin/videos", {
          headers: { Cookie: value },
        }),
        { ...env, SESSION_SECRET: undefined },
      ),
    ).toBe(false);
  });
  it("rejects incorrect passwords and expired sessions", async () => {
    const env = authEnv();
    await expect(
      login(
        writeRequest("/api/admin/login", { password: "incorrect-test-value" }),
        env,
      ),
    ).rejects.toMatchObject({ status: 401 });
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-13T12:00:00Z"));
    const response = await login(
      writeRequest("/api/admin/login", { password: env.ADMIN_PASSWORD }),
      env,
    );
    vi.setSystemTime(Date.parse("2026-10-14T12:00:00Z"));
    expect(
      await isAdmin(
        new Request("https://one.example/admin", {
          headers: { Cookie: cookie(response) },
        }),
        env,
      ),
    ).toBe(false);
  });
  it("issues a separate signed visitor identity and never trusts another host or a forged cookie", async () => {
    const env = authEnv();
    const response = await visitorIdentity(
      writeRequest("/api/history/identity"),
      env,
    );
    expect(response.headers.get("Set-Cookie")).toContain("__Host-vh_visitor=");
    expect(response.headers.get("Set-Cookie")).not.toContain("Domain=");
    const value = cookie(response);
    const first = await visitor(
      new Request("https://one.example/api/history", {
        headers: { Cookie: value },
      }),
      env,
    );
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await visitor(
        new Request("https://two.example/api/history", {
          headers: { Cookie: value },
        }),
        env,
      ),
    ).toBeNull();
    expect(
      await visitor(
        new Request("https://one.example/api/history?visitor=someone-else", {
          headers: { Cookie: "__Host-vh_visitor=someone-else.fake-signature" },
        }),
        env,
      ),
    ).toBeNull();
  });
});

describe("same-origin write protection", () => {
  it("rejects absent, foreign, opaque, or cross-site origins", () => {
    expect(() => sameOrigin(writeRequest("/api/admin/logout"))).not.toThrow();
    const origins: Record<string, string>[] = [
      {},
      { Origin: "https://two.example" },
      { Origin: "null" },
      { Origin: "https://one.example", "Sec-Fetch-Site": "cross-site" },
    ];
    for (const headers of origins) {
      expect(() =>
        sameOrigin(
          new Request("https://one.example/api/admin/logout", {
            method: "POST",
            headers,
          }),
        ),
      ).toThrow();
    }
  });
});

describe("strict media unpublication and ranges", () => {
  it("rechecks publication before warmed-cache, HEAD, and Range reads on every domain", async () => {
    let published = true;
    const db = {
      prepare(sql: string) {
        const statement = {
          bind: () => statement,
          first: async () =>
            sql.includes("JOIN videos")
              ? published
                ? { prefix: "videos/v/versions/r/", mode: "probe-remux" }
                : null
              : { bytes: 7, etag: "verified-etag" },
        };
        return statement;
      },
    };
    const match = vi.fn(async () => new Response("segment"));
    const put = vi.fn(async () => {});
    vi.stubGlobal("caches", { default: { match, put } });
    const get = vi.fn();
    const head = vi.fn();
    const start = vi.fn();
    const env = {
      DB: db,
      MEDIA: { get, head },
      APP_ENV: "test",
      PROCESSOR: { get: start },
    } as unknown as Env;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const warm = await serveMedia(
      new Request("https://one.example/media/v/r/segment-000001.ts"),
      env,
      "v",
      "r",
      "segment-000001.ts",
      false,
      ctx,
    );
    expect(await warm.text()).toBe("segment");
    expect(warm.headers.get("Cache-Control")).toContain("no-store");
    expect(match).toHaveBeenCalledOnce();
    published = false;
    for (const host of ["one.example", "two.example"])
      for (const method of ["GET", "HEAD"])
        for (const range of [null, "bytes=0-1"]) {
          await expect(
            serveMedia(
              new Request(`https://${host}/media/v/r/segment-000001.ts`, {
                method,
                headers: range ? { Range: range } : {},
              }),
              env,
              "v",
              "r",
              "segment-000001.ts",
              false,
              ctx,
            ),
          ).rejects.toMatchObject({ status: 404 });
        }
    expect(match).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it("bounds ranges and excludes the original-file compatibility and traversal paths", () => {
    expect(parseRange("bytes=0-99", 10)).toEqual({ offset: 0, length: 10 });
    expect(parseRange("bytes=-2", 10)).toEqual({ offset: 8, length: 2 });
    expect(parseRange("bytes=8-", 10)).toEqual({ offset: 8, length: 2 });
    for (const value of [
      "bytes=10-",
      "bytes=5-3",
      "bytes=-0",
      "bytes=1-2,4-5",
      "bytes=9007199254740992-",
    ])
      expect(() => parseRange(value, 10)).toThrow();
    for (const name of [
      "source.mp4",
      "../index.m3u8",
      "segment-000001.ts/..",
      "https://other.example/segment.ts",
    ])
      expect(safeMediaName(name)).toBe(false);
  });
});

function uploadEnv(previous?: { sha256: string }) {
  const upload = {
    id: "upload",
    expected_size: 4,
    state: "uploading",
    multipart_id: "multipart",
    object_key: "videos/v/source/source",
    expires_at: Date.now() + 60000,
  } as Upload;
  const db = {
    prepare(sql: string) {
      const statement = {
        bind: () => statement,
        first: async () =>
          sql.includes("FROM uploads") ? upload : (previous ?? null),
      };
      return statement;
    },
  };
  const resumeMultipartUpload = vi.fn();
  const start = vi.fn();
  return {
    env: {
      DB: db,
      MEDIA: { resumeMultipartUpload },
      PROCESSOR: { get: start },
    } as unknown as Env,
    resumeMultipartUpload,
    start,
  };
}
describe("multipart upload byte and replay boundaries", () => {
  it("measures actual bytes even when Content-Length claims a smaller body", async () => {
    const { env, resumeMultipartUpload, start } = uploadEnv();
    const overrun = new Request("https://one.example/part", {
      method: "PUT",
      body: new Uint8Array(5),
      headers: { "Content-Length": "4", "X-Part-SHA256": "a".repeat(64) },
    });
    await expect(putPart(overrun, env, "upload", 1)).rejects.toMatchObject({
      status: 413,
      code: "part_size",
    });
    const short = new Request("https://one.example/part", {
      method: "PUT",
      body: new Uint8Array(3),
      headers: { "X-Part-SHA256": "a".repeat(64) },
    });
    await expect(putPart(short, env, "upload", 1)).rejects.toMatchObject({
      code: "part_size",
    });
    expect(resumeMultipartUpload).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it("returns the existing identical part and rejects conflicting replay without another R2 upload", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const digest = await sha256(bytes);
    const request = () =>
      new Request("https://one.example/part", {
        method: "PUT",
        body: bytes,
        headers: { "X-Part-SHA256": digest },
      });
    const same = uploadEnv({ sha256: digest });
    expect((await putPart(request(), same.env, "upload", 1)).status).toBe(200);
    expect(same.resumeMultipartUpload).not.toHaveBeenCalled();
    expect(same.start).not.toHaveBeenCalled();
    const conflict = uploadEnv({ sha256: "b".repeat(64) });
    await expect(
      putPart(request(), conflict.env, "upload", 1),
    ).rejects.toMatchObject({ status: 409, code: "part_conflict" });
    expect(conflict.resumeMultipartUpload).not.toHaveBeenCalled();
  });
  it("recovers an already-completed source object without completing multipart twice", async () => {
    const upload = {
      id: "upload",
      video_id: "video",
      expected_size: 4,
      state: "completing",
      object_key: "videos/video/source/source",
      multipart_id: "multipart",
    };
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        const statement = {
          bind: () => statement,
          first: async () =>
            sql.includes("FROM uploads") ? upload : { id: "video" },
        };
        return statement;
      },
      batch: vi.fn(async () => []),
    };
    const resumeMultipartUpload = vi.fn();
    const start = vi.fn();
    const env = {
      DB: db,
      MEDIA: {
        head: vi.fn(async () => ({
          size: 4,
          etag: "source-etag",
          customMetadata: { upload_id: "upload" },
        })),
        resumeMultipartUpload,
      },
      PROCESSOR: { get: start },
    } as unknown as Env;
    expect((await completeUpload(env, "upload")).status).toBe(200);
    expect(resumeMultipartUpload).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(statements.some((sql) => /INSERT INTO videos/.test(sql))).toBe(
      false,
    );
  });
});
