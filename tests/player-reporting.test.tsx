import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  states: [] as unknown[],
  effects: [] as { effect: () => void | (() => void); cleanup?: () => void }[],
  refIndex: 0,
  stateIndex: 0,
  element: null as unknown,
}));
vi.mock("react", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useRef(initial: unknown) {
    const index = hooks.refIndex++;
    return (hooks.refs[index] ||= {
      current: index === 0 ? hooks.element : initial,
    });
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
  useCallback: (callback: unknown) => callback,
  useEffect(effect: () => void | (() => void)) {
    hooks.effects.push({ effect });
  },
}));
vi.mock("../web/ui", () => ({ Icon: () => null }));

type HlsEvent = { fatal: boolean; type: string; [key: string]: unknown };
let hlsError: ((event: string, data: HlsEvent) => void) | null;
let supported: boolean;
const destroy = vi.fn();
class FakeHls {
  static Events = { ERROR: "hlsError" };
  static isSupported() {
    return supported;
  }
  loadSource() {}
  attachMedia() {}
  on(_event: string, callback: (event: string, data: HlsEvent) => void) {
    hlsError = callback;
  }
  destroy = destroy;
}
function media(native = true) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    duration: 60,
    currentTime: 0,
    readyState: 4,
    paused: true,
    ended: false,
    seeking: false,
    error: null as { code: number; message: string } | null,
    canPlayType: () => (native ? "probably" : ""),
    addEventListener(name: string, callback: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    removeEventListener(name: string, callback: () => void) {
      listeners.get(name)?.delete(callback);
    },
    emit(name: string) {
      for (const listener of listeners.get(name) || []) listener();
    },
    dispatchEvent(event: Event) {
      for (const listener of listeners.get(event.type) || []) listener();
      return true;
    },
    removeAttribute() {},
    load() {},
  };
}
async function render(element: ReturnType<typeof media>, preview = false) {
  hooks.element = element;
  const { Player } = await import("../web/Player");
  Player({
    videoId: "video",
    versionId: "version",
    timelineId: "timeline",
    title: "Fixture",
    preview,
  });
  for (const effect of hooks.effects)
    effect.cleanup = effect.effect() || undefined;
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
}
const reportCalls = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.filter(([path]) => path === "/api/report");
const payload = (fetch: ReturnType<typeof vi.fn>) =>
  JSON.parse(String(reportCalls(fetch)[0][1].body));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-14T12:00:00Z"));
  hooks.refs = [];
  hooks.states = [];
  hooks.effects = [];
  hooks.refIndex = hooks.stateIndex = 0;
  hlsError = null;
  supported = true;
  destroy.mockClear();
  vi.doMock("hls.js", () => ({ default: FakeHls }));
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

describe("actual Player error handlers connect to the selected report transport", () => {
  it("reports native media failure and keeps recovered native playback usable", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetch);
    const element = media();
    await render(element);
    element.error = {
      code: 3,
      message: "https://fixture.invalid/private?token=test-only",
    };
    element.emit("error");
    await vi.advanceTimersByTimeAsync(0);
    expect(payload(fetch)).toEqual({
      code: "playback_native_error",
      videoId: "video",
      versionId: "version",
      nativeErrorCode: 3,
    });
    expect(hooks.states[2]).toBe(true);
    element.emit("error");
    expect(reportCalls(fetch)).toHaveLength(1);
    element.error = null;
    element.emit("playing");
    expect(hooks.states[2]).toBe(false);
  });

  it("reports fatal HLS categories without forwarding raw HLS diagnostics", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetch);
    const element = media(false);
    await render(element);
    expect(hlsError).not.toBeNull();
    hlsError!("hlsError", { fatal: false, type: "networkError" });
    expect(reportCalls(fetch)).toHaveLength(0);
    hlsError!("hlsError", {
      fatal: true,
      type: "networkError",
      url: "https://fixture.invalid/?token=test-only",
      details: "raw detail",
      error: new Error("raw message"),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(payload(fetch)).toEqual({
      code: "playback_hls_fatal",
      videoId: "video",
      versionId: "version",
      hlsErrorType: "networkError",
    });
    expect(destroy).toHaveBeenCalledOnce();
    element.emit("playing");
    expect(hooks.states[2]).toBe(true);
  });

  it("reports unsupported HLS separately from loading the player dependency", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetch);
    supported = false;
    await render(media(false));
    expect(payload(fetch)).toEqual({
      code: "playback_hls_unsupported",
      videoId: "video",
      versionId: "version",
    });
  });

  it.each([false, true])(
    "an unsupported browser path does not offer ineffective reload (preview=%s)",
    async (preview) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ accepted: true }, { status: 202 })),
      );
      supported = false;
      await render(media(false), preview);
      hooks.refIndex = hooks.stateIndex = 0;
      const { Player } = await import("../web/Player");
      const html = renderToStaticMarkup(
        Player({
          videoId: "video",
          versionId: "version",
          timelineId: "timeline",
          title: "Fixture",
          preview,
        }),
      );
      expect(html).toContain("当前浏览器不支持");
      expect(html).toContain("另一款浏览器");
      expect(html).not.toContain("<button");
      if (!preview) {
        expect(html).not.toContain("playback_hls_unsupported");
        expect(html).not.toContain("管理员技术详情");
      }
    },
  );

  it("reports dependency load failure without copying its error text", async () => {
    vi.doMock("hls.js", () => {
      throw new Error("https://fixture.invalid/private?token=test-only");
    });
    const fetch = vi.fn(async () =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetch);
    await render(media(false));
    expect(payload(fetch)).toEqual({
      code: "playback_loader_failed",
      videoId: "video",
      versionId: "version",
    });
  });

  it.each(["native", "fatal", "unsupported", "loader"])(
    "does not anonymously report administrator preview %s failures",
    async (mode) => {
      const fetch = vi.fn(async () =>
        Response.json({ accepted: true }, { status: 202 }),
      );
      vi.stubGlobal("fetch", fetch);
      if (mode === "unsupported") supported = false;
      if (mode === "loader")
        vi.doMock("hls.js", () => {
          throw new Error("test-only preview failure");
        });
      const element = media(mode === "native");
      await render(element, true);
      if (mode === "native") element.emit("error");
      if (mode === "fatal")
        hlsError!("hlsError", { fatal: true, type: "mediaError" });
      await vi.advanceTimersByTimeAsync(0);
      expect(reportCalls(fetch)).toHaveLength(0);
      expect(hooks.states[2]).toBe(true);
    },
  );
});
