import type { Env, Upload, Video } from "./types";
import {
  body,
  HttpError,
  id,
  intValue,
  json,
  now,
  readRequestBytes,
  sha256,
  textValue,
} from "./http";
import { requireStorageBudget, uploadResourceAmounts } from "./billing";
import { log } from "./logs";

export const PART_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 ** 3;
const EXPIRY_MS = 48 * 3600 * 1000;

interface UploadFileIdentity {
  name: string;
  title: string;
  size: number;
  fingerprint: string;
}
function fileIdentity(data: Record<string, unknown>): UploadFileIdentity {
  const name = textValue(data.name, "文件名", 240);
  const title = textValue(data.title ?? name, "标题");
  const size = intValue(data.size, 1, MAX_FILE_BYTES);
  const fingerprint = textValue(data.fingerprint, "文件指纹", 64);
  if (!/^[0-9a-f]{64}$/.test(fingerprint))
    throw new HttpError(400, "invalid_fingerprint", "文件指纹必须为 SHA-256");
  return { name, title, size, fingerprint };
}
async function reusableUpload(env: Env, file: UploadFileIdentity) {
  const upload = await env.DB.prepare(
    `SELECT u.* FROM uploads u JOIN videos v ON v.id=u.video_id
     WHERE u.fingerprint=? AND u.expected_size=? AND v.source_name=?
     AND u.state IN ('creating','uploading','cancelling','completing','complete','unknown')
     ORDER BY u.created_at DESC LIMIT 1`,
  )
    .bind(file.fingerprint, file.size, file.name)
    .first<Upload>();
  return upload &&
    (upload.state !== "complete" || (await currentCompletedSource(env, upload)))
    ? upload
    : null;
}
/** Retire only unused historical permissions. Existing multipart reservations stay intact. */
export async function expireUploadApprovals(env: Env) {
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE reservations SET state='released',released_at=? WHERE kind='upload_approval' AND state='reserved'",
    ).bind(timestamp),
    env.DB.prepare(
      "UPDATE upload_approval_files SET reserved_bytes=0,claim_token=NULL WHERE reserved_bytes>0 OR claim_token IS NOT NULL",
    ),
    env.DB.prepare(
      "UPDATE upload_approvals SET state='expired',expires_at=MIN(expires_at,?) WHERE state!='expired'",
    ).bind(timestamp),
  ]);
}

export async function uploadSpace(env: Env) {
  const snapshot = await requireStorageBudget(env, 0);
  const usedBytes = Math.max(
    snapshot.project.storedBytes!,
    snapshot.project.actualBytes!,
  );
  return json({
    usedBytes,
    reservedBytes: snapshot.project.reservedBytes,
    limitBytes: snapshot.policy.storageLimitBytes,
    availableBytes: Math.max(
      0,
      snapshot.policy.storageLimitBytes -
        usedBytes -
        snapshot.project.reservedBytes,
    ),
    checkedAt: snapshot.fetchedAt,
    source: "project-r2-and-reservations",
  });
}

// Recheck the current D1 counters in the same transaction as admission. The R2
// census is a lower bound on current physical occupancy, while the directory is
// also counted conservatively. All callers run under the account Coordinator.
const STORAGE_FENCE = `MAX((SELECT COALESCE(SUM(bytes),0) FROM objects WHERE state='present'),?)
  + (SELECT COALESCE(SUM(reserved_bytes),0) FROM uploads WHERE state NOT IN ('complete','cancelled','expired'))
  + (SELECT COALESCE(SUM(COALESCE(json_extract(amounts_json,'$.r2CurrentBytes'),0)),0) FROM reservations WHERE kind!='upload_approval' AND state NOT IN ('released','reconciled'))
  + ? <= MIN(?,CAST(COALESCE((SELECT value FROM settings WHERE key='storage_limit_bytes'),?) AS INTEGER))`;
function fenceValues(
  snapshot: Awaited<ReturnType<typeof requireStorageBudget>>,
  bytes: number,
) {
  return [
    snapshot.project.actualBytes ?? snapshot.project.storedBytes,
    bytes,
    snapshot.policy.storageLimitBytes,
    snapshot.policy.storageLimitBytes,
  ];
}

async function currentCompletedSource(
  env: Env,
  upload: Upload,
): Promise<Video | null> {
  const video = await env.DB.prepare("SELECT * FROM videos WHERE id=?")
    .bind(upload.video_id)
    .first<Video>();
  if (
    !video ||
    video.status === "deleted" ||
    video.source_key !== upload.object_key ||
    video.source_size !== upload.expected_size ||
    !video.source_etag
  )
    return null;
  const [indexed, head] = await Promise.all([
    env.DB.prepare(
      "SELECT video_id,category,bytes,etag,state FROM objects WHERE key=?",
    )
      .bind(upload.object_key)
      .first<{
        video_id: string;
        category: string;
        bytes: number;
        etag: string | null;
        state: string;
      }>(),
    env.MEDIA.head(upload.object_key),
  ]);
  if (
    !indexed ||
    indexed.video_id !== video.id ||
    indexed.category !== "source" ||
    indexed.state !== "present" ||
    indexed.bytes !== upload.expected_size ||
    !head ||
    head.size !== upload.expected_size ||
    head.etag !== video.source_etag ||
    indexed.etag !== head.etag ||
    head.customMetadata?.upload_id !== upload.id ||
    head.customMetadata?.video_id !== video.id ||
    head.customMetadata?.source_revision !== video.source_revision
  )
    return null;
  return video;
}
export async function uploadParts(env: Env, uploadId: string) {
  return (
    await env.DB.prepare(
      "SELECT number,size,etag,sha256 FROM upload_parts WHERE upload_id=? ORDER BY number",
    )
      .bind(uploadId)
      .all()
  ).results;
}
export async function createUpload(request: Request, env: Env) {
  const data = await body(request);
  const file = fileIdentity(data);
  const { name, title, size, fingerprint } = file;
  const existing = await reusableUpload(env, file);
  if (existing)
    return json({
      upload: existing,
      parts: await uploadParts(env, existing.id),
      reused: true,
      additionalBytes: 0,
    });
  // Old clients may still send an approvalId. It is deliberately ignored: an
  // expired account-risk permission cannot block or authorize ordinary upload.
  await expireUploadApprovals(env);
  const snapshot = await requireStorageBudget(env, size);
  const uploadId = id(),
    videoId = id(),
    revision = id(),
    key = `videos/${videoId}/source/${revision}`;
  const created = now();
  const admission = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO videos(id,title,source_size,source_revision,source_name,created_at,updated_at) SELECT ?,?,?,?,?,?,? WHERE ${STORAGE_FENCE}`,
    ).bind(
      videoId,
      title,
      size,
      revision,
      name,
      created,
      created,
      ...fenceValues(snapshot, size),
    ),
    env.DB.prepare(
      `INSERT INTO uploads(id,video_id,object_key,fingerprint,expected_size,state,reserved_bytes,expires_at,created_at,updated_at) SELECT ?,?,?,?,?,'creating',?,?,?,? WHERE EXISTS(SELECT 1 FROM videos WHERE id=?)`,
    ).bind(
      uploadId,
      videoId,
      key,
      fingerprint,
      size,
      size,
      created + EXPIRY_MS,
      created,
      created,
      videoId,
    ),
    env.DB.prepare(
      `INSERT INTO reservations(id,owner_id,kind,snapshot_id,period_start,amounts_json,state,created_at) SELECT ?,?,'upload',NULL,NULL,?,'reserved',? WHERE EXISTS(SELECT 1 FROM uploads WHERE id=?)`,
    ).bind(
      id(),
      uploadId,
      JSON.stringify(uploadResourceAmounts(size)),
      created,
      uploadId,
    ),
  ]);
  if (admission[0].meta.changes !== 1) {
    const replay = await reusableUpload(env, file);
    if (replay)
      return json({
        upload: replay,
        parts: await uploadParts(env, replay.id),
        reused: true,
        additionalBytes: 0,
      });
    throw new HttpError(
      409,
      "storage_limit",
      "项目占用或上传预留已变化，未创建新上传；请刷新空间信息",
    );
  }
  try {
    const multipart = await env.MEDIA.createMultipartUpload(key, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        upload_id: uploadId,
        video_id: videoId,
        source_revision: revision,
      },
    });
    await env.DB.prepare(
      `UPDATE uploads SET multipart_id=?,state='uploading',updated_at=? WHERE id=?`,
    )
      .bind(multipart.uploadId, now(), uploadId)
      .run();
  } catch {
    // Unknown create outcome may leave an incomplete remote upload; retain reservation for reconciliation.
    await env.DB.prepare(
      `UPDATE uploads SET state='unknown',error='multipart_create_unverified',updated_at=? WHERE id=?`,
    )
      .bind(now(), uploadId)
      .run();
    throw new HttpError(
      503,
      "upload_unknown",
      "上传创建结果未核实，预留空间保留，请在存储管理中核对",
    );
  }
  const upload = await env.DB.prepare("SELECT * FROM uploads WHERE id=?")
    .bind(uploadId)
    .first<Upload>();
  return json({ upload, parts: [], reused: false, additionalBytes: size }, 201);
}
async function getUpload(env: Env, uploadId: string) {
  const upload = await env.DB.prepare("SELECT * FROM uploads WHERE id=?")
    .bind(uploadId)
    .first<Upload>();
  if (!upload) throw new HttpError(404, "upload_missing", "上传任务不存在");
  return upload;
}
export async function putPart(
  request: Request,
  env: Env,
  uploadId: string,
  number: number,
  preloaded?: Uint8Array,
) {
  const upload = await getUpload(env, uploadId);
  if (
    upload.state !== "uploading" ||
    !upload.multipart_id ||
    upload.expires_at < now()
  )
    throw new HttpError(409, "upload_state", "上传不在可继续状态");
  const count = Math.ceil(upload.expected_size / PART_BYTES);
  intValue(number, 1, count);
  const expected =
    number === count
      ? upload.expected_size - PART_BYTES * (count - 1)
      : PART_BYTES;
  const claimed = request.headers.get("X-Part-SHA256");
  if (!claimed || !/^[0-9a-f]{64}$/.test(claimed))
    throw new HttpError(400, "hash_required", "分片校验和缺失");
  const buffer =
    preloaded ??
    (await readRequestBytes(request, PART_BYTES, {
      idleTimeoutMs: 30000,
      totalTimeoutMs: 5 * 60 * 1000,
    }));
  const bytes = buffer.byteLength;
  if (bytes > expected)
    throw new HttpError(413, "part_size", "实际分片超出允许字节数");
  if (bytes !== expected)
    throw new HttpError(400, "part_size", "实际分片字节数与预期不符");
  const digest = await sha256(buffer);
  if (digest !== claimed)
    throw new HttpError(400, "part_hash", "分片校验失败，请重试");
  const previous = await env.DB.prepare(
    "SELECT number,size,etag,sha256 FROM upload_parts WHERE upload_id=? AND number=?",
  )
    .bind(uploadId, number)
    .first<{ sha256: string }>();
  if (previous) {
    if (previous.sha256 !== digest)
      throw new HttpError(409, "part_conflict", "重复分片内容不一致");
    return json(previous);
  }
  if (request.signal.aborted)
    throw new HttpError(408, "request_aborted", "请求已中断，请重试");
  const result = await env.MEDIA.resumeMultipartUpload(
    upload.object_key,
    upload.multipart_id,
  ).uploadPart(number, buffer);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO upload_parts(upload_id,number,size,etag,sha256) VALUES(?,?,?,?,?)",
    ).bind(uploadId, number, bytes, result.etag, digest),
    env.DB.prepare(
      "UPDATE uploads SET updated_at=?,expires_at=? WHERE id=?",
    ).bind(now(), now() + EXPIRY_MS, uploadId),
  ]);
  return json({ number, size: bytes, etag: result.etag, sha256: digest });
}
async function registerSource(env: Env, upload: Upload, object: R2Object) {
  if (
    object.size !== upload.expected_size ||
    object.customMetadata?.upload_id !== upload.id
  )
    throw new HttpError(409, "object_conflict", "原片对象与上传任务不一致");
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE uploads SET state='complete',reserved_bytes=0,error=NULL,updated_at=? WHERE id=?`,
    ).bind(now(), upload.id),
    env.DB.prepare(
      `UPDATE videos SET source_key=?,source_etag=?,source_size=?,status=CASE WHEN status IN ('uploading','upload_cancelled') THEN 'unprocessed' ELSE status END,updated_at=? WHERE id=?`,
    ).bind(upload.object_key, object.etag, object.size, now(), upload.video_id),
    env.DB.prepare(
      `INSERT INTO objects(key,video_id,category,bytes,etag,updated_at) VALUES(?,?,'source',?,?,?) ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes,etag=excluded.etag,state='present',updated_at=excluded.updated_at`,
    ).bind(upload.object_key, upload.video_id, object.size, object.etag, now()),
    env.DB.prepare(
      `UPDATE reservations SET state='consumed' WHERE owner_id=? AND kind='upload' AND state='reserved'`,
    ).bind(upload.id),
  ]);
  return json({
    video: await env.DB.prepare("SELECT * FROM videos WHERE id=?")
      .bind(upload.video_id)
      .first<Video>(),
  });
}
export async function completeUpload(env: Env, uploadId: string) {
  const upload = await getUpload(env, uploadId);
  if (upload.state === "complete") {
    const video = await currentCompletedSource(env, upload);
    if (!video)
      throw new HttpError(
        409,
        "completed_source_changed",
        "已完成的原片已变化或被删除，请重试建立新的上传。旧播放版本会保留。",
      );
    return json({ video });
  }
  const head = await env.MEDIA.head(upload.object_key);
  if (head) return registerSource(env, upload, head);
  if (
    !["uploading", "completing"].includes(upload.state) ||
    !upload.multipart_id
  )
    throw new HttpError(409, "upload_state", "上传无法完成");
  const parts = await env.DB.prepare(
    "SELECT number,size,etag FROM upload_parts WHERE upload_id=? ORDER BY number",
  )
    .bind(uploadId)
    .all<{ number: number; size: number; etag: string }>();
  if (
    parts.results.length !== Math.ceil(upload.expected_size / PART_BYTES) ||
    parts.results.reduce((n, p) => n + p.size, 0) !== upload.expected_size ||
    parts.results.some((p, i) => p.number !== i + 1)
  )
    throw new HttpError(409, "parts_missing", "分片尚未上传完整");
  await env.DB.prepare(
    `UPDATE uploads SET state='completing',updated_at=? WHERE id=?`,
  )
    .bind(now(), uploadId)
    .run();
  try {
    const object = await env.MEDIA.resumeMultipartUpload(
      upload.object_key,
      upload.multipart_id,
    ).complete(
      parts.results.map((p) => ({ partNumber: p.number, etag: p.etag })),
    );
    return await registerSource(env, upload, object);
  } catch {
    const recovered = await env.MEDIA.head(upload.object_key);
    if (recovered) return registerSource(env, upload, recovered);
    throw new HttpError(
      503,
      "completion_unverified",
      "完成上传结果未核实；请重试，不会创建第二个原片",
    );
  }
}
interface UploadAbortReceipt {
  version: 1;
  uploadId: string;
  videoId: string;
  objectKey: string;
  multipartId: string;
  expectedBytes: number;
  sourceRevision: string;
  abortVerified: true;
  objectAbsent: true;
  verifiedAt: number;
}
/** Maintenance only; called inside the same Coordinator tail as part writes. */
export async function cancelExpiredUpload(
  env: Env,
  uploadId: string,
  receipts?: DurableObjectStorage,
) {
  // A scan outside the queue cannot authorize a later abort: an in-flight part
  // may have completed and renewed this upload while maintenance was waiting.
  const upload = await getUpload(env, uploadId);
  if (!Number.isSafeInteger(upload.expires_at))
    throw new HttpError(
      409,
      "abort_unverified",
      "上传到期时间无法核验，保留预留",
    );
  if (upload.expires_at >= now())
    return json({ skipped: true, notExpired: true, reason: "not_expired" });
  // Keep this predicate aligned with maintenance's bounded candidate scan.
  const eligible =
    ["uploading", "cancelling", "completing"].includes(upload.state) ||
    (["unknown", "creating"].includes(upload.state) &&
      typeof upload.multipart_id === "string" &&
      upload.multipart_id.length > 0);
  if (!eligible) return json({ skipped: true, reason: "not_eligible" });
  return cancelUpload(env, uploadId, receipts);
}
export async function cancelUpload(
  env: Env,
  uploadId: string,
  receipts?: DurableObjectStorage,
) {
  const upload = await getUpload(env, uploadId);
  const receiptKey = `upload-abort:${upload.id}`;
  if (upload.state === "cancelled") {
    await receipts?.delete(receiptKey).catch(() => {});
    return json({ cancelled: true, abortVerified: true });
  }
  const protectCompletedSource = async (object: R2Object) => {
    await registerSource(env, upload, object);
    throw new HttpError(
      409,
      "already_complete",
      "原片已上传完成。要删除文件，请到存储管理中选择这个视频并确认删除范围",
    );
  };
  const object = await env.MEDIA.head(upload.object_key);
  if (object) return protectCompletedSource(object);
  if (!upload.multipart_id)
    throw new HttpError(
      409,
      "abort_unverified",
      "上传状态尚未核实，暂时保留空间预留",
    );
  const video = await env.DB.prepare(
    "SELECT source_revision FROM videos WHERE id=?",
  )
    .bind(upload.video_id)
    .first<{ source_revision: string }>();
  if (!video?.source_revision)
    throw new HttpError(
      409,
      "abort_unverified",
      "原片修订无法核对，不能释放预留",
    );
  await env.DB.prepare(
    `UPDATE uploads SET state='cancelling',updated_at=? WHERE id=?`,
  )
    .bind(now(), uploadId)
    .run();
  try {
    const saved = await receipts?.get<UploadAbortReceipt>(receiptKey);
    if (saved !== undefined) {
      if (
        !saved ||
        saved.version !== 1 ||
        saved.uploadId !== upload.id ||
        saved.videoId !== upload.video_id ||
        saved.objectKey !== upload.object_key ||
        saved.multipartId !== upload.multipart_id ||
        saved.expectedBytes !== upload.expected_size ||
        saved.sourceRevision !== video.source_revision ||
        saved.abortVerified !== true ||
        saved.objectAbsent !== true ||
        !Number.isSafeInteger(saved.verifiedAt) ||
        saved.verifiedAt <= 0 ||
        saved.verifiedAt > now()
      )
        throw new Error("abort_receipt_mismatch");
    } else {
      await env.MEDIA.resumeMultipartUpload(
        upload.object_key,
        upload.multipart_id,
      ).abort();
    }
    // Even a matching receipt cannot authorize cancellation of an object that
    // has appeared since the verified abort. Never delete a completed source.
    const completed = await env.MEDIA.head(upload.object_key);
    if (completed) return await protectCompletedSource(completed);
    if (saved === undefined && receipts)
      await receipts.put(receiptKey, {
        version: 1,
        uploadId: upload.id,
        videoId: upload.video_id,
        objectKey: upload.object_key,
        multipartId: upload.multipart_id,
        expectedBytes: upload.expected_size,
        sourceRevision: video.source_revision,
        abortVerified: true,
        objectAbsent: true,
        verifiedAt: now(),
      } satisfies UploadAbortReceipt);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE uploads SET state='cancelled',reserved_bytes=0,error=NULL,updated_at=? WHERE id=?`,
      ).bind(now(), uploadId),
      env.DB.prepare(
        `UPDATE videos SET status='upload_cancelled',updated_at=? WHERE id=? AND source_key IS NULL`,
      ).bind(now(), upload.video_id),
      // Operations already performed remain charged. Retain their conservative ledger bound.
      env.DB.prepare(
        `UPDATE reservations SET state='consumed',amounts_json=json_remove(amounts_json,'$.r2StorageGbMonths','$.r2CurrentBytes') WHERE owner_id=? AND kind='upload'`,
      ).bind(upload.id),
    ]);
    const cancelled = await getUpload(env, uploadId);
    if (cancelled.state !== "cancelled") throw new Error("cancel_unverified");
    await receipts?.delete(receiptKey).catch(() => {});
  } catch (error) {
    if (error instanceof HttpError && error.code === "already_complete")
      throw error;
    await env.DB.prepare(
      `UPDATE uploads SET error='abort_unverified',updated_at=? WHERE id=? AND state NOT IN ('cancelled','complete')`,
    )
      .bind(now(), uploadId)
      .run();
    throw new HttpError(
      503,
      "abort_unverified",
      "取消结果尚未核实，请重试核对；未核实前保留空间预留",
    );
  }
  // Logging failure must not turn a proven, committed cancellation into an
  // unknown abort or discard its successful retry result.
  await log(env, {
    stage: "upload_abort_verified",
    videoId: upload.video_id,
    message:
      "R2 abort evidence and current object absence verified; cancellation committed under the coordinator lock",
  }).catch(() => {});
  return json({ cancelled: true, abortVerified: true });
}
