import type { Env, Version } from "./types";
import { body, HttpError, json, now, textValue } from "./http";
import { log } from "./logs";
import { verifyVersionObjects } from "./inventory";
import { validateMp4Attestation } from "./source";
export async function readPublicationRevision(
  env: Env,
  videoId: string,
): Promise<number> {
  const video = await env.DB.prepare(
    "SELECT publication_revision,status FROM videos WHERE id=?",
  )
    .bind(videoId)
    .first<{ publication_revision: number; status: string }>();
  if (!video || video.status === "deleted")
    throw new HttpError(404, "video_missing", "视频不存在或已删除");
  if (
    !Number.isSafeInteger(video.publication_revision) ||
    video.publication_revision < 0
  )
    throw new HttpError(
      503,
      "publication_revision_invalid",
      "发布状态无法核实，请稍后重试",
    );
  return video.publication_revision;
}

export async function publishVideo(
  request: Request,
  env: Env,
  videoId: string,
  expectedPublicationRevision?: number,
) {
  // Direct callers capture intent before consuming a possibly slow body;
  // routed requests carry the trusted snapshot taken before queue admission.
  const revision =
    expectedPublicationRevision ??
    (await readPublicationRevision(env, videoId));
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new HttpError(
      409,
      "publication_revoked",
      "旧发布请求已被撤销，请重新明确发布",
    );
  const input = await body(request);
  const versionId = textValue(input.versionId, "版本 ID", 64);
  if (revision !== (await readPublicationRevision(env, videoId)))
    throw new HttpError(
      409,
      "publication_revoked",
      "旧发布请求已被撤销，请重新明确发布",
    );
  const version = await env.DB.prepare(
    `SELECT * FROM versions WHERE id=? AND video_id=? AND state='verified'`,
  )
    .bind(versionId, videoId)
    .first<Version>();
  if (!version?.manifest || !version.validation_json)
    throw new HttpError(
      409,
      "version_unverified",
      "只能发布完整校验通过的版本",
    );
  await verifyVersionObjects(env, version);
  const publish = env.DB.prepare(
    `UPDATE videos SET published=1,current_version_id=?,status='ready',updated_at=?,publication_revision=publication_revision+1 WHERE id=? AND publication_revision=? AND status!='deleted' AND EXISTS(SELECT 1 FROM versions WHERE id=? AND video_id=? AND state='verified' AND validation_json=?)`,
  ).bind(
    versionId,
    now(),
    videoId,
    revision,
    versionId,
    videoId,
    version.validation_json,
  );
  if (version.mode === "faststart") {
    let attestation;
    try {
      attestation = validateMp4Attestation(
        input.attestation,
        Number(version.duration),
      );
    } catch {
      throw new HttpError(
        400,
        "mp4_attestation_required",
        "请实际确认优化 MP4 的播放、音画与拖动结果",
      );
    }
    const validation = JSON.parse(version.validation_json!);
    const attestedValidation = JSON.stringify({
      ...validation,
      administratorAttestation: {
        ...attestation,
        versionId,
        basis: "administrator-browser-playback-and-seek",
        confirmedAt: now(),
      },
    });
    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE versions SET validation_json=? WHERE id=? AND video_id=? AND state='verified' AND validation_json=? AND EXISTS(SELECT 1 FROM videos WHERE id=? AND publication_revision=? AND status!='deleted')",
      ).bind(
        attestedValidation,
        versionId,
        videoId,
        version.validation_json,
        videoId,
        revision,
      ),
      env.DB.prepare(
        "UPDATE videos SET published=1,current_version_id=?,status='ready',updated_at=?,publication_revision=publication_revision+1 WHERE id=? AND publication_revision=? AND status!='deleted' AND changes()=1 AND EXISTS(SELECT 1 FROM versions WHERE id=? AND video_id=? AND state='verified' AND validation_json=?)",
      ).bind(
        versionId,
        now(),
        videoId,
        revision,
        versionId,
        videoId,
        attestedValidation,
      ),
    ]);
    if (results.some((result) => result.meta.changes !== 1))
      throw new HttpError(
        409,
        "publication_revoked",
        "旧发布请求已被撤销或条件已变化，请重新预览并明确发布",
      );
  } else if ((await publish.run()).meta.changes !== 1)
    throw new HttpError(
      409,
      "publication_revoked",
      "旧发布请求已被撤销或条件已变化，请重新明确发布",
    );
  await log(env, {
    stage: "published",
    videoId,
    message:
      version.mode === "source"
        ? "管理员明确发布原片 MP4 版本；播放与拖动依据管理员确认"
        : version.mode === "faststart"
          ? "管理员核对播放、音画和拖动后明确发布独立优化 MP4 版本"
          : "管理员明确发布已验证 HLS 版本",
    details: {
      versionId,
      mediaKind:
        version.mode === "source"
          ? "source"
          : version.mode === "faststart"
            ? "mp4"
            : "hls",
    },
  });
  return json({ published: true, versionId });
}
