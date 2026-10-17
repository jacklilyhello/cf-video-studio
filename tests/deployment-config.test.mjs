import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import {
  loadDeploymentConfig,
  resolveDeploymentConfig,
  writeDeploymentConfig,
  readDeploymentApi,
} from "../scripts/deployment-config.mjs";
import viteConfig from "../vite.config.ts";

const temporary = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "cf-video-config-"));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const template = () => ({
  main: "src/index.ts",
  assets: { directory: "dist" },
  env: {
    test: {
      name: "fixture-test",
      d1_databases: [
        {
          binding: "DB",
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: "migrations",
        },
      ],
      r2_buckets: [{ binding: "MEDIA", bucket_name: "placeholder" }],
      containers: [
        {
          images: {
            processor: {
              dockerfile: "container/Dockerfile",
              build_context: ".",
            },
          },
        },
      ],
    },
  },
});
function discovery() {
  return vi.fn(async (path) => {
    if (path === "/accounts?per_page=50") return [{ id: "fixture-account" }];
    if (path.endsWith("/settings"))
      return {
        bindings: [
          { name: "DB", type: "d1", id: "fixture-database" },
          { name: "MEDIA", type: "r2_bucket", bucket_name: "fixture-bucket" },
          {
            name: "COORDINATOR",
            type: "durable_object_namespace",
            namespace_id: "fixture-coordinator",
          },
          {
            name: "PROCESSOR",
            type: "durable_object_namespace",
            namespace_id: "fixture-processor",
          },
          {
            name: "UNRELATED_TEXT",
            type: "plain_text",
            text: "must-never-be-copied",
          },
          { name: "ADMIN_PASSWORD", type: "secret_text" },
        ],
      };
    if (path.endsWith("/workers/scripts"))
      return [{ id: "fixture-test", tag: "fixture-tag" }];
    throw new Error("unexpected discovery path");
  });
}

describe("portable deployment configuration", () => {
  it("discovers existing Builds bindings without copying unrelated runtime variables or mutating the public template", async () => {
    const source = template(),
      read = discovery();
    const result = await resolveDeploymentConfig(source, "test", {
      env: {},
      read,
    });
    expect(source.env.test.d1_databases[0].database_id).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result.account_id).toBe("fixture-account");
    expect(result.env.test.d1_databases[0].database_id).toBe(
      "fixture-database",
    );
    expect(result.env.test.r2_buckets[0].bucket_name).toBe("fixture-bucket");
    expect(result.env.test.vars.RESOURCE_WORKER_TAG).toBe("fixture-tag");
    expect(
      JSON.parse(result.env.test.vars.RESOURCE_DO_NAMESPACES),
    ).toHaveLength(2);
    expect(result.env.test.vars.RESOURCE_DO_NAMESPACES).toBe(
      '[{"id":"fixture-coordinator","name":"COORDINATOR"},{"id":"fixture-processor","name":"PROCESSOR"}]',
    );
    expect(JSON.stringify(result)).not.toContain("must-never-be-copied");
    expect(JSON.stringify(result)).not.toContain("ADMIN_PASSWORD");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("requires explicit account selection for ambiguous credentials and stops before Worker reads", async () => {
    const read = vi.fn(async () => [{ id: "one" }, { id: "two" }]);
    await expect(
      resolveDeploymentConfig(template(), "test", { env: {}, read }),
    ).rejects.toThrow("exactly one account");
    expect(read).toHaveBeenCalledOnce();
  });

  it("honors explicit account and Worker selection and refuses missing target bindings", async () => {
    const read = vi.fn(async () => ({ bindings: [] }));
    await expect(
      resolveDeploymentConfig(template(), "test", {
        env: {
          CLOUDFLARE_ACCOUNT_ID: "own-account",
          CF_VIDEO_WORKER_NAME: "own-worker",
        },
        read,
      }),
    ).rejects.toThrow("could not be verified");
    expect(read).toHaveBeenCalledExactlyOnceWith(
      "/accounts/own-account/workers/scripts/own-worker/settings",
    );
  });

  it("supports an ignored complete config without network discovery and rejects plaintext runtime secrets", async () => {
    const cwd = directory(),
      source = template();
    source.account_id = "own-account";
    source.env.test.d1_databases[0].database_id = "own-database";
    writeFileSync(join(cwd, "private.jsonc"), JSON.stringify(source));
    const read = vi.fn();
    const config = loadDeploymentConfig({
      cwd,
      env: { CF_VIDEO_CONFIG: "private.jsonc" },
    });
    await resolveDeploymentConfig(config, "test", { env: {}, read });
    expect(read).not.toHaveBeenCalled();
    for (const name of [
      "SESSION_SECRET",
      "CF_DEPLOY_API_TOKEN",
      "CF_TOKEN_MANAGER_API_TOKEN",
      "CF_VIDEO_TOKEN_PROVISIONER",
      "CLOUDFLARE_API_TOKEN",
    ]) {
      source.env.test.vars = { [name]: "offline-never-use" };
      writeFileSync(join(cwd, "private.jsonc"), JSON.stringify(source));
      expect(() =>
        loadDeploymentConfig({
          cwd,
          env: { CF_VIDEO_CONFIG: "private.jsonc" },
        }),
      ).toThrow("Cloudflare Secrets");
      expect(() => writeDeploymentConfig(source, "test", { cwd })).toThrow(
        "Cloudflare Secrets",
      );
    }
  });

  it("roots generated source, assets, migrations and Docker context in the checkout", () => {
    const cwd = directory(),
      output = writeDeploymentConfig(template(), "test", { cwd });
    const config = JSON.parse(readFileSync(output, "utf8"));
    expect(output).toBe(join(cwd, ".local/wrangler.generated.test.json"));
    expect(statSync(output).mode & 0o777).toBe(0o600);
    chmodSync(output, 0o644);
    writeDeploymentConfig(template(), "test", { cwd });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(config.main).toBe(join(cwd, "src/index.ts"));
    expect(config.assets.directory).toBe(join(cwd, "dist"));
    expect(config.env.test.d1_databases[0].migrations_dir).toBe(
      join(cwd, "migrations"),
    );
    expect(config.env.test.containers[0].images.processor).toEqual({
      dockerfile: join(cwd, "container/Dockerfile"),
      build_context: cwd,
    });
  });

  it("discovery sends only GET requests and reports no credential or response body on failure", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json(
        { success: false, errors: [{ message: "sensitive-response-body" }] },
        { status: 403 },
      ),
    );
    await expect(
      readDeploymentApi("/accounts", {
        token: "offline-fixture-credential",
        fetchFn,
      }),
    ).rejects.toThrow("discovery unavailable");
    expect(fetchFn.mock.calls[0][1].method).toBeUndefined();
    expect(fetchFn.mock.calls[0][1].redirect).toBe("error");
    const error = await readDeploymentApi("/accounts", {
      token: "offline-fixture-credential",
      fetchFn,
    }).catch((error) => error);
    expect(error.message).not.toMatch(
      /offline-fixture-credential|sensitive-response-body/,
    );
  });
});

it("frontend builds exclude local .env and process VITE_* credentials even if code enumerates import.meta.env", async () => {
  const cwd = directory();
  mkdirSync(join(cwd, "web"));
  writeFileSync(
    join(cwd, "web/index.html"),
    '<script type="module" src="/main.js"></script>',
  );
  writeFileSync(
    join(cwd, "web/main.js"),
    "console.log(import.meta.env, import.meta.env.VITE_TEST_SECRET)",
  );
  writeFileSync(
    join(cwd, "web/.env"),
    "VITE_TEST_SECRET=offline-file-secret-sentinel",
  );
  vi.stubEnv("VITE_TEST_SECRET", "offline-process-secret-sentinel");
  const output = await build({
    ...viteConfig,
    configFile: false,
    root: join(cwd, "web"),
    logLevel: "silent",
    build: { write: false },
  });
  const serialized = JSON.stringify(output);
  expect(serialized).not.toContain("offline-file-secret-sentinel");
  expect(serialized).not.toContain("offline-process-secret-sentinel");
  expect(serialized).not.toContain('"type":"asset","fileName":"main.js.map"');
  expect(viteConfig.build.sourcemap).not.toBe(true);
});
