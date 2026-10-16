import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));
import worker from "../src/index";
import { login } from "../src/auth";
import type { Env } from "../src/types";

const origin = "https://upload-source-security.example";
function setup() {
  const coordinate = vi.fn(
    async (_input?: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ allowed: true }),
  );
  const database = vi.fn(() => {
    throw new Error("Unexpected database access");
  });
  const storage = vi.fn(() => {
    throw new Error("Unexpected media access");
  });
  const processor = vi.fn(() => {
    throw new Error("Unexpected Container access");
  });
  const env = {
    APP_ENV: "test",
    ADMIN_PASSWORD: "offline-test-admin-password",
    SESSION_SECRET: "offline-test-session-secret-longer-than-32-characters",
    DB: { prepare: database },
    MEDIA: { head: storage, get: storage, createMultipartUpload: storage },
    PROCESSOR: { get: processor },
    COORDINATOR: {
      idFromName: () => "admission",
      get: () => ({ fetch: coordinate }),
    },
  } as unknown as Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
  return { env, ctx, coordinate, database, storage, processor };
}
const endpoints = [
  ["POST", "/api/admin/upload-approvals"],
  ["POST", "/api/admin/upload-approvals/fixture-approval/confirm"],
  ["POST", "/api/admin/uploads"],
  ["GET", "/api/admin/source/fixture-video/check"],
  ["GET", "/api/admin/source/fixture-video/source.mp4"],
  ["HEAD", "/api/admin/source/fixture-video/source.mp4"],
  ["POST", "/api/admin/source/fixture-video/playback-report"],
  ["POST", "/api/admin/videos/fixture-video/source-version"],
] as const;

describe("upload approvals and original preview retain administrator boundaries", () => {
  it.each(endpoints)(
    "rejects anonymous %s %s before storage or coordination",
    async (method, path) => {
      const { env, ctx, coordinate, database, storage, processor } = setup();
      const response = await worker.fetch(
        new Request(origin + path, {
          method,
          headers: { Origin: origin },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
        env,
        ctx,
      );
      expect(response.status).toBe(401);
      expect(coordinate).not.toHaveBeenCalled();
      expect(database).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
      expect(processor).not.toHaveBeenCalled();
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    },
  );

  it.each(endpoints.filter(([method]) => method === "POST"))(
    "rejects foreign-origin %s %s before creating authorization",
    async (method, path) => {
      const { env, ctx, coordinate, database, storage, processor } = setup();
      const response = await worker.fetch(
        new Request(origin + path, {
          method,
          headers: { Origin: "https://foreign.example" },
          body: "{}",
        }),
        env,
        ctx,
      );
      expect(response.status).toBe(403);
      expect(coordinate).not.toHaveBeenCalled();
      expect(database).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
      expect(processor).not.toHaveBeenCalled();
    },
  );

  it("forwards authenticated explicit confirmation through admission without enabling processing", async () => {
    const { env, ctx, coordinate, processor } = setup();
    const authenticated = await login(
      new Request(origin + "/api/admin/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
      }),
      env,
    );
    const cookie = authenticated.headers.get("Set-Cookie")!.split(";")[0];
    coordinate.mockClear();
    let forwarded: Request | undefined;
    let confirmation: unknown;
    coordinate.mockImplementationOnce(async (request) => {
      forwarded = request as unknown as Request;
      confirmation = await forwarded.json();
      return Response.json({
        approval: { id: "fixture-approval", state: "confirmed" },
      });
    });
    const response = await worker.fetch(
      new Request(
        origin + "/api/admin/upload-approvals/fixture-approval/confirm",
        {
          method: "POST",
          headers: {
            Origin: origin,
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ acceptUnknownUsage: true }),
        },
      ),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(coordinate).toHaveBeenCalledOnce();
    expect(forwarded!.url).toBe(
      "https://internal/upload-approvals/fixture-approval/confirm",
    );
    expect(confirmation).toEqual({ acceptUnknownUsage: true });
    expect(processor).not.toHaveBeenCalled();
    expect(env.PROCESSING_ENABLED).not.toBe("true");
  });
});
