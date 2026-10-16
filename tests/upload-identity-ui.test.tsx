import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requireStorageBudget } from "../src/billing";
import type { Env } from "../src/types";
import { HttpError } from "../src/http";

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
    const previous = hooks.effects[index];
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
      previous?.cleanup?.();
      hooks.effects[index] = { effect, deps, run: true };
    }
  },
}));
vi.mock("../web/client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useLoad: () => ({
    data: { items: [], total: 0, page: 1, pageSize: 50 },
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
type Entry = {
  key: string;
  file: File;
  state: string;
  fingerprint?: string;
  uploadId?: string;
  parts: { number: number; size: number; sha256: string; etag: string }[];
  error?: string;
};
const entries = () => hooks.states[0] as Entry[];
function find(node: unknown, matches: (item: Node) => boolean): Node[] {
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
function add(files: File[]) {
  const target = find(render(), (node) => !!node.props?.onDrop)[0];
  (target.props!.onDrop as (event: unknown) => void)({
    preventDefault() {},
    dataTransfer: { files },
  });
}
function click(text: string) {
  const target = find(
    render(),
    (node) => node.type === "button" && node.props?.children === text,
  )[0];
  expect(target, text).toBeDefined();
  expect(target.props!.disabled).not.toBe(true);
  (target.props!.onClick as () => void)();
}
async function until(assertion: () => void) {
  await vi.waitFor(
    () => {
      render();
      assertion();
    },
    { timeout: 3000, interval: 5 },
  );
}
const spaceLimited = () =>
  Response.json(
    {
      error: {
        code: "storage_limit",
        message: "本项目可用空间不足",
      },
    },
    { status: 409 },
  );
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function gatedFile(content: string, gate: Promise<void>) {
  const file = new File([content], "same-name.mp4", { lastModified: 1000 });
  const original = file.slice.bind(file);
  const reads = vi.fn();
  vi.spyOn(file, "slice").mockImplementation((...args) => {
    const blob = original(...args);
    const read = blob.arrayBuffer.bind(blob);
    vi.spyOn(blob, "arrayBuffer").mockImplementation(async () => {
      reads();
      await gate;
      return read();
    });
    return blob;
  });
  return { file, reads };
}
beforeEach(() => {
  hooks.refs = [];
  hooks.states = [];
  hooks.effects = [];
});
afterEach(() => {
  for (const effect of hooks.effects) effect.cleanup?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps distinct bytes with identical name, size and mtime when selected while the first full fingerprint is pending", async () => {
  const gate = deferred<void>();
  const first = gatedFile("aaaaaaaa", gate.promise);
  const second = gatedFile("bbbbbbbb", gate.promise);
  const admissions: { fingerprint: string }[] = [];
  const sent = successfulPartTransport();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit) => {
      if (path === "/api/admin/uploads") {
        admissions.push(JSON.parse(String(options.body)));
        return Response.json({
          upload: { id: `upload-${admissions.length}`, state: "uploading" },
          parts: [],
          additionalBytes: 8,
        });
      }
      expect(path).toMatch(/^\/api\/admin\/uploads\/upload-[12]\/complete$/);
      return Response.json({ video: { id: "video-fixture" } });
    }),
  );
  add([first.file]);
  render();
  add([second.file]);
  expect(entries()).toHaveLength(2);
  render();
  expect(first.reads).toHaveBeenCalledOnce();
  expect(second.reads).toHaveBeenCalledOnce();
  gate.resolve();
  await until(() =>
    expect(entries().map((entry) => entry.state)).toEqual([
      "complete",
      "complete",
    ]),
  );
  expect(admissions).toHaveLength(2);
  expect(new Set(admissions.map((file) => file.fingerprint)).size).toBe(2);
  expect(sent).toHaveLength(2);
});

it("coalesces concurrent reselects only after both real fingerprints match, creating one ordinary upload without approval", async () => {
  const gate = deferred<void>();
  const first = gatedFile("aaaaaaaa", gate.promise);
  const second = gatedFile("aaaaaaaa", gate.promise);
  const creation = deferred<Response>();
  const sent = successfulPartTransport();
  const fetch = vi.fn(async (path: string) => {
    if (path === "/api/admin/uploads") return creation.promise;
    expect(path).toBe("/api/admin/uploads/same-file/complete");
    return Response.json({ video: { id: "video-fixture" } });
  });
  vi.stubGlobal("fetch", fetch);
  add([first.file]);
  render();
  add([second.file]);
  render();
  expect(entries()).toHaveLength(2);
  expect(first.reads).toHaveBeenCalledOnce();
  expect(second.reads).toHaveBeenCalledOnce();
  gate.resolve();
  // Do not render between the two finishing hashes: claiming the identity
  // cannot depend on React having committed the first entry's fingerprint.
  await vi.waitFor(
    () => {
      expect(entries()).toHaveLength(1);
      expect(entries()[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
    },
    { timeout: 3000, interval: 5 },
  );
  expect(fetch).toHaveBeenCalledOnce();
  creation.resolve(
    Response.json({
      upload: { id: "same-file", state: "uploading" },
      parts: [],
      additionalBytes: 8,
    }),
  );
  await until(() => expect(entries()[0].state).toBe("complete"));
  expect(
    fetch.mock.calls.filter(([path]) => path === "/api/admin/uploads"),
  ).toHaveLength(1);
  expect(sent).toEqual(["/api/admin/uploads/same-file/parts/1"]);
});

it("reselects an ordinary paused multipart into its original entry and verified parts without another reservation", async () => {
  const content = new Uint8Array(8 * 1024 * 1024 + 1);
  content[0] = 1;
  content[content.length - 1] = 2;
  const file = () =>
    new File([content], "same-name.mp4", { lastModified: 1000 });
  let created = false;
  let reservations = 0;
  let allowTail = false;
  const parts: Entry["parts"] = [];
  const sent: number[] = [];
  class XHR {
    upload = {};
    status = 200;
    responseText = "";
    part = 0;
    hash = "";
    onload?: () => void;
    onabort?: () => void;
    open(_method: string, path: string) {
      this.part = Number(path.split("/").at(-1));
    }
    setRequestHeader(_name: string, value: string) {
      this.hash = value;
    }
    send(blob: Blob) {
      sent.push(this.part);
      if (this.part === 2 && !allowTail) return;
      const part = {
        number: this.part,
        size: blob.size,
        sha256: this.hash,
        etag: `part-${this.part}`,
      };
      parts.push(part);
      this.responseText = JSON.stringify(part);
      queueMicrotask(() => this.onload?.());
    }
    abort() {
      this.onabort?.();
    }
  }
  vi.stubGlobal("XMLHttpRequest", XHR);
  const fetch = vi.fn(async (path: string, options: RequestInit) => {
    const data = JSON.parse(String(options.body));
    if (path === "/api/admin/uploads") {
      expect(data).toMatchObject({
        name: "same-name.mp4",
        size: content.length,
      });
      expect(data).not.toHaveProperty("approvalId");
      if (!created) {
        created = true;
        reservations++;
      }
      return Response.json({
        upload: { id: "upload-original", state: "uploading" },
        parts: [...parts],
      });
    }
    if (path.endsWith("/complete")) {
      expect(path).toBe("/api/admin/uploads/upload-original/complete");
      expect(parts).toHaveLength(2);
      return Response.json({ video: { id: "video-original" } });
    }
    throw new Error(`Unexpected path ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  add([file()]);
  await until(() => expect(sent).toEqual([1, 2]));
  const originalKey = entries()[0].key;
  click("暂停");
  await until(() => expect(entries()[0].state).toBe("paused"));
  allowTail = true;
  add([file()]);
  await until(() => {
    expect(entries()).toHaveLength(1);
    expect(entries()[0].state).toBe("complete");
  });
  expect(entries()[0]).toMatchObject({
    key: originalKey,
    uploadId: "upload-original",
  });
  expect(reservations).toBe(1);
  expect(
    fetch.mock.calls.filter(([path]) => path === "/api/admin/upload-approvals"),
  ).toHaveLength(0);
  expect(
    fetch.mock.calls.filter(([path]) => path.endsWith("/confirm")),
  ).toHaveLength(0);
  expect(sent).toEqual([1, 2, 2]);
});

function successfulPartTransport() {
  const sent: string[] = [];
  class XHR {
    upload = {};
    status = 200;
    responseText = "";
    path = "";
    hash = "";
    onload?: () => void;
    open(_method: string, path: string) {
      this.path = path;
    }
    setRequestHeader(_name: string, value: string) {
      this.hash = value;
    }
    send(blob: Blob) {
      sent.push(this.path);
      this.responseText = JSON.stringify({
        number: 1,
        size: blob.size,
        sha256: this.hash,
        etag: "part-one",
      });
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("XMLHttpRequest", XHR);
  return sent;
}

it.each(["known", "unknown"] as const)(
  "waits for an in-flight paused creation's %s outcome before deciding whether exact-file reselection can resume",
  async (outcome) => {
    const response = deferred<Response>();
    const file = () =>
      new File(["fixture"], "same-name.mp4", { lastModified: 1000 });
    const sent = successfulPartTransport();
    const admissions: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (path: string, options: RequestInit) => {
      if (path === "/api/admin/uploads") {
        admissions.push(JSON.parse(String(options.body)));
        if (admissions.length === 1) return response.promise;
        return Response.json({
          upload: { id: "original-upload", state: "uploading" },
          parts: [],
        });
      }
      expect(path).toBe("/api/admin/uploads/original-upload/complete");
      return Response.json({ video: { id: "original-video" } });
    });
    vi.stubGlobal("fetch", fetch);
    add([file()]);
    await until(() => expect(admissions).toHaveLength(1));
    const originalKey = entries()[0].key;
    click("暂停");
    add([file()]);
    await until(() => expect(entries()).toHaveLength(1));
    expect(entries()[0]).toMatchObject({ key: originalKey, state: "paused" });
    expect(admissions).toHaveLength(1);
    expect(sent).toHaveLength(0);
    if (outcome === "unknown") {
      response.resolve(
        Response.json(
          {
            error: { code: "creation_unverified", message: "创建结果尚未核实" },
          },
          { status: 503 },
        ),
      );
      await until(() =>
        expect(entries()[0].error).toContain("创建结果尚未核实"),
      );
      expect(entries()[0]).toMatchObject({ key: originalKey, state: "paused" });
      expect(admissions).toHaveLength(1);
      expect(sent).toHaveLength(0);
      return;
    }
    response.resolve(
      Response.json({
        upload: { id: "original-upload", state: "uploading" },
        parts: [],
      }),
    );
    await until(() => expect(entries()[0].state).toBe("complete"));
    expect(entries()[0]).toMatchObject({
      key: originalKey,
      uploadId: "original-upload",
    });
    expect(admissions).toHaveLength(2);
    expect(admissions[1]).toEqual(admissions[0]);
    expect(sent).toEqual(["/api/admin/uploads/original-upload/parts/1"]);
  },
);

it.each([false, true])(
  "keeps an unverified creation/cancellation (cancel=%s) and its error on exact-file reselection without another POST",
  async (cancel) => {
    const file = () =>
      new File(["fixture"], "same-name.mp4", { lastModified: 1000 });
    const fetch = vi.fn(async () => {
      throw new TypeError("Acknowledgement lost");
    });
    vi.stubGlobal("fetch", fetch);
    add([file()]);
    await until(() => expect(entries()[0].state).toBe("failed"));
    const originalKey = entries()[0].key;
    if (cancel) {
      click("取消");
      await until(() =>
        expect(entries()[0].error).toContain("创建结果尚未核实"),
      );
    }
    const originalError = entries()[0].error;
    add([file()]);
    await until(() => expect(entries()).toHaveLength(1));
    expect(entries()[0]).toMatchObject({ key: originalKey, state: "failed" });
    expect(entries()[0].error).toBe(originalError);
    expect(fetch).toHaveBeenCalledOnce();
    click("取消");
    await until(() => expect(entries()[0].error).toContain("创建结果尚未核实"));
    expect(entries()[0].state).toBe("failed");
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it("lets a project-census rejection cancel locally because the server never created an upload", async () => {
  const env = {
    DB: {
      prepare: () => ({
        first: async () => ({ value: "10737418240" }),
        all: async () => ({ results: [] }),
      }),
    },
    MEDIA: {
      list: async () => {
        throw new Error("Synthetic project census unavailable");
      },
    },
  } as unknown as Env;
  const rejection = (await requireStorageBudget(env, 7).catch(
    (error) => error,
  )) as HttpError;
  expect(rejection).toBeInstanceOf(HttpError);
  const fetch = vi.fn(async () =>
    Response.json(
      { error: { code: rejection.code, message: rejection.message } },
      { status: rejection.status },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  add([new File(["fixture"], "census-rejected.mp4", { lastModified: 1000 })]);
  await until(() => expect(entries()[0].state).toBe("failed"));
  click("取消");
  await until(() => expect(entries()[0].state).toBe("cancelled"));
  expect(fetch).toHaveBeenCalledOnce();
});

it("revalidates a completed source through the server instead of trusting a local matching fingerprint", async () => {
  const file = () =>
    new File(["fixture"], "same-name.mp4", { lastModified: 1000 });
  const sent = successfulPartTransport();
  let admissionCount = 0;
  const fetch = vi.fn(async (path: string) => {
    if (path === "/api/admin/uploads") {
      if (++admissionCount > 1) return spaceLimited();
      return Response.json({
        upload: { id: "old-upload", state: "uploading" },
        parts: [],
      });
    }
    expect(path).toBe("/api/admin/uploads/old-upload/complete");
    return Response.json({ video: { id: "old-video" } });
  });
  vi.stubGlobal("fetch", fetch);
  add([file()]);
  await until(() => expect(entries()[0].state).toBe("complete"));
  add([file()]);
  await until(() =>
    expect(entries().map((entry) => entry.state)).toEqual([
      "complete",
      "failed",
    ]),
  );
  expect(admissionCount).toBe(2);
  expect(entries()[1].error).toBe("本项目可用空间不足");
  expect(sent).toEqual(["/api/admin/uploads/old-upload/parts/1"]);
});
