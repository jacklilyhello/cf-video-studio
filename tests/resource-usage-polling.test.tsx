import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ResourceUsageSnapshot } from "../src/resource-usage";
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
const fixture = vi.hoisted(() => ({
  data: null as ResourceUsageSnapshot | null,
  loading: false,
  error: null as Error | null,
  reload: vi.fn(),
  setData: vi.fn(),
  useLoad: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useRef(initial: unknown) {
    return (hooks.refs[hooks.refIndex++] ||= { current: initial });
  },
  useState(initial: unknown) {
    const i = hooks.stateIndex++;
    if (!(i in hooks.states)) hooks.states[i] = initial;
    return [
      hooks.states[i],
      (value: unknown) => {
        hooks.states[i] = value;
      },
    ];
  },
  useEffect(effect: () => void | (() => void), deps: unknown[]) {
    const i = hooks.effectIndex++,
      previous = hooks.effects[i];
    if (!previous || deps.some((v, j) => v !== previous.deps[j])) {
      previous?.cleanup?.();
      hooks.effects[i] = { effect, deps, run: true };
    }
  },
}));
vi.mock("../web/client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useLoad: (...args: unknown[]) => {
    fixture.useLoad(...args);
    return {
      data: fixture.data,
      loading: fixture.loading,
      error: fixture.error,
      reload: fixture.reload,
      setData: fixture.setData,
    };
  },
}));
import { ResourceUsage } from "../web/ResourceUsage";
function render() {
  hooks.refIndex = hooks.stateIndex = hooks.effectIndex = 0;
  ResourceUsage();
  for (const effect of hooks.effects)
    if (effect.run) {
      effect.run = false;
      effect.cleanup = effect.effect() || undefined;
    }
}
beforeEach(() => {
  hooks.refs = [];
  hooks.states = [];
  hooks.effects = [];
  fixture.reload.mockClear();
  fixture.useLoad.mockClear();
  fixture.loading = false;
  fixture.error = null;
  fixture.data = {
    fetchedAt: 1,
    cached: false,
    nextRefreshAt: 35001,
    environment: "test",
    worker: "fixture-test",
    collection: {
      status: "collecting",
      checkedAt: 0,
      intervalMinutes: 60,
      coverageStart: null,
      note: "后台采集",
    },
    period: { label: "近24小时", start: "2026-10-14", end: "2026-10-15" },
    policy: { monthlyIncrementalBudgetUsd: 0, processingEnabled: false },
    cards: [],
  };
  vi.useFakeTimers();
});
afterEach(() => {
  for (const effect of hooks.effects) effect.cleanup?.();
  vi.useRealTimers();
});
it("bounds background readbacks to six ordinary GETs and stops on completion, without asking for another collection", async () => {
  for (let i = 0; i < 8; i++) {
    fixture.data!.fetchedAt++;
    render();
    await vi.advanceTimersByTimeAsync(5000);
  }
  expect(fixture.reload).toHaveBeenCalledTimes(6);
  expect(
    fixture.useLoad.mock.calls.every(
      ([path, timeout]) =>
        path === "/api/admin/resource-usage?range=24h" && timeout === 15000,
    ),
  ).toBe(true);
  fixture.data!.collection!.status = "partial";
  render();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fixture.reload).toHaveBeenCalledTimes(6);
});
it("cleans up a scheduled readback when the page is unmounted or its current read fails", async () => {
  render();
  for (const effect of hooks.effects) effect.cleanup?.();
  await vi.advanceTimersByTimeAsync(5000);
  expect(fixture.reload).not.toHaveBeenCalled();
  fixture.error = new Error("Request timed out");
  render();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fixture.reload).not.toHaveBeenCalled();
});
