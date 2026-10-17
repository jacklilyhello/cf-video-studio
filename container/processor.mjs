import http from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BRIDGE = "http://task.internal";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PROBE_BYTES = 1024 * 1024;
const SAFE_OBJECT = /^(index\.m3u8|segment-\d{6}\.ts)$/;
const FORMAT_METADATA = new Set([
  "creation_time",
  "title",
  "artist",
  "album_artist",
  "album",
  "grouping",
  "composer",
  "date",
  "comment",
  "genre",
  "copyright",
  "description",
  "synopsis",
  "show",
  "episode_id",
  "network",
  "lyrics",
  "track",
  "disc",
]);
const STREAM_METADATA = new Set([
  "creation_time",
  "language",
  "title",
  "handler_name",
]);
const activeChildren = new Set();
let activeTask;
let servedTask;
let shuttingDown = false;

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateTask(value, now = Date.now()) {
  ensure(value && typeof value === "object", "Task body is required");
  ensure(
    typeof value.taskId === "string" &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(value.taskId),
    "Invalid task ID",
  );
  ensure(
    ["probe-remux", "transcode", "faststart"].includes(value.mode),
    "Invalid processing mode",
  );
  ensure(
    ["source", "1080p", "720p"].includes(value.quality),
    "Invalid quality",
  );
  ensure(
    Number.isSafeInteger(value.deadlineMs) &&
      value.deadlineMs > now &&
      value.deadlineMs <= now + 6 * 60 * 60 * 1000,
    "Invalid task deadline",
  );
  ensure(
    Number.isSafeInteger(value.inputBytes) &&
      value.inputBytes > 0 &&
      value.inputBytes <= 20 * 1024 ** 3,
    "Invalid input byte limit",
  );
  ensure(
    Number.isSafeInteger(value.maxOutputBytes) &&
      value.maxOutputBytes > 0 &&
      value.maxOutputBytes <= 20 * 1024 ** 3,
    "Invalid output byte limit",
  );
  ensure(
    Number.isSafeInteger(value.maxMediaObjects) &&
      (value.mode === "faststart"
        ? value.maxMediaObjects === 1
        : value.maxMediaObjects >= 2 && value.maxMediaObjects <= 10000),
    "Invalid output object limit",
  );
  ensure(
    Number.isSafeInteger(value.memoryBytes) &&
      value.memoryBytes >= 256 * 1024 ** 2 &&
      value.memoryBytes <= 12 * 1024 ** 3,
    "Invalid memory reservation",
  );
  if (value.mode === "probe-remux")
    ensure(
      value.quality === "source",
      "Probe/remux must retain source quality",
    );
  if (value.mode === "faststart") {
    ensure(value.quality === "source", "Faststart must retain source quality");
    ensure(
      value.outputKind === "mp4" &&
        value.outputName === "optimized.mp4" &&
        value.maxUploadAttempts === 3,
      "Invalid faststart output reservation",
    );
    ensure(
      value.maxOutputBytes <= 5 * 1024 ** 3 - 5 * 1024 ** 2,
      "Faststart exceeds the confirmed single PUT limit",
    );
    ensure(
      value.inputBytes <= 5 * 1024 ** 3 - 5 * 1024 ** 2,
      "Faststart source exceeds the single-file reservation limit",
    );
  }
  return value;
}

export function summarizeProbe(raw) {
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  const videos = streams.filter((s) => s.codec_type === "video");
  const audios = streams.filter((s) => s.codec_type === "audio");
  const video = videos.find((s) => !s.disposition?.attached_pic) ?? videos[0];
  const durationSeconds = Number(raw.format?.duration ?? video?.duration);
  return {
    durationSeconds:
      Number.isFinite(durationSeconds) && durationSeconds > 0
        ? durationSeconds
        : null,
    format: String(raw.format?.format_name ?? ""),
    formatMetadata: raw.format?.tags ?? {},
    width: Number(video?.width) || null,
    height: Number(video?.height) || null,
    videoCodec: video?.codec_name ?? null,
    pixelFormat: video?.pix_fmt ?? null,
    videoProfile: video?.profile ?? null,
    frameRate: video?.avg_frame_rate ?? null,
    audioCodec: audios[0]?.codec_name ?? null,
    audioProfile: audios[0]?.profile ?? null,
    audioChannels: Number(audios[0]?.channels) || 0,
    chapters: Array.isArray(raw.chapters) ? raw.chapters.length : 0,
    hdr: streams.some(
      (s) =>
        ["smpte2084", "arib-std-b67"].includes(s.color_transfer) ||
        (s.side_data_list ?? []).some((d) =>
          /mastering display|content light|dovi|dolby vision/i.test(
            d.side_data_type ?? "",
          ),
        ),
    ),
    rotated: streams.some(
      (s) =>
        Number(s.tags?.rotate) ||
        (s.side_data_list ?? []).some((d) => Number(d.rotation)),
    ),
    streams: streams.map((s) => ({
      index: s.index,
      type: s.codec_type,
      codec: s.codec_name,
      profile: s.profile,
      width: s.width,
      height: s.height,
      pixelFormat: s.pix_fmt,
      channels: s.channels,
      sampleRate: s.sample_rate,
      extraDataSha256: s.extradata_hash ?? null,
      language: s.tags?.language,
      title: s.tags?.title,
      metadata: s.tags ?? {},
      sideDataTypes: (s.side_data_list ?? []).map((d) =>
        String(d.side_data_type ?? ""),
      ),
      startSeconds: Number.isFinite(Number(s.start_time))
        ? Number(s.start_time)
        : null,
      durationSeconds: Number.isFinite(Number(s.duration))
        ? Number(s.duration)
        : null,
      attachedPicture: !!s.disposition?.attached_pic,
    })),
  };
}

export function processingReasons(probe, mode) {
  const reasons = [];
  if (!probe.durationSeconds)
    reasons.push("A reliable media duration is unavailable.");
  if (!probe.width || !probe.height)
    reasons.push("A valid video stream is required.");
  if (probe.streams.filter((s) => s.type === "video").length !== 1)
    reasons.push(
      "Multiple video streams or attached artwork require an explicit preservation plan.",
    );
  if (probe.streams.filter((s) => s.type === "audio").length > 1)
    reasons.push(
      "Multiple audio tracks require an explicit preservation plan.",
    );
  if (probe.streams.some((s) => !["video", "audio"].includes(s.type)))
    reasons.push(
      "Subtitles, attachments, or data streams require an explicit preservation plan.",
    );
  if (probe.hdr)
    reasons.push(
      "HDR or Dolby Vision requires an explicit color and metadata plan.",
    );
  if (probe.rotated)
    reasons.push(
      "Display rotation requires an explicit orientation preservation plan.",
    );
  if (probe.audioChannels > 2)
    reasons.push(
      "Multichannel audio requires an explicit preservation or downmix plan.",
    );
  if (mode === "probe-remux" || mode === "faststart") {
    if (
      probe.videoCodec !== "h264" ||
      probe.pixelFormat !== "yuv420p" ||
      !["Constrained Baseline", "Baseline", "Main", "High"].includes(
        probe.videoProfile,
      )
    )
      reasons.push("Video must be re-encoded to compatible 8-bit H.264.");
    if (
      probe.audioCodec &&
      (probe.audioCodec !== "aac" || probe.audioProfile !== "LC")
    )
      reasons.push("Audio must be re-encoded to AAC-LC.");
  }
  if (mode === "faststart") {
    if (!probe.format.split(",").includes("mp4"))
      reasons.push("Faststart requires a compatible MP4 source.");
    if (probe.chapters)
      reasons.push("Chapter tracks require an explicit preservation plan.");
    if (probe.streams.some((s) => s.attachedPicture))
      reasons.push("Attached artwork requires an explicit preservation plan.");
    if (
      Object.keys(probe.formatMetadata ?? {}).some(
        (key) =>
          !FORMAT_METADATA.has(key) &&
          ![
            "major_brand",
            "minor_version",
            "compatible_brands",
            "encoder",
          ].includes(key),
      ) ||
      probe.streams.some((s) =>
        Object.keys(s.metadata ?? {}).some(
          (key) =>
            !STREAM_METADATA.has(key) &&
            !["vendor_id", "encoder"].includes(key),
        ),
      )
    )
      reasons.push(
        "Unsupported media metadata requires an explicit preservation plan.",
      );
    if (
      probe.streams.some((s) =>
        (s.sideDataTypes ?? []).some(
          (type) => !["CPB properties", "Display Matrix"].includes(type),
        ),
      )
    )
      reasons.push(
        "Complex stream side data requires an explicit preservation plan.",
      );
    if (
      probe.streams.some(
        (s) => !/^SHA256:[a-fA-F0-9]{64}$/.test(s.extraDataSha256 ?? ""),
      )
    )
      reasons.push("Codec configuration identity is unavailable.");
    if (
      probe.audioCodec &&
      (!Number.isInteger(probe.audioChannels) ||
        probe.audioChannels < 1 ||
        !Number.isFinite(
          Number(probe.streams.find((s) => s.type === "audio")?.sampleRate),
        ) ||
        Number(probe.streams.find((s) => s.type === "audio")?.sampleRate) <= 0)
    )
      reasons.push("Audio channel and sample rate identity is unavailable.");
  }
  return reasons;
}

export function targetDimensions(probe, quality) {
  const target =
    quality === "1080p" ? 1080 : quality === "720p" ? 720 : probe.height;
  // Preserve aspect ratio, even dimensions, and never enlarge either dimension.
  const scale = Math.min(1, target / probe.height);
  return {
    width: Math.max(2, Math.floor((probe.width * scale) / 2) * 2),
    height: Math.max(2, Math.floor((probe.height * scale) / 2) * 2),
  };
}

export function parsePlaylist(text) {
  ensure(
    text.startsWith("#EXTM3U") && text.includes("#EXT-X-ENDLIST"),
    "Incomplete HLS manifest",
  );
  const entries = [];
  let duration;
  for (const line of text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (line.startsWith("#EXTINF:")) {
      duration = Number(line.slice(8).split(",")[0]);
      ensure(
        Number.isFinite(duration) && duration > 0,
        "Invalid segment duration",
      );
    } else if (!line.startsWith("#")) {
      ensure(
        /^segment-\d{6}\.ts$/.test(line) && duration,
        "Unsafe or incomplete segment reference",
      );
      entries.push({ name: line, durationSeconds: duration });
      duration = undefined;
    }
  }
  ensure(
    entries.length > 0 && entries.length <= 100000 && !duration,
    "Invalid HLS segment list",
  );
  ensure(
    new Set(entries.map((e) => e.name)).size === entries.length,
    "Duplicate HLS segment reference",
  );
  return entries;
}

async function bridge(
  route,
  { method = "GET", body, headers = {}, signal } = {},
) {
  const response = await fetch(`${BRIDGE}${route}`, {
    method,
    body,
    headers,
    signal,
    redirect: "error",
    ...(body instanceof Readable || body instanceof ReadableStream
      ? { duplex: "half" }
      : {}),
  });
  ensure(
    response.ok,
    `Task bridge rejected ${route.split("/")[1]} (${response.status})`,
  );
  return response;
}

function contextFor(task) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Confirmed task deadline reached")),
    task.deadlineMs - Date.now(),
  );
  const context = {
    task,
    controller,
    signal: controller.signal,
    timer,
    lastEvent: 0,
  };
  return context;
}

async function event(ctx, payload, force = false) {
  if (!force && Date.now() - ctx.lastEvent < 1500) return;
  ctx.lastEvent = Date.now();
  await bridge("/event", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
    signal: ctx.signal,
  });
}

async function runProcess(
  ctx,
  command,
  args,
  { onLine, maxOutput = MAX_PROBE_BYTES } = {},
) {
  ctx.signal.throwIfAborted();
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
  });
  activeChildren.add(child);
  const out = [];
  let outBytes = 0;
  let errorText = "";
  let lineBuffer = "";
  let forcedError;
  const kill = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  };
  ctx.signal.addEventListener("abort", kill, { once: true });
  child.stdout.on("data", (chunk) => {
    if (onLine) {
      lineBuffer += chunk.toString("utf8");
      let newline;
      while ((newline = lineBuffer.indexOf("\n")) !== -1) {
        try {
          onLine(lineBuffer.slice(0, newline).trim());
        } catch (error) {
          forcedError ??= error;
          kill();
        }
        lineBuffer = lineBuffer.slice(newline + 1);
      }
      if (lineBuffer.length > MAX_PROBE_BYTES) {
        forcedError = new Error("Media tool output line exceeded limit");
        kill();
      }
    } else {
      outBytes += chunk.length;
      if (outBytes > maxOutput) {
        forcedError = new Error("Media tool output exceeded limit");
        kill();
      } else out.push(chunk);
    }
  });
  child.stderr.on("data", (chunk) => {
    errorText = (errorText + chunk.toString("utf8")).slice(-8192);
  });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    ctx.signal.throwIfAborted();
    if (forcedError) throw forcedError;
    // Input names are private generated paths; never expose full FFmpeg diagnostics.
    if (code !== 0)
      throw Object.assign(
        new Error(`${command} failed with exit code ${code}`),
        { exitCode: code },
      );
    return {
      output: Buffer.concat(out).toString("utf8"),
      diagnostics: errorText,
    };
  } finally {
    activeChildren.delete(child);
    ctx.signal.removeEventListener("abort", kill);
  }
}

async function probeFile(ctx, filename, extra = []) {
  const { output } = await runProcess(ctx, "ffprobe", [
    "-v",
    "error",
    "-protocol_whitelist",
    "file,crypto,data",
    ...extra,
    "-show_streams",
    "-show_data_hash",
    "sha256",
    "-show_format",
    "-show_chapters",
    "-of",
    "json",
    filename,
  ]);
  return JSON.parse(output);
}

async function checkOutputLimit(dir, maxBytes, maxObjects = 10000) {
  let total = 0;
  const names = await readdir(dir);
  ensure(
    names.length <= maxObjects,
    "Output exceeded confirmed object reservation",
  );
  for (const name of names) {
    const info = await stat(path.join(dir, name));
    if (info.isFile()) total += info.size;
  }
  ensure(total <= maxBytes, "Output exceeded confirmed byte reservation");
  return total;
}

async function download(ctx, filename) {
  await event(
    ctx,
    { stage: "downloading", bytes: 0, totalBytes: ctx.task.inputBytes },
    true,
  );
  const response = await bridge("/input", { signal: ctx.signal });
  const length = response.headers.get("content-length");
  if (length !== null)
    ensure(
      Number(length) === ctx.task.inputBytes,
      "Source object size changed",
    );
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > ctx.task.inputBytes)
        return done(new Error("Source exceeded confirmed size"));
      event(ctx, {
        stage: "downloading",
        bytes,
        totalBytes: ctx.task.inputBytes,
      }).then(() => done(null, chunk), done);
    },
  });
  ensure(response.body, "Source response has no body");
  await pipeline(
    Readable.fromWeb(response.body),
    counter,
    createWriteStream(filename, { flags: "wx" }),
    { signal: ctx.signal },
  );
  ensure(bytes === ctx.task.inputBytes, "Incomplete source download");
  await event(
    ctx,
    { stage: "downloading", bytes, totalBytes: ctx.task.inputBytes },
    true,
  );
}

export function encodingArgs(task, input, outputDir, probe) {
  const args = [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-xerror",
    "-protocol_whitelist",
    "file,crypto,data",
    "-i",
    input,
    "-map",
    "0:v:0",
  ];
  if (probe.audioCodec) args.push("-map", "0:a:0");
  if (task.mode === "probe-remux" || task.mode === "faststart")
    args.push("-c", "copy");
  else if (task.mode === "transcode") {
    const dimensions = targetDimensions(probe, task.quality);
    const bitrate =
      task.quality === "720p"
        ? 5000000
        : task.quality === "1080p"
          ? 10000000
          : 20000000;
    args.push(
      "-vf",
      `scale=${dimensions.width}:${dimensions.height}:flags=lanczos`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-maxrate",
      String(bitrate),
      "-bufsize",
      String(bitrate * 2),
      "-pix_fmt",
      "yuv420p",
      "-force_key_frames",
      "expr:gte(t,n_forced*6)",
    );
    if (probe.audioCodec) args.push("-c:a", "aac", "-b:a", "192k");
  } else throw new Error("Invalid processing mode");
  if (task.mode === "faststart") {
    args.push("-map_metadata", "0", "-map_metadata:s:v:0", "0:s:v:0");
    if (probe.audioCodec) args.push("-map_metadata:s:a:0", "0:s:a:0");
    args.push(
      "-sn",
      "-dn",
      "-map_chapters",
      "-1",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "-progress",
      "pipe:1",
      path.join(outputDir, "optimized.mp4"),
    );
  } else
    args.push(
      "-sn",
      "-dn",
      "-f",
      "hls",
      "-hls_time",
      "6",
      "-hls_playlist_type",
      "vod",
      "-hls_flags",
      "independent_segments",
      "-hls_segment_filename",
      path.join(outputDir, "segment-%06d.ts"),
      "-progress",
      "pipe:1",
      path.join(outputDir, "index.m3u8"),
    );
  return args;
}

async function encode(ctx, input, outputDir, probe) {
  const args = encodingArgs(ctx.task, input, outputDir, probe);
  let progress = Promise.resolve();
  const watchdog = setInterval(() => {
    checkOutputLimit(
      outputDir,
      ctx.task.maxOutputBytes,
      ctx.task.maxMediaObjects,
    ).catch((error) => ctx.controller.abort(error));
  }, 500);
  try {
    await event(
      ctx,
      { stage: "processing", durationSeconds: probe.durationSeconds },
      true,
    );
    await runProcess(ctx, "ffmpeg", args, {
      onLine(line) {
        // faststart performs a second index relocation pass after packet copying;
        // out_time reaching duration would not measure completion of that pass.
        if (ctx.task.mode !== "faststart" && line.startsWith("out_time_us=")) {
          const positionSeconds = Number(line.slice(12)) / 1000000;
          if (Number.isFinite(positionSeconds))
            progress = progress
              .then(() =>
                event(ctx, {
                  stage: "processing",
                  positionSeconds: Math.max(0, positionSeconds),
                  durationSeconds: probe.durationSeconds,
                }),
              )
              .catch((error) => ctx.controller.abort(error));
        }
      },
    });
    await progress;
    await checkOutputLimit(
      outputDir,
      ctx.task.maxOutputBytes,
      ctx.task.maxMediaObjects,
    );
  } finally {
    clearInterval(watchdog);
  }
}

async function packetTimeline(ctx, filename, playlist = false) {
  const result = new Map();
  await runProcess(
    ctx,
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,crypto,data",
      ...(playlist ? ["-allowed_extensions", "ALL"] : []),
      "-show_packets",
      "-show_entries",
      "packet=codec_type,pts_time,dts_time,duration_time",
      "-of",
      "compact=p=0:nk=0",
      filename,
    ],
    {
      onLine(line) {
        const fields = Object.fromEntries(
          line.split("|").map((part) => {
            const split = part.indexOf("=");
            return [part.slice(0, split), part.slice(split + 1)];
          }),
        );
        const type = fields.codec_type;
        if (!["video", "audio"].includes(type)) return;
        const pts = Number(fields.pts_time);
        const dts = Number(fields.dts_time);
        const duration = Number(fields.duration_time);
        ensure(
          Number.isFinite(pts),
          "Media packet has no verifiable presentation timestamp",
        );
        const current = result.get(type) ?? {
          type,
          start: Infinity,
          end: -Infinity,
          lastDts: -Infinity,
          packets: 0,
        };
        if (Number.isFinite(dts)) {
          ensure(
            dts + 0.00001 >= current.lastDts,
            "Media decode timeline regressed",
          );
          current.lastDts = dts;
        }
        current.start = Math.min(current.start, pts);
        current.end = Math.max(
          current.end,
          pts + (Number.isFinite(duration) && duration > 0 ? duration : 0),
        );
        current.packets++;
        result.set(type, current);
      },
    },
  );
  ensure(result.has("video"), "Media packet timeline has no video");
  return result;
}

async function validateOutput(ctx, input, outputDir, sourceProbe) {
  await event(ctx, { stage: "validating", objects: 0 }, true);
  const manifest = await readFile(path.join(outputDir, "index.m3u8"), "utf8");
  const segments = parsePlaylist(manifest);
  ensure(
    segments.length + 1 <= ctx.task.maxMediaObjects,
    "Output exceeded confirmed object reservation",
  );
  const expectedNames = ["index.m3u8", ...segments.map((s) => s.name)].sort();
  const actualNames = (await readdir(outputDir)).sort();
  ensure(
    JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    "Unexpected or missing HLS object",
  );
  const totalDuration = segments.reduce((n, s) => n + s.durationSeconds, 0);
  ensure(
    Math.abs(totalDuration - sourceProbe.durationSeconds) <=
      Math.max(1, sourceProbe.durationSeconds * 0.01),
    "HLS duration differs from source",
  );
  let validated = 0;
  for (const segment of segments) {
    const filename = path.join(outputDir, segment.name);
    const info = await stat(filename);
    ensure(info.size > 0, "Empty HLS segment");
    const raw = await probeFile(ctx, filename);
    const summary = summarizeProbe(raw);
    const dimensions =
      ctx.task.mode === "transcode"
        ? targetDimensions(sourceProbe, ctx.task.quality)
        : { width: sourceProbe.width, height: sourceProbe.height };
    ensure(
      summary.videoCodec === "h264" &&
        summary.width === dimensions.width &&
        summary.height === dimensions.height,
      "Output codec or resolution differs from confirmation",
    );
    ensure(
      !!summary.audioCodec === !!sourceProbe.audioCodec &&
        (!summary.audioCodec || summary.audioCodec === "aac"),
      "Output audio differs from confirmation",
    );
    const { output } = await runProcess(ctx, "ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-read_intervals",
      "%+#1",
      "-show_packets",
      "-show_entries",
      "packet=flags",
      "-of",
      "json",
      filename,
    ]);
    const firstPacket = JSON.parse(output).packets?.[0];
    ensure(
      firstPacket?.flags?.includes("K"),
      "HLS segment does not begin on a keyframe",
    );
    // Decode every packet in every segment; this is stronger than file existence.
    await runProcess(
      ctx,
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-err_detect",
        "explode",
        "-protocol_whitelist",
        "file,crypto,data",
        "-i",
        filename,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-f",
        "null",
        "-",
      ],
      { maxOutput: 0 },
    );
    validated++;
    await event(ctx, {
      stage: "validating",
      objects: validated,
      totalObjects: segments.length,
    });
  }
  // Stream packet timestamps rather than buffering a potentially huge JSON
  // packet list. Compare both ends of each timeline to catch drift/truncation.
  const sourceTimeline = await packetTimeline(ctx, input);
  const outputTimeline = await packetTimeline(
    ctx,
    path.join(outputDir, "index.m3u8"),
    true,
  );
  const sourceV = sourceTimeline.get("video");
  const sourceA = sourceTimeline.get("audio");
  const outputV = outputTimeline.get("video");
  const outputA = outputTimeline.get("audio");
  let syncOffsetDifferenceSeconds = null;
  let syncEndOffsetDifferenceSeconds = null;
  ensure(
    Math.abs(sourceV.end - sourceV.start - (outputV.end - outputV.start)) <=
      0.25,
    "Video packet timeline changed duration",
  );
  if (sourceA && outputA) {
    syncOffsetDifferenceSeconds = Math.abs(
      sourceA.start - sourceV.start - (outputA.start - outputV.start),
    );
    syncEndOffsetDifferenceSeconds = Math.abs(
      sourceA.end - sourceV.end - (outputA.end - outputV.end),
    );
    ensure(
      syncOffsetDifferenceSeconds <= 0.15,
      "A/V synchronization offset changed",
    );
    ensure(
      syncEndOffsetDifferenceSeconds <= 0.25,
      "A/V end synchronization offset changed",
    );
    ensure(
      Math.abs(sourceA.end - sourceA.start - (outputA.end - outputA.start)) <=
        0.25,
      "Audio packet timeline changed duration",
    );
  }
  // Also decode the complete playlist to check continuity across segment boundaries.
  await runProcess(
    ctx,
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-err_detect",
      "explode",
      "-protocol_whitelist",
      "file,crypto,data",
      "-allowed_extensions",
      "ALL",
      "-i",
      path.join(outputDir, "index.m3u8"),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-f",
      "null",
      "-",
    ],
    { maxOutput: 0 },
  );
  const playlistRaw = await probeFile(ctx, path.join(outputDir, "index.m3u8"), [
    "-allowed_extensions",
    "ALL",
  ]);
  const playlistDuration = Number(playlistRaw.format?.duration);
  ensure(
    Number.isFinite(playlistDuration) &&
      Math.abs(playlistDuration - totalDuration) <= 1,
    "Playlist timeline is inconsistent",
  );
  await event(
    ctx,
    {
      stage: "validating",
      objects: segments.length,
      totalObjects: segments.length,
    },
    true,
  );
  return {
    manifest,
    segments,
    durationSeconds: totalDuration,
    validation: {
      segmentCount: segments.length,
      allSegmentsDecoded: true,
      playlistDecoded: true,
      keyframeStarts: true,
      durationDifferenceSeconds: totalDuration - sourceProbe.durationSeconds,
      syncOffsetDifferenceSeconds,
      syncEndOffsetDifferenceSeconds,
      packetTimelinesVerified: true,
      codecAndResolutionVerified: true,
      browserPlaybackAndSeeking: "pending_admin_preview",
    },
  };
}

// Read only bounded top-level headers. FFprobe validates stream contents; this
// establishes real MP4 branding, one movie index and its position without
// buffering media payloads or treating a filename/MIME type as evidence.
export async function inspectMp4Layout(filename, signal) {
  const file = await open(filename, "r");
  try {
    const size = (await file.stat()).size;
    ensure(
      Number.isSafeInteger(size) && size >= 24,
      "MP4 structure is incomplete",
    );
    let offset = 0;
    let boxes = 0;
    let ftyp = false;
    let moov;
    const media = [];
    while (offset < size) {
      signal?.throwIfAborted();
      ensure(
        ++boxes <= 256 && size - offset >= 8,
        "MP4 top-level scan exceeded its bounds",
      );
      const header = Buffer.alloc(16);
      const requested = Math.min(16, size - offset);
      ensure(
        (await file.read(header, 0, requested, offset)).bytesRead === requested,
        "Incomplete MP4 box header",
      );
      const type = header.toString("ascii", 4, 8);
      let length = header.readUInt32BE(0);
      let headerBytes = 8;
      if (length === 1) {
        ensure(size - offset >= 16, "Incomplete extended MP4 box");
        const extended = header.readBigUInt64BE(8);
        ensure(
          extended <= BigInt(Number.MAX_SAFE_INTEGER),
          "MP4 box size is unsafe",
        );
        length = Number(extended);
        headerBytes = 16;
      } else if (length === 0) length = size - offset;
      ensure(
        length >= headerBytes && length <= size - offset,
        "MP4 box exceeds actual file",
      );
      ensure(
        !["moof", "mfra", "styp"].includes(type),
        "Fragmented MP4 requires an explicit preservation plan",
      );
      if (type === "ftyp") {
        ensure(
          !ftyp &&
            offset === 0 &&
            length <= 1024 &&
            length - headerBytes >= 8 &&
            (length - headerBytes) % 4 === 0,
          "Invalid MP4 file type",
        );
        const brands = Buffer.alloc(length - headerBytes);
        ensure(
          (await file.read(brands, 0, brands.length, offset + headerBytes))
            .bytesRead === brands.length,
          "Incomplete MP4 brands",
        );
        const accepted = new Set([
          "isom",
          "iso2",
          "iso3",
          "iso4",
          "iso5",
          "iso6",
          "avc1",
          "mp41",
          "mp42",
        ]);
        const declared = [brands.toString("ascii", 0, 4)];
        for (let at = 8; at < brands.length; at += 4)
          declared.push(brands.toString("ascii", at, at + 4));
        ensure(
          declared.some((brand) => accepted.has(brand)) &&
            !declared.includes("qt  "),
          "Source is not a supported MP4",
        );
        ftyp = true;
      } else if (type === "moov") {
        ensure(
          !moov && length > headerBytes,
          "MP4 movie index is missing or duplicated",
        );
        moov = { offset, bytes: length };
      } else if (type === "mdat") {
        ensure(length > headerBytes, "Empty MP4 media box");
        media.push({ offset, bytes: length });
      }
      offset += length;
    }
    ensure(
      ftyp && moov && media.length > 0 && offset === size,
      "MP4 structure is incomplete",
    );
    return {
      moovOffset: moov.offset,
      moovBytes: moov.bytes,
      beforeMedia: media.every((m) => moov.offset + moov.bytes <= m.offset),
    };
  } finally {
    await file.close();
  }
}

async function copyPacketEvidence(ctx, filename, probe) {
  const streams = new Map(probe.streams.map((s) => [s.index, s.type]));
  const result = new Map();
  let packetNumber = -1;
  let fields = {};
  const consume = () => {
    if (packetNumber < 0) return;
    const index = Number(fields.stream_index);
    const type = streams.get(index);
    const pts = Number(fields.pts_time);
    const dts = Number(fields.dts_time);
    const duration = Number(fields.duration_time);
    const bytes = Number(fields.size);
    ensure(
      ["video", "audio"].includes(type) && Number.isSafeInteger(index),
      "Unexpected copied packet stream",
    );
    ensure(
      Number.isFinite(pts) &&
        Number.isFinite(dts) &&
        Number.isFinite(duration) &&
        duration > 0,
      "Copied packet has no complete timeline",
    );
    ensure(
      Number.isSafeInteger(bytes) &&
        bytes > 0 &&
        /^SHA256:[a-fA-F0-9]{64}$/.test(fields.data_hash ?? ""),
      "Copied packet payload hash is unavailable",
    );
    const current = result.get(index) ?? {
      type,
      start: Infinity,
      end: -Infinity,
      firstDts: dts,
      lastDts: -Infinity,
      packets: 0,
      payload: createHash("sha256"),
      timeline: createHash("sha256"),
    };
    ensure(
      dts + 0.000001 >= current.lastDts,
      "Copied packet decode timeline regressed",
    );
    current.lastDts = dts;
    current.start = Math.min(current.start, pts);
    current.end = Math.max(current.end, pts + duration);
    current.packets++;
    // Length framing prevents ambiguous concatenation. Normalize only a whole
    // stream's timestamp origin; internal PTS/DTS/duration changes fail closed.
    current.payload.update(
      `${bytes}:${fields.data_hash.slice(7).toLowerCase()}\n`,
    );
    current.timeline.update(
      `${[pts - current.firstDts, dts - current.firstDts, duration].map((n) => Math.round(n * 1e6)).join(":")}\n`,
    );
    result.set(index, current);
  };
  await runProcess(
    ctx,
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,crypto,data",
      "-show_packets",
      "-show_data_hash",
      "sha256",
      "-show_entries",
      "packet=stream_index,pts_time,dts_time,duration_time,size,data_hash",
      "-of",
      "flat",
      filename,
    ],
    {
      onLine(line) {
        if (!line) return;
        // FFprobe 5.1 writes packet side data before data_hash, which can split
        // compact output into several lines. Flat keys bind every selected field
        // to its packet number; retain only the current bounded record.
        const match = /^packets\.packet\.(\d+)\.(.+?)=(.*)$/.exec(line);
        ensure(match, "Unrecognized copied packet evidence");
        const number = Number(match[1]);
        ensure(
          Number.isSafeInteger(number) &&
            (number === packetNumber || number === packetNumber + 1),
          "Copied packet record order changed",
        );
        if (number !== packetNumber) {
          consume();
          packetNumber = number;
          fields = {};
        }
        const key = match[2];
        if (
          ![
            "stream_index",
            "pts_time",
            "dts_time",
            "duration_time",
            "size",
            "data_hash",
          ].includes(key)
        )
          return;
        ensure(!Object.hasOwn(fields, key), "Duplicate copied packet field");
        fields[key] = match[3].startsWith('"')
          ? JSON.parse(match[3])
          : match[3];
      },
    },
  );
  consume();
  ensure(
    result.size === probe.streams.length,
    "A copied stream has no packets",
  );
  return new Map(
    [...result.values()].map((s) => [
      s.type,
      {
        ...s,
        sha256: s.payload.digest("hex"),
        timelineSha256: s.timeline.digest("hex"),
      },
    ]),
  );
}

export async function validateFaststartOutput(
  ctx,
  input,
  outputDir,
  sourceProbe,
) {
  await event(ctx, { stage: "validating", objects: 0, totalObjects: 1 }, true);
  ensure(
    ctx.task.mode === "faststart" && ctx.task.maxMediaObjects === 1,
    "Invalid faststart validation scope",
  );
  ensure(
    JSON.stringify(await readdir(outputDir)) ===
      JSON.stringify(["optimized.mp4"]),
    "Unexpected or missing MP4 output",
  );
  await checkOutputLimit(outputDir, ctx.task.maxOutputBytes, 1);
  const filename = path.join(outputDir, "optimized.mp4");
  const layout = await inspectMp4Layout(filename, ctx.signal);
  ensure(layout.beforeMedia, "Optimized MP4 index is not before all media");
  const outputProbe = summarizeProbe(await probeFile(ctx, filename));
  ensure(
    processingReasons(sourceProbe, "faststart").length === 0 &&
      processingReasons(outputProbe, "faststart").length === 0,
    "MP4 streams are outside the confirmed copy scope",
  );
  for (const key of [
    "width",
    "height",
    "videoCodec",
    "pixelFormat",
    "videoProfile",
    "audioCodec",
    "audioProfile",
    "audioChannels",
  ])
    ensure(
      sourceProbe[key] === outputProbe[key],
      "Copied codec or resolution identity changed",
    );
  for (const key of FORMAT_METADATA)
    if (Object.hasOwn(sourceProbe.formatMetadata ?? {}, key))
      ensure(
        sourceProbe.formatMetadata[key] === outputProbe.formatMetadata[key],
        "Copied format metadata changed",
      );
  for (const type of ["video", "audio"]) {
    const source = sourceProbe.streams.find((s) => s.type === type);
    const output = outputProbe.streams.find((s) => s.type === type);
    ensure(!!source === !!output, "Copied stream inventory changed");
    if (source)
      ensure(
        source.extraDataSha256.toLowerCase() ===
          output.extraDataSha256.toLowerCase(),
        "Copied codec configuration changed",
      );
    if (source && type === "audio")
      ensure(
        Number(source.sampleRate) === Number(output.sampleRate),
        "Copied audio sample rate changed",
      );
    if (source)
      for (const key of STREAM_METADATA)
        if (Object.hasOwn(source.metadata ?? {}, key))
          ensure(
            source.metadata[key] === output.metadata[key],
            "Copied stream metadata changed",
          );
  }
  const durationDifferenceSeconds =
    outputProbe.durationSeconds - sourceProbe.durationSeconds;
  ensure(
    Number.isFinite(durationDifferenceSeconds) &&
      Math.abs(durationDifferenceSeconds) <= 0.25,
    "MP4 duration differs from source",
  );
  const sourcePackets = await copyPacketEvidence(ctx, input, sourceProbe);
  const outputPackets = await copyPacketEvidence(ctx, filename, outputProbe);
  const copiedStreams = [];
  for (const [type, source] of sourcePackets) {
    const output = outputPackets.get(type);
    ensure(
      output &&
        source.packets === output.packets &&
        source.sha256 === output.sha256,
      "Copied packet payloads changed",
    );
    ensure(
      source.timelineSha256 === output.timelineSha256 &&
        Math.abs(source.end - source.start - (output.end - output.start)) <=
          0.25,
      "Copied packet timeline changed",
    );
    copiedStreams.push({
      type,
      packets: source.packets,
      sha256: source.sha256,
      outputPackets: output.packets,
      outputSha256: output.sha256,
    });
  }
  const sourceV = sourcePackets.get("video");
  const outputV = outputPackets.get("video");
  const sourceA = sourcePackets.get("audio");
  const outputA = outputPackets.get("audio");
  const syncOffsetDifferenceSeconds = sourceA
    ? Math.abs(sourceA.start - sourceV.start - (outputA.start - outputV.start))
    : 0;
  const syncEndOffsetDifferenceSeconds = sourceA
    ? Math.abs(sourceA.end - sourceV.end - (outputA.end - outputV.end))
    : 0;
  ensure(
    Number.isFinite(syncOffsetDifferenceSeconds) &&
      syncOffsetDifferenceSeconds <= 0.15 &&
      Number.isFinite(syncEndOffsetDifferenceSeconds) &&
      syncEndOffsetDifferenceSeconds <= 0.25,
    "Copied A/V synchronization changed",
  );
  await runProcess(
    ctx,
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-err_detect",
      "explode",
      "-protocol_whitelist",
      "file,crypto,data",
      "-i",
      filename,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-f",
      "null",
      "-",
    ],
    { maxOutput: 0 },
  );
  await event(ctx, { stage: "validating", objects: 1, totalObjects: 1 }, true);
  return {
    durationSeconds: outputProbe.durationSeconds,
    validation: {
      outputKind: "mp4",
      faststartVerified: true,
      allPacketsDecoded: true,
      packetTimelinesVerified: true,
      codecAndResolutionVerified: true,
      copiedStreamsVerified: true,
      copiedStreams,
      durationDifferenceSeconds,
      mediaMetadataPreserved: true,
      syncOffsetDifferenceSeconds,
      syncEndOffsetDifferenceSeconds,
      browserPlaybackAndSeeking: "pending_admin_preview",
    },
  };
}

export async function upload(ctx, outputDir, validated) {
  const faststart = ctx.task.mode === "faststart";
  const names = faststart
    ? ["optimized.mp4"]
    : [...validated.segments.map((s) => s.name), "index.m3u8"];
  const totalBytes = await checkOutputLimit(
    outputDir,
    ctx.task.maxOutputBytes,
    ctx.task.maxMediaObjects ?? 10000,
  );
  const objects = [];
  let bytes = 0;
  // Upload progress measures acknowledged durable objects. Reading a request
  // body does not prove those bytes reached either the network or R2.
  const reportProgress = (force = false) =>
    event(
      ctx,
      {
        stage: "uploading",
        bytes,
        totalBytes,
        progressBasis: "persisted-bytes",
      },
      force,
    );
  await reportProgress(true);
  for (const name of names) {
    ensure(
      faststart ? name === "optimized.mp4" : SAFE_OBJECT.test(name),
      "Unsafe output object",
    );
    const filename = path.join(outputDir, name);
    const info = await stat(filename);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filename, {
      signal: ctx.signal,
    }))
      hash.update(chunk);
    const sha256 = hash.digest("hex");
    // Upload retries reuse the same task/version path; they never restart FFmpeg.
    let uploaded = false;
    for (let attempt = 0; attempt < 3 && !uploaded; attempt++) {
      ctx.signal.throwIfAborted();
      let source;
      let stream;
      try {
        let sent = 0;
        const counter = new Transform({
          transform(chunk, _encoding, done) {
            sent += chunk.length;
            done(null, chunk);
          },
        });
        source = createReadStream(filename, { signal: ctx.signal });
        source.on("error", (error) => counter.destroy(error));
        stream = source.pipe(counter);
        const response = await bridge(`/output/${name}`, {
          method: "PUT",
          body: stream,
          headers: {
            "Content-Type": faststart
              ? "video/mp4"
              : name.endsWith(".m3u8")
                ? "application/vnd.apple.mpegurl"
                : "video/mp2t",
            "Content-Length": String(info.size),
            "X-Content-SHA256": sha256,
          },
          signal: ctx.signal,
        });
        const receipt = await response.json();
        ensure(
          receipt?.stored === true &&
            typeof receipt.duplicate === "boolean" &&
            receipt.name === name &&
            receipt.bytes === info.size &&
            receipt.sha256 === sha256,
          "Output storage acknowledgment differs from the confirmed object",
        );
        // Only the bridge's checksum/size-verified existing object permits an
        // early duplicate ACK. A newly written object still requires a full body.
        ensure(
          receipt.duplicate || sent === info.size,
          "Output upload was incomplete",
        );
        uploaded = true;
      } catch (error) {
        if (attempt === 2 || ctx.signal.aborted) throw error;
      } finally {
        // fetch() may return a verified duplicate response before consuming the
        // request body. Stop the now-redundant disk read and request stream.
        if (source && stream) source.unpipe(stream);
        source?.destroy();
        stream?.destroy();
      }
    }
    bytes += info.size;
    objects.push({ name, size: info.size, sha256 });
    await reportProgress();
  }
  await reportProgress(true);
  await bridge("/complete", {
    method: "POST",
    body: JSON.stringify({
      manifest: faststart ? "optimized.mp4" : "index.m3u8",
      objects,
      durationSeconds: validated.durationSeconds,
      validation: validated.validation,
    }),
    headers: { "Content-Type": "application/json" },
    signal: ctx.signal,
  });
}

async function executeTask(ctx) {
  let workDir;
  try {
    workDir = await mkdtemp("/work/task-");
    const outputDir = path.join(workDir, "output");
    await mkdir(outputDir);
    const disk = await statfs(workDir);
    const available = Number(disk.bavail) * Number(disk.bsize);
    ensure(
      available >=
        ctx.task.inputBytes + ctx.task.maxOutputBytes + 256 * 1024 ** 2,
      "Insufficient actual temporary disk space for confirmed task",
    );
    const input = path.join(workDir, "source");
    await download(ctx, input);
    await event(ctx, { stage: "probing" }, true);
    const raw = await probeFile(ctx, input);
    const probe = summarizeProbe(raw);
    await event(ctx, { stage: "probing", probe }, true);
    const reasons = processingReasons(probe, ctx.task.mode);
    if (ctx.task.mode === "faststart") {
      try {
        await inspectMp4Layout(input, ctx.signal);
      } catch (error) {
        ctx.signal.throwIfAborted();
        reasons.push(String(error.message).slice(0, 256));
      }
    }
    if (probe.width * probe.height * 24 > ctx.task.memoryBytes / 2)
      reasons.push(
        "The detected decode working set exceeds the confirmed memory safety allowance.",
      );
    if (ctx.task.probe) {
      for (const key of [
        "width",
        "height",
        "videoCodec",
        "audioCodec",
        "audioProfile",
        "audioChannels",
        "pixelFormat",
        "hdr",
        "rotated",
      ]) {
        if (ctx.task.probe[key] !== probe[key])
          reasons.push(`Source ${key} differs from the confirmed probe.`);
      }
      if (
        Math.abs(
          Number(ctx.task.probe.durationSeconds) - probe.durationSeconds,
        ) > 0.1
      )
        reasons.push("Source duration differs from the confirmed probe.");
    }
    if (reasons.length) {
      await bridge("/needs-confirmation", {
        method: "POST",
        body: JSON.stringify({ probe, reasons }),
        headers: { "Content-Type": "application/json" },
        signal: ctx.signal,
      });
      return;
    }
    await encode(ctx, input, outputDir, probe);
    const validated =
      ctx.task.mode === "faststart"
        ? await validateFaststartOutput(ctx, input, outputDir, probe)
        : await validateOutput(ctx, input, outputDir, probe);
    await upload(ctx, outputDir, validated);
  } catch (error) {
    // The coordinator retains its own deadline and stop alarm even if this event
    // cannot arrive. Report a bounded message without raw input or tool output.
    const safeError = ctx.signal.aborted
      ? "Task cancelled or confirmed deadline reached"
      : String(error.message ?? "Processing failed").slice(0, 256);
    try {
      await bridge("/event", {
        method: "POST",
        body: JSON.stringify({
          stage: "failed",
          error: safeError,
          exitCode: Number.isInteger(error.exitCode)
            ? error.exitCode
            : undefined,
        }),
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      /* Durable Object supervision remains authoritative. */
    }
  } finally {
    clearTimeout(ctx.timer);
    if (workDir) await rm(workDir, { recursive: true, force: true });
    activeTask = undefined;
    shuttingDown = true;
    // A task never remains alive awaiting another administrator confirmation.
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }
}

async function readJSON(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    ensure(bytes <= MAX_REQUEST_BYTES, "Task body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  const url = new URL(request.url, "http://container");
  if (request.method === "GET" && url.pathname === "/health") {
    response
      .writeHead(shuttingDown ? 503 : 200)
      .end(JSON.stringify({ ready: !shuttingDown, busy: !!activeTask }));
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/run") {
    response.writeHead(404).end('{"error":"Not found"}');
    return;
  }
  try {
    const task = validateTask(await readJSON(request));
    if (servedTask === task.taskId) {
      response
        .writeHead(202)
        .end(JSON.stringify({ taskId: task.taskId, duplicate: true }));
      return;
    }
    if (servedTask || activeTask || shuttingDown) {
      response
        .writeHead(409)
        .end('{"error":"Container is reserved for one task"}');
      return;
    }
    servedTask = task.taskId;
    activeTask = contextFor(task);
    response
      .writeHead(202)
      .end(JSON.stringify({ taskId: task.taskId, accepted: true }));
    void executeTask(activeTask);
  } catch {
    response.writeHead(400).end('{"error":"Invalid task request"}');
  }
});

async function shutdown() {
  shuttingDown = true;
  activeTask?.controller.abort(new Error("Container stopping"));
  for (const child of activeChildren) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  }
  if (!activeTask) server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  server.listen(8080, "0.0.0.0");
}
