import { afterEach, beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  states: [] as unknown[],
  effects: [] as {
    deps: unknown[];
    effect: () => void | (() => void);
    cleanup?: () => void;
    run: boolean;
  }[],
  refIndex: 0,
  stateIndex: 0,
  effectIndex: 0,
}));
const mse = vi.hoisted(() => ({
  attach: vi.fn(
    (
      _element: unknown,
      _input: unknown,
    ): Promise<
      { kind: "unsupported" } | { kind: "mse"; dispose: () => void }
    > => Promise.resolve({ kind: "unsupported" }),
  ),
}));
vi.mock("../web/source-mse-player", () => ({
  attachFragmentedSourcePlayer: mse.attach,
}));
vi.mock("react", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useCallback: (callback: unknown) => callback,
  useRef(initial: unknown) {
    const index = hooks.refIndex++;
    return (hooks.refs[index] ||= { current: initial });
  },
  useState(initial: unknown) {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [
      hooks.states[index],
      (next: unknown) => {
        hooks.states[index] =
          typeof next === "function" ? next(hooks.states[index]) : next;
      },
    ];
  },
  useEffect(effect: () => void | (() => void), deps: unknown[]) {
    const index = hooks.effectIndex++;
    const old = hooks.effects[index];
    if (!old || deps.some((value, i) => value !== old.deps[i])) {
      old?.cleanup?.();
      hooks.effects[index] = { effect, deps, run: true };
    }
  },
}));
vi.mock("../web/client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useLoad: () => ({
    data: { items: [], page: 1, pageSize: 50, total: 0 },
    reload: vi.fn(),
    loading: false,
    error: null,
  }),
}));
import { Player } from "../web/Player";
import { SourcePreview } from "../web/SourcePreview";
import { SourceMediaDiagnostics } from "../web/SourceMediaDiagnostics";
import { Loading } from "../web/ui";
import { MediaErrorBox } from "../web/media-errors";
import { WatchProgressQueue } from "../web/client";
import type { SourceCheck, SourcePreviewEvidence, Video } from "../web/client";
import type { SourceStartupTiming } from "../web/sourceStartupTiming";
let component: () => unknown;

type Node = {
  key?: string | null;
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
};
function find(node: unknown, matches: (node: Node) => boolean): Node[] {
  if (!node || typeof node !== "object") return [];
  const item = node as Node;
  return [
    ...(matches(item) ? [item] : []),
    ...[item.props?.children]
      .flat(Infinity)
      .flatMap((child) => find(child, matches)),
  ];
}
function renderedText(node: unknown): string {
  if (Array.isArray(node)) return node.map(renderedText).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return renderedText((node as Node).props?.children);
}
function render() {
  hooks.refIndex = hooks.stateIndex = hooks.effectIndex = 0;
  const tree = component();
  for (const effect of hooks.effects)
    if (effect.run) {
      effect.run = false;
      effect.cleanup = effect.effect() || undefined;
    }
  return tree;
}
function button(text: string) {
  return find(
    render(),
    (node) => node.type === "button" && node.props?.children === text,
  )[0];
}
beforeEach(() => {
  mse.attach.mockReset().mockResolvedValue({ kind: "unsupported" });
  hooks.refs = [];
  hooks.states = [];
  hooks.effects = [];
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    setInterval,
    clearInterval,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => {
  for (const effect of hooks.effects) effect.cleanup?.();
  vi.doUnmock("hls.js");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  { duration: 60, from: 1, to: 30, kind: "source" as const },
  { duration: 1, from: 0.1, to: 0.5, kind: "source" as const },
  { duration: 60, from: 1, to: 30, kind: "mp4" as const },
])(
  "uses native $kind without HLS and captures playback and seek for $duration seconds",
  async ({ duration, from, to, kind }) => {
    const imported = vi.fn();
    vi.doMock("hls.js", () => {
      imported();
      throw new Error("HLS must not be loaded");
    });
    const listeners = new Map<string, () => void>();
    const element = {
      currentTime: 0,
      duration,
      paused: true,
      ended: false,
      seeking: false,
      readyState: 4,
      error: null,
      src: "",
      canPlayType: () => "",
      addEventListener: (name: string, callback: () => void) =>
        listeners.set(name, callback),
      removeEventListener: (name: string) => listeners.delete(name),
      removeAttribute() {},
      load() {},
    };
    hooks.refs.push({ current: element });
    const evidence = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    component = () =>
      Player({
        videoId: "video",
        versionId: "version",
        timelineId: "source-timeline",
        title: "Fixture",
        mediaKind: kind,
        sourceRevision: kind === "mp4" ? "must-not-report-source" : undefined,
        preview: true,
        onPreviewEvidence: evidence,
      });
    render();
    listeners.get("loadedmetadata")!();
    expect(evidence.mock.calls.at(-1)?.[0]).toMatchObject({
      played: false,
      seeked: false,
      durationSeconds: duration,
    });
    element.paused = false;
    element.currentTime = from;
    listeners.get("timeupdate")!();
    element.seeking = true;
    listeners.get("seeking")!();
    element.currentTime = to;
    element.seeking = false;
    listeners.get("seeked")!();
    expect(evidence.mock.calls.at(-1)?.[0]).toEqual({
      played: true,
      seeked: true,
      durationSeconds: duration,
      seekFromSeconds: from,
      seekToSeconds: to,
    });
    expect(element.src).toBe(
      `/api/admin/preview/video/version/${kind === "mp4" ? "optimized.mp4" : "source.mp4"}`,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(imported).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

const video = {
  id: "video",
  title: "Fixture",
  source_key: "videos/video/source/revision",
} as Video;
const source = {
  videoId: "video",
  etag: "etag",
  revision: "revision",
  bytes: 7,
  compatible: true,
  previewUrl: "/api/admin/source/video/source.mp4",
  probe: {
    durationSeconds: 60,
    width: 640,
    height: 360,
    videoCodec: "h264",
    audioCodec: "aac",
    audioChannels: 2,
  },
  reasons: [],
};
const observed: SourcePreviewEvidence = {
  played: true,
  seeked: true,
  durationSeconds: 60,
  seekFromSeconds: 1,
  seekToSeconds: 30,
};
const fragmentedProbe: NonNullable<SourceCheck["probe"]> = {
  durationSeconds: 60,
  videoCodec: "avc1",
  audioCodec: null,
  audioChannels: 0,
  index: {
    basis: "bounded-top-level-box-scan",
    placement: "before-media",
    moovOffset: 24,
    moovBytes: 100,
  },
  fragmented: {
    basis: "bounded-fragment-sample-tables",
    fragmentCount: 2,
    sampleCount: 4,
    sampleRangesVerified: true,
    timelinesVerified: true,
    tracks: [
      {
        id: 1,
        type: "video",
        timescale: 1000,
        sampleCount: 4,
        decodeStartSeconds: 0,
        decodeEndSeconds: 60,
        presentationStartSeconds: 0,
        presentationEndSeconds: 60,
      },
    ],
  },
};
type AdapterInput = Parameters<
  typeof import("../web/source-mse-player").attachFragmentedSourcePlayer
>[1];
function adapterPlayer(props: Partial<Parameters<typeof Player>[0]> = {}) {
  const listeners = new Map<string, () => void>();
  const element = {
    currentTime: 0,
    duration: 60,
    paused: true,
    ended: false,
    seeking: false,
    readyState: 4,
    error: null,
    src: "",
    play: vi.fn(),
    canPlayType: () => "",
    addEventListener: (name: string, callback: () => void) =>
      listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
    removeAttribute() {},
    load() {},
    emit: (name: string) => listeners.get(name)?.(),
  };
  hooks.refs.push({ current: element });
  component = () =>
    Player({
      videoId: "msevideo",
      versionId: "version",
      timelineId: "timeline",
      title: "Fixture",
      mediaKind: "source",
      preview: true,
      sourceProbe: fragmentedProbe,
      sourceEtag: "etag",
      sourceBytes: 1000,
      ...props,
    });
  render();
  return element;
}

it.each([false, true])(
  "uses native only after pre-append unsupported or an explicit preference (preferNative=%s)",
  async (preferNative) => {
    const element = adapterPlayer({ preferNative });
    await vi.advanceTimersByTimeAsync(0);
    expect(mse.attach).toHaveBeenCalledTimes(preferNative ? 0 : 1);
    expect(element.src).toBe("/api/admin/preview/msevideo/version/source.mp4");
    expect(element.play).not.toHaveBeenCalled();
  },
);

it.each([true, false])(
  "keeps an MSE failure visible until explicit native retry and preserves public retry metadata refresh (preview=%s)",
  async (preview) => {
    const dispose = vi.fn();
    const retry = preview ? undefined : vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ accepted: true })),
    );
    mse.attach.mockImplementation(async (element) => {
      (element as HTMLVideoElement).src = "blob:synthetic-mse";
      return { kind: "mse", dispose };
    });
    const element = adapterPlayer({ preview, onRetry: retry });
    await vi.advanceTimersByTimeAsync(0);
    const input = mse.attach.mock.calls[0][1] as AdapterInput;
    expect(input).toMatchObject({
      sourceEtag: "etag",
      sourceBytes: 1000,
      durationSeconds: 60,
      signal: expect.any(AbortSignal),
    });
    input.onFatal("fixed_failure");
    expect(element.src).toBe("blob:synthetic-mse");
    expect(mse.attach).toHaveBeenCalledOnce();
    const fallback = find(
      render(),
      (node) =>
        node.type === "button" && renderedText(node) === "使用原生播放重试",
    )[0];
    expect(fallback).toBeDefined();
    (fallback.props!.onClick as () => void)();
    render();
    await vi.advanceTimersByTimeAsync(0);
    expect(element.src).toBe(
      preview
        ? "/api/admin/preview/msevideo/version/source.mp4"
        : "/media/msevideo/version/source.mp4",
    );
    expect(mse.attach).toHaveBeenCalledOnce();
    expect(input.signal.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    if (retry)
      expect(retry).toHaveBeenCalledExactlyOnceWith(0, {
        nativeFallback: true,
      });
    expect(element.play).not.toHaveBeenCalled();
  },
);

it("disposes a late MSE attachment after cleanup without restoring a retired source", async () => {
  let finish!: (result: { kind: "mse"; dispose: () => void }) => void;
  mse.attach.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const element = adapterPlayer();
  const input = mse.attach.mock.calls[0][1] as AdapterInput;
  for (const effect of hooks.effects) effect.cleanup?.();
  expect(input.signal.aborted).toBe(true);
  const dispose = vi.fn();
  finish({ kind: "mse", dispose });
  await vi.advanceTimersByTimeAsync(0);
  expect(dispose).toHaveBeenCalledOnce();
  expect(element.src).toBe("");
});

it("stops an attached MSE path on a later decoder error and offers explicit native fallback", async () => {
  const dispose = vi.fn();
  mse.attach.mockImplementation(async (element) => {
    (element as HTMLVideoElement).src = "blob:synthetic-mse";
    return { kind: "mse", dispose };
  });
  const element = adapterPlayer();
  await vi.advanceTimersByTimeAsync(0);
  const input = mse.attach.mock.calls[0][1] as AdapterInput;
  element.emit("error");
  expect(input.signal.aborted).toBe(true);
  expect(dispose).toHaveBeenCalledOnce();
  expect(element.src).toBe("blob:synthetic-mse");
  expect(
    find(
      render(),
      (node) =>
        node.type === "button" && renderedText(node) === "使用原生播放重试",
    ),
  ).toHaveLength(1);
  expect(element.play).not.toHaveBeenCalled();
});

it.each([
  { preview: true, kind: "source" as const, measured: true },
  { preview: false, kind: "source" as const, measured: false },
  { preview: true, kind: "mp4" as const, measured: false },
])(
  "measures native startup events only for private source preview ($preview/$kind)",
  ({ preview, kind, measured }) => {
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const listeners = new Map<string, () => void>();
    let frame!: () => void;
    const cancelFrame = vi.fn();
    const element = {
      currentTime: 0,
      duration: 60,
      paused: true,
      ended: false,
      seeking: false,
      readyState: 4,
      error: null,
      src: "",
      canPlayType: () => "",
      addEventListener: (name: string, callback: () => void) =>
        listeners.set(name, callback),
      removeEventListener: (name: string) => listeners.delete(name),
      removeAttribute() {},
      load() {},
      requestVideoFrameCallback(callback: () => void) {
        frame = callback;
        return 7;
      },
      cancelVideoFrameCallback: cancelFrame,
    };
    hooks.refs.push({ current: element });
    const updates: SourceStartupTiming[] = [];
    component = () =>
      Player({
        videoId: "video",
        versionId: "version",
        timelineId: "timeline",
        title: "Fixture",
        preview,
        mediaKind: kind,
        onStartupTiming: (value) => updates.push(value),
      });
    render();
    for (const [event, at] of [
      ["loadedmetadata", 1025],
      ["loadeddata", 1030],
      ["canplay", 1040],
      ["play", 1500],
      ["playing", 1550],
    ] as const) {
      clock = at;
      listeners.get(event)!();
    }
    clock = 1560;
    frame?.();
    if (measured)
      expect(updates.at(-1)).toEqual({
        initializedMs: 0,
        loadedMetadataMs: 25,
        loadedDataMs: 30,
        canPlayMs: 40,
        playRequestedMs: 500,
        firstPlayingMs: 550,
        firstFrameMs: 560,
      });
    else expect(updates).toHaveLength(0);
    const count = updates.length;
    clock = 1700;
    listeners.get("playing")!();
    expect(updates).toHaveLength(count);
    const late = listeners.get("loadeddata")!;
    for (const effect of hooks.effects) effect.cleanup?.();
    late();
    frame?.();
    expect(updates).toHaveLength(count);
    expect(cancelFrame).toHaveBeenCalledTimes(measured ? 1 : 0);
  },
);

it("requests proof reuse on opening and retry, keeps explicit recheck fresh, and resets only player stages on reload", async () => {
  let clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  let fail = false;
  const fetch = vi.fn(async (path: string) =>
    fail
      ? Response.json(
          { error: { code: "temporary", message: "temporary" } },
          { status: 503 },
        )
      : Response.json({
          source: {
            ...source,
            preparation: {
              structureProof: path.includes("reuse=1") ? "persisted" : "fresh",
              elapsedMs: 12,
            },
          },
        }),
  );
  vi.stubGlobal("fetch", fetch);
  component = () =>
    SourcePreview({ video, onClose: vi.fn(), onCreated: vi.fn() });
  render();
  clock = 1400;
  await vi.advanceTimersByTimeAsync(0);
  let tree = render();
  expect(fetch.mock.calls[0][0]).toBe("/api/admin/source/video/check?reuse=1");
  expect(renderedText(tree)).toContain("本次起播计时 · 本次打开");
  expect(renderedText(tree)).toContain("已复用与当前身份匹配的完整证明");
  expect(renderedText(tree)).toContain("400 ms");
  expect(renderedText(tree)).toContain("12 ms");
  const oldPlayer = find(tree, (node) => node.type === Player)[0];
  const timing: SourceStartupTiming = {
    initializedMs: 0,
    loadedMetadataMs: 300,
    loadedDataMs: 500,
    canPlayMs: 600,
    playRequestedMs: 1000,
    firstPlayingMs: 1100,
    firstFrameMs: 1150,
  };
  (oldPlayer.props!.onStartupTiming as (value: SourceStartupTiming) => void)(
    timing,
  );
  expect(renderedText(render())).toContain("1150 ms");
  (button("重新加载播放器").props!.onClick as () => void)();
  tree = render();
  expect(renderedText(tree)).toContain("本次起播计时 · 重新加载");
  expect(renderedText(tree)).not.toContain("1150 ms");
  (oldPlayer.props!.onStartupTiming as (value: SourceStartupTiming) => void)(
    timing,
  );
  expect(renderedText(render())).not.toContain("1150 ms");
  expect(fetch).toHaveBeenCalledOnce();
  fail = true;
  (button("重新检查原片").props!.onClick as () => void)();
  render();
  await vi.advanceTimersByTimeAsync(0);
  tree = render();
  expect(fetch.mock.calls[1][0]).toBe("/api/admin/source/video/check");
  const error = find(tree, (node) => node.type === MediaErrorBox)[0];
  fail = false;
  (error.props!.retry as () => void)();
  render();
  await vi.advanceTimersByTimeAsync(0);
  tree = render();
  expect(fetch.mock.calls[2][0]).toBe("/api/admin/source/video/check?reuse=1");
  expect(renderedText(tree)).toContain("媒体缓存冷暖与硬件解码状态仍无法确认");
  expect(button("确认预览并建立原片版本").props!.disabled).toBe(true);
});

it("shows a source player for a valid check completing after sixty seconds without creating a version", async () => {
  const created = vi.fn();
  const fetch = vi.fn(
    (_path: string, options: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(Response.json({ source })),
          60000,
        );
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetch);
  component = () =>
    SourcePreview({ video, onClose: vi.fn(), onCreated: created });
  render();
  await vi.advanceTimersByTimeAsync(59999);
  expect(fetch.mock.calls[0][1].signal?.aborted).toBe(false);
  expect(find(render(), (node) => node.type === Player)).toHaveLength(0);
  expect(
    find(render(), (node) => node.type === Loading)[0].props?.text,
  ).toContain("有界 MP4 元数据校验");
  expect(
    find(render(), (node) => node.type === Loading)[0].props?.text,
  ).toContain("100 秒");
  await vi.advanceTimersByTimeAsync(1);
  const player = find(render(), (node) => node.type === Player)[0];
  expect(player.props).toMatchObject({
    videoId: video.id,
    versionId: source.revision,
    preview: true,
    mediaKind: "source",
  });
  expect(
    find(render(), (node) => node.type === SourceMediaDiagnostics)[0].props,
  ).toMatchObject({
    videoId: video.id,
    sourceRevision: source.revision,
    size: source.bytes,
  });
  expect(button("确认预览并建立原片版本").props?.disabled).toBe(true);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "/api/admin/source/video/check?reuse=1",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(created).not.toHaveBeenCalled();
});

it("aborts a stalled check at one hundred seconds and reports timeout without creating a version", async () => {
  const created = vi.fn();
  const fetch = vi.fn(
    (_path: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetch);
  component = () =>
    SourcePreview({ video, onClose: vi.fn(), onCreated: created });
  render();
  await vi.advanceTimersByTimeAsync(99999);
  expect(fetch.mock.calls[0][1].signal?.aborted).toBe(false);
  expect(find(render(), (node) => node.type === Loading)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
  const tree = render();
  expect(find(tree, (node) => node.type === Player)).toHaveLength(0);
  expect(
    find(tree, (node) => node.type === SourceMediaDiagnostics),
  ).toHaveLength(0);
  expect(find(tree, (node) => node.type === Loading)).toHaveLength(0);
  const failure = find(tree, (node) => node.type === MediaErrorBox)[0];
  expect(failure.props?.error).toMatchObject({ code: "request_timeout" });
  expect(failure.props?.retry).toBeTypeOf("function");
  expect(fetch).toHaveBeenCalledOnce();
  expect(created).not.toHaveBeenCalled();
});

it.each(["closing", "switching videos"])(
  "ignores a late source-check response after %s",
  async (action) => {
    const resolvers: ((response: Response) => void)[] = [];
    const fetch = vi.fn(
      (_path: string, _options: RequestInit) =>
        new Promise<Response>((resolve) => {
          // Deliberately ignore abort to exercise the component's stale-result guard.
          resolvers.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetch);
    let currentVideo = video;
    const created = vi.fn();
    component = () =>
      SourcePreview({
        video: currentVideo,
        onClose: vi.fn(),
        onCreated: created,
      });
    render();
    if (action === "closing") {
      for (const effect of hooks.effects) effect.cleanup?.();
      component = () => null;
    } else {
      currentVideo = { ...video, id: "other-video" };
      render();
      resolvers[1](
        Response.json({
          source: {
            ...source,
            videoId: currentVideo.id,
            revision: "other-revision",
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(
        find(render(), (node) => node.type === Player)[0].props,
      ).toMatchObject({
        videoId: "other-video",
        versionId: "other-revision",
      });
    }
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
    const previous = [...hooks.states];
    resolvers[0](Response.json({ source }));
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.states).toEqual(previous);
    if (action === "closing") expect(render()).toBeNull();
    else
      expect(
        find(render(), (node) => node.type === Player)[0].props,
      ).toMatchObject({
        videoId: "other-video",
        versionId: "other-revision",
      });
    expect(created).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(action === "closing" ? 1 : 2);
  },
);

it.each<{
  index?: NonNullable<SourceCheck["probe"]>["index"];
  expected: string;
}>([
  {
    index: {
      basis: "bounded-top-level-box-scan",
      placement: "before-media",
      moovOffset: 100,
      moovBytes: 200,
    },
    expected: "前部索引：位于全部媒体数据之前",
  },
  {
    index: {
      basis: "bounded-top-level-box-scan",
      placement: "after-media",
      moovOffset: 100,
      moovBytes: 200,
    },
    expected: "尾部索引：位于全部媒体数据之后",
  },
  {
    index: {
      basis: "bounded-top-level-box-scan",
      placement: "between-media",
      moovOffset: 100,
      moovBytes: 200,
    },
    expected: "中部索引：位于媒体数据之间",
  },
  {
    index: {
      basis: "bounded-top-level-box-scan",
      placement: "unknown",
      reason: "media-ranges-unverified",
    },
    expected: "媒体数据范围尚未完整核验。",
  },
  { expected: "无法确认" },
])(
  "shows supported index evidence without authorizing processing: $expected",
  async ({ index, expected }) => {
    const fetch = vi.fn(async () =>
      Response.json({
        source: { ...source, probe: { ...source.probe, index } },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    component = () =>
      SourcePreview({ video, onClose: vi.fn(), onCreated: vi.fn() });
    render();
    await vi.advanceTimersByTimeAsync(0);
    const text = renderedText(render());
    expect(text).toContain(expected);
    if (index?.moovOffset !== undefined)
      expect(text).toContain("起始字节偏移 100");
    else expect(text).not.toContain("起始字节偏移");
    if (index?.placement === "before-media") {
      expect(text).toContain("索引已在文件开头");
      expect(text).toContain("无需为了前置索引再次优化");
    } else if (
      index?.placement === "after-media" ||
      index?.placement === "between-media"
    ) {
      expect(text).toContain("仅在首播确实较慢时评估前置索引无损优化");
      expect(text).toContain("不重新编码");
    } else {
      expect(text).toContain("暂不能判断前置索引整理是否有帮助");
    }
    expect(button("确认预览并建立原片版本").props!.disabled).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it.each([
  undefined,
  { basis: "global-traf-order", entries: 360 },
  { basis: "track-id-compatibility", entries: 360 },
] as const)(
  "shows fragmented random access evidence %j without authorizing any action",
  async (randomAccessIndex) => {
    const created = vi.fn();
    const fetch = vi.fn(async () =>
      Response.json({
        source: {
          ...source,
          probe: {
            ...source.probe,
            fragmented: {
              basis: "bounded-fragment-sample-tables",
              fragmentCount: 180,
              sampleCount: 12000,
              sampleRangesVerified: true,
              timelinesVerified: true,
              ...(randomAccessIndex ? { randomAccessIndex } : {}),
              tracks: [
                {
                  id: 1,
                  type: "video",
                  timescale: 1000,
                  sampleCount: 6000,
                  decodeStartSeconds: 0,
                  decodeEndSeconds: 60,
                  presentationStartSeconds: 0,
                  presentationEndSeconds: 60,
                },
                {
                  id: 2,
                  type: "audio",
                  timescale: 1000,
                  sampleCount: 6000,
                  decodeStartSeconds: 0,
                  decodeEndSeconds: 60,
                  presentationStartSeconds: 0,
                  presentationEndSeconds: 60,
                },
              ],
            },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    component = () =>
      SourcePreview({ video, onClose: vi.fn(), onCreated: created });
    render();
    await vi.advanceTimersByTimeAsync(0);
    const tree = render();
    const text = renderedText(tree);
    expect(text).toContain("分片 MP4 结构");
    expect(text).toContain("180");
    expect(text).toContain("12,000");
    if (randomAccessIndex) {
      expect(text).toContain("尾部随机访问索引");
      expect(text).toContain("360 条");
      expect(text).toContain(
        randomAccessIndex.basis === "track-id-compatibility"
          ? "按轨道兼容定位"
          : "按片段内轨道顺序定位",
      );
    }
    expect(text.includes("尾部索引采用按轨道兼容定位")).toBe(
      randomAccessIndex?.basis === "track-id-compatibility",
    );
    if (randomAccessIndex?.basis === "track-id-compatibility") {
      expect(text).toContain("结构检查不代表完整解码");
      expect(text).toContain("重点核对拖动后的声音与画面");
    }
    expect(find(tree, (node) => node.type === Player)[0].props).toMatchObject({
      mediaKind: "source",
      preview: true,
      mediaUrl: "/api/admin/source/video/source.mp4",
    });
    expect(button("确认预览并建立原片版本").props?.disabled).toBe(true);
    expect(
      find(
        tree,
        (node) => node.type === "input" && node.props?.type === "checkbox",
      )[0].props?.checked,
    ).toBe(false);
    (button("确认预览并建立原片版本").props!.onClick as () => void)();
    await vi.advanceTimersByTimeAsync(0);
    expect(created).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it("reloads only the private player and requires new evidence and acknowledgement without rechecking the source", async () => {
  const created = vi.fn();
  const fetch = vi.fn(async () => Response.json({ source }));
  vi.stubGlobal("fetch", fetch);
  component = () =>
    SourcePreview({ video, onClose: vi.fn(), onCreated: created });
  render();
  await vi.advanceTimersByTimeAsync(0);
  const previousPlayer = find(render(), (node) => node.type === Player)[0];
  const previousEvidence = previousPlayer.props!.onPreviewEvidence as (
    value: SourcePreviewEvidence,
  ) => void;
  previousEvidence(observed);
  const checkbox = find(
    render(),
    (node) => node.type === "input" && node.props?.type === "checkbox",
  )[0];
  (checkbox.props!.onChange as (event: unknown) => void)({
    target: { checked: true },
  });
  expect(button("确认预览并建立原片版本").props!.disabled).toBe(false);
  (button("重新加载播放器").props!.onClick as () => void)();
  await vi.advanceTimersByTimeAsync(0);
  const tree = render();
  const nextPlayer = find(tree, (node) => node.type === Player)[0];
  expect(nextPlayer.key).not.toBe(previousPlayer.key);
  expect(nextPlayer.props).toMatchObject({
    videoId: video.id,
    versionId: source.revision,
    mediaKind: "source",
    mediaUrl: "/api/admin/source/video/source.mp4",
  });
  expect(renderedText(tree)).toContain("等待播放");
  expect(renderedText(tree)).toContain("请使用播放控件拖动到另一位置");
  expect(renderedText(tree)).toContain("不重新生成或处理媒体");
  expect(
    find(
      tree,
      (node) => node.type === "input" && node.props?.type === "checkbox",
    )[0].props!.checked,
  ).toBe(false);
  expect(button("确认预览并建立原片版本").props!.disabled).toBe(true);
  previousEvidence(observed);
  (button("确认预览并建立原片版本").props!.onClick as () => void)();
  expect(renderedText(render())).toContain("等待播放");
  const renewedCheckbox = find(
    render(),
    (node) => node.type === "input" && node.props?.type === "checkbox",
  )[0];
  (renewedCheckbox.props!.onChange as (event: unknown) => void)({
    target: { checked: true },
  });
  expect(button("确认预览并建立原片版本").props!.disabled).toBe(true);
  (
    nextPlayer.props!.onPreviewEvidence as (
      value: SourcePreviewEvidence,
    ) => void
  )(observed);
  expect(button("确认预览并建立原片版本").props!.disabled).toBe(false);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "/api/admin/source/video/check?reuse=1",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(created).not.toHaveBeenCalled();
  // Closing also retires this player's callback, without changing the existing
  // source-check abort and late-response behavior.
  for (const effect of hooks.effects) effect.cleanup?.();
  const before = [...hooks.states];
  (
    nextPlayer.props!.onPreviewEvidence as (
      value: SourcePreviewEvidence,
    ) => void
  )(observed);
  expect(hooks.states).toEqual(before);
  expect(fetch).toHaveBeenCalledOnce();
});

it("creates an independent source version after explicit preview confirmation even when fresh metadata takes sixty seconds", async () => {
  const created = vi.fn();
  const fetch = vi.fn((path: string, options: RequestInit) =>
    path.split("?")[0].endsWith("/check")
      ? Promise.resolve(Response.json({ source }))
      : new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve(
                Response.json({
                  version: {
                    id: "source-version",
                    mode: "source",
                    timeline_id: "independent",
                  },
                }),
              ),
            60000,
          );
          options.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
  );
  vi.stubGlobal("fetch", fetch);
  component = () =>
    SourcePreview({ video, onClose: vi.fn(), onCreated: created });
  render();
  await vi.advanceTimersByTimeAsync(0);
  let tree = render();
  const confirm = button("确认预览并建立原片版本");
  expect(confirm.props!.disabled).toBe(true);
  (confirm.props!.onClick as () => void)();
  expect(fetch).toHaveBeenCalledOnce();
  const [checkPath, checkRequest] = fetch.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(checkPath).toBe("/api/admin/source/video/check?reuse=1");
  expect(checkRequest.method ?? "GET").toBe("GET");
  const player = find(tree, (node) => node.type === Player)[0];
  expect(player.props).toMatchObject({
    preview: true,
    mediaKind: "source",
    mediaUrl: "/api/admin/source/video/source.mp4",
  });
  (player.props!.onPreviewEvidence as (value: SourcePreviewEvidence) => void)(
    observed,
  );
  tree = render();
  expect(button("确认预览并建立原片版本").props!.disabled).toBe(true);
  const checkbox = find(
    tree,
    (node) => node.type === "input" && node.props?.type === "checkbox",
  )[0];
  (checkbox.props!.onChange as (event: unknown) => void)({
    target: { checked: true },
  });
  const ready = button("确认预览并建立原片版本");
  expect(ready.props!.disabled).toBe(false);
  (ready.props!.onClick as () => void)();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    JSON.parse(
      String((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body),
    ),
  ).toEqual({
    sourceEtag: "etag",
    sourceRevision: "revision",
    attestation: { ...observed, audioConfirmed: true },
  });
  await vi.advanceTimersByTimeAsync(59999);
  expect(created).not.toHaveBeenCalled();
  expect(fetch.mock.calls[1][1].signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(created).toHaveBeenCalledExactlyOnceWith({
    id: "source-version",
    mode: "source",
    timeline_id: "independent",
  });
  expect(
    fetch.mock.calls.every(
      ([path]) => !path.includes("/publish") && !path.includes("/quote"),
    ),
  ).toBe(true);
});

it("bounds a stalled explicitly confirmed source-version request at one hundred seconds without automatic retry", async () => {
  const created = vi.fn();
  const fetch = vi.fn((path: string, options: RequestInit) =>
    path.split("?")[0].endsWith("/check")
      ? Promise.resolve(Response.json({ source }))
      : new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
  );
  vi.stubGlobal("fetch", fetch);
  component = () =>
    SourcePreview({ video, onClose: vi.fn(), onCreated: created });
  render();
  await vi.advanceTimersByTimeAsync(0);
  const player = find(render(), (node) => node.type === Player)[0];
  (player.props!.onPreviewEvidence as (value: SourcePreviewEvidence) => void)(
    observed,
  );
  const checkbox = find(
    render(),
    (node) => node.type === "input" && node.props?.type === "checkbox",
  )[0];
  (checkbox.props!.onChange as (event: unknown) => void)({
    target: { checked: true },
  });
  (button("确认预览并建立原片版本").props!.onClick as () => void)();
  await vi.advanceTimersByTimeAsync(99999);
  expect(fetch.mock.calls[1][0]).toBe("/api/admin/videos/video/source-version");
  expect(fetch.mock.calls[1][1].signal?.aborted).toBe(false);
  expect(created).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch.mock.calls[1][1].signal?.aborted).toBe(true);
  expect(
    find(render(), (node) => node.type === MediaErrorBox)[0].props?.error,
  ).toMatchObject({ code: "source_version_creation_unverified" });
  expect(created).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not open a raw source player or allow creation when metadata is incompatible", async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      source: {
        ...source,
        compatible: false,
        reasons: ["Unsupported audio track"],
      },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  component = () =>
    SourcePreview({ video, onClose: vi.fn(), onCreated: vi.fn() });
  render();
  await vi.advanceTimersByTimeAsync(0);
  const tree = render();
  expect(find(tree, (node) => node.type === Player)).toHaveLength(0);
  expect(
    find(tree, (node) => node.type === SourceMediaDiagnostics),
  ).toHaveLength(0);
  const checkbox = find(
    tree,
    (node) => node.type === "input" && node.props?.type === "checkbox",
  )[0];
  expect(checkbox.props!.disabled).toBe(true);
  (checkbox.props!.onChange as (event: unknown) => void)({
    target: { checked: true },
  });
  const confirm = button("确认预览并建立原片版本");
  expect(confirm.props!.disabled).toBe(true);
  (confirm.props!.onClick as () => void)();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(["source", "mp4"] as const)(
  "saves resumed public %s playback against its independent timeline",
  async (kind) => {
    const listeners = new Map<string, Set<() => void>>();
    const emit = (name: string) => {
      for (const listener of listeners.get(name) || []) listener();
    };
    const element = {
      currentTime: 0,
      duration: 60,
      paused: true,
      ended: false,
      seeking: false,
      readyState: 4,
      error: null,
      src: "",
      canPlayType: () => "",
      addEventListener: (name: string, callback: () => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(callback);
      },
      removeEventListener: (name: string, callback: () => void) =>
        listeners.get(name)?.delete(callback),
      removeAttribute() {},
      load() {},
    };
    hooks.refs.push({ current: element });
    const fetch = vi.fn(async () => Response.json({ saved: true }));
    vi.stubGlobal("fetch", fetch);
    const saveQueue = new WatchProgressQueue();
    saveQueue.setWriteContext("a".repeat(64));
    component = () =>
      Player({
        videoId: "video",
        versionId: kind === "mp4" ? "optimized-version" : "source-version",
        timelineId: kind === "mp4" ? "optimized-timeline" : "source-timeline",
        title: "Fixture",
        mediaKind: kind,
        initialPosition: 20,
        saveHistory: true,
        saveQueue,
      });
    render();
    emit("loadedmetadata");
    expect(element.src).toBe(
      `/media/video/${kind === "mp4" ? "optimized-version/optimized.mp4" : "source-version/source.mp4"}`,
    );
    expect(element.currentTime).toBe(20);
    element.paused = false;
    element.currentTime = 21;
    await vi.advanceTimersByTimeAsync(1000);
    element.paused = true;
    emit("pause");
    await vi.advanceTimersByTimeAsync(0);
    const historyCalls = (
      fetch.mock.calls as unknown as [string, RequestInit][]
    ).filter(([path]) => path === "/api/history");
    expect(historyCalls).toHaveLength(1);
    const [path, request] = historyCalls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/history");
    expect(JSON.parse(String(request.body))).toMatchObject({
      videoId: "video",
      timelineId: kind === "mp4" ? "optimized-timeline" : "source-timeline",
      position: 21,
      playedSeconds: 1,
    });
  },
);

it("connects raw preview events only to bounded private diagnostics", async () => {
  const listeners = new Map<string, () => void>();
  const element = {
    currentTime: 0,
    duration: 60,
    paused: true,
    ended: false,
    seeking: false,
    readyState: 4,
    networkState: 1,
    error: null as null | { code: number },
    src: "",
    canPlayType: () => "",
    addEventListener: (name: string, callback: () => void) =>
      listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
    removeAttribute() {},
    load() {},
  };
  hooks.refs.push({ current: element });
  const fetch = vi.fn(async (_path: string, _options: RequestInit) =>
    Response.json({ accepted: true }, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetch);
  component = () =>
    Player({
      videoId: "raw-video",
      versionId: "revision",
      timelineId: "revision",
      title: "Fixture",
      mediaKind: "source",
      mediaUrl: "/api/admin/source/raw-video/source.mp4",
      sourceRevision: "revision",
      preview: true,
    });
  render();
  for (const phase of [
    "loadedmetadata",
    "playing",
    "waiting",
    "stalled",
    "seeked",
    "error",
  ])
    listeners.get(phase)!();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(6);
  expect(
    fetch.mock.calls.every(
      (call) => call[0] === "/api/admin/source/raw-video/playback-report",
    ),
  ).toBe(true);
  const phases = fetch.mock.calls.map(
    (call) =>
      JSON.parse(String((call as unknown as [string, RequestInit])[1].body))
        .phase,
  );
  expect(phases).toEqual([
    "loadedmetadata",
    "playing",
    "waiting",
    "stalled",
    "seeked",
    "error",
  ]);
});

it.each([false, true])(
  "does not confuse a front index or partial edit evidence with passing the file (compatible=%s)",
  async (compatible) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          source: {
            ...source,
            compatible,
            reasons: ["unsupported_edit_list"],
            probe: {
              ...source.probe,
              index: {
                basis: "bounded-top-level-box-scan",
                placement: "before-media",
                moovOffset: 32,
                moovBytes: 706014,
              },
              nativeEdits: [
                {
                  track: "audio",
                  mediaStartSeconds: 0,
                  durationSeconds: 276.063,
                },
              ],
            },
          },
        }),
      ),
    );
    component = () =>
      SourcePreview({ video, onClose: vi.fn(), onCreated: vi.fn() });
    render();
    await vi.advanceTimersByTimeAsync(0);
    const tree = render();
    const text = renderedText(tree);
    expect(text).toContain("原片结构检查尚未通过");
    expect(text).toContain("索引已在文件开头");
    expect(text).not.toContain("时间轴修剪及轨道延迟已通过");
    expect(text).not.toContain("可以开始管理员私有预览");
    expect(find(tree, (node) => node.type === Player)).toHaveLength(0);
    expect(
      find(
        tree,
        (node) =>
          node.type === MediaErrorBox &&
          node.props?.code === "unsupported_edit_list",
      ),
    ).toHaveLength(1);
    expect(button("确认预览并建立原片版本").props?.disabled).toBe(true);
  },
);

it("clears passing state immediately on recheck and never mixes old playback evidence with a failed result", async () => {
  let fail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        source: fail
          ? { ...source, compatible: false, reasons: ["unsupported_edit_list"] }
          : {
              ...source,
              parserVersion: "iso-bmff-source-v5",
              checkedAt: 1792150000000,
              probe: {
                ...source.probe,
                nativeEdits: [
                  {
                    track: "video",
                    mediaStartSeconds: 0.04,
                    movieStartSeconds: 0.04,
                    durationSeconds: 276,
                  },
                ],
              },
            },
      }),
    ),
  );
  component = () =>
    SourcePreview({ video, onClose: vi.fn(), onCreated: vi.fn() });
  render();
  await vi.advanceTimersByTimeAsync(0);
  const oldPlayer = find(render(), (n) => n.type === Player)[0];
  (
    oldPlayer.props!.onPreviewEvidence as (value: SourcePreviewEvidence) => void
  )(observed);
  expect(renderedText(render())).toContain("当前浏览器已观察到播放推进和拖动");
  fail = true;
  (button("重新检查原片").props!.onClick as () => void)();
  (
    oldPlayer.props!.onPreviewEvidence as (value: SourcePreviewEvidence) => void
  )(observed);
  let tree = render();
  expect(find(tree, (n) => n.type === Player)).toHaveLength(0);
  expect(renderedText(tree)).not.toContain("原片结构检查已通过");
  await vi.advanceTimersByTimeAsync(0);
  tree = render();
  expect(renderedText(tree)).toContain("原片结构检查尚未通过");
  expect(renderedText(tree)).not.toContain("已观察到播放进度");
  expect(renderedText(tree)).not.toContain("时间轴修剪及轨道延迟已通过");
  expect(button("确认预览并建立原片版本").props?.disabled).toBe(true);
});
