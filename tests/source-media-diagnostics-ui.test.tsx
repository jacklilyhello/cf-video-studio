import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    return (hooks.refs[hooks.refIndex++] ||= { current: initial });
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
    const index = hooks.effectIndex++,
      previous = hooks.effects[index];
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
      previous?.cleanup?.();
      hooks.effects[index] = { effect, deps, run: true };
    }
  },
}));
import {
  inspectSourceMediaConnection,
  SourceMediaDiagnostics,
  type SourceMediaDiagnosticResult,
} from "../web/SourceMediaDiagnostics";
import { streamMp4Object } from "../src/mp4-response";
import type { Env } from "../src/types";

type Node = {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
};
function find(node: unknown, type: string): Node[] {
  if (!node || typeof node !== "object") return [];
  const item = node as Node;
  return [
    ...(item.type === type ? [item] : []),
    ...[item.props?.children]
      .flat(Infinity)
      .flatMap((child) => find(child, type)),
  ];
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
  hooks.refIndex = hooks.stateIndex = hooks.effectIndex = 0;
  const tree = component();
  for (const effect of hooks.effects)
    if (effect.run) {
      effect.run = false;
      effect.cleanup = effect.effect() || undefined;
    }
  return tree;
}
beforeEach(() => {
  hooks.refs = [];
  hooks.states = [];
  hooks.effects = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
});
afterEach(() => {
  for (const effect of hooks.effects) effect.cleanup?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function contract(size: number) {
  // Synthetic arbitrary bytes: these tests prove HTTP/stream bounds, not decoding.
  const bytes = new Uint8Array(size).map((_, i) => i % 251);
  const head = {
    key: "private-local-source",
    size,
    etag: "private-etag-not-for-output",
    uploaded: new Date(),
  };
  const get = vi.fn(
    async (
      _key: string,
      options: {
        range?: { offset: number; length: number };
        onlyIf: { etagMatches: string };
      },
    ) => {
      expect(options.onlyIf).toEqual({ etagMatches: head.etag });
      const range = options.range;
      const body = range
        ? bytes.slice(range.offset, range.offset + range.length)
        : bytes;
      return { ...head, range, body: new Response(body.buffer).body! };
    },
  );
  const env = { MEDIA: { get } } as unknown as Env;
  const fetcher = vi.fn((path: string, options: RequestInit) =>
    streamMp4Object(
      new Request(`https://diagnostics.example${path}`, options),
      env,
      head as unknown as R2Object,
    ),
  );
  return { bytes, get, fetcher };
}
function response(
  size: number,
  options: RequestInit,
  body?: ReadableStream<Uint8Array>,
) {
  const range = new Headers(options.headers).get("Range");
  const invalid = range === `bytes=${size}-`;
  const match = range?.match(/^bytes=(\d+)-(\d+)$/);
  const length = match
    ? Number(match[2]) - Number(match[1]) + 1
    : options.method === "HEAD"
      ? size
      : 0;
  return new Response(
    options.method === "HEAD" || invalid
      ? null
      : (body ?? new Uint8Array(length)),
    {
      status: options.method === "HEAD" ? 200 : invalid ? 416 : 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(length),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store, max-age=0",
        ...(range
          ? {
              "Content-Range": invalid
                ? `bytes */${size}`
                : `bytes ${match![1]}-${match![2]}/${size}`,
            }
          : {}),
      },
    },
  );
}

describe("bounded private HTTP diagnostics using the actual client and MP4 response modules", () => {
  it.each([17, 200000])(
    "reads only two approved ranges for a %i-byte synthetic source",
    async (size) => {
      const f = contract(size),
        results: SourceMediaDiagnosticResult[] = [];
      await inspectSourceMediaConnection(
        "video/encoded",
        size,
        new AbortController().signal,
        (row) => results.push(row),
        f.fetcher,
      );
      expect(
        f.fetcher.mock.calls.map(([path, options]) => [
          path,
          options.method,
          new Headers(options.headers).get("Range"),
        ]),
      ).toEqual([
        ["/api/admin/source/video%2Fencoded/source.mp4", "HEAD", null],
        [
          "/api/admin/source/video%2Fencoded/source.mp4",
          "GET",
          `bytes=0-${Math.min(size, 65536) - 1}`,
        ],
        [
          "/api/admin/source/video%2Fencoded/source.mp4",
          "GET",
          `bytes=${Math.max(0, size - 65536)}-${size - 1}`,
        ],
        [
          "/api/admin/source/video%2Fencoded/source.mp4",
          "GET",
          `bytes=${size}-`,
        ],
      ]);
      for (const [, options] of f.fetcher.mock.calls)
        expect(options).toMatchObject({
          credentials: "same-origin",
          mode: "same-origin",
          redirect: "error",
          cache: "no-store",
          signal: expect.any(AbortSignal),
        });
      expect(results.map((row) => row.status)).toEqual([200, 206, 206, 416]);
      expect(results.map((row) => row.bytes)).toEqual([
        0,
        Math.min(size, 65536),
        Math.min(size, 65536),
        0,
      ]);
      expect(results.every((row) => row.failure === null)).toBe(true);
      expect(results.map((row) => row.firstByteMs)).toEqual([null, 0, 0, null]);
      expect(f.get).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(results)).not.toContain("private-etag");
      expect(Object.keys(results[0]).sort()).toEqual(
        [
          "method",
          "status",
          "expectedRange",
          "contentRange",
          "contentLength",
          "contentType",
          "acceptRanges",
          "cacheControl",
          "ttfbMs",
          "firstByteMs",
          "bytes",
          "totalMs",
          "failure",
        ].sort(),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(["ignored Range", "wrong range", "wrong length", "wrong type"])(
    "cancels %s without reading its body",
    async (failure) => {
      let bad!: Response;
      let cancel!: ReturnType<typeof vi.spyOn>,
        getReader!: ReturnType<typeof vi.spyOn>;
      const fetcher = vi.fn(async (_path: string, options: RequestInit) => {
        const result = response(100000, options);
        if (
          options.method !== "GET" ||
          new Headers(options.headers).get("Range") !== "bytes=0-65535"
        )
          return result;
        const headers = new Headers(result.headers);
        if (failure === "wrong range")
          headers.set("Content-Range", "bytes 1-65536/100000");
        if (failure === "wrong length") headers.set("Content-Length", "100000");
        if (failure === "wrong type")
          headers.set("Content-Type", "application/json");
        bad = new Response(result.body, {
          status: failure === "ignored Range" ? 200 : 206,
          headers,
        });
        cancel = vi.spyOn(bad.body!, "cancel");
        getReader = vi.spyOn(bad.body!, "getReader");
        return bad;
      });
      const results: SourceMediaDiagnosticResult[] = [];
      await inspectSourceMediaConnection(
        "video",
        100000,
        new AbortController().signal,
        (row) => results.push(row),
        fetcher,
      );
      expect(results[1]).toMatchObject({
        failure: failure === "ignored Range" ? "status" : "headers",
        bytes: 0,
        firstByteMs: null,
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(getReader).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(4);
    },
  );
  it("keeps response facts when BYOB is unavailable and never falls back to an ordinary reader", async () => {
    const bodies: {
      cancel: ReturnType<typeof vi.spyOn>;
      reader: ReturnType<typeof vi.spyOn>;
    }[] = [];
    const fetcher = vi.fn(async (_path: string, options: RequestInit) => {
      if (
        options.method === "HEAD" ||
        new Headers(options.headers).get("Range") === "bytes=10-"
      )
        return response(10, options);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(10));
          controller.close();
        },
      });
      bodies.push({
        cancel: vi.spyOn(body, "cancel"),
        reader: vi.spyOn(body, "getReader"),
      });
      return response(10, options, body);
    });
    const results: SourceMediaDiagnosticResult[] = [];
    await inspectSourceMediaConnection(
      "video",
      10,
      new AbortController().signal,
      (row) => results.push(row),
      fetcher,
    );
    expect(results[1]).toMatchObject({
      status: 206,
      contentRange: "bytes 0-9/10",
      contentLength: "10",
      failure: "bounded_read_unavailable",
      bytes: 0,
    });
    expect(results[2].failure).toBe("bounded_read_unavailable");
    for (const body of bodies) {
      expect(body.reader).toHaveBeenCalledExactlyOnceWith({ mode: "byob" });
      expect(body.cancel).toHaveBeenCalledOnce();
    }
  });
  it("caps BYOB delivery even when a response queues a chunk larger than its approved range", async () => {
    const cancels: ReturnType<typeof vi.fn>[] = [];
    const fetcher = vi.fn(async (_path: string, options: RequestInit) => {
      if (
        options.method === "HEAD" ||
        new Headers(options.headers).get("Range") === "bytes=100000-"
      )
        return response(100000, options);
      const cancel = vi.fn();
      cancels.push(cancel);
      const body = new ReadableStream<Uint8Array>({
        type: "bytes",
        start(controller) {
          controller.enqueue(new Uint8Array(200000));
        },
        cancel,
      });
      return response(100000, options, body);
    });
    const results: SourceMediaDiagnosticResult[] = [];
    await inspectSourceMediaConnection(
      "video",
      100000,
      new AbortController().signal,
      (row) => results.push(row),
      fetcher,
    );
    expect(results.map((row) => row.bytes)).toEqual([0, 65536, 65536, 0]);
    for (const cancel of cancels) expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(["HEAD status", "invalid Content-Range"])(
    "rejects a mismatched %s without reading a body",
    async (failure) => {
      let cancel!: ReturnType<typeof vi.spyOn>,
        getReader!: ReturnType<typeof vi.spyOn>;
      const fetcher = vi.fn(async (_path: string, options: RequestInit) => {
        const normal = response(100000, options);
        const isInvalid =
          new Headers(options.headers).get("Range") === "bytes=100000-";
        if (
          !(failure === "HEAD status" ? options.method === "HEAD" : isInvalid)
        )
          return normal;
        const headers = new Headers(normal.headers);
        if (isInvalid) headers.set("Content-Range", "bytes */99999");
        const body = new Response(new Uint8Array(1)).body!;
        cancel = vi.spyOn(body, "cancel");
        getReader = vi.spyOn(body, "getReader");
        return new Response(body, { status: isInvalid ? 416 : 206, headers });
      });
      const results: SourceMediaDiagnosticResult[] = [];
      await inspectSourceMediaConnection(
        "video",
        100000,
        new AbortController().signal,
        (row) => results.push(row),
        fetcher,
      );
      expect(results[failure === "HEAD status" ? 0 : 3]).toMatchObject({
        failure: failure === "HEAD status" ? "status" : "headers",
        bytes: 0,
        firstByteMs: null,
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(getReader).not.toHaveBeenCalled();
    },
  );
  it("bounds every hanging header request at fifteen seconds without retrying a phase", async () => {
    const results: SourceMediaDiagnosticResult[] = [];
    const fetcher = vi.fn(
      (_path: string, _options: RequestInit) => new Promise<Response>(() => {}),
    );
    const pending = inspectSourceMediaConnection(
      "video",
      100000,
      new AbortController().signal,
      (row) => results.push(row),
      fetcher,
    );
    await vi.advanceTimersByTimeAsync(14999);
    expect(results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(results).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(45000);
    await pending;
    expect(results).toHaveLength(4);
    expect(
      results.every(
        (row) => row.failure === "timeout" && row.totalMs === 15000,
      ),
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels hanging BYOB bodies at the same request deadline without awaiting cancellation", async () => {
    const cancels: ReturnType<typeof vi.fn>[] = [];
    const fetcher = vi.fn(async (_path: string, options: RequestInit) => {
      const range = new Headers(options.headers).get("Range");
      if (options.method === "HEAD" || range === "bytes=100000-")
        return response(100000, options);
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      cancels.push(cancel);
      const body = new ReadableStream<Uint8Array>({
        type: "bytes",
        pull: () => new Promise<void>(() => {}),
        cancel,
      });
      return response(100000, options, body);
    });
    const results: SourceMediaDiagnosticResult[] = [];
    const pending = inspectSourceMediaConnection(
      "video",
      100000,
      new AbortController().signal,
      (row) => results.push(row),
      fetcher,
    );
    await vi.advanceTimersByTimeAsync(30000);
    await pending;
    expect(results.map((row) => row.failure)).toEqual([
      null,
      "timeout",
      "timeout",
      null,
    ]);
    expect(results.map((row) => row.bytes)).toEqual([0, 0, 0, 0]);
    for (const cancel of cancels) expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("manual diagnostic component lifecycle", () => {
  it.each(["closing", "changing source"])(
    "starts only on click, deduplicates clicks and ignores a late response after %s",
    async (action) => {
      let release!: (value: Response) => void;
      const fetcher = vi.fn(
        (_path: string, _options: RequestInit) =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      let props = {
        videoId: "video",
        sourceRevision: "revision",
        size: 100000,
      };
      component = () => SourceMediaDiagnostics(props);
      render();
      expect(fetcher).not.toHaveBeenCalled();
      const button = find(render(), "button")[0];
      (button.props!.onClick as () => void)();
      (button.props!.onClick as () => void)();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(find(render(), "button")[0].props!.disabled).toBe(true);
      if (action === "closing") {
        for (const effect of hooks.effects) effect.cleanup?.();
        component = () => null;
      } else {
        props = { ...props, sourceRevision: "replacement" };
        render();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
      const body = new Response(new Uint8Array(100000)).body!;
      const cancel = vi.spyOn(body, "cancel"),
        getReader = vi.spyOn(body, "getReader");
      const previous = [...hooks.states];
      release(
        new Response(body, {
          headers: {
            "Content-Length": "100000",
            "Content-Type": "video/mp4",
            ETag: "private-not-for-output",
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(hooks.states).toEqual(previous);
      expect(cancel).toHaveBeenCalledOnce();
      expect(getReader).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(text(render())).not.toContain("private-not-for-output");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
