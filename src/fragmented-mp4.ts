// Metadata and sample-table proof only. Sample payload bytes are never decoded.
export interface FragmentedMp4Summary {
  basis: "bounded-fragment-sample-tables";
  fragmentCount: number;
  sampleCount: number;
  sampleRangesVerified: true;
  timelinesVerified: true;
  randomAccessIndex?: {
    basis: "global-traf-order" | "track-id-compatibility";
    entries: number;
  };
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
}
export interface FragmentTrack {
  id: number;
  type: "video" | "audio";
  timescale: number;
  initialDurationSeconds: number;
  editMediaTime: number;
  editDurationSeconds: number;
}
export interface FragmentBox {
  type: string;
  start: number;
  data: number;
  end: number;
}
export class FragmentInspectionError extends Error {}
function fail(code: string): never {
  throw new FragmentInspectionError(code);
}
const view = (b: Uint8Array) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength);
const u32 = (b: Uint8Array, at: number) => {
  if (at < 0 || at + 4 > b.length) fail("truncated_fragment_metadata");
  return view(b).getUint32(at);
};
const i32 = (b: Uint8Array, at: number) => {
  if (at < 0 || at + 4 > b.length) fail("truncated_fragment_metadata");
  return view(b).getInt32(at);
};
const u64 = (b: Uint8Array, at: number) =>
  safe(u32(b, at) * 2 ** 32 + u32(b, at + 4));
const safe = (n: number) => {
  if (!Number.isSafeInteger(n)) fail("unsafe_fragment_integer");
  return n;
};
const type = (b: Uint8Array, at: number) =>
  String.fromCharCode(...b.subarray(at, at + 4));
function boxes(b: Uint8Array, start = 0, end = b.length): FragmentBox[] {
  const found: FragmentBox[] = [];
  while (start < end) {
    if (end - start < 8 || found.length >= 128) fail("fragment_box_limit");
    const small = u32(b, start),
      header = small === 1 ? 16 : 8;
    const size = small === 1 ? u64(b, start + 8) : small || end - start;
    if (size < header || safe(start + size) > end) fail("invalid_fragment_box");
    found.push({
      type: type(b, start + 4),
      start,
      data: start + header,
      end: start + size,
    });
    start += size;
  }
  return found;
}
function one(list: FragmentBox[], name: string): FragmentBox {
  const selected = list.filter((box) => box.type === name);
  if (selected.length !== 1) fail("missing_or_duplicate_" + name);
  return selected[0];
}
function full(
  b: Uint8Array,
  box: FragmentBox,
  versions: number[],
  flags: number,
): number {
  const word = u32(b, box.data);
  if (!versions.includes(word >>> 24) || word & 0xffffff & ~flags)
    fail("unsupported_fragment_flags_or_version");
  return word & 0xffffff;
}
function sampleFlags(flags: number) {
  // Reserved bits and reserved value 3 in the ISO sample dependency fields.
  if (
    flags >>> 28 ||
    [26, 24, 22, 20].some((shift) => ((flags >>> shift) & 3) === 3)
  )
    fail("unsupported_sample_flags");
}
const isSync = (flags: number) =>
  !(flags & 0x10000) && ((flags >>> 24) & 3) !== 1;
interface Defaults {
  duration: number;
  size: number;
  flags: number;
}
interface State extends FragmentTrack {
  samples: number;
  decodeStart: number | null;
  decodeEnd: number | null;
  presentationStart: number | null;
  presentationEnd: number | null;
  visibleEnd: number | null;
  pending: { start: number; end: number }[];
}
function flushTimeline(state: State, through: number) {
  state.pending.sort((a, b) => a.start - b.start);
  let count = 0;
  for (const interval of state.pending) {
    if (interval.end > through) break;
    if (state.visibleEnd !== null && interval.start !== state.visibleEnd)
      fail("fragment_presentation_discontinuity");
    state.visibleEnd = interval.end;
    count++;
  }
  state.pending.splice(0, count);
  if (state.pending.length > 65536) fail("fragment_reordering_limit");
}

export function inspectFragments(input: {
  top: FragmentBox[];
  moofs: Map<number, Uint8Array>;
  mvex: Uint8Array;
  tracks: FragmentTrack[];
  movieDurationSeconds: number;
  movieTimescale: number;
  // Optional trailing random-access index, separately bounded by the caller.
  mfra?: Uint8Array;
}): { durationSeconds: number; summary: FragmentedMp4Summary } {
  const defaults = new Map<number, Defaults>();
  let declaredDuration: number | null = null;
  for (const box of boxes(input.mvex)) {
    if (box.type === "trex") {
      full(input.mvex, box, [0], 0);
      if (box.end - box.data !== 24) fail("invalid_trex");
      const id = u32(input.mvex, box.data + 4);
      if (
        !input.tracks.some((track) => track.id === id) ||
        defaults.has(id) ||
        u32(input.mvex, box.data + 8) !== 1
      )
        fail("unsupported_fragment_description");
      const flags = u32(input.mvex, box.data + 20);
      sampleFlags(flags);
      defaults.set(id, {
        duration: u32(input.mvex, box.data + 12),
        size: u32(input.mvex, box.data + 16),
        flags,
      });
    } else if (box.type === "mehd") {
      full(input.mvex, box, [0, 1], 0);
      const version = input.mvex[box.data];
      if (box.end - box.data !== (version ? 12 : 8)) fail("invalid_mehd");
      if (declaredDuration !== null) fail("invalid_mehd");
      declaredDuration =
        (version
          ? u64(input.mvex, box.data + 4)
          : u32(input.mvex, box.data + 4)) / input.movieTimescale;
    } else fail("unsupported_fragment_init");
  }
  if (defaults.size !== input.tracks.length) fail("missing_fragment_defaults");
  const states = new Map<number, State>(
    input.tracks.map((track) => [
      track.id,
      {
        ...track,
        samples: 0,
        decodeStart: null,
        decodeEnd: null,
        presentationStart: null,
        presentationEnd: null,
        visibleEnd: null,
        pending: [],
      },
    ]),
  );
  let fragmentCount = 0,
    sampleCount = 0,
    previousSequence = 0;
  const access = new Map<
    number,
    Map<number, { time: number; sync: boolean; traf: number; trun: number }>
  >();
  const allowed = new Set([
    "ftyp",
    "moov",
    "moof",
    "mdat",
    "free",
    "skip",
    "mfra",
  ]);
  if (input.top.some((box) => !allowed.has(box.type)))
    fail("unsupported_fragment_top_box");
  const firstMoof = input.top.findIndex((box) => box.type === "moof");
  if (
    firstMoof < 0 ||
    input.top.slice(0, firstMoof).some((box) => box.type === "mdat") ||
    input.top.findIndex((box) => box.type === "moov") > firstMoof
  )
    fail("invalid_fragment_order");
  if (
    input.top.filter((box) => box.type === "mfra").length > 1 ||
    input.top.some(
      (box, i) => box.type === "mfra" && i !== input.top.length - 1,
    )
  )
    fail("unsupported_fragment_index");
  for (let index = firstMoof; index < input.top.length; index++) {
    const moof = input.top[index];
    if (moof.type !== "moof") continue;
    if (++fragmentCount > 1024) fail("fragment_count_limit");
    const b = input.moofs.get(moof.start);
    if (!b || b.length !== moof.end - moof.data)
      fail("truncated_fragment_metadata");
    const children = boxes(b);
    if (children.some((box) => !["mfhd", "traf"].includes(box.type)))
      fail("unsupported_fragment_box");
    const mfhd = one(children, "mfhd");
    full(b, mfhd, [0], 0);
    if (
      mfhd.end - mfhd.data !== 8 ||
      u32(b, mfhd.data + 4) !== previousSequence + 1
    )
      fail("fragment_sequence_discontinuity");
    previousSequence++;
    const trafs = children.filter((box) => box.type === "traf");
    if (!trafs.length || trafs.length > input.tracks.length)
      fail("unsupported_fragment_track_count");
    const mdats: FragmentBox[] = [];
    for (
      let n = index + 1;
      n < input.top.length && !["moof", "mfra"].includes(input.top[n].type);
      n++
    ) {
      if (input.top[n].type === "mdat") mdats.push(input.top[n]);
      else if (!["free", "skip"].includes(input.top[n].type))
        fail("invalid_fragment_order");
    }
    if (!mdats.length || mdats.some((box) => box.data === box.end))
      fail("fragment_mdat_required");
    const extents: { start: number; end: number }[] = [];
    const seen = new Set<number>();
    const fragmentAccess = new Map<
      number,
      { time: number; sync: boolean; traf: number; trun: number }
    >();
    let fragmentSamples = 0;
    for (let trafIndex = 0; trafIndex < trafs.length; trafIndex++) {
      const traf = trafs[trafIndex],
        contents = boxes(b, traf.data, traf.end);
      if (
        contents.some((box) =>
          ["senc", "saiz", "saio", "sgpd", "sbgp", "sinf", "tenc"].includes(
            box.type,
          ),
        )
      )
        fail("encrypted_or_grouped_fragment_samples");
      if (contents.some((box) => !["tfhd", "tfdt", "trun"].includes(box.type)))
        fail("unsupported_fragment_box");
      const tfhd = one(contents, "tfhd"),
        tfdt = one(contents, "tfdt");
      const flags = full(b, tfhd, [0], 0x03003b);
      if (flags & 0x10000) fail("empty_fragment_track");
      const id = u32(b, tfhd.data + 4),
        state = states.get(id),
        inherited = defaults.get(id);
      if (!state || !inherited || seen.has(id))
        fail("unknown_or_duplicate_fragment_track");
      seen.add(id);
      let at = tfhd.data + 8,
        base = moof.start;
      if (flags & 1 && flags & 0x20000) fail("unsupported_fragment_addressing");
      if (flags & 1) {
        base = u64(b, at);
        at += 8;
      } else if (!(flags & 0x20000) && trafs.length !== 1)
        fail("unsupported_fragment_addressing");
      if (flags & 2) {
        if (u32(b, at) !== 1) fail("unsupported_fragment_description");
        at += 4;
      }
      const d = { ...inherited };
      if (flags & 8) {
        d.duration = u32(b, at);
        at += 4;
      }
      if (flags & 16) {
        d.size = u32(b, at);
        at += 4;
      }
      if (flags & 32) {
        d.flags = u32(b, at);
        at += 4;
        sampleFlags(d.flags);
      }
      if (at !== tfhd.end) fail("invalid_tfhd");
      full(b, tfdt, [0, 1], 0);
      const version = b[tfdt.data];
      if (tfdt.end - tfdt.data !== (version ? 12 : 8)) fail("invalid_tfdt");
      let dts = version ? u64(b, tfdt.data + 4) : u32(b, tfdt.data + 4);
      if (
        (state.decodeEnd !== null && dts !== state.decodeEnd) ||
        (state.decodeStart === null && dts !== 0)
      )
        fail("fragment_decode_discontinuity");
      state.decodeStart ??= dts;
      const runs = contents.filter((box) => box.type === "trun");
      if (!runs.length || runs.length > 64) fail("fragment_run_limit");
      let previousEnd: number | null = null;
      for (let runIndex = 0; runIndex < runs.length; runIndex++) {
        const run = runs[runIndex],
          f = full(b, run, [0, 1], 0xf05);
        if (f & 4 && f & 0x400) fail("conflicting_fragment_sample_flags");
        const count = u32(b, run.data + 4);
        if (
          !count ||
          count > 16384 ||
          (fragmentSamples += count) > 16384 ||
          (sampleCount += count) > 1000000
        )
          fail("fragment_sample_limit");
        let p = run.data + 8,
          offset: number;
        if (f & 1) {
          offset = safe(base + i32(b, p));
          p += 4;
        } else {
          if (previousEnd === null) fail("fragment_data_offset_required");
          offset = previousEnd;
        }
        const start = offset;
        let firstFlags = d.flags;
        if (f & 4) {
          firstFlags = u32(b, p);
          p += 4;
          sampleFlags(firstFlags);
        }
        const stride =
          (f & 0x100 ? 4 : 0) +
          (f & 0x200 ? 4 : 0) +
          (f & 0x400 ? 4 : 0) +
          (f & 0x800 ? 4 : 0);
        if (p + stride * count !== run.end) fail("invalid_trun");
        for (let n = 0; n < count; n++) {
          let duration = d.duration,
            bytes = d.size,
            sf = n === 0 ? firstFlags : d.flags,
            cts = 0;
          if (f & 0x100) {
            duration = u32(b, p);
            p += 4;
          }
          if (f & 0x200) {
            bytes = u32(b, p);
            p += 4;
          }
          if (f & 0x400) {
            sf = u32(b, p);
            p += 4;
            sampleFlags(sf);
          }
          if (f & 0x800) {
            cts = b[run.data] ? i32(b, p) : u32(b, p);
            p += 4;
          }
          if (!duration || !bytes) fail("missing_fragment_sample_defaults");
          if (Math.abs(cts) > state.timescale * 2)
            fail("unsupported_composition_offset");
          if (!state.samples && state.type === "video" && !isSync(sf))
            fail("fragment_sync_sample_required");
          if (!fragmentAccess.has(id))
            fragmentAccess.set(id, {
              time: safe(dts + cts),
              sync: isSync(sf),
              traf: trafIndex + 1,
              trun: runIndex + 1,
            });
          const pts = safe(dts + cts - state.editMediaTime),
            end = safe(pts + duration);
          state.presentationStart = Math.min(
            state.presentationStart ?? pts,
            pts,
          );
          state.presentationEnd = Math.max(state.presentationEnd ?? end, end);
          state.pending.push({ start: pts, end });
          state.samples++;
          dts = safe(dts + duration);
          offset = safe(offset + bytes);
        }
        if (!mdats.some((mdat) => start >= mdat.data && offset <= mdat.end))
          fail("fragment_sample_outside_mdat");
        extents.push({ start, end: offset });
        previousEnd = offset;
      }
      state.decodeEnd = dts;
      // Future CTS may reorder by at most two seconds. Finalize only intervals
      // that no future sample may precede, keeping memory bounded for B frames.
      flushTimeline(state, dts - state.timescale * 2 - state.editMediaTime);
    }
    extents.sort((a, b) => a.start - b.start);
    if (extents.some((range, n) => n > 0 && range.start < extents[n - 1].end))
      fail("overlapping_fragment_samples");
    if (
      mdats.some(
        (mdat) =>
          !extents.some(
            (range) => range.start >= mdat.data && range.end <= mdat.end,
          ),
      )
    )
      fail("unreferenced_fragment_mdat");
    access.set(moof.start, fragmentAccess);
  }
  const summaryTracks: FragmentedMp4Summary["tracks"] = [];
  for (const state of states.values()) {
    if (
      !state.samples ||
      state.decodeStart === null ||
      state.decodeEnd === null ||
      state.presentationStart === null ||
      state.presentationEnd === null
    )
      fail("fragment_track_samples_required");
    flushTimeline(state, Infinity);
    const start = state.presentationStart / state.timescale,
      end = state.presentationEnd / state.timescale;
    if (
      Math.abs(start) > 0.25 ||
      end <= 0 ||
      (state.initialDurationSeconds > 0 &&
        Math.abs(state.initialDurationSeconds - end) > 0.25) ||
      (state.editDurationSeconds > 0 &&
        Math.abs(state.editDurationSeconds - end) > 0.25)
    )
      fail("fragment_duration_mismatch");
    summaryTracks.push({
      id: state.id,
      type: state.type,
      timescale: state.timescale,
      sampleCount: state.samples,
      decodeStartSeconds: state.decodeStart / state.timescale,
      decodeEndSeconds: state.decodeEnd / state.timescale,
      presentationStartSeconds: start,
      presentationEndSeconds: end,
    });
  }
  const video = summaryTracks.find((track) => track.type === "video")!;
  const audio = summaryTracks.find((track) => track.type === "audio");
  if (
    audio &&
    (Math.abs(video.presentationStartSeconds - audio.presentationStartSeconds) >
      0.25 ||
      Math.abs(video.presentationEndSeconds - audio.presentationEndSeconds) >
        0.25)
  )
    fail("fragment_audio_video_timeline_mismatch");
  const durationSeconds = Math.max(
    ...summaryTracks.map((track) => track.presentationEndSeconds),
  );
  if (
    (input.movieDurationSeconds > 0 &&
      Math.abs(input.movieDurationSeconds - durationSeconds) > 0.25) ||
    (declaredDuration !== null &&
      declaredDuration > 0 &&
      Math.abs(declaredDuration - durationSeconds) > 0.25)
  )
    fail("fragment_duration_mismatch");
  const randomAccessIndex = input.mfra
    ? inspectMfra(input.mfra, access, states)
    : undefined;
  return {
    durationSeconds,
    summary: {
      basis: "bounded-fragment-sample-tables",
      fragmentCount,
      sampleCount,
      sampleRangesVerified: true,
      timelinesVerified: true,
      ...(randomAccessIndex ? { randomAccessIndex } : {}),
      tracks: summaryTracks,
    },
  };
}

function inspectMfra(
  b: Uint8Array,
  access: Map<
    number,
    Map<number, { time: number; sync: boolean; traf: number; trun: number }>
  >,
  states: Map<number, State>,
): NonNullable<FragmentedMp4Summary["randomAccessIndex"]> {
  const children = boxes(b);
  if (children.some((box) => !["tfra", "mfro"].includes(box.type)))
    fail("unsupported_fragment_index");
  const mfro = one(children, "mfro");
  full(b, mfro, [0], 0);
  if (
    children.at(-1) !== mfro ||
    mfro.end - mfro.data !== 8 ||
    u32(b, mfro.data + 4) !== b.length + 8
  )
    fail("invalid_fragment_index");
  const seen = new Set<number>();
  let entries = 0,
    usedCompatibility = false;
  for (const tfra of children.filter((box) => box.type === "tfra")) {
    full(b, tfra, [0, 1], 0);
    const id = u32(b, tfra.data + 4),
      lengths = u32(b, tfra.data + 8),
      count = u32(b, tfra.data + 12);
    if (!states.has(id) || seen.has(id) || lengths >>> 6 || count > 1024)
      fail("unsupported_fragment_index");
    entries += count;
    if (entries > 2048) fail("unsupported_fragment_index");
    seen.add(id);
    const widths = [
      ((lengths >>> 4) & 3) + 1,
      ((lengths >>> 2) & 3) + 1,
      (lengths & 3) + 1,
    ];
    const version = b[tfra.data],
      integerBytes = version ? 8 : 4;
    let p = tfra.data + 16,
      previousTime = -1,
      previousOffset = -1,
      globalOrder = true,
      trackFirstCompatibility = true;
    const variable = (width: number) => {
      let n = 0;
      for (let j = 0; j < width; j++) {
        if (p >= tfra.end) fail("invalid_fragment_index");
        n = n * 256 + b[p++];
      }
      return n;
    };
    for (let n = 0; n < count; n++) {
      const time = version ? u64(b, p) : u32(b, p);
      p += integerBytes;
      const offset = version ? u64(b, p) : u32(b, p);
      p += integerBytes;
      const traf = variable(widths[0]),
        trun = variable(widths[1]),
        sample = variable(widths[2]);
      const entry = access.get(offset)?.get(id);
      if (
        !entry ||
        !entry.sync ||
        entry.time !== time ||
        entry.trun !== trun ||
        sample !== 1 ||
        time <= previousTime ||
        offset <= previousOffset
      )
        fail("unverified_fragment_index");
      // The ordinary mapping uses the actual traf order in this moof.
      // FFmpeg's mov_write_tfra_tag writes 1/1/1 for every track instead:
      // https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/movenc.c
      // Accept that producer convention only for an entire tfra, never by
      // guessing independently per entry. The earlier seen-track guard proves
      // exactly one traf for this explicit track ID in each referenced moof.
      globalOrder &&= entry.traf === traf;
      trackFirstCompatibility &&= traf === 1;
      if (!globalOrder && !trackFirstCompatibility)
        fail("unverified_fragment_index");
      previousTime = time;
      previousOffset = offset;
    }
    if (p !== tfra.end) fail("invalid_fragment_index");
    if (!globalOrder) usedCompatibility = true;
  }
  return {
    basis: usedCompatibility ? "track-id-compatibility" : "global-traf-order",
    entries,
  };
}
