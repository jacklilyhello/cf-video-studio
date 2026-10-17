import { afterEach, describe, expect, it, vi } from "vitest";
import { visitor, visitorIdentity } from "../src/auth";
import { getHistory, saveHistory } from "../src/history";
import { sha256 } from "../src/http";
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
const origin = "https://history-test.example";
interface Snapshot {
  items: unknown[];
  cookieEnabled: boolean;
  writeContext: string | null;
}
function request(
  method: string,
  cookie = "",
  payload?: string,
  hostOrigin = origin,
) {
  return new Request(`${hostOrigin}/api/history`, {
    method,
    headers: {
      Origin: hostOrigin,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: payload,
  });
}
function event(writeContext: unknown, overrides = {}) {
  return JSON.stringify({
    videoId: "video",
    timelineId: "timeline",
    eventId: "event-a",
    eventAt: Date.now(),
    position: 20,
    playedSeconds: 20,
    writeContext,
    ...overrides,
  });
}
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
    "INSERT INTO videos(id,title,source_revision,source_name,status,published,current_version_id,created_at,updated_at) VALUES('video','Fixture','source','fixture.mp4','ready',1,'version',1,1)",
  );
  native.exec(
    "INSERT INTO versions(id,video_id,prefix,state,mode,quality,duration,timeline_id,created_at) VALUES('version','video','videos/video/versions/version/','verified','probe-remux','source',40,'timeline',1)",
  );
  const prepare = vi.fn((sql: string) => {
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
        return {
          success: true,
          meta: { changes: Number(prepared.run(...values).changes) },
        };
      },
    };
    return statement;
  });
  const env = {
    DB: { prepare },
    APP_ENV: "test",
    SESSION_SECRET:
      "test-only-history-binding-session-secret-over-32-characters",
    COORDINATOR: {
      idFromName: () => "admission",
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
    },
  } as unknown as Env;
  async function snapshot(cookie = "", hostOrigin = origin) {
    return (await (
      await getHistory(request("GET", cookie, undefined, hostOrigin), env)
    ).json()) as Snapshot;
  }
  async function issue(hostOrigin = origin) {
    const response = await visitorIdentity(
      request("POST", "", "{}", hostOrigin),
      env,
    );
    expect(await response.json()).toEqual({ identityIssued: true });
    const cookie = response.headers.get("Set-Cookie")!.split(";")[0];
    return {
      cookie,
      context: (await snapshot(cookie, hostOrigin)).writeContext!,
    };
  }
  return { native, env, prepare, snapshot, issue };
}
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("history event identity binding with actual SQLite", () => {
  it("rejects an immutable event after an acknowledged-unknown A write is retried with a new B Cookie", async () => {
    const s = setup();
    const a = await s.issue();
    const payload = event(a.context);
    // D1 committed; the caller never received its acknowledgement.
    await saveHistory(request("POST", a.cookie, payload), s.env);
    const before = s.native.prepare("SELECT * FROM watch_history").get();
    // Clearing the browser Cookie and accepting identity again creates B.
    const b = await s.issue();
    expect(a.context === b.context).toBe(false);
    expect((await s.snapshot(b.cookie)).items).toHaveLength(0);
    s.prepare.mockClear();
    await expect(
      saveHistory(request("POST", b.cookie, payload), s.env),
    ).rejects.toMatchObject({ status: 409, code: "history_identity_changed" });
    expect(s.prepare).not.toHaveBeenCalled();
    expect((await s.snapshot(b.cookie)).items).toHaveLength(0);
    expect(
      JSON.stringify(s.native.prepare("SELECT * FROM watch_history").get()) ===
        JSON.stringify(before),
    ).toBe(true);
    expect((await s.snapshot(a.cookie)).items).toHaveLength(1);

    await saveHistory(
      request(
        "POST",
        b.cookie,
        event(b.context, { eventId: "event-b", position: 1, playedSeconds: 1 }),
      ),
      s.env,
    );
    expect((await s.snapshot(b.cookie)).items).toMatchObject([{ position: 1 }]);
    expect(
      s.native.prepare("SELECT COUNT(*) AS n FROM watch_history").get()?.n,
    ).toBe(2);
    expect(
      s.native
        .prepare(
          "SELECT played_seconds FROM watch_history ORDER BY played_seconds",
        )
        .all(),
    ).toEqual([{ played_seconds: 1 }, { played_seconds: 20 }]);
  });

  it("keeps the same Cookie's context stable and its lost-ACK retry idempotent", async () => {
    const s = setup();
    const a = await s.issue();
    const payload = event(a.context);
    await saveHistory(request("POST", a.cookie, payload), s.env);
    expect((await s.snapshot(a.cookie)).writeContext === a.context).toBe(true);
    const identity = await visitorIdentity(
      request("POST", a.cookie, "{}"),
      s.env,
    );
    expect(await identity.json()).toEqual({ identityIssued: true });
    expect(identity.headers.has("Set-Cookie")).toBe(false);
    await saveHistory(request("POST", a.cookie, payload), s.env);
    expect(
      s.native
        .prepare(
          "SELECT COUNT(*) AS n,MAX(played_seconds) AS played FROM watch_history",
        )
        .get(),
    ).toEqual({ n: 1, played: 20 });
  });

  it.each([undefined, null, "", "f".repeat(64), 42, { context: "invalid" }])(
    "rejects missing or invalid event context without accessing D1 (%j)",
    async (context) => {
      const s = setup();
      const a = await s.issue();
      s.prepare.mockClear();
      await expect(
        saveHistory(request("POST", a.cookie, event(context)), s.env),
      ).rejects.toMatchObject({
        status: 409,
        code: "history_identity_changed",
      });
      expect(s.prepare).not.toHaveBeenCalled();
      expect(
        s.native.prepare("SELECT COUNT(*) AS n FROM watch_history").get()?.n,
      ).toBe(0);
    },
  );

  it("never lets an event context replace a missing or invalid Cookie", async () => {
    const s = setup();
    const a = await s.issue();
    for (const cookie of ["", `${a.cookie}tampered`]) {
      s.prepare.mockClear();
      await expect(
        saveHistory(request("POST", cookie, event(a.context)), s.env),
      ).rejects.toMatchObject({ status: 409, code: "cookies_required" });
      expect(s.prepare).not.toHaveBeenCalled();
      expect(await s.snapshot(cookie)).toEqual({
        items: [],
        cookieEnabled: false,
        writeContext: null,
      });
    }
  });

  it("rejects both transplanted Cookies and another host's context", async () => {
    const s = setup();
    const a = await s.issue();
    const otherOrigin = "https://other-history.example";
    const b = await s.issue(otherOrigin);
    expect(a.context === b.context).toBe(false);
    await expect(
      saveHistory(
        request("POST", a.cookie, event(a.context), otherOrigin),
        s.env,
      ),
    ).rejects.toMatchObject({ status: 409, code: "cookies_required" });
    s.prepare.mockClear();
    await expect(
      saveHistory(
        request("POST", b.cookie, event(a.context), otherOrigin),
        s.env,
      ),
    ).rejects.toMatchObject({ status: 409, code: "history_identity_changed" });
    expect(s.prepare).not.toHaveBeenCalled();
    await saveHistory(
      request("POST", b.cookie, event(b.context), otherOrigin),
      s.env,
    );
    expect((await s.snapshot(a.cookie)).items).toHaveLength(0);
    expect((await s.snapshot(b.cookie, otherOrigin)).items).toHaveLength(1);
  });

  it("uses the specified HMAC purpose without exposing Cookie or database identity in GET", async () => {
    const s = setup();
    const a = await s.issue();
    const identity = await visitor(request("GET", a.cookie), s.env);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(s.env.SESSION_SECRET!),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const bytes = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        `history-write:${new URL(origin).host}:${identity}`,
      ),
    );
    const expected = [...new Uint8Array(bytes)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const snapshot = await s.snapshot(a.cookie);
    expect(snapshot.writeContext === expected).toBe(true);
    expect(snapshot.writeContext === identity).toBe(false);
    expect(snapshot.writeContext === a.cookie.split(".").at(-1)).toBe(false);
    expect(snapshot.writeContext === (await sha256(a.cookie))).toBe(false);
    expect(Object.keys(snapshot).sort()).toEqual([
      "cookieEnabled",
      "items",
      "writeContext",
    ]);
    expect(snapshot.cookieEnabled).toBe(true);
  });
});
