import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Report = Parameters<
  typeof import("../web/client").reportPlaybackFailure
>[0];
let reportPlaybackFailure: typeof import("../web/client").reportPlaybackFailure;
const report = (videoId = "video"): Report => ({
  code: "playback_native_error",
  videoId,
  versionId: "version",
  nativeErrorCode: 3,
});
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-14T12:00:00Z"));
  ({ reportPlaybackFailure } = await import("../web/client"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("public playback reporting uses bounded, selected client data", () => {
  it("rebuilds the payload without copying diagnostics, URLs, headers or credentials", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetch);
    const input = {
      ...report(),
      url: "https://fixture.invalid/media?token=test-only",
      message: "raw diagnostic",
      stack: "raw stack",
      headers: { Authorization: "test-only", Cookie: "test-only" },
      origin: "https://fixture.invalid",
      hlsErrorType: "networkError",
    };
    await reportPlaybackFailure(input);
    expect(fetch).toHaveBeenCalledOnce();
    const [path, options] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe("/api/report");
    expect(options).toMatchObject({
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
      keepalive: true,
    });
    expect(JSON.parse(String(options.body))).toEqual(report());
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects invalid identifiers and report codes before opening a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const input of [
      { ...report(), code: "raw arbitrary error" },
      { ...report(), videoId: "https://fixture.invalid/path" },
      { ...report(), versionId: "v".repeat(65) },
      { ...report(), videoId: undefined },
    ])
      await reportPlaybackFailure(input as Report);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("omits invalid native numbers and normalizes unknown HLS error categories", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetch);
    await reportPlaybackFailure({ ...report(), nativeErrorCode: 99 });
    await reportPlaybackFailure({
      ...report("second"),
      code: "playback_hls_fatal",
      hlsErrorType: "raw provider detail",
    });
    const payloads = fetch.mock.calls.map((call) =>
      JSON.parse(String((call as unknown as [string, RequestInit])[1].body)),
    );
    expect(payloads).toEqual([
      { code: "playback_native_error", videoId: "video", versionId: "version" },
      {
        code: "playback_hls_fatal",
        videoId: "second",
        versionId: "version",
        hlsErrorType: "otherError",
      },
    ]);
  });

  it("deduplicates for sixty seconds and sends at most three reports per minute", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetch);
    for (const id of ["one", "two", "three", "four", "one"])
      await reportPlaybackFailure(report(id));
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(59999);
    await reportPlaybackFailure(report("one"));
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await reportPlaybackFailure(report("one"));
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("aborts a stalled transport after four seconds and never retries it automatically", async () => {
    const aborted = vi.fn();
    const fetch = vi.fn(
      (_path: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener(
            "abort",
            () => {
              aborted();
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const complete = vi.fn();
    const pending = reportPlaybackFailure(report()).then(complete);
    await vi.advanceTimersByTimeAsync(3999);
    expect(complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(aborted).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("swallows both network failure and server rejection without retrying or reading diagnostics into another report", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("test-only transport failure"))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "rate_limited",
              message: "test-only backend detail",
            },
          },
          { status: 429 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(reportPlaybackFailure(report())).resolves.toBeUndefined();
    await expect(
      reportPlaybackFailure(report("second")),
    ).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
