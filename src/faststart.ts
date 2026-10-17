import type { Env, Version } from "./types";
import { HttpError, now, readRequestBytes } from "./http";
import { inspectSourceMp4 } from "./source-mp4";
import { streamMp4Object } from "./mp4-response";
import { validateMp4Attestation } from "./source";

async function readBefore<T>(
  promise: Promise<T>,
  deadline: number,
  discard?: (value: T) => void,
): Promise<T> {
  const timeout = () =>
    new HttpError(503, "mp4_check_timeout", "优化 MP4 核对超时，请稍后重试");
  if (now() >= deadline) {
    void promise.then((value) => discard?.(value)).catch(() => {});
    throw timeout();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  try {
    const result = await Promise.race([
      promise.then((value) => {
        if (finished) discard?.(value);
        return value;
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new HttpError(
                503,
                "mp4_check_timeout",
                "优化 MP4 核对超时，请稍后重试",
              ),
            ),
          Math.max(0, deadline - now()),
        );
      }),
    ]);
    if (now() >= deadline) {
      discard?.(result);
      throw timeout();
    }
    return result;
  } finally {
    finished = true;
    clearTimeout(timer);
  }
}

export async function inspectFaststartObject(
  env: Env,
  head: R2Object,
  options: { deadlineAt?: number } = {},
) {
  const deadline = Math.min(now() + 20000, options.deadlineAt ?? Infinity);
  const remaining = () => {
    if (now() >= deadline)
      throw new HttpError(
        503,
        "mp4_check_timeout",
        "优化 MP4 核对超时，请稍后重试",
      );
    return deadline - now();
  };
  const probe = await inspectSourceMp4(
    head.size,
    async (offset, length) => {
      remaining();
      const object = await readBefore(
        env.MEDIA.get(head.key, {
          onlyIf: { etagMatches: head.etag },
          range: { offset, length },
        }),
        deadline,
        (object) => {
          if (object && "body" in object)
            void object.body.cancel().catch(() => {});
        },
      );
      if (
        !object ||
        !("body" in object) ||
        object.key !== head.key ||
        object.etag !== head.etag ||
        object.size !== head.size ||
        !object.range ||
        !("offset" in object.range) ||
        !("length" in object.range) ||
        object.range.offset !== offset ||
        object.range.length !== length
      ) {
        if (object && "body" in object)
          void object.body.cancel().catch(() => {});
        throw new HttpError(409, "mp4_changed", "优化 MP4 对象在检查时变化");
      }
      const bytes = await readRequestBytes(
        new Request("https://internal/mp4-metadata", {
          method: "POST",
          body: object.body,
          duplex: "half",
        } as RequestInit),
        length,
        {
          idleTimeoutMs: Math.min(5000, remaining()),
          totalTimeoutMs: remaining(),
        },
      );
      if (bytes.length !== length) throw new Error("mp4_range_incomplete");
      return bytes;
    },
    // Optimized output remains the separately quoted, non-fragmented format.
    { allowMono: true, allowFragmented: false },
  );
  if (!probe.compatible || probe.index?.placement !== "before-media")
    throw new HttpError(
      409,
      "mp4_incomplete",
      "优化 MP4 的兼容结构或前置索引未核实",
    );
  const after = await readBefore(env.MEDIA.head(head.key), deadline);
  if (!after || after.etag !== head.etag || after.size !== head.size)
    throw new HttpError(409, "mp4_changed", "优化 MP4 对象在检查时变化");
  return probe;
}

export async function verifyFaststartVersion(
  env: Env,
  version: Version,
  options: { inspectStructure?: boolean; requireAttestation?: boolean } = {},
) {
  const deadline = now() + 20000;
  let validation:
    | (Record<string, unknown> & {
        administratorAttestation?: Record<string, unknown>;
      })
    | undefined;
  try {
    validation = JSON.parse(version.validation_json ?? "null");
  } catch {
    /* fail closed */
  }
  if (
    version.mode !== "faststart" ||
    version.state !== "verified" ||
    version.manifest !== "optimized.mp4" ||
    version.prefix !== `videos/${version.video_id}/versions/${version.id}/` ||
    validation?.outputKind !== "mp4" ||
    validation.faststartVerified !== true ||
    validation.allPacketsDecoded !== true ||
    validation.packetTimelinesVerified !== true ||
    validation.codecAndResolutionVerified !== true ||
    validation.copiedStreamsVerified !== true ||
    validation.mediaMetadataPreserved !== true ||
    validation.r2PutChecksumsVerified !== true ||
    validation.completionR2EtagsSizesVerified !== true ||
    validation.actualR2Objects !== 1 ||
    typeof validation.verifiedAt !== "number" ||
    !Number.isSafeInteger(validation.verifiedAt) ||
    validation.verifiedAt <= 0 ||
    validation.verifiedAt > now() ||
    !Number.isSafeInteger(version.bytes) ||
    version.bytes <= 0 ||
    !Number.isFinite(version.duration) ||
    Number(version.duration) <= 0
  )
    throw new HttpError(409, "mp4_unverified", "优化 MP4 完整校验证据不足");
  const structure = validation.mp4Structure as
    Record<string, unknown> | undefined;
  if (
    structure?.compatible !== true ||
    structure.serverDecoded !== false ||
    structure.validationBasis !== "bounded-iso-bmff-metadata" ||
    (structure.index as { placement?: string } | undefined)?.placement !==
      "before-media" ||
    ![null, "mp4a.40.2"].includes(structure.audioCodec as string | null)
  )
    throw new HttpError(
      409,
      "mp4_unverified",
      "优化 MP4 的独立结构校验记录不完整",
    );
  const finiteWithin = (value: unknown, bound: number) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= bound;
  const copied = validation.copiedStreams;
  if (
    !finiteWithin(validation.durationDifferenceSeconds, 0.25) ||
    !finiteWithin(validation.syncOffsetDifferenceSeconds, 0.15) ||
    !finiteWithin(validation.syncEndOffsetDifferenceSeconds, 0.25) ||
    !Array.isArray(copied) ||
    copied.length < 1 ||
    copied.length > 2 ||
    copied.some((stream) => stream?.type === "audio") !==
      (structure.audioCodec !== null) ||
    !copied.some((stream) => stream?.type === "video") ||
    new Set(copied.map((stream) => stream?.type)).size !== copied.length ||
    copied.some(
      (stream) =>
        !stream ||
        !["video", "audio"].includes(stream.type) ||
        !Number.isSafeInteger(stream.packets) ||
        stream.packets <= 0 ||
        stream.outputPackets !== stream.packets ||
        !/^[a-f0-9]{64}$/.test(stream.sha256) ||
        stream.outputSha256 !== stream.sha256,
    )
  )
    throw new HttpError(
      409,
      "mp4_unverified",
      "优化 MP4 编码数据与时间轴保留证据不足",
    );
  if (options.requireAttestation) {
    const evidence = validation.administratorAttestation;
    if (
      evidence?.basis !== "administrator-browser-playback-and-seek" ||
      evidence.versionId !== version.id ||
      typeof evidence.confirmedAt !== "number" ||
      !Number.isSafeInteger(evidence.confirmedAt) ||
      evidence.confirmedAt <= 0 ||
      evidence.confirmedAt > now()
    )
      throw new HttpError(
        409,
        "mp4_attestation_required",
        "优化 MP4 尚未完成管理员播放确认",
      );
    validateMp4Attestation(evidence, Number(version.duration));
  }
  const rows = await env.DB.prepare(
    "SELECT key,bytes,etag,sha256,state,category FROM objects WHERE version_id=?",
  )
    .bind(version.id)
    .all<{
      key: string;
      bytes: number;
      etag: string;
      sha256: string;
      state: string;
      category: string;
    }>();
  const object = rows.results[0];
  if (
    rows.results.length !== 1 ||
    object?.key !== version.prefix + "optimized.mp4" ||
    object.bytes !== version.bytes ||
    object.state !== "present" ||
    object.category !== "mp4" ||
    !object.etag ||
    !/^[a-f0-9]{64}$/.test(object.sha256)
  )
    throw new HttpError(409, "mp4_incomplete", "优化 MP4 对象登记不完整");
  const head = await readBefore(env.MEDIA.head(object.key), deadline);
  if (
    !head ||
    head.size !== object.bytes ||
    head.etag !== object.etag ||
    (head.checksums?.sha256 &&
      [...new Uint8Array(head.checksums.sha256)]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("") !== object.sha256)
  )
    throw new HttpError(409, "mp4_changed", "优化 MP4 实际对象缺失或变化");
  if (options.inspectStructure) {
    const page = await readBefore(
      env.MEDIA.list({ prefix: version.prefix, limit: 2 }),
      deadline,
    );
    const actual = page.objects;
    if (
      page.truncated ||
      actual.length !== 1 ||
      actual[0].key !== object.key ||
      actual[0].size !== head.size ||
      actual[0].etag !== head.etag
    )
      throw new HttpError(409, "mp4_incomplete", "优化 MP4 实际目录不完整");
    const probe = await inspectFaststartObject(env, head, {
      deadlineAt: deadline,
    });
    if (
      !probe.durationSeconds ||
      Math.abs(probe.durationSeconds - Number(version.duration)) > 0.25 ||
      probe.audioCodec !== structure.audioCodec
    )
      throw new HttpError(409, "mp4_changed", "优化 MP4 时长与校验记录不一致");
  }
  return head;
}

export async function serveFaststartVersion(
  request: Request,
  env: Env,
  version: Version,
  preview: boolean,
) {
  const head = await verifyFaststartVersion(env, version, {
    requireAttestation: !preview,
  });
  return streamMp4Object(request, env, head, "optimized.mp4");
}
