import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: DurableObjectState,
      public env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {},
}));
import { Processor } from "../src/processor";
import type { Env } from "../src/types";

// Exercise the real Processor request and persisted handoff code. Every
// Container operation below is a local stub; no image or media tool is started.
async function handoff(
  mode: string,
  withProbe: boolean,
  sourceChanged = false,
) {
  const probe = {
    durationSeconds: 12.25,
    width: 1920,
    height: 1080,
    videoCodec: "h264",
    videoProfile: "High",
    pixelFormat: "yuv420p",
    frameRate: "30000/1001",
    audioCodec: "aac",
    audioProfile: "LC",
    audioChannels: 2,
    hdr: false,
    rotated: false,
    format: "mov,mp4,m4a,3gp,3g2,mj2",
    formatMetadata: { title: "Synthetic scope" },
    chapters: 0,
    streams: [
      { index: 0, type: "video", codec: "h264", width: 1920, height: 1080 },
      {
        index: 1,
        type: "audio",
        codec: "aac",
        sampleRate: "48000",
        channels: 2,
      },
    ],
  };
  const plan = {
    mode,
    quality: "source",
    sourceKey: "videos/video/source/revision",
    sourceBytes: 1024,
    sourceEtag: "source-etag",
    sourceRevision: "revision",
    encoding: mode === "transcode" ? "h264-aac" : "copy-only",
    outputKind: mode === "faststart" ? "mp4" : "hls",
    outputName: mode === "faststart" ? "optimized.mp4" : "index.m3u8",
    maxMediaObjects: mode === "faststart" ? 1 : 34,
    maxUploadAttempts: 3,
    maxOutputBytes: 4096,
    totalTimeoutSeconds: 1800,
    instance: {
      name: "standard-2",
      vcpu: 1,
      memoryBytes: 6 * 1024 ** 3,
      diskBytes: 20e9,
    },
    ...(withProbe ? { probe } : {}),
  };
  const quote = {
    id: "quote",
    video_id: "video",
    mode,
    quality: "source",
    state: "confirmed",
    source_etag: plan.sourceEtag,
    source_revision: plan.sourceRevision,
    expires_at: Date.now() + 60000,
    data_json: JSON.stringify(plan),
  };
  const video = {
    id: "video",
    source_key: plan.sourceKey,
    source_size: plan.sourceBytes,
    source_etag: plan.sourceEtag,
    source_revision: sourceChanged ? "different-revision" : plan.sourceRevision,
  };
  const version = {
    id: "version",
    mode,
    video_id: video.id,
    task_id: "task",
    prefix: "videos/video/versions/version/",
    state: "processing",
  };
  const job = {
    id: "task",
    state: "queued",
    quote_id: quote.id,
    version_id: version.id,
    video_id: video.id,
  };
  const db = {
    prepare(sql: string) {
      const statement = {
        bind: (..._values: unknown[]) => statement,
        first: async () =>
          sql.includes("FROM jobs")
            ? job
            : sql.includes("FROM quotes")
              ? quote
              : sql.includes("FROM versions")
                ? version
                : sql.includes("FROM videos")
                  ? video
                  : null,
        run: async () => ({ meta: { changes: 1 } }),
      };
      return statement;
    },
  };
  const stored = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => stored.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      stored.set(key, structuredClone(value));
    }),
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: vi.fn(async () => {}),
  };
  let running = false;
  const requests: Request[] = [];
  const port = {
    fetch: vi.fn(async (input: string, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(
        request.url.endsWith("/health") ? { ready: true } : { accepted: true },
        { status: request.url.endsWith("/run") ? 202 : 200 },
      );
    }),
  };
  const container = {
    get running() {
      return running;
    },
    images: { processor: "fixture-image" },
    start: vi.fn(() => {
      running = true;
    }),
    inspect: vi.fn(async () => (running ? { image: "fixture-image" } : null)),
    getTcpPort: vi.fn(() => port),
    interceptOutboundHttp: vi.fn(async () => {}),
    setInactivityTimeout: vi.fn(async () => {}),
    monitor: vi.fn(() => new Promise<void>(() => {})),
    signal: vi.fn(),
    destroy: vi.fn(async () => {
      running = false;
    }),
  };
  let initialization = Promise.resolve();
  const ctx = {
    id: { toString: () => "task-do" },
    container,
    storage,
    exports: { TaskBridge: vi.fn(() => ({})) },
    waitUntil: vi.fn(),
    blockConcurrencyWhile: (callback: () => Promise<void>) => {
      initialization = callback();
      return initialization;
    },
  } as unknown as DurableObjectState;
  const media = {
    head: vi.fn(async () => ({
      size: plan.sourceBytes,
      etag: plan.sourceEtag,
    })),
  };
  const env = {
    DB: db,
    MEDIA: media,
    PROCESSING_ENABLED: "true",
    PROCESSOR: { idFromName: () => ({ toString: () => "task-do" }) },
  } as unknown as Env;
  const processor = new Processor(ctx, env);
  await initialization;
  const response = await processor.fetch(
    new Request("https://processor/start", {
      method: "POST",
      body: JSON.stringify({ jobId: job.id }),
    }),
  );
  const run = requests.find((request) => request.url.endsWith("/run"));
  const task = run
    ? ((await run.json()) as Record<string, unknown>)
    : undefined;
  return {
    processor,
    response,
    task,
    plan,
    quote,
    probe,
    storage,
    stored,
    container,
    media,
    requests,
  };
}
afterEach(() => vi.restoreAllMocks());

describe("confirmed processing probe handoff", () => {
  it.each([
    ["faststart", true, true],
    ["faststart", false, false],
    ["transcode", true, true],
    ["probe-remux", true, false],
  ])(
    "hands off %s with saved probe %s without changing scope",
    async (mode, withProbe, expectedProbe) => {
      const f = await handoff(String(mode), Boolean(withProbe));
      expect(f.response.status).toBe(202);
      expect(f.task).toMatchObject({
        taskId: "task",
        mode,
        quality: "source",
        inputBytes: f.plan.sourceBytes,
        maxOutputBytes: f.plan.maxOutputBytes,
        maxMediaObjects: f.plan.maxMediaObjects,
        memoryBytes: f.plan.instance.memoryBytes,
      });
      if (expectedProbe) expect(f.task?.probe).toEqual(f.probe);
      else expect(f.task).not.toHaveProperty("probe");
      expect(f.task?.deadlineMs).toBe(
        (f.stored.get("lifecycle") as { deadlineAt: number }).deadlineAt -
          15000,
      );
      expect(f.media.head).toHaveBeenCalledWith(f.plan.sourceKey);
      expect(JSON.parse(f.quote.data_json)).toEqual(f.plan);
      expect(f.container.start).toHaveBeenCalledExactlyOnceWith({
        image: "fixture-image",
        instance: "standard-2",
        enableInternet: false,
        labels: { task: "task" },
      });
      expect(f.storage.setAlarm.mock.invocationCallOrder[0]).toBeLessThan(
        f.container.start.mock.invocationCallOrder[0],
      );
      if (mode === "faststart")
        expect(f.task).toMatchObject({
          outputKind: "mp4",
          outputName: "optimized.mp4",
          maxUploadAttempts: 3,
        });
      const replay = await f.processor.fetch(
        new Request("https://processor/start", {
          method: "POST",
          body: '{"jobId":"task"}',
        }),
      );
      expect(await replay.json()).toMatchObject({ duplicate: true });
      expect(f.container.start).toHaveBeenCalledTimes(1);
      expect(
        f.requests.filter((request) => request.url.endsWith("/run")),
      ).toHaveLength(1);
    },
  );
  it("keeps source revision validation before any stub start or handoff", async () => {
    const f = await handoff("faststart", true, true);
    expect(f.response.status).toBe(409);
    expect(f.container.start).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
  });
});
