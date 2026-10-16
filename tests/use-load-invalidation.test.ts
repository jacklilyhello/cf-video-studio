import { afterEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  effects: [] as {
    callback: () => void | (() => void);
    deps: unknown[];
    run: boolean;
    cleanup?: () => void;
  }[],
  callbacks: [] as { value: unknown; deps: unknown[] }[],
  stateIndex: 0,
  refIndex: 0,
  effectIndex: 0,
  callbackIndex: 0,
}));
vi.mock("react", () => ({
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
  useRef(initial: unknown) {
    const index = hooks.refIndex++;
    return (hooks.refs[index] ||= { current: initial });
  },
  useCallback(value: unknown, deps: unknown[]) {
    const index = hooks.callbackIndex++,
      old = hooks.callbacks[index];
    if (!old || deps.some((value, i) => value !== old.deps[i]))
      hooks.callbacks[index] = { value, deps };
    return hooks.callbacks[index].value;
  },
  useEffect(callback: () => void | (() => void), deps: unknown[]) {
    const index = hooks.effectIndex++,
      old = hooks.effects[index];
    if (!old || deps.some((value, i) => value !== old.deps[i])) {
      old?.cleanup?.();
      hooks.effects[index] = { callback, deps, run: true };
    }
  },
}));
import { useLoad } from "../web/client";
function render() {
  hooks.stateIndex =
    hooks.refIndex =
    hooks.effectIndex =
    hooks.callbackIndex =
      0;
  const result = useLoad<{ version: string; writeContext: string }>(
    "/api/history",
  );
  for (const effect of hooks.effects)
    if (effect.run) {
      effect.run = false;
      effect.cleanup = effect.callback() || undefined;
    }
  return result;
}
afterEach(() => {
  for (const effect of hooks.effects) effect.cleanup?.();
  vi.unstubAllGlobals();
});
it("atomically invalidates a late GET when explicit recovery or clear replaces data, while preserving the setter identity", async () => {
  let finish!: (response: Response) => void;
  let signal!: AbortSignal;
  vi.stubGlobal(
    "fetch",
    vi.fn((_path: string, options: RequestInit) => {
      signal = options.signal!;
      // Deliberately ignore abort, as a completed/stalled adapter can deliver late.
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }),
  );
  const first = render();
  first.setData({ version: "recovered", writeContext: "b".repeat(64) });
  expect(signal.aborted).toBe(true);
  const replaced = render();
  expect(replaced.setData).toBe(first.setData);
  finish(Response.json({ version: "old", writeContext: "a".repeat(64) }));
  await vi.waitFor(() => expect(render().data?.version).toBe("recovered"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(render().data).toEqual({
    version: "recovered",
    writeContext: "b".repeat(64),
  });
  expect(render().loading).toBe(false);
});
