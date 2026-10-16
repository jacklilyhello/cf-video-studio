import { describe, expect, it } from "vitest";
import { inspectSourceMp4 } from "../src/source-mp4";
import {
  FragmentedPlaybackError,
  normalizeFragmentedMedia,
  parseFragmentedPlaybackPlan,
  readFragmentedFooter,
  SOURCE_FRAGMENTED_LIMITS,
} from "../web/source-fragmented-mp4";
import {
  concat,
  fixtureBoxes,
  fragmentedMp4Fixture,
} from "./fragmented-fixture";

// Zero payloads are synthetic and NOT decodable media. These tests establish
// bounded structure/relocation and byte preservation, never browser playback.
const hash = async (b: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(b).buffer),
    ),
  )
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const set = (b: Uint8Array, at: number, value: number) =>
  new DataView(b.buffer, b.byteOffset).setUint32(at, value);
const inspect = (b: Uint8Array) =>
  inspectSourceMp4(b.length, async (offset, length) =>
    b.slice(offset, offset + length),
  );
function descendants(b: Uint8Array, name: string) {
  const found: ReturnType<typeof fixtureBoxes> = [];
  const scan = (start: number, end: number) => {
    for (const item of fixtureBoxes(b, start, end)) {
      if (item.type === name) found.push(item);
      if (
        [
          "moov",
          "trak",
          "mdia",
          "minf",
          "stbl",
          "mvex",
          "moof",
          "traf",
          "mfra",
          "dinf",
          "edts",
        ].includes(item.type)
      )
        scan(item.data, item.end);
    }
  };
  scan(0, b.length);
  return found;
}
async function setup(options: Parameters<typeof fragmentedMp4Fixture>[0] = {}) {
  const bytes = fragmentedMp4Fixture({ fragments: 3, index: true, ...options });
  const proof = await inspect(bytes);
  expect(proof.compatible).toBe(true);
  const mfra = fixtureBoxes(bytes).find((b) => b.type === "mfra")!;
  const args = {
    prefix: bytes.slice(
      0,
      Math.min(bytes.length, SOURCE_FRAGMENTED_LIMITS.initBytes),
    ),
    mfra: bytes.slice(mfra.start, mfra.end),
    totalBytes: bytes.length,
    proof,
  };
  const plan = parseFragmentedPlaybackPlan(args);
  const fragmentBytes = (index = 0) => {
    const f = plan.fragments[index];
    return bytes.slice(f.offset, f.offset + f.length);
  };
  return { bytes, proof, args, plan, fragmentBytes };
}

describe("bounded original fMP4 playback packaging", () => {
  it("plans an exact complete index using codec configuration and the verified source proof", async () => {
    const f = await setup();
    expect(f.plan.mimeType).toBe('video/mp4; codecs="avc1.42001e,mp4a.40.2"');
    expect(f.plan.videoTrackId).toBe(1);
    expect(f.plan.audioTrackId).toBe(2);
    expect(f.plan.durationSeconds).toBe(3);
    expect(f.plan.fragments.map((p) => [p.startSeconds, p.endSeconds])).toEqual(
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    );
    expect(f.plan.fragments[0].offset).toBe(f.plan.initEnd);
    const last = f.plan.fragments.at(-1)!;
    expect(last.offset + last.length).toBe(f.bytes.length - f.args.mfra.length);
    expect(f.plan.init).toEqual(f.args.prefix.slice(0, f.plan.initEnd));
    expect(
      readFragmentedFooter(f.args.mfra.slice(-16), f.bytes.length),
    ).toEqual({
      offset: last.offset + last.length,
      length: f.args.mfra.length,
    });
  });

  it("relocates actual absolute-base header shapes and preserves every mdat byte and sample reference", async () => {
    const f = await setup({
      addressing: "absolute",
      defaults: "tfhd",
      indexTrafNumber: "track-first",
      audioPadding: 14,
    });
    expect(f.plan.indexBasis).toBe("track-id-compatibility");
    const outputs = await Promise.all(
      f.plan.fragments.map(async (fragment) => {
        const input = f.fragmentBytes(fragment.index),
          before = input.slice();
        // Make the sample and padding bytes distinguishable without claiming they decode.
        const oldMdat = fixtureBoxes(input).find((b) => b.type === "mdat")!;
        for (let p = oldMdat.data; p < oldMdat.end; p++)
          input[p] = (p * 37 + fragment.index) % 256;
        const inputHash = await hash(input),
          out = normalizeFragmentedMedia(input, fragment, f.plan);
        expect(await hash(input)).toBe(inputHash);
        const newMdat = fixtureBoxes(out).find((b) => b.type === "mdat")!;
        expect(out.length).toBe(input.length - 16);
        expect(await hash(out.subarray(newMdat.start, newMdat.end))).toBe(
          await hash(input.subarray(oldMdat.start, oldMdat.end)),
        );
        const oldHeaders = descendants(input, "tfhd"),
          newHeaders = descendants(out, "tfhd");
        for (let n = 0; n < newHeaders.length; n++) {
          expect(newHeaders[n].end - newHeaders[n].start).toBe(
            oldHeaders[n].end - oldHeaders[n].start - 8,
          );
          expect(new DataView(out.buffer).getUint32(newHeaders[n].data)).toBe(
            0x20038,
          );
        }
        const oldRuns = descendants(input, "trun"),
          newRuns = descendants(out, "trun");
        for (let n = 0; n < newRuns.length; n++) {
          const oldOffset = new DataView(input.buffer).getInt32(
              oldRuns[n].data + 8,
            ),
            newOffset = new DataView(out.buffer).getInt32(newRuns[n].data + 8);
          expect(newOffset).toBe(oldOffset - 16);
          expect(out.slice(newOffset, newOffset + 8)).toEqual(
            input.slice(oldOffset, oldOffset + 8),
          );
          expect(out.slice(newRuns[n].data + 12, newRuns[n].end)).toEqual(
            input.slice(oldRuns[n].data + 12, oldRuns[n].end),
          );
        }
        expect(before.length).toBe(input.length);
        return out;
      }),
    );
    // Independently feed the transient normalized chain to the existing actual
    // server parser. It proves offsets/timelines, not decoding of zero samples.
    expect(await inspect(concat(f.plan.init, ...outputs))).toMatchObject({
      compatible: true,
      durationSeconds: f.plan.durationSeconds,
      fragmented: {
        fragmentCount: 3,
        sampleCount: 12,
        sampleRangesVerified: true,
        timelinesVerified: true,
      },
    });
  });

  it.each(["trex", "tfhd", "trun"] as const)(
    "supports %s defaults without unnecessary sample or header changes",
    async (defaults) => {
      const f = await setup({ defaults });
      for (const fragment of f.plan.fragments) {
        const input = f.fragmentBytes(fragment.index);
        expect(normalizeFragmentedMedia(input, fragment, f.plan)).toEqual(
          input,
        );
      }
    },
  );
  it("supports video-only sources without introducing audio", async () => {
    const f = await setup({ audio: false, addressing: "absolute" });
    expect(f.plan.audioTrackId).toBeNull();
    expect(f.plan.mimeType).toBe('video/mp4; codecs="avc1.42001e"');
    expect(
      normalizeFragmentedMedia(f.fragmentBytes(), f.plan.fragments[0], f.plan)
        .length,
    ).toBe(f.fragmentBytes().length - 8);
  });
  it("preserves signed composition offsets and tfdt exactly", async () => {
    const bytes = fragmentedMp4Fixture({
      fragments: 3,
      index: true,
      signedCts: true,
      addressing: "absolute",
    });
    for (const box of descendants(bytes, "mdhd"))
      set(bytes, box.data + 12, 10000);
    const proof = await inspect(bytes);
    expect(proof.compatible).toBe(true);
    const mfra = fixtureBoxes(bytes).find((b) => b.type === "mfra")!;
    const plan = parseFragmentedPlaybackPlan({
      prefix: bytes,
      mfra: bytes.slice(mfra.start),
      totalBytes: bytes.length,
      proof,
    });
    const fragment = plan.fragments[1],
      input = bytes.slice(fragment.offset, fragment.offset + fragment.length);
    const output = normalizeFragmentedMedia(input, fragment, plan);
    for (const name of ["tfdt", "trun"]) {
      const old = descendants(input, name),
        updated = descendants(output, name);
      old.forEach((b, i) => {
        const skip = name === "trun" ? 12 : 0;
        expect(output.slice(updated[i].data + skip, updated[i].end)).toEqual(
          input.slice(b.data + skip, b.end),
        );
      });
    }
  });

  it.each(["magic", "flags", "short", "size", "unsafe-total"])(
    "rejects invalid footer %s without a media allocation",
    (kind) => {
      const b = new Uint8Array(16),
        d = new DataView(b.buffer);
      d.setUint32(0, 16);
      b.set(new TextEncoder().encode("mfro"), 4);
      d.setUint32(12, 80);
      if (kind === "magic") b[4] = 0;
      if (kind === "flags") d.setUint32(8, 1);
      if (kind === "size")
        d.setUint32(12, SOURCE_FRAGMENTED_LIMITS.indexBytes + 1);
      expect(() =>
        readFragmentedFooter(
          kind === "short" ? b.slice(1) : b,
          kind === "unsafe-total" ? Infinity : 1000,
        ),
      ).toThrow(FragmentedPlaybackError);
    },
  );

  it.each([
    "incompatible",
    "timeline",
    "index-count",
    "missing-index",
    "fragment-limit",
  ])("requires a complete proof: %s", async (kind) => {
    const f = await setup(),
      proof = structuredClone(f.proof);
    if (kind === "incompatible") proof.compatible = false;
    if (kind === "timeline")
      proof.fragmented!.timelinesVerified = false as true;
    if (kind === "index-count") proof.fragmented!.randomAccessIndex!.entries--;
    if (kind === "missing-index") delete proof.fragmented!.randomAccessIndex;
    if (kind === "fragment-limit") proof.fragmented!.fragmentCount = 1025;
    expect(() => parseFragmentedPlaybackPlan({ ...f.args, proof })).toThrow(
      FragmentedPlaybackError,
    );
  });

  it.each([
    "duplicate-offset",
    "outside-file",
    "first-offset",
    "backward-time",
    "track-mismatch",
    "trun",
    "sample",
    "track-drift",
  ])("rejects forged or incomplete index %s", async (kind) => {
    const f = await setup(),
      mfra = f.args.mfra.slice(),
      tables = descendants(mfra, "tfra"),
      first = tables[0].data + 16;
    if (kind === "duplicate-offset")
      mfra.set(mfra.slice(first + 8, first + 16), first + 19 + 8);
    if (kind === "outside-file") {
      set(mfra, first + 8, 0);
      set(mfra, first + 12, f.bytes.length);
    }
    if (kind === "first-offset") set(mfra, first + 12, f.plan.initEnd + 1);
    if (kind === "backward-time") set(mfra, first + 19 + 4, 0);
    if (kind === "track-mismatch") set(mfra, tables[1].data + 4, 1);
    if (kind === "trun") mfra[first + 17] = 2;
    if (kind === "sample") mfra[first + 18] = 2;
    if (kind === "track-drift") set(mfra, tables[1].data + 20, 500);
    expect(() => parseFragmentedPlaybackPlan({ ...f.args, mfra })).toThrow(
      FragmentedPlaybackError,
    );
  });
  it("rejects partial mfra coverage instead of turning missing fragments into a media extent", async () => {
    const bytes = fragmentedMp4Fixture({
        fragments: 4,
        index: true,
        indexEvery: 2,
      }),
      proof = await inspect(bytes);
    expect(proof.compatible).toBe(true);
    const mfra = fixtureBoxes(bytes).find((b) => b.type === "mfra")!;
    expect(() =>
      parseFragmentedPlaybackPlan({
        prefix: bytes,
        mfra: bytes.slice(mfra.start),
        totalBytes: bytes.length,
        proof,
      }),
    ).toThrow("complete_index_proof_required");
  });

  it.each([
    "width",
    "audio-codec",
    "external",
    "sample-count",
    "truncated-init",
    "init-limit",
  ])("rejects mismatched init %s", async (kind) => {
    const f = await setup(),
      prefix = f.args.prefix.slice(),
      proof = structuredClone(f.proof);
    if (kind === "width") proof.width!++;
    if (kind === "audio-codec") proof.audioCodec = null;
    if (kind === "external")
      set(prefix, descendants(prefix, "dref")[0].end - 4, 0);
    if (kind === "sample-count")
      set(prefix, descendants(prefix, "stsz")[0].data + 8, 1);
    expect(() =>
      parseFragmentedPlaybackPlan({
        ...f.args,
        proof,
        prefix:
          kind === "truncated-init"
            ? prefix.slice(0, f.plan.initEnd - 1)
            : kind === "init-limit"
              ? new Uint8Array(SOURCE_FRAGMENTED_LIMITS.initBytes + 1)
              : prefix,
      }),
    ).toThrow(FragmentedPlaybackError);
  });

  it.each([
    "truncated",
    "unknown-track",
    "flags",
    "base",
    "overlap",
    "outside-mdat",
    "duration",
    "size",
    "sample-limit",
    "pts",
    "not-sync",
  ])("rejects invalid fragment %s before append", async (kind) => {
    const f = await setup({ addressing: "absolute" }),
      input = f.fragmentBytes(),
      headers = descendants(input, "tfhd"),
      runs = descendants(input, "trun");
    if (kind === "unknown-track") set(input, headers[0].data + 4, 99);
    if (kind === "flags") set(input, headers[0].data, 0x41);
    if (kind === "base") set(input, headers[0].data + 12, f.plan.initEnd + 1);
    if (kind === "overlap")
      set(
        input,
        runs[1].data + 8,
        new DataView(input.buffer).getUint32(runs[0].data + 8),
      );
    if (kind === "outside-mdat") set(input, runs[0].data + 8, input.length - 4);
    if (kind === "duration") set(input, runs[0].data + 12, 0);
    if (kind === "size") set(input, runs[0].data + 16, 0);
    if (kind === "sample-limit") set(input, runs[0].data + 4, 16385);
    if (kind === "pts") set(input, descendants(input, "tfdt")[0].data + 8, 1);
    if (kind === "not-sync") set(input, runs[0].data + 20, 0x1010000);
    expect(() =>
      normalizeFragmentedMedia(
        kind === "truncated" ? input.slice(0, -1) : input,
        f.plan.fragments[0],
        f.plan,
      ),
    ).toThrow(FragmentedPlaybackError);
  });
  it("bounds each Range and refuses an unregistered fragment object", async () => {
    const f = await setup();
    expect(() =>
      normalizeFragmentedMedia(
        f.fragmentBytes(),
        { ...f.plan.fragments[0] },
        f.plan,
      ),
    ).toThrow("fragment_range_mismatch");
    expect(() =>
      normalizeFragmentedMedia(
        new Uint8Array(SOURCE_FRAGMENTED_LIMITS.fragmentBytes + 1),
        f.plan.fragments[0],
        f.plan,
      ),
    ).toThrow("fragment_range_mismatch");
  });
  it("rejects a declared oversized fragment before allocating or reading its media", async () => {
    const f = await setup();
    expect(() =>
      parseFragmentedPlaybackPlan({
        ...f.args,
        totalBytes: f.bytes.length + SOURCE_FRAGMENTED_LIMITS.fragmentBytes,
      }),
    ).toThrow("unsupported_fragment_extent");
  });
});
