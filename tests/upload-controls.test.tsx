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
  useLoad: () => ({
    data: { items: [], page: 1, pageSize: 50, total: 0 },
    reload: vi.fn(),
    loading: false,
    error: null,
  }),
}));
import { Uploads } from "../web/Uploads";
import { ApiError } from "../web/client";
import { explainMediaError } from "../web/media-errors";

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
      mediaError?: Error;
      uploadId?: string;
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

it("releases both paused slots after a bounded unknown creation result, allowing a third file to proceed", async () => {
  const fetch = vi.fn(
    (_path: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetch);
  add(render(), ["one.mp4", "two.mp4"]);
  render();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const button of find(
    render(),
    (node) => node.type === "button" && node.props?.children === "暂停",
  ))
    (button.props!.onClick as () => void)();
  add(render(), ["three.mp4"]);
  render();
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60000);
  render();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("does not claim cancellation when a creation response never provided an upload identity", async () => {
  const fetch = vi.fn(
    (_path: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetch);
  add(render(), ["one.mp4"]);
  render();
  await vi.advanceTimersByTimeAsync(0);
  click("取消");
  await vi.advanceTimersByTimeAsync(30000);
  expect(entryState()).toMatchObject({ state: "failed" });
  expect(entryState().error).toContain("尚未核实");
  click("取消");
  await vi.advanceTimersByTimeAsync(0);
  expect(entryState().state).toBe("failed");
  expect(entryState().error).toContain("服务器上的任务");
  expect(fetch).toHaveBeenCalledOnce();
});

it("retries an uncertain completion through verified creation and skips an already accepted chunk", async () => {
  let completed = false;
  let completionCalls = 0;
  const part = {
    number: 1,
    size: 7,
    sha256: "0".repeat(64),
    etag: "part-fixture",
  };
  const xhrSend = vi.fn();
  class FakeXHR {
    upload = { onprogress: null };
    status = 200;
    responseText = JSON.stringify(part);
    onload?: () => void;
    onabort?: () => void;
    open() {}
    setRequestHeader() {}
    send() {
      xhrSend();
      Promise.resolve().then(() => this.onload?.());
    }
    abort() {
      this.onabort?.();
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  const fetch = vi.fn((path: string, options: RequestInit) => {
    if (path === "/api/admin/uploads")
      return Promise.resolve(
        Response.json({
          upload: { id: "upload", state: completed ? "complete" : "uploading" },
          parts: completed ? [part] : [],
        }),
      );
    if (path.endsWith("/complete")) {
      completed = true;
      if (++completionCalls === 1)
        return new Promise<Response>((_resolve, reject) =>
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        );
      return Promise.resolve(Response.json({ video: { id: "video" } }));
    }
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetch);
  add(render(), ["one.mp4"]);
  render();
  await vi.advanceTimersByTimeAsync(0);
  expect(completionCalls).toBe(1);
  expect(entryState().state).toBe("completing");
  const saving = render();
  expect(
    find(
      saving,
      (node) =>
        node.type === "button" &&
        ["暂停", "取消"].includes(String(node.props?.children)),
    ),
  ).toHaveLength(0);
  expect(find(saving, (node) => node.props?.role === "status")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30000);
  expect(entryState()).toMatchObject({ state: "failed", uploadId: "upload" });
  expect(entryState().error).toContain("完成保存的结果尚未核实");
  expect(entryState().mediaError).toBeInstanceOf(ApiError);
  expect(
    explainMediaError(entryState().mediaError, { stage: "upload" }).action,
  ).toBe("reconcile-upload");
  click("核对保存结果");
  render();
  await vi.advanceTimersByTimeAsync(0);
  expect(entryState().state).toBe("complete");
  expect(completionCalls).toBe(2);
  expect(xhrSend).toHaveBeenCalledOnce();
  const creations = fetch.mock.calls.filter(
    ([path]) => path === "/api/admin/uploads",
  );
  expect(creations[0][1].body).toBe(creations[1][1].body);
});

it.each([
  [401, "unauthorized", "sign-in"],
  [400, "part_hash", "resume-upload"],
] as const)(
  "preserves the real chunk response %s/%s so recovery selects %s",
  async (status, code, action) => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    class RejectedXHR {
      upload = {};
      status = status;
      responseText = JSON.stringify({
        error: { code, message: "合成分片诊断" },
        requestId: "synthetic-chunk-request",
      });
      onload?: () => void;
      open() {}
      setRequestHeader() {}
      send() {
        Promise.resolve().then(() => this.onload?.());
      }
      abort() {}
    }
    vi.stubGlobal("XMLHttpRequest", RejectedXHR);
    const fetch = vi.fn(async () =>
      Response.json({
        upload: { id: "upload", state: "uploading" },
        parts: [],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    add(render(), ["chunk-fixture.mp4"]);
    render();
    await vi.advanceTimersByTimeAsync(0);
    const failure = entryState().mediaError as ApiError;
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      code,
      status,
      requestId: "synthetic-chunk-request",
    });
    expect(explainMediaError(failure, { stage: "upload" }).action).toBe(action);
    expect(fetch).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  },
);

it("keeps a known cancellation pending until its response and permits a bounded idempotent retry", async () => {
  class FakeXHR {
    upload = { onprogress: null };
    onabort?: () => void;
    open() {}
    setRequestHeader() {}
    send() {}
    abort() {
      this.onabort?.();
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  let cancelCalls = 0;
  const fetch = vi.fn((path: string, options: RequestInit) => {
    if (path === "/api/admin/uploads")
      return Promise.resolve(
        Response.json({
          upload: { id: "upload", state: "uploading" },
          parts: [],
          reused: true,
          additionalBytes: 0,
        }),
      );
    if (path.endsWith("/cancel")) {
      if (++cancelCalls === 1)
        return new Promise<Response>((_resolve, reject) =>
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        );
      return Promise.resolve(Response.json({ state: "cancelled" }));
    }
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetch);
  add(render(), ["one.mp4"]);
  render();
  await vi.advanceTimersByTimeAsync(0);
  expect(entryState()).toMatchObject({
    state: "uploading",
    uploadId: "upload",
  });
  click("取消");
  await vi.advanceTimersByTimeAsync(0);
  expect(entryState().state).toBe("cancelling");
  await vi.advanceTimersByTimeAsync(30000);
  expect(entryState()).toMatchObject({ state: "failed", uploadId: "upload" });
  click("取消");
  await vi.advanceTimersByTimeAsync(0);
  expect(entryState().state).toBe("cancelled");
  expect(cancelCalls).toBe(2);
  const text = (node: unknown): string => {
    if (Array.isArray(node)) return node.map(text).join("");
    if (typeof node === "string" || typeof node === "number")
      return String(node);
    return node && typeof node === "object"
      ? text((node as Node).props?.children)
      : "";
  };
  const cancelledTree = render();
  expect(text(cancelledTree)).toContain("总大小 7 B");
  const row = find(
    cancelledTree,
    (node) => node.props?.className === "upload-row",
  )[0];
  expect(text(row)).toContain("已取消，不会继续上传");
  expect(text(row)).not.toContain("复用已有上传");
  expect(find(row, (node) => node.type === "progress")).toHaveLength(0);
});
