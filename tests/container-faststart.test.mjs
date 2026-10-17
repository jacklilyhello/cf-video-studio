import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";
import {
  encodingArgs,
  inspectMp4Layout,
  processingReasons,
  summarizeProbe,
  upload,
  validateFaststartOutput,
  validateTask,
} from "../container/processor.mjs";
import { sourceMp4Fixture } from "./source-fixture";

// These structural bytes and stub tool outputs are deliberately synthetic;
// no local FFmpeg/FFprobe process, container or real media conversion is run.
const directories = [];
const hash = "a".repeat(64);
function rawProbe(audio = true, indexes = [0, 1]) {
  return {
    format: { duration: "10", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
    streams: [
      {
        index: indexes[0],
        codec_type: "video",
        codec_name: "h264",
        profile: "High",
        pix_fmt: "yuv420p",
        width: 640,
        height: 360,
        extradata_hash: `SHA256:${hash}`,
      },
      ...(audio
        ? [
            {
              index: indexes[1],
              codec_type: "audio",
              codec_name: "aac",
              profile: "LC",
              channels: 2,
              sample_rate: "44100",
              extradata_hash: `SHA256:${hash}`,
            },
          ]
        : []),
    ],
  };
}
function compactPackets(indexes = [0, 1], audio = true, change = {}) {
  return (
    [
      ...[0, 5].map(
        (pts, i) =>
          `stream_index=${indexes[0]}|pts_time=${pts}|dts_time=${pts}|duration_time=5|size=4|data_hash=SHA256:${i ? "b".repeat(64) : hash}`,
      ),
      ...(audio
        ? [0, 5].map(
            (pts) =>
              `stream_index=${indexes[1]}|pts_time=${pts + (change.audioOffset ?? 0)}|dts_time=${pts + (change.audioOffset ?? 0)}|duration_time=5|size=4|data_hash=SHA256:${change.audioHash ?? hash}`,
          )
        : []),
    ].join("\n") + "\n"
  );
}
function flatPackets(compact) {
  return (
    compact
      .trim()
      .split("\n")
      .flatMap((packet, index) =>
        packet.split("|").map((field) => {
          const at = field.indexOf("=");
          return `packets.packet.${index}.${field.slice(0, at)}=${JSON.stringify(field.slice(at + 1))}`;
        }),
      )
      .join("\n") + "\n"
  );
}
function packets(indexes = [0, 1], audio = true, change = {}) {
  return flatPackets(compactPackets(indexes, audio, change));
}
function stubTools(options = {}) {
  spawn.mockImplementation((command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let output = "";
    let code = 0;
    if (command === "ffprobe" && args.includes("-show_streams"))
      output = JSON.stringify(
        options.outputProbe ?? rawProbe(options.audio !== false, [7, 9]),
      );
    else if (command === "ffprobe")
      output = args.at(-1).endsWith("optimized.mp4")
        ? (options.outputPackets ?? packets([7, 9], options.audio !== false))
        : (options.sourcePackets ?? packets([0, 1], options.audio !== false));
    else code = options.decodeExit ?? 0;
    queueMicrotask(() => {
      child.stdout.end(output);
      child.stderr.end();
      child.emit("close", code);
    });
    return child;
  });
}
async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cf-faststart-"));
  directories.push(directory);
  const input = path.join(directory, "input.mp4");
  const outputDir = path.join(directory, "output");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(outputDir);
  await writeFile(input, sourceMp4Fixture({ audio: options.audio !== false }));
  await writeFile(
    path.join(outputDir, "optimized.mp4"),
    sourceMp4Fixture({
      tail: options.tail ?? false,
      audio: options.audio !== false,
    }),
  );
  const controller = new AbortController();
  return {
    input,
    outputDir,
    ctx: {
      task: {
        taskId: "task",
        mode: "faststart",
        quality: "source",
        maxMediaObjects: 1,
        maxUploadAttempts: 3,
        outputKind: "mp4",
        outputName: "optimized.mp4",
        maxOutputBytes: 100000,
        memoryBytes: 4 * 1024 ** 3,
        inputBytes: 10000,
        deadlineMs: Date.now() + 60000,
      },
      controller,
      signal: controller.signal,
      lastEvent: 0,
    },
    probe: summarizeProbe(rawProbe(options.audio !== false)),
  };
}
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("{}", { headers: { "Content-Type": "application/json" } }),
    ),
  );
  spawn.mockReset();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

describe("copy-only MP4 faststart container", () => {
  it("requires exact single-object/source-quality/three-attempt reservation", async () => {
    const { ctx } = await fixture();
    expect(validateTask(ctx.task)).toBe(ctx.task);
    for (const change of [
      { quality: "720p" },
      { maxMediaObjects: 2 },
      { outputName: "index.m3u8" },
      { outputKind: "hls" },
      { maxUploadAttempts: 2 },
      { maxOutputBytes: 5 * 1024 ** 3 },
    ])
      expect(() => validateTask({ ...ctx.task, ...change })).toThrow();
  });
  it("copies compatible video/audio into one faststart MP4 without encoder or HLS flags", async () => {
    const { ctx, probe } = await fixture();
    const args = encodingArgs(ctx.task, "source", "/output", probe);
    expect(args).toContain("copy");
    expect(args).toContain("+faststart");
    expect(args.at(-1)).toBe("/output/optimized.mp4");
    for (const forbidden of [
      "libx264",
      "-vf",
      "-hls_time",
      "-hls_flags",
      "-c:a",
    ])
      expect(args).not.toContain(forbidden);
    expect(
      encodingArgs(
        { mode: "probe-remux", quality: "source" },
        "source",
        "/output",
        probe,
      ).at(-1),
    ).toBe("/output/index.m3u8");
    expect(() =>
      encodingArgs({ mode: "unexpected" }, "source", "/output", probe),
    ).toThrow();
  });
  it.each([
    { videoCodec: "hevc" },
    { pixelFormat: "yuv420p10le" },
    { hdr: true },
    { rotated: true },
    { audioChannels: 6 },
    { audioProfile: "HE-AAC" },
    { format: "matroska,webm" },
    { chapters: 1 },
  ])("requires new confirmation for unsupported scope %j", (change) => {
    expect(
      processingReasons(
        { ...summarizeProbe(rawProbe()), ...change },
        "faststart",
      ).length,
    ).toBeGreaterThan(0);
  });
  it("rejects extra subtitle/audio/artwork streams rather than silently mapping them away", () => {
    const probe = summarizeProbe(rawProbe());
    for (const stream of [
      { type: "subtitle" },
      { type: "audio" },
      { type: "video", attachedPicture: true },
    ])
      expect(
        processingReasons(
          { ...probe, streams: [...probe.streams, stream] },
          "faststart",
        ).length,
      ).toBeGreaterThan(0);
  });
  it("requires confirmation for unknown metadata and complex stream side data", () => {
    const probe = summarizeProbe(rawProbe());
    expect(
      processingReasons(
        { ...probe, formatMetadata: { unknown_private_tag: "not copied" } },
        "faststart",
      ),
    ).toContain(
      "Unsupported media metadata requires an explicit preservation plan.",
    );
    expect(
      processingReasons(
        {
          ...probe,
          streams: probe.streams.map((s) => ({
            ...s,
            sideDataTypes: ["Spherical Mapping"],
          })),
        },
        "faststart",
      ),
    ).toContain(
      "Complex stream side data requires an explicit preservation plan.",
    );
  });
  it("locates front and tail moov using actual bounded file headers", async () => {
    const f = await fixture();
    expect((await inspectMp4Layout(f.input)).beforeMedia).toBe(false);
    expect(
      (await inspectMp4Layout(path.join(f.outputDir, "optimized.mp4")))
        .beforeMedia,
    ).toBe(true);
    await writeFile(f.input, sourceMp4Fixture({ fragment: true }));
    await expect(inspectMp4Layout(f.input)).rejects.toThrow("Fragmented");
    await writeFile(f.input, Buffer.alloc(5000));
    await expect(inspectMp4Layout(f.input)).rejects.toThrow();
  });
  it.each([true, false])(
    "verifies payload aggregates by stream, reindexed streams and full decode (audio %s)",
    async (audio) => {
      const f = await fixture({ audio });
      stubTools({ audio });
      const result = await validateFaststartOutput(
        f.ctx,
        f.input,
        f.outputDir,
        f.probe,
      );
      expect(result.validation).toMatchObject({
        outputKind: "mp4",
        faststartVerified: true,
        allPacketsDecoded: true,
        copiedStreamsVerified: true,
        packetTimelinesVerified: true,
        browserPlaybackAndSeeking: "pending_admin_preview",
        syncOffsetDifferenceSeconds: 0,
        syncEndOffsetDifferenceSeconds: 0,
      });
      expect(result.validation.copiedStreams).toHaveLength(audio ? 2 : 1);
      for (const s of result.validation.copiedStreams) {
        expect(s.outputPackets).toBe(s.packets);
        expect(s.outputSha256).toBe(s.sha256);
      }
      expect(
        spawn.mock.calls.filter(([command]) => command === "ffmpeg"),
      ).toHaveLength(1);
      expect(
        spawn.mock.calls.find(([command]) => command === "ffmpeg")[1],
      ).toContain("explode");
    },
  );
  it("handles FFprobe5.1 flat side-data fields before packet data_hash without merging records", async () => {
    const f = await fixture();
    const withSideData = (text) =>
      text.replace(
        /(packets\.packet\.2\.data_hash=)/,
        'packets.packet.2.side_data_list.side_data.0.side_data_type="Skip Samples"\npackets.packet.2.side_data_list.side_data.0.skip_samples=1024\n$1',
      );
    stubTools({
      sourcePackets: withSideData(packets()),
      outputPackets: withSideData(packets([7, 9])),
    });
    const result = await validateFaststartOutput(
      f.ctx,
      f.input,
      f.outputDir,
      f.probe,
    );
    expect(
      result.validation.copiedStreams.find((s) => s.type === "audio").packets,
    ).toBe(2);
    expect(
      spawn.mock.calls
        .filter(
          ([command, args]) =>
            command === "ffprobe" && args.includes("-show_packets"),
        )
        .every(([, args]) => args.includes("flat")),
    ).toBe(true);
  });
  it.each([
    [
      "changed audio payload",
      { outputPackets: packets([7, 9], true, { audioHash: "c".repeat(64) }) },
      "payload",
    ],
    [
      "lost packet",
      {
        outputPackets: packets([7, 9])
          .split("\n")
          .filter((line) => !line.startsWith("packets.packet.3."))
          .join("\n"),
      },
      "payload",
    ],
    [
      "changed relative audio offset",
      { outputPackets: packets([7, 9], true, { audioOffset: 0.2 }) },
      "synchronization",
    ],
    [
      "regressed timestamps",
      {
        outputPackets: packets([7, 9]).replace(
          'packets.packet.1.dts_time="5"',
          'packets.packet.1.dts_time="-1"',
        ),
      },
      "regressed",
    ],
    [
      "missing packet hash",
      { outputPackets: packets([7, 9]).replace(`SHA256:${hash}`, "N/A") },
      "hash",
    ],
    [
      "changed packet PTS without changed span",
      {
        outputPackets: packets([7, 9]).replace(
          'packets.packet.1.pts_time="5"',
          'packets.packet.1.pts_time="4.9"',
        ),
      },
      "timeline",
    ],
    ["decode failure", { decodeExit: 1 }, "ffmpeg failed"],
    [
      "changed audio sample rate",
      {
        outputProbe: {
          ...rawProbe(true, [7, 9]),
          streams: rawProbe(true, [7, 9]).streams.map((s) =>
            s.codec_type === "audio" ? { ...s, sample_rate: "48000" } : s,
          ),
        },
      },
      "sample rate",
    ],
    [
      "changed codec configuration",
      {
        outputProbe: {
          ...rawProbe(true, [7, 9]),
          streams: rawProbe(true, [7, 9]).streams.map((s) => ({
            ...s,
            extradata_hash: `SHA256:${"c".repeat(64)}`,
          })),
        },
      },
      "configuration",
    ],
  ])("rejects %s before upload/complete", async (_name, options, message) => {
    const f = await fixture();
    stubTools(options);
    await expect(
      validateFaststartOutput(f.ctx, f.input, f.outputDir, f.probe),
    ).rejects.toThrow(message);
    expect(fetch.mock.calls.every(([url]) => url.endsWith("/event"))).toBe(
      true,
    );
  });
  it("verifies supported format and stream metadata preservation", async () => {
    const f = await fixture();
    f.probe.formatMetadata = { title: "Synthetic title" };
    f.probe.streams[0].metadata = { language: "eng" };
    const outputProbe = rawProbe(true, [7, 9]);
    outputProbe.format.tags = { title: "Synthetic title" };
    outputProbe.streams[0].tags = { language: "eng" };
    stubTools({ outputProbe });
    expect(
      (await validateFaststartOutput(f.ctx, f.input, f.outputDir, f.probe))
        .validation.mediaMetadataPreserved,
    ).toBe(true);
    outputProbe.streams[0].tags.language = "und";
    await expect(
      validateFaststartOutput(f.ctx, f.input, f.outputDir, f.probe),
    ).rejects.toThrow("stream metadata");
  });
  it("rejects tail index, surplus output and byte overflow before media tools", async () => {
    const f = await fixture({ tail: true });
    stubTools();
    await expect(
      validateFaststartOutput(f.ctx, f.input, f.outputDir, f.probe),
    ).rejects.toThrow("index");
    await writeFile(path.join(f.outputDir, "extra.ts"), "x");
    await expect(
      validateFaststartOutput(f.ctx, f.input, f.outputDir, f.probe),
    ).rejects.toThrow("Unexpected");
    expect(spawn).not.toHaveBeenCalled();
    await rm(path.join(f.outputDir, "extra.ts"));
    f.ctx.task.maxOutputBytes = 1;
    await expect(
      validateFaststartOutput(f.ctx, f.input, f.outputDir, f.probe),
    ).rejects.toThrow("byte");
  });
  it("uploads exactly optimized.mp4 with verified receipt, persisted progress and MP4 completion", async () => {
    const f = await fixture();
    const calls = [];
    fetch.mockImplementation(async (url, init) => {
      calls.push([url, init]);
      if (url.includes("/output/")) {
        const digest = createHash("sha256");
        let size = 0;
        for await (const chunk of init.body) {
          digest.update(chunk);
          size += chunk.length;
        }
        return Response.json({
          stored: true,
          duplicate: false,
          name: "optimized.mp4",
          bytes: size,
          sha256: digest.digest("hex"),
        });
      }
      return Response.json({ validated: true });
    });
    await upload(f.ctx, f.outputDir, {
      durationSeconds: 10,
      validation: { outputKind: "mp4" },
    });
    const puts = calls.filter(([url]) => url.includes("/output/"));
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe("http://task.internal/output/optimized.mp4");
    expect(puts[0][1].headers["Content-Type"]).toBe("video/mp4");
    expect(
      JSON.parse(calls.find(([url]) => url.endsWith("/complete"))[1].body),
    ).toMatchObject({
      manifest: "optimized.mp4",
      objects: [{ name: "optimized.mp4" }],
    });
    expect(
      calls
        .filter(([url]) => url.endsWith("/event"))
        .map(([, init]) => JSON.parse(init.body))
        .every((e) => e.progressBasis === "persisted-bytes"),
    ).toBe(true);
  });
});
