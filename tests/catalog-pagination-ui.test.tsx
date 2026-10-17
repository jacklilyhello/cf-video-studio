import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type PaginationProps = {
  page: number;
  total: number;
  pageSize: number;
  onPage(page: number): void;
};
const fixture = vi.hoisted(() => ({
  data: {
    items: [] as Record<string, unknown>[],
    page: 1,
    total: 0,
    pageSize: 12,
  },
  paths: [] as string[],
  pagers: [] as PaginationProps[],
  root: null as ReactNode,
  reload: vi.fn(),
  historyData: {
    items: [] as Record<string, unknown>[],
    cookieEnabled: true,
    writeContext: "a".repeat(64) as string | null,
  },
  historySetData: vi.fn(),
  buttons: [] as { children?: unknown; onClick?: () => void }[],
  refs: [] as { current: unknown }[],
  states: [] as unknown[],
  effects: [] as {
    deps: unknown[];
    callback: () => void | (() => void);
    cleanup?: () => void;
    run: boolean;
  }[],
  refIndex: 0,
  stateIndex: 0,
  effectIndex: 0,
}));
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  const capture = (type: unknown, props: unknown) => {
    if (type === "button")
      fixture.buttons.push(props as (typeof fixture.buttons)[number]);
  };
  return {
    ...actual,
    jsx: (...args: Parameters<typeof actual.jsx>) => {
      capture(args[0], args[1]);
      return actual.jsx(...args);
    },
    jsxs: (...args: Parameters<typeof actual.jsxs>) => {
      capture(args[0], args[1]);
      return actual.jsxs(...args);
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      if (args[0] === "button")
        fixture.buttons.push(args[1] as (typeof fixture.buttons)[number]);
      return actual.jsxDEV(...args);
    },
  };
});
vi.mock("react", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useRef(initial: unknown) {
    const index = fixture.refIndex++;
    return (fixture.refs[index] ||= { current: initial });
  },
  useState(initial: unknown) {
    const index = fixture.stateIndex++;
    if (!(index in fixture.states))
      fixture.states[index] =
        typeof initial === "function" ? initial() : initial;
    return [
      fixture.states[index],
      (next: unknown) => {
        fixture.states[index] =
          typeof next === "function" ? next(fixture.states[index]) : next;
      },
    ];
  },
  useEffect(callback: () => void | (() => void), deps: unknown[] = []) {
    const index = fixture.effectIndex++;
    const old = fixture.effects[index];
    if (!old || deps.some((value, i) => value !== old.deps[i])) {
      old?.cleanup?.();
      fixture.effects[index] = { callback, deps, run: true };
    }
  },
}));
vi.mock("react-dom/client", () => ({
  createRoot: () => ({
    render: (node: ReactNode) => {
      fixture.root = node;
    },
    unmount: vi.fn(),
  }),
}));
vi.mock("../web/client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  api: vi.fn(async () => ({})),
  useLoad(path: string | null) {
    if (path) fixture.paths.push(path);
    const data =
      path?.startsWith("/api/admin/videos?") || path?.startsWith("/api/videos?")
        ? fixture.data
        : path === "/api/admin/session"
          ? { authenticated: true, configured: true }
          : path === "/api/history"
            ? fixture.historyData
            : path === "/api/config"
              ? { configured: true, progressIntervalSeconds: 20 }
              : {
                  items: [],
                  total: 0,
                  page: 1,
                  pageSize: 50,
                  cookieEnabled: true,
                };
    return {
      data,
      loading: false,
      error: null,
      reload: fixture.reload,
      setData: path === "/api/history" ? fixture.historySetData : vi.fn(),
    };
  },
}));
vi.mock("../web/ui", async (original) => {
  const actual = await original<typeof import("../web/ui")>();
  return {
    ...actual,
    Pagination(props: PaginationProps) {
      fixture.pagers.push(props);
      return actual.Pagination(props);
    },
  };
});

const video = {
  id: "video",
  title: "Fixture",
  duration: 60,
  versionId: "version",
  timelineId: "timeline",
  updatedAt: 1,
  source_name: "fixture.mp4",
  source_size: 7,
  status: "ready",
  published: 1,
  updated_at: 1,
};
let tree: ReactNode;
function render() {
  fixture.refIndex = fixture.stateIndex = fixture.effectIndex = 0;
  fixture.pagers = [];
  fixture.buttons = [];
  const markup = renderToStaticMarkup(tree);
  for (const effect of fixture.effects)
    if (effect.run) {
      effect.run = false;
      effect.cleanup = effect.callback() || undefined;
    }
  return markup;
}
function previousDisabled(markup: string) {
  const previous = [
    ...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g),
  ].find((match) => match[2].includes("上一页"));
  expect(previous).toBeDefined();
  return previous![1].includes("disabled");
}
async function mount(admin: boolean) {
  fixture.data = {
    items: [video],
    page: 1,
    total: admin ? 21 : 13,
    pageSize: admin ? 20 : 12,
  };
  vi.stubGlobal("location", {
    pathname: admin ? "/admin/library" : "/video",
    search: "",
    origin: "https://fixture.invalid",
  });
  if (admin) {
    const { Admin } = await import("../web/Admin");
    tree = createElement(Admin);
  } else {
    const { PublicSite } = await import("../web/PublicSite");
    tree = createElement(PublicSite);
  }
  render();
  await vi.advanceTimersByTimeAsync(0);
  render();
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  fixture.refs = [];
  fixture.states = [];
  fixture.effects = [];
  fixture.paths = [];
  fixture.pagers = [];
  fixture.root = null;
  fixture.historyData = {
    items: [],
    cookieEnabled: true,
    writeContext: "a".repeat(64),
  };
  fixture.historySetData.mockClear();
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    scrollTo: vi.fn(),
  });
  vi.stubGlobal("document", {
    title: "",
    getElementById: () => ({}),
    body: { style: { overflow: "" } },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("BroadcastChannel", undefined);
});
afterEach(() => {
  for (const effect of fixture.effects) effect.cleanup?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each([false, true])(
  "actual %s catalog components preserve pagination escape",
  (admin) => {
    it("renders one usable previous-page control for a successful empty second page with a positive total", async () => {
      await mount(admin);
      fixture.pagers[0].onPage(2);
      fixture.data = { ...fixture.data, items: [], page: 2 };
      const markup = render();
      expect(fixture.pagers).toHaveLength(1);
      expect(fixture.pagers[0]).toMatchObject({
        page: 2,
        total: admin ? 21 : 13,
      });
      expect(previousDisabled(markup)).toBe(false);
      fixture.pagers[0].onPage(1);
      fixture.data = { ...fixture.data, items: [video], page: 1 };
      expect(previousDisabled(render())).toBe(true);
    });

    it("synchronizes a server-clamped effective page back into component state and the next query", async () => {
      await mount(admin);
      fixture.pagers[0].onPage(2);
      fixture.data = { ...fixture.data, page: 2 };
      render();
      fixture.data = { ...fixture.data, page: 1, total: admin ? 20 : 12 };
      render();
      const markup = render();
      expect(fixture.pagers).toHaveLength(1);
      expect(fixture.pagers[0].page).toBe(1);
      expect(previousDisabled(markup)).toBe(true);
      const lastQuery = fixture.paths
        .filter((path) =>
          path.startsWith(admin ? "/api/admin/videos?" : "/api/videos?"),
        )
        .at(-1);
      expect(
        new URL(lastQuery!, "https://fixture.invalid").searchParams.get("page"),
      ).toBe("1");
    });

    it("hides pagination when a successful catalog really has zero results", async () => {
      await mount(admin);
      fixture.data = { ...fixture.data, items: [], total: 0 };
      const markup = render();
      expect(fixture.pagers).toHaveLength(0);
      expect(markup).not.toContain("上一页");
    });
  },
);

describe("video cards render numeric watched flags as UI state", () => {
  it.each([0, 1])(
    "renders watched=%s without a stray numeric text node",
    async (watched) => {
      fixture.historyData.items = [
        {
          videoId: "video",
          title: "Fixture",
          timelineId: "timeline",
          position: 25,
          duration: 60,
          watched,
          updatedAt: 1,
        },
      ];
      await mount(false);
      const markup = render();
      const cover = markup.match(
        /<div class="video-cover cover-0">([\s\S]*?)<\/div><div class="video-info">/,
      )?.[1];
      expect(cover).toBeDefined();
      expect(cover).not.toMatch(/>0</);
      expect(cover).toContain('class="cover-number">01</span>');
      expect(cover).toContain('class="cover-duration">1:00</span>');
      expect(cover!.includes("watched-badge")).toBe(watched === 1);
      expect(cover!.includes("cover-progress")).toBe(watched === 0);
    },
  );
});

describe("empty visible history still supports current-host erasure", () => {
  it("renders room navigation and footer without an administrator entry", async () => {
    await mount(false);
    const markup = render();
    expect(markup).toContain('href="/video"');
    expect(markup).toContain("观看记录");
    expect(markup).toContain("切换至月夜深色模式");
    expect(markup).not.toContain('href="/admin');
    expect(markup).not.toContain("管理后台");
  });
  it("opens existing confirmation and performs DELETE/reset/broadcast without visible or hidden video identifiers", async () => {
    const posted = vi.fn();
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage: unknown;
        postMessage = posted;
        close() {}
      },
    );
    await mount(false);
    const { api, WatchProgressQueue } = await import("../web/client");
    const reset = vi.spyOn(WatchProgressQueue.prototype, "reset");
    const markup = render();
    expect(markup).toContain("清除当前域名历史");
    expect(markup).not.toContain("history-card");
    expect(
      vi
        .mocked(api)
        .mock.calls.some(
          ([path, options]) =>
            path === "/api/history" && options?.method === "DELETE",
        ),
    ).toBe(false);
    fixture.buttons.find((button) => button.children === "清除当前域名历史")!
      .onClick!();
    expect(render()).toContain(
      "将清除当前浏览器、当前域名下的全部观看记录和续播位置。",
    );
    fixture.buttons.find((button) => button.children === "确认清除")!
      .onClick!();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      vi
        .mocked(api)
        .mock.calls.filter(
          ([path, options]) =>
            path === "/api/history" && options?.method === "DELETE",
        ),
    ).toEqual([["/api/history", { method: "DELETE" }, 4000]]);
    expect(reset).toHaveBeenCalledOnce();
    expect(fixture.historySetData).toHaveBeenCalledWith({
      items: [],
      cookieEnabled: false,
      writeContext: null,
    });
    expect(posted.mock.calls).toEqual([["cleared"], ["ready"]]);
    expect(fixture.reload).toHaveBeenCalled();
  });

  it("does not promise history deletion when a visitor Cookie is unavailable", async () => {
    fixture.historyData = {
      items: [],
      cookieEnabled: false,
      writeContext: null,
    };
    await mount(false);
    const markup = render();
    expect(markup).not.toContain("清除当前域名历史");
    expect(markup).not.toContain("确认清除");
    expect(markup).toContain("浏览器未接受观看记录 Cookie");
  });
});
