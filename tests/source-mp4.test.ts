import { describe, expect, it } from "vitest";
import { inspectSourceMp4, aacLcExtensionSupported } from "../src/source-mp4";
import { sourceMp4Fixture } from "./source-fixture";
const inspect = (b: Uint8Array) =>
  inspectSourceMp4(b.length, async (offset, length) =>
    b.slice(offset, offset + length),
  );
const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};
const box = (type: string, payloadBytes = 8) => {
  const result = new Uint8Array(8 + payloadBytes);
  new DataView(result.buffer).setUint32(0, result.length);
  result.set(new TextEncoder().encode(type), 4);
  return result;
};
const movieOffset = (data: Uint8Array, tail = true) => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const first = view.getUint32(0);
  return tail ? first + view.getUint32(first) : first;
};
describe("bounded MP4 metadata candidates do not claim decoding", () => {
  it("identifies an EBML signature as another container without claiming media corruption", async () => {
    // Only the container signature is evidence here; zero padding does not
    // establish a valid or decodable WebM/Matroska file.
    const data = new Uint8Array(64);
    data.set([0x1a, 0x45, 0xdf, 0xa3]);
    const reads: [number, number][] = [];
    const result = await inspectSourceMp4(
      data.length,
      async (offset, length) => {
        reads.push([offset, length]);
        return data.slice(offset, offset + length);
      },
    );
    expect(result).toMatchObject({
      compatible: false,
      reasons: ["unsupported_source_container"],
      serverDecoded: false,
      index: { placement: "unknown", reason: "top-level-scan-unverified" },
    });
    expect(result).not.toHaveProperty("videoCodec");
    expect(result).not.toHaveProperty("nativeEdits");
    expect(reads).toEqual([[0, 8]]);
  });
  it("keeps invalid MP4 length checks for unknown signatures", async () => {
    const data = new Uint8Array(64);
    data.set([0x1a, 0x45, 0xdf, 0xa2]);
    expect((await inspect(data)).reasons).toEqual(["invalid_box_size"]);
  });
  it("does not mistake an embedded EBML word for the source container", async () => {
    const data = sourceMp4Fixture();
    // An unknown major brand is valid here because mp42 remains a compatible
    // brand. Detecting this word anywhere in the file would reject valid MP4.
    data.set([0x1a, 0x45, 0xdf, 0xa3], 8);
    expect(await inspect(data)).toMatchObject({
      compatible: true,
      reasons: [],
    });
  });
  it("preserves the four-minute source's leading empty video edit and media trim", async () => {
    // Same timeline shape as the identified 276.063s source. Payload is
    // synthetic, so this proves metadata support, never browser decoding.
    const data = sourceMp4Fixture({
      tail: false,
      audio: false,
      edit: true,
      movieDurationTicks: 276063,
      mediaTimescale: 90000,
      mediaDurationTicks: 24840000,
      videoEmptyEditDurationTicks: 40,
      videoEditDurationTicks: 276000,
      editMediaTime: 3600,
      sampleTiming: [{ count: 6900, delta: 3600 }],
      composition: [{ count: 6900, offset: 3600 }],
    });
    const before = data.slice();
    expect(await inspect(data)).toMatchObject({
      compatible: true,
      reasons: [],
      durationSeconds: 276.063,
      nativeEdits: [
        {
          track: "video",
          movieStartSeconds: 0.04,
          mediaStartSeconds: 0.04,
          durationSeconds: 276,
        },
      ],
      index: { placement: "before-media" },
      serverDecoded: false,
    });
    expect(data).toEqual(before);
  });
  it.each([0, 1001, 3000])(
    "does not accept unsupported or overflowing leading edits (%s ticks)",
    async (delay) => {
      expect(
        (
          await inspect(
            sourceMp4Fixture({
              audio: false,
              edit: true,
              videoEmptyEditDurationTicks: delay,
            }),
          )
        ).reasons,
      ).toContain("unsupported_edit_list");
    },
  );
  it.each([
    [12, 0, "a repeated media segment"],
    [16, 0x20000, "a changed rate on the empty edit"],
    [24, 0xffffffff, "a trailing empty edit"],
    [24, 0xfffffffe, "another negative media time"],
    [28, 0, "a dwell media edit"],
    [20, 0, "an empty media segment"],
  ] as const)("rejects %s=%s (%s)", async (field, value, _label) => {
    const data = sourceMp4Fixture({
      audio: false,
      edit: true,
      movieDurationTicks: 10040,
      videoEmptyEditDurationTicks: 40,
    });
    const elst = new TextDecoder().decode(data).indexOf("elst") + 4;
    new DataView(data.buffer).setUint32(elst + field, value);
    expect((await inspect(data)).reasons).toContain("unsupported_edit_list");
  });
  it("still verifies sample coverage after a leading empty edit", async () => {
    expect(
      (
        await inspect(
          sourceMp4Fixture({
            audio: false,
            edit: true,
            movieDurationTicks: 10040,
            videoEmptyEditDurationTicks: 40,
            editMediaTime: 40,
          }),
        )
      ).reasons,
    ).toContain("unsupported_edit_list");
  });
  it("does not expose partial native edit success when a later track fails", async () => {
    const result = await inspect(
      sourceMp4Fixture({
        edit: true,
        editMediaTime: 20,
        composition: [{ count: 2, offset: 20 }],
      }),
    );
    expect(result).toMatchObject({
      compatible: false,
      reasons: ["unsupported_edit_list"],
    });
    expect(result).not.toHaveProperty("nativeEdits");
  });
  it("keeps native edit offsets and allows audio to end before the movie", async () => {
    const result = await inspect(
      sourceMp4Fixture({
        edit: true,
        audioEditDurationTicks: 9800,
        editMediaTime: 20,
        composition: [{ count: 2, offset: 20 }],
      }),
    );
    expect(result.compatible).toBe(true);
    expect(result.durationSeconds).toBe(10);
    expect(result.audioCodec).toBe("mp4a.40.2");
    expect(result.nativeEdits).toEqual([
      { track: "video", mediaStartSeconds: 0.02, durationSeconds: 10 },
      { track: "audio", mediaStartSeconds: 0.02, durationSeconds: 9.8 },
    ]);
  });
  it("rejects an edit extending beyond the presentation duration", async () => {
    expect(
      (
        await inspect(
          sourceMp4Fixture({ edit: true, audioEditDurationTicks: 11000 }),
        )
      ).reasons,
    ).toContain("unsupported_edit_list");
  });
  it("rejects a matching tkhd/movie edit that extends one second beyond the actual samples", async () => {
    expect(
      (await inspect(sourceMp4Fixture({ edit: true, editMediaTime: 1000 })))
        .reasons,
    ).toContain("unsupported_edit_list");
  });
  it("uses composition timestamps that can legitimately extend beyond the decode duration", async () => {
    expect(
      await inspect(
        sourceMp4Fixture({
          audio: false,
          edit: true,
          editMediaTime: 1000,
          composition: [{ count: 2, offset: 1000 }],
        }),
      ),
    ).toMatchObject({
      compatible: true,
      nativeEdits: [
        { track: "video", mediaStartSeconds: 1, durationSeconds: 10 },
      ],
    });
  });
  it.each([1, 2])(
    "allows only one movie tick of terminal rounding (overrun=%s ticks)",
    async (ticks) => {
      const result = await inspect(
        sourceMp4Fixture({ audio: false, edit: true, editMediaTime: ticks }),
      );
      expect(result.compatible).toBe(ticks === 1);
      if (ticks > 1) expect(result.reasons).toContain("unsupported_edit_list");
    },
  );
  it("rejects an edit beginning before the first actual presentation sample", async () => {
    expect(
      (
        await inspect(
          sourceMp4Fixture({
            audio: false,
            edit: true,
            composition: [{ count: 2, offset: 20 }],
          }),
        )
      ).reasons,
    ).toContain("unsupported_edit_list");
  });
  it("supports signed negative CTS offsets when the edit is fully covered", async () => {
    expect(
      await inspect(
        sourceMp4Fixture({
          audio: false,
          edit: true,
          videoEditDurationTicks: 9980,
          compositionVersion: 1,
          composition: [{ count: 2, offset: -20 }],
        }),
      ),
    ).toMatchObject({
      compatible: true,
      nativeEdits: [
        { track: "video", mediaStartSeconds: 0, durationSeconds: 9.98 },
      ],
    });
  });
  it("intersects differently aligned timing and composition runs", async () => {
    expect(
      await inspect(
        sourceMp4Fixture({
          audio: false,
          edit: true,
          editMediaTime: 1000,
          videoEditDurationTicks: 9500,
          sampleTiming: [
            { count: 2, delta: 3000 },
            { count: 1, delta: 4000 },
          ],
          composition: [
            { count: 1, offset: 1000 },
            { count: 2, offset: 500 },
          ],
        }),
      ),
    ).toMatchObject({
      compatible: true,
      nativeEdits: [
        { track: "video", mediaStartSeconds: 1, durationSeconds: 9.5 },
      ],
    });
  });
  it("rejects zero-length composition runs rather than stalling timeline validation", async () => {
    expect(
      (
        await inspect(
          sourceMp4Fixture({
            audio: false,
            edit: true,
            composition: [
              { count: 0, offset: 20 },
              { count: 2, offset: 20 },
            ],
          }),
        )
      ).reasons,
    ).toContain("invalid_composition_table");
  });
  it("accepts AAC-LC explicit SBR absence but refuses active or unknown extensions", () => {
    expect(aacLcExtensionSupported(new Uint8Array([0x56, 0xe5, 0]))).toBe(true);
    expect(aacLcExtensionSupported(new Uint8Array([0x56, 0xe5, 0x80]))).toBe(
      false,
    );
    expect(aacLcExtensionSupported(new Uint8Array([0x56, 0xe4, 0]))).toBe(
      false,
    );
    expect(aacLcExtensionSupported(new Uint8Array([0x56, 0xe5, 1]))).toBe(
      false,
    );
  });
  it.each([true, false])(
    "reports actual moov placement with tail=%s without reading mdat",
    async (tail) => {
      const data = sourceMp4Fixture({ tail, edit: true });
      const reads: [number, number][] = [];
      const top: { type: string; offset: number; bytes: number }[] = [];
      const probe = await inspectSourceMp4(
        data.length,
        async (offset, length) => {
          reads.push([offset, length]);
          return data.slice(offset, offset + length);
        },
        { onTopLevelBox: (box) => top.push(box) },
      );
      expect(top.map((box) => box.type)).toEqual(
        tail ? ["ftyp", "mdat", "moov"] : ["ftyp", "moov", "mdat"],
      );
      expect(top.reduce((bytes, box) => bytes + box.bytes, 0)).toBe(
        data.length,
      );
      expect(probe).toMatchObject({
        compatible: true,
        durationSeconds: 10,
        width: 640,
        height: 360,
        videoCodec: "avc1",
        audioCodec: "mp4a.40.2",
        audioChannels: 2,
        serverDecoded: false,
        index: {
          basis: "bounded-top-level-box-scan",
          placement: tail ? "after-media" : "before-media",
          moovOffset: movieOffset(data, tail),
          moovBytes: new DataView(data.buffer).getUint32(
            movieOffset(data, tail),
          ),
        },
      });
      expect(probe.index?.reason).toBeUndefined();
      const mdatType = new TextDecoder().decode(data).indexOf("mdat");
      expect(
        reads.every(
          ([offset, length]) =>
            offset + length <= mdatType + 4 || offset >= mdatType + 20,
        ),
      ).toBe(true);
    },
  );
  it("reports between-media only when mdat boxes lie on both sides", async () => {
    const data = sourceMp4Fixture();
    const result = await inspect(concat(data, box("mdat")));
    expect(result).toMatchObject({
      compatible: true,
      serverDecoded: false,
      index: {
        placement: "between-media",
        moovOffset: movieOffset(data),
        moovBytes: data.length - movieOffset(data),
      },
    });
  });
  it("measures the whole moov box including an extended-size header", async () => {
    const data = sourceMp4Fixture();
    const offset = movieOffset(data);
    const header = new Uint8Array(16);
    const view = new DataView(header.buffer);
    view.setUint32(0, 1);
    header.set(new TextEncoder().encode("moov"), 4);
    view.setBigUint64(8, BigInt(data.length - offset + 8));
    expect(
      await inspect(
        concat(data.slice(0, offset), header, data.slice(offset + 8)),
      ),
    ).toMatchObject({
      compatible: true,
      index: {
        placement: "after-media",
        moovOffset: offset,
        moovBytes: data.length - offset + 8,
      },
    });
  });
  it("locates a distant tail index using bounded reads across an extended mdat", async () => {
    const data = sourceMp4Fixture();
    const ftypBytes = new DataView(data.buffer).getUint32(0);
    const ftyp = data.slice(0, ftypBytes);
    const moov = data.slice(movieOffset(data));
    // The extended mdat header is eight bytes larger than the fixture's header.
    for (let offset = 0; offset <= moov.length - 16; offset++) {
      if (new TextDecoder().decode(moov.slice(offset, offset + 4)) === "stco") {
        const view = new DataView(moov.buffer);
        view.setUint32(offset + 12, view.getUint32(offset + 12) + 8);
      }
    }
    const mdatBytes = 8 * 1024 ** 3;
    const mdat = new Uint8Array(16);
    const header = new DataView(mdat.buffer);
    header.setUint32(0, 1);
    mdat.set(new TextEncoder().encode("mdat"), 4);
    header.setBigUint64(8, BigInt(mdatBytes));
    const moovOffset = ftyp.length + mdatBytes;
    const ranges = [
      { offset: 0, bytes: ftyp },
      { offset: ftyp.length, bytes: mdat },
      { offset: moovOffset, bytes: moov },
    ];
    let readBytes = 0;
    const result = await inspectSourceMp4(
      moovOffset + moov.length,
      async (offset, length) => {
        readBytes += length;
        const range = ranges.find(
          (item) =>
            offset >= item.offset &&
            offset + length <= item.offset + item.bytes.length,
        );
        if (!range) throw new Error("sample payload must not be read");
        return range.bytes.slice(
          offset - range.offset,
          offset - range.offset + length,
        );
      },
    );
    expect(result).toMatchObject({
      compatible: true,
      serverDecoded: false,
      index: { placement: "after-media", moovOffset, moovBytes: moov.length },
    });
    expect(readBytes).toBeLessThan(4096);
  });
  it("keeps index placement separate from unsupported codec validation", async () => {
    expect(
      await inspect(sourceMp4Fixture({ codec: "hvc1", tail: false })),
    ).toMatchObject({
      compatible: false,
      reasons: ["unsupported_video_codec"],
      serverDecoded: false,
      index: { placement: "before-media" },
    });
  });
  it.each([false, true])(
    "does not guess a missing or duplicate moov (duplicate=%s)",
    async (duplicate) => {
      const data = sourceMp4Fixture();
      const offset = movieOffset(data);
      const probe = await inspect(
        duplicate ? concat(data, data.slice(offset)) : data.slice(0, offset),
      );
      expect(probe.index).toEqual({
        basis: "bounded-top-level-box-scan",
        placement: "unknown",
        reason: "missing-or-duplicate-moov",
      });
      expect(probe.compatible).toBe(false);
    },
  );
  it.each([false, true])(
    "does not infer media placement from absent or empty mdat (empty=%s)",
    async (empty) => {
      const data = sourceMp4Fixture();
      const ftypBytes = new DataView(data.buffer).getUint32(0);
      const movie = data.slice(movieOffset(data));
      const ftyp = data.slice(0, ftypBytes);
      const probe = await inspect(
        concat(ftyp, ...(empty ? [box("mdat", 0)] : []), movie),
      );
      expect(probe.index).toEqual({
        basis: "bounded-top-level-box-scan",
        placement: "unknown",
        moovOffset: ftypBytes + (empty ? 8 : 0),
        moovBytes: movie.length,
        reason: "media-ranges-unverified",
      });
      expect(probe.compatible).toBe(false);
    },
  );
  it("does not keep partial index evidence when trailing structure is truncated", async () => {
    const probe = await inspect(concat(sourceMp4Fixture(), new Uint8Array(1)));
    expect(probe.index).toEqual({
      basis: "bounded-top-level-box-scan",
      placement: "unknown",
      reason: "top-level-scan-unverified",
    });
    expect(probe.compatible).toBe(false);
  });
  it("fails closed at the top-level scan limit without reading metadata or samples", async () => {
    const data = concat(
      sourceMp4Fixture(),
      ...Array.from({ length: 128 }, () => box("free", 0)),
    );
    let readBytes = 0;
    const probe = await inspectSourceMp4(
      data.length,
      async (offset, length) => {
        readBytes += length;
        return data.slice(offset, offset + length);
      },
    );
    expect(probe.index).toEqual({
      basis: "bounded-top-level-box-scan",
      placement: "unknown",
      reason: "top-level-scan-unverified",
    });
    expect(probe.reasons).toEqual(["top_box_limit"]);
    expect(readBytes).toBe(128 * 8);
  });
  it("reports silent video explicitly without inventing an audio track", async () => {
    expect(await inspect(sourceMp4Fixture({ audio: false }))).toMatchObject({
      compatible: true,
      audioCodec: null,
      audioChannels: 0,
    });
  });
  it.each([
    [{ external: true }, "external_data_reference"],
    [{ hdr: true }, "unsupported_color_metadata"],
    [{ codec: "hvc1" }, "unsupported_video_codec"],
    [{ channels: 1 }, "unsupported_audio_codec_or_channels"],
    [{ badOffset: true }, "sample_outside_mdat"],
    [{ fragment: true }, "fragmented_or_encrypted_mp4"],
  ] as const)(
    "rejects unsupported or unsafe sample metadata %s",
    async (options, reason) => {
      expect(await inspect(sourceMp4Fixture(options))).toMatchObject({
        compatible: false,
        reasons: [reason],
      });
    },
  );
  it("rejects a filename-like payload and truncated boxes", async () => {
    expect(
      (
        await inspect(
          new TextEncoder().encode("fake.mp4 video/mp4 ".repeat(10)),
        )
      ).compatible,
    ).toBe(false);
    const valid = sourceMp4Fixture();
    expect((await inspect(valid.slice(0, -1))).compatible).toBe(false);
  });
  it("does not expose thrown backend diagnostic strings", async () => {
    const result = await inspectSourceMp4(100, async () => {
      throw new Error("sensitivebackendvalue");
    });
    expect(result.reasons).toEqual(["source_read_unverified"]);
    expect(result.index).toEqual({
      basis: "bounded-top-level-box-scan",
      placement: "unknown",
      reason: "top-level-scan-unverified",
    });
  });
  it("rejects oversized moov before requesting its payload", async () => {
    const size = 5 * 1024 ** 2;
    const reads: number[] = [];
    const result = await inspectSourceMp4(size, async (offset, length) => {
      reads.push(length);
      const b = new Uint8Array(length);
      const v = new DataView(b.buffer);
      if (offset === 0) {
        v.setUint32(0, 24);
        b.set(new TextEncoder().encode("ftyp"), 4);
      } else if (offset === 24) {
        v.setUint32(0, 16);
        b.set(new TextEncoder().encode("mdat"), 4);
      } else if (offset === 40) {
        v.setUint32(0, size - 40);
        b.set(new TextEncoder().encode("moov"), 4);
      } else b.set(new TextEncoder().encode("isom"));
      return b;
    });
    expect(result).toMatchObject({
      compatible: false,
      reasons: ["metadata_limit"],
      index: {
        placement: "after-media",
        moovOffset: 40,
        moovBytes: size - 40,
      },
    });
    expect(Math.max(...reads)).toBeLessThan(1024);
  });
});
