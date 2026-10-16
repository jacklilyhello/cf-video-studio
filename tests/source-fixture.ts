// Synthetic metadata only: sample payloads are deliberately not decodable media.
const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
};
const bytes = (text: string) => new TextEncoder().encode(text);
const u32 = (value: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value);
  return b;
};
const box = (type: string, ...data: Uint8Array[]) => {
  const body = concat(...data);
  return concat(u32(body.length + 8), bytes(type), body);
};
const full = (...parts: Uint8Array[]) => concat(u32(0), ...parts);
export function sourceMp4Fixture(
  options: {
    tail?: boolean;
    audio?: boolean;
    codec?: string;
    channels?: number;
    ascChannels?: number;
    external?: boolean;
    hdr?: boolean;
    badOffset?: boolean;
    edit?: boolean;
    audioEditDurationTicks?: number;
    videoEditDurationTicks?: number;
    videoEmptyEditDurationTicks?: number;
    movieDurationTicks?: number;
    mediaDurationTicks?: number;
    mediaTimescale?: number;
    editMediaTime?: number;
    composition?: { count: number; offset: number }[];
    compositionVersion?: 0 | 1;
    sampleTiming?: { count: number; delta: number }[];
    fragment?: boolean;
  } = {},
) {
  const timing = options.sampleTiming ?? [{ count: 2, delta: 5000 }];
  const sampleCount = timing.reduce((count, run) => count + run.count, 0);
  const trackBytes = sampleCount * 4;
  const ftyp = box("ftyp", bytes("isom"), u32(0), bytes("mp42"));
  const mdat = box(
    "mdat",
    new Uint8Array(options.audio === false ? trackBytes : trackBytes * 2),
  );
  const makeMovie = (offset: number) => {
    const mvhd = new Uint8Array(100);
    const mv = new DataView(mvhd.buffer);
    mv.setUint32(12, 1000);
    mv.setUint32(16, options.movieDurationTicks ?? 10000);
    const track = (audio: boolean) => {
      const tkhd = new Uint8Array(84);
      const tk = new DataView(tkhd.buffer);
      tk.setUint32(0, 3);
      tk.setUint32(12, audio ? 2 : 1);
      tk.setUint32(
        20,
        audio
          ? (options.audioEditDurationTicks ?? 10000)
          : (options.videoEditDurationTicks ?? 10000) +
              (options.videoEmptyEditDurationTicks ?? 0),
      );
      [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824].forEach((n, i) =>
        tk.setUint32(40 + i * 4, n),
      );
      if (!audio) {
        tk.setUint32(76, 640 * 65536);
        tk.setUint32(80, 360 * 65536);
      }
      const mdhd = new Uint8Array(24);
      const md = new DataView(mdhd.buffer);
      md.setUint32(12, options.mediaTimescale ?? 1000);
      md.setUint32(16, options.mediaDurationTicks ?? 10000);
      let sample: Uint8Array;
      if (!audio) {
        const entry = new Uint8Array(78);
        const e = new DataView(entry.buffer);
        e.setUint16(6, 1);
        e.setUint16(24, 640);
        e.setUint16(26, 360);
        e.setUint16(74, 24);
        e.setUint16(76, 65535);
        const avcc = box(
          "avcC",
          new Uint8Array([
            1, 66, 0, 30, 255, 225, 0, 5, 103, 66, 0, 30, 128, 1, 0, 2, 104, 0,
          ]),
        );
        const color = options.hdr
          ? box("colr", bytes("nclx"), new Uint8Array([0, 9, 0, 16, 0, 9, 128]))
          : new Uint8Array();
        sample = box(options.codec ?? "avc1", entry, avcc, color);
      } else {
        const entry = new Uint8Array(28);
        const e = new DataView(entry.buffer);
        e.setUint16(6, 1);
        e.setUint16(16, options.channels ?? 2);
        e.setUint16(18, 16);
        e.setUint32(24, 44100 * 65536);
        const asc = new Uint8Array([
          5,
          2,
          0x12,
          (options.ascChannels ?? options.channels ?? 2) << 3,
        ]);
        const decoderData = concat(
          new Uint8Array([0x40, 0x15]),
          new Uint8Array(11),
          asc,
        );
        const decoder = concat(
          new Uint8Array([4, decoderData.length]),
          decoderData,
        );
        const esData = concat(
          new Uint8Array([0, 2, 0]),
          decoder,
          new Uint8Array([6, 1, 2]),
        );
        sample = box(
          "mp4a",
          entry,
          box("esds", full(new Uint8Array([3, esData.length]), esData)),
        );
      }
      const stbl = box(
        "stbl",
        box("stsd", full(u32(1), sample)),
        box(
          "stts",
          full(
            u32(timing.length),
            ...timing.flatMap((run) => [u32(run.count), u32(run.delta)]),
          ),
        ),
        ...(!audio && options.composition
          ? [
              box(
                "ctts",
                u32((options.compositionVersion ?? 0) * 2 ** 24),
                u32(options.composition.length),
                ...options.composition.flatMap((run) => [
                  u32(run.count),
                  u32(run.offset),
                ]),
              ),
            ]
          : []),
        box("stsz", full(u32(4), u32(sampleCount))),
        box("stsc", full(u32(1), u32(1), u32(sampleCount), u32(1))),
        box(
          "stco",
          full(
            u32(1),
            u32(options.badOffset ? 0 : offset + (audio ? trackBytes : 0)),
          ),
        ),
        ...(!audio ? [box("stss", full(u32(1), u32(1)))] : []),
      );
      const minf = box(
        "minf",
        box(
          "dinf",
          box("dref", full(u32(1), box("url ", u32(options.external ? 0 : 1)))),
        ),
        stbl,
      );
      const hdlr = box(
        "hdlr",
        full(u32(0), bytes(audio ? "soun" : "vide"), new Uint8Array(12)),
      );
      const edit = options.edit
        ? box(
            "edts",
            box(
              "elst",
              full(
                u32(
                  !audio && options.videoEmptyEditDurationTicks !== undefined
                    ? 2
                    : 1,
                ),
                ...(!audio && options.videoEmptyEditDurationTicks !== undefined
                  ? [
                      u32(options.videoEmptyEditDurationTicks),
                      u32(0xffffffff),
                      u32(65536),
                    ]
                  : []),
                u32(
                  audio
                    ? (options.audioEditDurationTicks ?? 10000)
                    : (options.videoEditDurationTicks ?? 10000),
                ),
                u32(options.editMediaTime ?? 0),
                u32(65536),
              ),
            ),
          )
        : new Uint8Array();
      return box(
        "trak",
        box("tkhd", tkhd),
        edit,
        box("mdia", box("mdhd", mdhd), hdlr, minf),
      );
    };
    return box(
      "moov",
      box("mvhd", mvhd),
      track(false),
      ...(options.audio === false ? [] : [track(true)]),
    );
  };
  let moov = makeMovie(ftyp.length + 8);
  if (options.tail === false) moov = makeMovie(ftyp.length + moov.length + 8);
  const data =
    options.tail === false
      ? concat(ftyp, moov, mdat)
      : concat(ftyp, mdat, moov);
  return options.fragment ? concat(data, box("moof", new Uint8Array())) : data;
}
