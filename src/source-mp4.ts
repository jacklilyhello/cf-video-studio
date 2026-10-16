import {
  FragmentInspectionError,
  inspectFragments,
  type FragmentedMp4Summary,
  type FragmentTrack,
} from "./fragmented-mp4";
// Conservative ISO-BMFF metadata inspection. No samples are decoded here.
export const SOURCE_MP4_PARSER_VERSION = "iso-bmff-source-v5";
export interface SourceMp4Index {
  basis: "bounded-top-level-box-scan";
  placement: "before-media" | "after-media" | "between-media" | "unknown";
  // Zero-based box offset and total box bytes, including its header.
  moovOffset?: number;
  moovBytes?: number;
  reason?:
    | "top-level-scan-unverified"
    | "missing-or-duplicate-moov"
    | "media-ranges-unverified";
}
export interface SourceMp4Probe {
  compatible: boolean;
  reasons: string[];
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string | null;
  audioChannels?: number;
  // Classic MP4 is handed unchanged to the native browser demuxer. These
  // offsets describe its presentation edits, never instructions to strip them.
  nativeEdits?: {
    track: "video" | "audio";
    mediaStartSeconds: number;
    durationSeconds: number;
    // A leading empty edit delays this track in movie time. The source bytes
    // and edit list are preserved for the native browser demuxer.
    movieStartSeconds?: number;
  }[];
  validationBasis: "bounded-iso-bmff-metadata";
  serverDecoded: false;
  index?: SourceMp4Index;
  fragmented?: FragmentedMp4Summary;
}
type Box = { type: string; start: number; data: number; end: number };
class InspectionError extends Error {}
const fail = (reason: string): never => {
  throw new InspectionError(reason);
};
const u32 = (b: Uint8Array, n: number) => {
  if (n < 0 || n + 4 > b.length) fail("truncated_metadata");
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(n);
};
const u16 = (b: Uint8Array, n: number) => {
  if (n < 0 || n + 2 > b.length) fail("truncated_metadata");
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(n);
};
const u64 = (b: Uint8Array, n: number) => {
  const value = u32(b, n) * 2 ** 32 + u32(b, n + 4);
  if (!Number.isSafeInteger(value)) fail("unsafe_box_integer");
  return value;
};
const text = (b: Uint8Array, n: number) =>
  String.fromCharCode(...b.subarray(n, n + 4));

// AAC-LC encoders may append a sync extension explicitly saying SBR is off.
// Accept that declared absence, while rejecting HE-AAC and unknown extensions.
export function aacLcExtensionSupported(tail: Uint8Array): boolean {
  if (tail.every((byte) => byte === 0)) return true;
  const bits = [...tail]
    .map((byte) => byte.toString(2).padStart(8, "0"))
    .join("");
  return (
    bits.length >= 17 &&
    bits.slice(0, 11) === "01010110111" &&
    bits.slice(11, 16) === "00101" &&
    bits[16] === "0" &&
    /^0*$/.test(bits.slice(17))
  );
}

export async function inspectSourceMp4(
  size: number,
  readRange: (offset: number, length: number) => Promise<Uint8Array>,
  options: {
    allowMono?: boolean;
    // Optimized faststart outputs keep the classic MP4-only contract.
    allowFragmented?: boolean;
    onFragmentReadPlan?: (plan: {
      basis: "mfra-hints" | "sequential";
      hintCount: number;
      indexBytes: number;
      concurrency: number;
    }) => void;
    onTopLevelBox?: (box: {
      type: string;
      offset: number;
      bytes: number;
    }) => void;
  } = {},
): Promise<SourceMp4Probe> {
  const result: SourceMp4Probe = {
    compatible: false,
    reasons: [],
    validationBasis: "bounded-iso-bmff-metadata",
    serverDecoded: false,
    index: {
      basis: "bounded-top-level-box-scan",
      placement: "unknown",
      reason: "top-level-scan-unverified",
    },
  };
  let closeReads = () => {};
  try {
    if (!Number.isSafeInteger(size) || size < 32) fail("invalid_mp4_size");
    let readBytes = 0;
    let boxCount = 0;
    let closed = false;
    let activeReads = 0;
    const waiting: { resolve: () => void; reject: (error: Error) => void }[] =
      [];
    closeReads = () => {
      closed = true;
      for (const waiter of waiting.splice(0))
        waiter.reject(new InspectionError("source_read_unverified"));
    };
    const read = async (offset: number, length: number) => {
      if (closed) fail("source_read_unverified");
      // Reserve synchronously, including failed/unused speculative reads. The
      // semaphore covers the entire range read (GET plus response body).
      if (
        offset < 0 ||
        length < 1 ||
        offset + length > size ||
        (readBytes += length) > 5 * 1024 ** 2
      )
        fail("metadata_limit");
      await new Promise<void>((resolve, reject) => {
        if (activeReads < 8) {
          activeReads++;
          resolve();
        } else waiting.push({ resolve, reject });
      });
      try {
        if (closed) fail("source_read_unverified");
        const bytes = await readRange(offset, length);
        if (bytes.length !== length) fail("truncated_metadata");
        return bytes;
      } finally {
        activeReads--;
        if (!closed && waiting.length) {
          activeReads++;
          waiting.shift()!.resolve();
        }
      }
    };
    const boxes = (b: Uint8Array, start: number, end: number): Box[] => {
      const found: Box[] = [];
      while (start < end) {
        if (++boxCount > 4096 || end - start < 8)
          fail("box_limit_or_truncation");
        const small = u32(b, start);
        const header = small === 1 ? 16 : 8;
        const length = small === 1 ? u64(b, start + 8) : small || end - start;
        if (length < header || start + length > end) fail("invalid_box_size");
        found.push({
          type: text(b, start + 4),
          start,
          data: start + header,
          end: start + length,
        });
        start += length;
      }
      return found;
    };
    const child = (b: Uint8Array, parent: Box, type: string, skip = 0): Box => {
      const matches = boxes(b, parent.data + skip, parent.end).filter(
        (box) => box.type === type,
      );
      if (matches.length !== 1) fail("missing_or_duplicate_" + type);
      return matches[0];
    };
    const top: Box[] = [];
    const moofs = new Map<number, Uint8Array>();
    let fragmented = false;
    let window: { offset: number; bytes: Uint8Array } | null = null;
    let footer: { offset: number; bytes: Uint8Array } | null = null;
    type HintResult =
      { bytes: Uint8Array; error?: never } | { bytes?: never; error: unknown };
    const prefetched = new Map<number, Promise<HintResult>>();
    let hintOffsets: number[] = [],
      nextHint = 0,
      activeHints = 0;
    let hintError: { error: unknown } | null = null;
    let planned = false;
    const from = (
      range: { offset: number; bytes: Uint8Array } | null,
      offset: number,
      length: number,
    ) =>
      range &&
      offset >= range.offset &&
      offset + length <= range.offset + range.bytes.length
        ? range.bytes.subarray(
            offset - range.offset,
            offset - range.offset + length,
          )
        : null;
    const pump = () => {
      while (
        !closed &&
        !hintError &&
        activeHints < 8 &&
        nextHint < hintOffsets.length
      ) {
        const offset = hintOffsets[nextHint++];
        activeHints++;
        // Install rejection handling when the task is created, including when
        // the authoritative scan will fail before consuming this hint.
        const task: Promise<HintResult> = read(
          offset,
          Math.min(4096, size - offset),
        )
          .then(
            (bytes) => ({ bytes }),
            (error) => {
              hintError ??= { error };
              return { error };
            },
          )
          .then((outcome) => {
            activeHints--;
            pump();
            return outcome;
          });
        prefetched.set(offset, task);
      }
    };
    const planHints = async () => {
      if (planned) return;
      planned = true;
      let offsets: number[] = [];
      try {
        const tail = await read(size - 16, 16);
        const total = u32(tail, 12);
        if (
          u32(tail, 0) !== 16 ||
          text(tail, 4) !== "mfro" ||
          u32(tail, 8) ||
          total < 24 ||
          total > 256 * 1024 ||
          total > size
        )
          throw new InspectionError("unsupported_fragment_index");
        const start = size - total;
        const header = await read(start, 8);
        // Only ordinary box headers are supported as hints. Extended or
        // malformed footer layouts still undergo the full sequential proof.
        if (u32(header, 0) !== total || text(header, 4) !== "mfra")
          throw new InspectionError("unsupported_fragment_index");
        const middle =
          total > 24 ? await read(start + 8, total - 24) : new Uint8Array();
        const bytes = new Uint8Array(total);
        bytes.set(header);
        bytes.set(middle, 8);
        bytes.set(tail, total - 16);
        footer = { offset: start, bytes };
        const children = boxes(bytes, 8, bytes.length);
        if (
          children.some((box) => !["tfra", "mfro"].includes(box.type)) ||
          children.at(-1)?.type !== "mfro" ||
          children.filter((box) => box.type === "mfro").length !== 1
        )
          throw new InspectionError("unsupported_fragment_index");
        const unique = new Set<number>();
        for (const index of children.filter((box) => box.type === "tfra")) {
          if (
            index.end - index.data < 16 ||
            ![0, 1].includes(bytes[index.data]) ||
            u32(bytes, index.data) & 0xffffff
          )
            throw new InspectionError("unsupported_fragment_index");
          const lengths = u32(bytes, index.data + 8),
            count = u32(bytes, index.data + 12);
          const wide = bytes[index.data] === 1 ? 8 : 4;
          const stride =
            wide * 2 +
            ((lengths >>> 4) & 3) +
            ((lengths >>> 2) & 3) +
            (lengths & 3) +
            3;
          if (
            lengths >>> 6 ||
            count > 4096 ||
            index.data + 16 + stride * count !== index.end
          )
            throw new InspectionError("unsupported_fragment_index");
          for (let p = index.data + 16; p < index.end; p += stride) {
            // Decode the time too so unsafe 64-bit integers cannot sneak into
            // the hint parser. None of these fields are trusted as proof.
            if (wide === 8) u64(bytes, p);
            const offset =
              wide === 8 ? u64(bytes, p + wide) : u32(bytes, p + wide);
            if (offset < 0 || offset > size - 8)
              throw new InspectionError("unsupported_fragment_index");
            unique.add(offset);
            if (unique.size > 1024)
              throw new InspectionError("unsupported_fragment_index");
          }
        }
        offsets = [...unique].sort((a, b) => a - b);
      } catch {
        // Missing, incomplete or forged hints are an optimization miss, never
        // permission to skip any part of the authoritative sequential scan.
      }
      hintOffsets = offsets;
      options.onFragmentReadPlan?.({
        basis: offsets.length ? "mfra-hints" : "sequential",
        hintCount: offsets.length,
        indexBytes: footer?.bytes.length ?? 0,
        concurrency: offsets.length ? 8 : 1,
      });
      pump();
    };
    const cached = async (
      offset: number,
      length: number,
    ): Promise<Uint8Array> => {
      const existing =
        from(window, offset, length) ?? from(footer, offset, length);
      if (existing) return existing;
      if (hintError) throw hintError.error;
      const hinted = prefetched.get(offset);
      if (hinted) {
        const outcome = await hinted;
        if ("error" in outcome) throw outcome.error;
        if (outcome.bytes && length <= outcome.bytes.length)
          return outcome.bytes.subarray(0, length);
      }
      return read(offset, length);
    };
    const readWindow = async (offset: number) => {
      const length = Math.min(4096, size - offset);
      const bytes = await cached(offset, length);
      return { offset, bytes };
    };
    for (let offset = 0; offset < size;) {
      if (top.length >= (fragmented ? 4096 : 128) || size - offset < 8)
        fail("top_box_limit");
      // Only the fragment path reads ahead into a small, explicitly charged
      // window. Ordinary MP4 still reads headers without any media payload.
      if (
        fragmented &&
        (!window ||
          offset < window.offset ||
          offset + 8 > window.offset + window.bytes.length)
      )
        window = await readWindow(offset);
      let header = await cached(offset, 8);
      const small = u32(header, 0);
      // EBML (used by WebM/Matroska) is a different container, not an MP4
      // length failure. This signature does not establish its document type,
      // track compatibility, integrity or decoding; only MP4 is inspected.
      if (offset === 0 && small === 0x1a45dfa3)
        fail("unsupported_source_container");
      let length = small || size - offset;
      let headerSize = 8;
      if (small === 1) {
        header = await cached(offset, 16);
        length = u64(header, 8);
        headerSize = 16;
      }
      if (
        length < headerSize ||
        !Number.isSafeInteger(offset + length) ||
        offset + length > size
      )
        fail("invalid_box_size");
      const kind = text(header, 4);
      const box = {
        type: kind,
        start: offset,
        data: offset + headerSize,
        end: offset + length,
      };
      top.push(box);
      options.onTopLevelBox?.({ type: kind, offset, bytes: length });
      if (kind === "moof") {
        if (options.allowFragmented === false)
          fail("fragmented_or_encrypted_mp4");
        fragmented = true;
        await planHints();
        if (moofs.size >= 1024 || length > 65536)
          fail("fragment_metadata_limit");
        if (
          !window ||
          offset < window.offset ||
          offset + Math.min(length + 8, size - offset) >
            window.offset + window.bytes.length
        )
          window = await readWindow(offset);
        moofs.set(offset, await cached(box.data, box.end - box.data));
      }
      offset += length;
    }
    const ftyp = top.filter((box) => box.type === "ftyp");
    const movie = top.filter((box) => box.type === "moov");
    const mdats = top.filter((box) => box.type === "mdat");
    // Placement is an independent structural fact, not evidence of decoding or
    // browser compatibility. Do not infer it from a partially scanned file.
    if (movie.length !== 1) {
      result.index = {
        basis: "bounded-top-level-box-scan",
        placement: "unknown",
        reason: "missing-or-duplicate-moov",
      };
    } else {
      const moov = movie[0];
      const identity = {
        basis: "bounded-top-level-box-scan" as const,
        moovOffset: moov.start,
        moovBytes: moov.end - moov.start,
      };
      result.index =
        !mdats.length || mdats.some((mdat) => mdat.data === mdat.end)
          ? {
              ...identity,
              placement: "unknown",
              reason: "media-ranges-unverified",
            }
          : {
              ...identity,
              placement: mdats.every((mdat) => moov.end <= mdat.start)
                ? "before-media"
                : mdats.every((mdat) => mdat.end <= moov.start)
                  ? "after-media"
                  : "between-media",
            };
    }
    if (top.some((box) => ["sidx", "pssh"].includes(box.type)))
      fail("fragmented_or_encrypted_mp4");
    if (
      ftyp.length !== 1 ||
      movie.length !== 1 ||
      !mdats.length ||
      top[0].type !== "ftyp"
    )
      fail("not_complete_mp4");
    if (ftyp[0].end - ftyp[0].data > 1024 || ftyp[0].end - ftyp[0].data < 8)
      fail("invalid_ftyp");
    const brands = await read(ftyp[0].data, ftyp[0].end - ftyp[0].data);
    if ((brands.length - 8) % 4) fail("invalid_ftyp");
    const names = [text(brands, 0)];
    for (let p = 8; p < brands.length; p += 4) names.push(text(brands, p));
    if (
      !names.some((name) =>
        ["isom", "iso2", "mp41", "mp42", "avc1"].includes(name),
      )
    )
      fail("unsupported_mp4_brand");
    const moov = movie[0];
    if (moov.end - moov.data > 4 * 1024 ** 2) fail("metadata_limit");
    const b = await read(moov.data, moov.end - moov.data);
    const root: Box = { type: "moov", start: 0, data: 0, end: b.length };
    const roots = boxes(b, 0, b.length);
    const mvexes = roots.filter((box) => box.type === "mvex");
    if (
      roots.some((box) => box.type === "pssh") ||
      (fragmented ? mvexes.length !== 1 : mvexes.length > 0)
    )
      fail("fragmented_or_encrypted_mp4");
    const duration = (box: Box) => {
      const version = b[box.data];
      if (version !== 0 && version !== 1) fail("unsupported_header_version");
      if (
        box.end - box.data <
        (box.type === "mvhd" ? (version ? 112 : 100) : version ? 36 : 24)
      )
        fail("truncated_metadata");
      const scale = u32(b, box.data + (version ? 20 : 12));
      const ticks = version ? u64(b, box.data + 24) : u32(b, box.data + 16);
      if (
        !scale ||
        (!fragmented && !ticks) ||
        ticks === 0xffffffff ||
        !Number.isFinite(ticks / scale)
      )
        fail("invalid_duration");
      return { scale, ticks, seconds: ticks / scale };
    };
    const movieDuration = duration(child(b, root, "mvhd"));
    if (!fragmented) result.durationSeconds = movieDuration.seconds;
    const fragmentTracks: FragmentTrack[] = [];
    const nativeEdits: NonNullable<SourceMp4Probe["nativeEdits"]> = [];
    const trackIds = new Set<number>();
    const tracks = roots.filter((box) => box.type === "trak");
    if (tracks.length < 1 || tracks.length > 2) fail("unsupported_track_count");
    let videos = 0,
      audios = 0;
    const extents: { start: number; end: number }[] = [];
    for (const track of tracks) {
      const tkhd = child(b, track, "tkhd");
      const mdia = child(b, track, "mdia");
      const mdhd = child(b, mdia, "mdhd");
      const media = duration(mdhd);
      const hdlr = child(b, mdia, "hdlr");
      if (b[tkhd.data] > 1) fail("unsupported_header_version");
      if (
        hdlr.end - hdlr.data < 12 ||
        tkhd.end - tkhd.data < (b[tkhd.data] ? 96 : 84) ||
        (u32(b, tkhd.data) & 3) !== 3
      )
        fail("truncated_or_disabled_track");
      const handler = text(b, hdlr.data + 8);
      if (!["vide", "soun"].includes(handler)) fail("unsupported_track_type");
      if (!fragmented && Math.abs(media.seconds - movieDuration.seconds) > 1)
        fail("track_duration_mismatch");
      const edits = boxes(b, track.data, track.end).filter(
        (box) => box.type === "edts",
      );
      if (edits.length > 1) fail("unsupported_edit_list");
      let editMediaTime = 0,
        editDurationSeconds = 0,
        editMovieStartSeconds = 0;
      if (edits.length) {
        const elst = child(b, edits[0], "elst");
        const entryCount = u32(b, elst.data + 4);
        if (
          u32(b, elst.data) !== 0 ||
          ![1, 2].includes(entryCount) ||
          elst.end - elst.data !== 8 + entryCount * 12 ||
          // Fragmented playback uses a separate MSE timeline contract and
          // cannot inherit the native demuxer's empty-edit support.
          (fragmented && entryCount !== 1)
        )
          fail("unsupported_edit_list");
        let entry = elst.data + 8;
        if (entryCount === 2) {
          const delay = u32(b, entry);
          // Deliberately support only a leading empty edit followed by one
          // normal-rate media edit. Repeats, gaps, dwell/rate changes and
          // trailing empty edits still need their own validation.
          if (
            !delay ||
            u32(b, entry + 4) !== 0xffffffff ||
            u32(b, entry + 8) !== 0x10000
          )
            fail("unsupported_edit_list");
          editMovieStartSeconds = delay / movieDuration.scale;
          entry += 12;
        }
        const segment = u32(b, entry) / movieDuration.scale;
        const mediaTime = u32(b, entry + 4);
        const presentationDuration = editMovieStartSeconds + segment;
        if (
          mediaTime >= 0x80000000 ||
          mediaTime / media.scale > 1 ||
          u32(b, entry + 8) !== 0x10000 ||
          (!fragmented &&
            (segment <= 0 ||
              presentationDuration >
                movieDuration.seconds +
                  Math.min(0.01, 1 / movieDuration.scale))) ||
          // tkhd is the edited track duration in movie timescale. Audio may
          // legitimately end before video (AAC priming/trailing padding).
          // Comparing each elst to the whole movie rejects valid files.
          (!fragmented &&
            Math.abs(
              presentationDuration -
                (b[tkhd.data]
                  ? u64(b, tkhd.data + 28)
                  : u32(b, tkhd.data + 20)) /
                  movieDuration.scale,
            ) >
              1 / movieDuration.scale)
        )
          fail("unsupported_edit_list");
        editMediaTime = mediaTime;
        editDurationSeconds = segment;
      }
      const minf = child(b, mdia, "minf");
      const dref = child(b, child(b, minf, "dinf"), "dref");
      if (dref.end - dref.data < 8) fail("truncated_metadata");
      const references = boxes(b, dref.data + 8, dref.end);
      if (
        u32(b, dref.data + 4) !== 1 ||
        references.length !== 1 ||
        references[0].type !== "url " ||
        references[0].end - references[0].data !== 4 ||
        u32(b, references[0].data) !== 1
      )
        fail("external_data_reference");
      const stbl = child(b, minf, "stbl");
      const stsd = child(b, stbl, "stsd");
      if (stsd.end - stsd.data < 8) fail("truncated_metadata");
      const entries = boxes(b, stsd.data + 8, stsd.end);
      if (
        u32(b, stsd.data + 4) !== 1 ||
        entries.length !== 1 ||
        u16(b, entries[0].data + 6) !== 1
      )
        fail("unsupported_sample_descriptions");
      const entry = entries[0];
      if (handler === "vide") {
        if (entry.end - entry.data < 78) fail("truncated_metadata");
        if (++videos > 1 || !["avc1", "avc3"].includes(entry.type))
          fail("unsupported_video_codec");
        result.width = u16(b, entry.data + 24);
        result.height = u16(b, entry.data + 26);
        if (
          !result.width ||
          !result.height ||
          result.width > 8192 ||
          result.height > 8192
        )
          fail("unsupported_dimensions");
        const extension = boxes(b, entry.data + 78, entry.end);
        if (
          extension.some((box) =>
            ["sinf", "mdcv", "clli", "dvcC", "dvvC", "clap"].includes(box.type),
          )
        )
          fail("unsupported_hdr_or_encryption");
        for (const aspect of extension.filter((box) => box.type === "pasp"))
          if (
            aspect.end - aspect.data !== 8 ||
            u32(b, aspect.data) !== u32(b, aspect.data + 4) ||
            !u32(b, aspect.data)
          )
            fail("unsupported_video_transform");
        for (const color of extension.filter((box) => box.type === "colr"))
          if (
            color.end - color.data < 10 ||
            (text(b, color.data) !== "nclx" &&
              text(b, color.data) !== "nclc") ||
            u16(b, color.data + 4) === 9 ||
            [16, 18].includes(u16(b, color.data + 6))
          )
            fail("unsupported_color_metadata");
        const avcc = extension.filter((box) => box.type === "avcC");
        if (avcc.length !== 1) fail("missing_avc_config");
        const c = b.subarray(avcc[0].data, avcc[0].end);
        if (
          c.length < 7 ||
          c[0] !== 1 ||
          ![66, 77, 100].includes(c[1]) ||
          c[3] > 51 ||
          (c[4] & 0xfc) !== 0xfc ||
          (c[5] & 0xe0) !== 0xe0 ||
          (c[4] & 3) === 2
        )
          fail("unsupported_avc_profile");
        let p = 6;
        const sps = c[5] & 31;
        if (!sps) fail("missing_avc_parameter_sets");
        for (let n = 0; n < sps; n++) {
          const length = u16(c, p);
          p += 2;
          if (
            length < 4 ||
            p + length > c.length ||
            (c[p] & 31) !== 7 ||
            c[p + 1] !== c[1] ||
            c[p + 2] !== c[2] ||
            c[p + 3] !== c[3]
          )
            fail("invalid_avc_config");
          p += length;
        }
        if (p >= c.length || !c[p]) fail("missing_avc_parameter_sets");
        const pps = c[p++];
        for (let n = 0; n < pps; n++) {
          const length = u16(c, p);
          p += 2;
          if (length < 2 || p + length > c.length || (c[p] & 31) !== 8)
            fail("invalid_avc_config");
          p += length;
        }
        if (p < c.length) {
          if (
            c[1] !== 100 ||
            c.length - p < 4 ||
            (c[p] & 0xfc) !== 0xfc ||
            (c[p] & 3) !== 1 ||
            (c[p + 1] & 0xf8) !== 0xf8 ||
            (c[p + 1] & 7) !== 0 ||
            (c[p + 2] & 0xf8) !== 0xf8 ||
            (c[p + 2] & 7) !== 0
          )
            fail("unsupported_avc_bit_depth");
          p += 3;
          const extensions = c[p++];
          for (let n = 0; n < extensions; n++) {
            const length = u16(c, p);
            p += 2;
            if (!length || p + length > c.length || (c[p] & 31) !== 13)
              fail("invalid_avc_config");
            p += length;
          }
          if (p !== c.length) fail("invalid_avc_config");
        }
        result.videoCodec = entry.type;
        const version = b[tkhd.data];
        if (version > 1) fail("unsupported_header_version");
        const matrix = tkhd.data + (version ? 52 : 40);
        const identity = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
        if (identity.some((value, i) => u32(b, matrix + i * 4) !== value))
          fail("unsupported_video_transform");
        if (
          u32(b, matrix + 36) !== result.width * 65536 ||
          u32(b, matrix + 40) !== result.height * 65536
        )
          fail("unsupported_video_transform");
      } else {
        if (entry.end - entry.data < 28) fail("truncated_metadata");
        const channels = u16(b, entry.data + 16);
        if (
          boxes(b, entry.data + 28, entry.end).some(
            (box) => box.type === "sinf",
          )
        )
          fail("encrypted_samples");
        if (
          ++audios > 1 ||
          entry.type !== "mp4a" ||
          u16(b, entry.data + 8) !== 0 ||
          (channels !== 2 && !(options.allowMono && channels === 1))
        )
          fail("unsupported_audio_codec_or_channels");
        const esds = child(b, entry, "esds", 28);
        const descriptor = (start: number, end: number, tag: number) => {
          if (b[start++] !== tag) fail("invalid_audio_descriptor");
          let length = 0,
            count = 0,
            next: number;
          do {
            if (start >= end || ++count > 4) fail("invalid_audio_descriptor");
            next = b[start++];
            length = length * 128 + (next & 127);
          } while (next & 128);
          if (start + length > end) fail("invalid_audio_descriptor");
          return { start, end: start + length };
        };
        const es = descriptor(esds.data + 4, esds.end, 3);
        if (b[es.start + 2] !== 0) fail("unsupported_audio_descriptor");
        const decoder = descriptor(es.start + 3, es.end, 4);
        if (b[decoder.start] !== 0x40 || b[decoder.start + 1] >> 2 !== 5)
          fail("unsupported_audio_codec");
        const asc = descriptor(decoder.start + 13, decoder.end, 5);
        if (
          asc.end - asc.start < 2 ||
          asc.end - asc.start > 16 ||
          b[asc.start] >> 3 !== 2 ||
          (((b[asc.start] & 7) << 1) | (b[asc.start + 1] >> 7)) > 12 ||
          ((b[asc.start + 1] >> 3) & 15) !== channels ||
          (b[asc.start + 1] & 7) !== 0 ||
          !aacLcExtensionSupported(b.subarray(asc.start + 2, asc.end))
        )
          fail("unsupported_aac_profile");
        result.audioCodec = "mp4a.40.2";
        result.audioChannels = channels;
      }
      if (fragmented) {
        const version = b[tkhd.data];
        if (version > 1) fail("unsupported_header_version");
        const id = u32(b, tkhd.data + (version ? 20 : 12));
        if (!id || trackIds.has(id)) fail("invalid_fragment_track_id");
        trackIds.add(id);
        fragmentTracks.push({
          id,
          type: handler === "vide" ? "video" : "audio",
          timescale: media.scale,
          initialDurationSeconds: media.seconds,
          editMediaTime,
          editDurationSeconds,
        });
        const tables = boxes(b, stbl.data, stbl.end);
        if (
          tables.some((box) =>
            ["senc", "saiz", "saio", "sgpd", "sbgp"].includes(box.type),
          )
        )
          fail("encrypted_or_grouped_fragment_samples");
        if (
          tables.some(
            (box) =>
              ![
                "stsd",
                "stsz",
                "stts",
                "stsc",
                "stco",
                "co64",
                "stss",
                "ctts",
              ].includes(box.type),
          )
        )
          fail("unsupported_fragment_sample_table");
        const stsz = child(b, stbl, "stsz");
        if (
          stsz.end - stsz.data !== 12 ||
          u32(b, stsz.data) ||
          u32(b, stsz.data + 4) ||
          u32(b, stsz.data + 8)
        )
          fail("nonempty_fragment_init_samples");
        for (const name of ["stts", "stsc"]) {
          const table = child(b, stbl, name);
          if (
            table.end - table.data !== 8 ||
            u32(b, table.data) ||
            u32(b, table.data + 4)
          )
            fail("nonempty_fragment_init_samples");
        }
        const offsets = tables.filter((box) =>
          ["stco", "co64"].includes(box.type),
        );
        if (offsets.length !== 1) fail("invalid_chunk_table");
        for (const table of [
          ...offsets,
          ...tables.filter((box) => ["stss", "ctts"].includes(box.type)),
        ])
          if (
            table.end - table.data !== 8 ||
            u32(b, table.data) ||
            u32(b, table.data + 4)
          )
            fail("nonempty_fragment_init_samples");
        continue;
      }
      const stsz = child(b, stbl, "stsz");
      const fixed = u32(b, stsz.data + 4),
        samples = u32(b, stsz.data + 8);
      if (
        !samples ||
        samples > 1000000 ||
        stsz.end - stsz.data !== 12 + (fixed ? 0 : 4 * samples)
      )
        fail("sample_table_limit");
      const stts = child(b, stbl, "stts");
      const times = u32(b, stts.data + 4);
      if (stts.end - stts.data !== 8 + 8 * times) fail("invalid_time_table");
      let counted = 0,
        ticks = 0;
      for (let n = 0; n < times; n++) {
        const count = u32(b, stts.data + 8 + n * 8),
          delta = u32(b, stts.data + 12 + n * 8);
        if (!count || !delta) fail("invalid_time_table");
        counted += count;
        ticks += count * delta;
      }
      if (
        counted !== samples ||
        !Number.isSafeInteger(ticks) ||
        Math.abs(ticks - media.ticks) > media.scale / 10
      )
        fail("sample_duration_mismatch");
      const tables = boxes(b, stbl.data, stbl.end);
      if (
        tables.filter((box) => box.type === "stss").length > 1 ||
        tables.filter((box) => box.type === "ctts").length > 1
      )
        fail("duplicate_sample_table");
      for (const sync of tables.filter((box) => box.type === "stss")) {
        const count = u32(b, sync.data + 4);
        let previous = 0;
        if (!count || sync.end - sync.data !== 8 + count * 4)
          fail("invalid_sync_table");
        for (let n = 0; n < count; n++) {
          const index = u32(b, sync.data + 8 + n * 4);
          if ((!n && index !== 1) || index <= previous || index > samples)
            fail("invalid_sync_table");
          previous = index;
        }
      }
      for (const composition of tables.filter((box) => box.type === "ctts")) {
        const count = u32(b, composition.data + 4);
        let counted = 0;
        if (
          b[composition.data] > 1 ||
          (u32(b, composition.data) & 0xffffff) !== 0 ||
          composition.end - composition.data !== 8 + count * 8
        )
          fail("invalid_composition_table");
        for (let n = 0; n < count; n++) {
          const p = composition.data + 8 + n * 8;
          const offset =
            b[composition.data] === 1
              ? new DataView(b.buffer, b.byteOffset).getInt32(p + 4)
              : u32(b, p + 4);
          const samplesInRun = u32(b, p);
          if (!samplesInRun || (counted += samplesInRun) > samples)
            fail("invalid_composition_table");
          if (Math.abs(offset) > media.scale * 2)
            fail("unsupported_composition_offset");
        }
        if (counted !== samples) fail("invalid_composition_table");
      }
      if (edits.length) {
        // Decode duration (mdhd/stts) excludes composition offsets. In an
        // ordinary B-frame MP4 the last presented sample can end after mdhd.
        // Intersect timing/CTS runs directly to bound PTS without allocating
        // an array for up to a million samples or reading any media payload.
        const composition = tables.find((box) => box.type === "ctts");
        let timeRun = 0,
          compositionRun = 0,
          timeLeft = u32(b, stts.data + 8),
          compositionLeft = composition
            ? u32(b, composition.data + 8)
            : samples,
          decodeTime = 0,
          presentationStart = Infinity,
          presentationEnd = -Infinity;
        while (timeRun < times) {
          const count = Math.min(timeLeft, compositionLeft),
            delta = u32(b, stts.data + 12 + timeRun * 8),
            offsetPosition = composition
              ? composition.data + 12 + compositionRun * 8
              : 0,
            offset = !composition
              ? 0
              : b[composition.data] === 1
                ? new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(
                    offsetPosition,
                  )
                : u32(b, offsetPosition),
            start = decodeTime + offset,
            end = decodeTime + count * delta + offset;
          if (
            !count ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end)
          )
            fail("invalid_composition_table");
          presentationStart = Math.min(presentationStart, start);
          presentationEnd = Math.max(presentationEnd, end);
          decodeTime += count * delta;
          timeLeft -= count;
          compositionLeft -= count;
          if (!timeLeft && ++timeRun < times)
            timeLeft = u32(b, stts.data + 8 + timeRun * 8);
          if (!compositionLeft && composition && timeRun < times)
            compositionLeft = u32(
              b,
              composition.data + 8 + ++compositionRun * 8,
            );
        }
        const editEnd = editMediaTime + editDurationSeconds * media.scale,
          tickTolerance = media.scale / movieDuration.scale,
          // Only compensate floating-point arithmetic around a movie tick.
          epsilon =
            Number.EPSILON *
            Math.max(1, Math.abs(editEnd), Math.abs(presentationEnd)) *
            4;
        if (
          editMediaTime < presentationStart - tickTolerance - epsilon ||
          editMediaTime >= presentationEnd ||
          editEnd > presentationEnd + tickTolerance + epsilon
        )
          fail("unsupported_edit_list");
        nativeEdits.push({
          track: handler === "vide" ? "video" : "audio",
          mediaStartSeconds: editMediaTime / media.scale,
          durationSeconds: editDurationSeconds,
          ...(editMovieStartSeconds > 0
            ? { movieStartSeconds: editMovieStartSeconds }
            : {}),
        });
      }
      if (tables.some((box) => ["senc", "saiz", "saio"].includes(box.type)))
        fail("encrypted_samples");
      const offsets = tables.filter((box) =>
        ["stco", "co64"].includes(box.type),
      );
      if (offsets.length !== 1) fail("invalid_chunk_table");
      const offsetsBox = offsets[0],
        chunks = u32(b, offsetsBox.data + 4),
        stride = offsetsBox.type === "co64" ? 8 : 4;
      if (
        !chunks ||
        chunks > 100000 ||
        offsetsBox.end - offsetsBox.data !== 8 + stride * chunks
      )
        fail("chunk_table_limit");
      const stsc = child(b, stbl, "stsc"),
        entriesCount = u32(b, stsc.data + 4);
      if (
        !entriesCount ||
        entriesCount > chunks ||
        stsc.end - stsc.data !== 8 + 12 * entriesCount
      )
        fail("invalid_chunk_table");
      const mapping: { first: number; count: number }[] = [];
      for (let n = 0; n < entriesCount; n++) {
        const p = stsc.data + 8 + n * 12,
          first = u32(b, p),
          count = u32(b, p + 4);
        if (
          (!n && first !== 1) ||
          (n && first <= mapping[n - 1].first) ||
          first > chunks ||
          !count ||
          u32(b, p + 8) !== 1
        )
          fail("invalid_chunk_table");
        mapping.push({ first, count });
      }
      let sample = 0,
        map = 0;
      for (let n = 0; n < chunks; n++) {
        if (map + 1 < mapping.length && mapping[map + 1].first === n + 1) map++;
        const start =
          stride === 8
            ? u64(b, offsetsBox.data + 8 + n * stride)
            : u32(b, offsetsBox.data + 8 + n * stride);
        let end = start;
        if (sample + mapping[map].count > samples)
          fail("chunk_sample_mismatch");
        for (let count = 0; count < mapping[map].count; count++, sample++) {
          const bytes = fixed || u32(b, stsz.data + 12 + sample * 4);
          if (!bytes) fail("empty_sample");
          end += bytes;
        }
        if (!mdats.some((mdat) => start >= mdat.data && end <= mdat.end))
          fail("sample_outside_mdat");
        extents.push({ start, end });
      }
      if (sample !== samples) fail("chunk_sample_mismatch");
    }
    if (videos !== 1) fail("video_track_required");
    extents.sort((a, b) => a.start - b.start);
    if (extents.some((extent, n) => n && extent.start < extents[n - 1].end))
      fail("overlapping_samples");
    if (fragmented) {
      const indexes = top.filter((box) => box.type === "mfra");
      if (indexes.some((box) => box.end - box.data > 256 * 1024))
        fail("fragment_index_limit");
      const inspected = inspectFragments({
        top,
        moofs,
        tracks: fragmentTracks,
        mvex: b.subarray(mvexes[0].data, mvexes[0].end),
        movieDurationSeconds: movieDuration.seconds,
        movieTimescale: movieDuration.scale,
        ...(indexes.length === 1
          ? {
              mfra: await cached(
                indexes[0].data,
                indexes[0].end - indexes[0].data,
              ),
            }
          : {}),
      });
      result.durationSeconds = inspected.durationSeconds;
      result.fragmented = inspected.summary;
    }
    // Publish timeline support only with the complete compatible proof. A
    // later track/sample failure must not expose earlier edits as a file-wide
    // success signal beside an unsupported_edit_list result.
    if (nativeEdits.length) result.nativeEdits = nativeEdits;
    result.audioCodec ??= null;
    result.audioChannels ??= 0;
    result.compatible = true;
  } catch (error) {
    const reason =
      error instanceof InspectionError ||
      error instanceof FragmentInspectionError
        ? error.message
        : "source_read_unverified";
    result.reasons = [reason];
  } finally {
    // Stop scheduling immediately. The readRange owner cancels all acquired
    // readers/late GET bodies when this inspection scope ends; we cannot wait
    // for a remote promise that may never settle.
    closeReads();
  }
  return result;
}
