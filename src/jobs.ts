import type { Env, Job, Quote, Video } from "./types";
import { HttpError, id, json, now } from "./http";
import { quoteProcessing, validateQuoteBudget } from "./billing";
import type { ProcessingPlan } from "./processor";
import { log } from "./logs";

const LIVE = ["queued", "starting", "running", "stopping", "stop_unverified"];
// Match upload admission: the census is a conservative floor, while current
// catalog and reservations close changes after the fresh budget read. A higher
// setting cannot enlarge the capacity authorized by that snapshot.
const STORAGE_FENCE = `MAX((SELECT COALESCE(SUM(bytes),0) FROM objects WHERE state='present'),?)
  + (SELECT COALESCE(SUM(reserved_bytes),0) FROM uploads WHERE state NOT IN ('complete','cancelled','expired'))
  + (SELECT COALESCE(SUM(COALESCE(json_extract(amounts_json,'$.r2CurrentBytes'),0)),0) FROM reservations WHERE kind!='upload_approval' AND state NOT IN ('released','reconciled'))
  + ? <= MIN(?,CAST(COALESCE((SELECT value FROM settings WHERE key='storage_limit_bytes'),?) AS INTEGER))`;

export async function createQuote(
  env: Env,
  videoId: string,
  input: Record<string, unknown>,
): Promise<Response> {
  const video = await env.DB.prepare("SELECT * FROM videos WHERE id=?")
    .bind(videoId)
    .first<Video>();
  if (!video) throw new HttpError(404, "video_missing", "视频不存在");
  const active = await env.DB.prepare(
    "SELECT id FROM jobs WHERE video_id=? AND state IN ('queued','starting','running','stopping','stop_unverified') LIMIT 1",
  )
    .bind(videoId)
    .first();
  if (active)
    throw new HttpError(
      409,
      "job_active",
      "此视频已有未结束或停止未核实的任务",
    );
  // Quotes inspect R2 metadata and account usage only. This path never touches
  // PROCESSOR, container ports, probes, thumbnails, or a billable start method.
  const draft = await quoteProcessing(env, video, {
    mode: input.mode,
    quality: input.quality,
    ...(input.manualEvidenceIds !== undefined
      ? { manualEvidenceIds: input.manualEvidenceIds }
      : {}),
  });
  const quoteId = id();
  const plan: ProcessingPlan = {
    ...draft,
    ...((draft.mode === "transcode" || draft.mode === "faststart") &&
    video.probe_json
      ? { probe: JSON.parse(video.probe_json) }
      : {}),
  };
  await env.DB.prepare(
    "INSERT INTO quotes(id,video_id,source_revision,source_etag,mode,quality,snapshot_id,period_start,expires_at,state,data_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,'open',?,?)",
  )
    .bind(
      quoteId,
      video.id,
      video.source_revision,
      video.source_etag,
      draft.mode,
      draft.quality,
      draft.snapshotId,
      draft.periodStart,
      draft.expiresAt,
      JSON.stringify(plan),
      now(),
    )
    .run();
  return json(
    {
      quote: { id: quoteId, videoId, ...plan },
      confirmationRequired: true,
      processingEnabled: env.PROCESSING_ENABLED === "true",
    },
    201,
  );
}

/** Called only inside the account's singleton coordinator serialization queue. */
export async function confirmProcessing(
  env: Env,
  quoteId: string,
): Promise<Response> {
  const existing = await env.DB.prepare("SELECT * FROM jobs WHERE quote_id=?")
    .bind(quoteId)
    .first<Job>();
  if (existing) return json({ job: existing, duplicate: true }, 200);
  const fence = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='deployment_fence_until'",
  ).first<{ value: string }>();
  if (Number(fence?.value ?? 0) > now())
    throw new HttpError(
      409,
      "deployment_busy",
      "正在部署，请部署核验结束后重新确认报价",
    );
  if (env.PROCESSING_ENABLED !== "true")
    throw new HttpError(409, "processing_disabled", "视频处理总开关尚未开启");
  const quote = await env.DB.prepare("SELECT * FROM quotes WHERE id=?")
    .bind(quoteId)
    .first<Quote>();
  if (!quote) throw new HttpError(404, "quote_missing", "报价不存在");
  // Re-read actual account usage immediately before reserve/start. The user's
  // earlier quote acknowledgment cannot turn stale or missing data into a pass.
  const snapshot = await validateQuoteBudget(env, quote);
  const plan = JSON.parse(quote.data_json) as ProcessingPlan;
  const stored = snapshot.project.storedBytes;
  const actual = snapshot.project.actualBytes;
  const reserved = plan.resourceAmounts.r2CurrentBytes;
  const limit = snapshot.policy.storageLimitBytes;
  if (
    snapshot.project.ledgerValid !== true ||
    stored === null ||
    actual === undefined ||
    ![stored, actual, reserved, limit].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    reserved <= 0
  )
    throw new HttpError(
      503,
      "budget_unknown",
      "处理项目存储核验不完整，请重新核验报价",
    );
  const config = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='processing_concurrency'",
  ).first<{ value: string }>();
  const concurrency = Number(config?.value ?? 1);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10)
    throw new HttpError(503, "concurrency_invalid", "处理并发设置无效");
  const active = await env.DB.prepare(
    "SELECT id,video_id FROM jobs WHERE state IN ('queued','starting','running','stopping','stop_unverified')",
  ).all<{ id: string; video_id: string }>();
  if (
    active.results.length >= concurrency ||
    active.results.some((j) => j.video_id === quote.video_id)
  )
    throw new HttpError(
      409,
      "processing_busy",
      "已有任务或停止待核实实例占用处理槽位",
    );
  if (
    !snapshot.periodEnd ||
    now() + plan.totalTimeoutSeconds * 1000 >= Date.parse(snapshot.periodEnd)
  )
    throw new HttpError(
      409,
      "billing_period_boundary",
      "任务可能跨账期，请重新报价",
    );
  if (plan.mode === "transcode" && !plan.probe)
    throw new HttpError(409, "probe_missing", "转码报价缺少绑定的可信探测结果");
  const jobId = id();
  const versionId = id();
  const timestamp = now();
  const prefix = `videos/${quote.video_id}/versions/${versionId}/`;
  // D1 batch is transactional. changes() binds all new rows to the successful
  // open -> confirmed transition, protecting replay even after a coordinator
  // restart. quote_id is also UNIQUE in jobs.
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE quotes SET state='confirmed' WHERE id=? AND state='open' AND expires_at>? AND NOT EXISTS(SELECT 1 FROM settings WHERE key='deployment_fence_until' AND CAST(value AS INTEGER)>?) AND ${STORAGE_FENCE}`,
    ).bind(
      quote.id,
      timestamp,
      timestamp,
      Math.max(stored, actual),
      reserved,
      limit,
      limit,
    ),
    env.DB.prepare(
      "INSERT INTO versions(id,video_id,task_id,prefix,state,mode,quality,timeline_id,created_at) SELECT ?,?,?,?,'processing',?,?,?,? WHERE changes()=1",
    ).bind(
      versionId,
      quote.video_id,
      jobId,
      prefix,
      quote.mode,
      quote.quality,
      versionId,
      timestamp,
    ),
    env.DB.prepare(
      "INSERT INTO jobs(id,video_id,version_id,quote_id,state,stage,created_at,updated_at) SELECT ?,?,?,?,'queued','queued',?,? WHERE EXISTS(SELECT 1 FROM versions WHERE id=? AND task_id=?)",
    ).bind(
      jobId,
      quote.video_id,
      versionId,
      quote.id,
      timestamp,
      timestamp,
      versionId,
      jobId,
    ),
    env.DB.prepare(
      "INSERT INTO reservations(id,owner_id,kind,snapshot_id,period_start,amounts_json,state,created_at) SELECT ?,?,'processing',?,?,?,'active',? WHERE EXISTS(SELECT 1 FROM jobs WHERE id=?)",
    ).bind(
      id(),
      jobId,
      snapshot.id,
      snapshot.periodStart,
      JSON.stringify(plan.resourceAmounts),
      timestamp,
      jobId,
    ),
  ]);
  if (results[0].meta.changes !== 1) {
    const replay = await env.DB.prepare("SELECT * FROM jobs WHERE quote_id=?")
      .bind(quote.id)
      .first<Job>();
    if (replay) return json({ job: replay, duplicate: true });
    const activeFence = await env.DB.prepare(
      "SELECT value FROM settings WHERE key='deployment_fence_until'",
    ).first<{ value: string }>();
    if (Number(activeFence?.value ?? 0) > now())
      throw new HttpError(
        409,
        "deployment_busy",
        "正在部署，报价尚未使用，请部署结束后重试",
      );
    const currentQuote = await env.DB.prepare(
      "SELECT state,expires_at FROM quotes WHERE id=?",
    )
      .bind(quote.id)
      .first<{ state: string; expires_at: number }>();
    if (currentQuote?.state === "open" && currentQuote.expires_at > now())
      throw new HttpError(
        409,
        "storage_limit",
        "项目存储占用、预留或上限已变化，报价尚未使用，请重新核验后确认",
      );
    throw new HttpError(409, "quote_consumed", "报价已被使用或过期");
  }
  await log(env, {
    stage: "processing_confirmed",
    message: "管理员已确认处理范围并预留预算",
    videoId: quote.video_id,
    taskId: jobId,
    details: {
      quoteId,
      versionId,
      instance: plan.instance.name,
      maxOutputBytes: plan.maxOutputBytes,
      totalTimeoutSeconds: plan.totalTimeoutSeconds,
    },
  });
  let dispatchError = false;
  try {
    const response = await env.PROCESSOR.get(
      env.PROCESSOR.idFromName(jobId),
    ).fetch("https://processor/start", {
      method: "POST",
      body: JSON.stringify({ jobId }),
    });
    dispatchError = !response.ok;
  } catch {
    // An unknown transport result must never dispatch another paid start. The
    // periodic supervisor reconciles this same Durable Object's persisted state.
    dispatchError = true;
  }
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind(jobId)
    .first<Job>();
  return json(
    {
      job,
      ...(dispatchError
        ? { warning: "任务交接结果需核对；不会自动创建或启动第二个收费任务" }
        : {}),
    },
    202,
  );
}

export async function cancelJob(env: Env, jobId: string): Promise<Response> {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind(jobId)
    .first<Job>();
  if (!job) throw new HttpError(404, "job_missing", "任务不存在");
  if (!LIVE.includes(job.state)) return json({ job, alreadyFinished: true });
  // Cancellation and stop verification stay available without billing API access.
  const response = await env.PROCESSOR.get(
    env.PROCESSOR.idFromName(jobId),
  ).fetch("https://processor/cancel", {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
  if (!response.ok)
    throw new HttpError(
      503,
      "cancel_unverified",
      "停止请求未核实；预算继续保留，请重试核对",
    );
  return json({
    job: await env.DB.prepare("SELECT * FROM jobs WHERE id=?")
      .bind(jobId)
      .first<Job>(),
    cancellationRequested: true,
  });
}
