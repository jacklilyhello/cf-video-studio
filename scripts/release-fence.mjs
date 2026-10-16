// This fence shares the numeric setting used by the task admission transition.
// Owner metadata is diagnostic/control-plane evidence, never an override of the
// numeric lease or the active/stop-unverified job check.
export const RELEASE_LEASE_MS = 90 * 60 * 1000;
const activeJobs =
  "SELECT 1 FROM jobs WHERE state IN ('queued','starting','running','stopping','stop_unverified') OR (started_at IS NOT NULL AND stop_verified=0)";
const terminalOutcomes = new Set([
  "success",
  "fail",
  "skipped",
  "cancelled",
  "terminated",
]);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const commit = /^[a-f0-9]{40}$/;
const workerName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

function leaseValue(value) {
  if (value === null || value === undefined) return 0;
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error(
      "Release fence value is invalid; operator reconciliation required",
    );
  return Number(value);
}

function parseOwner(value, until, worker) {
  try {
    const owner = JSON.parse(value);
    if (
      owner?.fenceUntil === until &&
      owner.worker === worker &&
      commit.test(owner.revision) &&
      uuid.test(owner.buildUuid)
    )
      return owner;
  } catch {
    /* Missing or legacy metadata never proves that its deployment has stopped. */
  }
  throw new Error(
    "Expired release fence has no verifiable build owner; operator reconciliation required",
  );
}

export async function acquireReleaseFence({
  query,
  readBuild,
  revision,
  worker,
  buildUuid,
  now = Date.now,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 5 * 60 * 1000,
  pollMs = 5000,
  onWait = () => {},
}) {
  if (
    typeof revision !== "string" ||
    !commit.test(revision) ||
    typeof worker !== "string" ||
    !workerName.test(worker) ||
    (buildUuid !== undefined &&
      (typeof buildUuid !== "string" || !uuid.test(buildUuid))) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(pollMs) ||
    pollMs <= 0
  )
    throw new Error("Release fence identity or wait configuration is invalid");
  const deadline = now() + timeoutMs;
  let announced = false;
  do {
    const [state] = await query(
      `SELECT (SELECT value FROM settings WHERE key='deployment_fence_until') AS fence,(SELECT value FROM settings WHERE key='deployment_fence_owner') AS owner,(SELECT COUNT(*) FROM (${activeJobs})) AS active`,
    );
    // No task data leaves the database. The INSERT repeats the guard atomically.
    if (!state || !Number.isSafeInteger(state.active) || state.active < 0)
      throw new Error(
        "Release admission state unavailable; deployment stopped",
      );
    if (state.active !== 0)
      throw new Error(
        "Active or stop-unverified processing tasks exist; deployment stopped",
      );
    const until = leaseValue(state.fence);
    const currentTime = now();
    if (until > 0 && until <= currentTime) {
      const owner = parseOwner(state.owner, until, worker);
      let build;
      try {
        build = await readBuild(owner.buildUuid);
      } catch {
        throw new Error(
          "Expired release fence owner could not be checked; fence retained",
        );
      }
      if (
        build?.build_uuid !== owner.buildUuid ||
        build.build_trigger_metadata?.commit_hash !== owner.revision ||
        build.status !== "stopped" ||
        !terminalOutcomes.has(build.build_outcome)
      )
        throw new Error(
          "Expired release fence owner is still live or unverified; fence retained",
        );
    }
    if (now() >= deadline) break;
    if (until <= currentTime) {
      const admittedAt = now();
      const fenceUntil = admittedAt + RELEASE_LEASE_MS;
      const expected =
        state.fence === null || state.fence === undefined
          ? "NOT EXISTS(SELECT 1 FROM settings WHERE key='deployment_fence_until')"
          : `value=${quote(state.fence)}`;
      const rows = await query(
        `INSERT INTO settings(key,value,updated_at) SELECT 'deployment_fence_until','${fenceUntil}',${admittedAt} WHERE NOT EXISTS(${activeJobs}) AND ${state.fence === null || state.fence === undefined ? expected : `EXISTS(SELECT 1 FROM settings WHERE key='deployment_fence_until' AND ${expected})`} ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE settings.value=${quote(state.fence ?? "0")} AND CAST(settings.value AS INTEGER)<=${admittedAt} AND NOT EXISTS(${activeJobs}) RETURNING key`,
      );
      if (rows.length === 1) {
        const owner = JSON.stringify({
          worker,
          revision,
          buildUuid: buildUuid ?? null,
          fenceUntil,
        });
        const recorded = await query(
          `INSERT INTO settings(key,value,updated_at) SELECT 'deployment_fence_owner',${quote(owner)},${admittedAt} WHERE EXISTS(SELECT 1 FROM settings WHERE key='deployment_fence_until' AND value='${fenceUntil}') ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE EXISTS(SELECT 1 FROM settings WHERE key='deployment_fence_until' AND value='${fenceUntil}') RETURNING key`,
        );
        if (recorded.length !== 1)
          throw new Error(
            "Release owner could not be recorded; fence retained",
          );
        return { fenceUntil, waited: announced };
      }
      // A competing admission won the compare-and-swap or a task started.
      // Reread both conditions; no failed write authorizes deployment.
    } else if (!announced) {
      onWait({ fenceUntil: until });
      announced = true;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await pause(Math.min(pollMs, remaining));
  } while (now() < deadline);
  throw new Error(
    "Release fence remained contended after bounded waiting; deployment stopped without taking another lock",
  );
}

export async function releaseOwnedFence(query, fenceUntil, now = Date.now) {
  const rows = await query(
    `UPDATE settings SET value='0',updated_at=${now()} WHERE key='deployment_fence_until' AND value='${fenceUntil}' RETURNING key`,
  );
  if (rows.length !== 1)
    throw new Error(
      "Verified release no longer owns its fence; another lock was not cleared",
    );
  return rows;
}
