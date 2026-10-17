import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  acquireReleaseFence,
  releaseOwnedFence,
  RELEASE_LEASE_MS,
} from "../scripts/release-fence.mjs";

const revision = "a".repeat(40);
const buildUuid = "11111111-1111-4111-8111-111111111111";
const oldBuild = "22222222-2222-4222-8222-222222222222";
function fixture({ until, owner } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE jobs(state TEXT,started_at INTEGER,stop_verified INTEGER);",
  );
  const put = (key, value) =>
    db
      .prepare(
        "INSERT INTO settings VALUES(?,?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, String(value));
  if (until !== undefined) put("deployment_fence_until", until);
  if (owner !== undefined) put("deployment_fence_owner", JSON.stringify(owner));
  let time = 10_000;
  const options = {
    revision,
    worker: "fixture-test",
    buildUuid,
    query: vi.fn(async (sql) => db.prepare(sql).all()),
    readBuild: vi.fn(async (id) => ({
      build_uuid: id,
      status: "stopped",
      build_outcome: "fail",
      build_trigger_metadata: { commit_hash: revision },
    })),
    now: () => time,
    pause: vi.fn(async (ms) => {
      time += ms;
    }),
    timeoutMs: 100,
    pollMs: 20,
    onWait: vi.fn(),
  };
  const get = () =>
    Object.fromEntries(
      db
        .prepare("SELECT key,value FROM settings")
        .all()
        .map((r) => [r.key, r.value]),
    );
  return { db, put, options, get, close: () => db.close() };
}
function expiredOwner(until) {
  return {
    worker: "fixture-test",
    revision,
    buildUuid: oldBuild,
    fenceUntil: until,
  };
}

describe("release fence admission against actual SQLite", () => {
  it.each([undefined, 0])(
    "atomically acquires a missing/clear fence (%s) and records its exact owner",
    async (until) => {
      const f = fixture({ until });
      try {
        const result = await acquireReleaseFence(f.options);
        expect(result).toEqual({
          fenceUntil: 10_000 + RELEASE_LEASE_MS,
          waited: false,
        });
        expect(JSON.parse(f.get().deployment_fence_owner)).toEqual({
          worker: "fixture-test",
          revision,
          buildUuid,
          fenceUntil: result.fenceUntil,
        });
        expect(f.options.readBuild).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );

  it("waits for a live deployment to release without changing its lock", async () => {
    const f = fixture({ until: 20_000 });
    try {
      f.options.pause = vi.fn(async () => {
        expect(f.get().deployment_fence_until).toBe("20000");
        f.put("deployment_fence_until", 0);
      });
      const result = await acquireReleaseFence(f.options);
      expect(result.waited).toBe(true);
      expect(f.options.onWait).toHaveBeenCalledExactlyOnceWith({
        fenceUntil: 20_000,
      });
      expect(f.options.readBuild).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it("stops after bounded contention and does not clear a valid deployment lease", async () => {
    const f = fixture({ until: 20_000 });
    try {
      await expect(acquireReleaseFence(f.options)).rejects.toThrow(
        "bounded waiting",
      );
      expect(f.get().deployment_fence_until).toBe("20000");
      expect(f.options.pause).toHaveBeenCalledTimes(5);
      expect(f.options.onWait).toHaveBeenCalledTimes(1);
      expect(f.options.readBuild).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it.each([
    ["queued", null, 0],
    ["running", 1, 0],
    ["stop_unverified", 1, 0],
    ["complete", 1, 0],
  ])(
    "refuses active or stop-unverified jobs before waiting (%s)",
    async (state, started, stop) => {
      const f = fixture({ until: 20_000 });
      try {
        f.db
          .prepare("INSERT INTO jobs VALUES(?,?,?)")
          .run(state, started, stop);
        await expect(acquireReleaseFence(f.options)).rejects.toThrow(
          "processing tasks exist",
        );
        expect(f.get().deployment_fence_until).toBe("20000");
        expect(f.options.pause).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );

  it("repeats the task guard inside atomic admission after a concurrent task starts", async () => {
    const f = fixture({ until: 0 });
    try {
      const original = f.options.query;
      let inserted = false;
      f.options.query = async (sql) => {
        if (sql.startsWith("INSERT INTO settings") && !inserted) {
          inserted = true;
          f.db.prepare("INSERT INTO jobs VALUES('starting',1,0)").run();
        }
        return original(sql);
      };
      await expect(acquireReleaseFence(f.options)).rejects.toThrow(
        "processing tasks exist",
      );
      expect(f.get().deployment_fence_until).toBe("0");
      expect(f.get().deployment_fence_owner).toBeUndefined();
    } finally {
      f.close();
    }
  });

  it("recovers an expired lease only after its exact owner's terminal build response", async () => {
    const f = fixture({ until: 9000, owner: expiredOwner(9000) });
    try {
      const result = await acquireReleaseFence(f.options);
      expect(result.fenceUntil).toBe(10_000 + RELEASE_LEASE_MS);
      expect(f.options.readBuild).toHaveBeenCalledExactlyOnceWith(oldBuild);
      expect(JSON.parse(f.get().deployment_fence_owner).buildUuid).toBe(
        buildUuid,
      );
    } finally {
      f.close();
    }
  });

  it.each([
    { status: "running", build_outcome: null },
    { status: "queued", build_outcome: null },
    { status: "stopped", build_outcome: null },
    { status: "stopped", build_outcome: "unknown" },
    { build_uuid: buildUuid },
    { build_trigger_metadata: { commit_hash: "b".repeat(40) } },
  ])(
    "never takes an expired but live/unverified owner (%j)",
    async (change) => {
      const f = fixture({ until: 9000, owner: expiredOwner(9000) });
      try {
        f.options.readBuild = vi.fn(async () => ({
          build_uuid: oldBuild,
          status: "stopped",
          build_outcome: "fail",
          build_trigger_metadata: { commit_hash: revision },
          ...change,
        }));
        await expect(acquireReleaseFence(f.options)).rejects.toThrow(
          "still live or unverified",
        );
        expect(f.get().deployment_fence_until).toBe("9000");
      } finally {
        f.close();
      }
    },
  );

  it("retains expired legacy or mismatched metadata instead of guessing abandonment", async () => {
    for (const owner of [
      undefined,
      {},
      { ...expiredOwner(9000), fenceUntil: 8000 },
      { ...expiredOwner(9000), worker: "other-worker" },
    ]) {
      const f = fixture({ until: 9000, owner });
      try {
        await expect(acquireReleaseFence(f.options)).rejects.toThrow(
          "no verifiable build owner",
        );
        expect(f.get().deployment_fence_until).toBe("9000");
        expect(f.options.readBuild).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    }
  });

  it("sanitizes owner lookup failure and retains the lease", async () => {
    const f = fixture({ until: 9000, owner: expiredOwner(9000) });
    try {
      f.options.readBuild = vi.fn(async () => {
        throw new Error("private-upstream-body");
      });
      await expect(acquireReleaseFence(f.options)).rejects.toThrow(
        "owner could not be checked; fence retained",
      );
      expect(f.get().deployment_fence_until).toBe("9000");
    } finally {
      f.close();
    }
  });

  it.each(["invalid", "01", "-1", "1.5", "9007199254740992"])(
    "rejects a malformed lease instead of CAST-coercing it (%s)",
    async (until) => {
      const f = fixture({ until });
      try {
        await expect(acquireReleaseFence(f.options)).rejects.toThrow(
          "fence value is invalid",
        );
        expect(f.get().deployment_fence_until).toBe(until);
      } finally {
        f.close();
      }
    },
  );

  it("only releases its own exact numeric fence after verification", async () => {
    const f = fixture({ until: 20_000 });
    try {
      await expect(
        releaseOwnedFence(f.options.query, 19_000, f.options.now),
      ).rejects.toThrow("another lock was not cleared");
      expect(f.get().deployment_fence_until).toBe("20000");
      expect(
        await releaseOwnedFence(f.options.query, 20_000, f.options.now),
      ).toHaveLength(1);
      expect(f.get().deployment_fence_until).toBe("0");
    } finally {
      f.close();
    }
  });
});
