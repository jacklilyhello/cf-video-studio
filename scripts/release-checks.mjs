const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateProductionIsolation(config) {
  function resources(environment) {
    const env = config?.env?.[environment];
    const binding = (entries, name, field = "binding") => {
      const matches = Array.isArray(entries)
        ? entries.filter((entry) => entry?.[field] === name)
        : [];
      if (matches.length !== 1)
        throw new Error(
          "Production/test resource isolation cannot be verified",
        );
      return matches[0];
    };
    const worker = env?.name;
    const database = binding(env?.d1_databases, "DB").database_id;
    const bucket = binding(env?.r2_buckets, "MEDIA").bucket_name;
    if (
      typeof worker !== "string" ||
      !dnsLabel.test(worker) ||
      typeof database !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(database) ||
      typeof bucket !== "string" ||
      bucket.length < 3 ||
      !dnsLabel.test(bucket)
    )
      throw new Error("Production/test resource isolation cannot be verified");
    for (const [name, className] of [
      ["COORDINATOR", "Coordinator"],
      ["PROCESSOR", "Processor"],
    ]) {
      const object = binding(env?.durable_objects?.bindings, name, "name");
      if (
        object.class_name !== className ||
        (object.script_name !== undefined && object.script_name !== worker) ||
        object.environment !== undefined
      )
        throw new Error(
          "Production/test Durable Objects must belong to their own Worker",
        );
    }
    return { worker, database: database.toLowerCase(), bucket };
  }
  const test = resources("test");
  const production = resources("production");
  for (const key of ["worker", "database", "bucket"])
    if (test[key] === production[key])
      throw new Error(`Production ${key} must be isolated from test`);
}

export function parseReleaseHealthOrigin(value) {
  let url;
  try {
    if (typeof value !== "string") throw new Error();
    url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (value !== url.origin && value !== `${url.origin}/`) ||
      url.hostname.length > 253 ||
      url.hostname.split(".").length < 2 ||
      !url.hostname.split(".").every((label) => dnsLabel.test(label)) ||
      !/^[a-z]/.test(url.hostname.split(".").at(-1))
    )
      throw new Error();
  } catch {
    throw new Error(
      "Release health origin must be a canonical HTTPS DNS origin",
    );
  }
  return url.origin;
}

export async function verifiedReleaseOrigin({
  worker,
  environment,
  healthOrigin,
  read,
}) {
  if (typeof worker !== "string" || !dnsLabel.test(worker))
    throw new Error("Release Worker name cannot be verified");
  let origin =
    healthOrigin === undefined
      ? undefined
      : parseReleaseHealthOrigin(healthOrigin);
  const workersDev =
    origin && new URL(origin).hostname.endsWith(".workers.dev");
  if ((!origin && environment === "test") || workersDev) {
    const accountDomain = await read("/workers/subdomain");
    if (
      typeof accountDomain?.subdomain !== "string" ||
      !dnsLabel.test(accountDomain.subdomain)
    )
      throw new Error("Worker workers.dev origin cannot be verified");
    const expected = `https://${worker}.${accountDomain.subdomain}.workers.dev`;
    if (origin && origin !== expected)
      throw new Error("Release health origin does not belong to this Worker");
    const availability = await read(
      `/workers/scripts/${encodeURIComponent(worker)}/subdomain`,
    );
    if (availability?.enabled !== true)
      throw new Error("Worker workers.dev origin is not enabled");
    return expected;
  }
  if (!origin)
    throw new Error(
      "Production releases require an explicit RELEASE_HEALTH_ORIGIN",
    );
  const hostname = new URL(origin).hostname;
  // The official Domains API supports exact filters and uses a SinglePage.
  // Only a positive exact mapping proves ownership; an empty/ambiguous list does
  // not. Independent script Workers use the API's default production service
  // environment, even when the application's APP_ENV is "test".
  const query = new URLSearchParams({
    hostname,
    service: worker,
    environment: "production",
    enabled: "true",
  });
  const domains = await read(`/workers/domains?${query}`);
  const domain =
    Array.isArray(domains) && domains.length === 1 ? domains[0] : null;
  if (
    typeof domain?.id !== "string" ||
    !domain.id ||
    domain.hostname !== hostname ||
    domain.service !== worker ||
    domain.environment !== "production" ||
    domain.enabled !== true
  )
    throw new Error("Release health custom domain is not bound to this Worker");
  return origin;
}

export function validateRuntimeSettings(settings, environment, account) {
  const bindings = new Map(
    (settings.bindings ?? []).map((binding) => [binding.name, binding]),
  );
  for (const name of [
    "ADMIN_PASSWORD",
    "SESSION_SECRET",
    "CF_USAGE_API_TOKEN",
  ]) {
    if (bindings.get(name)?.type !== "secret_text")
      throw new Error(
        `Runtime ${name} must be a Cloudflare Secret; configure it manually before deployment`,
      );
  }
  for (const name of [
    "CLOUDFLARE_ACCOUNT_ID",
    "APP_ENV",
    "PROCESSING_ENABLED",
  ]) {
    if (bindings.get(name)?.type !== "plain_text")
      throw new Error(`Runtime ${name} must be a Text variable`);
  }
  if (
    bindings.get("APP_ENV").text !== environment ||
    bindings.get("CLOUDFLARE_ACCOUNT_ID").text !== account
  )
    throw new Error("Runtime environment/account binding mismatch");
  if (!["true", "false"].includes(bindings.get("PROCESSING_ENABLED").text))
    throw new Error("Runtime processing switch must be true or false");
}

async function waitForConvergence(
  inspect,
  message,
  {
    now = Date.now,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs = 60000,
  } = {},
) {
  const deadline = now() + timeoutMs;
  do {
    try {
      const result = await inspect(() => {
        const remaining = deadline - now();
        if (remaining <= 0)
          throw new Error("Release readback deadline exceeded");
        return AbortSignal.timeout(Math.max(1, Math.min(5000, remaining)));
      });
      if (result && now() < deadline) return result;
    } catch {
      /* An old edge, transient network response or invalid body cannot authorize the release. */
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await pause(Math.min(2000, remaining));
  } while (now() < deadline);
  throw new Error(message);
}

async function healthMatches(url, revision, versionId, fetchFn, signal) {
  const response = await fetchFn(
    `${url}/health?release=${encodeURIComponent(revision)}&version=${encodeURIComponent(versionId)}`,
    {
      cache: "no-store",
      redirect: "error",
      headers: { "Cache-Control": "no-cache" },
      signal,
    },
  );
  if (response.redirected || !response.ok) return false;
  const health = await response.json();
  return (
    response.ok &&
    health.buildCommit === revision &&
    health.versionId === versionId &&
    health.configured === true
  );
}

export async function waitForHealth(
  url,
  revision,
  versionId,
  { fetchFn = fetch, ...options } = {},
) {
  if (!versionId) throw new Error("Expected serving Worker version is missing");
  return waitForConvergence(
    async (signal) =>
      healthMatches(url, revision, versionId, fetchFn, signal()),
    "Worker commit/version/runtime readback did not converge; release fence retained",
    options,
  );
}

function activeVersion(deployments) {
  const latest = deployments.deployments?.[0];
  if (
    latest?.versions?.length !== 1 ||
    latest.versions[0].percentage !== 100 ||
    typeof latest.versions[0].version_id !== "string"
  )
    throw new Error("Expected one fully active Worker version");
  return latest.versions[0].version_id;
}

export async function verifiedDuplicateRelease({
  query,
  expectedMigrations,
  ...options
}) {
  const workerPath = `/workers/scripts/${encodeURIComponent(options.worker)}`;
  const deployment = (await options.readCloudflare(`${workerPath}/deployments`))
    .deployments?.[0];
  // A matching tag is only a candidate. Split traffic or another commit must
  // follow the ordinary deployment path, never a successful duplicate result.
  if (
    deployment?.versions?.length !== 1 ||
    deployment.versions[0].percentage !== 100 ||
    typeof deployment.versions[0].version_id !== "string"
  )
    return null;
  const version = await options.readCloudflare(
    `${workerPath}/versions/${encodeURIComponent(deployment.versions[0].version_id)}`,
  );
  if (version.annotations?.["workers/tag"] !== options.revision) return null;
  const applied = new Set(
    (await query("SELECT name FROM d1_migrations")).map((row) => row.name),
  );
  if (
    !Array.isArray(expectedMigrations) ||
    !expectedMigrations.length ||
    expectedMigrations.some((name) => !applied.has(name))
  )
    throw new Error(
      "Same-commit deployment has unverified migrations; fence retained",
    );
  // Failures here propagate: a matching tag with bad health/settings/image is
  // never silently labelled complete or allowed to clear the owned fence.
  return waitForRelease(options);
}

export async function waitForRelease({
  worker,
  environment,
  account,
  revision,
  databaseId,
  mediaBucket,
  healthOrigin,
  readCloudflare,
  fetchFn = fetch,
  ...options
}) {
  const selectedOrigin =
    healthOrigin === undefined
      ? undefined
      : parseReleaseHealthOrigin(healthOrigin);
  return waitForConvergence(
    async (signal) => {
      const read = (path) => readCloudflare(path, { signal: signal() });
      const workerPath = `/workers/scripts/${encodeURIComponent(worker)}`;
      const versionId = activeVersion(await read(`${workerPath}/deployments`));
      const version = await read(
        `${workerPath}/versions/${encodeURIComponent(versionId)}`,
      );
      if (
        version.id !== versionId ||
        version.annotations?.["workers/tag"] !== revision
      )
        throw new Error("Active Worker version is not tagged with this commit");
      const binding = version.resources?.bindings?.find(
        (b) =>
          b.type === "durable_object_namespace" &&
          b.name === "PROCESSOR" &&
          b.class_name === "Processor" &&
          (b.script_name === undefined || b.script_name === worker),
      );
      const coordinator = version.resources?.bindings?.find(
        (b) =>
          b.type === "durable_object_namespace" &&
          b.name === "COORDINATOR" &&
          b.class_name === "Coordinator" &&
          (b.script_name === undefined || b.script_name === worker),
      );
      const container = version.resources?.script_runtime?.containers?.find(
        (c) => c.class_name === "Processor",
      );
      const image = container?.images?.processor;
      if (
        !binding?.namespace_id ||
        !coordinator?.namespace_id ||
        typeof container?.name !== "string" ||
        typeof image !== "string" ||
        !/@sha256:[a-f0-9]{64}$/.test(image)
      )
        throw new Error(
          "Worker Container namespace/prepared image not verified",
        );
      const app = await read(
        `/containers/applications/${encodeURIComponent(binding.namespace_id)}`,
      );
      const idle = [
        app.health?.instances?.active,
        app.health?.instances?.starting,
      ].every((count) => Number.isFinite(count) && count === 0);
      if (
        app.id !== binding.namespace_id ||
        app.durable_objects?.namespace_id !== binding.namespace_id ||
        app.scheduling_policy !== "durable_object" ||
        app.name !== container.name ||
        !idle
      )
        throw new Error(
          "Container application binding or idle state not verified",
        );
      const settings = await read(`${workerPath}/settings`);
      validateRuntimeSettings(settings, environment, account);
      for (const source of [version.resources.bindings, settings.bindings]) {
        const bindings = new Map(source.map((b) => [b.name, b]));
        const database = bindings.get("DB");
        const actualDatabaseId = database?.id ?? database?.database_id;
        if (
          !databaseId ||
          !mediaBucket ||
          database?.type !== "d1" ||
          actualDatabaseId !== databaseId ||
          (database.id !== undefined &&
            database.database_id !== undefined &&
            database.id !== database.database_id) ||
          bindings.get("MEDIA")?.type !== "r2_bucket" ||
          bindings.get("MEDIA")?.bucket_name !== mediaBucket ||
          bindings.get("PROCESSOR")?.type !== "durable_object_namespace" ||
          bindings.get("PROCESSOR")?.namespace_id !== binding.namespace_id ||
          bindings.get("COORDINATOR")?.type !== "durable_object_namespace" ||
          bindings.get("COORDINATOR")?.namespace_id !==
            coordinator.namespace_id ||
          bindings.get("VERSION")?.type !== "version_metadata"
        )
          throw new Error(
            "Resource or Worker version metadata binding mismatch",
          );
      }
      const originOptions = {
        worker,
        environment,
        healthOrigin: selectedOrigin,
        read,
      };
      const url = await verifiedReleaseOrigin(originOptions);
      if (!(await healthMatches(url, revision, versionId, fetchFn, signal())))
        return false;
      if ((await verifiedReleaseOrigin(originOptions)) !== url) return false;
      // Settings changes and deployments can create another immutable version
      // while the edge converges. Discard this whole attempt if its active
      // version changed; never reuse its image or application in a later retry.
      if (activeVersion(await read(`${workerPath}/deployments`)) !== versionId)
        return false;
      return {
        commit: revision,
        workerVersion: versionId,
        containerNamespace: binding.namespace_id,
        preparedImage: image,
        healthOrigin: url,
        releaseVerified: true,
      };
    },
    "Worker/Container/serving version readback did not converge; release fence retained",
    options,
  );
}
