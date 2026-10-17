import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  frames: new Map<Function, unknown[]>(),
  active: [] as unknown[],
  index: 0,
  detail: {} as {
    video: Record<string, unknown>;
    versions: Record<string, unknown>[];
    jobs: unknown[];
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useEffect: vi.fn(),
  useState(initial: unknown) {
    const state = fixture.active,
      index = fixture.index++;
    if (!(index in state))
      state[index] = typeof initial === "function" ? initial() : initial;
    return [
      state[index],
      (value: unknown) => {
        state[index] =
          typeof value === "function" ? value(state[index]) : value;
      },
    ];
  },
}));
vi.mock("../web/client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useLoad(path: string) {
    return {
      data:
        path === "/api/admin/session"
          ? { authenticated: true, configured: true }
          : path === "/api/config"
            ? { configured: true, processingEnabled: false }
            : path === "/api/admin/videos/video"
              ? fixture.detail
              : {
                  items: [fixture.detail.video],
                  total: 1,
                  page: 1,
                  pageSize: 20,
                },
      loading: false,
      error: null,
      reload: vi.fn(),
      setData: vi.fn(),
    };
  },
}));
import { Admin } from "../web/Admin";
import { Player } from "../web/Player";
import type { SourcePreviewEvidence } from "../web/client";
type Node = {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
};
type Component = (props: Record<string, unknown>) => unknown;
function find(node: unknown, test: (node: Node) => boolean): Node[] {
  if (!node || typeof node !== "object") return [];
  const item = node as Node;
  return [
    ...(test(item) ? [item] : []),
    ...[item.props?.children]
      .flat(Infinity)
      .flatMap((child) => find(child, test)),
  ];
}
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object"
    ? text((node as Node).props?.children)
    : "";
}
function render(component: Component, props: Record<string, unknown> = {}) {
  fixture.active = fixture.frames.get(component) || [];
  fixture.frames.set(component, fixture.active);
  fixture.index = 0;
  return component(props);
}
function child(tree: unknown, name: string) {
  const node = find(
    tree,
    (node) => typeof node.type === "function" && node.type.name === name,
  )[0];
  expect(node).toBeDefined();
  return { component: node.type as Component, props: node.props! };
}
function button(tree: unknown, label: string) {
  const node = find(
    tree,
    (node) => node.type === "button" && text(node) === label,
  )[0];
  expect(node).toBeDefined();
  return node;
}
let detail: ReturnType<typeof child>;
const view = () => render(detail.component, detail.props);
const click = (label: string) => {
  (button(view(), label).props!.onClick as () => void)();
};
function versionButton(id: string, label: string) {
  const row = find(
    view(),
    (node) =>
      node.props?.className === "version-row" && text(node).includes(id),
  )[0];
  (button(row, label).props!.onClick as () => void)();
}
function select(label: string, value: string) {
  const row = find(
    view(),
    (node) => node.type === "label" && text(node).startsWith(label),
  )[0];
  (
    find(row, (node) => node.type === "select")[0].props!.onChange as (
      event: unknown,
    ) => void
  )({ target: { value } });
}
const observed: SourcePreviewEvidence = {
  played: true,
  seeked: true,
  durationSeconds: 60,
  seekFromSeconds: 1,
  seekToSeconds: 30,
};
beforeEach(() => {
  fixture.frames.clear();
  fixture.detail = {
    video: {
      id: "video",
      title: "Fixture",
      source_key: "videos/video/source/revision",
      source_size: 7,
      status: "ready",
      published: 0,
    },
    versions: ["optimized-one", "optimized-two"].map((id) => ({
      id,
      mode: "faststart",
      quality: "source",
      manifest: "optimized.mp4",
      state: "verified",
      timeline_id: `timeline-${id}`,
      duration: 60,
      bytes: 7,
      created_at: 1,
    })),
    jobs: [],
  };
  vi.useFakeTimers();
  vi.stubGlobal("location", {
    pathname: "/admin/library",
    origin: "https://fixture.invalid",
  });
  vi.stubGlobal("window", {
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", { title: "" });
  const library = child(render(Admin), "Library");
  (
    button(render(library.component, library.props), "管理").props!
      .onClick as () => void
  )();
  detail = child(render(library.component, library.props), "VideoDetail");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("selects copy-only source-quality faststart and requests a quote without starting processing", async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      quote: {
        id: "quote",
        mode: "faststart",
        quality: "source",
        expiresAt: Date.now() + 60000,
        data: {
          codec: "copy",
          outputKind: "mp4",
          outputName: "optimized.mp4",
          encoding: "copy-only",
          maxMediaObjects: 1,
          maxUploadAttempts: 3,
        },
      },
      processingEnabled: false,
    }),
  );
  vi.stubGlobal("fetch", fetch);
  select("处理方式", "transcode");
  select("输出画质", "720p");
  select("处理方式", "faststart");
  const quality = find(
    view(),
    (node) => node.type === "select" && node.props?.disabled === true,
  )[0];
  expect(quality.props!.value).toBe("source");
  expect(fetch).not.toHaveBeenCalled();
  expect(text(view())).toContain("不自动转码、发布或替换当前版本");
  click("获取处理报价");
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledOnce();
  const [path, options] = fetch.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(path).toBe("/api/admin/videos/video/quote");
  expect(JSON.parse(String(options.body))).toEqual({
    mode: "faststart",
    quality: "source",
  });
  const dialog = child(view(), "QuoteDialog");
  const quoteView = render(dialog.component, dialog.props);
  const values = child(quoteView, "ProcessingQuoteValues");
  const terms = text(render(values.component, values.props));
  expect(terms).toContain("保留视频与音频编码，不兼容就停止");
  expect(terms).toContain("独立 MP4 文件");
  expect(values.props.data).toMatchObject({
    outputName: "optimized.mp4",
    maxMediaObjects: 1,
    maxUploadAttempts: 3,
  });
  expect(
    button(render(dialog.component, dialog.props), "确认费用并启动任务").props!
      .disabled,
  ).toBe(true);
});

it("requires this version's native preview evidence and explicit audio acknowledgement before MP4 publication", async () => {
  const fetch = vi.fn(async () => Response.json({ published: true }));
  vi.stubGlobal("fetch", fetch);
  versionButton("optimized-one", "选择发布");
  expect(button(view(), "确认发布此版本").props!.disabled).toBe(true);
  click("确认发布此版本");
  expect(fetch).not.toHaveBeenCalled();
  click("预览此 MP4 版本");
  const player = find(view(), (node) => node.type === Player)[0];
  expect(player.props).toMatchObject({
    versionId: "optimized-one",
    mediaKind: "mp4",
    preview: true,
  });
  (
    player.props!.onPreviewEvidence as (evidence: SourcePreviewEvidence) => void
  )(observed);
  click("继续到发布确认");
  expect(button(view(), "确认发布此版本").props!.disabled).toBe(true);
  const checkbox = find(
    view(),
    (node) => node.type === "input" && node.props?.type === "checkbox",
  )[0];
  (checkbox.props!.onChange as (event: unknown) => void)({
    target: { checked: true },
  });
  expect(button(view(), "确认发布此版本").props!.disabled).toBe(false);
  click("确认发布此版本");
  await vi.advanceTimersByTimeAsync(0);
  const [path, options] = fetch.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(path).toBe("/api/admin/videos/video/publish");
  expect(JSON.parse(String(options.body))).toEqual({
    versionId: "optimized-one",
    attestation: { ...observed, audioConfirmed: true },
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it("never reuses another MP4 version's observed playback or audio acknowledgement", () => {
  versionButton("optimized-one", "预览");
  const player = find(view(), (node) => node.type === Player)[0];
  (
    player.props!.onPreviewEvidence as (evidence: SourcePreviewEvidence) => void
  )(observed);
  const preview = find(
    view(),
    (node) =>
      typeof node.type === "function" &&
      node.type.name === "Modal" &&
      node.props?.title === "管理员预览",
  )[0];
  (preview.props!.onClose as () => void)();
  versionButton("optimized-two", "选择发布");
  expect(button(view(), "确认发布此版本").props!.disabled).toBe(true);
  const checkbox = find(
    view(),
    (node) => node.type === "input" && node.props?.type === "checkbox",
  )[0];
  expect(checkbox.props).toMatchObject({ checked: false, disabled: true });
});

it.each(["source", "probe-remux"])(
  "keeps %s publication contract unchanged",
  async (mode) => {
    fixture.detail.versions[0] = {
      ...fixture.detail.versions[0],
      mode,
      manifest: mode === "source" ? "source.mp4" : "index.m3u8",
    };
    const fetch = vi.fn(async () => Response.json({ published: true }));
    vi.stubGlobal("fetch", fetch);
    versionButton("optimized-one", "选择发布");
    expect(button(view(), "确认发布此版本").props!.disabled).toBe(false);
    click("确认发布此版本");
    await vi.advanceTimersByTimeAsync(0);
    expect(
      JSON.parse(
        String(
          (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body,
        ),
      ),
    ).toEqual({ versionId: "optimized-one" });
  },
);
