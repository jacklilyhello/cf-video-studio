import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  authenticated: false,
  states: [] as unknown[],
  index: 0,
  effects: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[],
  reload: vi.fn(),
  send: vi.fn(),
  brand: {
    name: "山月放映室",
    logoUrl: `/site-logo/${"a".repeat(64)}.png`,
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useState(initial: unknown) {
    const index = fixture.index++;
    if (!(index in fixture.states))
      fixture.states[index] =
        typeof initial === "function" ? initial() : initial;
    return [
      fixture.states[index],
      (next: unknown) => (fixture.states[index] = next),
    ];
  },
  useEffect(effect: () => void | (() => void)) {
    fixture.effects.push(effect);
  },
}));
vi.mock("../web/client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useLoad(path: string) {
    expect(path).toBe("/api/admin/session");
    return {
      data: { authenticated: fixture.authenticated, configured: true },
      loading: false,
      error: null,
      reload: fixture.reload,
    };
  },
  send: fixture.send,
}));
vi.mock("../web/public-theme", () => ({
  useSiteBrand: () => fixture.brand,
  ThemeToggle: function ThemeToggle() {
    return null;
  },
}));
import { Admin } from "../web/Admin";

type Node = {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
};
function find(node: unknown, matches: (item: Node) => boolean): Node[] {
  if (Array.isArray(node)) return node.flatMap((item) => find(item, matches));
  if (!node || typeof node !== "object") return [];
  const item = node as Node;
  return [
    ...(matches(item) ? [item] : []),
    ...find(item.props?.children, matches),
  ];
}
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object"
    ? text((node as Node).props?.children)
    : "";
}
function render() {
  fixture.index = 0;
  return Admin();
}
function components(tree: unknown, name: string) {
  return find(
    tree,
    (item) => typeof item.type === "function" && item.type.name === name,
  );
}
beforeEach(() => {
  fixture.authenticated = false;
  fixture.states = [];
  fixture.index = 0;
  fixture.effects = [];
  fixture.cleanups = [];
  fixture.send.mockReset().mockResolvedValue({});
  fixture.reload.mockReset();
  vi.stubGlobal("location", { pathname: "/admin/library" });
  vi.stubGlobal("document", { title: "" });
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  for (const cleanup of fixture.cleanups) cleanup();
  vi.unstubAllGlobals();
});
it("uses configured branding and the shared theme control on the guarded login page", () => {
  const tree = render();
  expect(tree.props.className).toBe("login-page admin-login");
  expect(components(tree, "ThemeToggle")).toHaveLength(1);
  expect(components(tree, "Logo")[0].props?.brand).toBe(fixture.brand);
  expect(find(tree, (item) => item.type === "a")[0].props?.href).toBe("/video");
  expect(components(tree, "Library")).toHaveLength(0);
  expect(text(tree)).toContain("管理员密码");
  for (const effect of fixture.effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) fixture.cleanups.push(cleanup);
  }
  expect(document.title).toBe("管理后台 · 山月放映室");
  expect(fixture.send).not.toHaveBeenCalled();
});
it("keeps administrator login on its existing endpoint and clears the input after success", async () => {
  let tree = render();
  const password = find(tree, (item) => item.type === "input")[0];
  expect(password.props).toMatchObject({
    type: "password",
    autoComplete: "current-password",
  });
  (password.props!.onChange as (event: unknown) => void)({
    target: { value: "fixture-login-value" },
  });
  tree = render();
  const form = find(tree, (item) => item.type === "form")[0];
  const preventDefault = vi.fn();
  await (form.props!.onSubmit as (event: unknown) => Promise<void>)({
    preventDefault,
  });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(fixture.send).toHaveBeenCalledExactlyOnceWith("/api/admin/login", {
    password: "fixture-login-value",
  });
  expect(fixture.reload).toHaveBeenCalledOnce();
  expect(find(render(), (item) => item.type === "input")[0].props?.value).toBe(
    "",
  );
});
it("reuses the theme control in the authenticated shell, exposes current navigation and keeps views behind the session", () => {
  fixture.authenticated = true;
  const tree = render();
  expect(tree.props.className).toBe("admin-app");
  expect(components(tree, "ThemeToggle")).toHaveLength(1);
  expect(components(tree, "Logo")[0].props?.brand).toBe(fixture.brand);
  expect(components(tree, "Library")).toHaveLength(1);
  expect(
    find(tree, (item) => item.props?.["aria-current"] === "page").map(text),
  ).toEqual(["视频库"]);
  expect(
    find(tree, (item) => item.props?.["aria-controls"] === "admin-navigation"),
  ).toHaveLength(1);
  expect(
    find(tree, (item) => item.props?.id === "admin-content")[0].props?.tabIndex,
  ).toBe(-1);
  expect(text(tree)).toContain("资源用量");
  expect(text(find(tree, (item) => item.type === "footer")[0])).toContain(
    fixture.brand.name,
  );
  expect(fixture.send).not.toHaveBeenCalled();
});
