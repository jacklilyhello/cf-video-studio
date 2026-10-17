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

const fixture = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  reload: vi.fn(),
  setData: vi.fn(),
}));
vi.mock("../web/client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useLoad: (path: string) => ({
    data: fixture.data[path],
    loading: false,
    error: null,
    reload: fixture.reload,
    setData: fixture.setData,
  }),
}));
import { WatchSettings } from "../web/WatchSettings";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
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
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object"
    ? text((node as Node).props?.children)
    : "";
}
let component: () => unknown;
function render() {
  hooks.s = hooks.r = hooks.e = 0;
  const tree = component();
  for (const e of hooks.effects)
    if (e.run) {
      e.run = false;
      e.cleanup = e.effect() || undefined;
    }
  return tree;
}
function input(id: string, value: unknown) {
  const node = find(render(), "input")
    .concat(find(render(), "select"))
    .find((n) => n.props?.id === id)!;
  (node.props!.onChange as Function)({ target: { value, checked: value } });
}
function button(label: string) {
  return find(render(), "button").find((n) => text(n).includes(label))!;
}
function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
beforeEach(() => {
  hooks.states = [];
  hooks.refs = [];
  hooks.effects = [];
  fixture.reload.mockClear();
  fixture.setData.mockClear();
  fixture.data = {
    "/api/admin/watch": {
      enabled: true,
      configured: true,
      revision: 4,
      updatedAt: 123,
    },
  };
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  for (const e of hooks.effects) e.cleanup?.();
  vi.unstubAllGlobals();
});
it("saves only explicit viewing settings with the observed revision, without returning a password", async () => {
  component = WatchSettings;
  render();
  const fetcher = vi.fn(async (_path: string, _options?: RequestInit) =>
    reply({ enabled: true, configured: true, revision: 5, updatedAt: 456 }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(button("保存观看设置").props!.disabled).toBe(true);
  input("viewing-password", "replacement-password");
  const form = find(render(), "form")[0];
  await (form.props!.onSubmit as Function)({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("/api/admin/watch");
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
    enabled: true,
    password: "replacement-password",
    expectedRevision: 4,
  });
  expect(fixture.setData).toHaveBeenCalledWith({
    enabled: true,
    configured: true,
    revision: 5,
    updatedAt: 456,
  });
  expect(
    find(render(), "input").find((n) => n.props?.id === "viewing-password")
      ?.props!.value,
  ).toBe("");
  expect(text(render())).not.toContain("replacement-password");
});
it("requires explicit buffered-content acknowledgement before global revoke and cannot double submit", async () => {
  component = WatchSettings;
  render();
  let resolve: (r: Response) => void = () => {};
  const fetcher = vi.fn(
    (_path: string, _options?: RequestInit) =>
      new Promise<Response>((r) => (resolve = r)),
  );
  vi.stubGlobal("fetch", fetcher);
  (button("撤销全部访客授权").props!.onClick as Function)();
  expect(text(render())).toContain("已下载或已缓冲的数据无法收回");
  expect(button("确认撤销全部授权").props!.disabled).toBe(true);
  (button("确认撤销全部授权").props!.onClick as Function)();
  expect(fetcher).not.toHaveBeenCalled();
  const check = find(render(), "input").find(
    (n) =>
      n.props?.type === "checkbox" &&
      !n.props?.id &&
      n.props?.checked === false,
  )!;
  (check.props!.onChange as Function)({ target: { checked: true } });
  const action = button("确认撤销全部授权").props!.onClick as Function;
  action();
  action();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
    expectedRevision: 4,
    confirmed: true,
  });
  resolve(
    reply({ enabled: true, configured: true, revision: 5, updatedAt: 456 }),
  );
  await new Promise((r) => setTimeout(r, 0));
  expect(text(render())).toContain("已撤销全部");
});
it("stale revision refusal performs a readback, never automatically resubmits", async () => {
  component = WatchSettings;
  render();
  const fetcher = vi.fn(async () =>
    reply(
      { error: { code: "watch_revision_conflict", message: "设置已变化" } },
      409,
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  input("viewing-password", "replacement-password");
  await (find(render(), "form")[0].props!.onSubmit as Function)({
    preventDefault() {},
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fixture.reload).toHaveBeenCalledTimes(1);
  expect(fixture.setData).not.toHaveBeenCalled();
});
