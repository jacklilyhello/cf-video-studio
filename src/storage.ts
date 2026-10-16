import type { Env, Video, Version } from "./types";
import { body, HttpError, id, json, now, sha256, textValue } from "./http";
import { log } from "./logs";
import { listPrefix, verifyVersionObjects } from "./inventory";
import { verifyFaststartVersion } from "./faststart";

// Preserve access to already imported originals; the old import workflow is removed.
const IMPORT_PREFIX = "imports/";
interface ListedObject {
  key: string;
  bytes: number;
  etag: string;
  videoId: string;
  versionId: string | null;
  category: string;
}
interface DeletionPlan {
  id: string;
  video_id: string;
  kind: string;
  scope_json: string;
  fingerprint: string;
  state: string;
  released_bytes: number;
  failure_json: string | null;
  expires_at: number;
}
interface DeletionScope {
  versionId: string | null;
  versionIds?: string[];
  sourceKey?: string | null;
  sourceReferenceOnly: boolean;
  requiresUnpublish: boolean;
  preservePlayback?: boolean;
  removeDependencies?: boolean;
  dependencyVersionIds?: string[];
  retainedVersionId?: string | null;
  videoTitle?: string;
  missingKeys?: string[];
  missingSource?: boolean;
  warning?: string;
}
function allowedObject(video: Video, key: string) {
  return (
    key.startsWith(`videos/${video.id}/`) ||
    (key === video.source_key && key.startsWith(IMPORT_PREFIX))
  );
}
function scopeDigest(objects: ListedObject[]) {
  return sha256(
    JSON.stringify(
      objects.map((o) => [
        o.key,
        o.bytes,
        o.etag,
        o.videoId,
        o.versionId,
        o.category,
      ]),
    ),
  );
}
async function assertIdle(env: Env, videoId: string) {
  const job = await env.DB.prepare(
    `SELECT id,state,stage FROM jobs WHERE video_id=? AND (state NOT IN ('succeeded','complete','failed','cancelled','needs_confirmation','timed_out') OR (started_at IS NOT NULL AND stop_verified=0)) LIMIT 1`,
  )
    .bind(videoId)
    .first<{ id: string; state: string; stage: string }>();
  if (job)
    throw new HttpError(
      409,
      "active_task",
      `处理任务 ${job.id} 仍在运行或尚未核实停止。请到“处理任务”停止该任务并等待停止确认，再删除文件。`,
    );
  const upload = await env.DB.prepare(
    `SELECT id FROM uploads WHERE video_id=? AND state NOT IN ('complete','cancelled','expired') LIMIT 1`,
  )
    .bind(videoId)
    .first<{ id: string }>();
  if (upload)
    throw new HttpError(
      409,
      "upload_active",
      `上传 ${upload.id} 尚未结束。请到“视频库”的上传记录取消或完成它，再删除文件。`,
    );
}
async function versionsForVideo(env: Env, videoId: string) {
  return (
    await env.DB.prepare(
      "SELECT * FROM versions WHERE video_id=? AND state!='deleted' ORDER BY created_at DESC,id",
    )
      .bind(videoId)
      .all<Version>()
  ).results;
}
async function independentVersion(
  env: Env,
  video: Video,
  versions: Version[],
  exactId?: string,
) {
  const candidates = versions.filter(
    (v) =>
      v.state === "verified" &&
      ["faststart", "probe-remux", "transcode"].includes(v.mode) &&
      (!exactId || v.id === exactId),
  );
  candidates.sort(
    (a, b) =>
      Number(b.id === video.current_version_id) -
      Number(a.id === video.current_version_id),
  );
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      if (candidate.mode === "faststart")
        await verifyFaststartVersion(env, candidate, {
          inspectStructure: true,
          requireAttestation: video.published === 1,
        });
      else await verifyVersionObjects(env, candidate);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  // Keep the historical API code compatible; the user-facing requirement now includes MP4.
  throw new HttpError(
    409,
    "hls_required",
    "没有可独立播放的完整 MP4 或 HLS 版本。可选择同时移除原片播放版本并下架；无需先付费转换。",
  );
}
async function objectsForPrefix(
  env: Env,
  prefix: string,
  videoId: string,
  versionId: string | null,
  category: string,
) {
  if (
    (versionId && prefix !== `videos/${videoId}/versions/${versionId}/`) ||
    (!versionId && prefix !== `videos/${videoId}/`)
  )
    throw new HttpError(
      409,
      "scope_violation",
      "文件目录超出这个视频的项目范围",
    );
  return (await listPrefix(env, prefix)).map((o) => ({
    key: o.key,
    bytes: o.size,
    etag: o.etag,
    videoId,
    versionId,
    category,
  }));
}
export async function createDeletionPlan(request: Request, env: Env) {
  const data = await body(request);
  const kind = textValue(data.kind, "删除类型", 20);
  if (!["source", "version", "video", "failed"].includes(kind))
    throw new HttpError(400, "invalid_scope", "删除范围无效");
  const videoId = textValue(data.videoId, "视频 ID", 64);
  const video = await env.DB.prepare("SELECT * FROM videos WHERE id=?")
    .bind(videoId)
    .first<Video>();
  if (!video || video.status === "deleted")
    throw new HttpError(404, "video_missing", "视频不存在或已删除");
  await assertIdle(env, videoId);
  const versions = await versionsForVideo(env, videoId);
  let objects: ListedObject[] = [];
  const scope: DeletionScope = {
    videoTitle: video.title,
    versionId: null,
    versionIds: [],
    sourceKey: video.source_key,
    sourceReferenceOnly: false,
    requiresUnpublish: false,
  };
  if (kind === "source") {
    if (!video.source_key)
      throw new HttpError(
        409,
        "source_missing",
        "这个视频已经没有原片，无需删除",
      );
    const dependencies = versions.filter((v) => v.mode === "source");
    scope.preservePlayback = data.preservePlayback !== false;
    scope.removeDependencies = data.removeDependencies === true;
    scope.dependencyVersionIds = dependencies.map((v) => v.id);
    scope.versionIds = scope.dependencyVersionIds;
    if (dependencies.length && !scope.removeDependencies)
      throw new HttpError(
        409,
        "source_referenced",
        "原片直接播放版本依赖这份文件。请确认同时移除这些播放版本，或保留原片。",
      );
    const retained = scope.preservePlayback
      ? await independentVersion(env, video, versions)
      : null;
    scope.retainedVersionId = retained?.id ?? null;
    scope.requiresUnpublish =
      video.published === 1 &&
      !retained &&
      (!video.current_version_id ||
        dependencies.some((v) => v.id === video.current_version_id));
    const object = await env.MEDIA.head(video.source_key);
    if (object)
      objects = [
        {
          key: object.key,
          bytes: object.size,
          etag: object.etag,
          videoId,
          versionId: null,
          category: "source",
        },
      ];
    scope.warning = retained
      ? "删除原片及依赖它的直接播放版本；保留已核实的独立播放文件。原片删除后不能恢复，也不能再用于转换。"
      : "删除原片及依赖它的直接播放版本。其他生成文件保留；受到影响的前台视频会下架。文件删除后不能恢复。";
  } else if (kind === "version") {
    const versionId = textValue(data.versionId, "版本 ID", 64);
    const version = versions.find((v) => v.id === versionId);
    if (!version)
      throw new HttpError(404, "version_missing", "该播放版本不存在或已移除");
    scope.versionId = versionId;
    scope.versionIds = [versionId];
    scope.sourceReferenceOnly = version.mode === "source";
    scope.requiresUnpublish =
      video.published === 1 && video.current_version_id === version.id;
    objects =
      version.mode === "source"
        ? []
        : await objectsForPrefix(
            env,
            version.prefix,
            videoId,
            version.id,
            version.mode === "faststart" ? "mp4" : "hls",
          );
    scope.warning = scope.sourceReferenceOnly
      ? "移除直接播放版本记录，原片保留，不释放文件空间。"
      : "删除选定生成版本的文件，原片及其他生成版本保留。文件删除后不能恢复。";
  } else if (kind === "video") {
    scope.versionIds = versions.map((v) => v.id);
    scope.requiresUnpublish = video.published === 1;
    objects = await objectsForPrefix(
      env,
      `videos/${videoId}/`,
      videoId,
      null,
      "video",
    );
    if (video.source_key?.startsWith(IMPORT_PREFIX)) {
      const source = await env.MEDIA.head(video.source_key);
      if (source)
        objects.push({
          key: source.key,
          bytes: source.size,
          etag: source.etag,
          videoId,
          versionId: null,
          category: "source",
        });
    }
    scope.warning =
      "彻底删除这个视频、原片、全部已列出的生成版本及文件，并从前台下架。文件删除后不能恢复。";
  } else {
    const failed = versions.filter(
      (v) =>
        v.mode !== "source" &&
        ["failed", "cancelled", "needs_confirmation", "timed_out"].includes(
          v.state,
        ),
    );
    scope.versionIds = failed.map((v) => v.id);
    for (const version of failed) {
      if (version.id === video.current_version_id)
        throw new HttpError(
          409,
          "referenced_version",
          "待清理的失败版本仍是当前播放版本，请先在视频详情中更换或移除它",
        );
      objects.push(
        ...(await objectsForPrefix(
          env,
          version.prefix,
          videoId,
          version.id,
          "failed",
        )),
      );
    }
    scope.warning = "仅删除列出的失败生成文件及版本记录；原片和成功版本保留。";
  }
  // Missing files still have directory entries to remove, but release no space.
  // Snapshot those entries as well; a later reappearance requires a new confirmation.
  const indexed = await env.DB.prepare(
    "SELECT key,bytes,etag,version_id AS versionId,category FROM objects WHERE video_id=? AND state!='deleted'",
  )
    .bind(videoId)
    .all<Omit<ListedObject, "videoId">>();
  const actualKeys = new Set(objects.map((o) => o.key));
  scope.missingKeys = [];
  for (const entry of indexed.results) {
    const selected =
      kind === "video" ||
      (kind === "source"
        ? entry.key === video.source_key
        : !scope.sourceReferenceOnly &&
          !!entry.versionId &&
          !!scope.versionIds?.includes(entry.versionId));
    if (!selected || actualKeys.has(entry.key)) continue;
    if (!allowedObject(video, entry.key))
      throw new HttpError(
        409,
        "scope_violation",
        "登记的文件超出这个视频的范围，请先检查记录",
      );
    const head = await env.MEDIA.head(entry.key);
    objects.push({
      ...entry,
      videoId,
      ...(head ? { bytes: head.size, etag: head.etag } : {}),
    });
    actualKeys.add(entry.key);
    if (!head) scope.missingKeys.push(entry.key);
  }
  if (
    kind === "source" &&
    video.source_key &&
    !actualKeys.has(video.source_key)
  )
    scope.missingSource = true;
  if (
    objects.length > 0 &&
    objects.every((object) => scope.missingKeys?.includes(object.key))
  )
    scope.warning =
      "所选文件已不在存储中。本次仅同步这个范围的视频或版本记录，不释放文件空间，其他文件保留。";
  if (objects.some((o) => !allowedObject(video, o.key)))
    throw new HttpError(409, "scope_violation", "文件超出本项目范围");
  objects.sort((a, b) => a.key.localeCompare(b.key));
  const planId = id(),
    fingerprint = await scopeDigest(objects),
    expiresAt = now() + 10 * 60 * 1000;
  const actionable =
    objects.length > 0 ||
    kind === "video" ||
    kind === "source" ||
    !!scope.versionIds?.length;
  await env.DB.prepare(
    `INSERT INTO deletion_plans(id,video_id,kind,scope_json,fingerprint,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,'building',?,?,?)`,
  )
    .bind(
      planId,
      videoId,
      kind,
      JSON.stringify(scope),
      fingerprint,
      expiresAt,
      now(),
      now(),
    )
    .run();
  const inserts = [];
  for (let index = 0; index < objects.length; index += 100)
    inserts.push(
      env.DB.prepare(
        `INSERT INTO deletion_items(plan_id,key,bytes,etag,video_id,version_id,category) SELECT ?,json_extract(value,'$.key'),json_extract(value,'$.bytes'),json_extract(value,'$.etag'),json_extract(value,'$.videoId'),json_extract(value,'$.versionId'),json_extract(value,'$.category') FROM json_each(?)`,
      ).bind(planId, JSON.stringify(objects.slice(index, index + 100))),
    );
  if (inserts.length) await env.DB.batch(inserts);
  await env.DB.prepare("UPDATE deletion_plans SET state=? WHERE id=?")
    .bind(actionable ? "pending" : "complete", planId)
    .run();
  return getDeletionPlan(env, planId);
}
export async function executeDeletion(
  request: Request,
  env: Env,
  planId: string,
  receipts?: DurableObjectStorage,
) {
  const data = await body(request);
  if (data.confirmation !== "DELETE_LISTED_OBJECTS")
    throw new HttpError(400, "confirmation_required", "请确认本次删除范围");
  const plan = await env.DB.prepare("SELECT * FROM deletion_plans WHERE id=?")
    .bind(planId)
    .first<DeletionPlan>();
  if (!plan) throw new HttpError(404, "plan_missing", "删除请求不存在");
  if (plan.state === "complete")
    return json({
      state: "complete",
      releasedBytes: plan.released_bytes,
      failures: [],
      remainingCount: 0,
    });
  if (plan.expires_at < now() && plan.state === "pending")
    throw new HttpError(
      409,
      "plan_expired",
      "这次删除确认已过期，尚未删除文件。请重新检查或取消待办。",
    );
  if (!["pending", "partial", "running"].includes(plan.state))
    throw new HttpError(
      409,
      "plan_state",
      "这次删除请求已取消或尚未准备好，请重新检查",
    );
  await assertIdle(env, plan.video_id);
  const scope = JSON.parse(plan.scope_json) as DeletionScope;
  const listing = await env.DB.prepare(
    "SELECT key,bytes,etag,video_id AS videoId,version_id AS versionId,category,state FROM deletion_items WHERE plan_id=?",
  )
    .bind(planId)
    .all<ListedObject & { state: string }>();
  const objects = listing.results.sort((a, b) => a.key.localeCompare(b.key));
  if ((await scopeDigest(objects)) !== plan.fingerprint)
    throw new HttpError(409, "plan_changed", "删除范围校验失败，请重新检查");
  const video = await env.DB.prepare("SELECT * FROM videos WHERE id=?")
    .bind(plan.video_id)
    .first<Video>();
  if (!video) throw new HttpError(404, "video_missing", "视频不存在");
  const versions = await versionsForVideo(env, video.id);
  const versionIds =
    scope.versionIds ??
    (plan.kind === "version"
      ? [scope.versionId!]
      : [
          ...new Set(
            objects.map((o) => o.versionId).filter((v): v is string => !!v),
          ),
        ]);
  const sourceDependencies = versions.filter((v) => v.mode === "source");
  if (
    plan.kind === "video" &&
    (!scope.versionIds || versions.some((v) => !versionIds.includes(v.id)))
  )
    throw new HttpError(
      409,
      "metadata_changed",
      "这个视频新增了播放版本。原删除范围不会扩大，请重新检查并确认。",
    );
  if (
    ["source", "video"].includes(plan.kind) &&
    scope.sourceKey !== undefined &&
    video.source_key !== scope.sourceKey
  )
    throw new HttpError(
      409,
      "objects_changed",
      "原片已经变化，请重新检查；这次不会删除新的原片",
    );
  let retained: Version | null = null;
  if (plan.kind === "source") {
    if (
      sourceDependencies.some(
        (v) => !(scope.dependencyVersionIds ?? []).includes(v.id),
      )
    )
      throw new HttpError(
        409,
        "source_referenced",
        "新增了依赖原片的播放版本，请重新检查并确认删除范围",
      );
    if (
      sourceDependencies.length &&
      (scope.removeDependencies !== true || data.removeDependencies !== true)
    )
      throw new HttpError(
        409,
        "source_referenced",
        "请确认同时移除依赖原片的直接播放版本",
      );
    if (scope.preservePlayback !== false)
      retained = await independentVersion(
        env,
        video,
        versions,
        scope.retainedVersionId ?? undefined,
      );
  }
  const includesCurrent =
    plan.kind === "video" ||
    versionIds.includes(video.current_version_id ?? "");
  const needsUnpublish = video.published === 1 && includesCurrent && !retained;
  if (needsUnpublish && data.unpublish !== true)
    throw new HttpError(
      409,
      "unpublish_required",
      "这次删除会影响前台播放，请确认先下架这个视频",
    );
  if (objects.some((o) => !allowedObject(video, o.key)))
    throw new HttpError(403, "scope_denied", "文件范围不允许");
  if (
    scope.missingSource &&
    scope.sourceKey &&
    (await env.MEDIA.head(scope.sourceKey))
  )
    throw new HttpError(
      409,
      "objects_changed",
      "之前缺失的原片重新出现了。请重新检查并确认文件删除范围。",
    );
  const work = objects.filter((o) => o.state !== "deleted").slice(0, 100);
  // Inspect this batch before changing playback or removing any of its files.
  for (const item of work) {
    const head = await env.MEDIA.head(item.key);
    if (
      head &&
      (scope.missingKeys?.includes(item.key) ||
        head.etag !== item.etag ||
        head.size !== item.bytes)
    )
      throw new HttpError(
        409,
        "objects_changed",
        "待删除文件已经变化。尚未扩大删除范围，请重新检查。",
      );
  }
  if (needsUnpublish)
    await env.DB.prepare(
      "UPDATE videos SET published=0,updated_at=? WHERE id=?",
    )
      .bind(now(), video.id)
      .run();
  if (plan.kind === "source" && retained && includesCurrent)
    await env.DB.prepare(
      "UPDATE videos SET current_version_id=?,updated_at=?,publication_revision=publication_revision+1 WHERE id=?",
    )
      .bind(retained.id, now(), video.id)
      .run();
  if (versionIds.length)
    await env.DB.prepare(
      "UPDATE versions SET state='deleting',validation_json=NULL WHERE id IN (SELECT value FROM json_each(?)) AND video_id=? AND state!='deleted'",
    )
      .bind(JSON.stringify(versionIds), video.id)
      .run();
  await env.DB.prepare(
    "UPDATE deletion_plans SET state='running',updated_at=? WHERE id=?",
  )
    .bind(now(), planId)
    .run();
  const failures: { key: string; error: string }[] = [];
  for (const item of work) {
    const receiptKey = `deletion-receipt:${planId}:${await sha256(item.key)}`;
    try {
      const before = await env.MEDIA.head(item.key);
      if (
        before &&
        (scope.missingKeys?.includes(item.key) ||
          before.etag !== item.etag ||
          before.size !== item.bytes)
      )
        throw new Error("object_changed_after_confirmation");
      if (before) await env.MEDIA.delete(item.key);
      if (await env.MEDIA.head(item.key)) throw new Error("still_present");
      const prior = await receipts?.get<{
        bytes: number;
        etag: string;
        verified: boolean;
      }>(receiptKey);
      const freed =
        before?.size ??
        (prior?.verified && prior.etag === item.etag ? prior.bytes : 0);
      if (receipts)
        await receipts.put(receiptKey, {
          bytes: freed,
          etag: item.etag,
          verified: true,
        });
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE objects SET state='deleted',updated_at=? WHERE key=?",
        ).bind(now(), item.key),
        env.DB.prepare(
          "UPDATE deletion_items SET state='deleted',error=NULL,released_bytes=? WHERE plan_id=? AND key=? AND state!='deleted'",
        ).bind(freed, planId, item.key),
      ]);
      await receipts?.delete(receiptKey).catch(() => {});
    } catch {
      failures.push({ key: item.key, error: "delete_or_verification_failed" });
      await env.DB.prepare(
        "UPDATE deletion_items SET state='failed',error='delete_or_verification_failed' WHERE plan_id=? AND key=?",
      )
        .bind(planId, item.key)
        .run();
    }
  }
  const totals = await env.DB.prepare(
    "SELECT COALESCE(SUM(released_bytes),0) AS released,SUM(CASE WHEN state!='deleted' THEN 1 ELSE 0 END) AS remaining FROM deletion_items WHERE plan_id=?",
  )
    .bind(planId)
    .first<{ released: number; remaining: number }>();
  const released = totals?.released ?? 0,
    remainingCount = totals?.remaining ?? 0;
  if (plan.kind === "video" && remainingCount === 0) {
    const leftovers = await objectsForPrefix(
      env,
      `videos/${video.id}/`,
      video.id,
      null,
      "video",
    );
    if (video.source_key?.startsWith(IMPORT_PREFIX)) {
      const source = await env.MEDIA.head(video.source_key);
      if (source)
        leftovers.push({
          key: source.key,
          bytes: source.size,
          etag: source.etag,
          videoId: video.id,
          versionId: null,
          category: "source",
        });
    }
    for (const item of leftovers)
      failures.push({
        key: item.key,
        error: "unconfirmed_new_object_requires_new_plan",
      });
  }
  const state = failures.length || remainingCount ? "partial" : "complete";
  const finalization: D1PreparedStatement[] = [];
  if (state === "complete") {
    if (plan.kind === "source" || plan.kind === "video")
      finalization.push(
        env.DB.prepare(
          "UPDATE videos SET source_key=NULL,source_etag=NULL,source_size=0,updated_at=? WHERE id=?",
        ).bind(now(), video.id),
      );
    if (plan.kind === "video")
      finalization.push(
        env.DB.prepare(
          "UPDATE videos SET published=0,current_version_id=NULL,status='deleted',updated_at=? WHERE id=?",
        ).bind(now(), video.id),
      );
    if (versionIds.length) {
      if (plan.kind !== "video")
        finalization.push(
          env.DB.prepare(
            "UPDATE versions SET state='deleted' WHERE id IN (SELECT value FROM json_each(?)) AND video_id=?",
          ).bind(JSON.stringify(versionIds), video.id),
        );
      finalization.push(
        env.DB.prepare(
          "UPDATE videos SET current_version_id=NULL,published=0,updated_at=? WHERE id=? AND current_version_id IN (SELECT value FROM json_each(?))",
        ).bind(now(), video.id, JSON.stringify(versionIds)),
      );
    }
    if (plan.kind === "video")
      finalization.push(
        env.DB.prepare(
          "UPDATE versions SET state='deleted' WHERE video_id=? AND id IN (SELECT value FROM json_each(?))",
        ).bind(video.id, JSON.stringify(versionIds)),
      );
  }
  finalization.push(
    env.DB.prepare(
      "UPDATE deletion_plans SET state=?,failure_json=?,released_bytes=?,updated_at=? WHERE id=?",
    ).bind(state, JSON.stringify(failures), released, now(), planId),
  );
  await env.DB.batch(finalization);
  await log(env, {
    stage: "deletion_verified",
    videoId: video.id,
    message: state,
    details: { planId, releasedBytes: released, failures: failures.length },
  });
  return json({ state, releasedBytes: released, failures, remainingCount });
}
export async function cancelDeletionPlan(env: Env, planId: string) {
  const plan = await env.DB.prepare("SELECT * FROM deletion_plans WHERE id=?")
    .bind(planId)
    .first<DeletionPlan>();
  if (!plan) throw new HttpError(404, "plan_missing", "删除请求不存在");
  if (["partial", "running"].includes(plan.state))
    throw new HttpError(
      409,
      "deletion_started",
      "文件删除已开始。为保留恢复能力，请继续完成原来的删除范围；关闭窗口会保留这条待办。",
    );
  if (plan.state !== "complete")
    await env.DB.prepare(
      "UPDATE deletion_plans SET state='cancelled',updated_at=? WHERE id=? AND state IN ('pending','building','cancelled')",
    )
      .bind(now(), planId)
      .run();
  return json({
    state: plan.state === "complete" ? "complete" : "cancelled",
    filesDeleted: false,
  });
}
export async function listDeletionPlans(request: Request, env: Env) {
  const page = Math.max(
    1,
    Math.min(
      100000,
      Math.floor(Number(new URL(request.url).searchParams.get("page")) || 1),
    ),
  );
  const unfinished = `p.state IN ('pending','running','partial') AND (EXISTS(SELECT 1 FROM deletion_items d WHERE d.plan_id=p.id AND d.state!='deleted') OR (p.kind='video' AND v.status!='deleted') OR (p.kind='source' AND v.source_key IS NOT NULL AND (json_type(p.scope_json,'$.sourceKey') IS NULL OR v.source_key=json_extract(p.scope_json,'$.sourceKey'))) OR EXISTS(SELECT 1 FROM versions r WHERE r.video_id=p.video_id AND r.state!='deleted' AND (r.id=json_extract(p.scope_json,'$.versionId') OR r.id IN (SELECT value FROM json_each(p.scope_json,'$.versionIds')))))`;
  const rows = await env.DB.prepare(
    `SELECT p.id,p.kind,p.video_id AS videoId,v.title AS videoTitle,p.state,p.expires_at AS expiresAt,p.scope_json AS scopeJson,p.released_bytes AS releasedBytes,p.created_at AS createdAt,COUNT(CASE WHEN i.state!='deleted' THEN 1 END) AS remainingCount FROM deletion_plans p LEFT JOIN deletion_items i ON i.plan_id=p.id LEFT JOIN videos v ON v.id=p.video_id WHERE ${unfinished} GROUP BY p.id ORDER BY p.created_at DESC LIMIT 50 OFFSET ?`,
  )
    .bind((page - 1) * 50)
    .all<{ id: string; state: string; expiresAt: number; scopeJson: string }>();
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM deletion_plans p LEFT JOIN videos v ON v.id=p.video_id WHERE ${unfinished}`,
  ).first<{ n: number }>();
  return json({
    items: rows.results.map(({ scopeJson, ...row }) => ({
      ...row,
      expired: row.state === "pending" && row.expiresAt <= now(),
      metadataOnly: JSON.parse(scopeJson).sourceReferenceOnly === true,
    })),
    page,
    pageSize: 50,
    total: count?.n ?? 0,
  });
}
export async function getDeletionPlan(env: Env, planId: string) {
  const plan = await env.DB.prepare("SELECT * FROM deletion_plans WHERE id=?")
    .bind(planId)
    .first<DeletionPlan>();
  if (!plan) throw new HttpError(404, "plan_missing", "删除请求不存在");
  const scope = JSON.parse(plan.scope_json) as DeletionScope;
  const items = await env.DB.prepare(
    "SELECT key,bytes,etag,video_id AS videoId,version_id AS versionId,category,state FROM deletion_items WHERE plan_id=? ORDER BY key",
  )
    .bind(planId)
    .all<ListedObject & { state: string }>();
  const video = await env.DB.prepare("SELECT * FROM videos WHERE id=?")
    .bind(plan.video_id)
    .first<Video>();
  const liveVersions = await versionsForVideo(env, plan.video_id);
  const metadataAction =
    plan.kind === "video"
      ? video?.status !== "deleted" && !!video
      : plan.kind === "source"
        ? !!video?.source_key &&
          (scope.sourceKey === undefined ||
            video.source_key === scope.sourceKey)
        : liveVersions.some(
            (v) => v.id === scope.versionId || scope.versionIds?.includes(v.id),
          );
  const noAction =
    plan.state !== "complete" &&
    items.results.every((item) => item.state === "deleted") &&
    !metadataAction;
  return json({
    plan: {
      id: plan.id,
      kind: plan.kind,
      videoId: plan.video_id,
      ...scope,
      noAction,
      objects: items.results.map((item) => ({
        ...item,
        missing: scope.missingKeys?.includes(item.key) ?? false,
      })),
      totalBytes: items.results.reduce(
        (n, o) => n + (scope.missingKeys?.includes(o.key) ? 0 : o.bytes),
        0,
      ),
      expiresAt: plan.expires_at,
      expired: plan.state === "pending" && plan.expires_at <= now(),
      state: plan.state,
      releasedBytes: plan.released_bytes,
      remainingCount: items.results.filter((o) => o.state !== "deleted").length,
      remainingBytes: items.results.reduce(
        (n, o) =>
          n +
          (o.state === "deleted" || scope.missingKeys?.includes(o.key)
            ? 0
            : o.bytes),
        0,
      ),
      failures: plan.failure_json ? JSON.parse(plan.failure_json) : [],
    },
  });
}
async function storageVideos(request: Request, env: Env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 200);
  const page = Math.max(
    1,
    Math.min(100000, Math.floor(Number(url.searchParams.get("page")) || 1)),
  );
  const videos = await env.DB.prepare(
    `SELECT v.id,v.title,v.source_name,v.source_key,v.source_size,v.published,v.current_version_id,v.status,v.updated_at,
    COALESCE((SELECT SUM(bytes) FROM objects WHERE video_id=v.id AND category='source' AND state='present'),0) AS sourceBytes,
    COALESCE((SELECT SUM(bytes) FROM objects WHERE video_id=v.id AND category!='source' AND state='present'),0) AS generatedBytes,
    COALESCE((SELECT SUM(reserved_bytes) FROM uploads WHERE video_id=v.id AND state NOT IN ('complete','cancelled','expired')),0) AS reservedBytes
    FROM videos v WHERE v.status!='deleted' AND (v.title LIKE ? OR v.source_name LIKE ? OR v.id LIKE ?) ORDER BY v.updated_at DESC LIMIT 30 OFFSET ?`,
  )
    .bind(`%${q}%`, `%${q}%`, `%${q}%`, (page - 1) * 30)
    .all<
      Video & {
        sourceBytes: number;
        generatedBytes: number;
        reservedBytes: number;
      }
    >();
  const ids = JSON.stringify(videos.results.map((v) => v.id));
  const versions = await env.DB.prepare(
    `SELECT r.id,r.video_id AS videoId,r.mode,r.state,r.quality,r.created_at AS createdAt,
    COALESCE(SUM(CASE WHEN o.state='present' THEN o.bytes ELSE 0 END),0) AS bytes,
    COUNT(CASE WHEN o.state='present' THEN 1 END) AS fileCount
    FROM versions r LEFT JOIN objects o ON o.version_id=r.id WHERE r.video_id IN (SELECT value FROM json_each(?)) AND r.state!='deleted' GROUP BY r.id ORDER BY r.created_at DESC`,
  )
    .bind(ids)
    .all<{
      id: string;
      videoId: string;
      mode: string;
      state: string;
      bytes: number;
      fileCount: number;
    }>();
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM videos WHERE status!='deleted' AND (title LIKE ? OR source_name LIKE ? OR id LIKE ?)",
  )
    .bind(`%${q}%`, `%${q}%`, `%${q}%`)
    .first<{ n: number }>();
  const summary = await env.DB.prepare(
    `SELECT
    COALESCE(SUM(CASE WHEN category='source' THEN bytes ELSE 0 END),0) AS sourceBytes,
    COALESCE(SUM(CASE WHEN category NOT IN ('source','branding') THEN bytes ELSE 0 END),0) AS generatedBytes,
    COALESCE(SUM(CASE WHEN category='branding' THEN bytes ELSE 0 END),0) AS otherBytes
    FROM objects WHERE state='present'`,
  ).first<{
    sourceBytes: number;
    generatedBytes: number;
    otherBytes: number;
  }>();
  const pending = await env.DB.prepare(
    "SELECT COALESCE(SUM(reserved_bytes),0) AS n FROM uploads WHERE state NOT IN ('complete','cancelled','expired')",
  ).first<{ n: number }>();
  return json({
    items: videos.results.map((video) => ({
      ...video,
      versions: versions.results
        .filter((v) => v.videoId === video.id)
        .map((v) => ({
          ...v,
          current: video.current_version_id === v.id,
          usesSource: v.mode === "source",
        })),
    })),
    total: count?.n ?? 0,
    page,
    pageSize: 30,
    summary: { ...summary, reservedBytes: pending?.n ?? 0 },
  });
}
export async function storageList(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.searchParams.get("view") === "videos")
    return storageVideos(request, env);
  const q = (url.searchParams.get("q") ?? "").slice(0, 200);
  const category = (url.searchParams.get("category") ?? "").slice(0, 30);
  const page = Math.max(
    1,
    Math.min(100000, Number(url.searchParams.get("page")) || 1),
  );
  const derived = `CASE
    WHEN o.category='source' THEN 'source'
    WHEN r.mode='faststart' AND r.state='verified' AND v.current_version_id=r.id THEN 'current_mp4'
    WHEN r.mode='faststart' AND r.state='verified' THEN 'historical_mp4'
    WHEN r.state='verified' AND v.current_version_id=r.id THEN 'current_hls'
    WHEN r.state='verified' THEN 'historical_hls'
    WHEN r.mode!='source' AND r.state IN ('failed','cancelled','timed_out','needs_confirmation') THEN 'failed_output'
    ELSE o.category END`;
  const where = `o.state='present' AND o.key LIKE ? AND (?='' OR ${derived}=?)`;
  const args = [`%${q}%`, category, category];
  const joins =
    "LEFT JOIN videos v ON v.id=o.video_id LEFT JOIN versions r ON r.id=o.version_id";
  const items = await env.DB.prepare(
    `SELECT o.*,${derived} AS category,v.published,v.current_version_id,CASE WHEN v.published=1 AND (v.current_version_id=o.version_id OR (o.category='source' AND EXISTS(SELECT 1 FROM versions sv WHERE sv.id=v.current_version_id AND sv.mode='source' AND sv.state='verified' AND json_valid(sv.validation_json) AND json_extract(sv.validation_json,'$.source.key')=o.key))) THEN 1 ELSE 0 END AS referenced FROM objects o ${joins} WHERE ${where} ORDER BY o.updated_at DESC LIMIT 50 OFFSET ?`,
  )
    .bind(...args, (page - 1) * 50)
    .all();
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM objects o ${joins} WHERE ${where}`,
  )
    .bind(...args)
    .first<{ n: number }>();
  const summaryRows = await env.DB.prepare(
    `SELECT ${derived} AS category,SUM(o.bytes) AS bytes FROM objects o ${joins} WHERE o.state='present' GROUP BY 1`,
  ).all<{ category: string; bytes: number }>();
  const pending = await env.DB.prepare(
    `SELECT COALESCE(SUM(reserved_bytes),0) AS n FROM uploads WHERE state NOT IN ('complete','cancelled','expired')`,
  ).first<{ n: number }>();
  const summary = Object.fromEntries(
    summaryRows.results.map((r) => [r.category, r.bytes]),
  );
  summary.incomplete_uploads = pending?.n ?? 0;
  return json({
    items: items.results,
    total: total?.n ?? 0,
    page,
    pageSize: 50,
    summary,
    notice: "索引占用可通过对账核验。删除不抵销当期累计存储计量。",
  });
}
export async function reconcileStorage(env: Env, cursor = "") {
  const indexed = await env.DB.prepare(
    `SELECT key,bytes,etag FROM objects WHERE state='present' AND key>? ORDER BY key LIMIT 101`,
  )
    .bind(cursor)
    .all<{ key: string; bytes: number; etag: string }>();
  const missingKeys: string[] = [];
  const page = indexed.results.slice(0, 100);
  for (const item of page) {
    const head = await env.MEDIA.head(item.key);
    if (!head || head.size !== item.bytes || head.etag !== item.etag)
      missingKeys.push(item.key);
  }
  // Keep the original inventory rows and revoke their proof atomically. Also
  // repair invalidation for missing rows recorded by earlier reconciliations.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE objects SET state='missing',updated_at=? WHERE key IN (SELECT value FROM json_each(?)) AND state='present'`,
    ).bind(now(), JSON.stringify(missingKeys)),
    env.DB.prepare(
      `UPDATE versions SET state=CASE WHEN state='verified' THEN 'objects_missing' ELSE state END,validation_json=NULL WHERE state!='deleted' AND id IN (SELECT DISTINCT version_id FROM objects WHERE state='missing' AND version_id IS NOT NULL)`,
    ),
    env.DB.prepare(
      `UPDATE videos SET published=0,status='objects_missing',updated_at=? WHERE current_version_id IN (SELECT DISTINCT version_id FROM objects WHERE state='missing' AND version_id IS NOT NULL)`,
    ).bind(now()),
    env.DB.prepare(
      "UPDATE versions SET state=CASE WHEN state='verified' THEN 'objects_missing' ELSE state END,validation_json=NULL WHERE mode='source' AND state!='deleted' AND CASE WHEN json_valid(validation_json) THEN json_extract(validation_json,'$.source.key') END IN (SELECT key FROM objects WHERE category='source' AND state='missing')",
    ),
    env.DB.prepare(
      "UPDATE videos SET published=0,status='objects_missing',updated_at=? WHERE current_version_id IN (SELECT id FROM versions WHERE mode='source' AND state='objects_missing')",
    ).bind(now()),
  ]);
  const missing = missingKeys.length;
  await log(env, {
    stage: "storage_reconcile",
    message: "R2 objects reconciled",
    details: { checked: page.length, missing },
  });
  return json({
    checked: page.length,
    missing,
    hasMore: indexed.results.length > 100,
    nextCursor: indexed.results.length > 100 ? page.at(-1)?.key : null,
  });
}
