import { sourceMp4Fixture } from "./source-fixture";
// Synthetic ISO-BMFF metadata. Payload is zeros and is NOT decodable media.
export const concat = (...parts: Uint8Array[]) => {
  const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    b.set(part, at);
    at += part.length;
  }
  return b;
};
export const word = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const long = (n: number) =>
  concat(word(Math.floor(n / 2 ** 32)), word(n % 2 ** 32));
const name = (s: string) => new TextEncoder().encode(s);
export const box = (type: string, ...body: Uint8Array[]) => {
  const b = concat(...body);
  return concat(word(b.length + 8), name(type), b);
};
const full = (flags: number, ...body: Uint8Array[]) =>
  concat(word(flags), ...body);
export function fixtureBoxes(b: Uint8Array, start = 0, end = b.length) {
  const result: { type: string; start: number; data: number; end: number }[] =
    [];
  for (let p = start; p < end;) {
    const size = new DataView(b.buffer, b.byteOffset).getUint32(p);
    result.push({
      type: String.fromCharCode(...b.subarray(p + 4, p + 8)),
      start: p,
      data: p + 8,
      end: p + size,
    });
    p += size;
  }
  return result;
}
export function fragmentedMp4Fixture(
  options: {
    fragments?: number;
    audio?: boolean;
    separateTracks?: boolean;
    addressing?: "moof" | "absolute" | "implicit";
    defaults?: "trex" | "tfhd" | "trun";
    signedCts?: boolean;
    index?: boolean;
    indexTrafNumber?: "global" | "track-first";
    indexEvery?: number;
    initPadding?: number;
    edit?: boolean;
    audioPadding?: number;
    mdatPadding?: number;
    mehdSeconds?: number;
  } = {},
) {
  const original = sourceMp4Fixture({
    tail: false,
    audio: options.audio,
    edit: options.edit,
  });
  const top = fixtureBoxes(original),
    ftyp = original.slice(top[0].start, top[0].end);
  const rewrite = (a: number, z: number): Uint8Array =>
    concat(
      ...fixtureBoxes(original, a, z).map((item) => {
        if (["moov", "trak", "mdia", "minf", "stbl"].includes(item.type)) {
          let body = rewrite(item.data, item.end);
          if (item.type === "moov" && options.initPadding)
            body = concat(
              body,
              box("free", new Uint8Array(options.initPadding)),
            );
          if (item.type === "moov")
            body = concat(
              body,
              box(
                "mvex",
                ...(options.mehdSeconds === undefined
                  ? []
                  : [box("mehd", full(0, word(options.mehdSeconds * 1000)))]),
                ...[1, ...(options.audio === false ? [] : [2])].map((id) =>
                  box(
                    "trex",
                    full(
                      0,
                      word(id),
                      word(1),
                      word(options.defaults === "trex" ? 500 : 0),
                      word(options.defaults === "trex" ? 4 : 0),
                      word(0x2000000),
                    ),
                  ),
                ),
              ),
            );
          return box(item.type, body);
        }
        if (["mvhd", "mdhd", "tkhd"].includes(item.type)) {
          const b = original.slice(item.data, item.end);
          new DataView(b.buffer).setUint32(item.type === "tkhd" ? 20 : 16, 0);
          return box(item.type, b);
        }
        if (item.type === "edts")
          return box(
            "edts",
            box("elst", full(0, word(1), word(0), word(0), word(65536))),
          );
        if (["stts", "stsc", "stco", "stss"].includes(item.type))
          return box(item.type, full(0, word(0)));
        if (item.type === "stsz") return box("stsz", full(0, word(0), word(0)));
        if (item.type === "stsd" && options.audioPadding) {
          const entry = fixtureBoxes(original, item.data + 8, item.end)[0];
          if (entry.type === "mp4a") {
            const asc = concat(
              new Uint8Array([0x12, 0x10]),
              new Uint8Array(options.audioPadding),
            );
            const decoder = concat(
              new Uint8Array([0x40, 0x15]),
              new Uint8Array(11),
              new Uint8Array([5, asc.length]),
              asc,
            );
            const es = concat(
              new Uint8Array([0, 2, 0, 4, decoder.length]),
              decoder,
              new Uint8Array([6, 1, 2]),
            );
            return box(
              "stsd",
              full(
                0,
                word(1),
                box(
                  "mp4a",
                  original.slice(entry.data, entry.data + 28),
                  box("esds", full(0, new Uint8Array([3, es.length]), es)),
                ),
              ),
            );
          }
        }
        return original.slice(item.start, item.end);
      }),
    );
  const moovBox = top.find((item) => item.type === "moov")!;
  const moov = rewrite(moovBox.start, moovBox.end);
  const parts = [ftyp, moov];
  let offset = ftyp.length + moov.length,
    sequence = 0;
  const indices = new Map<
    number,
    { time: number; offset: number; traf: number }[]
  >([
    [1, []],
    ...(options.audio === false
      ? []
      : [
          [2, []] as [number, { time: number; offset: number; traf: number }[]],
        ]),
  ]);
  const addFragment = (ids: number[], ordinal: number) => {
    sequence++;
    const make = (dataOffsets: number[]) =>
      box(
        "moof",
        box("mfhd", full(0, word(sequence))),
        ...ids.map((id, i) => {
          const flags =
            (options.addressing === "absolute"
              ? 1
              : options.addressing === "implicit"
                ? 0
                : 0x20000) | (options.defaults === "tfhd" ? 0x38 : 0);
          const tfhd = box(
            "tfhd",
            full(
              flags,
              word(id),
              ...(options.addressing === "absolute" ? [long(offset)] : []),
              ...(options.defaults === "tfhd"
                ? [word(500), word(4), word(0x2000000)]
                : []),
            ),
          );
          const perSample =
            options.defaults && options.defaults !== "trun" ? 0 : 0x700;
          const cts = options.signedCts ? 0x800 : 0;
          const fields = [0, 1].map((n) =>
            concat(
              ...(perSample ? [word(500), word(4), word(0x2000000)] : []),
              ...(cts ? [word(n ? -500 : 500)] : []),
            ),
          );
          const trun = box(
            "trun",
            full(
              (options.signedCts ? 0x1000000 : 0) | 1 | perSample | cts,
              word(2),
              word(dataOffsets[i]),
              ...fields,
            ),
          );
          return box(
            "traf",
            tfhd,
            box("tfdt", full(0x1000000, long(ordinal * 1000))),
            trun,
          );
        }),
      );
    let moof = make(ids.map(() => 0));
    moof = make(ids.map((_, i) => moof.length + 8 + i * 8));
    for (let i = 0; i < ids.length; i++)
      indices.get(ids[i])!.push({
        time: ordinal * 1000 + (options.signedCts ? 500 : 0),
        offset,
        traf: i + 1,
      });
    const mdat = box(
      "mdat",
      new Uint8Array(ids.length * 8 + (options.mdatPadding ?? 0)),
    );
    parts.push(moof, mdat);
    offset += moof.length + mdat.length;
  };
  for (let n = 0; n < (options.fragments ?? 2); n++) {
    if (options.separateTracks && options.audio !== false) {
      addFragment([1], n);
      addFragment([2], n);
    } else addFragment(options.audio === false ? [1] : [1, 2], n);
  }
  if (options.index) {
    const tfras = [...indices].map(([id, allEntries]) => {
      const entries = allEntries.filter(
        (_, i) => i % (options.indexEvery ?? 1) === 0,
      );
      return box(
        "tfra",
        full(
          0x1000000,
          word(id),
          word(0),
          word(entries.length),
          ...entries.map((entry) =>
            concat(
              long(entry.time),
              long(entry.offset),
              new Uint8Array([
                options.indexTrafNumber === "track-first" ? 1 : entry.traf,
                1,
                1,
              ]),
            ),
          ),
        ),
      );
    });
    const length = tfras.reduce((n, b) => n + b.length, 0) + 24;
    parts.push(box("mfra", ...tfras, box("mfro", full(0, word(length)))));
  }
  return concat(...parts);
}
