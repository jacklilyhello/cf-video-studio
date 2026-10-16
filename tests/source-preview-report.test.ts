import { afterEach, beforeEach, expect, it, vi } from "vitest";

let reportSourcePreview: typeof import("../web/client").reportSourcePreview;
type Report = Parameters<typeof import("../web/client").reportSourcePreview>[0];
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-14T12:00:00Z"));
  ({ reportSourcePreview } = await import("../web/client"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const report = (videoId = "video"): Report => ({
  videoId,
  sourceRevision: "revision",
  phase: "playing",
  nativeErrorCode: 0,
  networkState: 1,
  readyState: 4,
  currentTime: 2,
  duration: 60,
});

it("sends selected raw preview fields only to the same-origin private route", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ accepted: true }, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetch);
  await reportSourcePreview({
    ...report(),
    url: "https://fixture.invalid/?token=test-only",
    message: "raw",
    stack: "raw",
    cookie: "test-only",
    authorization: "test-only",
  } as Report);
  const [path, options] = fetch.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(path).toBe("/api/admin/source/video/playback-report");
  expect(options).toMatchObject({
    method: "POST",
    mode: "same-origin",
    credentials: "same-origin",
    keepalive: true,
  });
  expect(JSON.parse(String(options.body))).toEqual({
    sourceRevision: "revision",
    phase: "playing",
    nativeErrorCode: 0,
    networkState: 1,
    readyState: 4,
    currentTime: 2,
    duration: 60,
  });
});

it("rejects unsafe scope and phases and omits invalid primitive measurements", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ accepted: true }, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetch);
  for (const input of [
    { ...report(), videoId: undefined },
    { ...report(), sourceRevision: "../private" },
    { ...report(), phase: "raw error" },
  ])
    await reportSourcePreview(input as Report);
  expect(fetch).not.toHaveBeenCalled();
  await reportSourcePreview({
    ...report(),
    nativeErrorCode: 9,
    networkState: -1,
    readyState: 0.5,
    currentTime: Infinity,
    duration: NaN,
  });
  expect(
    JSON.parse(
      String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ),
  ).toEqual({ sourceRevision: "revision", phase: "playing" });
});

it("deduplicates by phase independently of playback position and bounds transmission to six per minute", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ accepted: true }, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetch);
  await reportSourcePreview(report());
  await reportSourcePreview({ ...report(), currentTime: 10 });
  for (let n = 0; n < 10; n++) await reportSourcePreview(report(`video-${n}`));
  expect(fetch).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(60000);
  await reportSourcePreview(report());
  expect(fetch).toHaveBeenCalledTimes(7);
});

it("aborts after four seconds and ignores failures without retrying", async () => {
  const fetch = vi.fn(
    (_path: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        options.signal!.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const done = vi.fn();
  const pending = reportSourcePreview(report()).then(done);
  await vi.advanceTimersByTimeAsync(3999);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(done).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(120000);
  expect(fetch).toHaveBeenCalledOnce();
});
