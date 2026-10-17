// Playback packaging only: the caller must first obtain a complete, current
// identity-bound source proof. These helpers never decode or change samples.
export const SOURCE_FRAGMENTED_LIMITS = {
  initBytes: 256 * 1024,
  indexBytes: 256 * 1024,
  fragmentBytes: 16 * 1024 * 1024,
  fragments: 1024,
  samplesPerFragment: 16384,
} as const;

export class FragmentedPlaybackError extends Error {
  readonly code = "source_fragmented_unsupported";
}
function fail(reason: string): never {
  throw new FragmentedPlaybackError(reason);
}
const safe = (n: number) => {
  if (!Number.isSafeInteger(n)) fail("unsafe_integer");
  return n;
};
const view = (b: Uint8Array) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength);
const u32 = (b: Uint8Array, p: number) => {
  if (p < 0 || p + 4 > b.length) fail("truncated_metadata");
  return view(b).getUint32(p);
};
const i32 = (b: Uint8Array, p: number) => {
  if (p < 0 || p + 4 > b.length) fail("truncated_metadata");
  return view(b).getInt32(p);
};
const u16 = (b: Uint8Array, p: number) => {
  if (p < 0 || p + 2 > b.length) fail("truncated_metadata");
  return view(b).getUint16(p);
};
const u64 = (b: Uint8Array, p: number) =>
  safe(u32(b, p) * 2 ** 32 + u32(b, p + 4));
const text = (b: Uint8Array, p: number) => {
  if (p < 0 || p + 4 > b.length) fail("truncated_metadata");
  return String.fromCharCode(...b.subarray(p, p + 4));
};
type Box = { type: string; start: number; data: number; end: number };
function at(b: Uint8Array, start: number, end = b.length): Box {
  if (start < 0 || end - start < 8) fail("truncated_box");
  const length = u32(b, start);
  // The playback subset uses ordinary headers. Reject extended/implicit sizes
  // rather than introducing another size delta while relocating fragment data.
  if (length < 8 || safe(start + length) > end) fail("invalid_box_bounds");
  return {
    type: text(b, start + 4),
    start,
    data: start + 8,
    end: start + length,
  };
}
function boxes(b: Uint8Array, start = 0, end = b.length) {
  const result: Box[] = [];
  while (start < end) {
    if (result.length >= 128) fail("box_count_limit");
    const item = at(b, start, end);
    result.push(item);
    start = item.end;
  }
  if (start !== end) fail("invalid_box_bounds");
  return result;
}
function one(items: Box[], name: string) {
  const found = items.filter((b) => b.type === name);
  if (found.length !== 1) fail("missing_or_duplicate_box");
  return found[0];
}
function full(b: Uint8Array, box: Box, versions: number[], mask = 0) {
  if (box.end - box.data < 4) fail("truncated_full_box");
  const word = u32(b, box.data);
  if (!versions.includes(word >>> 24) || word & 0xffffff & ~mask)
    fail("unsupported_flags_or_version");
  return word & 0xffffff;
}
const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((n, b) => safe(n + b.length), 0));
  let p = 0;
  for (const part of parts) {
    result.set(part, p);
    p += part.length;
  }
  return result;
};
function encodedBox(type: string, body: Uint8Array) {
  const b = new Uint8Array(body.length + 8);
  view(b).setUint32(0, b.length);
  for (let n = 0; n < 4; n++) b[4 + n] = type.charCodeAt(n);
  b.set(body, 8);
  return b;
}
function sampleFlags(value: number) {
  if (value >>> 28 || [26, 24, 22, 20].some((s) => ((value >>> s) & 3) === 3))
    fail("unsupported_sample_flags");
}
const sync = (value: number) =>
  !(value & 0x10000) && ((value >>> 24) & 3) !== 1;

export interface FragmentedPlaybackProof {
  compatible: boolean;
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string | null;
  audioChannels?: number;
  fragmented?: {
    basis: string;
    fragmentCount: number;
    sampleCount: number;
    sampleRangesVerified: boolean;
    timelinesVerified: boolean;
    randomAccessIndex?: { basis: string; entries: number };
    tracks: {
      id: number;
      type: "video" | "audio";
      timescale: number;
      sampleCount: number;
      decodeStartSeconds: number;
      decodeEndSeconds: number;
      presentationStartSeconds: number;
      presentationEndSeconds: number;
    }[];
  };
}
export interface FragmentedPlaybackTrack {
  id: number;
  type: "video" | "audio";
  timescale: number;
  defaultDuration: number;
  defaultSize: number;
  defaultFlags: number;
}
export interface FragmentedPlaybackFragment {
  index: number;
  offset: number;
  length: number;
  startSeconds: number;
  endSeconds: number;
  // Raw tfra PTS ticks, separately bound to each track's mdhd timescale.
  trackTimes: { trackId: number; ticks: number; traf: number }[];
}
export interface FragmentedPlaybackPlan {
  init: Uint8Array;
  initEnd: number;
  totalBytes: number;
  mimeType: string;
  durationSeconds: number;
  videoTrackId: number;
  audioTrackId: number | null;
  tracks: FragmentedPlaybackTrack[];
  fragments: FragmentedPlaybackFragment[];
  indexBasis: "global-traf-order" | "track-id-compatibility";
}

export function readFragmentedFooter(footer: Uint8Array, totalBytes: number) {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 16 ||
    footer.length !== 16 ||
    u32(footer, 0) !== 16 ||
    text(footer, 4) !== "mfro" ||
    u32(footer, 8) !== 0
  )
    fail("fragment_index_footer_missing");
  const length = u32(footer, 12);
  if (
    length < 24 ||
    length > SOURCE_FRAGMENTED_LIMITS.indexBytes ||
    length >= totalBytes
  )
    fail("fragment_index_size_limit");
  return { offset: totalBytes - length, length };
}

function avcCodec(b: Uint8Array, entry: Box) {
  if (!["avc1", "avc3"].includes(entry.type) || entry.end - entry.data < 78)
    fail("unsupported_video_sample_entry");
  const extensions = boxes(b, entry.data + 78, entry.end);
  if (
    extensions.some((x) =>
      ["sinf", "tenc", "dvcC", "dvvC", "mdcv", "clli"].includes(x.type),
    )
  )
    fail("unsupported_video_sample_entry");
  const config = one(extensions, "avcC"),
    c = b.subarray(config.data, config.end);
  if (
    c.length < 7 ||
    c[0] !== 1 ||
    ![66, 77, 100].includes(c[1]) ||
    c[3] > 51 ||
    (c[4] & 0xfc) !== 0xfc ||
    (c[4] & 3) === 2 ||
    (c[5] & 0xe0) !== 0xe0
  )
    fail("unsupported_avc_config");
  let p = 6;
  const sps = c[5] & 31;
  if (!sps) fail("missing_avc_parameter_sets");
  for (let n = 0; n < sps; n++) {
    const size = u16(c, p);
    p += 2;
    if (
      size < 4 ||
      p + size > c.length ||
      (c[p] & 31) !== 7 ||
      c[p + 1] !== c[1] ||
      c[p + 2] !== c[2] ||
      c[p + 3] !== c[3]
    )
      fail("unsupported_avc_config");
    p += size;
  }
  const pps = c[p++];
  if (!pps) fail("missing_avc_parameter_sets");
  for (let n = 0; n < pps; n++) {
    const size = u16(c, p);
    p += 2;
    if (size < 2 || p + size > c.length || (c[p] & 31) !== 8)
      fail("unsupported_avc_config");
    p += size;
  }
  if (p < c.length) {
    if (
      c[1] !== 100 ||
      c.length - p < 4 ||
      c[p] !== 0xfd ||
      c[p + 1] !== 0xf8 ||
      c[p + 2] !== 0xf8
    )
      fail("unsupported_avc_config");
    p += 3;
    const count = c[p++];
    for (let n = 0; n < count; n++) {
      const size = u16(c, p);
      p += 2;
      if (!size || p + size > c.length || (c[p] & 31) !== 13)
        fail("unsupported_avc_config");
      p += size;
    }
  }
  if (p !== c.length) fail("unsupported_avc_config");
  return `${entry.type}.${[c[1], c[2], c[3]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
function aacCodec(b: Uint8Array, entry: Box) {
  if (
    entry.type !== "mp4a" ||
    entry.end - entry.data < 28 ||
    u16(b, entry.data + 8) !== 0 ||
    u16(b, entry.data + 16) !== 2
  )
    fail("unsupported_audio_sample_entry");
  const extension = boxes(b, entry.data + 28, entry.end);
  if (extension.some((x) => x.type === "sinf")) fail("encrypted_audio");
  const esds = one(extension, "esds");
  full(b, esds, [0]);
  const descriptor = (p: number, end: number, tag: number) => {
    if (p >= end || b[p++] !== tag) fail("invalid_audio_descriptor");
    let size = 0,
      count = 0,
      next: number;
    do {
      if (p >= end || ++count > 4) fail("invalid_audio_descriptor");
      next = b[p++];
      size = size * 128 + (next & 127);
    } while (next & 128);
    if (p + size > end) fail("invalid_audio_descriptor");
    return { start: p, end: p + size };
  };
  const es = descriptor(esds.data + 4, esds.end, 3);
  if (es.end - es.start < 3 || b[es.start + 2] !== 0)
    fail("unsupported_audio_descriptor");
  const decoder = descriptor(es.start + 3, es.end, 4);
  if (
    decoder.end - decoder.start < 13 ||
    b[decoder.start] !== 0x40 ||
    b[decoder.start + 1] >> 2 !== 5
  )
    fail("unsupported_audio_descriptor");
  const asc = descriptor(decoder.start + 13, decoder.end, 5),
    c = b.subarray(asc.start, asc.end);
  if (
    c.length < 2 ||
    c.length > 16 ||
    c[0] >> 3 !== 2 ||
    (((c[0] & 7) << 1) | (c[1] >> 7)) > 12 ||
    ((c[1] >> 3) & 15) !== 2 ||
    c[1] & 7 ||
    c.subarray(2).some((v) => v !== 0)
  )
    fail("unsupported_aac_config");
  return "mp4a.40.2";
}

function parseInit(prefix: Uint8Array, proof: FragmentedPlaybackProof) {
  if (prefix.length > SOURCE_FRAGMENTED_LIMITS.initBytes)
    fail("init_size_limit");
  const ftyp = at(prefix, 0),
    moov = at(prefix, ftyp.end);
  if (
    ftyp.type !== "ftyp" ||
    moov.type !== "moov" ||
    moov.end > SOURCE_FRAGMENTED_LIMITS.initBytes
  )
    fail("unsupported_init_layout");
  if (ftyp.end - ftyp.data < 8 || (ftyp.end - ftyp.data) % 4)
    fail("invalid_ftyp");
  const movie = boxes(prefix, moov.data, moov.end);
  if (movie.some((x) => ["pssh", "sinf", "tenc"].includes(x.type)))
    fail("encrypted_init");
  const mvhd = one(movie, "mvhd");
  full(prefix, mvhd, [0, 1]);
  if (
    mvhd.end - mvhd.data !== (prefix[mvhd.data] === 1 ? 112 : 100) ||
    !u32(prefix, mvhd.data + (prefix[mvhd.data] === 1 ? 20 : 12))
  )
    fail("invalid_movie_header");
  const mvex = one(movie, "mvex"),
    defaults = new Map<number, FragmentedPlaybackTrack>();
  for (const trex of boxes(prefix, mvex.data, mvex.end)) {
    if (trex.type === "mehd") {
      full(prefix, trex, [0, 1]);
      continue;
    }
    if (trex.type !== "trex") fail("unsupported_mvex");
    full(prefix, trex, [0]);
    if (trex.end - trex.data !== 24 || u32(prefix, trex.data + 8) !== 1)
      fail("invalid_trex");
    const id = u32(prefix, trex.data + 4);
    if (!id || defaults.has(id)) fail("duplicate_track");
    const flags = u32(prefix, trex.data + 20);
    sampleFlags(flags);
    defaults.set(id, {
      id,
      type: "video",
      timescale: 0,
      defaultDuration: u32(prefix, trex.data + 12),
      defaultSize: u32(prefix, trex.data + 16),
      defaultFlags: flags,
    });
  }
  const tracks: FragmentedPlaybackTrack[] = [],
    codecs: string[] = [];
  for (const trak of movie.filter((x) => x.type === "trak")) {
    const children = boxes(prefix, trak.data, trak.end),
      tkhd = one(children, "tkhd");
    full(prefix, tkhd, [0, 1], 7);
    if (tkhd.end - tkhd.data !== (prefix[tkhd.data] === 1 ? 96 : 84))
      fail("invalid_track_header");
    const id = u32(prefix, tkhd.data + (prefix[tkhd.data] === 1 ? 20 : 12));
    const inherited = defaults.get(id);
    if (!inherited || tracks.some((t) => t.id === id))
      fail("unknown_or_duplicate_track");
    for (const edts of children.filter((x) => x.type === "edts")) {
      const elst = one(boxes(prefix, edts.data, edts.end), "elst");
      full(prefix, elst, [0]);
      if (
        elst.end - elst.data !== 20 ||
        u32(prefix, elst.data + 4) !== 1 ||
        u32(prefix, elst.data + 8) !== 0 ||
        i32(prefix, elst.data + 12) !== 0 ||
        u32(prefix, elst.data + 16) !== 65536
      )
        fail("unsupported_edit_mapping");
    }
    const mdia = one(children, "mdia"),
      media = boxes(prefix, mdia.data, mdia.end);
    const mdhd = one(media, "mdhd");
    full(prefix, mdhd, [0, 1]);
    if (mdhd.end - mdhd.data !== (prefix[mdhd.data] === 1 ? 36 : 24))
      fail("invalid_media_header");
    const timescale = u32(
      prefix,
      mdhd.data + (prefix[mdhd.data] === 1 ? 20 : 12),
    );
    if (!timescale) fail("invalid_timescale");
    const handler = one(media, "hdlr");
    full(prefix, handler, [0]);
    const kind = text(prefix, handler.data + 8);
    if (!["vide", "soun"].includes(kind)) fail("unsupported_track");
    const type = kind === "vide" ? "video" : "audio";
    if (tracks.some((t) => t.type === type)) fail("duplicate_track_type");
    const minf = one(media, "minf"),
      info = boxes(prefix, minf.data, minf.end);
    const dinf = one(info, "dinf"),
      dref = one(boxes(prefix, dinf.data, dinf.end), "dref");
    full(prefix, dref, [0]);
    const references = boxes(prefix, dref.data + 8, dref.end);
    if (
      u32(prefix, dref.data + 4) !== 1 ||
      references.length !== 1 ||
      references[0].type !== "url " ||
      references[0].end - references[0].data !== 4 ||
      u32(prefix, references[0].data) !== 1
    )
      fail("external_data_reference");
    const stbl = one(info, "stbl"),
      tables = boxes(prefix, stbl.data, stbl.end);
    if (
      tables.some(
        (item) =>
          ![
            "stsd",
            "stts",
            "stsc",
            "stsz",
            "stco",
            "co64",
            "stss",
            "ctts",
          ].includes(item.type),
      )
    )
      fail("unsupported_init_sample_table");
    const offsets = tables.filter((item) =>
      ["stco", "co64"].includes(item.type),
    );
    if (offsets.length !== 1) fail("invalid_init_chunk_table");
    for (const name of ["stts", "stsc", offsets[0].type]) {
      const empty = one(tables, name);
      full(prefix, empty, [0]);
      if (empty.end - empty.data !== 8 || u32(prefix, empty.data + 4))
        fail("nonempty_init_samples");
    }
    for (const optional of tables.filter((item) =>
      ["stss", "ctts"].includes(item.type),
    )) {
      full(prefix, optional, [0, 1]);
      if (optional.end - optional.data !== 8 || u32(prefix, optional.data + 4))
        fail("nonempty_init_samples");
    }
    const stsz = one(tables, "stsz");
    full(prefix, stsz, [0]);
    if (
      stsz.end - stsz.data !== 12 ||
      u32(prefix, stsz.data + 4) ||
      u32(prefix, stsz.data + 8)
    )
      fail("nonempty_init_samples");
    const stsd = one(tables, "stsd");
    full(prefix, stsd, [0]);
    const entries = boxes(prefix, stsd.data + 8, stsd.end);
    if (
      u32(prefix, stsd.data + 4) !== 1 ||
      entries.length !== 1 ||
      u16(prefix, entries[0].data + 6) !== 1
    )
      fail("unsupported_sample_description");
    const entry = entries[0],
      codec =
        type === "video" ? avcCodec(prefix, entry) : aacCodec(prefix, entry);
    if (
      type === "video" &&
      (proof.videoCodec !== entry.type ||
        u16(prefix, entry.data + 24) !== proof.width ||
        u16(prefix, entry.data + 26) !== proof.height)
    )
      fail("init_proof_mismatch");
    if (
      type === "audio" &&
      (proof.audioCodec !== codec || proof.audioChannels !== 2)
    )
      fail("init_proof_mismatch");
    const verified = proof.fragmented!.tracks.find(
      (t) => t.id === id && t.type === type,
    );
    if (!verified || verified.timescale !== timescale)
      fail("init_proof_mismatch");
    tracks.push({ ...inherited, type, timescale });
    codecs.push(codec);
  }
  const video = tracks.find((t) => t.type === "video"),
    audio = tracks.find((t) => t.type === "audio");
  if (
    !video ||
    tracks.length !== defaults.size ||
    tracks.length !== proof.fragmented!.tracks.length ||
    !!audio !== !!proof.audioCodec ||
    tracks.length > 2
  )
    fail("init_proof_mismatch");
  return {
    init: prefix.slice(0, moov.end),
    initEnd: moov.end,
    tracks,
    videoTrackId: video.id,
    audioTrackId: audio?.id ?? null,
    mimeType: `video/mp4; codecs="${codecs.join(",")}"`,
  };
}

export function parseFragmentedPlaybackPlan({
  prefix,
  mfra,
  totalBytes,
  proof,
}: {
  prefix: Uint8Array;
  mfra: Uint8Array;
  totalBytes: number;
  proof: FragmentedPlaybackProof;
}): FragmentedPlaybackPlan {
  const summary = proof.fragmented,
    duration = proof.durationSeconds;
  if (
    !proof.compatible ||
    !summary ||
    summary.basis !== "bounded-fragment-sample-tables" ||
    summary.sampleRangesVerified !== true ||
    summary.timelinesVerified !== true ||
    !Number.isFinite(duration) ||
    Number(duration) <= 0 ||
    !Number.isSafeInteger(summary.fragmentCount) ||
    summary.fragmentCount < 1 ||
    summary.fragmentCount > SOURCE_FRAGMENTED_LIMITS.fragments ||
    !Array.isArray(summary.tracks) ||
    summary.tracks.length < 1 ||
    summary.tracks.length > 2 ||
    !summary.randomAccessIndex ||
    !["global-traf-order", "track-id-compatibility"].includes(
      summary.randomAccessIndex.basis,
    ) ||
    summary.randomAccessIndex.entries !==
      summary.fragmentCount * summary.tracks.length
  )
    fail("complete_index_proof_required");
  if (
    !Number.isSafeInteger(proof.width) ||
    Number(proof.width) < 1 ||
    Number(proof.width) > 8192 ||
    !Number.isSafeInteger(proof.height) ||
    Number(proof.height) < 1 ||
    Number(proof.height) > 8192 ||
    !Number.isSafeInteger(summary.sampleCount) ||
    summary.sampleCount < 1 ||
    summary.sampleCount > 1000000 ||
    summary.tracks.some(
      (track) =>
        !track ||
        !Number.isSafeInteger(track.id) ||
        track.id <= 0 ||
        !["video", "audio"].includes(track.type) ||
        !Number.isSafeInteger(track.timescale) ||
        track.timescale < 1 ||
        track.timescale > 0xffffffff ||
        !Number.isSafeInteger(track.sampleCount) ||
        track.sampleCount < 1 ||
        track.sampleCount > 1000000 ||
        ![
          track.decodeStartSeconds,
          track.decodeEndSeconds,
          track.presentationStartSeconds,
          track.presentationEndSeconds,
        ].every(Number.isFinite) ||
        track.decodeStartSeconds !== 0 ||
        track.decodeEndSeconds <= 0 ||
        track.presentationStartSeconds < 0 ||
        track.presentationEndSeconds <= track.presentationStartSeconds,
    ) ||
    new Set(summary.tracks.map((track) => track.id)).size !==
      summary.tracks.length ||
    new Set(summary.tracks.map((track) => track.type)).size !==
      summary.tracks.length ||
    summary.tracks.filter((track) => track.type === "video").length !== 1 ||
    summary.tracks.reduce((total, track) => total + track.sampleCount, 0) !==
      summary.sampleCount ||
    (summary.randomAccessIndex.basis === "track-id-compatibility" &&
      summary.tracks.length !== 2)
  )
    fail("invalid_fragment_proof_summary");
  const init = parseInit(prefix, proof);
  const footer = readFragmentedFooter(
    mfra.subarray(mfra.length - 16),
    totalBytes,
  );
  if (mfra.length !== footer.length) fail("fragment_index_length_mismatch");
  const top = at(mfra, 0);
  if (top.type !== "mfra" || top.end !== mfra.length)
    fail("invalid_fragment_index");
  const children = boxes(mfra, top.data, top.end),
    mfro = one(children, "mfro");
  if (
    children.some((x) => !["tfra", "mfro"].includes(x.type)) ||
    children.at(-1) !== mfro ||
    mfro.start !== mfra.length - 16 ||
    mfro.end - mfro.data !== 8
  )
    fail("invalid_fragment_index");
  full(mfra, mfro, [0]);
  const tables = new Map<
    number,
    { ticks: number; offset: number; traf: number }[]
  >();
  for (const tfra of children.filter((x) => x.type === "tfra")) {
    full(mfra, tfra, [0, 1]);
    const id = u32(mfra, tfra.data + 4),
      track = init.tracks.find((t) => t.id === id),
      lengths = u32(mfra, tfra.data + 8);
    if (
      !track ||
      tables.has(id) ||
      lengths >>> 6 ||
      u32(mfra, tfra.data + 12) !== summary.fragmentCount
    )
      fail("incomplete_fragment_index");
    const width = mfra[tfra.data] === 1 ? 8 : 4,
      entries: { ticks: number; offset: number; traf: number }[] = [];
    let p = tfra.data + 16;
    const integer = () => {
      const n = width === 8 ? u64(mfra, p) : u32(mfra, p);
      p += width;
      return n;
    };
    const ordinal = (shift: number) => {
      let n = 0;
      for (let j = 0; j < ((lengths >>> shift) & 3) + 1; j++) {
        if (p >= tfra.end) fail("truncated_fragment_index");
        n = n * 256 + mfra[p++];
      }
      return n;
    };
    for (let n = 0; n < summary.fragmentCount; n++) {
      const ticks = integer(),
        offset = integer(),
        traf = ordinal(4),
        trun = ordinal(2),
        sample = ordinal(0);
      if (
        offset < init.initEnd ||
        offset > footer.offset - 16 ||
        !traf ||
        trun !== 1 ||
        sample !== 1 ||
        (n &&
          (ticks <= entries[n - 1].ticks || offset <= entries[n - 1].offset))
      )
        fail("invalid_fragment_index_entry");
      if (
        summary.randomAccessIndex.basis === "track-id-compatibility"
          ? traf !== 1
          : traf !== init.tracks.indexOf(track) + 1
      )
        fail("unsupported_fragment_index_mapping");
      entries.push({ ticks, offset, traf });
    }
    if (p !== tfra.end) fail("invalid_fragment_index_length");
    tables.set(id, entries);
  }
  if (tables.size !== init.tracks.length) fail("incomplete_fragment_index");
  const video = init.tracks.find((t) => t.id === init.videoTrackId)!,
    entries = tables.get(video.id)!;
  const fragments = entries.map((entry, index) => {
    const nextOffset = entries[index + 1]?.offset ?? footer.offset;
    const length = safe(nextOffset - entry.offset),
      startSeconds = entry.ticks / video.timescale;
    const endSeconds = entries[index + 1]
      ? entries[index + 1].ticks / video.timescale
      : Number(duration);
    if (
      (index === 0 && entry.offset !== init.initEnd) ||
      length < 16 ||
      length > SOURCE_FRAGMENTED_LIMITS.fragmentBytes ||
      startSeconds < 0 ||
      startSeconds >= Number(duration) ||
      endSeconds <= startSeconds ||
      (index === 0 && startSeconds > 0.25)
    )
      fail("unsupported_fragment_extent");
    const trackTimes = init.tracks.map((track) => {
      const indexed = tables.get(track.id)![index];
      if (
        indexed.offset !== entry.offset ||
        Math.abs(indexed.ticks / track.timescale - startSeconds) > 0.25
      )
        fail("unsupported_fragment_track_alignment");
      return { trackId: track.id, ticks: indexed.ticks, traf: indexed.traf };
    });
    return {
      index,
      offset: entry.offset,
      length,
      startSeconds,
      endSeconds,
      trackTimes,
    };
  });
  return {
    ...init,
    totalBytes,
    durationSeconds: Number(duration),
    fragments,
    indexBasis: summary.randomAccessIndex
      .basis as FragmentedPlaybackPlan["indexBasis"],
  };
}

// Normalize only headers. MSE requires each first trun's offset to be relative
// to its moof; Chromium rejects tfhd base-data-offset-present outright.
export function normalizeFragmentedMedia(
  bytes: Uint8Array,
  fragment: FragmentedPlaybackFragment,
  plan: FragmentedPlaybackPlan,
): Uint8Array {
  const registered = plan.fragments[fragment.index];
  if (
    !registered ||
    registered !== fragment ||
    bytes.length !== fragment.length ||
    bytes.length > SOURCE_FRAGMENTED_LIMITS.fragmentBytes
  )
    fail("fragment_range_mismatch");
  const top = boxes(bytes),
    moof = top[0];
  if (
    !moof ||
    moof.type !== "moof" ||
    top.length < 2 ||
    top.slice(1).some((x) => x.type !== "mdat")
  )
    fail("unsupported_fragment_layout");
  const contents = boxes(bytes, moof.data, moof.end),
    mfhd = one(contents, "mfhd");
  full(bytes, mfhd, [0]);
  if (
    mfhd.end - mfhd.data !== 8 ||
    u32(bytes, mfhd.data + 4) !== fragment.index + 1 ||
    contents.some((x) => !["mfhd", "traf"].includes(x.type))
  )
    fail("unsupported_fragment_sequence");
  const trafs = contents.filter((x) => x.type === "traf");
  if (trafs.length !== plan.tracks.length) fail("fragment_track_mismatch");
  const headers = trafs.map((traf) =>
    one(boxes(bytes, traf.data, traf.end), "tfhd"),
  );
  const removed = headers.reduce(
    (n, tfhd) => n + (full(bytes, tfhd, [0], 0x02003b) & 1 ? 8 : 0),
    0,
  );
  const intervals: { start: number; end: number }[] = [],
    seen = new Set<number>();
  let samples = 0;
  const transformed = new Map<number, Uint8Array>();
  for (let position = 0; position < trafs.length; position++) {
    const traf = trafs[position],
      items = boxes(bytes, traf.data, traf.end),
      tfhd = one(items, "tfhd"),
      tfdt = one(items, "tfdt");
    if (items.some((x) => !["tfhd", "tfdt", "trun"].includes(x.type)))
      fail("unsupported_fragment_box");
    const flags = full(bytes, tfhd, [0], 0x02003b),
      id = u32(bytes, tfhd.data + 4),
      track = plan.tracks.find((t) => t.id === id);
    if (!track || seen.has(id) || (flags & 1 && flags & 0x20000))
      fail("fragment_track_mismatch");
    seen.add(id);
    const indexed = fragment.trackTimes.find((t) => t.trackId === id);
    if (
      !indexed ||
      (plan.indexBasis === "global-traf-order" && indexed.traf !== position + 1)
    )
      fail("fragment_index_mismatch");
    let p = tfhd.data + 8;
    if (flags & 1) {
      if (u64(bytes, p) !== fragment.offset)
        fail("unsupported_fragment_addressing");
      p += 8;
    } else if (!(flags & 0x20000) && trafs.length !== 1)
      fail("unsupported_fragment_addressing");
    if (flags & 2) {
      if (u32(bytes, p) !== 1) fail("unsupported_sample_description");
      p += 4;
    }
    let defaultDuration = track.defaultDuration,
      defaultSize = track.defaultSize,
      defaultFlags = track.defaultFlags;
    if (flags & 8) {
      defaultDuration = u32(bytes, p);
      p += 4;
    }
    if (flags & 16) {
      defaultSize = u32(bytes, p);
      p += 4;
    }
    if (flags & 32) {
      defaultFlags = u32(bytes, p);
      p += 4;
    }
    sampleFlags(defaultFlags);
    if (p !== tfhd.end) fail("invalid_tfhd_length");
    const headerBody =
      flags & 1
        ? concat(
            bytes.slice(tfhd.data, tfhd.data + 8),
            bytes.slice(tfhd.data + 16, tfhd.end),
          )
        : bytes.slice(tfhd.data, tfhd.end);
    view(headerBody).setUint32(0, (flags & ~1) | 0x20000);
    transformed.set(tfhd.start, encodedBox("tfhd", headerBody));
    full(bytes, tfdt, [0, 1]);
    const wide = bytes[tfdt.data] === 1;
    if (tfdt.end - tfdt.data !== (wide ? 12 : 8)) fail("invalid_tfdt_length");
    let dts = wide ? u64(bytes, tfdt.data + 4) : u32(bytes, tfdt.data + 4),
      previousEnd: number | null = null;
    const runs = items.filter((x) => x.type === "trun");
    if (!runs.length || runs.length > 64) fail("fragment_run_limit");
    for (let runIndex = 0; runIndex < runs.length; runIndex++) {
      const run = runs[runIndex],
        flags = full(bytes, run, [0, 1], 0xf05),
        count = u32(bytes, run.data + 4);
      if (
        !count ||
        (samples += count) > SOURCE_FRAGMENTED_LIMITS.samplesPerFragment ||
        (flags & 4 && flags & 0x400)
      )
        fail("invalid_fragment_samples");
      let p = run.data + 8;
      let offset: number;
      const explicit = !!(flags & 1);
      if (explicit) {
        offset = i32(bytes, p);
        p += 4;
      } else {
        if (previousEnd === null) fail("fragment_data_offset_required");
        offset = previousEnd;
      }
      let firstFlags = defaultFlags;
      if (flags & 4) {
        firstFlags = u32(bytes, p);
        p += 4;
        sampleFlags(firstFlags);
      }
      const stride =
        [0x100, 0x200, 0x400, 0x800].filter((mask) => flags & mask).length * 4;
      if (p + count * stride !== run.end) fail("invalid_trun_length");
      const start = offset;
      for (let n = 0; n < count; n++) {
        let duration = defaultDuration,
          size = defaultSize,
          sampleFlag = n === 0 ? firstFlags : defaultFlags;
        if (flags & 0x100) {
          duration = u32(bytes, p);
          p += 4;
        }
        if (flags & 0x200) {
          size = u32(bytes, p);
          p += 4;
        }
        if (flags & 0x400) {
          sampleFlag = u32(bytes, p);
          p += 4;
        }
        let cts = 0;
        if (flags & 0x800) {
          cts = bytes[run.data] === 1 ? i32(bytes, p) : u32(bytes, p);
          p += 4;
        }
        sampleFlags(sampleFlag);
        if (!duration || !size || Math.abs(cts) > track.timescale * 2)
          fail("invalid_fragment_sample");
        if (
          !runIndex &&
          !n &&
          (safe(dts + cts) !== indexed.ticks || !sync(sampleFlag))
        )
          fail("fragment_random_access_mismatch");
        dts = safe(dts + duration);
        offset = safe(offset + size);
      }
      if (
        !top.slice(1).some((mdat) => start >= mdat.data && offset <= mdat.end)
      )
        fail("fragment_sample_outside_mdat");
      intervals.push({ start, end: offset });
      previousEnd = offset;
      if (explicit) {
        const body = bytes.slice(run.data, run.end),
          adjusted = start - removed;
        if (adjusted < 0 || adjusted > 0x7fffffff)
          fail("fragment_offset_overflow");
        view(body).setInt32(8, adjusted);
        transformed.set(run.start, encodedBox("trun", body));
      }
    }
    transformed.set(
      traf.start,
      encodedBox(
        "traf",
        concat(
          ...items.map(
            (item) =>
              transformed.get(item.start) ?? bytes.slice(item.start, item.end),
          ),
        ),
      ),
    );
  }
  intervals.sort((a, b) => a.start - b.start);
  if (
    intervals.some(
      (item, index) => index > 0 && item.start < intervals[index - 1].end,
    )
  )
    fail("overlapping_fragment_samples");
  const outputMoof = encodedBox(
    "moof",
    concat(
      ...contents.map(
        (item) =>
          transformed.get(item.start) ?? bytes.slice(item.start, item.end),
      ),
    ),
  );
  if (outputMoof.length !== moof.end - removed)
    fail("fragment_relocation_mismatch");
  // All mdat headers, padding and sample bytes are copied verbatim, in order.
  return concat(outputMoof, bytes.subarray(moof.end));
}
