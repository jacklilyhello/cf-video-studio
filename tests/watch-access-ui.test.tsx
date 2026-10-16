import { afterEach, beforeEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  effects: [] as {
    deps: unknown[];
    effect: () => void | (() => void);
    cleanup?: () => void;
    run: boolean;
  }[],
  s: 0,
  r: 0,
  e: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useState(initial: unknown) {
    const i = hooks.s++;
    if (!(i in hooks.states))
      hooks.states[i] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.states[i],
      (next: unknown) => {
        hooks.states[i] =
          typeof next === "function" ? next(hooks.states[i]) : next;
      },
    ];
  },
  useRef(initial: unknown) {
    return (hooks.refs[hooks.r++] ||= { current: initial });
  },
  useEffect(effect: () => void | (() => void), deps: unknown[] = []) {
    const i = hooks.e++,
      old = hooks.effects[i];
    if (!old || deps.some((v, j) => v !== old.deps[j])) {
      old?.cleanup?.();
      hooks.effects[i] = { effect, deps, run: true };
    }
  },
}));
vi.mock("../web/public-theme", () => ({
  useSiteBrand: () => ({ name: "Video Hub", logoUrl: null }),
  ThemeToggle: () => null,
}));
import { WatchAccess } from "../web/WatchAccess";
import { api } from "../web/client";
type Node = {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
};
function find(node: unknown, type: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap((n) => find(n, type));
  if (!node || typeof node !== "object") return [];
  const n = node as Node;
  return [...(n.type === type ? [n] : []), ...find(n.props?.children, type)];
}
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "string") return node;
  return node && typeof node === "object"
    ? text((node as Node).props?.children)
    : "";
}
const content = {
  type: "private-room",
  props: { children: "Protected content" },
};
function render() {
  hooks.s = hooks.r = hooks.e = 0;
  const tree = WatchAccess({ children: content as never });
  for (const e of hooks.effects)
    if (e.run) {
      e.run = false;
      e.cleanup = e.effect() || undefined;
    }
  return tree as Node;
}
const gated = {
  enabled: true,
  authorized: false,
  configured: true,
  expiresAt: null,
};
const allowed = {
  enabled: true,
  authorized: true,
  configured: true,
  expiresAt: 123456789,
};
function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function changePassword(value = "test-passphrase") {
  const input = find(render(), "input")[0];
  (input.props!.onChange as Function)({ target: { value } });
}
async function login() {
  const form = find(render(), "form")[0];
  await (form.props!.onSubmit as Function)({ preventDefault() {} });
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  hooks.states = [];
  hooks.refs = [];
  hooks.effects = [];
  vi.useFakeTimers();
  const win = new EventTarget();
  Object.assign(win, { setInterval, clearInterval });
  vi.stubGlobal("window", win);
  vi.stubGlobal("location", {
    pathname: "/video",
    search: "?video=keep",
    href: "https://fixture.invalid/video?video=keep",
  });
});
afterEach(() => {
  for (const e of hooks.effects) e.cleanup?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("does not mount protected children until session proves authorization; disabled access remains open", async () => {
  const fetcher = vi.fn(async (_path: string) => reply(gated));
  vi.stubGlobal("fetch", fetcher);
  expect(text(render())).not.toContain("Protected content");
  await settle();
  expect(text(render())).toContain("输入观看口令");
  expect(fetcher.mock.calls).toHaveLength(1);
  expect(fetcher.mock.calls[0][0]).toBe("/api/watch/session");
  fetcher.mockImplementation(async () =>
    reply({ enabled: false, authorized: true, configured: false }),
  );
  window.dispatchEvent(new Event("focus"));
  await settle();
  expect(render().props!.children).toBe(content);
  expect(render().props!.value).toBeNull();
});
it("confirms the browser Cookie with GET after a single login POST, preserving the original URL", async () => {
  const fetcher = vi.fn(async (path: string) =>
    reply(path === "/api/watch/login" ? allowed : gated),
  );
  vi.stubGlobal("fetch", fetcher);
  render();
  await settle();
  changePassword();
  const form = find(render(), "form")[0];
  const first = (form.props!.onSubmit as Function)({ preventDefault() {} });
  const second = (form.props!.onSubmit as Function)({ preventDefault() {} });
  await Promise.all([first, second]);
  expect(fetcher.mock.calls.map((c) => c[0])).toEqual([
    "/api/watch/session",
    "/api/watch/login",
    "/api/watch/session",
  ]);
  expect(text(render())).toContain("浏览器未接受");
  expect(location.search).toBe("?video=keep");
  fetcher.mockImplementation(async () => reply(allowed));
  changePassword();
  await login();
  expect(render().props!.children).toBe(content);
});
it.each(["focus", "pageshow", "timer"])(
  "rechecks authorization on %s and unmounts content when revoked",
  async (trigger) => {
    const fetcher = vi.fn(async () => reply(allowed));
    vi.stubGlobal("fetch", fetcher);
    render();
    await settle();
    expect(render().props!.children).toBe(content);
    fetcher.mockImplementation(async () => reply(gated));
    if (trigger === "timer") await vi.advanceTimersByTimeAsync(30000);
    else {
      window.dispatchEvent(new Event(trigger));
      await settle();
    }
    expect(text(render())).toContain("输入观看口令");
  },
);
it("a protected API rejection immediately closes content while its session recheck is pending", async () => {
  let resolve: (r: Response) => void = () => {};
  let next = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) =>
      path.startsWith("/api/videos")
        ? Promise.resolve(
            reply(
              { error: { code: "watch_required", message: "private-detail" } },
              401,
            ),
          )
        : next
          ? new Promise<Response>((r) => (resolve = r))
          : Promise.resolve(reply(allowed)),
    ),
  );
  render();
  await settle();
  next = true;
  await expect(api("/api/videos/one")).rejects.toMatchObject({
    code: "watch_required",
  });
  expect(text(render())).not.toContain("Protected content");
  resolve(reply(gated));
  await settle();
  expect(text(render())).toContain("输入观看口令");
  expect(text(render())).not.toContain("private-detail");
});
it("does not self-retry a session failure or mount content on malformed receipts", async () => {
  const fetcher = vi.fn(async () =>
    reply({ error: { code: "watch_unavailable" } }, 503),
  );
  vi.stubGlobal("fetch", fetcher);
  render();
  await settle();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(text(render())).toContain("暂时无法核验");
  expect(text(render())).not.toContain("Protected content");
});
it("logout closes immediately, ignores an older session receipt and preserves unrelated Cookie/history/theme state", async () => {
  let late: (r: Response) => void = () => {};
  let refreshed = false;
  const fetcher = vi.fn((path: string) =>
    path === "/api/watch/logout"
      ? Promise.resolve(reply({ enabled: true, authorized: false }))
      : refreshed
        ? new Promise<Response>((r) => (late = r))
        : Promise.resolve(reply(allowed)),
  );
  vi.stubGlobal("fetch", fetcher);
  render();
  await settle();
  const logout = (render().props!.value as { logout: () => void }).logout;
  refreshed = true;
  window.dispatchEvent(new Event("focus"));
  logout();
  expect(text(render())).not.toContain("Protected content");
  late(reply(allowed));
  await settle();
  expect(text(render())).not.toContain("Protected content");
  expect(
    fetcher.mock.calls.every((c) => String(c[0]).startsWith("/api/watch/")),
  ).toBe(true);
  expect(location.search).toBe("?video=keep");
});
it("failed logout stays closed without silently reauthorizing on polling", async () => {
  const fetcher = vi.fn(async (path: string) =>
    path === "/api/watch/logout"
      ? reply({ error: { code: "unavailable" } }, 503)
      : reply(allowed),
  );
  vi.stubGlobal("fetch", fetcher);
  render();
  await settle();
  (render().props!.value as { logout: () => void }).logout();
  await settle();
  expect(text(render())).toContain("重试退出观看");
  const count = fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetcher.mock.calls.length).toBe(count);
  expect(text(render())).not.toContain("Protected content");
});
it("does not present visitor logout for administrator bypass", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => reply({ ...allowed, expiresAt: null })),
  );
  render();
  await settle();
  expect(render().props!.children).toBe(content);
  expect(render().props!.value).toBeNull();
});
it("late session responses after unmount cannot authorize a new view", async () => {
  let resolve: (r: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((r) => (resolve = r))),
  );
  render();
  for (const e of hooks.effects) e.cleanup?.();
  resolve(reply(allowed));
  await settle();
  expect(text(render())).not.toContain("Protected content");
});

it("bounds an unavailable initial session check to five seconds without automatic retry", async () => {
  const fetcher = vi.fn(
    (_path: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        options.signal!.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  render();
  await vi.advanceTimersByTimeAsync(4999);
  expect(text(render())).not.toContain("暂时无法核验");
  await vi.advanceTimersByTimeAsync(1);
  expect(text(render())).toContain("暂时无法核验观看权限");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(text(render())).not.toContain("Protected content");
});
it("confirms logout through the current session without clearing visitor history or theme", async () => {
  let loggedOut = false;
  const fetcher = vi.fn(async (path: string) => {
    if (path === "/api/watch/logout") loggedOut = true;
    return reply(loggedOut ? gated : allowed);
  });
  vi.stubGlobal("fetch", fetcher);
  render();
  await settle();
  (render().props!.value as { logout: () => void }).logout();
  await settle();
  expect(text(render())).toContain("输入观看口令");
  expect(text(render())).not.toContain("Protected content");
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    "/api/watch/session",
    "/api/watch/logout",
    "/api/watch/session",
  ]);
  expect(location.search).toBe("?video=keep");
});
it("shows a fixed login error rather than backend diagnostics", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      path === "/api/watch/login"
        ? reply(
            {
              error: {
                code: "watch_password",
                message: "sensitive-internal-diagnostic",
              },
            },
            401,
          )
        : reply(gated),
    ),
  );
  render();
  await settle();
  changePassword();
  await login();
  expect(text(render())).toContain("观看口令不正确或已更新");
  expect(text(render())).not.toContain("sensitive-internal-diagnostic");
});
