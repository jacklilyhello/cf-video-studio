import { describe, expect, it, vi } from "vitest";
import { inspectSourceMp4, SOURCE_MP4_PARSER_VERSION } from "../src/source-mp4";
import {
  box,
  concat,
  fixtureBoxes,
  fragmentedMp4Fixture,
  word,
} from "./fragmented-fixture";

const inspect = (b: Uint8Array) =>
  inspectSourceMp4(b.length, async (offset, length) =>
    b.slice(offset, offset + length),
  );
const descendants = (b: Uint8Array, type: string) => {
  const result: ReturnType<typeof fixtureBoxes> = [];
  const walk = (start: number, end: number) => {
    for (const item of fixtureBoxes(b, start, end)) {
      if (item.type === type) result.push(item);
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
        ].includes(item.type)
      )
        walk(item.data, item.end);
    }
  };
  walk(0, b.length);
  return result;
};
const set = (b: Uint8Array, at: number, value: number) =>
  new DataView(b.buffer, b.byteOffset).setUint32(at, value);
const rename = (b: Uint8Array, at: number, name: string) =>
  b.set(new TextEncoder().encode(name), at + 4);

// These samples are deliberately zeros: these tests prove metadata validation,
// not that a real browser or decoder has accepted the synthetic sample payload.
describe("bounded fragmented MP4 source inspection", () => {
  it("derives full duration from continuous fragments with empty init tables", async () => {
    const result = await inspect(fragmentedMp4Fixture({ fragments: 3 }));
    expect(SOURCE_MP4_PARSER_VERSION).toBe("iso-bmff-source-v5");
    expect(result).toMatchObject({
      compatible: true,
      reasons: [],
      durationSeconds: 3,
      audioChannels: 2,
      validationBasis: "bounded-iso-bmff-metadata",
      serverDecoded: false,
      index: { placement: "before-media" },
      fragmented: {
        fragmentCount: 3,
        sampleCount: 12,
        sampleRangesVerified: true,
        timelinesVerified: true,
        tracks: [
          {
            id: 1,
            type: "video",
            sampleCount: 6,
            timescale: 1000,
            decodeStartSeconds: 0,
            decodeEndSeconds: 3,
            presentationStartSeconds: 0,
            presentationEndSeconds: 3,
          },
          { id: 2, type: "audio", sampleCount: 6 },
        ],
      },
    });
    expect(JSON.stringify(result).length).toBeLessThan(4096);
  });
  it.each(["trex", "tfhd", "trun"] as const)(
    "resolves %s defaults without changing sample coverage",
    async (defaults) => {
      expect(await inspect(fragmentedMp4Fixture({ defaults }))).toMatchObject({
        compatible: true,
        durationSeconds: 2,
      });
    },
  );
  it("supports separately interleaved audio and video moofs", async () => {
    expect(
      await inspect(fragmentedMp4Fixture({ separateTracks: true })),
    ).toMatchObject({
      compatible: true,
      fragmented: { fragmentCount: 4, sampleCount: 8 },
    });
  });
  it.each(["absolute", "implicit"] as const)(
    "validates %s base addressing against the same fragment's mdat",
    async (addressing) => {
      expect(
        await inspect(
          fragmentedMp4Fixture({
            addressing,
            audio: addressing === "implicit" ? false : true,
          }),
        ),
      ).toMatchObject({ compatible: true });
    },
  );
  it("validates signed CTS with reordered presentation samples", async () => {
    expect(
      await inspect(fragmentedMp4Fixture({ signedCts: true })),
    ).toMatchObject({
      compatible: true,
      durationSeconds: 2,
      fragmented: { timelinesVerified: true },
    });
  });
  it("supports the zero-duration single rate-one edit used by fragment init segments", async () => {
    expect(await inspect(fragmentedMp4Fixture({ edit: true }))).toMatchObject({
      compatible: true,
      durationSeconds: 2,
    });
  });
  it("cross-checks a nonzero mehd duration in the movie timescale", async () => {
    expect(
      await inspect(fragmentedMp4Fixture({ mehdSeconds: 2 })),
    ).toMatchObject({ compatible: true });
    expect(
      await inspect(fragmentedMp4Fixture({ mehdSeconds: 3 })),
    ).toMatchObject({
      compatible: false,
      reasons: ["fragment_duration_mismatch"],
    });
  });
  it("keeps classic-only callers bounded by rejecting the first moof header", async () => {
    const b = fragmentedMp4Fixture({ fragments: 80, mdatPadding: 8192 });
    const read = vi.fn(async (offset: number, length: number) =>
      b.slice(offset, offset + length),
    );
    expect(
      await inspectSourceMp4(b.length, read, { allowFragmented: false }),
    ).toMatchObject({
      compatible: false,
      reasons: ["fragmented_or_encrypted_mp4"],
    });
    expect(read.mock.calls).toHaveLength(3);
    expect(read.mock.calls.every(([, length]) => length === 8)).toBe(true);
  });
  it("cross-checks a trailing random-access index against actual verified fragments", async () => {
    expect(await inspect(fragmentedMp4Fixture({ index: true }))).toMatchObject({
      compatible: true,
    });
    const wrong = fragmentedMp4Fixture({ index: true });
    const tfra = descendants(wrong, "tfra")[0];
    set(wrong, tfra.data + 28, 0); // low half of first referenced moof offset
    expect(await inspect(wrong)).toMatchObject({
      compatible: false,
      reasons: ["unverified_fragment_index"],
    });
  });
  it("accepts only bounded all-zero AAC-LC config padding, rejecting unknown extension bits", async () => {
    const padded = fragmentedMp4Fixture({ audioPadding: 14 });
    expect(await inspect(padded)).toMatchObject({
      compatible: true,
      audioCodec: "mp4a.40.2",
    });
    // Find the 16-byte ASC descriptor in the synthetic audio esds.
    const marker = padded.findIndex(
      (byte, i) =>
        byte === 5 &&
        padded[i + 1] === 16 &&
        padded[i + 2] === 0x12 &&
        padded[i + 3] === 0x10,
    );
    padded[marker + 17] = 1;
    expect(await inspect(padded)).toMatchObject({
      compatible: false,
      reasons: ["unsupported_aac_profile"],
    });
    expect(
      await inspect(fragmentedMp4Fixture({ audioPadding: 15 })),
    ).toMatchObject({
      compatible: false,
      reasons: ["unsupported_aac_profile"],
    });
  });
  it.each([13, 14])("rejects reserved AAC sampling index %i", async (index) => {
    const b = fragmentedMp4Fixture();
    const marker = b.findIndex(
      (byte, i) =>
        byte === 5 && b[i + 1] === 2 && b[i + 2] === 0x12 && b[i + 3] === 0x10,
    );
    b[marker + 2] = 0x10 | (index >>> 1);
    b[marker + 3] = ((index & 1) << 7) | 0x10;
    expect(await inspect(b)).toMatchObject({
      compatible: false,
      reasons: ["unsupported_aac_profile"],
    });
  });
  it("scans more than 128 top-level boxes with charged 4KiB fragment lookahead", async () => {
    const b = fragmentedMp4Fixture({ fragments: 80, mdatPadding: 8192 });
    const read = vi.fn(async (offset: number, length: number) =>
      b.slice(offset, offset + length),
    );
    expect(await inspectSourceMp4(b.length, read)).toMatchObject({
      compatible: true,
      durationSeconds: 80,
      fragmented: { fragmentCount: 80, sampleCount: 320 },
    });
    expect(read.mock.calls.length).toBeLessThanOrEqual(88);
    expect(read.mock.calls.every(([, length]) => length <= 4096)).toBe(true);
    expect(
      read.mock.calls.reduce((sum, [, length]) => sum + length, 0),
    ).toBeLessThan(5 * 1024 ** 2);
  });
  it.each([
    [
      "unknown fragment flags",
      (b: Uint8Array) => {
        const t = descendants(b, "trun")[0];
        set(b, t.data, 0x703);
      },
      "unsupported_fragment_flags_or_version",
    ],
    [
      "unknown trun version",
      (b: Uint8Array) => {
        const t = descendants(b, "trun")[0];
        b[t.data] = 2;
      },
      "unsupported_fragment_flags_or_version",
    ],
    [
      "conflicting first/per-sample flags",
      (b: Uint8Array) => {
        const t = descendants(b, "trun")[0];
        set(b, t.data, 0x705);
      },
      "conflicting_fragment_sample_flags",
    ],
    [
      "changed description",
      (b: Uint8Array) => {
        const t = descendants(b, "trex")[0];
        set(b, t.data + 8, 2);
      },
      "unsupported_fragment_description",
    ],
    [
      "missing defaults",
      (b: Uint8Array) => {
        const t = descendants(b, "trun")[0];
        set(b, t.data + 12, 0);
      },
      "missing_fragment_sample_defaults",
    ],
    [
      "missing tfdt",
      (b: Uint8Array) => {
        rename(b, descendants(b, "tfdt")[0].start, "free");
      },
      "unsupported_fragment_box",
    ],
    [
      "encrypted samples",
      (b: Uint8Array) => {
        rename(b, descendants(b, "tfdt")[0].start, "senc");
      },
      "encrypted_or_grouped_fragment_samples",
    ],
    [
      "sample groups",
      (b: Uint8Array) => {
        rename(b, descendants(b, "tfdt")[0].start, "sbgp");
      },
      "encrypted_or_grouped_fragment_samples",
    ],
    [
      "discontinuous sequence",
      (b: Uint8Array) => {
        set(b, descendants(b, "mfhd")[1].data + 4, 3);
      },
      "fragment_sequence_discontinuity",
    ],
    [
      "decode gap",
      (b: Uint8Array) => {
        set(b, descendants(b, "tfdt")[2].data + 8, 1001);
      },
      "fragment_decode_discontinuity",
    ],
    [
      "sample outside its own mdat",
      (b: Uint8Array) => {
        set(b, descendants(b, "trun")[0].data + 8, -8);
      },
      "fragment_sample_outside_mdat",
    ],
    [
      "sample count/length mismatch",
      (b: Uint8Array) => {
        set(b, descendants(b, "trun")[0].data + 4, 3);
      },
      "invalid_trun",
    ],
    [
      "sample count limit",
      (b: Uint8Array) => {
        set(b, descendants(b, "trun")[0].data + 4, 16385);
      },
      "fragment_sample_limit",
    ],
    [
      "initial video not sync",
      (b: Uint8Array) => {
        set(b, descendants(b, "trun")[0].data + 20, 0x1010000);
      },
      "fragment_sync_sample_required",
    ],
    [
      "nonempty init table",
      (b: Uint8Array) => {
        set(b, descendants(b, "stsz")[0].data + 8, 1);
      },
      "nonempty_fragment_init_samples",
    ],
  ] as const)("rejects %s", async (_label, mutate, reason) => {
    const b = fragmentedMp4Fixture();
    mutate(b);
    expect(await inspect(b)).toMatchObject({
      compatible: false,
      reasons: [reason],
      serverDecoded: false,
    });
  });
  it("rejects overlapping audio/video extents", async () => {
    const b = fragmentedMp4Fixture(),
      runs = descendants(b, "trun");
    const first = new DataView(b.buffer).getUint32(runs[0].data + 8);
    set(b, runs[1].data + 8, first);
    expect(await inspect(b)).toMatchObject({
      compatible: false,
      reasons: ["overlapping_fragment_samples"],
    });
  });
  it("rejects presentation overlap even with a continuous decode timeline", async () => {
    const b = fragmentedMp4Fixture({ signedCts: true });
    const run = descendants(b, "trun")[0];
    set(b, run.data + 24, 0); // first sample CTS=0, second remains -500 => both PTS=0
    expect(await inspect(b)).toMatchObject({
      compatible: false,
      reasons: ["fragment_presentation_discontinuity"],
    });
  });
  it("rejects AV end drift greater than the fixed quarter-second policy", async () => {
    const b = fragmentedMp4Fixture({ fragments: 1 });
    const run = descendants(b, "trun")[1];
    set(b, run.data + 12, 626);
    set(b, run.data + 24, 626);
    expect(await inspect(b)).toMatchObject({
      compatible: false,
      reasons: ["fragment_audio_video_timeline_mismatch"],
    });
  });
  it("rejects truncated or oversized fragment metadata before scanning samples", async () => {
    const b = fragmentedMp4Fixture();
    expect(await inspect(b.subarray(0, b.length - 1))).toMatchObject({
      compatible: false,
      reasons: ["invalid_box_size"],
    });
    const moof = box("moof", new Uint8Array(65536));
    const top = fixtureBoxes(b);
    const prefix = b.slice(0, top.find((x) => x.type === "moof")!.start);
    expect(
      await inspect(concat(prefix, moof, box("mdat", word(0)))),
    ).toMatchObject({
      compatible: false,
      reasons: ["fragment_metadata_limit"],
    });
  });
  it("retains the global byte budget for a fragment file with oversized init metadata", async () => {
    const b = fragmentedMp4Fixture();
    const top = fixtureBoxes(b),
      moov = top.find((item) => item.type === "moov")!;
    const huge = concat(
      b.slice(0, moov.start),
      box("moov", new Uint8Array(4 * 1024 ** 2 + 1)),
      b.slice(moov.end),
    );
    const read = vi.fn(async (at: number, length: number) =>
      huge.slice(at, at + length),
    );
    expect(await inspectSourceMp4(huge.length, read)).toMatchObject({
      compatible: false,
      reasons: ["metadata_limit"],
    });
    expect(read.mock.calls.every(([, n]) => n <= 4096)).toBe(true);
  });
});

describe("untrusted mfra hint prefetch", () => {
  it("bounds concurrent complete reads at eight and avoids one RTT per fragment", async () => {
    vi.useFakeTimers();
    try {
      const b = fragmentedMp4Fixture({
        fragments: 32,
        index: true,
        mdatPadding: 8192,
      });
      const moofs = fixtureBoxes(b).filter((item) => item.type === "moof");
      const footer = fixtureBoxes(b).find((item) => item.type === "mfra")!;
      let active = 0,
        peak = 0,
        finishedAt = Infinity;
      const startedAt = Date.now();
      const read = vi.fn(async (offset: number, length: number) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 100));
        active--;
        return b.slice(offset, offset + length);
      });
      const plan = vi.fn();
      const pending = inspectSourceMp4(b.length, read, {
        onFragmentReadPlan: plan,
      }).then((result) => {
        finishedAt = Date.now();
        return result;
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({
        compatible: true,
        durationSeconds: 32,
      });
      expect(peak).toBe(8);
      expect(active).toBe(0);
      expect(finishedAt - startedAt).toBeLessThan(2000);
      expect(plan).toHaveBeenCalledExactlyOnceWith({
        basis: "mfra-hints",
        hintCount: 32,
        indexBytes: footer.end - footer.start,
        concurrency: 8,
      });
      for (const moof of moofs)
        expect(
          read.mock.calls.filter(
            ([offset, length]) => offset === moof.start && length === 4096,
          ),
        ).toHaveLength(1);
      // Three disjoint reads retrieve the footer once; final top scan and the
      // authoritative tfra validation reuse those exact bytes.
      const footerReads = read.mock.calls.filter(
        ([offset]) => offset >= footer.start,
      );
      expect(footerReads.reduce((sum, [, length]) => sum + length, 0)).toBe(
        footer.end - footer.start,
      );
      expect(
        new Set(
          read.mock.calls.map(([offset, length]) => `${offset}:${length}`),
        ).size,
      ).toBe(read.mock.calls.length);
    } finally {
      vi.useRealTimers();
    }
  });
  it("an incomplete index never skips physical fragments or their samples", async () => {
    const b = fragmentedMp4Fixture({
      fragments: 16,
      index: true,
      indexEvery: 2,
      mdatPadding: 8192,
    });
    const read = vi.fn(async (offset: number, length: number) =>
      b.slice(offset, offset + length),
    );
    const plan = vi.fn();
    expect(
      await inspectSourceMp4(b.length, read, { onFragmentReadPlan: plan }),
    ).toMatchObject({
      compatible: true,
      fragmented: { fragmentCount: 16, sampleCount: 64 },
    });
    expect(plan.mock.calls[0][0]).toMatchObject({
      basis: "mfra-hints",
      hintCount: 8,
    });
    for (const moof of fixtureBoxes(b).filter((item) => item.type === "moof"))
      expect(
        read.mock.calls.some(
          ([offset, length]) => offset === moof.start && length === 4096,
        ),
      ).toBe(true);
  });
  it("shares the eight-read semaphore with foreground misses in a sparse index", async () => {
    vi.useFakeTimers();
    try {
      const b = fragmentedMp4Fixture({
        fragments: 32,
        index: true,
        indexEvery: 2,
        mdatPadding: 8192,
      });
      const moofs = fixtureBoxes(b).filter((item) => item.type === "moof");
      let active = 0,
        peak = 0,
        foregroundOverlapped = false;
      const read = vi.fn(async (offset: number, length: number) => {
        if (offset === moofs[1].start && active > 0)
          foregroundOverlapped = true;
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) =>
          setTimeout(resolve, offset === moofs[0].start ? 1 : 100),
        );
        active--;
        return b.slice(offset, offset + length);
      });
      const pending = inspectSourceMp4(b.length, read);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({
        compatible: true,
        fragmented: { fragmentCount: 32 },
      });
      expect(foregroundOverlapped).toBe(true);
      expect(peak).toBe(8);
      expect(active).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("a missing footer retains the complete sequential fallback", async () => {
    const b = fragmentedMp4Fixture({ fragments: 12, mdatPadding: 8192 });
    const read = vi.fn(async (offset: number, length: number) =>
      b.slice(offset, offset + length),
    );
    const plan = vi.fn();
    expect(
      await inspectSourceMp4(b.length, read, { onFragmentReadPlan: plan }),
    ).toMatchObject({ compatible: true, fragmented: { fragmentCount: 12 } });
    expect(plan).toHaveBeenCalledExactlyOnceWith({
      basis: "sequential",
      hintCount: 0,
      indexBytes: 0,
      concurrency: 1,
    });
  });
  it("forged in-mdat hints cannot replace the sequential chain or final index proof", async () => {
    const b = fragmentedMp4Fixture({
      fragments: 12,
      index: true,
      mdatPadding: 8192,
    });
    const moofs = fixtureBoxes(b).filter((item) => item.type === "moof");
    const tfra = descendants(b, "tfra")[0];
    set(b, tfra.data + 28, moofs[0].end + 32); // first hint targets media payload
    const read = vi.fn(async (offset: number, length: number) =>
      b.slice(offset, offset + length),
    );
    expect(await inspectSourceMp4(b.length, read)).toMatchObject({
      compatible: false,
      reasons: ["unverified_fragment_index"],
    });
    for (const moof of moofs)
      expect(
        read.mock.calls.some(
          ([offset, length]) => offset === moof.start && length === 4096,
        ),
      ).toBe(true);
    expect(
      read.mock.calls.every(
        ([offset, length]) => offset >= 0 && offset + length <= b.length,
      ),
    ).toBe(true);
  });
  it("out-of-range index entries are not dispatched as hints and still fail authoritative verification", async () => {
    const b = fragmentedMp4Fixture({
      fragments: 12,
      index: true,
      mdatPadding: 8192,
    });
    const tfra = descendants(b, "tfra")[0];
    set(b, tfra.data + 28, b.length + 1);
    const plan = vi.fn(),
      read = vi.fn(async (offset: number, length: number) =>
        b.slice(offset, offset + length),
      );
    expect(
      await inspectSourceMp4(b.length, read, { onFragmentReadPlan: plan }),
    ).toMatchObject({
      compatible: false,
      reasons: ["unverified_fragment_index"],
    });
    expect(plan.mock.calls[0][0]).toMatchObject({
      basis: "sequential",
      hintCount: 0,
    });
    expect(
      read.mock.calls.every(([offset, length]) => offset + length <= b.length),
    ).toBe(true);
  });
  it("a failed hint closes scheduling and handles later rejected pending tasks", async () => {
    const b = fragmentedMp4Fixture({
      fragments: 32,
      index: true,
      mdatPadding: 8192,
    });
    const moofs = fixtureBoxes(b).filter((item) => item.type === "moof");
    const offsets = new Set(moofs.map((item) => item.start));
    const late: ((error: Error) => void)[] = [];
    let active = 0,
      peak = 0;
    const read = vi.fn(
      (offset: number, length: number): Promise<Uint8Array> => {
        if (length === 4096 && offsets.has(offset)) {
          active++;
          peak = Math.max(peak, active);
          if (offset === moofs[1].start) {
            active--;
            return Promise.reject(new Error("upstream read failed"));
          }
          if (offset !== moofs[0].start)
            return new Promise((_resolve, reject) =>
              late.push((error) => {
                active--;
                reject(error);
              }),
            );
          active--;
        }
        return Promise.resolve(b.slice(offset, offset + length));
      },
    );
    expect(await inspectSourceMp4(b.length, read)).toMatchObject({
      compatible: false,
      reasons: ["source_read_unverified"],
    });
    expect(peak).toBeLessThanOrEqual(8);
    const callsAfterReturn = read.mock.calls.length;
    late.forEach((reject) => reject(new Error("late failure")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledTimes(callsAfterReturn);
    expect(active).toBe(0);
  });
  it("charges all speculative reads against the same hard metadata budget", async () => {
    const b = fragmentedMp4Fixture({
      fragments: 900,
      index: true,
      initPadding: 2 * 1024 ** 2,
      mdatPadding: 8192,
    });
    let requested = 0;
    const read = vi.fn(async (offset: number, length: number) => {
      requested += length;
      return b.slice(offset, offset + length);
    });
    expect(await inspectSourceMp4(b.length, read)).toMatchObject({
      compatible: false,
      reasons: ["metadata_limit"],
    });
    expect(requested).toBeLessThanOrEqual(5 * 1024 ** 2);
  });
});

describe("explicit track-ID random-access compatibility mapping", () => {
  it("distinguishes the global traf order from the FFmpeg track-first convention", async () => {
    expect(await inspect(fragmentedMp4Fixture({ index: true }))).toMatchObject({
      compatible: true,
      fragmented: {
        randomAccessIndex: { basis: "global-traf-order", entries: 4 },
      },
    });
    expect(
      await inspect(
        fragmentedMp4Fixture({ index: true, indexTrafNumber: "track-first" }),
      ),
    ).toMatchObject({
      compatible: true,
      serverDecoded: false,
      fragmented: {
        fragmentCount: 2,
        sampleCount: 8,
        randomAccessIndex: { basis: "track-id-compatibility", entries: 4 },
      },
    });
    expect(
      (await inspect(fragmentedMp4Fixture())).fragmented,
    ).not.toHaveProperty("randomAccessIndex");
  });
  it.each([false, true])(
    "rejects mixed mappings within one tfra (reverse=%s)",
    async (reverse) => {
      const b = fragmentedMp4Fixture({
        index: true,
        indexTrafNumber: reverse ? "global" : "track-first",
      });
      const audio = descendants(b, "tfra")[1];
      b[audio.data + 32 + 19] = reverse ? 1 : 2;
      expect(await inspect(b)).toMatchObject({
        compatible: false,
        reasons: ["unverified_fragment_index"],
      });
    },
  );
  it.each([
    [
      "zero traf",
      (b: Uint8Array, at: number) => {
        b[at + 32] = 0;
      },
      "unverified_fragment_index",
    ],
    [
      "other traf",
      (b: Uint8Array, at: number) => {
        b[at + 32] = 3;
      },
      "unverified_fragment_index",
    ],
    [
      "other run",
      (b: Uint8Array, at: number) => {
        b[at + 33] = 2;
      },
      "unverified_fragment_index",
    ],
    [
      "other sample",
      (b: Uint8Array, at: number) => {
        b[at + 34] = 2;
      },
      "unverified_fragment_index",
    ],
    [
      "wrong time",
      (b: Uint8Array, at: number) => {
        set(b, at + 20, 1);
      },
      "unverified_fragment_index",
    ],
    [
      "wrong moof",
      (b: Uint8Array, at: number) => {
        set(b, at + 28, 2);
      },
      "unverified_fragment_index",
    ],
    [
      "unknown track",
      (b: Uint8Array, at: number) => {
        set(b, at + 4, 3);
      },
      "unsupported_fragment_index",
    ],
  ] as const)(
    "keeps exact verification for %s",
    async (_name, mutate, reason) => {
      const b = fragmentedMp4Fixture({
        index: true,
        indexTrafNumber: "track-first",
      });
      mutate(b, descendants(b, "tfra")[1].data);
      expect(await inspect(b)).toMatchObject({
        compatible: false,
        reasons: [reason],
      });
    },
  );
  it("rejects a random-access reference to a non-sync sample in a later fragment", async () => {
    const b = fragmentedMp4Fixture({
      index: true,
      indexTrafNumber: "track-first",
    });
    set(b, descendants(b, "trun")[2].data + 20, 0x1010000);
    expect(await inspect(b)).toMatchObject({
      compatible: false,
      reasons: ["unverified_fragment_index"],
    });
  });
  it("rejects ambiguous duplicate track IDs before applying compatibility mapping", async () => {
    const b = fragmentedMp4Fixture({
      index: true,
      indexTrafNumber: "track-first",
    });
    set(b, descendants(b, "tfhd")[1].data + 4, 1);
    expect(await inspect(b)).toMatchObject({
      compatible: false,
      reasons: ["unknown_or_duplicate_fragment_track"],
    });
  });
  it("preserves the bounded empty random-access index policy", async () => {
    const b = fragmentedMp4Fixture({ fragments: 1 });
    const emptyIndex = box("mfra", box("mfro", word(0), word(24)));
    expect(await inspect(concat(b, emptyIndex))).toMatchObject({
      compatible: true,
      fragmented: {
        randomAccessIndex: { basis: "global-traf-order", entries: 0 },
      },
    });
  });
});
