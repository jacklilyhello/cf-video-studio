import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const fixture = vi.hoisted(() => ({
  paths: [] as string[],
  roomImports: 0,
  adminImports: 0,
  api: vi.fn(),
  name: "山月放映室",
}));
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render() {}, unmount() {} }),
}));
vi.mock("../web/client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  api: fixture.api,
  useLoad(path: string) {
    fixture.paths.push(path);
    return {
      data: {
        name: fixture.name,
        logoUrl: null,
        searchIndexing: false,
        updatedAt: 1,
      },
      reload() {},
    };
  },
}));
vi.mock("../web/PublicSite", () => {
  fixture.roomImports++;
  return {
    PublicSite: () =>
      createElement("main", { "data-room": true }, "Actual route boundary"),
  };
});
vi.mock("../web/Admin", () => {
  fixture.adminImports++;
  return {
    Admin: () =>
      createElement("main", { "data-admin": true }, "Admin route boundary"),
  };
});
beforeEach(() => {
  vi.resetModules();
  fixture.paths = [];
  fixture.roomImports = fixture.adminImports = 0;
  fixture.api.mockClear();
  vi.stubGlobal("location", { pathname: "/", search: "" });
  vi.stubGlobal("document", {
    getElementById: () => ({}),
    documentElement: { getAttribute: () => "light" },
  });
});
afterEach(() => vi.unstubAllGlobals());
it("renders an independent branded welcome with a relative room link, no admin entry and no player/history/catalog loading", async () => {
  const { App } = await import("../web/main");
  const html = renderToStaticMarkup(createElement(App));
  expect(html).toContain("好故事");
  expect(html).toContain("山月放映室");
  expect(html).toContain('href="/video"');
  expect(html).toContain("进入放映室");
  expect(html).toContain("moonwater-landscape");
  expect(html).toContain("切换至月夜深色模式");
  expect(html).not.toContain("/admin");
  expect(html).not.toContain("<video");
  expect(html).not.toContain("搜索视频");
  expect(fixture.paths).toEqual(["/api/site"]);
  expect(fixture.api).not.toHaveBeenCalled();
  await vi.dynamicImportSettled();
  expect(fixture.roomImports).toBe(0);
  expect(fixture.adminImports).toBe(0);
});
it.each(["/video", "/"])(
  "gates the room before loading catalog or media for its route or a legacy link (%s)",
  async (pathname) => {
    vi.stubGlobal("location", { pathname, search: "?video=example" });
    const { App } = await import("../web/main");
    renderToStaticMarkup(createElement(App));
    await vi.dynamicImportSettled();
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("正在核验观看权限");
    expect(html).not.toContain('data-room="true"');
    expect(fixture.roomImports).toBe(0);
    expect(html).not.toContain("welcome-hero");
    expect(fixture.paths).toEqual(["/api/site", "/api/site"]);
    expect(fixture.adminImports).toBe(0);
  },
);
it("preserves the separate lazy admin route without mounting public branding or theme", async () => {
  vi.stubGlobal("location", { pathname: "/admin/settings", search: "" });
  const { App } = await import("../web/main");
  renderToStaticMarkup(createElement(App));
  await vi.dynamicImportSettled();
  expect(renderToStaticMarkup(createElement(App))).toContain(
    'data-admin="true"',
  );
  expect(fixture.roomImports).toBe(0);
  expect(fixture.paths).toEqual([]);
});
