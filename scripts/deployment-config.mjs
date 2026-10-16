import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "jsonc-parser";

const emptyDatabase = "00000000-0000-0000-0000-000000000000";
function rejectCredentialVars(config) {
  for (const section of [config, ...Object.values(config.env || {})]) {
    if (
      Object.keys(section?.vars || {}).some((name) =>
        /PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY/i.test(name),
      )
    )
      throw new Error(
        "Runtime passwords and tokens must be Cloudflare Secrets, never Wrangler vars",
      );
  }
}

export function loadDeploymentConfig({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const errors = [];
  const config = parse(
    readFileSync(resolve(cwd, env.CF_VIDEO_CONFIG || "wrangler.jsonc"), "utf8"),
    errors,
    { allowTrailingComma: true },
  );
  if (errors.length || !config || typeof config !== "object")
    throw new Error("Invalid Wrangler JSONC configuration");
  rejectCredentialVars(config);
  return config;
}

// GET-only discovery lets an existing Workers Builds connection keep its
// bindings after deployment identifiers are removed from the public template.
// It never reads secret values or mutates the running Worker.
export async function resolveDeploymentConfig(
  config,
  environment,
  { env = process.env, read } = {},
) {
  config = structuredClone(config);
  const target = config.env?.[environment];
  if (!target)
    throw new Error(
      "Prepare an isolated Wrangler environment before deployment",
    );
  if (env.CF_VIDEO_WORKER_NAME) target.name = env.CF_VIDEO_WORKER_NAME;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(target.name || ""))
    throw new Error("Deployment Worker name is invalid");
  config.account_id = env.CLOUDFLARE_ACCOUNT_ID || config.account_id;
  if (!config.account_id) {
    const accounts = await read("/accounts?per_page=50");
    if (!Array.isArray(accounts) || accounts.length !== 1 || !accounts[0]?.id)
      throw new Error(
        "Set CLOUDFLARE_ACCOUNT_ID when the deployment token does not identify exactly one account",
      );
    config.account_id = accounts[0].id;
  }
  const resource = (entries, name) => {
    const matches = entries?.filter((item) => item.binding === name);
    if (matches?.length !== 1)
      throw new Error("Exactly one DB and MEDIA binding is required");
    return matches[0];
  };
  const database = resource(target.d1_databases, "DB");
  const bucket = resource(target.r2_buckets, "MEDIA");
  if (!database || !bucket)
    throw new Error("DB and MEDIA bindings are required");
  const needsDiscovery =
    !database.database_id || database.database_id === emptyDatabase;
  if (needsDiscovery) {
    const prefix = `/accounts/${encodeURIComponent(config.account_id)}`;
    const settings = await read(
      `${prefix}/workers/scripts/${encodeURIComponent(target.name)}/settings`,
    );
    const binding = (name, type) => {
      const matches = settings?.bindings?.filter(
        (item) => item.name === name && item.type === type,
      );
      if (matches?.length !== 1)
        throw new Error(
          "Existing Worker resource bindings could not be verified; bootstrap resources or provide CF_VIDEO_CONFIG",
        );
      return matches[0];
    };
    const databaseBinding = binding("DB", "d1");
    if (
      databaseBinding.id &&
      databaseBinding.database_id &&
      databaseBinding.id !== databaseBinding.database_id
    )
      throw new Error("Existing Worker database identity is ambiguous");
    database.database_id = databaseBinding.id ?? databaseBinding.database_id;
    // The binding UUID is authoritative. A copied template database name may
    // belong to a different installation and is unnecessary when an ID exists.
    delete database.database_name;
    bucket.bucket_name = binding("MEDIA", "r2_bucket").bucket_name;
    if (
      !database.database_id ||
      database.database_id === emptyDatabase ||
      !bucket.bucket_name
    )
      throw new Error("Existing Worker DB and MEDIA identities are missing");
    // Copy only resource identifiers. Never serialize other dashboard Text
    // variables, Secrets, headers, credentials or API response bodies.
    const objects = ["COORDINATOR", "PROCESSOR"].flatMap((name) => {
      const item = settings.bindings.find(
        (entry) =>
          entry.name === name && entry.type === "durable_object_namespace",
      );
      return item?.namespace_id ? [{ id: item.namespace_id, name }] : [];
    });
    const scripts = await read(`${prefix}/workers/scripts`);
    const worker =
      Array.isArray(scripts) && scripts.find((item) => item.id === target.name);
    const processor = objects.find((item) => item.name === "PROCESSOR");
    target.vars = {
      ...target.vars,
      RESOURCE_WORKER_NAME: target.name,
      RESOURCE_D1_DATABASE_ID: database.database_id,
      RESOURCE_R2_BUCKET: bucket.bucket_name,
      ...(objects.length
        ? { RESOURCE_DO_NAMESPACES: JSON.stringify(objects) }
        : {}),
      ...(processor ? { RESOURCE_CONTAINER_APPLICATION_ID: processor.id } : {}),
      ...(worker?.tag ? { RESOURCE_WORKER_TAG: worker.tag } : {}),
    };
  }
  return config;
}

export function writeDeploymentConfig(
  config,
  environment,
  { cwd = process.cwd() } = {},
) {
  rejectCredentialVars(config);
  const output = resolve(cwd, `.local/wrangler.generated.${environment}.json`);
  config = structuredClone(config);
  // Wrangler resolves paths against its config directory, including the
  // Container build context. Keep all paths rooted in this checkout.
  if (config.main) config.main = resolve(cwd, config.main);
  if (config.assets?.directory)
    config.assets.directory = resolve(cwd, config.assets.directory);
  for (const section of [config, ...Object.values(config.env || {})]) {
    for (const database of section.d1_databases || [])
      if (database.migrations_dir)
        database.migrations_dir = resolve(cwd, database.migrations_dir);
    for (const container of section.containers || [])
      for (const image of Object.values(container.images || {})) {
        if (image.dockerfile) image.dockerfile = resolve(cwd, image.dockerfile);
        if (image.build_context)
          image.build_context = resolve(cwd, image.build_context);
      }
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(output, 0o600);
  return output;
}

export async function readDeploymentApi(
  path,
  { token = process.env.CLOUDFLARE_API_TOKEN, fetchFn = fetch } = {},
) {
  if (!token)
    throw new Error("CLOUDFLARE_API_TOKEN deployment credential is required");
  let response, payload;
  try {
    response = await fetchFn(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    payload = await response.json();
  } catch {
    throw new Error("Deployment configuration discovery unavailable");
  }
  if (!response.ok || payload.success !== true)
    throw new Error(
      "Deployment configuration discovery unavailable; verify credentials and explicit configuration",
    );
  return payload.result;
}
