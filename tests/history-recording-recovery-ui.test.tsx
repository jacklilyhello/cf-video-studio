import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HistorySnapshot, PublicVideo } from "../web/client";
type Frame = {
  states: unknown[];
  refs: { current: unknown }[];
  effects: {
    deps: unknown[];
    run: boolean;
    effect: () => void | (() => void);
    cleanup?: () => void;
  }[];
};
const fixture = vi.hoisted(() => ({
  root: null as unknown,
  frames: new Map<string, Frame>(),
  active: null as Frame | null,
  index: 0,
  refIndex: 0,
  effectIndex: 0,
  loads: new Map<
    string,
    {
      data: unknown;
      loading: boolean;
      error: Error | null;
      reload: () => void;
      setData: (value: unknown) => void;
    }
  >(),
  initial: {} as PublicVideo,
  second: {} as PublicVideo,
  history: {} as HistorySnapshot,
}));
vi.mock("react", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useCallback: (callback: unknown) => callback,
  useState(initial: unknown) {
    const frame = fixture.active!,
      index = fixture.index++;
    if (!(index in frame.states))
      frame.states[index] = typeof initial === "function" ? initial() : initial;
    return [
      frame.states[index],
      (next: unknown) => {
        frame.states[index] =
          typeof next === "function" ? next(frame.states[index]) : next;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = fixture.refIndex++;
    return (fixture.active!.refs[index] ||= { current: initial });
  },
  useEffect(effect: () => void | (() => void), deps: unknown[] = []) {
    const index = fixture.effectIndex++,
      frame = fixture.active!;
    const old = frame.effects[index];
    if (!old || deps.some((value, i) => value !== old.deps[i])) {
      old?.cleanup?.();
      frame.effects[index] = { deps, run: true, effect };
    }
  },
}));
vi.mock("react-dom/client", () => ({
  createRoot: () => ({
    render: (node: unknown) => {
      fixture.root = node;
    },
    unmount() {},
  }),
}));
vi.mock("../web/client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useLoad(path: string | null) {
    const key = path ?? "disabled";
    if (!fixture.loads.has(key)) {
      const load = {
        data:
          path === "/api/history"
            ? fixture.history
            : path === "/api/config"
              ? { progressIntervalSeconds: 20 }
              : path?.includes("/api/videos?")
                ? {
                    items: [fixture.initial, fixture.second],
                    page: 1,
                    pageSize: 12,
                    total: 2,
                  }
                : path === "/api/videos/video"
                  ? fixture.initial
                  : path === "/api/videos/second"
                    ? fixture.second
                    : null,
        loading: false,
        error: null as Error | null,
        reload: vi.fn(),
        setData: (value: unknown) => {
          load.data = value as typeof load.data;
        },
      };
      fixture.loads.set(key, load);
    }
    return fixture.loads.get(key);
  },
}));
type Node = {
  type?: unknown;
  key?: string | null;
  props?: Record<string, unknown> & { children?: unknown };
};
type Component = (props: Record<string, unknown>) => unknown;
function find(node: unknown, match: (node: Node) => boolean): Node[] {
  if (!node || typeof node !== "object") return [];
  const item = node as Node;
  return [
    ...(match(item) ? [item] : []),
    ...[item.props?.children]
      .flat(Infinity)
      .flatMap((child) => find(child, match)),
  ];
}
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object"
    ? text((node as Node).props?.children)
    : "";
}
function named(tree: unknown, name: string) {
  return find(
    tree,
    (node) => typeof node.type === "function" && node.type.name === name,
  )[0];
}
function render(
  component: Component,
  key: string,
  props: Record<string, unknown> = {},
) {
  const frame = fixture.frames.get(key) ?? {
    states: [],
    refs: [],
    effects: [],
  };
  fixture.frames.set(key, frame);
  fixture.active = frame;
  fixture.index = fixture.refIndex = fixture.effectIndex = 0;
  const tree = component(props);
  for (const effect of frame.effects)
    if (effect.run) {
      effect.run = false;
      effect.cleanup = effect.effect() || undefined;
    }
  return tree;
}
class Media extends EventTarget {
  currentTime = 0;
  duration = 60;
  paused = false;
  ended = false;
  seeking = false;
  readyState = 4;
  error = null;
  src = "";
  removeAttribute() {}
  load() {}
}
let publicComponent: Component, playerKey: string | null, media: Media;
let latest: PublicVideo,
  cookie: boolean,
  context: string,
  acceptsCookie: boolean;
let historyItems: HistorySnapshot["items"],
  sent: {
    path: string;
    options: RequestInit;
    body?: Record<string, unknown>;
  }[];
let custom:
  | ((path: string, options: RequestInit) => Promise<Response> | undefined)
  | undefined;
const posted: Record<string, unknown>[] = [],
  broadcast: unknown[] = [];
let channel: { onmessage: ((event: { data: unknown }) => void) | null };
const site = () => render(publicComponent, "site");
function player() {
  const node = named(site(), "Player");
  if (!node) return null;
  const key = `player:${node.key}`;
  if (playerKey !== key) {
    if (playerKey)
      for (const effect of fixture.frames.get(playerKey)!.effects)
        effect.cleanup?.();
    media = new Media();
    media.duration = latest.duration ?? 60;
    fixture.frames.set(key, {
      states: [],
      refs: [{ current: media }],
      effects: [],
    });
    playerKey = key;
  }
  return render(node.type as Component, key, node.props!);
}
function click(tree: unknown, label: string) {
  const target = find(
    tree,
    (node) => node.type === "button" && text(node) === label,
  )[0];
  expect(target, label).toBeDefined();
  expect(target.props!.disabled).not.toBe(true);
  (target.props!.onClick as () => void)();
}
async function settle() {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0);
    site();
    player();
  }
}
async function observe(position = 20) {
  media.currentTime = position;
  media.dispatchEvent(new Event("pause"));
  await settle();
}
async function recover() {
  click(player(), "重新开始记录");
  await settle();
}
const responseError = (code: string, status = 409) =>
  Response.json({ error: { code, message: code } }, { status });
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  fixture.frames.clear();
  fixture.loads.clear();
  fixture.root = null;
  fixture.initial = {
    id: "video",
    title: "Fixture",
    duration: 60,
    versionId: "old",
    timelineId: "old-timeline",
    mediaKind: "source",
    updatedAt: 1,
  };
  fixture.second = {
    ...fixture.initial,
    id: "second",
    title: "Second",
    versionId: "second-version",
    timelineId: "second-timeline",
  };
  fixture.history = {
    items: [],
    cookieEnabled: true,
    writeContext: "a".repeat(64),
  };
  latest = fixture.initial;
  cookie = acceptsCookie = true;
  context = "a".repeat(64);
  historyItems = [];
  playerKey = null;
  sent = [];
  posted.length = broadcast.length = 0;
  custom = undefined;
  vi.stubGlobal("location", {
    pathname: "/video",
    search: "?video=video",
    origin: "https://fixture.invalid",
  });
  vi.stubGlobal("window", {
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    history: { pushState: vi.fn() },
  });
  vi.stubGlobal("document", {
    title: "",
    visibilityState: "visible",
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage = null;
      constructor() {
        channel = this;
      }
      postMessage(value: unknown) {
        broadcast.push(value);
      }
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit = {}) => {
      const body =
        typeof options.body === "string" ? JSON.parse(options.body) : undefined;
      sent.push({ path, options, body });
      const special = custom?.(path, options);
      if (special) return special;
      if (path === "/api/videos/video") return Response.json(latest);
      if (path === "/api/history/identity") {
        if (acceptsCookie) cookie = true;
        return Response.json({ identityIssued: true });
      }
      if (path === "/api/history" && options.method === "DELETE") {
        cookie = false;
        historyItems = [];
        return Response.json({ cleared: true });
      }
      if (path === "/api/history" && options.method === "POST") {
        posted.push(body);
        if (!cookie) return responseError("cookies_required");
        if (body.writeContext !== context)
          return responseError("history_identity_changed");
        if (body.timelineId !== latest.timelineId)
          return responseError("timeline_changed");
        return Response.json({ saved: true });
      }
      if (path === "/api/history")
        return Response.json({
          items: historyItems,
          cookieEnabled: cookie,
          writeContext: cookie ? context : null,
        });
      throw new Error("Unexpected fixture API");
    }),
  );
  const { PublicSite } = await import("../web/PublicSite");
  publicComponent = PublicSite as Component;
  site();
  await settle();
  media.dispatchEvent(new Event("loadedmetadata"));
  sent = [];
});
afterEach(() => {
  for (const frame of fixture.frames.values())
    for (const effect of frame.effects) effect.cleanup?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("recovers a changed timeline through current metadata and matching fresh history, never attributing old buffered playback to it", async () => {
  latest = {
    ...latest,
    versionId: "new",
    timelineId: "new-timeline",
    mediaKind: "mp4",
    duration: 120,
  };
  historyItems = [
    {
      videoId: "video",
      title: "Fixture",
      position: 35,
      duration: 120,
      timelineId: "new-timeline",
      watched: 0,
      updatedAt: 1,
    },
  ];
  await observe();
  expect(text(player())).toContain("视频版本已更新");
  await recover();
  expect(sent.filter((item) => item.path === "/api/videos/video")).toHaveLength(
    1,
  );
  expect(media.src).toBe("/media/video/new/optimized.mp4");
  media.dispatchEvent(new Event("loadedmetadata"));
  expect(media.currentTime).toBe(35);
  await observe(36);
  expect(posted.map((item) => item.timelineId)).toEqual([
    "old-timeline",
    "new-timeline",
  ]);
  expect(posted[1]).toMatchObject({
    writeContext: "a".repeat(64),
    position: 36,
    playedSeconds: 0,
  });
});

it("passes the published source descriptor and retains explicit native fallback only for the exact reloaded version", async () => {
  const descriptor: NonNullable<PublicVideo["sourcePlayback"]> = {
    etag: "fixture-etag",
    bytes: 1000,
    probe: {
      durationSeconds: 60,
      videoCodec: "avc1",
      audioCodec: null,
      audioChannels: 0,
    },
  };
  fixture.initial.sourcePlayback = descriptor;
  latest = { ...fixture.initial };
  let node = named(site(), "Player");
  expect(node.props).toMatchObject({
    sourceEtag: descriptor.etag,
    sourceBytes: descriptor.bytes,
    sourceProbe: descriptor.probe,
    preferNative: false,
  });
  (
    node.props!.onRetry as (
      position: number,
      options: { nativeFallback: true },
    ) => void
  )(21, { nativeFallback: true });
  await settle();
  node = named(site(), "Player");
  expect(sent.filter((item) => item.path === "/api/videos/video")).toHaveLength(
    1,
  );
  expect(node.props).toMatchObject({
    versionId: "old",
    preferNative: true,
    initialPosition: 21,
  });
  latest = {
    ...latest,
    versionId: "replacement",
    timelineId: "replacement-timeline",
  };
  (node.props!.onRetry as (position: number) => void)(22);
  await settle();
  expect(named(site(), "Player").props).toMatchObject({
    versionId: "replacement",
    preferNative: false,
  });
});

it("proves Cookie acceptance by GET before reset, keeps playback on failure and discards old visitor events only after an explicit successful retry", async () => {
  cookie = acceptsCookie = false;
  context = "b".repeat(64);
  await observe();
  const oldMedia = media,
    oldId = posted[0].eventId;
  await recover();
  expect(media).toBe(oldMedia);
  expect(text(player())).toContain("浏览器未接受观看记录 Cookie");
  expect(broadcast).toEqual(["cleared"]);
  expect(posted).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20000);
  expect(posted).toHaveLength(1);
  acceptsCookie = true;
  await recover();
  expect(broadcast).toEqual(["cleared", "cleared", "ready"]);
  expect(media).toBe(oldMedia);
  await observe(21);
  expect(posted[1]).toMatchObject({
    writeContext: "b".repeat(64),
    position: 21,
  });
  expect(posted[1].eventId).not.toBe(oldId);
});

it("bounds identity failure without interrupting the player or automatically sending another identity request", async () => {
  cookie = false;
  await observe();
  const oldMedia = media;
  custom = (path, options) =>
    path === "/api/history/identity"
      ? new Promise((_resolve, reject) =>
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        )
      : undefined;
  click(player(), "重新开始记录");
  await settle();
  expect(text(player())).toContain("正在核对记录");
  await vi.advanceTimersByTimeAsync(4001);
  await settle();
  expect(media).toBe(oldMedia);
  expect(text(player())).toContain("恢复未完成");
  expect(
    sent.filter((item) => item.path === "/api/history/identity"),
  ).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20000);
  expect(
    sent.filter((item) => item.path === "/api/history/identity"),
  ).toHaveLength(1);
});

it("keeps a new valid visitor identity without POST identity and does not replay the rejected old-context event", async () => {
  context = "b".repeat(64);
  await observe();
  expect(text(player())).toContain("访客身份已改变");
  await recover();
  expect(
    sent.filter((item) => item.path === "/api/history/identity"),
  ).toHaveLength(0);
  await observe(21);
  expect(posted.map((item) => item.writeContext)).toEqual([
    "a".repeat(64),
    "b".repeat(64),
  ]);
});

it.each(["switch", "close", "clear", "delete"] as const)(
  "ignores a late recovery response after %s and coalesces double clicks",
  async (action) => {
    latest = { ...latest, versionId: "new", timelineId: "new-timeline" };
    await observe();
    let finish!: (response: Response) => void;
    custom = (path) =>
      path === "/api/videos/video"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : undefined;
    const target = find(
      player(),
      (node) => node.type === "button" && text(node) === "重新开始记录",
    )[0];
    (target.props!.onClick as () => void)();
    (target.props!.onClick as () => void)();
    await settle();
    expect(
      sent.filter((item) => item.path === "/api/videos/video"),
    ).toHaveLength(1);
    if (action === "switch") {
      const item = find(
        site(),
        (node) =>
          node.props?.className === "video-card" &&
          text(node).includes("Second"),
      )[0];
      (item.props!.onClick as () => void)();
    } else if (action === "close") click(site(), "← 返回放映室");
    else if (action === "clear") channel.onmessage?.({ data: "cleared" });
    else {
      click(site(), "清除当前域名历史");
      click(site(), "确认清除");
    }
    await settle();
    finish(Response.json(latest));
    await settle();
    if (action === "switch")
      expect(named(site(), "Player").props).toMatchObject({
        videoId: "second",
        versionId: "second-version",
      });
    else if (action === "close")
      expect(named(site(), "Player")).toBeUndefined();
    else
      expect(named(site(), "Player").props).toMatchObject({
        versionId: "old",
        saveHistory: false,
      });
    expect(posted).toHaveLength(1);
  },
);

it("turns an identity-change recovery with a newly missing Cookie into a separate explicit Cookie retry", async () => {
  context = "b".repeat(64);
  await observe();
  cookie = acceptsCookie = false;
  await recover();
  expect(
    sent.filter((item) => item.path === "/api/history/identity"),
  ).toHaveLength(0);
  expect(text(player())).toContain("浏览器未接受观看记录 Cookie");
  acceptsCookie = true;
  await recover();
  expect(
    sent.filter((item) => item.path === "/api/history/identity"),
  ).toHaveLength(1);
  await observe(21);
  expect(posted.at(-1)?.writeContext).toBe("b".repeat(64));
});

it("does not use identity POST to repair a malformed non-null context receipt", async () => {
  context = "broken-context";
  await observe();
  await recover();
  expect(text(player())).toContain("身份数据暂时无法核验");
  await recover();
  expect(posted).toHaveLength(1);
  expect(
    sent.filter((item) => item.path === "/api/history/identity"),
  ).toHaveLength(0);
});

it("leaves the existing native player intact when current metadata returns 404", async () => {
  latest = { ...latest, versionId: "new", timelineId: "new-timeline" };
  await observe();
  const oldMedia = media;
  custom = (path) =>
    path === "/api/videos/video"
      ? Promise.resolve(responseError("video_unavailable", 404))
      : undefined;
  await recover();
  expect(media).toBe(oldMedia);
  expect(media.src).toBe("/media/video/old/source.mp4");
  expect(text(player())).toContain("视频已下架或暂不可用");
  expect(posted).toHaveLength(1);
  expect(
    sent.filter((item) => item.path === "/api/history/identity"),
  ).toHaveLength(0);
});

it("does not replace an uncertain acknowledgement's event identity during ordinary retries, and only offers explicit recovery after the bounded window", async () => {
  custom = (path, options) =>
    path === "/api/history" && options.method === "POST"
      ? Promise.reject(new Error("Acknowledgement lost"))
      : undefined;
  await observe();
  expect(text(player())).not.toContain("重新开始记录");
  await vi.advanceTimersByTimeAsync(1000);
  await settle();
  const attempts = sent.filter(
    (item) => item.path === "/api/history" && item.options.method === "POST",
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[1].options.body).toBe(attempts[0].options.body);
  await vi.advanceTimersByTimeAsync(320000);
  await settle();
  expect(text(player())).toContain("此前未确认片段可能不完整");
  expect(text(player())).toContain("重新开始记录");
});

it.each(["response failure", "timeout"] as const)(
  "requires explicit verified recovery after a clear %s, without restoring the old context or replaying discarded playback",
  async (failure) => {
    await observe(10);
    const oldMedia = media,
      oldEventId = posted[0].eventId;
    custom = (path, options) => {
      if (path !== "/api/history" || options.method !== "DELETE")
        return undefined;
      if (failure === "response failure")
        return Promise.resolve(responseError("clear_failed", 503));
      // A lost response does not establish whether DELETE changed the Cookie.
      cookie = acceptsCookie = false;
      context = "b".repeat(64);
      return new Promise<Response>((_resolve, reject) =>
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    };
    click(site(), "清除当前域名历史");
    click(site(), "确认清除");
    await settle();
    if (failure === "timeout") {
      await vi.advanceTimersByTimeAsync(4001);
      await settle();
    }
    expect(media).toBe(oldMedia);
    expect(text(player())).toContain("重新开始记录");
    expect(
      find(
        site(),
        (node) =>
          typeof node.type === "function" &&
          node.type.name === "ErrorBox" &&
          !!node.props?.error,
      ),
    ).toHaveLength(1);
    await observe(11);
    media.currentTime = 20;
    await vi.advanceTimersByTimeAsync(20000);
    await settle();
    expect(posted).toHaveLength(1);
    expect(sent.filter((item) => item.path === "/api/history")).toHaveLength(2);
    expect(
      sent.filter((item) => item.path === "/api/history/identity"),
    ).toHaveLength(0);

    await recover();
    if (failure === "timeout") {
      // Set-Cookie alone cannot unlock recording while the browser rejects it.
      expect(text(player())).toContain("浏览器未接受观看记录 Cookie");
      expect(posted).toHaveLength(1);
      expect(
        sent.filter((item) => item.path === "/api/history/identity"),
      ).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20000);
      await settle();
      expect(
        sent.filter((item) => item.path === "/api/history/identity"),
      ).toHaveLength(1);
      acceptsCookie = true;
      await recover();
      expect(
        sent
          .filter(
            (item) =>
              item.path === "/api/history" ||
              item.path === "/api/history/identity",
          )
          .slice(-3)
          .map((item) => [item.path, item.options.method ?? "GET"]),
      ).toEqual([
        ["/api/history", "GET"],
        ["/api/history/identity", "POST"],
        ["/api/history", "GET"],
      ]);
    } else {
      expect(
        sent.filter((item) => item.path === "/api/history/identity"),
      ).toHaveLength(0);
    }
    expect(media).toBe(oldMedia);
    expect(text(player())).not.toContain("重新开始记录");
    await observe(21);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({
      writeContext: failure === "timeout" ? "b".repeat(64) : "a".repeat(64),
      position: 21,
      playedSeconds: 0,
    });
    expect(posted[1].eventId).not.toBe(oldEventId);
  },
);

it("bounds Cookie recreation after a failed clear and only retries it on another explicit recovery", async () => {
  custom = (path, options) => {
    if (path === "/api/history" && options.method === "DELETE")
      return Promise.resolve(responseError("clear_failed", 503));
    if (path === "/api/history/identity")
      return new Promise<Response>((_resolve, reject) =>
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    return undefined;
  };
  click(site(), "清除当前域名历史");
  click(site(), "确认清除");
  await settle();
  cookie = false;
  context = "b".repeat(64);
  const oldMedia = media;
  click(player(), "重新开始记录");
  await settle();
  expect(text(player())).toContain("正在核对记录");
  await vi.advanceTimersByTimeAsync(4001);
  await settle();
  expect(media).toBe(oldMedia);
  expect(text(player())).toContain("恢复未完成");
  expect(text(player())).toContain("重新开始记录");
  await observe(10);
  await vi.advanceTimersByTimeAsync(20000);
  await settle();
  expect(posted).toHaveLength(0);
  expect(
    sent.filter((item) => item.path === "/api/history/identity"),
  ).toHaveLength(1);
  custom = undefined;
  await recover();
  expect(
    sent.filter((item) => item.path === "/api/history/identity"),
  ).toHaveLength(2);
  await observe(11);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({
    writeContext: "b".repeat(64),
    position: 11,
    playedSeconds: 0,
  });
});

it("keeps room selection, closing and browser navigation under /video", async () => {
  const item = find(
    site(),
    (node) =>
      node.props?.className === "video-card" && text(node).includes("Second"),
  )[0];
  (item.props!.onClick as () => void)();
  await settle();
  expect(window.history.pushState).toHaveBeenLastCalledWith(
    {},
    "",
    "/video?video=second",
  );
  expect(named(site(), "Player").props?.videoId).toBe("second");
  click(site(), "← 返回放映室");
  await settle();
  expect(window.history.pushState).toHaveBeenLastCalledWith({}, "", "/video");
  expect(named(site(), "Player")).toBeUndefined();
  location.search = "?video=video";
  const listener = vi
    .mocked(window.addEventListener)
    .mock.calls.find(([event]) => String(event) === "popstate")![1];
  (listener as () => void)();
  await settle();
  expect(named(site(), "Player").props?.videoId).toBe("video");
});

it.each([404, 500])(
  "distinguishes selected video absence from a retriable failure (%i)",
  async (status) => {
    const { ApiError } = await import("../web/client");
    fixture.loads.get("/api/videos/video")!.error = new ApiError(
      "private-detail",
      "video_unavailable",
      undefined,
      status,
    );
    const tree = site();
    if (status === 404) {
      expect(named(tree, "Empty")?.props?.title).toBe("视频不存在或已下架");
      expect(
        find(tree, (n) => n.type === "a" && n.props?.href === "/video").some(
          (n) => text(n).includes("返回放映室"),
        ),
      ).toBe(true);
      expect(named(tree, "Player")).toBeUndefined();
    } else {
      const error = named(tree, "ErrorBox");
      expect(error?.props?.retry).toBe(
        fixture.loads.get("/api/videos/video")!.reload,
      );
      expect(text(tree)).not.toContain("视频不存在或已下架");
    }
  },
);
