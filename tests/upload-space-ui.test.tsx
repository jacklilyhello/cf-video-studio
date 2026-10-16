import { afterEach, beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  states: [] as unknown[],
  effects: [] as {
    deps: unknown[];
    effect: () => void | (() => void);
    cleanup?: () => void;
    run: boolean;
  }[],
  refIndex: 0,
  stateIndex: 0,
  effectIndex: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useRef(initial: unknown) {
    const index = hooks.refIndex++;
    return (hooks.refs[index] ||= { current: initial });
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
  useEffect(effect: () => void | (() => void), deps: unknown[]) {
    const index = hooks.effectIndex++;
    const old = hooks.effects[index];
    if (!old || deps.some((value, i) => value !== old.deps[i])) {
      old?.cleanup?.();
      hooks.effects[index] = { effect, deps, run: true };
    }
  },
}));
vi.mock("../web/client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useLoad: (path: string) => ({
    data:
      path === "/api/admin/upload-space"
        ? {
            usedBytes: 1024 ** 2,
            reservedBytes: 2 * 1024 ** 2,
            limitBytes: 10 * 1024 ** 3,
            availableBytes: 10 * 1024 ** 3 - 3 * 1024 ** 2,
          }
        : { items: [], page: 1, pageSize: 50, total: 0 },
    reload: vi.fn(),
    loading: false,
    error: null,
  }),
}));
import { Uploads } from "../web/Uploads";

type Node = {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
};
function find(node: unknown, matches: (node: Node) => boolean): Node[] {
  if (!node || typeof node !== "object") return [];
  const item = node as Node;
  return [
    ...(matches(item) ? [item] : []),
    ...[item.props?.children]
      .flat(Infinity)
      .flatMap((child) => find(child, matches)),
  ];
}
function render() {
  hooks.refIndex = hooks.stateIndex = hooks.effectIndex = 0;
  const tree = Uploads({ onComplete: vi.fn() });
  for (const effect of hooks.effects)
    if (effect.run) {
      effect.run = false;
      effect.cleanup = effect.effect() || undefined;
    }
  return tree;
}
function add(tree: Node, names: string[]) {
  const drop = find(
    tree,
    (node) => typeof node.props?.onDrop === "function",
  )[0];
  (drop.props!.onDrop as (event: unknown) => void)({
    preventDefault: vi.fn(),
    dataTransfer: {
      files: names.map(
        (name) => new File(["fixture"], name, { lastModified: 1 }),
      ),
    },
  });
}
function click(text: string) {
  const button = find(
    render(),
    (node) => node.type === "button" && node.props?.children === text,
  )[0];
  expect(button).toBeDefined();
  (button.props!.onClick as () => void)();
}
const entryState = () =>
  (
    hooks.states[0] as {
      state: string;
      error?: string;
      uploadId?: string;
      reused?: boolean;
      additionalBytes?: number;
    }[]
  )[0];
beforeEach(() => {
  hooks.refs = [];
  hooks.states = [];
  hooks.effects = [];
  vi.useFakeTimers();
  // File hashing is orthogonal here; requests and scheduling use the actual module.
  vi.spyOn(crypto.subtle, "digest").mockResolvedValue(
    new Uint8Array(32).buffer,
  );
});
afterEach(() => {
  for (const effect of hooks.effects) effect.cleanup?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function nodeText(node: unknown): string {
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object"
    ? nodeText((node as Node).props?.children)
    : "";
}
function xhrFixture() {
  const part = { number: 1, size: 7, sha256: "0".repeat(64), etag: "fixture" };
  const sent = vi.fn();
  class XHR {
    upload = {};
    status = 200;
    responseText = JSON.stringify(part);
    onload?: () => void;
    open() {}
    setRequestHeader() {}
    send() {
      sent();
      Promise.resolve().then(() => this.onload?.());
    }
  }
  vi.stubGlobal("XMLHttpRequest", XHR);
  return { part, sent };
}
it("uploads selected files directly without an account approval request or risk modal", async () => {
  xhrFixture();
  const fetch = vi.fn(async (path: string, options: RequestInit) => {
    if (path === "/api/admin/uploads") {
      const data = JSON.parse(String(options.body));
      expect(data).not.toHaveProperty("approvalId");
      expect(data).not.toHaveProperty("includeManualChecks");
      return Response.json({
        upload: { id: data.name, state: "uploading" },
        parts: [],
        reused: false,
        additionalBytes: 7,
      });
    }
    if (path.endsWith("/complete"))
      return Response.json({ video: { id: "video" } });
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetch);
  add(render(), ["one.mp4", "two.mp4"]);
  render();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    (hooks.states[0] as { state: string }[]).map((entry) => entry.state),
  ).toEqual(["complete", "complete"]);
  expect(fetch.mock.calls.some(([path]) => path.includes("approval"))).toBe(
    false,
  );
  const text = nodeText(render());
  expect(text).toContain("项目空间");
  expect(text).toContain("项目上限");
  expect(text).not.toContain("管理员批准本次上传");
  expect(text).not.toContain("账户用量尚无法完整确认");
});
it.each(["storage_limit", "project_storage_unknown"])(
  "shows a real %s failure without sending an approval and permits local cancellation",
  async (code) => {
    const fetch = vi.fn(async () =>
      Response.json(
        { error: { code, message: "本项目空间需检查" } },
        { status: code === "storage_limit" ? 409 : 503 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    add(render(), ["one.mp4"]);
    render();
    await vi.advanceTimersByTimeAsync(0);
    expect(entryState()).toMatchObject({
      state: "failed",
      error: "本项目空间需检查",
    });
    click("取消");
    await vi.advanceTimersByTimeAsync(0);
    expect(entryState().state).toBe("cancelled");
    expect(fetch).toHaveBeenCalledOnce();
  },
);
it("displays verified reuse as zero additional space and does not resend accepted file bytes", async () => {
  const { part, sent } = xhrFixture();
  const fetch = vi.fn(async (path: string) =>
    path === "/api/admin/uploads"
      ? Response.json({
          upload: { id: "existing", state: "complete" },
          parts: [part],
          reused: true,
          additionalBytes: 0,
        })
      : Response.json({ video: { id: "video" } }),
  );
  vi.stubGlobal("fetch", fetch);
  add(render(), ["existing.mp4"]);
  render();
  await vi.advanceTimersByTimeAsync(0);
  expect(entryState()).toMatchObject({
    state: "complete",
    reused: true,
    additionalBytes: 0,
  });
  expect(sent).not.toHaveBeenCalled();
  expect(nodeText(render())).toContain("复用已有上传，不新增空间");
});
it("preserves an unknown creation result rather than falsely declaring it cancelled", async () => {
  const fetch = vi.fn(async () =>
    Response.json(
      { error: { code: "upload_unknown", message: "上传创建结果未核实" } },
      { status: 503 },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  add(render(), ["one.mp4"]);
  render();
  await vi.advanceTimersByTimeAsync(0);
  expect(entryState().state).toBe("failed");
  click("取消");
  await vi.advanceTimersByTimeAsync(0);
  expect(entryState().state).toBe("failed");
  expect(entryState().error).toContain("服务器上的任务");
  expect(fetch).toHaveBeenCalledOnce();
});
