import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  state: [] as unknown[],
  index: 0,
  mounted: false,
  effects: [] as (() => void)[],
  send: vi.fn(),
  api: vi.fn(),
  load: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useState(initial: unknown) {
    const index = fixture.index++;
    if (!(index in fixture.state))
      fixture.state[index] =
        typeof initial === "function" ? initial() : initial;
    return [
      fixture.state[index],
      (value: unknown) => {
        fixture.state[index] =
          typeof value === "function" ? value(fixture.state[index]) : value;
      },
    ];
  },
  useEffect(callback: () => void) {
    if (!fixture.mounted) fixture.effects.push(callback);
  },
}));
vi.mock("../web/client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  send: fixture.send,
  api: fixture.api,
  useLoad: fixture.load,
}));
import { ApiError } from "../web/client";
import { DeletionDialog, Storage } from "../web/Storage";
type Node = {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
};
function text(value: unknown): string {
  return Array.isArray(value)
    ? value.map(text).join("")
    : typeof value === "number" || typeof value === "string"
      ? String(value)
      : value && typeof value === "object"
        ? text((value as Node).props?.children)
        : "";
}
function find(value: unknown, match: (node: Node) => boolean): Node[] {
  if (Array.isArray(value)) return value.flatMap((item) => find(item, match));
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return [...(match(node) ? [node] : []), ...find(node.props?.children, match)];
}
const defaultPlan = () => ({
  id: "confirmed-scope",
  kind: "version",
  videoId: "video",
  videoTitle: "Disposable sample",
  versionId: "source-version",
  versionIds: ["source-version"],
  sourceReferenceOnly: true,
  requiresUnpublish: false,
  warning: "移除版本记录，原片保留，不释放文件空间。",
  state: "pending",
  expiresAt: Date.now() + 600000,
  totalBytes: 0,
  releasedBytes: 0,
  remainingCount: 0,
  objects: [],
  failures: [],
});
function mount(props: Parameters<typeof DeletionDialog>[0]) {
  fixture.index = 0;
  const result = DeletionDialog(props);
  if (!fixture.mounted) {
    fixture.mounted = true;
    for (const effect of fixture.effects.splice(0)) effect();
  }
  return result;
}
async function settle() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}
function button(tree: unknown, title: string) {
  const node = find(
    tree,
    (item) => item.type === "button" && text(item) === title,
  )[0];
  expect(node).toBeDefined();
  return node;
}
beforeEach(() => {
  fixture.state = [];
  fixture.index = 0;
  fixture.mounted = false;
  fixture.effects = [];
  fixture.send.mockReset();
  fixture.api.mockReset();
  fixture.load.mockReset();
});
it("rechecks a deletion if another tab published its target after the original review", async () => {
  fixture.send.mockResolvedValue({ plan: defaultPlan() });
  const props = {
    request: {
      kind: "version" as const,
      videoId: "video",
      versionId: "source-version",
    },
    onClose: vi.fn(),
    onDone: vi.fn(),
  };
  mount(props);
  await settle();
  let tree = mount(props);
  (
    find(
      tree,
      (node) => node.type === "input" && node.props?.type === "checkbox",
    )[0].props!.onChange as (event: unknown) => void
  )({ target: { checked: true } });
  fixture.send.mockRejectedValueOnce(
    new ApiError("当前版本已发布，请确认先下架", "unpublish_required"),
  );
  (button(mount(props), "确认移除记录").props!.onClick as () => void)();
  await settle();
  tree = mount(props);
  expect(button(tree, "重新检查删除范围").props?.disabled).toBe(false);
  expect(fixture.send).toHaveBeenLastCalledWith(
    "/api/admin/storage/plans/confirmed-scope/confirm",
    {
      confirmation: "DELETE_LISTED_OBJECTS",
      unpublish: false,
      removeDependencies: true,
    },
  );
  fixture.send
    .mockResolvedValueOnce({ state: "cancelled" })
    .mockResolvedValueOnce({
      plan: { ...defaultPlan(), id: "new-review", requiresUnpublish: true },
    });
  (button(tree, "重新检查删除范围").props!.onClick as () => void)();
  await settle();
  tree = mount(props);
  expect(text(tree)).toContain("我同意先将这个视频下架");
  expect(button(tree, "确认移除记录").props?.disabled).toBe(true);
});
it("fetches older deletion tasks through their own pagination instead of hiding everything after the first fifty", () => {
  fixture.load.mockImplementation((path: string) => ({
    data: path.includes("/plans?")
      ? {
          items: [
            {
              id: "pending",
              kind: "video",
              videoId: "video",
              videoTitle: "Older disposable request",
              state: "pending",
              expired: false,
              remainingCount: 1,
              releasedBytes: 0,
              createdAt: 1,
            },
          ],
          page: Number(
            new URL(path, "https://fixture.example").searchParams.get("page"),
          ),
          pageSize: 50,
          total: 101,
        }
      : {
          items: [],
          total: 0,
          page: 1,
          pageSize: 30,
          summary: { sourceBytes: 0, generatedBytes: 0, reservedBytes: 0 },
        },
    loading: false,
    error: null,
    reload: vi.fn(),
  }));
  fixture.index = 0;
  const tree = Storage();
  const pager = find(
    tree,
    (node) =>
      typeof node.type === "function" && node.type.name === "Pagination",
  )[0];
  expect(pager.props).toMatchObject({ page: 1, total: 101, pageSize: 50 });
  (pager.props!.onPage as (page: number) => void)(2);
  fixture.index = 0;
  Storage();
  expect(fixture.load).toHaveBeenLastCalledWith(
    "/api/admin/storage/plans?page=2",
  );
});
it("presents expired requests with working recheck/cancel actions and no unusable delete confirmation", async () => {
  fixture.api.mockResolvedValue({ plan: { ...defaultPlan(), expiresAt: 1 } });
  const props = { planId: "expired", onClose: vi.fn(), onDone: vi.fn() };
  mount(props);
  await settle();
  const tree = mount(props);
  expect(
    find(
      tree,
      (node) => node.type === "input" && node.props?.type === "checkbox",
    ),
  ).toHaveLength(0);
  expect(text(tree)).toContain("删除确认已过期");
  expect(button(tree, "重新检查删除范围").props?.disabled).toBe(false);
  fixture.send.mockResolvedValue({ state: "cancelled", filesDeleted: false });
  await (
    button(tree, "取消待办，保留文件").props!.onClick as () => Promise<void>
  )();
  expect(fixture.send).toHaveBeenCalledWith(
    "/api/admin/storage/plans/confirmed-scope/cancel",
    {},
  );
  expect(props.onDone).toHaveBeenCalledOnce();
});
it.each([undefined, "Sintel renamed in the reviewed plan"])(
  "keeps the pending video's title when the filtered video list is empty and the old plan title is %s",
  async (reviewedTitle) => {
    fixture.load.mockImplementation((path: string) => ({
      data: path.includes("/plans?")
        ? {
            items: [
              {
                ...defaultPlan(),
                videoTitle: "Sintel",
                expired: true,
                createdAt: 1,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 50,
          }
        : {
            items: [],
            total: 0,
            page: 1,
            pageSize: 30,
            summary: { sourceBytes: 0, generatedBytes: 0, reservedBytes: 0 },
          },
      loading: false,
      error: null,
      reload: vi.fn(),
    }));
    const storage = () => {
      fixture.index = 0;
      return Storage();
    };
    const search = find(
      storage(),
      (node) => node.props?.["aria-label"] === "搜索视频存储",
    )[0];
    (search.props!.onChange as (event: unknown) => void)({
      target: { value: "可丢弃" },
    });
    const filtered = storage();
    expect(fixture.load).toHaveBeenCalledWith(
      `/api/admin/storage?view=videos&q=${encodeURIComponent("可丢弃")}&page=1`,
    );
    expect(
      find(filtered, (node) => node.props?.title === "没有符合条件的视频"),
    ).toHaveLength(1);
    (button(filtered, "重新检查").props!.onClick as () => void)();
    const props = find(storage(), (node) => node.type === DeletionDialog)[0]
      .props as Parameters<typeof DeletionDialog>[0];
    // Mount the dialog as its own component instance, preserving only the
    // actual props obtained by clicking the pending row above.
    fixture.state = [];
    fixture.index = 0;
    fixture.mounted = false;
    fixture.effects = [];
    fixture.api.mockResolvedValueOnce({
      plan: { ...defaultPlan(), videoTitle: reviewedTitle, expiresAt: 1 },
    });
    mount(props);
    await settle();
    let tree = mount(props);
    const expected = reviewedTitle || "Sintel";
    expect(text(tree)).toContain(expected);
    expect(text(tree)).not.toContain("选定视频");
    fixture.send
      .mockResolvedValueOnce({ state: "cancelled", filesDeleted: false })
      .mockResolvedValueOnce({
        plan: { ...defaultPlan(), id: "rechecked", videoTitle: undefined },
      });
    (button(tree, "重新检查删除范围").props!.onClick as () => void)();
    await settle();
    tree = mount(props);
    expect(text(tree)).toContain(expected);
    expect(text(tree)).not.toContain("选定视频");
    expect(fixture.send.mock.calls).toEqual([
      ["/api/admin/storage/plans/confirmed-scope/cancel", {}],
      [
        "/api/admin/storage/plan",
        {
          kind: "version",
          videoId: "video",
          versionId: "source-version",
          preservePlayback: undefined,
          removeDependencies: undefined,
        },
      ],
    ]);
    expect(button(tree, "确认移除记录").props?.disabled).toBe(true);
  },
);
it("shows cancellation in progress without implying metadata or files are being deleted", async () => {
  fixture.send.mockResolvedValueOnce({ plan: defaultPlan() });
  const props = {
    request: {
      kind: "version" as const,
      videoId: "video",
      versionId: "source-version",
    },
    onClose: vi.fn(),
    onDone: vi.fn(),
  };
  mount(props);
  await settle();
  let resolve!: (value: unknown) => void;
  fixture.send.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  (button(mount(props), "取消，保留文件").props!.onClick as () => void)();
  await settle();
  const cancelling = mount(props);
  expect(button(cancelling, "正在取消…").props?.disabled).toBe(true);
  expect(button(cancelling, "确认移除记录").props?.disabled).toBe(true);
  expect(text(cancelling)).not.toContain("正在删除");
  expect(text(cancelling)).not.toContain("正在移除记录");
  expect(props.onDone).not.toHaveBeenCalled();
  resolve({ state: "cancelled", filesDeleted: false });
  await settle();
  expect(props.onDone).toHaveBeenCalledOnce();
  expect(fixture.send.mock.calls.map(([path]) => path)).toEqual([
    "/api/admin/storage/plan",
    "/api/admin/storage/plans/confirmed-scope/cancel",
  ]);
});
it.each(["version", "source"] as const)(
  "retains the exact %s target and options when replacement creation fails after cancelling an existing plan",
  async (kind) => {
    const original = {
      ...defaultPlan(),
      kind,
      expiresAt: 1,
      versionId: kind === "version" ? "source-version" : null,
      preservePlayback: false,
      removeDependencies: false,
    };
    fixture.api.mockResolvedValue({ plan: original });
    const props = {
      planId: "confirmed-scope",
      // The pending list knows no version/options; the fetched plan owns them.
      request: { kind, videoId: "video" },
      onClose: vi.fn(),
      onDone: vi.fn(),
    };
    mount(props);
    await settle();
    fixture.send
      .mockResolvedValueOnce({ state: "cancelled", filesDeleted: false })
      .mockRejectedValueOnce(new Error("Replacement response unavailable"));
    (button(mount(props), "重新检查删除范围").props!.onClick as () => void)();
    await settle();
    const failed = mount(props);
    const error = find(
      failed,
      (node) =>
        typeof node.type === "function" && node.type.name === "ErrorBox",
    )[0];
    expect(error.props?.error).toMatchObject({
      message: "Replacement response unavailable",
    });
    expect(error.props?.retry).toBeTypeOf("function");
    fixture.send.mockResolvedValueOnce({
      plan: { ...original, id: "replacement", expiresAt: Date.now() + 600000 },
    });
    (error.props!.retry as () => void)();
    await settle();
    expect(fixture.send.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/storage/plans/confirmed-scope/cancel",
      "/api/admin/storage/plan",
      "/api/admin/storage/plan",
    ]);
    const replacementTarget = {
      kind,
      videoId: "video",
      versionId: kind === "version" ? "source-version" : undefined,
      preservePlayback: false,
      removeDependencies: false,
    };
    expect(fixture.send.mock.calls[1][1]).toEqual(replacementTarget);
    expect(fixture.send.mock.calls[2][1]).toEqual(replacementTarget);
    expect(text(mount(props))).toContain("Disposable sample");
  },
);
it("retries fetching the same existing plan when its first read fails", async () => {
  fixture.api.mockRejectedValueOnce(new Error("Plan read unavailable"));
  const props = {
    planId: "confirmed-scope",
    request: { kind: "version" as const, videoId: "video" },
    onClose: vi.fn(),
    onDone: vi.fn(),
  };
  mount(props);
  await settle();
  const error = find(
    mount(props),
    (node) => typeof node.type === "function" && node.type.name === "ErrorBox",
  )[0];
  fixture.api.mockResolvedValueOnce({ plan: defaultPlan() });
  (error.props!.retry as () => void)();
  await settle();
  expect(fixture.api.mock.calls).toEqual([
    ["/api/admin/storage/plans/confirmed-scope"],
    ["/api/admin/storage/plans/confirmed-scope"],
  ]);
  expect(fixture.send).not.toHaveBeenCalled();
  expect(text(mount(props))).toContain("Disposable sample");
});
it("allows metadata-only version removal after one acknowledgement without demanding typed file deletion", async () => {
  fixture.send.mockResolvedValue({ plan: defaultPlan() });
  const props = {
    request: {
      kind: "version" as const,
      videoId: "video",
      versionId: "source-version",
    },
    onClose: vi.fn(),
    onDone: vi.fn(),
  };
  mount(props);
  await settle();
  let tree = mount(props);
  expect(text(tree)).toContain("移除版本记录，原片保留，不释放文件空间");
  expect(
    find(
      tree,
      (node) => node.type === "input" && node.props?.placeholder === "删除",
    ),
  ).toHaveLength(0);
  (
    find(
      tree,
      (node) => node.type === "input" && node.props?.type === "checkbox",
    )[0].props!.onChange as (e: unknown) => void
  )({ target: { checked: true } });
  tree = mount(props);
  expect(button(tree, "确认移除记录").props?.disabled).toBe(false);
  fixture.send.mockResolvedValue({
    state: "complete",
    releasedBytes: 0,
    remainingCount: 0,
    failures: [],
  });
  fixture.api.mockResolvedValue({
    plan: { ...defaultPlan(), state: "complete" },
  });
  await (button(tree, "确认移除记录").props!.onClick as () => Promise<void>)();
  expect(fixture.send).toHaveBeenLastCalledWith(
    "/api/admin/storage/plans/confirmed-scope/confirm",
    {
      confirmation: "DELETE_LISTED_OBJECTS",
      unpublish: false,
      removeDependencies: true,
    },
  );
});
it("offers an explicit source-dependency removal path when no independent playback version exists", async () => {
  fixture.send.mockRejectedValueOnce(
    new ApiError("没有独立播放版本，可选择下架", "hls_required"),
  );
  const props = {
    request: { kind: "source" as const, videoId: "video" },
    onClose: vi.fn(),
    onDone: vi.fn(),
  };
  mount(props);
  await settle();
  const tree = mount(props);
  const allowUnpublish = find(
    tree,
    (node) =>
      node.type === "input" &&
      node.props?.type === "radio" &&
      node.props?.checked === false,
  )[0];
  fixture.send.mockResolvedValue({
    plan: {
      ...defaultPlan(),
      kind: "source",
      sourceReferenceOnly: false,
      preservePlayback: false,
      requiresUnpublish: true,
    },
  });
  (allowUnpublish.props!.onChange as () => void)();
  await settle();
  expect(fixture.send).toHaveBeenLastCalledWith("/api/admin/storage/plan", {
    kind: "source",
    videoId: "video",
    versionId: undefined,
    preservePlayback: false,
    removeDependencies: true,
  });
  expect(text(mount(props))).toContain("我同意先将这个视频下架");
});
it("retains the original plan id for a partially failed continuation", async () => {
  fixture.api.mockResolvedValue({
    plan: {
      ...defaultPlan(),
      state: "partial",
      objects: [{ key: "videos/video/confirmed", bytes: 10, state: "failed" }],
      totalBytes: 10,
      remainingCount: 1,
      failures: [
        {
          key: "videos/video/confirmed",
          error: "delete_or_verification_failed",
        },
      ],
    },
  });
  const props = {
    planId: "confirmed-scope",
    onClose: vi.fn(),
    onDone: vi.fn(),
  };
  mount(props);
  await settle();
  let tree = mount(props);
  (
    find(
      tree,
      (node) => node.type === "input" && node.props?.type === "checkbox",
    )[0].props!.onChange as (e: unknown) => void
  )({ target: { checked: true } });
  (
    find(
      tree,
      (node) => node.type === "input" && node.props?.placeholder === "删除",
    )[0].props!.onChange as (e: unknown) => void
  )({ target: { value: "删除" } });
  tree = mount(props);
  fixture.send.mockResolvedValue({
    state: "partial",
    releasedBytes: 0,
    remainingCount: 1,
    failures: [
      { key: "videos/video/confirmed", error: "delete_or_verification_failed" },
    ],
  });
  await (button(tree, "确认删除").props!.onClick as () => Promise<void>)();
  await settle();
  tree = mount(props);
  await (button(tree, "继续删除").props!.onClick as () => Promise<void>)();
  expect(
    fixture.send.mock.calls.every(
      ([path]) => path === "/api/admin/storage/plans/confirmed-scope/confirm",
    ),
  ).toBe(true);
});
