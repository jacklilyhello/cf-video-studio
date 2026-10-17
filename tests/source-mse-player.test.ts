import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectSourceMp4 } from "../src/source-mp4";
import { fixtureBoxes, fragmentedMp4Fixture } from "./fragmented-fixture";
import {
  attachFragmentedSourcePlayer,
  readSourcePlaybackRange,
} from "../web/source-mse-player";

// Synthetic zero payload: tests HTTP, cancellation and MSE scheduling only.
// No browser decoding, hardware acceleration or cloud conversion is claimed.
const input = {
  url: "/api/admin/source/example/source.mp4",
  sourceEtag: "fixture-etag",
  sourceBytes: 100,
};
function body(bytes: Uint8Array) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    type: "bytes",
    pull(controller) {
      const request = (controller as ReadableByteStreamController).byobRequest!;
      const target = new Uint8Array(
        request.view!.buffer,
        request.view!.byteOffset,
        request.view!.byteLength,
      );
      const count = Math.min(target.length, bytes.length - offset);
      target.set(bytes.subarray(offset, offset + count));
      offset += count;
      request.respond(count);
      if (offset === bytes.length) controller.close();
    },
  });
}
function response(
  bytes: Uint8Array,
  start: number,
  total: number,
  headers: Record<string, string> = {},
) {
  return new Response(body(bytes), {
    status: 206,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(bytes.length),
      "Content-Range": `bytes ${start}-${start + bytes.length - 1}/${total}`,
      ETag: '"fixture-etag"',
      "Cache-Control": "no-store, max-age=0",
      "Accept-Ranges": "bytes",
      ...headers,
    },
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bounded original MSE transport", () => {
  it("reads only an exact authenticated same-origin closed range", async () => {
    const fetcher = vi.fn(async () =>
      response(new Uint8Array([1, 2, 3]), 5, 100),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await readSourcePlaybackRange(input, 5, 3, new AbortController().signal),
    ).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetcher).toHaveBeenCalledWith(
      input.url,
      expect.objectContaining({
        credentials: "same-origin",
        mode: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { Range: "bytes=5-7" },
      }),
    );
  });
  it.each([
    ["ETag", '"changed"'],
    ["Content-Length", "99"],
    ["Content-Range", "bytes 5-7/99"],
    ["Content-Type", "text/html"],
  ])("refuses changed %s before reading", async (header, value) => {
    const returned = response(new Uint8Array([1, 2, 3]), 5, 100, {
      [header]: value,
    });
    const cancel = vi.spyOn(returned.body!, "cancel");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => returned),
    );
    await expect(
      readSourcePlaybackRange(input, 5, 3, new AbortController().signal),
    ).rejects.toMatchObject({ code: "source_mse_identity" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("does not read a full-file 200 when Range is ignored", async () => {
    const returned = new Response(new Uint8Array(100), { status: 200 });
    const cancel = vi.spyOn(returned.body!, "cancel");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => returned),
    );
    await expect(
      readSourcePlaybackRange(input, 5, 3, new AbortController().signal),
    ).rejects.toMatchObject({ code: "source_mse_identity" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([
    { ...input, url: "https://other.example/source.mp4" },
    { ...input, url: input.url + "?token=invalid" },
    { ...input, url: "/api/admin/source/../source.mp4" },
  ])("rejects non-fixed media paths without network", async (bad) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      readSourcePlaybackRange(bad, 0, 3, new AbortController().signal),
    ).rejects.toMatchObject({ code: "source_mse_range" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("cancels a late response after parent abort without consuming it", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((yes) => {
            resolve = yes;
          }),
      ),
    );
    const abort = new AbortController();
    const pending = readSourcePlaybackRange(input, 5, 3, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const late = response(new Uint8Array([1, 2, 3]), 5, 100);
    const cancel = vi.spyOn(late.body!, "cancel");
    resolve(late);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
});

class FakeBuffer extends EventTarget {
  constructor(private readonly owner: FakeMedia) {
    super();
  }
  updating = false;
  retained: {
    start: number;
    end: number;
    highestEnd: number;
    bytes: number;
  }[] = [];
  maxRetainedBytes = 0;
  removals: [number, number][] = [];
  get buffered() {
    const ranges = this.retained
      .map((range) => ({
        ...range,
        end: this.owner.readyState === "ended" ? range.highestEnd : range.end,
      }))
      .sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const r of ranges) {
      const last = merged.at(-1);
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else merged.push({ ...r });
    }
    return {
      length: merged.length,
      start: (i: number) => merged[i].start,
      end: (i: number) => merged[i].end,
    };
  }
  appended: { length: number; start: number | null }[] = [];
  private beginMutation() {
    if (this.updating || this.owner.readyState === "closed")
      throw new DOMException("Invalid buffer state", "InvalidStateError");
    // MSE prepare-append and remove both reopen an ended parent source.
    if (this.owner.readyState === "ended") {
      this.owner.readyState = "open";
      queueMicrotask(() => this.owner.dispatchEvent(new Event("sourceopen")));
    }
    this.updating = true;
  }
  appendBuffer(bytes: Uint8Array) {
    this.beginMutation();
    // These synthetic fixtures use explicit trun durations and timescale1000.
    // Model A/V intersection while open, and EOS extension to the highest end.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const moof = fixtureBoxes(bytes).find((box) => box.type === "moof");
    const tracks = moof
      ? fixtureBoxes(bytes, moof.data, moof.end)
          .filter((box) => box.type === "traf")
          .map((traf) => {
            const boxes = fixtureBoxes(bytes, traf.data, traf.end),
              tfdt = boxes.find((box) => box.type === "tfdt")!,
              trun = boxes.find((box) => box.type === "trun")!;
            const start = Number(view.getBigUint64(tfdt.data + 4)) / 1000;
            let duration = 0;
            for (
              let sample = 0;
              sample < view.getUint32(trun.data + 4);
              sample++
            )
              duration += view.getUint32(trun.data + 12 + sample * 12) / 1000;
            return { start, end: start + duration };
          })
      : [];
    const time = tracks[0]?.start ?? null;
    this.appended.push({ length: bytes.length, start: time });
    if (time !== null)
      this.retained.push({
        start: Math.max(...tracks.map((track) => track.start)),
        end: Math.min(...tracks.map((track) => track.end)),
        highestEnd: Math.max(...tracks.map((track) => track.end)),
        bytes: bytes.length,
      });
    this.maxRetainedBytes = Math.max(
      this.maxRetainedBytes,
      this.retained.reduce((n, r) => n + r.bytes, 0),
    );
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }
  remove(start: number, end: number) {
    this.beginMutation();
    this.removals.push([start, end]);
    this.retained = this.retained.filter(
      (r) => r.end <= start || r.start >= end,
    );
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }
  abort() {
    this.updating = false;
  }
}
class FakeMedia extends EventTarget {
  static instances: FakeMedia[] = [];
  static isTypeSupported = () => true;
  readyState = "closed";
  duration = 0;
  buffer = new FakeBuffer(this);
  endOfStreamCalls = 0;
  constructor() {
    super();
    FakeMedia.instances.push(this);
  }
  addSourceBuffer() {
    return this.buffer;
  }
  endOfStream() {
    if (this.readyState !== "open" || this.buffer.updating)
      throw new DOMException("Invalid source state", "InvalidStateError");
    this.endOfStreamCalls++;
    this.readyState = "ended";
  }
}
class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = true;
  ended = false;
  value: string | null = null;
  set src(value: string) {
    this.value = value;
    queueMicrotask(() => {
      const media = FakeMedia.instances.at(-1)!;
      media.readyState = "open";
      media.dispatchEvent(new Event("sourceopen"));
    });
  }
  getAttribute() {
    return this.value;
  }
  removeAttribute() {
    this.value = null;
  }
  load() {}
}
async function fixture(
  options: {
    fragments?: number;
    mdatPadding?: number;
    videoTailDurationTicks?: number;
  } = {},
) {
  const bytes = fragmentedMp4Fixture({
    fragments: 30,
    addressing: "absolute",
    index: true,
    indexTrafNumber: "track-first",
    ...options,
  });
  if (options.videoTailDurationTicks !== undefined) {
    const moof = fixtureBoxes(bytes)
      .filter((box) => box.type === "moof")
      .at(-1)!;
    const traf = fixtureBoxes(bytes, moof.data, moof.end).find(
      (box) => box.type === "traf",
    )!;
    const trun = fixtureBoxes(bytes, traf.data, traf.end).find(
      (box) => box.type === "trun",
    )!;
    new DataView(bytes.buffer).setUint32(
      trun.data + 24,
      options.videoTailDurationTicks,
    );
  }
  const probe = await inspectSourceMp4(bytes.length, async (offset, length) =>
    bytes.slice(offset, offset + length),
  );
  expect(probe.compatible).toBe(true);
  FakeMedia.instances = [];
  vi.stubGlobal("MediaSource", FakeMedia);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic-player");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const ranges: { start: number; end: number }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options: RequestInit) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(
        (options.headers as Record<string, string>).Range,
      )!;
      const start = Number(match[1]),
        end = Number(match[2]);
      ranges.push({ start, end });
      return response(bytes.slice(start, end + 1), start, bytes.length);
    }),
  );
  const video = new FakeVideo();
  const controller = new AbortController();
  const onFatal = vi.fn();
  const config = {
    ...input,
    sourceBytes: bytes.length,
    probe,
    durationSeconds: probe.durationSeconds!,
    signal: controller.signal,
    onFatal,
  };
  return { video, config, ranges, controller, onFatal, revoke };
}
describe("fragment scheduling lifecycle, synthetic media only", () => {
  it("physically evicts large old fragments before appending a new target without stalling at the byte cap", async () => {
    const f = await fixture({ fragments: 5, mdatPadding: 12 * 1024 ** 2 });
    const attached = await attachFragmentedSourcePlayer(
      f.video as unknown as HTMLVideoElement,
      f.config,
    );
    const buffer = FakeMedia.instances[0].buffer;
    await vi.waitFor(() =>
      expect(buffer.appended.filter((x) => x.start !== null)).toHaveLength(2),
    );
    for (let second = 1; second < 5; second++) {
      f.video.currentTime = second;
      f.video.dispatchEvent(new Event("timeupdate"));
      await vi.waitFor(() =>
        expect(buffer.appended.some((x) => x.start === second)).toBe(true),
      );
    }
    expect(buffer.maxRetainedBytes).toBeLessThanOrEqual(32 * 1024 ** 2);
    expect(buffer.removals.length).toBeGreaterThan(0);
    expect(f.onFatal).not.toHaveBeenCalled();
    if (attached.kind === "mse") attached.dispose();
  });
  it("refetches an indexed target after UA coded-frame eviction", async () => {
    const f = await fixture();
    const attached = await attachFragmentedSourcePlayer(
      f.video as unknown as HTMLVideoElement,
      f.config,
    );
    const buffer = FakeMedia.instances[0].buffer;
    await vi.waitFor(() =>
      expect(buffer.appended.filter((x) => x.start === 0)).toHaveLength(1),
    );
    buffer.retained = buffer.retained.filter((x) => x.start !== 0);
    f.video.dispatchEvent(new Event("waiting"));
    await vi.waitFor(() =>
      expect(buffer.appended.filter((x) => x.start === 0)).toHaveLength(2),
    );
    expect(f.onFatal).not.toHaveBeenCalled();
    if (attached.kind === "mse") attached.dispose();
  });
  it("does not mistake an evicted target prefix for the genuine stream start offset", async () => {
    const f = await fixture();
    const attached = await attachFragmentedSourcePlayer(
      f.video as unknown as HTMLVideoElement,
      f.config,
    );
    const buffer = FakeMedia.instances[0].buffer;
    await vi.waitFor(() =>
      expect(buffer.appended.filter((x) => x.start === 0)).toHaveLength(1),
    );
    buffer.retained.find((x) => x.start === 0)!.start = 0.2;
    f.video.currentTime = 0;
    f.video.dispatchEvent(new Event("waiting"));
    await vi.waitFor(() =>
      expect(buffer.appended.filter((x) => x.start === 0)).toHaveLength(2),
    );
    expect(f.onFatal).not.toHaveBeenCalled();
    if (attached.kind === "mse") attached.dispose();
  });
  it("starts with init/index and bounded first fragments, without native whole-file scanning", async () => {
    const f = await fixture();
    const attached = await attachFragmentedSourcePlayer(
      f.video as unknown as HTMLVideoElement,
      f.config,
    );
    expect(attached.kind).toBe("mse");
    await vi.waitFor(() =>
      expect(FakeMedia.instances[0].buffer.appended.length).toBeGreaterThan(2),
    );
    expect(f.ranges.length).toBeLessThan(20);
    expect(
      f.ranges.every((r) => r.end - r.start + 1 < f.config.sourceBytes),
    ).toBe(true);
    expect(FakeMedia.instances[0].duration).toBe(30);
    expect(f.onFatal).not.toHaveBeenCalled();
    if (attached.kind === "mse") attached.dispose();
    expect(f.video.value).toBeNull();
    expect(f.revoke).toHaveBeenCalledOnce();
  });
  it("seeks from the indexed target and does not restart at the beginning at normal end", async () => {
    const f = await fixture();
    const attached = await attachFragmentedSourcePlayer(
      f.video as unknown as HTMLVideoElement,
      f.config,
    );
    await vi.waitFor(() =>
      expect(FakeMedia.instances[0].buffer.appended.length).toBeGreaterThan(3),
    );
    f.video.currentTime = 25;
    f.video.dispatchEvent(new Event("seeking"));
    await vi.waitFor(() =>
      expect(FakeMedia.instances[0].readyState).toBe("ended"),
    );
    const requestsAtEnd = f.ranges.length;
    f.video.currentTime = 30;
    f.video.ended = true;
    f.video.dispatchEvent(new Event("timeupdate"));
    await Promise.resolve();
    await Promise.resolve();
    expect(f.ranges.length).toBe(requestsAtEnd);
    expect(f.onFatal).not.toHaveBeenCalled();
    if (attached.kind === "mse") attached.dispose();
  });
  it("restores EOS after advancing playback trims old buffers, without changing duration or appending the tail again", async () => {
    const f = await fixture({ fragments: 45 });
    f.video.paused = false;
    const attached = await attachFragmentedSourcePlayer(
      f.video as unknown as HTMLVideoElement,
      f.config,
    );
    const media = FakeMedia.instances[0],
      buffer = media.buffer;
    await vi.waitFor(() =>
      expect(buffer.appended.some((x) => x.start === 20)).toBe(true),
    );
    for (const position of [15, 30]) {
      f.video.currentTime = position;
      f.video.dispatchEvent(new Event("timeupdate"));
      await vi.waitFor(() =>
        expect(
          buffer.appended.some((x) => x.start === Math.min(44, position + 20)),
        ).toBe(true),
      );
    }
    await vi.waitFor(() => expect(media.readyState).toBe("ended"));
    expect(media.endOfStreamCalls).toBe(1);
    const appendedAtEOS = buffer.appended.slice(),
      requestsAtEOS = f.ranges.length;
    for (const position of [35, 40]) {
      f.video.currentTime = position;
      f.video.dispatchEvent(new Event("timeupdate"));
      await vi.waitFor(() => {
        expect(buffer.removals).toContainEqual([0, position - 10]);
        expect(buffer.updating).toBe(false);
        expect(media.readyState).toBe("ended");
      });
    }
    expect(media.endOfStreamCalls).toBe(3);
    expect(media.duration).toBe(45);
    expect(buffer.appended).toEqual(appendedAtEOS);
    expect(f.ranges).toHaveLength(requestsAtEOS);
    expect(f.video.ended).toBe(false);
    expect(f.onFatal).not.toHaveBeenCalled();
    if (attached.kind === "mse") attached.dispose();
  });
  it("keeps the source open after seeking away from an ended tail when prefetch stops before the last fragment", async () => {
    const f = await fixture({ fragments: 60 });
    f.video.paused = false;
    const attached = await attachFragmentedSourcePlayer(
      f.video as unknown as HTMLVideoElement,
      f.config,
    );
    const media = FakeMedia.instances[0],
      buffer = media.buffer;
    await vi.waitFor(() =>
      expect(buffer.appended.some((x) => x.start === 20)).toBe(true),
    );
    f.video.currentTime = 50;
    f.video.dispatchEvent(new Event("seeking"));
    await vi.waitFor(() => expect(media.readyState).toBe("ended"));
    expect(media.endOfStreamCalls).toBe(1);
    f.video.currentTime = 0;
    f.video.dispatchEvent(new Event("seeking"));
    await vi.waitFor(() => {
      expect(buffer.appended.filter((x) => x.start === 20)).toHaveLength(2);
      expect(buffer.updating).toBe(false);
    });
    expect(media.readyState).toBe("open");
    expect(media.endOfStreamCalls).toBe(1);
    expect(media.duration).toBe(60);
    expect(buffer.buffered.end(buffer.buffered.length - 1)).toBe(21);
    expect(f.onFatal).not.toHaveBeenCalled();
    if (attached.kind === "mse") attached.dispose();
  });
  it("refetches a loaded tail missing its final 100ms instead of treating the old ledger as complete", async () => {
    const f = await fixture({ fragments: 45 });
    f.video.paused = false;
    const attached = await attachFragmentedSourcePlayer(
      f.video as unknown as HTMLVideoElement,
      f.config,
    );
    const media = FakeMedia.instances[0],
      buffer = media.buffer;
    await vi.waitFor(() =>
      expect(buffer.appended.some((x) => x.start === 20)).toBe(true),
    );
    f.video.currentTime = 30;
    f.video.dispatchEvent(new Event("timeupdate"));
    await vi.waitFor(() => expect(media.readyState).toBe("ended"));
    const tail = buffer.retained.find((range) => range.start === 44)!;
    tail.end = tail.highestEnd = 44.9;
    f.video.currentTime = 35;
    f.video.dispatchEvent(new Event("timeupdate"));
    await vi.waitFor(() => {
      expect(buffer.appended.filter((x) => x.start === 44)).toHaveLength(2);
      expect(media.readyState).toBe("ended");
    });
    expect(media.duration).toBe(45);
    expect(buffer.buffered.end(buffer.buffered.length - 1)).toBe(45);
    expect(f.onFatal).not.toHaveBeenCalled();
    if (attached.kind === "mse") attached.dispose();
  });
  it("accepts the proof's unequal A/V endpoints and restores EOS extension without refetching or changing playback time", async () => {
    const f = await fixture({ fragments: 45, videoTailDurationTicks: 450 });
    expect(
      f.config.probe.fragmented!.tracks.map(
        (track) => track.presentationEndSeconds,
      ),
    ).toEqual([44.95, 45]);
    f.video.paused = false;
    const attached = await attachFragmentedSourcePlayer(
      f.video as unknown as HTMLVideoElement,
      f.config,
    );
    const media = FakeMedia.instances[0],
      buffer = media.buffer;
    await vi.waitFor(() =>
      expect(buffer.appended.some((x) => x.start === 20)).toBe(true),
    );
    f.video.currentTime = 30;
    f.video.dispatchEvent(new Event("timeupdate"));
    await vi.waitFor(() => expect(media.readyState).toBe("ended"));
    const requestsAtEOS = f.ranges.length;
    expect(buffer.buffered.end(buffer.buffered.length - 1)).toBe(45);
    expect(buffer.retained.find((range) => range.start === 44)?.end).toBe(
      44.95,
    );
    for (const position of [35, 44.975]) {
      f.video.currentTime = position;
      f.video.dispatchEvent(new Event("timeupdate"));
      await vi.waitFor(() => {
        expect(buffer.removals).toContainEqual([0, Math.floor(position - 10)]);
        expect(buffer.updating).toBe(false);
        expect(media.readyState).toBe("ended");
      });
      expect(f.video.currentTime).toBe(position);
      expect(buffer.buffered.end(buffer.buffered.length - 1)).toBe(45);
    }
    expect(f.ranges).toHaveLength(requestsAtEOS);
    expect(buffer.appended.filter((x) => x.start === 44)).toHaveLength(1);
    expect(media.duration).toBe(45);
    expect(f.video.ended).toBe(false);
    expect(f.onFatal).not.toHaveBeenCalled();
    if (attached.kind === "mse") attached.dispose();
  });
  it("aborts setup without creating a MediaSource or appending late bytes", async () => {
    const f = await fixture();
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = attachFragmentedSourcePlayer(
      f.video as unknown as HTMLVideoElement,
      f.config,
    );
    f.controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    finish(
      response(
        new Uint8Array(16),
        f.config.sourceBytes - 16,
        f.config.sourceBytes,
      ),
    );
    await Promise.resolve();
    expect(FakeMedia.instances).toHaveLength(0);
    expect(f.video.value).toBeNull();
  });
  it("uses native only before attachment when MSE itself is unsupported", async () => {
    const f = await fixture();
    vi.stubGlobal("MediaSource", undefined);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      await attachFragmentedSourcePlayer(
        f.video as unknown as HTMLVideoElement,
        f.config,
      ),
    ).toEqual({ kind: "unsupported" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.video.value).toBeNull();
  });
});
