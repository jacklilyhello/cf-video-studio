import type { Env, Video, Version } from "./types";
import { body, HttpError, id, json, now } from "./http";
import { log } from "./logs";
import { streamMp4Object } from "./mp4-response";
import {
  inspectSourceMp4,
  SOURCE_MP4_PARSER_VERSION,
  type SourceMp4Probe,
} from "./source-mp4";

interface SourceIdentity {
  key: string;
  etag: string;
  revision: string;
  bytes: number;
}
interface SourceState {
  video: Video;
  head: R2Object;
  identity: SourceIdentity;
}
interface SourceAttestation {
  played: true;
  seeked: true;
  audioConfirmed: true;
  durationSeconds: number;
  seekFromSeconds: number;
  seekToSeconds: number;
}
const SOURCE_CHECK_MS = 90000;
// Per-isolate diagnostic sampling only. A full active map skips new traces
// rather than evicting live counters and allowing repeated windows to reset.
const previewTraces = new Map<string, { started: number; count: number }>();
function samplePreviewTrace(videoId: string) {
  const at = Date.now();
  for (const [key, window] of previewTraces)
    if (at - window.started >= 60000) previewTraces.delete(key);
  const window = previewTraces.get(videoId);
  if (window) {
    if (window.count >= 12) return false;
    window.count++;
    return true;
  }
  if (previewTraces.size >= 32) return false;
  previewTraces.set(videoId, { started: at, count: 1 });
  return true;
}
function previewRange(value: string | null) {
  if (!value) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return { kind: "invalid" };
  if (!match[1]) {
    const suffix = Number(match[2]);
    return integer(suffix, 1)
      ? { kind: "suffix", suffix }
      : { kind: "invalid" };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  if (!integer(start, 0) || (end !== undefined && !integer(end, start)))
    return { kind: "invalid" };
  return { kind: "single", start, ...(end !== undefined ? { end } : {}) };
}
function previewResponseDetails(response: Response) {
  const length = response.headers.get("Content-Length");
  const contentLength = length && /^\d+$/.test(length) ? Number(length) : null;
  const range = response.headers.get("Content-Range");
  const partial = range && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
  const unsatisfied = range && /^bytes \*\/(\d+)$/.exec(range);
  let contentRange:
    | { kind: "partial"; start: number; end: number; total: number }
    | { kind: "unsatisfied"; total: number }
    | null = null;
  if (partial) {
    const [start, end, total] = partial.slice(1).map(Number);
    if (integer(start, 0) && integer(end, start) && integer(total, end + 1))
      contentRange = { kind: "partial", start, end, total };
  } else if (unsatisfied) {
    const total = Number(unsatisfied[1]);
    if (integer(total, 1)) contentRange = { kind: "unsatisfied", total };
  }
  return {
    status: response.status,
    contentLength: integer(contentLength, 0) ? contentLength : null,
    contentRange,
  };
}
const MAX_PROOF_BYTES = 4096;
const PROOF_IDENTITY = `video_id=? AND object_key=? AND source_revision=?
  AND source_etag=? AND source_bytes=? AND parser_version=?`;
function proofIdentity(state: SourceState) {
  return [
    state.video.id,
    state.identity.key,
    state.identity.revision,
    state.identity.etag,
    state.identity.bytes,
    SOURCE_MP4_PARSER_VERSION,
  ];
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}
function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}
function finite(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
  );
}
function validStructureProof(
  value: unknown,
  bytes: number,
): value is SourceMp4Probe {
  if (
    !record(value) ||
    !onlyKeys(value, [
      "compatible",
      "reasons",
      "durationSeconds",
      "width",
      "height",
      "videoCodec",
      "audioCodec",
      "audioChannels",
      "validationBasis",
      "serverDecoded",
      "index",
      "fragmented",
      "nativeEdits",
    ]) ||
    value.compatible !== true ||
    value.serverDecoded !== false ||
    value.validationBasis !== "bounded-iso-bmff-metadata" ||
    !Array.isArray(value.reasons) ||
    value.reasons.length !== 0 ||
    !finite(value.durationSeconds) ||
    value.durationSeconds <= 0 ||
    !integer(value.width, 1, 8192) ||
    !integer(value.height, 1, 8192) ||
    !["avc1", "avc3"].includes(String(value.videoCodec)) ||
    !(
      (value.audioCodec === null && value.audioChannels === 0) ||
      (value.audioCodec === "mp4a.40.2" && value.audioChannels === 2)
    )
  )
    return false;
  if (value.nativeEdits !== undefined) {
    if (
      value.fragmented !== undefined ||
      !Array.isArray(value.nativeEdits) ||
      value.nativeEdits.length < 1 ||
      value.nativeEdits.length > 2
    )
      return false;
    const tracks = new Set<string>();
    for (const edit of value.nativeEdits) {
      if (
        !record(edit) ||
        !onlyKeys(edit, [
          "track",
          "mediaStartSeconds",
          "durationSeconds",
          "movieStartSeconds",
        ]) ||
        !["video", "audio"].includes(String(edit.track)) ||
        tracks.has(String(edit.track)) ||
        (edit.track === "audio" && value.audioCodec === null) ||
        !finite(edit.mediaStartSeconds) ||
        edit.mediaStartSeconds < 0 ||
        edit.mediaStartSeconds > 1 ||
        !finite(edit.durationSeconds) ||
        edit.durationSeconds <= 0 ||
        (edit.movieStartSeconds !== undefined &&
          (!finite(edit.movieStartSeconds) || edit.movieStartSeconds <= 0)) ||
        edit.durationSeconds + (edit.movieStartSeconds ?? 0) >
          value.durationSeconds + 0.01
      )
        return false;
      tracks.add(String(edit.track));
    }
  }
  const index = value.index;
  if (
    !record(index) ||
    !onlyKeys(index, ["basis", "placement", "moovOffset", "moovBytes"]) ||
    index.basis !== "bounded-top-level-box-scan" ||
    !["before-media", "after-media", "between-media"].includes(
      String(index.placement),
    ) ||
    !integer(index.moovOffset, 0, bytes - 8) ||
    !integer(index.moovBytes, 8, bytes) ||
    Number(index.moovOffset) + Number(index.moovBytes) > bytes
  )
    return false;
  if (value.fragmented !== undefined) {
    const fragment = value.fragmented;
    if (
      !record(fragment) ||
      !onlyKeys(fragment, [
        "basis",
        "fragmentCount",
        "sampleCount",
        "sampleRangesVerified",
        "timelinesVerified",
        "randomAccessIndex",
        "tracks",
      ]) ||
      fragment.basis !== "bounded-fragment-sample-tables" ||
      !integer(fragment.fragmentCount, 1, 1024) ||
      !integer(fragment.sampleCount, 1, 1000000) ||
      fragment.sampleRangesVerified !== true ||
      fragment.timelinesVerified !== true ||
      !Array.isArray(fragment.tracks) ||
      fragment.tracks.length < 1 ||
      fragment.tracks.length > 2
    )
      return false;
    if (fragment.randomAccessIndex !== undefined) {
      const access = fragment.randomAccessIndex;
      if (
        !record(access) ||
        !onlyKeys(access, ["basis", "entries"]) ||
        !["global-traf-order", "track-id-compatibility"].includes(
          String(access.basis),
        ) ||
        !integer(
          access.entries,
          0,
          Math.min(2048, fragment.fragmentCount * fragment.tracks.length),
        ) ||
        (access.basis === "track-id-compatibility" &&
          (access.entries === 0 || fragment.tracks.length !== 2))
      )
        return false;
    }
    const ids = new Set<number>(),
      types = new Set<string>();
    let samples = 0;
    for (const track of fragment.tracks) {
      if (
        !record(track) ||
        !onlyKeys(track, [
          "id",
          "type",
          "timescale",
          "sampleCount",
          "decodeStartSeconds",
          "decodeEndSeconds",
          "presentationStartSeconds",
          "presentationEndSeconds",
        ]) ||
        !integer(track.id, 1, 0xffffffff) ||
        !["video", "audio"].includes(String(track.type)) ||
        !integer(track.timescale, 1, 0xffffffff) ||
        !integer(track.sampleCount, 1, 1000000) ||
        !finite(track.decodeStartSeconds) ||
        track.decodeStartSeconds < 0 ||
        !finite(track.decodeEndSeconds) ||
        track.decodeEndSeconds <= track.decodeStartSeconds ||
        !finite(track.presentationStartSeconds) ||
        !finite(track.presentationEndSeconds) ||
        track.presentationEndSeconds <= track.presentationStartSeconds ||
        ids.has(Number(track.id)) ||
        types.has(String(track.type))
      )
        return false;
      ids.add(Number(track.id));
      types.add(String(track.type));
      samples += Number(track.sampleCount);
    }
    if (
      !types.has("video") ||
      types.has("audio") !== (value.audioCodec !== null) ||
      samples !== fragment.sampleCount
    )
      return false;
  }
  return true;
}
function parseStructureProof(
  json: unknown,
  bytes: number,
): SourceMp4Probe | null {
  if (
    typeof json !== "string" ||
    json.length > MAX_PROOF_BYTES ||
    new TextEncoder().encode(json).length > MAX_PROOF_BYTES
  )
    return null;
  try {
    const value: unknown = JSON.parse(json);
    return validStructureProof(value, bytes) ? value : null;
  } catch {
    return null;
  }
}

// Advisory playback metadata only. Actual media requests still verify current
// publication, source identity and the version's administrator attestation.
export function publicSourcePlayback(
  version: Pick<Version, "mode" | "bytes" | "duration" | "validation_json">,
  current: Pick<
    Video,
    "source_key" | "source_etag" | "source_revision" | "source_size"
  >,
): { bytes: number; etag: string; probe: SourceMp4Probe } | null {
  const raw = version.validation_json;
  if (
    version.mode !== "source" ||
    !integer(version.bytes, 1) ||
    !finite(version.duration) ||
    version.duration <= 0 ||
    typeof raw !== "string" ||
    raw.length > 2 * MAX_PROOF_BYTES ||
    new TextEncoder().encode(raw).length > 2 * MAX_PROOF_BYTES
  )
    return null;
  try {
    const validation: unknown = JSON.parse(raw);
    if (
      !record(validation) ||
      validation.kind !== "source" ||
      validation.schemaVersion !== 1 ||
      validation.serverDecoded !== false ||
      !record(validation.source)
    )
      return null;
    const identity = validation.source;
    if (
      identity.bytes !== version.bytes ||
      identity.bytes !== current.source_size ||
      typeof identity.etag !== "string" ||
      !/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(identity.etag) ||
      identity.etag !== current.source_etag ||
      typeof identity.key !== "string" ||
      !identity.key ||
      identity.key !== current.source_key ||
      typeof identity.revision !== "string" ||
      !identity.revision ||
      identity.revision !== current.source_revision
    )
      return null;
    const probe = parseStructureProof(
      JSON.stringify(validation.probe),
      version.bytes,
    );
    if (!probe || probe.durationSeconds !== version.duration) return null;
    return { bytes: version.bytes, etag: identity.etag, probe };
  } catch {
    return null;
  }
}
const knownTopLevelBoxes = new Set([
  "ftyp",
  "moov",
  "mdat",
  "free",
  "skip",
  "wide",
  "uuid",
  "moof",
  "sidx",
  "ssix",
  "mfra",
  "emsg",
  "styp",
]);
class SourceCheckBudget {
  readonly started = Date.now();
  phase = "identity";
  reads = 0;
  bytes = 0;
  requestedBytes = 0;
  topLevelBoxes = 0;
  topLevelTypes: Record<string, number> = {};
  lastTopLevelOffset?: number;
  timedOut = false;
  readsClosed = false;
  readonly cancelReads = new Set<() => void>();
  structureProof?: "persisted" | "fresh";
  fragmentReadPlan?: {
    basis: "mfra-hints" | "sequential";
    hintCount: number;
    indexBytes: number;
    concurrency: number;
  };
  get expired() {
    return this.timedOut || Date.now() - this.started >= SOURCE_CHECK_MS;
  }
  details() {
    return {
      phase: this.phase,
      elapsedMs: Date.now() - this.started,
      rangeReads: this.reads,
      metadataBytesRead: this.bytes,
      metadataBytesRequested: this.requestedBytes,
      topLevelBoxes: this.topLevelBoxes,
      topLevelTypes: { ...this.topLevelTypes },
      lastTopLevelOffset: this.lastTopLevelOffset,
      fragmentReadPlan: this.fragmentReadPlan,
    };
  }
  stopReads() {
    this.readsClosed = true;
    for (const cancel of this.cancelReads) cancel();
    this.cancelReads.clear();
  }
  checkRead() {
    this.check();
    if (this.readsClosed) throw new Error("source_read_unverified");
  }
  check() {
    if (this.expired) {
      this.timedOut = true;
      this.stopReads();
      throw new HttpError(
        504,
        "source_check_timeout",
        "原片检查超时，尚未判定播放兼容性。请重试或查看后台诊断。",
        this.details(),
      );
    }
  }
  async wait<T>(
    pending: Promise<T>,
    onExpired?: (value: T) => void,
  ): Promise<T> {
    // The operation may already be in flight when the deadline is observed.
    // Its eventual rejection must remain handled even if we fail before racing.
    void pending.catch(() => {});
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              this.timedOut = true;
              this.stopReads();
              reject(
                new HttpError(
                  504,
                  "source_check_timeout",
                  "原片检查超时，尚未判定播放兼容性。请重试或查看后台诊断。",
                  this.details(),
                ),
              );
            },
            SOURCE_CHECK_MS - (Date.now() - this.started),
          );
        }),
      ]);
      try {
        this.check();
      } catch (error) {
        onExpired?.(result);
        throw error;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
function matchesRange(
  value: R2Range | undefined,
  offset: number,
  length: number,
) {
  return (
    !!value &&
    "offset" in value &&
    value.offset === offset &&
    "length" in value &&
    value.length === length
  );
}

export async function sourceIdentity(
  env: Env,
  videoId: string,
): Promise<SourceState> {
  const video = await env.DB.prepare(
    "SELECT * FROM videos WHERE id=? AND status!='deleted'",
  )
    .bind(videoId)
    .first<Video>();
  if (
    !video?.source_key ||
    !video.source_etag ||
    !video.source_revision ||
    !Number.isSafeInteger(video.source_size) ||
    video.source_size <= 0
  )
    throw new HttpError(404, "source_unavailable", "完整原片尚不可用");
  if (
    !video.source_key.startsWith(`videos/${video.id}/source/`) &&
    !video.source_key.startsWith("imports/")
  )
    throw new HttpError(409, "source_changed", "原片路径不在登记项目范围");
  const indexedRead = env.DB.prepare(
    "SELECT video_id,category,bytes,etag,state FROM objects WHERE key=?",
  )
    .bind(video.source_key)
    .first<{
      video_id: string;
      category: string;
      bytes: number;
      etag: string;
      state: string;
    }>();
  const uploadRead = video.source_key.startsWith("imports/")
    ? Promise.resolve(null)
    : env.DB.prepare(
        "SELECT id FROM uploads WHERE video_id=? AND object_key=? AND expected_size=? AND state='complete'",
      )
        .bind(video.id, video.source_key, video.source_size)
        .first<{ id: string }>();
  const [indexed, head, upload] = await Promise.all([
    indexedRead,
    env.MEDIA.head(video.source_key),
    uploadRead,
  ]);
  if (
    !indexed ||
    indexed.video_id !== videoId ||
    indexed.category !== "source" ||
    indexed.state !== "present" ||
    indexed.bytes !== video.source_size ||
    indexed.etag !== video.source_etag ||
    !head ||
    head.key !== video.source_key ||
    head.size !== video.source_size ||
    head.etag !== video.source_etag
  )
    throw new HttpError(
      409,
      "source_changed",
      "原片实际对象或登记信息变化，请先对账",
    );
  if (!video.source_key.startsWith("imports/")) {
    if (
      !upload ||
      head.customMetadata?.upload_id !== upload.id ||
      head.customMetadata?.video_id !== video.id ||
      head.customMetadata?.source_revision !== video.source_revision
    )
      throw new HttpError(409, "source_changed", "原片完成状态及修订无法核对");
  }
  return {
    video,
    head,
    identity: {
      key: video.source_key,
      etag: video.source_etag,
      revision: video.source_revision,
      bytes: video.source_size,
    },
  };
}

async function probeSource(
  env: Env,
  state: SourceState,
  fresh = false,
  budget = new SourceCheckBudget(),
) {
  const identity = proofIdentity(state);
  if (!fresh) {
    const cached = await budget.wait(
      env.DB.prepare(
        `SELECT state,result_json,verified_at FROM source_structural_checks WHERE ${PROOF_IDENTITY}`,
      )
        .bind(...identity)
        .first<{ state: string; result_json: string; verified_at: number }>(),
    );
    const probe =
      cached?.state === "verified" && integer(cached.verified_at, 1, now())
        ? parseStructureProof(cached.result_json, state.identity.bytes)
        : null;
    if (probe) {
      budget.structureProof = "persisted";
      return probe;
    }
  }
  // A deliberate fresh check revokes the old proof before any new range read.
  // Failed or partial checks therefore cannot fall back to the previous result.
  await budget.wait(
    env.DB.prepare(
      `DELETE FROM source_structural_checks WHERE ${PROOF_IDENTITY}`,
    )
      .bind(...identity)
      .run(),
  );
  let probe: SourceMp4Probe;
  try {
    probe = await inspectSourceMp4(
      state.identity.bytes,
      async (offset, length) => {
        budget.checkRead();
        budget.reads++;
        budget.requestedBytes += length;
        let discarded = false;
        const discard = (object: R2ObjectBody | R2Object | null) => {
          if (!discarded && object && "body" in object) {
            discarded = true;
            void object.body.cancel().catch(() => {});
          }
        };
        const object = await budget.wait(
          env.MEDIA.get(state.identity.key, {
            onlyIf: { etagMatches: state.identity.etag },
            range: { offset, length },
          }).then((object) => {
            if (budget.expired || budget.readsClosed) discard(object);
            return object;
          }),
          discard,
        );
        if (budget.readsClosed) {
          discard(object);
          throw new Error("source_read_unverified");
        }
        if (
          !object ||
          !("body" in object) ||
          object.key !== state.identity.key ||
          object.etag !== state.identity.etag ||
          object.size !== state.identity.bytes ||
          !matchesRange(object.range, offset, length)
        ) {
          if (object && "body" in object)
            void object.body.cancel().catch(() => {});
          throw new Error("source_read_unverified");
        }
        const reader = object.body.getReader();
        let cancelled = false;
        const cancel = () => {
          if (cancelled) return;
          cancelled = true;
          try {
            void reader.cancel().catch(() => {});
          } catch {
            // A local cleanup failure cannot prevent the other readers closing.
          }
        };
        budget.cancelReads.add(cancel);
        const result = new Uint8Array(length);
        let at = 0;
        try {
          while (true) {
            budget.checkRead();
            const next = await budget.wait(reader.read());
            if (next.done) break;
            budget.bytes += next.value.length;
            if (at + next.value.length > length)
              throw new Error("source_read_unverified");
            result.set(next.value, at);
            at += next.value.length;
          }
          if (at !== length) throw new Error("source_read_unverified");
          return result;
        } finally {
          budget.cancelReads.delete(cancel);
          cancel();
        }
      },
      {
        onTopLevelBox: ({ type, offset }) => {
          const name = knownTopLevelBoxes.has(type) ? type : "other";
          budget.topLevelBoxes++;
          budget.topLevelTypes[name] = (budget.topLevelTypes[name] || 0) + 1;
          budget.lastTopLevelOffset = offset;
        },
        onFragmentReadPlan: ({ basis, hintCount, indexBytes, concurrency }) => {
          if (
            (basis === "mfra-hints" || basis === "sequential") &&
            integer(hintCount, 0, 1024) &&
            integer(indexBytes, 0, 5 * 1024 ** 2) &&
            integer(concurrency, 0, 8)
          )
            budget.fragmentReadPlan = {
              basis,
              hintCount,
              indexBytes,
              concurrency,
            };
        },
      },
    );
  } finally {
    // Metadata prefetch may still be in flight. Close only this read scope;
    // final identity checks and D1 proof writes retain the overall deadline.
    budget.stopReads();
  }
  budget.check();
  if (probe.reasons.includes("source_read_unverified"))
    throw new HttpError(
      503,
      "source_read_unverified",
      "原片元数据读取未完成，尚未判定播放兼容性。请重试。",
    );
  budget.phase = "revalidate";
  const after = await budget.wait(sourceIdentity(env, state.video.id));
  if (JSON.stringify(after.identity) !== JSON.stringify(state.identity))
    throw new HttpError(409, "source_changed", "原片在校验期间发生变化");
  if (probe.compatible) {
    const resultJson = JSON.stringify(probe);
    if (!parseStructureProof(resultJson, state.identity.bytes))
      throw new HttpError(
        503,
        "source_proof_unverified",
        "原片结构检查结果尚未核实，请重试",
      );
    const saved = await budget.wait(
      env.DB.prepare(
        `INSERT INTO source_structural_checks(video_id,object_key,source_revision,source_etag,source_bytes,parser_version,state,result_json,verified_at)
       SELECT v.id,v.source_key,v.source_revision,v.source_etag,v.source_size,?,'verified',?,?
       FROM videos v JOIN objects o ON o.key=v.source_key
       WHERE v.id=? AND v.source_key=? AND v.source_revision=? AND v.source_etag=? AND v.source_size=? AND v.status!='deleted'
       AND o.video_id=v.id AND o.category='source' AND o.state='present' AND o.bytes=v.source_size AND o.etag=v.source_etag
       AND (v.source_key LIKE 'imports/%' OR EXISTS(SELECT 1 FROM uploads u WHERE u.video_id=v.id AND u.object_key=v.source_key AND u.expected_size=v.source_size AND u.state='complete'))
       ON CONFLICT(video_id,object_key,source_revision,source_etag,source_bytes,parser_version)
       DO UPDATE SET result_json=excluded.result_json,verified_at=excluded.verified_at,state='verified'`,
      )
        .bind(
          SOURCE_MP4_PARSER_VERSION,
          resultJson,
          now(),
          state.video.id,
          state.identity.key,
          state.identity.revision,
          state.identity.etag,
          state.identity.bytes,
        )
        .run(),
    );
    if (saved.meta.changes !== 1)
      throw new HttpError(
        409,
        "source_changed",
        "原片在保存结构核验结果时变化，请重新检查",
      );
    budget.structureProof = "fresh";
  }
  return probe;
}

export async function checkSource(
  env: Env,
  videoId: string,
  options: {
    beforeCheck?: () => Promise<void>;
    requestId?: string;
    waitUntil?: (promise: Promise<unknown>) => void;
    fresh?: boolean;
  } = {},
) {
  const budget = new SourceCheckBudget();
  const record = (code: string, compatible?: boolean) => {
    const pending = log(env, {
      stage: "source_check",
      requestId: options.requestId,
      videoId,
      message: "管理员原片有界元数据检查",
      details: {
        ...budget.details(),
        structureProof: budget.structureProof,
        code,
        compatible,
      },
    }).catch(() => {});
    options.waitUntil?.(pending);
  };
  try {
    if (options.beforeCheck) {
      budget.phase = "admission";
      await budget.wait(options.beforeCheck());
    }
    budget.phase = "identity";
    const state = await budget.wait(sourceIdentity(env, videoId));
    budget.phase = "metadata";
    const probe = await probeSource(
      env,
      state,
      options.fresh !== false,
      budget,
    );
    const elapsedMs = Date.now() - budget.started;
    record("checked", probe.compatible);
    return json({
      source: {
        videoId,
        etag: state.identity.etag,
        revision: state.identity.revision,
        bytes: state.identity.bytes,
        parserVersion: SOURCE_MP4_PARSER_VERSION,
        checkedAt: now(),
        compatible: probe.compatible,
        reasons: probe.reasons,
        probe,
        ...(probe.compatible && budget.structureProof && integer(elapsedMs, 0)
          ? {
              preparation: {
                structureProof: budget.structureProof,
                elapsedMs,
              },
            }
          : {}),
        previewUrl: `/api/admin/source/${encodeURIComponent(videoId)}/source.mp4`,
      },
    });
  } catch (error) {
    record(error instanceof HttpError ? error.code : "source_read_unverified");
    throw error;
  }
}

export function validateMp4Attestation(
  value: unknown,
  duration: number,
): SourceAttestation {
  const input = value as Partial<SourceAttestation> | null;
  const finite = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n);
  if (
    !input ||
    input.played !== true ||
    input.seeked !== true ||
    input.audioConfirmed !== true ||
    !finite(input.durationSeconds) ||
    !finite(input.seekFromSeconds) ||
    !finite(input.seekToSeconds) ||
    Math.abs(input.durationSeconds - duration) >
      Math.max(0.5, duration * 0.01) ||
    input.seekFromSeconds < 0 ||
    input.seekToSeconds < 0 ||
    input.seekFromSeconds > duration ||
    input.seekToSeconds > duration ||
    Math.abs(input.seekToSeconds - input.seekFromSeconds) <
      Math.min(1, duration * 0.2)
  )
    throw new HttpError(
      400,
      "source_attestation_required",
      "请实际确认原片播放、音画或无音轨状态及拖动后再创建版本",
    );
  return {
    played: true,
    seeked: true,
    audioConfirmed: true,
    durationSeconds: input.durationSeconds,
    seekFromSeconds: input.seekFromSeconds,
    seekToSeconds: input.seekToSeconds,
  };
}

export async function createSourceVersion(
  request: Request,
  env: Env,
  videoId: string,
) {
  const input = await body(request, 2048);
  const state = await sourceIdentity(env, videoId);
  if (
    input.sourceEtag !== state.identity.etag ||
    input.sourceRevision !== state.identity.revision
  )
    throw new HttpError(409, "source_changed", "请重新核对当前原片再确认");
  const probe = await probeSource(env, state, true);
  if (!probe.compatible || !probe.durationSeconds)
    throw new HttpError(
      422,
      "source_not_supported",
      "原片结构或编码不在安全直接发布范围；保留原片，可另行报价处理",
    );
  const confirmed = validateMp4Attestation(
    input.attestation,
    probe.durationSeconds,
  );
  const prior = await env.DB.prepare(
    "SELECT * FROM versions WHERE video_id=? AND mode='source' AND state='verified' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(videoId)
    .first<Version>();
  if (prior) {
    try {
      await verifySourceVersion(env, prior);
      return json({ version: prior, reused: true });
    } catch (error) {
      if (!(error instanceof HttpError))
        throw error; /* Changed source requires its own version. */
    }
  }
  const versionId = id();
  const validation = {
    kind: "source",
    schemaVersion: 1,
    source: state.identity,
    probe,
    administratorAttestation: {
      ...confirmed,
      confirmedAt: now(),
      basis: "administrator-browser-playback-and-seek",
    },
    serverDecoded: false,
  };
  await env.DB.prepare(
    "INSERT INTO versions(id,video_id,prefix,state,mode,quality,manifest,bytes,duration,timeline_id,validation_json,created_at) SELECT ?,id,?,'verified','source','source','source.mp4',?,?,?, ?,? FROM videos WHERE id=? AND source_key=? AND source_etag=? AND source_revision=? AND source_size=? AND status!='deleted'",
  )
    .bind(
      versionId,
      `videos/${videoId}/versions/${versionId}/`,
      state.identity.bytes,
      probe.durationSeconds,
      id(),
      JSON.stringify(validation),
      now(),
      videoId,
      state.identity.key,
      state.identity.etag,
      state.identity.revision,
      state.identity.bytes,
    )
    .run();
  const version = await env.DB.prepare("SELECT * FROM versions WHERE id=?")
    .bind(versionId)
    .first<Version>();
  if (!version)
    throw new HttpError(409, "source_changed", "原片修订已变化，请重新确认");
  await verifySourceVersion(env, version);
  await log(env, {
    stage: "source_version_verified",
    videoId,
    message: "有界 MP4 结构检查和管理员播放拖动确认已记录；服务端未解码",
    details: { versionId },
  });
  return json({ version });
}

export async function verifySourceVersion(
  env: Env,
  version: Version,
): Promise<SourceState> {
  let validation;
  try {
    validation = JSON.parse(version.validation_json ?? "null");
  } catch {
    /* fail closed below */
  }
  if (
    version.mode !== "source" ||
    version.state !== "verified" ||
    version.manifest !== "source.mp4" ||
    version.prefix !== `videos/${version.video_id}/versions/${version.id}/` ||
    validation?.kind !== "source" ||
    validation.schemaVersion !== 1 ||
    validation.serverDecoded !== false ||
    validation.probe?.compatible !== true ||
    validation.probe?.validationBasis !== "bounded-iso-bmff-metadata" ||
    validation.probe?.serverDecoded !== false ||
    validation.administratorAttestation?.basis !==
      "administrator-browser-playback-and-seek" ||
    !Number.isSafeInteger(validation.administratorAttestation?.confirmedAt) ||
    validation.administratorAttestation.confirmedAt <= 0 ||
    validation.administratorAttestation.confirmedAt > now()
  )
    throw new HttpError(
      409,
      "source_version_unverified",
      "原片版本校验或管理员确认记录不完整",
    );
  const state = await sourceIdentity(env, version.video_id);
  const source = validation.source;
  if (
    !source ||
    source.key !== state.identity.key ||
    source.etag !== state.identity.etag ||
    source.revision !== state.identity.revision ||
    source.bytes !== state.identity.bytes ||
    version.bytes !== state.identity.bytes ||
    version.duration !== validation.probe.durationSeconds ||
    !Number.isFinite(version.duration) ||
    Number(version.duration) <= 0
  )
    throw new HttpError(
      409,
      "source_changed",
      "原片版本引用的对象或修订已变化",
    );
  validateMp4Attestation(
    validation.administratorAttestation,
    Number(version.duration),
  );
  return state;
}

async function streamSource(request: Request, env: Env, state: SourceState) {
  return streamMp4Object(request, env, state.head);
}

export async function serveSourcePreview(
  request: Request,
  env: Env,
  videoId: string,
  options: {
    requestId?: string;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
) {
  if (!["GET", "HEAD"].includes(request.method))
    throw new HttpError(405, "method_denied", "请求方法不允许");
  const budget = new SourceCheckBudget();
  const method = request.method;
  const range = previewRange(request.headers.get("Range"));
  let traced = false;
  try {
    traced = samplePreviewTrace(videoId);
  } catch {
    // Diagnostics never select identity, authorize access or block playback.
  }
  const record = (
    phase:
      | "request_received"
      | "identity_verified"
      | "structure_verified"
      | "response_started",
    extra: Record<string, unknown> = {},
  ) => {
    if (!traced) return;
    const pending = log(env, {
      stage: "source_preview",
      requestId: options.requestId,
      videoId,
      message: "管理员原片流式响应准备阶段",
      details: {
        phase,
        elapsedMs: Date.now() - budget.started,
        method,
        range,
        ...extra,
      },
    }).catch(() => {});
    try {
      options.waitUntil?.(pending);
    } catch {
      // Failure to retain a diagnostic cannot replace the media response.
    }
  };
  record("request_received");
  try {
    budget.phase = "identity";
    const state = await budget.wait(sourceIdentity(env, videoId));
    record("identity_verified");
    budget.phase = "metadata";
    const probe = await probeSource(env, state, false, budget);
    if (!probe.compatible)
      throw new HttpError(
        422,
        "source_not_supported",
        "当前原片不在直接 MP4 预览支持范围，请查看结构检查结果",
      );
    record("structure_verified", { structureProof: budget.structureProof });
    budget.phase = "response";
    let discarded = false;
    const discard = (response: Response) => {
      if (!discarded && response.body) {
        discarded = true;
        try {
          void response.body.cancel().catch(() => {});
        } catch {
          // Preparation cancellation does not wait for the remote producer.
        }
      }
    };
    const response = await budget.wait(
      streamSource(request, env, state).then((response) => {
        if (budget.expired) discard(response);
        return response;
      }),
      discard,
    );
    // Only response preparation is bounded. The original stream remains
    // untouched and may play for longer than the metadata-check deadline.
    record("response_started", previewResponseDetails(response));
    return response;
  } catch (error) {
    const failure =
      error instanceof HttpError
        ? error
        : new HttpError(
            503,
            "source_read_unverified",
            "原片预览响应准备未完成，请重试。",
          );
    const pending = log(env, {
      stage: "source_preview_failed",
      requestId: options.requestId,
      videoId,
      message: "管理员原片预览未完成",
      details: {
        code: failure.code,
        phase: budget.phase,
        elapsedMs: Date.now() - budget.started,
        method,
        range,
      },
    }).catch(() => {});
    try {
      options.waitUntil?.(pending);
    } catch {
      // Preserve the original preparation failure if diagnostics are unavailable.
    }
    throw failure;
  }
}
export async function serveSourceVersion(
  request: Request,
  env: Env,
  version: Version,
) {
  return streamSource(request, env, await verifySourceVersion(env, version));
}

export async function reportSourcePlayback(
  request: Request,
  env: Env,
  videoId: string,
) {
  const input = await body(request, 1024);
  const allowed = [
    "sourceRevision",
    "phase",
    "nativeErrorCode",
    "networkState",
    "readyState",
    "currentTime",
    "duration",
  ];
  const phases = [
    "loadedmetadata",
    "playing",
    "seeked",
    "error",
    "stalled",
    "waiting",
  ];
  const state = await sourceIdentity(env, videoId);
  if (
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    input.sourceRevision !== state.identity.revision ||
    typeof input.phase !== "string" ||
    !phases.includes(input.phase)
  )
    throw new HttpError(400, "invalid_source_report", "原片诊断字段无效");
  const details: Record<string, unknown> = {
    sourceRevision: state.identity.revision,
    phase: input.phase,
  };
  for (const [name, maximum] of [
    ["nativeErrorCode", 4],
    ["networkState", 3],
    ["readyState", 4],
  ] as const) {
    const value = input[name];
    if (value !== undefined) {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > maximum
      )
        throw new HttpError(400, "invalid_source_report", "原片诊断数值无效");
      details[name] = value;
    }
  }
  for (const name of ["currentTime", "duration"] as const) {
    const value = input[name];
    if (value !== undefined) {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 7 * 86400
      )
        throw new HttpError(400, "invalid_source_report", "原片诊断数值无效");
      details[name] = value;
    }
  }
  await log(env, {
    stage: "source_playback",
    videoId,
    message: "管理员原片播放器诊断",
    details,
  });
  return json({ accepted: true }, 202);
}
