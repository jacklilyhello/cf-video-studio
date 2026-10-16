import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: URL, encoding: string): string;
};
const { runInNewContext } = (await import("node:vm" as string)) as {
  runInNewContext(code: string, context: Record<string, unknown>): unknown;
};

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  effects: [] as (() => void | (() => void))[],
  state: 0,
  ref: 0,
  cleanups: [] as (() => void)[],
  reload: vi.fn(),
  paths: [] as string[],
}));
vi.mock("react", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useState(initial: unknown) {
    const index = hooks.state++;
    if (!(index in hooks.states))
      hooks.states[index] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.states[index],
      (next: unknown) => {
        hooks.states[index] =
          typeof next === "function" ? next(hooks.states[index]) : next;
      },
    ];
  },
  useRef(initial: unknown) {
    return (hooks.refs[hooks.ref++] ||= { current: initial });
  },
  useEffect(effect: () => void | (() => void)) {
    hooks.effects.push(effect);
  },
}));
vi.mock("../web/client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useLoad: (path: string) => {
    hooks.paths.push(path);
    return { data: { name: "月白小筑", logoUrl: null }, reload: hooks.reload };
  },
}));
import {
  applyPublicTheme,
  normalizeSiteBrand,
  ThemeToggle,
  THEME_STORAGE_KEY,
  useSiteBrand,
} from "../web/public-theme";
import { Logo } from "../web/ui";
import { Welcome } from "../web/Welcome";

type Node = { type?: unknown; props: Record<string, unknown> };
function find(node: unknown, type: string): Node | undefined {
  if (!node || typeof node !== "object") return;
  const value = node as Node;
  if (value.type === type) return value;
  return [value.props?.children]
    .flat(Infinity)
    .map((child) => find(child, type))
    .find(Boolean);
}
class Query extends EventTarget {
  matches = false;
}
class Document extends EventTarget {
  title = "";
  visibilityState = "visible";
  attributes = new Map<string, string>();
  meta = new Map<string, string>();
  documentElement = {
    getAttribute: (key: string) => this.attributes.get(key) ?? null,
    setAttribute: (key: string, value: string) => {
      this.attributes.set(key, value);
    },
  };
  querySelector() {
    return {
      setAttribute: (key: string, value: string) => {
        this.meta.set(key, value);
      },
    };
  }
}
let document: Document, window: EventTarget, query: Query;
let values: Map<string, string>, writes: [string, string][];
let channel: {
  onmessage: ((event: { data: unknown }) => void) | null;
  close: ReturnType<typeof vi.fn>;
};
const bootstrap = readFileSync(
  new URL("../web/public/public-theme.js", import.meta.url),
  "utf8",
);
function renderToggle() {
  hooks.state = hooks.ref = 0;
  return ThemeToggle();
}
function effects() {
  for (const effect of hooks.effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  }
}
beforeEach(() => {
  hooks.states = [];
  hooks.refs = [];
  hooks.effects = [];
  hooks.cleanups = [];
  hooks.state = hooks.ref = 0;
  hooks.reload.mockClear();
  hooks.paths = [];
  document = new Document();
  window = new EventTarget();
  query = new Query();
  values = new Map();
  writes = [];
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("matchMedia", () => query);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
      writes.push([key, value]);
    },
  });
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage = null;
      close = vi.fn();
      constructor(name: string) {
        expect(name).toBe("video-hub-site");
        channel = this;
      }
    },
  );
});
afterEach(() => {
  for (const cleanup of hooks.cleanups) cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it.each(["/", "/video", "/admin", "/admin/usage"])(
  "applies the shared persisted theme before app/styles at %s, without storing any identity",
  (path) => {
    values.set(THEME_STORAGE_KEY, "dark");
    runInNewContext(bootstrap, {
      location: { pathname: path },
      localStorage,
      matchMedia,
      document,
    });
    expect(document.attributes.get("data-public-theme")).toBe("dark");
    expect(document.meta.get("content")).toBe("#18313d");
    expect(writes).toEqual([]);
    const html = readFileSync(
      new URL("../web/index.html", import.meta.url),
      "utf8",
    );
    expect(html.indexOf('src="/public-theme.js"')).toBeLessThan(
      html.indexOf('src="/main.tsx"'),
    );
    for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))
      expect(script[1].trim()).toBe("");
  },
);
it("uses the same OS preference on public and admin pages without storage", () => {
  query.matches = true;
  const blocked = {
    getItem() {
      throw new Error("blocked");
    },
  };
  runInNewContext(bootstrap, {
    location: { pathname: "/video" },
    localStorage: blocked,
    matchMedia,
    document,
  });
  expect(document.attributes.get("data-public-theme")).toBe("dark");
  document.attributes.clear();
  runInNewContext(bootstrap, {
    location: { pathname: "/admin/settings" },
    localStorage: blocked,
    matchMedia,
    document,
  });
  expect(document.attributes.get("data-public-theme")).toBe("dark");
});
it("exposes a keyboard button, follows OS until a manual choice and synchronizes another tab's theme", () => {
  let button = renderToggle();
  effects();
  expect(button.props["aria-label"]).toContain("月夜");
  query.matches = true;
  query.dispatchEvent(new Event("change"));
  button = renderToggle();
  expect(button.props["aria-pressed"]).toBe(true);
  button.props.onClick();
  button = renderToggle();
  expect(button.type).toBe("button");
  expect(button.props["aria-pressed"]).toBe(false);
  expect(writes).toEqual([[THEME_STORAGE_KEY, "light"]]);
  query.dispatchEvent(new Event("change"));
  expect(document.attributes.get("data-public-theme")).toBe("light");
  values.set(THEME_STORAGE_KEY, "dark");
  window.dispatchEvent(
    Object.assign(new Event("storage"), { key: THEME_STORAGE_KEY }),
  );
  expect(renderToggle().props["aria-pressed"]).toBe(true);
  expect(writes).toHaveLength(1);
});
it("retains a manual choice in the current page when preference storage is blocked", () => {
  vi.stubGlobal("localStorage", {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  });
  const button = renderToggle();
  effects();
  button.props.onClick();
  query.dispatchEvent(new Event("change"));
  expect(document.attributes.get("data-public-theme")).toBe("dark");
  expect(renderToggle().props["aria-pressed"]).toBe(true);
});
it("refreshes site branding on return or an admin change, coalesces events and closes listeners", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  expect(useSiteBrand().name).toBe("月白小筑");
  effects();
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  channel.onmessage?.({ data: "changed" });
  expect(hooks.reload).toHaveBeenCalledTimes(1);
  vi.setSystemTime(2001);
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(hooks.reload).toHaveBeenCalledTimes(1);
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(hooks.reload).toHaveBeenCalledTimes(2);
  vi.setSystemTime(3002);
  window.dispatchEvent(new Event("hub-site-changed"));
  expect(hooks.reload).toHaveBeenCalledTimes(3);
  for (const cleanup of hooks.cleanups.splice(0)) cleanup();
  vi.setSystemTime(4003);
  window.dispatchEvent(new Event("focus"));
  expect(hooks.reload).toHaveBeenCalledTimes(3);
  expect(channel.close).toHaveBeenCalledOnce();
});
it("uses safe fallback branding and retires a failed logo without hiding the configured name", () => {
  expect(
    normalizeSiteBrand({ name: " ", logoUrl: "javascript:bad" }),
  ).toMatchObject({ name: "Video Hub", logoUrl: null });
  const brand = {
    name: "月白小筑",
    logoUrl: `/site-logo/${"a".repeat(64)}.png`,
  };
  let tree = Logo({ brand });
  const image = find(tree, "img")!;
  expect(image.props.src).toBe(brand.logoUrl);
  expect(image.props.alt).toBe("");
  (image.props.onError as () => void)();
  hooks.state = 0;
  tree = Logo({ brand });
  expect(find(tree, "img")).toBeUndefined();
  expect(find(tree, "a")?.props.href).toBe("/");
  hooks.state = 0;
  expect(
    find(
      Logo({
        brand: { ...brand, logoUrl: `/site-logo/${"b".repeat(64)}.jpg` },
      }),
      "img",
    ),
  ).toBeDefined();
  applyPublicTheme("light");
  expect(document.attributes.get("data-public-theme")).toBe("light");
});

it.each(["png", "jpg"])(
  "accepts only the server's exact relative content-addressed %s logo",
  (extension) => {
    const path = `/site-logo/${"a".repeat(64)}.${extension}`;
    expect(normalizeSiteBrand({ name: "山月", logoUrl: path })).toMatchObject({
      name: "山月",
      logoUrl: path,
    });
  },
);

it.each([
  "https://fixture.invalid/site-logo/" + "a".repeat(64) + ".png",
  "https://external.invalid/logo.png",
  "//external.invalid/logo.png",
  "/\\external.invalid/logo.png",
  "/api/site/logo",
  `/site-logo/${"a".repeat(63)}.png`,
  `/site-logo/${"a".repeat(65)}.png`,
  `/site-logo/${"A".repeat(64)}.png`,
  `/site-logo/${"a".repeat(64)}.svg`,
  `/site-logo/${"a".repeat(64)}.jpeg`,
  `/site-logo/${"a".repeat(64)}.png?revision=1`,
  `/site-logo/${"a".repeat(64)}.png#fragment`,
  `/site-logo/${"a".repeat(64)}.png\n`,
  ` /site-logo/${"a".repeat(64)}.png`,
  `/site-logo/%2f${"a".repeat(64)}.png`,
  "data:image/png;base64,AAAA",
  null,
])("rejects a non-contract logo address: %s", (path) => {
  expect(normalizeSiteBrand({ name: "山月", logoUrl: path })).toMatchObject({
    name: "山月",
    logoUrl: null,
  });
});

it("retains a brand change arriving just after focus as one bounded trailing refresh", async () => {
  vi.useFakeTimers();
  useSiteBrand();
  effects();
  window.dispatchEvent(new Event("focus"));
  expect(hooks.reload).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500);
  channel.onmessage?.({ data: "changed" });
  window.dispatchEvent(new Event("hub-site-changed"));
  await vi.advanceTimersByTimeAsync(499);
  expect(hooks.reload).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.reload).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(hooks.reload).toHaveBeenCalledTimes(2);
});

it("mounts welcome effects with only site branding, without visitor identity or playback requests", () => {
  const fetcher = vi.fn(() => Promise.reject(new Error("Unexpected request")));
  vi.stubGlobal("fetch", fetcher);
  const html = renderToStaticMarkup(createElement(Welcome));
  effects();
  expect(hooks.paths).toEqual(["/api/site"]);
  expect(fetcher).not.toHaveBeenCalled();
  expect(document.title).toBe("月白小筑 · 月白水碧，静候好故事");
  expect(html.match(/月白小筑/g)).toHaveLength(3);
});
