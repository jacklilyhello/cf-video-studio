import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));
import worker from "../src/index";
import {
  validateRuntimeSettings,
  parseReleaseHealthOrigin,
  validateProductionIsolation,
  verifiedDuplicateRelease,
  waitForHealth,
  waitForRelease,
} from "../scripts/release-checks.mjs";
function settings() {
  return {
    bindings: [
      ...["ADMIN_PASSWORD", "SESSION_SECRET", "CF_USAGE_API_TOKEN"].map(
        (name) => ({ name, type: "secret_text" }),
      ),
      { name: "APP_ENV", type: "plain_text", text: "test" },
      { name: "CLOUDFLARE_ACCOUNT_ID", type: "plain_text", text: "account" },
      { name: "PROCESSING_ENABLED", type: "plain_text", text: "false" },
    ],
  };
}
describe("serving version metadata", () => {
  it("reports the actual Worker version without touching processing or storage", async () => {
    const getProcessor = vi.fn();
    const prepare = vi.fn();
    const response = await worker.fetch(
      new Request("https://test.example/health"),
      {
        ADMIN_PASSWORD: "test-fixture-password",
        SESSION_SECRET: "test-fixture-session-at-least-32-characters",
        APP_ENV: "test",
        VERSION: {
          id: "serving-version",
          tag: "commit",
          timestamp: "timestamp",
        },
        PROCESSOR: { get: getProcessor },
        DB: { prepare },
      },
      {},
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: true,
      versionId: "serving-version",
    });
    expect(getProcessor).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
});
describe("runtime secret preflight", () => {
  it("rejects each sensitive Text variable without disclosing its value", () => {
    for (const name of [
      "ADMIN_PASSWORD",
      "SESSION_SECRET",
      "CF_USAGE_API_TOKEN",
    ]) {
      const input = settings();
      Object.assign(
        input.bindings.find((b) => b.name === name),
        { type: "plain_text", text: "sensitive-fixture-value" },
      );
      let message = "";
      try {
        validateRuntimeSettings(input, "test", "account");
      } catch (error) {
        message = error.message;
      }
      expect(message).toContain(name);
      expect(message).toContain("Cloudflare Secret");
      expect(message).not.toContain("sensitive-fixture-value");
    }
  });
  it("requires complete bindings and exact environment/account", () => {
    expect(() =>
      validateRuntimeSettings(settings(), "test", "account"),
    ).not.toThrow();
    expect(() =>
      validateRuntimeSettings(settings(), "production", "account"),
    ).toThrow("mismatch");
    expect(() => validateRuntimeSettings(settings(), "test", "other")).toThrow(
      "mismatch",
    );
    const input = settings();
    input.bindings = input.bindings.filter((b) => b.name !== "SESSION_SECRET");
    expect(() => validateRuntimeSettings(input, "test", "account")).toThrow(
      "Cloudflare Secret",
    );
  });
});
describe("release edge convergence", () => {
  it("rejects the same commit served by a different Worker version", async () => {
    let time = 0;
    await expect(
      waitForHealth("https://test.example", "expected", "current", {
        fetchFn: async () =>
          Response.json({
            buildCommit: "expected",
            versionId: "other",
            configured: true,
          }),
        now: () => time,
        pause: async (ms) => {
          time += ms;
        },
        timeoutMs: 4000,
      }),
    ).rejects.toThrow("fence retained");
  });
  it("waits for the exact serving commit and configured runtime after a stale edge", async () => {
    let time = 0;
    const pause = vi.fn(async (ms) => {
      time += ms;
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          buildCommit: "old",
          versionId: "serving",
          configured: true,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          buildCommit: "expected",
          versionId: "serving",
          configured: false,
        }),
      )
      .mockResolvedValue(
        Response.json({
          buildCommit: "expected",
          versionId: "serving",
          configured: true,
        }),
      );
    await waitForHealth("https://test.example", "expected", "serving", {
      fetchFn,
      now: () => time,
      pause,
      timeoutMs: 10000,
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledTimes(2);
  });
  it("times out safely when the serving commit never matches", async () => {
    let time = 0;
    const fetchFn = vi.fn(async () =>
      Response.json({
        buildCommit: "old",
        versionId: "serving",
        configured: true,
      }),
    );
    await expect(
      waitForHealth("https://test.example", "expected", "serving", {
        fetchFn,
        now: () => time,
        pause: async (ms) => {
          time += ms;
        },
        timeoutMs: 4000,
      }),
    ).rejects.toThrow("fence retained");
    expect(time).toBe(4000);
  });
});

function releaseFixture() {
  let time = 0;
  const resourceBindings = [
    { name: "DB", type: "d1", id: "database" },
    { name: "MEDIA", type: "r2_bucket", bucket_name: "bucket" },
    {
      name: "PROCESSOR",
      type: "durable_object_namespace",
      class_name: "Processor",
      namespace_id: "processor-namespace",
    },
    {
      name: "COORDINATOR",
      type: "durable_object_namespace",
      class_name: "Coordinator",
      namespace_id: "coordinator-namespace",
    },
    { name: "VERSION", type: "version_metadata" },
  ];
  const runtimeSettings = settings();
  runtimeSettings.bindings.push(...resourceBindings);
  const fixture = {
    active: "current",
    runtimeSettings,
    resourceBindings,
    app: {
      id: "processor-namespace",
      durable_objects: { namespace_id: "processor-namespace" },
      name: "processor-app",
      scheduling_policy: "durable_object",
      health: { instances: { active: 0, starting: 0 } },
    },
    tag: "expected",
    readMilliseconds: 0,
    accountSubdomain: "fixture",
    workerAvailability: { enabled: true, previews_enabled: false },
    domains: [
      {
        id: "domain",
        hostname: "staging.example",
        service: "worker",
        environment: "production",
        enabled: true,
      },
    ],
  };
  const readCloudflare = vi.fn(async (path) => {
    time += fixture.readMilliseconds;
    if (path.endsWith("/deployments"))
      return {
        deployments: [
          { versions: [{ version_id: fixture.active, percentage: 100 }] },
        ],
      };
    if (path.includes("/versions/")) {
      const versionId = path.split("/").at(-1);
      return {
        id: versionId,
        annotations: { "workers/tag": fixture.tag },
        resources: {
          bindings: fixture.resourceBindings,
          script_runtime: {
            containers: [
              {
                class_name: "Processor",
                name: "processor-app",
                images: {
                  processor: `registry.example/image@sha256:${(versionId === "old" ? "a" : "b").repeat(64)}`,
                },
              },
            ],
          },
        },
      };
    }
    if (path.includes("/containers/")) return fixture.app;
    if (path.endsWith("/settings")) return fixture.runtimeSettings;
    if (path === "/workers/subdomain")
      return { subdomain: fixture.accountSubdomain };
    if (path.endsWith("/subdomain")) return fixture.workerAvailability;
    if (path.startsWith("/workers/domains?")) return fixture.domains;
    throw new Error("Unexpected fixture read");
  });
  const fetchFn = vi.fn(async () =>
    Response.json({
      buildCommit: "expected",
      versionId: fixture.active,
      configured: true,
    }),
  );
  return {
    fixture,
    readCloudflare,
    fetchFn,
    options: {
      worker: "worker",
      environment: "test",
      account: "account",
      revision: "expected",
      databaseId: "database",
      mediaBucket: "bucket",
      readCloudflare,
      fetchFn,
      now: () => time,
      pause: async (ms) => {
        time += ms;
      },
      timeoutMs: 8000,
    },
    time: () => time,
  };
}

describe("verified same-commit duplicate release", () => {
  function duplicateFixture() {
    const f = releaseFixture();
    f.options.query = vi.fn(async () => [
      { name: "0001_initial.sql" },
      { name: "0002_example.sql" },
    ]);
    f.options.expectedMigrations = ["0001_initial.sql", "0002_example.sql"];
    return f;
  }

  it("only returns duplicate proof after matching migrations, health, bindings and prepared image", async () => {
    const f = duplicateFixture();
    const result = await verifiedDuplicateRelease(f.options);
    expect(result).toMatchObject({
      commit: "expected",
      workerVersion: "current",
      releaseVerified: true,
    });
    expect(f.options.query).toHaveBeenCalledExactlyOnceWith(
      "SELECT name FROM d1_migrations",
    );
    expect(
      f.readCloudflare.mock.calls.some(([path]) =>
        path.includes("/containers/applications/"),
      ),
    ).toBe(true);
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not call migration/health readback or claim a duplicate for a different commit", async () => {
    const f = duplicateFixture();
    f.fixture.tag = "older";
    expect(await verifiedDuplicateRelease(f.options)).toBeNull();
    expect(f.options.query).not.toHaveBeenCalled();
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it("does not label split traffic as an already complete duplicate", async () => {
    const f = duplicateFixture();
    const original = f.options.readCloudflare;
    f.options.readCloudflare = async (path, ...args) =>
      path.endsWith("/deployments")
        ? {
            deployments: [
              {
                versions: [
                  { version_id: "current", percentage: 50 },
                  { version_id: "old", percentage: 50 },
                ],
              },
            ],
          }
        : original(path, ...args);
    expect(await verifiedDuplicateRelease(f.options)).toBeNull();
    expect(f.options.query).not.toHaveBeenCalled();
  });

  it("rejects same-commit migration gaps instead of skipping migrations", async () => {
    const f = duplicateFixture();
    f.options.query.mockResolvedValue([{ name: "0001_initial.sql" }]);
    await expect(verifiedDuplicateRelease(f.options)).rejects.toThrow(
      "unverified migrations; fence retained",
    );
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it.each(["secret", "resource", "container", "health"])(
    "propagates failed same-commit %s proof instead of reporting duplicate success",
    async (proof) => {
      const f = duplicateFixture();
      if (proof === "secret")
        f.fixture.runtimeSettings.bindings[0].type = "plain_text";
      if (proof === "resource") f.fixture.resourceBindings[0].id = "wrong-db";
      if (proof === "container") f.fixture.app.health.instances.active = 1;
      if (proof === "health")
        f.fetchFn.mockResolvedValue(Response.json({ configured: false }));
      await expect(verifiedDuplicateRelease(f.options)).rejects.toThrow(
        "fence retained",
      );
    },
  );

  it("propagates the candidate API failure without converting it into a deployment or duplicate result", async () => {
    const f = duplicateFixture();
    f.options.readCloudflare = vi.fn(async () => {
      throw new Error("readback unavailable");
    });
    await expect(verifiedDuplicateRelease(f.options)).rejects.toThrow(
      "readback unavailable",
    );
    expect(f.options.query).not.toHaveBeenCalled();
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
});

describe("single-version release evidence", () => {
  it("rereads an old control-plane snapshot without combining its image with new health", async () => {
    const { fixture, options, fetchFn, readCloudflare } = releaseFixture();
    fixture.active = "old";
    fetchFn.mockImplementationOnce(async () => {
      fixture.active = "current";
      return Response.json({
        buildCommit: "expected",
        versionId: "current",
        configured: true,
      });
    });
    const evidence = await waitForRelease(options);
    expect(evidence.workerVersion).toBe("current");
    expect(evidence.preparedImage).toContain("b".repeat(64));
    expect(
      readCloudflare.mock.calls
        .filter(([path]) => path.includes("/versions/"))
        .map(([path]) => path.split("/").at(-1)),
    ).toEqual(["old", "current"]);
  });

  it("discards an attempt if another version becomes active after matching health", async () => {
    const { fixture, options, fetchFn } = releaseFixture();
    fixture.active = "old";
    fetchFn.mockImplementationOnce(async () => {
      fixture.active = "current";
      return Response.json({
        buildCommit: "expected",
        versionId: "old",
        configured: true,
      });
    });
    const evidence = await waitForRelease(options);
    expect(evidence.workerVersion).toBe("current");
    expect(evidence.preparedImage).toContain("b".repeat(64));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retains the fence when the active version tag does not match the release commit", async () => {
    const { fixture, options, fetchFn } = releaseFixture();
    fixture.tag = "other-commit";
    await expect(waitForRelease(options)).rejects.toThrow("fence retained");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(["active", "starting"])(
    "does not verify release while a Container is %s",
    async (state) => {
      const { fixture, options, fetchFn } = releaseFixture();
      fixture.app.health.instances[state] = 1;
      await expect(waitForRelease(options)).rejects.toThrow("fence retained");
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["active", undefined],
    ["starting", undefined],
    ["active", null],
    ["active", Infinity],
    ["starting", -1],
    ["starting", "0"],
    ["active", NaN],
  ])(
    "keeps unknown or invalid Container %s counts unverified (%s)",
    async (state, count) => {
      const { fixture, options, fetchFn } = releaseFixture();
      fixture.app.health.instances[state] = count;
      await expect(waitForRelease(options)).rejects.toThrow("fence retained");
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("does not infer idle state from missing Container health metadata", async () => {
    const { fixture, options, fetchFn } = releaseFixture();
    delete fixture.app.health;
    await expect(waitForRelease(options)).rejects.toThrow("fence retained");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(["id", "database_id"])(
    "accepts the D1 %s resource-ID shape in both interfaces",
    async (field) => {
      const { fixture, options } = releaseFixture();
      const binding = { name: "DB", type: "d1", [field]: "database" };
      fixture.resourceBindings = fixture.resourceBindings.map((b) =>
        b.name === "DB" ? binding : b,
      );
      fixture.runtimeSettings.bindings = fixture.runtimeSettings.bindings.map(
        (b) => (b.name === "DB" ? binding : b),
      );
      await expect(waitForRelease(options)).resolves.toMatchObject({
        releaseVerified: true,
      });
    },
  );

  it("rejects disagreeing D1 resource-ID aliases", async () => {
    const { fixture, options, fetchFn } = releaseFixture();
    fixture.runtimeSettings.bindings = fixture.runtimeSettings.bindings.map(
      (binding) =>
        binding.name === "DB"
          ? { ...binding, database_id: "different-database" }
          : binding,
    );
    await expect(waitForRelease(options)).rejects.toThrow("fence retained");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(["DB", "MEDIA", "PROCESSOR", "COORDINATOR", "VERSION"])(
    "rejects a mismatched runtime %s resource binding",
    async (name) => {
      const { fixture, options, fetchFn } = releaseFixture();
      fixture.runtimeSettings.bindings = fixture.runtimeSettings.bindings.map(
        (binding) =>
          binding.name === name ? { ...binding, type: "wrong_type" } : binding,
      );
      await expect(waitForRelease(options)).rejects.toThrow("fence retained");
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["DB", "id"],
    ["MEDIA", "bucket_name"],
    ["PROCESSOR", "namespace_id"],
    ["COORDINATOR", "namespace_id"],
  ])(
    "rejects runtime %s pointing at another resource with the correct type",
    async (name, field) => {
      const { fixture, options, fetchFn } = releaseFixture();
      fixture.runtimeSettings.bindings = fixture.runtimeSettings.bindings.map(
        (binding) =>
          binding.name === name
            ? { ...binding, [field]: "other-resource" }
            : binding,
      );
      await expect(waitForRelease(options)).rejects.toThrow("fence retained");
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("rejects an application associated with another Durable Object namespace", async () => {
    const { fixture, options, fetchFn } = releaseFixture();
    fixture.app.durable_objects.namespace_id = "other-namespace";
    await expect(waitForRelease(options)).rejects.toThrow("fence retained");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("uses one timeout budget for all API reads and health attempts", async () => {
    const { fixture, options, fetchFn, readCloudflare, time } =
      releaseFixture();
    fixture.readMilliseconds = 1000;
    options.timeoutMs = 4000;
    await expect(waitForRelease(options)).rejects.toThrow("fence retained");
    expect(time()).toBe(4000);
    expect(readCloudflare).toHaveBeenCalledTimes(4);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("release health origin ownership", () => {
  it.each([
    "http://staging.example",
    "https://user:private@staging.example",
    "https://staging.example:443",
    "https://staging.example:8443",
    "https://staging.example/health",
    "https://staging.example/./",
    "https://staging.example?token=private",
    "https://staging.example?",
    "https://staging.example#private",
    "https://staging.example#",
    "https://staging.example\\",
    "https://staging.example.",
    "https://127.0.0.1",
    "https://[::1]",
    "https://localhost",
    "https://bad_label.example",
    "https://%73taging.example",
    " https://staging.example",
    "",
  ])(
    "rejects a non-origin URL without any remote access (%s)",
    async (origin) => {
      const { options, readCloudflare, fetchFn } = releaseFixture();
      await expect(
        waitForRelease({ ...options, healthOrigin: origin }),
      ).rejects.toThrow("canonical HTTPS DNS origin");
      expect(readCloudflare).not.toHaveBeenCalled();
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("accepts and normalizes an optional root slash", () => {
    expect(parseReleaseHealthOrigin("https://staging.example/")).toBe(
      "https://staging.example",
    );
  });

  it("verifies the default test workers.dev entry before health and again after it", async () => {
    const { options, readCloudflare, fetchFn } = releaseFixture();
    const evidence = await waitForRelease(options);
    expect(evidence.healthOrigin).toBe("https://worker.fixture.workers.dev");
    expect(fetchFn.mock.calls[0][0]).toMatch(
      /^https:\/\/worker\.fixture\.workers\.dev\/health\?/,
    );
    expect(fetchFn.mock.calls[0][1].redirect).toBe("error");
    expect(
      readCloudflare.mock.calls.filter(
        ([path]) => path === "/workers/scripts/worker/subdomain",
      ),
    ).toHaveLength(2);
  });

  it.each([false, undefined, "true", 1])(
    "does not use a workers.dev hostname without explicit enabled=true (%s)",
    async (enabled) => {
      const { options, fixture, fetchFn } = releaseFixture();
      fixture.workerAvailability = { enabled, previews_enabled: true };
      await expect(waitForRelease(options)).rejects.toThrow("fence retained");
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it.each(["fixture.evil.example", "bad_label", "-bad", "bad-", "", null])(
    "rejects malformed account subdomain metadata (%s)",
    async (subdomain) => {
      const { options, fixture, fetchFn } = releaseFixture();
      fixture.accountSubdomain = subdomain;
      await expect(waitForRelease(options)).rejects.toThrow("fence retained");
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://other.fixture.workers.dev",
    "https://worker.other.workers.dev",
    "https://preview-worker.fixture.workers.dev",
    "https://extra.worker.fixture.workers.dev",
  ])("rejects another or preview workers.dev origin (%s)", async (origin) => {
    const { options, fetchFn } = releaseFixture();
    await expect(
      waitForRelease({ ...options, healthOrigin: origin }),
    ).rejects.toThrow("fence retained");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("allows an independent production Worker to verify workers.dev before formal-domain cutover", async () => {
    const { options, fixture, fetchFn } = releaseFixture();
    fixture.runtimeSettings.bindings.find((b) => b.name === "APP_ENV").text =
      "production";
    await expect(
      waitForRelease({
        ...options,
        environment: "production",
        healthOrigin: "https://worker.fixture.workers.dev",
      }),
    ).resolves.toMatchObject({
      releaseVerified: true,
      healthOrigin: "https://worker.fixture.workers.dev",
    });
    expect(fetchFn.mock.calls[0][0]).toContain("worker.fixture.workers.dev");
  });

  it("requires a positive exact custom-domain mapping with a documented filtered lookup", async () => {
    const { options, readCloudflare } = releaseFixture();
    await expect(
      waitForRelease({ ...options, healthOrigin: "https://staging.example" }),
    ).resolves.toMatchObject({
      releaseVerified: true,
      healthOrigin: "https://staging.example",
    });
    const lookups = readCloudflare.mock.calls.filter(([path]) =>
      path.startsWith("/workers/domains?"),
    );
    expect(lookups).toHaveLength(2);
    expect(
      Object.fromEntries(
        new URL(lookups[0][0], "https://api.fixture").searchParams,
      ),
    ).toEqual({
      hostname: "staging.example",
      service: "worker",
      environment: "production",
      enabled: "true",
    });
  });

  it.each([
    { service: "other-worker" },
    { hostname: "other.example" },
    { environment: "staging" },
    { enabled: false },
    { enabled: undefined },
    { enabled: "true" },
    { id: undefined },
  ])("rejects incomplete or unrelated domain mapping (%s)", async (change) => {
    const { options, fixture, fetchFn } = releaseFixture();
    Object.assign(fixture.domains[0], change);
    await expect(
      waitForRelease({ ...options, healthOrigin: "https://staging.example" }),
    ).rejects.toThrow("fence retained");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([[], [{}, {}], null, { result: [] }])(
    "does not infer custom-domain ownership from empty or ambiguous records (%s)",
    async (domains) => {
      const { options, fixture, fetchFn } = releaseFixture();
      fixture.domains = domains;
      await expect(
        waitForRelease({ ...options, healthOrigin: "https://staging.example" }),
      ).rejects.toThrow("fence retained");
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("requires an explicit production health origin without contacting an unrelated default domain", async () => {
    const { options, fixture, fetchFn } = releaseFixture();
    fixture.runtimeSettings.bindings.find((b) => b.name === "APP_ENV").text =
      "production";
    await expect(waitForRelease({ ...options, environment: "production" })).rejects.toThrow("fence retained");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not retain matching health when its domain is reassigned during the request", async () => {
    const { options, fixture, fetchFn } = releaseFixture();
    fetchFn.mockImplementation(async () => {
      fixture.domains[0].service = "other-worker";
      return Response.json({
        buildCommit: "expected",
        versionId: fixture.active,
        configured: true,
      });
    });
    await expect(
      waitForRelease({ ...options, healthOrigin: "https://staging.example" }),
    ).rejects.toThrow("fence retained");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("rejects followed redirects even if the returned health payload matches", async () => {
    const { options, fetchFn } = releaseFixture();
    fetchFn.mockImplementation(async () => {
      const response = Response.json({
        buildCommit: "expected",
        versionId: "current",
        configured: true,
      });
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    });
    await expect(waitForRelease(options)).rejects.toThrow("fence retained");
    expect(
      fetchFn.mock.calls.every(([, init]) => init.redirect === "error"),
    ).toBe(true);
  });

  it("rejects final active-version evidence that arrives after the shared deadline", async () => {
    const { options, fixture } = releaseFixture();
    let time = 0;
    let deployments = 0;
    const read = options.readCloudflare;
    options.now = () => time;
    options.pause = async (ms) => {
      time += ms;
    };
    options.timeoutMs = 100;
    options.readCloudflare = async (path, init) => {
      const result = await read(path, init);
      if (path.endsWith("/deployments") && ++deployments === 2) time = 150;
      return result;
    };
    await expect(waitForRelease(options)).rejects.toThrow("fence retained");
    expect(fixture.active).toBe("current");
  });
});

function isolatedConfig() {
  const env = (name, database, bucket) => ({
    name,
    d1_databases: [{ binding: "DB", database_id: database }],
    r2_buckets: [{ binding: "MEDIA", bucket_name: bucket }],
    durable_objects: {
      bindings: [
        { name: "COORDINATOR", class_name: "Coordinator" },
        { name: "PROCESSOR", class_name: "Processor" },
      ],
    },
  });
  return {
    account_id: "fixture-account",
    env: {
      test: env(
        "cf-video-hub-test",
        "11111111-1111-4111-8111-111111111111",
        "cf-video-hub-test",
      ),
      production: env(
        "cf-video-hub-production",
        "22222222-2222-4222-8222-222222222222",
        "cf-video-hub-production",
      ),
    },
  };
}

function releaseEntry(config, authorized = true, environment = "production") {
  const directory = mkdtempSync(join(tmpdir(), "cf-video-release-preflight-"));
  try {
    writeFileSync(join(directory, "wrangler.jsonc"), JSON.stringify(config));
    const url = new URL("../scripts/release.mjs", import.meta.url).href;
    return spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `process.argv[2]=${JSON.stringify(environment)};globalThis.fetch=async()=>{throw new Error('UNEXPECTED_REMOTE_READ')};await import(${JSON.stringify(url)});`,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 5000,
        env: {
          PATH: process.env.PATH,
          CLOUDFLARE_API_TOKEN: "offline-fixture-token",
          RELEASE_HEALTH_ORIGIN: "https://worker.fixture.workers.dev",
          ...(authorized ? { PRODUCTION_RELEASE_AUTHORIZED: "true" } : {}),
        },
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("production configuration isolation precedes every remote operation", () => {
  it("accepts explicit independent resources and local Durable Objects", () => {
    expect(() => validateProductionIsolation(isolatedConfig())).not.toThrow();
  });

  it.each(["worker", "database", "bucket"])(
    "rejects a shared %s in the actual release entry before any remote read or mutation",
    (resource) => {
      const config = isolatedConfig();
      const test = config.env.test;
      const production = config.env.production;
      if (resource === "worker") production.name = test.name;
      if (resource === "database")
        production.d1_databases[0].database_id =
          test.d1_databases[0].database_id;
      if (resource === "bucket")
        production.r2_buckets[0].bucket_name = test.r2_buckets[0].bucket_name;
      const result = releaseEntry(config);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("must be isolated from test");
      expect(result.stderr).not.toContain("UNEXPECTED_REMOTE_READ");
    },
  );

  it.each([
    (config) => delete config.env.test,
    (config) => delete config.env.production,
    (config) => delete config.env.production.name,
    (config) => delete config.env.test.d1_databases[0].database_id,
    (config) =>
      (config.env.production.d1_databases[0].database_id = "CHANGE_ME"),
    (config) => delete config.env.production.r2_buckets[0].bucket_name,
    (config) => (config.env.production.r2_buckets[0].bucket_name = ""),
    (config) =>
      config.env.production.d1_databases.push(
        config.env.production.d1_databases[0],
      ),
    (config) =>
      config.env.production.r2_buckets.push(
        config.env.production.r2_buckets[0],
      ),
  ])("fails closed when isolation cannot be proved (%s)", (mutate) => {
    const config = isolatedConfig();
    mutate(config);
    expect(() => validateProductionIsolation(config)).toThrow(
      "isolation cannot be verified",
    );
  });

  it.each(["database", "bucket"])(
    "also stops test release before remote access when its %s points at production",
    (resource) => {
      const config = isolatedConfig();
      if (resource === "database")
        config.env.test.d1_databases[0].database_id =
          config.env.production.d1_databases[0].database_id;
      else
        config.env.test.r2_buckets[0].bucket_name =
          config.env.production.r2_buckets[0].bucket_name;
      const result = releaseEntry(config, false, "test");
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("must be isolated from test");
      expect(result.stderr).not.toContain("UNEXPECTED_REMOTE_READ");
    },
  );

  it("preserves current test-only release preflight without a production environment", () => {
    const config = isolatedConfig();
    delete config.env.production;
    const result = releaseEntry(config, false, "test");
    expect(result.error).toBeUndefined();
    // The isolated HTTP sentinel is reached only after local preflight; no
    // actual cloud access, database operation or Wrangler process is possible.
    expect(result.stderr).toContain("UNEXPECTED_REMOTE_READ");
    expect(result.stderr).not.toContain("isolation cannot be verified");
  });

  it.each(["test", "production"])(
    "rejects external or unknown %s DO ownership",
    (environment) => {
      for (const change of [
        { script_name: "another-worker" },
        { class_name: "AnotherClass" },
        { environment: "staging" },
      ]) {
        const config = isolatedConfig();
        Object.assign(
          config.env[environment].durable_objects.bindings[0],
          change,
        );
        expect(() => validateProductionIsolation(config)).toThrow(
          "Durable Objects must belong to their own Worker",
        );
      }
    },
  );

  it("does not let an operator health origin replace first-production authorization", () => {
    const result = releaseEntry(isolatedConfig(), false);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "First production release requires explicit authorization",
    );
    expect(result.stderr).not.toContain("UNEXPECTED_REMOTE_READ");
  });
});
