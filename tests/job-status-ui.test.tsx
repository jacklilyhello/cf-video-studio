import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env, Job } from "../src/types";

const fixture = vi.hoisted(() => ({
  frames: new Map<Function, unknown[]>(),
  active: [] as unknown[],
  index: 0,
  job: {} as Job,
  reload: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useEffect: vi.fn(),
  useState(initial: unknown) {
    const state = fixture.active;
    const index = fixture.index++;
    if (!(index in state))
      state[index] = typeof initial === "function" ? initial() : initial;
    return [
      state[index],
      (value: unknown) => {
        state[index] =
          typeof value === "function" ? value(state[index]) : value;
      },
    ];
  },
}));
vi.mock("../web/client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useLoad(path: string) {
    return {
      data:
        path === "/api/admin/session"
          ? { authenticated: true, configured: true }
          : { items: [fixture.job] },
      loading: false,
      error: null,
      reload: fixture.reload,
    };
  },
}));
import { Admin } from "../web/Admin";
import { cancelJob } from "../src/jobs";
import { HttpError } from "../src/http";
import { ApiError } from "../web/client";

type Node = {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
};
type Component = (props: Record<string, unknown>) => unknown;
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
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object"
    ? text((node as Node).props?.children)
    : "";
}
function render(component: Component, props: Record<string, unknown> = {}) {
  fixture.active = fixture.frames.get(component) || [];
  fixture.frames.set(component, fixture.active);
  fixture.index = 0;
  return component(props);
}
function child(tree: unknown, name: string) {
  const node = find(
    tree,
    (item) => typeof item.type === "function" && item.type.name === name,
  )[0];
  expect(node, name).toBeDefined();
  return { component: node.type as Component, props: node.props! };
}
function buttons(tree: unknown, label: string) {
  return find(tree, (item) => item.type === "button" && text(item) === label);
}
function click(tree: unknown, label: string) {
  const target = buttons(tree, label)[0];
  expect(target, label).toBeDefined();
  expect(target.props!.disabled).not.toBe(true);
  (target.props!.onClick as () => void)();
}
let jobs: ReturnType<typeof child>;
const view = () => render(jobs.component, jobs.props);
function card() {
  const item = child(view(), "JobCard");
  return render(item.component, item.props);
}
function server(status = 200) {
  const processorFetch = vi.fn(async () => Response.json({}, { status }));
  const statement = {
    bind() {
      return statement;
    },
    async first() {
      return fixture.job;
    },
  };
  const env = {
    DB: { prepare: () => statement },
    PROCESSOR: {
      idFromName: (value: string) => value,
      get: () => ({ fetch: processorFetch }),
    },
  } as unknown as Env;
  const fetch = vi.fn(async (path: string, options: RequestInit) => {
    expect(path).toBe("/api/admin/jobs/job/cancel");
    expect(options.method).toBe("POST");
    try {
      return await cancelJob(env, "job");
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
  });
  vi.stubGlobal("fetch", fetch);
  return { env, fetch, processorFetch };
}
beforeEach(() => {
  fixture.frames.clear();
  fixture.reload.mockClear();
  fixture.job = {
    id: "job",
    video_id: "video",
    version_id: "version",
    quote_id: "quote",
    state: "queued",
    stage: "queued",
    progress_json: null,
    error: null,
    started_at: null,
    deadline_at: null,
    finished_at: null,
    stop_verified: 0,
    stop_evidence_json: null,
    consumption_json: null,
    created_at: 1,
    updated_at: 1,
  };
  vi.stubGlobal("location", { pathname: "/admin/jobs" });
  jobs = child(render(Admin), "Jobs");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["queued", "starting", "running", "stopping", "stop_unverified"])(
  "keeps the real server's %s cancellation available only after explicit confirmation",
  async (state) => {
    fixture.job.state = fixture.job.stage = state;
    const { fetch, processorFetch } = server();
    expect(buttons(card(), "取消任务")).toHaveLength(1);
    expect(text(card())).toContain("实例停止尚未核实，预算预留保持有效");
    click(card(), "取消任务");
    expect(fetch).not.toHaveBeenCalled();
    click(view(), "确认取消任务");
    await vi.waitFor(() => expect(fixture.reload).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledOnce();
    expect(processorFetch).toHaveBeenCalledOnce();
    expect(processorFetch.mock.calls[0]).toEqual([
      "https://processor/cancel",
      { method: "POST", body: JSON.stringify({ jobId: "job" }) },
    ]);
    // A successful cancel request is not itself verified physical stop.
    expect(text(card())).toContain("实例停止尚未核实，预算预留保持有效");
  },
);

it.each([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "needs_confirmation",
  "complete",
  "completed",
  "stopped",
  "awaiting_confirmation",
  "needs_transcode",
  "unknown",
  "future_state",
  "",
])(
  "hides cancellation for non-live %j, matching the actual server's idempotent finished response",
  async (state) => {
    fixture.job.state = fixture.job.stage = state;
    fixture.job.stop_verified = 1;
    const { env, processorFetch } = server();
    expect(buttons(card(), "取消任务")).toHaveLength(0);
    const result = await (await cancelJob(env, "job")).json();
    expect(result).toMatchObject({ alreadyFinished: true, job: { state } });
    expect(processorFetch).not.toHaveBeenCalled();
  },
);

it("shows successful completion in Chinese without offering cancellation", () => {
  fixture.job.state = fixture.job.stage = "succeeded";
  fixture.job.stop_verified = 1;
  const badge = child(card(), "Badge");
  expect(text(render(badge.component, badge.props))).toBe("处理成功");
  expect(text(card())).toContain("实例已核实停止");
  expect(buttons(card(), "取消任务")).toHaveLength(0);
});

it("explains the trusted audio incompatibility reason without suggesting whole-video conversion", () => {
  fixture.job.state = fixture.job.stage = "needs_confirmation";
  fixture.job.stop_verified = 1;
  fixture.job.progress_json = JSON.stringify({
    probe: { audioCodec: "ac3", videoCodec: "h264" },
    reasons: ["Audio must be re-encoded to AAC-LC."],
  });
  const error = child(card(), "MediaErrorBox");
  const explanation = text(render(error.component, error.props));
  expect(explanation).toContain("音频轨道");
  expect(explanation).toContain("仅处理音频、复制视频");
  expect(explanation).toContain("不得直接确认全片转码");
  expect(explanation).toContain("另取报价");
  expect(buttons(card(), "取消任务")).toHaveLength(0);
});

it("keeps an unverified-stop cancellation failure visible and retryable without claiming stop or auto-retrying", async () => {
  fixture.job.state = fixture.job.stage = "stop_unverified";
  const { fetch, processorFetch } = server(503);
  click(card(), "取消任务");
  click(view(), "确认取消任务");
  await vi.waitFor(() => {
    const errors = find(
      view(),
      (item) => item.props?.error instanceof ApiError,
    );
    expect(
      errors.some(
        (item) => (item.props!.error as ApiError).code === "cancel_unverified",
      ),
    ).toBe(true);
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(processorFetch).toHaveBeenCalledOnce();
  expect(fixture.reload).not.toHaveBeenCalled();
  expect(buttons(view(), "确认取消任务")[0].props!.disabled).toBe(false);
  expect(text(card())).toContain("实例停止尚未核实，预算预留保持有效");
});
