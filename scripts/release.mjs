import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import {
  loadDeploymentConfig,
  resolveDeploymentConfig,
  writeDeploymentConfig,
  readDeploymentApi,
} from "./deployment-config.mjs";
import {
  parseReleaseHealthOrigin,
  validateProductionIsolation,
  validateRuntimeSettings,
  verifiedDuplicateRelease,
  waitForRelease,
} from "./release-checks.mjs";
import { acquireReleaseFence, releaseOwnedFence } from "./release-fence.mjs";
const environment = process.argv[2];
if (!["test", "production"].includes(environment))
  throw new Error("Choose test or production");
if (
  environment === "production" &&
  process.env.PRODUCTION_RELEASE_AUTHORIZED !== "true"
)
  throw new Error(
    "First production release requires explicit authorization and prepared bindings",
  );
let config = loadDeploymentConfig();
if (process.env.CF_VIDEO_WORKER_NAME && config.env?.[environment])
  config.env[environment].name = process.env.CF_VIDEO_WORKER_NAME;
const healthOrigin =
  process.env.RELEASE_HEALTH_ORIGIN === undefined
    ? undefined
    : parseReleaseHealthOrigin(process.env.RELEASE_HEALTH_ORIGIN);
if (environment === "production" && !healthOrigin)
  throw new Error("Production releases require an explicit RELEASE_HEALTH_ORIGIN");
// Reject missing/shared production resources before any remote read or write.
if (environment === "production" || config.env?.production !== undefined)
  validateProductionIsolation(config);
config = await resolveDeploymentConfig(config, environment, {
  read: readDeploymentApi,
});
// Recheck after any explicit Worker-name override and resource discovery.
if (environment === "production" || config.env?.production !== undefined)
  validateProductionIsolation(config);
const generatedConfig = writeDeploymentConfig(config, environment);
const account = config.account_id;
const database = config.env[environment]?.d1_databases?.find(
  (binding) => binding.binding === "DB",
)?.database_id;
const mediaBucket = config.env[environment]?.r2_buckets?.find(
  (binding) => binding.binding === "MEDIA",
)?.bucket_name;
if (!account || !database || !mediaBucket || !process.env.CLOUDFLARE_API_TOKEN)
  throw new Error(
    "Cloudflare Builds deployment credentials/bindings are missing",
  );
async function query(sql) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const result = await response.json();
  if (!response.ok || !result.success || !result.result?.[0]?.success)
    throw new Error(
      "Deployment preflight database query unavailable; deployment stopped",
    );
  return result.result[0].results;
}
// Type verification precedes every Wrangler call: its config-diff output may
// print plaintext variables, so sensitive settings must already be Secrets.
validateRuntimeSettings(
  await readCloudflare(
    `/workers/scripts/${config.env[environment].name}/settings`,
  ),
  environment,
  account,
);
const tables = await query(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'",
);
if (tables.length) {
  const active = await query(
    "SELECT COUNT(*) AS count FROM jobs WHERE state IN ('queued','starting','running','stopping','stop_unverified') OR (started_at IS NOT NULL AND stop_verified=0)",
  );
  if (active[0].count !== 0)
    throw new Error(
      "Active or stop-unverified processing tasks exist; deployment stopped",
    );
}
const revision =
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.WORKERS_CI_COMMIT_SHA ||
  spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
if (!/^[a-f0-9]{40}$/.test(revision))
  throw new Error("Exact deployment commit unavailable");
// Commit identity is a build-time constant, separate from user-managed runtime variables.
writeFileSync(
  "src/build-info.ts",
  `export const BUILD_COMMIT=${JSON.stringify(revision)};\n`,
);
let fenceUntil;
async function acquireFence() {
  ({ fenceUntil } = await acquireReleaseFence({
    query,
    revision,
    worker: config.env[environment].name,
    buildUuid: process.env.WORKERS_CI_BUILD_UUID,
    readBuild: (id) =>
      readCloudflare(`/builds/builds/${encodeURIComponent(id)}`),
    onWait: ({ fenceUntil: until }) =>
      console.log(
        `Another deployment owns the release fence until ${new Date(until).toISOString()}; waiting up to five minutes without taking its lock`,
      ),
  }));
}
async function run(args) {
  // Admission may have waited for another build. Recheck immediately before
  // each Wrangler call so a dashboard change cannot expose newly-Text secrets
  // through Wrangler's configuration-diff output after that wait.
  validateRuntimeSettings(
    await readCloudflare(
      `/workers/scripts/${config.env[environment].name}/settings`,
    ),
    environment,
    account,
  );
  const result = spawnSync(
    "node",
    ["node_modules/wrangler/bin/wrangler.js", ...args, "--config", generatedConfig],
    { stdio: "inherit", env: process.env },
  );
  if (result.status !== 0) throw new Error("Cloudflare release command failed");
}
let fenced = false;
let verified = false;
async function readCloudflare(
  path,
  { signal = AbortSignal.timeout(15000) } = {},
) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
    {
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
      signal,
    },
  );
  const payload = await response.json();
  if (!response.ok || !payload.success)
    throw new Error(
      "Cloudflare release readback unavailable; release fence retained",
    );
  return payload.result;
}
async function verifyRelease() {
  const evidence = await waitForRelease({
    worker: config.env[environment].name,
    environment,
    account,
    revision,
    databaseId: database,
    mediaBucket,
    healthOrigin,
    readCloudflare,
  });
  console.log(JSON.stringify(evidence));
  return evidence;
}

async function duplicateRelease() {
  const evidence = await verifiedDuplicateRelease({
    query,
    expectedMigrations: readdirSync("migrations").filter((name) =>
      name.endsWith(".sql"),
    ),
    worker: config.env[environment].name,
    environment,
    account,
    revision,
    databaseId: database,
    mediaBucket,
    healthOrigin,
    readCloudflare,
  });
  if (!evidence) return false;
  console.log(JSON.stringify(evidence));
  console.log(
    JSON.stringify({
      result: "duplicate_already_deployed",
      commit: revision,
      workerVersion: evidence.workerVersion,
      deploymentSkipped: true,
      migrationsVerified: true,
    }),
  );
  return true;
}

try {
  if (tables.length) {
    await acquireFence();
    fenced = true;
  }
  if (fenced && (await duplicateRelease())) verified = true;
  else {
    await run([
      "d1",
      "migrations",
      "apply",
      "DB",
      "--env",
      environment,
      "--remote",
    ]);
    if (!fenced) {
      await acquireFence();
      fenced = true;
    }
    await run([
      "deploy",
      "--env",
      environment,
      "--keep-vars",
      "--tag",
      revision,
    ]);
    await verifyRelease();
    verified = true;
  }
} finally {
  if (fenced && verified) await releaseOwnedFence(query, fenceUntil);
  else if (fenced)
    console.error(
      "Release incomplete or unverified: processing fence retained until operator reconciliation or expiry",
    );
}
