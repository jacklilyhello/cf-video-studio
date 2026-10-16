import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WatchProgressQueue, type WatchSaveState } from "../web/client";
const queues: WatchProgressQueue[] = [];
const observation = {
  videoId: "video",
  timelineId: "timeline",
  position: 20,
  duration: 60,
  playedSeconds: 20,
};
function setup() {
  let state: WatchSaveState = { error: null, needsRestart: false };
  const queue = new WatchProgressQueue({
    onState: (next) => {
      state = next;
    },
  });
  queues.push(queue);
  return { queue, state: () => state };
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const queue of queues.splice(0)) queue.reset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("cannot send without verified context and does not let a late old-context acknowledgement unfreeze passive identity change", async () => {
  let acknowledge!: (response: Response) => void;
  const fetch = vi.fn(
    (_path: string, _options: RequestInit) =>
      new Promise<Response>((resolve) => {
        acknowledge = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const s = setup();
  expect(s.queue.enqueue(observation)).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  s.queue.setWriteContext("a".repeat(64));
  s.queue.enqueue(observation);
  const body = String(fetch.mock.calls[0]?.[1]?.body);
  s.queue.setWriteContext("b".repeat(64));
  expect(s.state()).toMatchObject({
    needsRestart: true,
    restartReason: "history_identity_changed",
  });
  acknowledge(Response.json({ saved: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(s.state()).toMatchObject({
    needsRestart: true,
    restartReason: "history_identity_changed",
  });
  expect(JSON.parse(body).writeContext).toBe("a".repeat(64));
  expect(
    s.queue.enqueue({ ...observation, position: 21, playedSeconds: 1 }),
  ).toBe(false);
  await vi.advanceTimersByTimeAsync(60000);
  expect(fetch).toHaveBeenCalledOnce();
});

it("keeps the entire retry event immutable and freezes rather than rebinding pending or queued observations to a new identity", async () => {
  const fetch = vi.fn(async (_path: string, _options: RequestInit) => {
    throw new Error("Acknowledgement lost");
  });
  vi.stubGlobal("fetch", fetch);
  const s = setup();
  s.queue.setWriteContext("a".repeat(64));
  s.queue.enqueue(observation);
  await vi.advanceTimersByTimeAsync(0);
  s.queue.enqueue({ ...observation, position: 22, playedSeconds: 2 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledTimes(2);
  const bodies = fetch.mock.calls.map((call) => String(call[1]?.body));
  expect(bodies[1]).toBe(bodies[0]);
  s.queue.setWriteContext("b".repeat(64));
  await vi.advanceTimersByTimeAsync(60000);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(s.state().restartReason).toBe("history_identity_changed");
  const saved: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, options: RequestInit) => {
      saved.push(JSON.parse(String(options.body)));
      return Response.json({ saved: true });
    }),
  );
  s.queue.reset("b".repeat(64));
  s.queue.enqueue({ ...observation, position: 23, playedSeconds: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    writeContext: "b".repeat(64),
    playedSeconds: 1,
    position: 23,
  });
  expect(saved[0].eventId).not.toBe(JSON.parse(bodies[0]).eventId);
});

it("treats passive Cookie loss as explicit Cookie recovery and invalidates old writers only on deliberate reset", async () => {
  const fetch = vi.fn(async () => Response.json({ saved: true }));
  vi.stubGlobal("fetch", fetch);
  const s = setup();
  s.queue.setWriteContext("a".repeat(64));
  const oldWriter = s.queue.writer();
  s.queue.setWriteContext(null);
  expect(s.state()).toMatchObject({
    needsRestart: true,
    restartReason: "cookies_required",
  });
  expect(oldWriter.enqueue(observation)).toBe(false);
  s.queue.reset();
  expect(oldWriter.enqueue(observation)).toBe(false);
  expect(s.queue.enqueue(observation)).toBe(false);
  s.queue.setWriteContext("b".repeat(64));
  expect(s.queue.enqueue({ ...observation, playedSeconds: 1 })).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  ["b".repeat(64), "history_identity_changed", false],
  [null, "cookies_required", true],
] as const)(
  "keeps the frozen cause after a late old flight failure (next=%s, timeout=%s)",
  async (next, reason, timeout) => {
    let fail!: (error: Error) => void;
    const fetch = vi.fn(
      (_path: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          fail = reject;
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const s = setup();
    s.queue.setWriteContext("a".repeat(64));
    s.queue.enqueue(observation);
    s.queue.setWriteContext(next);
    if (timeout) await vi.advanceTimersByTimeAsync(4001);
    else {
      fail(new Error("Lost acknowledgement"));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(s.state()).toMatchObject({
      needsRestart: true,
      restartReason: reason,
    });
    expect(s.queue.enqueue(observation)).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it("refuses malformed context without replacing valid pending identity or authorizing Cookie issuance", async () => {
  const fetch = vi.fn(async (_path: string, _options: RequestInit) => {
    throw new Error("Offline");
  });
  vi.stubGlobal("fetch", fetch);
  const s = setup();
  s.queue.setWriteContext("a".repeat(64));
  s.queue.enqueue(observation);
  await vi.advanceTimersByTimeAsync(0);
  s.queue.setWriteContext("B".repeat(64));
  expect(s.state()).toMatchObject({
    needsRestart: true,
    restartReason: "context_unavailable",
  });
  s.queue.reset("invalid");
  expect(s.queue.enqueue(observation)).toBe(false);
  await vi.advanceTimersByTimeAsync(60000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetch.mock.calls[0][1].body)).writeContext).toBe(
    "a".repeat(64),
  );
});
