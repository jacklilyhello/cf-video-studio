import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { Env, Job, Quote, Version, Video } from "./types";
import { body, HttpError, json, now } from "./http";
import { log, redact } from "./logs";
import type { QuoteDraft } from "./billing";
import { inspectFaststartObject } from "./faststart";

export type ProcessingPlan = QuoteDraft & {
  probe?: Record<string, unknown>;
  maxMediaObjects?: number;
};
interface Lifecycle {
  jobId: string;
  startRequestedAt: number;
  deadlineAt: number;
  terminal?:
    "succeeded" | "needs_confirmation" | "failed" | "cancelled" | "timed_out";
  error?: string;
  stopRequestedAt?: number;
  image?: string;
  stopAttempts?: number;
  startIssuedAt?: number;
  handoffConfirmedAt?: number;
  observedImage?: string;
  unattributedContainerObserved?: {
    observedAt: number;
    source: "running" | "inspection";
  };
}
interface BridgeProps {
  taskId: string;
}
interface JobContext {
  job: Job;
  quote: Quote;
  plan: ProcessingPlan;
  version: Version;
  video: Video;
}
const SAFE_NAME = /^(index\.m3u8|segment-\d{6}\.ts)$/;
const TERMINAL = [
  "succeeded",
  "needs_confirmation",
  "failed",
  "cancelled",
  "timed_out",
];
const LIVE_STATES = [
  "queued",
  "starting",
  "running",
  "stopping",
  "stop_unverified",
];
// Reserve time inside the confirmed whole-task limit for forced shutdown and
// independent stop inspection. Platform API delays still retain the reservation.
const WORKLOAD_STOP_MARGIN_MS = 15_000;
const OWNER_STOP_MARGIN_MS = 10_000;
const CATALOG_CONTROL_TIMEOUT_MS = 1000;

async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Container control deadline exceeded")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function safeOutputName(name: string, mode = "probe-remux"): boolean {
  return mode === "faststart"
    ? name === "optimized.mp4"
    : ["probe-remux", "transcode"].includes(mode) && SAFE_NAME.test(name);
}

export function validFaststartValidation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const copied = v.copiedStreams as Record<string, unknown>[] | undefined;
  return (
    v.outputKind === "mp4" &&
    v.faststartVerified === true &&
    v.allPacketsDecoded === true &&
    v.packetTimelinesVerified === true &&
    v.codecAndResolutionVerified === true &&
    v.copiedStreamsVerified === true &&
    v.mediaMetadataPreserved === true &&
    v.browserPlaybackAndSeeking === "pending_admin_preview" &&
    (
      [
        ["durationDifferenceSeconds", 0.25],
        ["syncOffsetDifferenceSeconds", 0.15],
        ["syncEndOffsetDifferenceSeconds", 0.25],
      ] as const
    ).every(
      ([key, limit]) =>
        typeof v[key] === "number" &&
        Number.isFinite(v[key]) &&
        Math.abs(v[key] as number) <= Number(limit),
    ) &&
    Array.isArray(copied) &&
    copied.length >= 1 &&
    copied.length <= 2 &&
    copied.every(
      (s) =>
        s &&
        ["video", "audio"].includes(String(s.type)) &&
        Number.isSafeInteger(s.packets) &&
        Number(s.packets) > 0 &&
        s.outputPackets === s.packets &&
        typeof s.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(s.sha256) &&
        s.outputSha256 === s.sha256,
    ) &&
    copied.filter((s) => s.type === "video").length === 1 &&
    new Set(copied.map((s) => s.type)).size === copied.length
  );
}
export function hexDigest(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function stoppedEvidence(
  running: boolean,
  inspection: unknown,
): boolean {
  return running === false && inspection === null;
}
export function manifestSegments(manifest: string): string[] {
  if (!manifest.startsWith("#EXTM3U") || !manifest.includes("#EXT-X-ENDLIST"))
    throw new HttpError(400, "manifest_invalid", "HLS 清单不完整");
  const names = manifest
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  if (
    !names.length ||
    names.length > 10000 ||
    names.some((name) => !/^segment-\d{6}\.ts$/.test(name)) ||
    new Set(names).size !== names.length
  )
    throw new HttpError(
      400,
      "manifest_invalid",
      "HLS 清单包含不安全或重复路径",
    );
  if (/^#EXT-X-(KEY|MAP|MEDIA|STREAM-INF):/m.test(manifest))
    throw new HttpError(400, "manifest_invalid", "不支持含外部引用的清单");
  const durations = [...manifest.matchAll(/^#EXTINF:([\d.]+),/gm)].map((m) =>
    Number(m[1]),
  );
  if (
    durations.length !== names.length ||
    durations.some((v) => !Number.isFinite(v) || v <= 0)
  )
    throw new HttpError(400, "manifest_invalid", "HLS 分片时长无效");
  return names;
}

async function context(env: Env, jobId: string): Promise<JobContext> {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind(jobId)
    .first<Job>();
  if (!job) throw new HttpError(404, "job_missing", "处理任务不存在");
  const [quote, version, video] = await Promise.all([
    env.DB.prepare("SELECT * FROM quotes WHERE id=?")
      .bind(job.quote_id)
      .first<Quote>(),
    env.DB.prepare("SELECT * FROM versions WHERE id=?")
      .bind(job.version_id)
      .first<Version>(),
    env.DB.prepare("SELECT * FROM videos WHERE id=?")
      .bind(job.video_id)
      .first<Video>(),
  ]);
  if (
    !quote ||
    !version ||
    !video ||
    version.task_id !== job.id ||
    version.video_id !== video.id ||
    quote.video_id !== video.id ||
    version.mode !== quote.mode ||
    version.prefix !== `videos/${video.id}/versions/${version.id}/`
  )
    throw new HttpError(409, "job_invalid", "任务引用无效");
  return {
    job,
    quote,
    version,
    video,
    plan: JSON.parse(quote.data_json) as ProcessingPlan,
  };
}

async function processorCall(
  env: Env,
  jobId: string,
  route: string,
  value?: Record<string, unknown>,
): Promise<Response> {
  return env.PROCESSOR.get(env.PROCESSOR.idFromName(jobId)).fetch(
    `https://processor${route}`,
    {
      method: "POST",
      ...(value ? { body: JSON.stringify(value) } : {}),
    },
  );
}

// All access to this Durable Object comes from trusted Worker code. The public
// router never proxies requests to PROCESSOR, including diagnostics or health.
export class Processor extends DurableObject<Env> {
  private lifecycle?: Lifecycle;
  private monitoring = false;
  private stopping = false;
  private starting = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.lifecycle = await ctx.storage.get<Lifecycle>("lifecycle");
      if (ctx.container?.running && this.lifecycle) {
        await this.registerBridge(this.lifecycle.jobId);
        await ctx.container.setInactivityTimeout(60_000);
        if (!this.lifecycle.handoffConfirmedAt && !this.lifecycle.terminal) {
          this.lifecycle.terminal = "failed";
          this.lifecycle.error =
            "任务交接核实前协调器重启，停止现有实例以防空转和重复执行";
          await ctx.storage.put("lifecycle", this.lifecycle);
        }
        this.monitor();
      }
      if (this.lifecycle) await ctx.storage.setAlarm(now() + 1000);
    });
  }

  private async registerBridge(jobId: string) {
    const container = this.ctx.container;
    if (!container)
      throw new HttpError(503, "processor_unconfigured", "Container 未配置");
    const exports = this.ctx.exports as unknown as {
      TaskBridge(options: { props: BridgeProps }): Fetcher;
    };
    await container.interceptOutboundHttp(
      "task.internal",
      exports.TaskBridge({ props: { taskId: jobId } }),
    );
  }

  private monitor() {
    const container = this.ctx.container;
    if (!container || this.monitoring) return;
    this.monitoring = true;
    this.ctx.waitUntil(
      container.monitor().then(
        async () => {
          this.monitoring = false;
          await this.supervise();
        },
        async () => {
          this.monitoring = false;
          if (this.lifecycle && !this.lifecycle.terminal) {
            this.lifecycle.terminal = "failed";
            this.lifecycle.error = "Container 意外退出或启动失败";
            await this.ctx.storage.put("lifecycle", this.lifecycle);
          }
          await this.supervise();
        },
      ),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const route = new URL(request.url).pathname;
    try {
      if (request.method !== "POST")
        return json({ error: "Method not allowed" }, 405);
      if (route === "/start") {
        if (this.starting) return json({ duplicate: true }, 202);
        this.starting = true;
        try {
          return await this.startTask(await body(request));
        } finally {
          this.starting = false;
        }
      }
      if (route === "/supervise") {
        if (!this.lifecycle && request.body)
          await this.reconcileUnstarted(
            String((await body(request)).jobId ?? ""),
            "failed",
          );
        await this.supervise();
        return json({ supervised: true });
      }
      if (route === "/cancel") {
        await this.ctx.storage.put("cancelRequested", true);
        if (!this.lifecycle && request.body)
          await this.reconcileUnstarted(
            String((await body(request)).jobId ?? ""),
            "cancelled",
          );
        if (!this.lifecycle)
          return json({ cancelled: false, reason: "not_started" });
        let job: Job | null = null;
        try {
          job = await bounded(
            this.env.DB.prepare("SELECT * FROM jobs WHERE id=?")
              .bind(this.lifecycle.jobId)
              .first<Job>(),
            CATALOG_CONTROL_TIMEOUT_MS,
          );
        } catch {
          /* Cancellation must still stop a running Container. */
        }
        if (job?.stop_verified && TERMINAL.includes(job.state))
          return json({ job });
        this.lifecycle.terminal ??= "cancelled";
        await this.ctx.storage.put("lifecycle", this.lifecycle);
        await this.stopAndVerify();
        return json({ cancelled: true });
      }
      if (route === "/finish") {
        const input = await body(request);
        if (
          !this.lifecycle ||
          input.jobId !== this.lifecycle.jobId ||
          !TERMINAL.includes(String(input.state))
        )
          throw new HttpError(409, "job_invalid", "任务状态不匹配");
        if (!this.lifecycle.terminal) {
          this.lifecycle.terminal = input.state as Lifecycle["terminal"];
          this.lifecycle.error =
            typeof input.error === "string"
              ? redact(input.error).slice(0, 256)
              : undefined;
          await this.ctx.storage.put("lifecycle", this.lifecycle);
        }
        // Return the bridge acknowledgment before terminating the caller process.
        await this.ctx.storage.setAlarm(now() + 500);
        try {
          await bounded(
            this.env.DB.prepare(
              "UPDATE jobs SET state='stopping',stage='stopping',updated_at=? WHERE id=? AND stop_verified=0",
            )
              .bind(now(), this.lifecycle.jobId)
              .run(),
            CATALOG_CONTROL_TIMEOUT_MS,
          );
        } catch {
          /* The durable terminal state and stop alarm remain authoritative. */
        }
        return json({ stopping: true }, 202);
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      return json(
        {
          error: {
            code: error instanceof HttpError ? error.code : "processor_error",
            message:
              error instanceof HttpError ? error.message : "处理协调失败",
          },
        },
        status,
      );
    }
  }

  private async startTask(input: Record<string, unknown>): Promise<Response> {
    const jobId = String(input.jobId ?? "");
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(jobId) ||
      this.ctx.id.toString() !== this.env.PROCESSOR.idFromName(jobId).toString()
    )
      throw new HttpError(400, "job_invalid", "任务标识无效");
    if (this.lifecycle) {
      if (this.lifecycle.jobId !== jobId)
        throw new HttpError(409, "instance_used", "实例已用于另一个任务");
      // Persisted single-attempt guard: a transport retry can never restart work.
      return json({ jobId, duplicate: true }, 202);
    }
    const details = await context(this.env, jobId);
    const { job, quote, plan, video } = details;
    if (
      this.env.PROCESSING_ENABLED !== "true" ||
      quote.state !== "confirmed" ||
      quote.expires_at <= now() ||
      job.state !== "queued"
    )
      throw new HttpError(409, "start_denied", "任务未获有效启动确认");
    if (
      !video.source_key ||
      video.source_revision !== quote.source_revision ||
      video.source_etag !== quote.source_etag
    )
      throw new HttpError(409, "source_changed", "原片已改变，需重新报价");
    if (
      !Number.isSafeInteger(plan.totalTimeoutSeconds) ||
      plan.totalTimeoutSeconds < 30 ||
      plan.totalTimeoutSeconds > 21600 ||
      !plan.instance?.name ||
      !Number.isSafeInteger(plan.maxOutputBytes) ||
      plan.maxOutputBytes <= 0
    )
      throw new HttpError(409, "quote_invalid", "报价处理范围无效");
    if (
      quote.mode === "faststart" &&
      (quote.quality !== "source" ||
        plan.mode !== "faststart" ||
        plan.quality !== "source" ||
        plan.sourceKey !== video.source_key ||
        plan.sourceBytes !== video.source_size ||
        plan.sourceRevision !== quote.source_revision ||
        plan.sourceEtag !== quote.source_etag ||
        plan.encoding !== "copy-only" ||
        plan.outputKind !== "mp4" ||
        plan.outputName !== "optimized.mp4" ||
        plan.maxMediaObjects !== 1 ||
        plan.maxUploadAttempts !== 3 ||
        plan.maxOutputBytes > 5 * 1024 ** 3 - 5 * 1024 ** 2)
    )
      throw new HttpError(409, "quote_invalid", "MP4 优化报价范围无效");
    const source = await this.env.MEDIA.head(video.source_key);
    if (
      !source ||
      source.etag !== quote.source_etag ||
      source.size !== video.source_size
    )
      throw new HttpError(409, "source_changed", "原片对象与报价不一致");
    const startedAt = now();
    this.lifecycle = {
      jobId,
      startRequestedAt: startedAt,
      deadlineAt: startedAt + plan.totalTimeoutSeconds * 1000,
    };
    // Both persistent attempt state and the stop alarm precede the billable start.
    await this.ctx.storage.put("lifecycle", this.lifecycle);
    await this.ctx.storage.setAlarm(startedAt + 5000);
    await this.env.DB.prepare(
      "UPDATE jobs SET state='starting',stage='starting',started_at=?,deadline_at=?,updated_at=? WHERE id=? AND state='queued'",
    )
      .bind(startedAt, this.lifecycle.deadlineAt, startedAt, jobId)
      .run();
    const container = this.ctx.container;
    try {
      if (!container || !container.images.processor)
        throw new Error("Processor image is unavailable");
      if (container.running)
        throw new Error("Unexpected pre-existing Container");
      await this.registerBridge(jobId);
      this.lifecycle.image = container.images.processor;
      await this.ctx.storage.put("lifecycle", this.lifecycle);
      const size = plan.instance.name as
        "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4";
      if (
        ![
          "lite",
          "standard-1",
          "standard-2",
          "standard-3",
          "standard-4",
        ].includes(size)
      )
        throw new Error("Invalid confirmed instance");
      if (await this.ctx.storage.get<boolean>("cancelRequested")) {
        this.lifecycle.terminal = "cancelled";
        await this.ctx.storage.put("lifecycle", this.lifecycle);
      }
      if (
        this.lifecycle.terminal ||
        now() >= this.lifecycle.deadlineAt - WORKLOAD_STOP_MARGIN_MS
      )
        throw new Error("Task ended before Container start");
      this.lifecycle.startIssuedAt = now();
      await this.ctx.storage.put("lifecycle", this.lifecycle);
      // A cancellation/alarm can run while the durable attempt is being saved.
      // start() is synchronous; no await may separate this guard from that call.
      if (
        this.lifecycle.terminal ||
        now() >= this.lifecycle.deadlineAt - WORKLOAD_STOP_MARGIN_MS
      )
        throw new Error("Task ended before Container start");
      container.start({
        image: container.images.processor,
        instance: size,
        enableInternet: false,
        labels: { task: jobId.slice(0, 64) },
      });
      await container.setInactivityTimeout(60_000);
      this.monitor();
      let ready = false;
      const startupDeadline = Math.min(
        this.lifecycle.deadlineAt - WORKLOAD_STOP_MARGIN_MS,
        startedAt + 60_000,
      );
      while (now() < startupDeadline && !this.lifecycle.terminal) {
        try {
          const response = await container
            .getTcpPort(8080)
            .fetch("http://container/health", {
              signal: AbortSignal.timeout(3000),
            });
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* Startup is asynchronous; the stored deadline remains authoritative. */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready || this.lifecycle.terminal || now() >= startupDeadline)
        throw new Error(
          "Container did not become ready within the startup deadline",
        );
      const runningInfo = await container.inspect();
      if (!runningInfo || runningInfo.image !== this.lifecycle.image)
        throw new Error(
          "Running Container image differs from confirmed deployment",
        );
      this.lifecycle.observedImage = runningInfo.image;
      const task = {
        taskId: jobId,
        mode: quote.mode,
        quality: quote.quality,
        deadlineMs: this.lifecycle.deadlineAt - WORKLOAD_STOP_MARGIN_MS,
        maxOutputBytes: plan.maxOutputBytes,
        maxMediaObjects: plan.maxMediaObjects ?? 10000,
        ...(quote.mode === "faststart"
          ? {
              outputKind: plan.outputKind,
              outputName: plan.outputName,
              maxUploadAttempts: plan.maxUploadAttempts,
            }
          : {}),
        memoryBytes: plan.instance.memoryBytes,
        inputBytes: video.source_size,
        ...((quote.mode === "transcode" || quote.mode === "faststart") &&
        plan.probe
          ? { probe: plan.probe }
          : {}),
      };
      await this.env.DB.prepare(
        "UPDATE jobs SET state='running',stage='downloading',updated_at=? WHERE id=? AND state='starting'",
      )
        .bind(now(), jobId)
        .run();
      const response = await container
        .getTcpPort(8080)
        .fetch("http://container/run", {
          method: "POST",
          body: JSON.stringify(task),
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(5000),
        });
      if (!response.ok) throw new Error("Container rejected confirmed task");
      this.lifecycle.handoffConfirmedAt = now();
      await this.ctx.storage.put("lifecycle", this.lifecycle);
      await log(this.env, {
        stage: "processing_start",
        message: "已启动已确认的 Cloudflare 视频任务",
        videoId: video.id,
        taskId: jobId,
        details: {
          image: this.lifecycle.image,
          instance: plan.instance.name,
          deadlineAt: this.lifecycle.deadlineAt,
        },
      });
      return json({ jobId, started: true }, 202);
    } catch {
      if (!this.lifecycle.terminal) {
        this.lifecycle.terminal = "failed";
        this.lifecycle.error =
          "Container 启动或任务交接失败；为防重复收费不会自动重启";
        await this.ctx.storage.put("lifecycle", this.lifecycle);
      }
      await this.stopAndVerify();
      return json({ jobId, error: "启动失败，停止状态已核对或保留告警" }, 502);
    }
  }

  async alarm(): Promise<void> {
    await this.supervise();
  }

  private async reconcileUnstarted(
    jobId: string,
    terminal: "failed" | "cancelled",
  ): Promise<void> {
    if (
      this.starting ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(jobId) ||
      this.ctx.id.toString() !== this.env.PROCESSOR.idFromName(jobId).toString()
    )
      return;
    const job = await bounded(
      this.env.DB.prepare("SELECT * FROM jobs WHERE id=?")
        .bind(jobId)
        .first<Job>(),
      CATALOG_CONTROL_TIMEOUT_MS,
    );
    if (!job || job.state !== "queued") return;
    // No saved lifecycle means this Durable Object never reached its guarded
    // start call. Inspect nevertheless; absence of state alone is no stop proof.
    const container = this.ctx.container;
    if (
      !container ||
      !stoppedEvidence(
        container.running,
        await bounded(container.inspect(), 3000),
      )
    )
      return;
    this.lifecycle = {
      jobId,
      startRequestedAt: now(),
      deadlineAt: now(),
      terminal,
      error:
        terminal === "failed"
          ? "处理交接未到达已保存的启动阶段，已确认没有运行实例"
          : undefined,
    };
    await this.ctx.storage.put("lifecycle", this.lifecycle);
  }

  private async supervise(): Promise<void> {
    if (!this.lifecycle) return;
    const ownerStopAt = this.lifecycle.deadlineAt - OWNER_STOP_MARGIN_MS;
    // Catalog latency must never stand between an expired physical deadline
    // (or a saved cancellation/completion) and the Container control call.
    if (now() >= ownerStopAt && !this.lifecycle.terminal) {
      this.lifecycle.terminal = "timed_out";
      this.lifecycle.error =
        "任务总时限已到（含启动、下载、处理、上传、校验和停止）";
      await this.ctx.storage.put("lifecycle", this.lifecycle);
    }
    if (
      this.lifecycle.terminal ||
      (!this.starting && !this.ctx.container?.running)
    ) {
      if (!this.lifecycle.terminal) {
        this.lifecycle.terminal = "failed";
        this.lifecycle.error = "Container 停止但未收到完整校验结果";
        await this.ctx.storage.put("lifecycle", this.lifecycle);
      }
      await this.stopAndVerify();
      return;
    }
    if (this.starting && !this.lifecycle.terminal && now() < ownerStopAt) {
      await this.ctx.storage.setAlarm(Math.min(ownerStopAt, now() + 5000));
      return;
    }
    let job: Job | null = null;
    try {
      job = await bounded(
        this.env.DB.prepare("SELECT * FROM jobs WHERE id=?")
          .bind(this.lifecycle.jobId)
          .first<Job>(),
        Math.max(1, Math.min(CATALOG_CONTROL_TIMEOUT_MS, ownerStopAt - now())),
      );
    } catch {
      /* An unavailable catalog must not prevent a deadline stop. */
    }
    if (job?.stop_verified) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (now() >= ownerStopAt && !this.lifecycle.terminal) {
      this.lifecycle.terminal = "timed_out";
      this.lifecycle.error =
        "任务总时限已到（含启动、下载、处理、上传、校验和停止）";
      await this.ctx.storage.put("lifecycle", this.lifecycle);
    }
    if (this.lifecycle.terminal || !this.ctx.container?.running) {
      if (!this.lifecycle.terminal) {
        this.lifecycle.terminal = "failed";
        this.lifecycle.error = "Container 停止但未收到完整校验结果";
        await this.ctx.storage.put("lifecycle", this.lifecycle);
      }
      await this.stopAndVerify();
    } else {
      this.monitor();
      await this.ctx.storage.setAlarm(Math.min(ownerStopAt, now() + 5000));
    }
  }

  private async stopAndVerify(): Promise<void> {
    if (!this.lifecycle || this.stopping) return;
    this.stopping = true;
    const lifecycle = this.lifecycle;
    let finalized = false;
    let retryAt = now() + 5000;
    const rememberUnattributed = async (source: "running" | "inspection") => {
      if (
        !lifecycle.startIssuedAt &&
        !lifecycle.unattributedContainerObserved
      ) {
        lifecycle.unattributedContainerObserved = { observedAt: now(), source };
        // Save before destruction: later null inspection, including after a DO
        // restart, cannot erase an earlier observation of an unowned instance.
        await this.ctx.storage.put("lifecycle", lifecycle);
      }
    };
    try {
      lifecycle.stopRequestedAt ??= now();
      lifecycle.stopAttempts = (lifecycle.stopAttempts ?? 0) + 1;
      await this.ctx.storage.put("lifecycle", lifecycle);
      await this.ctx.storage.setAlarm(now() + 5000);
      const container = this.ctx.container;
      if (!container) throw new Error("Container binding cannot be inspected");
      if (container.running) {
        await rememberUnattributed("running");
        if (
          now() - lifecycle.stopRequestedAt < 1000 &&
          now() < lifecycle.deadlineAt
        ) {
          container.signal(15);
          retryAt = lifecycle.stopRequestedAt + 1000;
          await this.ctx.storage.setAlarm(retryAt);
          try {
            await bounded(
              this.env.DB.prepare(
                "UPDATE jobs SET state='stopping',stage='stopping',updated_at=? WHERE id=? AND stop_verified=0",
              )
                .bind(now(), lifecycle.jobId)
                .run(),
              CATALOG_CONTROL_TIMEOUT_MS,
            );
          } catch {
            /* Stop signal has priority over D1 availability. */
          }
          return;
        }
        await bounded(container.destroy(), 5000);
      }
      let inspection = await bounded(container.inspect(), 3000);
      if (inspection !== null) await rememberUnattributed("inspection");
      if (!container.running && inspection !== null) {
        // A false local running flag is insufficient when the platform still
        // reports an instance. Force destruction rather than retrying inspection forever.
        await bounded(container.destroy(), 5000);
        inspection = await bounded(container.inspect(), 3000);
      }
      const verifiedAt = now();
      if (!stoppedEvidence(container.running, inspection))
        throw new Error("Container stop has not been verified");
      const evidence = {
        verifiedAt,
        running: container.running,
        inspection,
        startRequestedAt: lifecycle.startRequestedAt,
        stopRequestedAt: lifecycle.stopRequestedAt,
        stopAttempts: lifecycle.stopAttempts,
        image: lifecycle.image ?? null,
        observedRunningImage: lifecycle.observedImage ?? null,
        unattributedContainerObserved:
          lifecycle.unattributedContainerObserved ?? null,
        source: "DurableObject.Container.inspect+running",
      };
      const { job, plan } = await bounded(
        context(this.env, lifecycle.jobId),
        CATALOG_CONTROL_TIMEOUT_MS,
      );
      if (job.stop_verified) {
        await this.ctx.storage.deleteAlarm();
        finalized = true;
        return;
      }
      const unattributed = !!lifecycle.unattributedContainerObserved;
      const wallSeconds = unattributed
        ? null
        : lifecycle.startIssuedAt
          ? Math.max(0, (verifiedAt - lifecycle.startIssuedAt) / 1000)
          : 0;
      const consumption = {
        wallSeconds,
        source: unattributed
          ? "unattributed_container_usage_unknown_quote_estimate_retained"
          : "configured_capacity_times_observed_wall_time_upper_estimate",
        officialRecorded: false,
        containerUsageStatus: unattributed
          ? "unknown_unattributed_instance"
          : lifecycle.startIssuedAt
            ? "observed_wall_time_estimate"
            : "proven_no_start",
        unattributedContainerObserved:
          lifecycle.unattributedContainerObserved ?? null,
        ...(unattributed
          ? { retainedContainerQuoteIsUsageUpperBound: false }
          : {}),
        cpuVcpuSecondsUpper:
          wallSeconds === null ? null : plan.instance.vcpu * wallSeconds,
        memoryGibSecondsUpper:
          wallSeconds === null
            ? null
            : (plan.instance.memoryBytes / 1024 ** 3) * wallSeconds,
        diskGbSecondsUpper:
          wallSeconds === null
            ? null
            : (plan.instance.diskBytes / 1e9) * wallSeconds,
        networkEgressBytes: null,
        networkEgressEstimateBytes:
          lifecycle.startIssuedAt || unattributed
            ? (plan.resourceAmounts.containerEgressBytes ?? null)
            : 0,
        operationsSource: "retained_quote_bound_not_official_metering",
      };
      const state = lifecycle.terminal ?? "failed";
      const timestamp = now();
      const amounts = { ...plan.resourceAmounts };
      if (lifecycle.startIssuedAt) {
        if (wallSeconds !== null) {
          amounts.containerCpuSeconds = plan.instance.vcpu * wallSeconds;
          amounts.containerMemoryByteSeconds =
            plan.instance.memoryBytes * wallSeconds;
          amounts.containerDiskByteSeconds =
            plan.instance.diskBytes * wallSeconds;
        }
      } else {
        // No owned start excludes output occupancy. Container usage is zero
        // only if no contrary physical observation was saved; an unowned
        // instance's size/history is unknown, so keep the quote estimate without
        // claiming an actual upper bound. Control/operation estimates remain.
        for (const key of [
          ...(!unattributed
            ? [
                "containerCpuSeconds",
                "containerMemoryByteSeconds",
                "containerDiskByteSeconds",
                "containerEgressBytes",
              ]
            : []),
          "r2CurrentBytes",
          "r2StorageGbMonths",
        ])
          if (key in amounts) amounts[key] = 0;
      }
      await bounded(
        this.env.DB.batch([
          this.env.DB.prepare(
            "UPDATE jobs SET state=?,stage=?,stop_verified=1,stop_evidence_json=?,consumption_json=?,error=?,finished_at=?,updated_at=? WHERE id=? AND stop_verified=0",
          ).bind(
            state,
            state,
            JSON.stringify(evidence),
            JSON.stringify(consumption),
            lifecycle.error ?? null,
            timestamp,
            timestamp,
            job.id,
          ),
          this.env.DB.prepare(
            "UPDATE versions SET state=CASE WHEN ?='succeeded' THEN 'verified' WHEN ?='needs_confirmation' THEN 'needs_confirmation' ELSE 'failed' END WHERE id=? AND state='processing'",
          ).bind(state, state, job.version_id),
          this.env.DB.prepare(
            "UPDATE reservations SET state=?,amounts_json=?,released_at=? WHERE owner_id=? AND kind='processing' AND state='active'",
          ).bind("consumed", JSON.stringify(amounts), timestamp, job.id),
          this.env.DB.prepare(
            "UPDATE videos SET status=CASE WHEN EXISTS(SELECT 1 FROM versions WHERE video_id=videos.id AND state='verified') THEN 'ready' WHEN ?='needs_confirmation' THEN 'needs_confirmation' ELSE 'unprocessed' END,updated_at=? WHERE id=? AND status!='deleted'",
          ).bind(state, timestamp, job.video_id),
        ]),
        CATALOG_CONTROL_TIMEOUT_MS,
      );
      await this.ctx.storage.deleteAlarm();
      finalized = true;
      try {
        await bounded(
          log(this.env, {
            stage: "stop_verified",
            message: "已核实 Container 停止，保留已产生消耗的估计",
            videoId: job.video_id,
            taskId: job.id,
            details: evidence,
          }),
          CATALOG_CONTROL_TIMEOUT_MS,
        );
      } catch {
        /* Logging cannot hold stop control or undo verified evidence. */
      }
    } catch {
      try {
        await bounded(
          this.env.DB.prepare(
            "UPDATE jobs SET state='stop_unverified',stage='stop_unverified',error=?,updated_at=? WHERE id=? AND stop_verified=0",
          )
            .bind(
              "无法核实 Container 已停止；预算预留继续保留，监督重试",
              now(),
              lifecycle.jobId,
            )
            .run(),
          CATALOG_CONTROL_TIMEOUT_MS,
        );
      } catch {
        /* Catalog failure must not cancel the persistent stop retry. */
      }
      retryAt = now() + 5000;
    } finally {
      this.stopping = false;
      // An alarm can fire while a bounded catalog write is still pending and
      // encounter stopping=true. Always replace that consumed alarm on exit.
      if (!finalized)
        await this.ctx.storage.setAlarm(Math.max(now() + 1, retryAt));
    }
  }
}

// This entrypoint is reachable only through the trusted egress intercept. It is
// not exported through the public fetch router and accepts no caller task ID.
export class TaskBridge extends WorkerEntrypoint<Env, BridgeProps> {
  async fetch(request: Request): Promise<Response> {
    try {
      const taskId = this.ctx.props.taskId;
      if (!taskId || !/^[a-zA-Z0-9_-]{1,128}$/.test(taskId))
        throw new HttpError(403, "task_denied", "任务未授权");
      const details = await context(this.env, taskId);
      const { job, video, version } = details;
      if (
        !LIVE_STATES.includes(job.state) ||
        job.stop_verified ||
        !job.deadline_at ||
        now() >= job.deadline_at
      )
        throw new HttpError(403, "task_expired", "任务授权已结束");
      const url = new URL(request.url);
      if (url.hostname !== "task.internal" || url.search || url.hash)
        throw new HttpError(403, "task_denied", "不允许的任务地址");
      if (request.method === "GET" && url.pathname === "/input")
        return await this.input(request, details);
      if (request.method === "PUT" && url.pathname.startsWith("/output/"))
        return await this.output(request, details, url.pathname.slice(8));
      if (request.method === "POST" && url.pathname === "/event") {
        const input = await body(request);
        if (["stopping", "stop_unverified"].includes(job.state))
          return json({ ignored: true });
        const stages = [
          "downloading",
          "probing",
          "processing",
          "validating",
          "uploading",
          "failed",
        ];
        const stage = String(input.stage ?? "");
        if (!stages.includes(stage))
          throw new HttpError(400, "stage_invalid", "任务阶段无效");
        const progress: Record<string, unknown> = {};
        for (const key of [
          "bytes",
          "totalBytes",
          "positionSeconds",
          "durationSeconds",
          "objects",
          "totalObjects",
        ]) {
          if (
            typeof input[key] === "number" &&
            Number.isFinite(input[key]) &&
            input[key] >= 0
          )
            progress[key] = input[key];
        }
        if (stage === "uploading" && input.progressBasis === "persisted-bytes")
          progress.progressBasis = "persisted-bytes";
        if (input.probe && stage === "probing")
          await this.env.DB.prepare(
            "UPDATE videos SET probe_json=?,updated_at=? WHERE id=?",
          )
            .bind(JSON.stringify(input.probe), now(), video.id)
            .run();
        await this.env.DB.prepare(
          "UPDATE jobs SET stage=?,progress_json=?,updated_at=? WHERE id=? AND state=?",
        )
          .bind(stage, JSON.stringify(progress), now(), job.id, job.state)
          .run();
        if (stage === "failed")
          await processorCall(this.env, job.id, "/finish", {
            jobId: job.id,
            state: "failed",
            error:
              typeof input.error === "string"
                ? redact(input.error)
                : "处理失败",
          });
        return json({ recorded: true });
      }
      if (request.method === "POST" && url.pathname === "/needs-confirmation") {
        const input = await body(request);
        if (!input.probe || !Array.isArray(input.reasons))
          throw new HttpError(400, "probe_invalid", "探测结果无效");
        await this.env.DB.prepare(
          "UPDATE videos SET probe_json=?,updated_at=? WHERE id=?",
        )
          .bind(JSON.stringify(input.probe), now(), video.id)
          .run();
        await this.env.DB.prepare(
          "UPDATE jobs SET progress_json=?,updated_at=? WHERE id=?",
        )
          .bind(
            JSON.stringify({ probe: input.probe, reasons: input.reasons }),
            now(),
            job.id,
          )
          .run();
        await processorCall(this.env, job.id, "/finish", {
          jobId: job.id,
          state: "needs_confirmation",
        });
        return json({ confirmationRequired: true });
      }
      if (request.method === "POST" && url.pathname === "/complete")
        return await this.complete(request, details);
      throw new HttpError(403, "task_denied", "不允许的任务操作");
    } catch (error) {
      return json(
        { error: error instanceof HttpError ? error.code : "bridge_failed" },
        error instanceof HttpError ? error.status : 500,
      );
    }
  }

  private async input(
    request: Request,
    { video, quote }: JobContext,
  ): Promise<Response> {
    if (
      !video.source_key ||
      video.source_etag !== quote.source_etag ||
      video.source_revision !== quote.source_revision
    )
      throw new HttpError(409, "source_changed", "原片已改变");
    const range = request.headers.get("Range");
    if (range && !/^bytes=\d+-\d*$/.test(range))
      throw new HttpError(416, "range_invalid", "Range 格式无效");
    const object = await this.env.MEDIA.get(video.source_key, {
      onlyIf: { etagMatches: quote.source_etag },
      ...(range ? { range: request.headers } : {}),
    });
    if (!object || !("body" in object) || object.size !== video.source_size)
      throw new HttpError(409, "source_changed", "原片对象与报价不一致");
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      ETag: object.httpEtag,
      "Accept-Ranges": "bytes",
    });
    let status = 200;
    if (
      object.range &&
      "offset" in object.range &&
      "length" in object.range &&
      object.range.offset !== undefined &&
      object.range.length !== undefined
    ) {
      headers.set(
        "Content-Range",
        `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`,
      );
      headers.set("Content-Length", String(object.range.length));
      status = 206;
    } else headers.set("Content-Length", String(object.size));
    return new Response(object.body, { status, headers });
  }

  private async output(
    request: Request,
    { job, version, plan, quote }: JobContext,
    name: string,
  ): Promise<Response> {
    if (
      !safeOutputName(name, quote.mode) ||
      job.state !== "running" ||
      version.state !== "processing"
    )
      throw new HttpError(403, "output_denied", "产物路径未授权");
    if (
      quote.mode === "faststart" &&
      (plan.mode !== "faststart" ||
        plan.quality !== "source" ||
        plan.encoding !== "copy-only" ||
        plan.maxMediaObjects !== 1 ||
        plan.outputName !== "optimized.mp4" ||
        plan.outputKind !== "mp4" ||
        plan.maxUploadAttempts !== 3)
    )
      throw new HttpError(403, "output_denied", "MP4 产物范围未授权");
    const category = quote.mode === "faststart" ? "mp4" : "hls";
    const length = Number(request.headers.get("Content-Length"));
    const checksum = request.headers.get("X-Content-SHA256") ?? "";
    if (
      !request.body ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > plan.maxOutputBytes ||
      !/^[a-f0-9]{64}$/.test(checksum)
    )
      throw new HttpError(400, "output_invalid", "产物大小或校验值无效");
    const key = `${version.prefix}${name}`;
    const reservation = await this.env.DB.prepare(
      "INSERT INTO objects(key,video_id,version_id,category,bytes,sha256,state,updated_at) SELECT ?,?,?,?, ?,?,'uploading',? WHERE COALESCE((SELECT SUM(bytes) FROM objects WHERE version_id=? AND state IN ('present','uploading')),0)+?<=? AND (SELECT COUNT(*) FROM objects WHERE version_id=? AND state IN ('present','uploading'))<? ON CONFLICT(key) DO NOTHING",
    )
      .bind(
        key,
        job.video_id,
        version.id,
        category,
        length,
        checksum,
        now(),
        version.id,
        length,
        plan.maxOutputBytes,
        version.id,
        plan.maxMediaObjects ?? 10000,
      )
      .run();
    if (reservation.meta.changes !== 1) {
      const indexed = await this.env.DB.prepare(
        "SELECT bytes,sha256 FROM objects WHERE key=? AND version_id=? AND state IN ('present','uploading')",
      )
        .bind(key, version.id)
        .first<{ bytes: number; sha256: string }>();
      if (!indexed || indexed.bytes !== length || indexed.sha256 !== checksum)
        throw new HttpError(
          409,
          "output_budget",
          "产物超出已确认空间或存在同名冲突",
        );
    }
    const existing = await this.env.MEDIA.head(key);
    if (existing) {
      if (
        existing.size !== length ||
        !existing.checksums.sha256 ||
        hexDigest(existing.checksums.sha256) !== checksum
      )
        throw new HttpError(409, "output_conflict", "同名产物内容冲突");
      await this.env.DB.prepare(
        "UPDATE objects SET state='present',etag=?,updated_at=? WHERE key=? AND version_id=?",
      )
        .bind(existing.etag, now(), key, version.id)
        .run();
      return json({
        stored: true,
        duplicate: true,
        name,
        bytes: existing.size,
        sha256: checksum,
      });
    }
    // R2 verifies the actual incoming stream against the supplied SHA-256. No
    // whole-segment buffering or trusting a metadata-only checksum is needed.
    const object = await this.env.MEDIA.put(key, request.body, {
      sha256: checksum,
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: {
        contentType:
          quote.mode === "faststart"
            ? "video/mp4"
            : name.endsWith(".m3u8")
              ? "application/vnd.apple.mpegurl"
              : "video/mp2t",
      },
      customMetadata: { taskId: job.id },
    });
    if (
      !object ||
      object.size !== length ||
      !object.checksums.sha256 ||
      hexDigest(object.checksums.sha256) !== checksum
    )
      throw new HttpError(409, "output_invalid", "R2 实际产物校验失败");
    await this.env.DB.prepare(
      "INSERT INTO objects(key,video_id,version_id,category,bytes,etag,sha256,state,updated_at) VALUES(?,?,?,?,?,?,?,'present',?) ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes,etag=excluded.etag,sha256=excluded.sha256,state=excluded.state,updated_at=excluded.updated_at",
    )
      .bind(
        key,
        job.video_id,
        version.id,
        category,
        object.size,
        object.etag,
        checksum,
        now(),
      )
      .run();
    return json({
      stored: true,
      duplicate: false,
      name,
      bytes: object.size,
      sha256: checksum,
    });
  }

  private async complete(
    request: Request,
    { job, version, plan, quote, video }: JobContext,
  ): Promise<Response> {
    const input = await body(request, 2 * 1024 * 1024);
    const faststart = quote.mode === "faststart";
    const outputName = faststart ? "optimized.mp4" : "index.m3u8";
    if (
      job.state !== "running" ||
      version.state !== "processing" ||
      input.manifest !== outputName ||
      !Array.isArray(input.objects) ||
      (faststart
        ? input.objects.length !== 1 ||
          plan.maxMediaObjects !== 1 ||
          plan.mode !== "faststart" ||
          plan.quality !== "source" ||
          plan.encoding !== "copy-only" ||
          plan.outputKind !== "mp4" ||
          plan.outputName !== outputName ||
          plan.maxUploadAttempts !== 3
        : input.objects.length < 2) ||
      input.objects.length > (plan.maxMediaObjects ?? 10000)
    )
      throw new HttpError(409, "completion_invalid", "任务完成清单无效");
    const validation = input.validation as Record<string, unknown> | undefined;
    if (
      faststart
        ? !validFaststartValidation(validation)
        : !validation ||
          validation.allSegmentsDecoded !== true ||
          validation.playlistDecoded !== true ||
          validation.keyframeStarts !== true ||
          validation.codecAndResolutionVerified !== true
    )
      throw new HttpError(409, "validation_missing", "完整校验证据不足");
    const manifest = faststart
      ? null
      : await this.env.MEDIA.get(`${version.prefix}index.m3u8`);
    if (!faststart && (!manifest || manifest.size > 2 * 1024 * 1024))
      throw new HttpError(409, "manifest_missing", "HLS 清单缺失或超出限制");
    const names = faststart
      ? [outputName]
      : ["index.m3u8", ...manifestSegments(await manifest!.text())].sort();
    const provided = input.objects as {
      name: string;
      size: number;
      sha256: string;
    }[];
    if (
      provided.some(
        (o) =>
          !o ||
          !safeOutputName(o.name, quote.mode) ||
          !Number.isSafeInteger(o.size) ||
          o.size <= 0 ||
          !/^[a-f0-9]{64}$/.test(o.sha256),
      ) ||
      JSON.stringify(provided.map((o) => o.name).sort()) !==
        JSON.stringify(names)
    )
      throw new HttpError(
        409,
        "inventory_invalid",
        "产物清单与 HLS 引用不一致",
      );
    // A full HEAD per segment exceeds the Worker's subrequest limit on long
    // videos. List pages establish current inventory, size and ETag; the indexed
    // checksum was verified by R2 against the actual bytes at each immutable PUT.
    const actualObjects = new Map<string, R2Object>();
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      if (!job.deadline_at || now() >= job.deadline_at)
        throw new HttpError(409, "task_expired", "已到任务总时限");
      const page = await this.env.MEDIA.list({
        prefix: version.prefix,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const object of page.objects) actualObjects.set(object.key, object);
      if (actualObjects.size > (plan.maxMediaObjects ?? 10000))
        throw new HttpError(
          409,
          "inventory_invalid",
          "R2 实际对象超出确认清单",
        );
      if (page.truncated && (!page.cursor || seenCursors.has(page.cursor)))
        throw new HttpError(
          409,
          "inventory_invalid",
          "R2 清单分页无法完整核实",
        );
      cursor = page.truncated ? page.cursor : undefined;
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    const indexed = await this.env.DB.prepare(
      "SELECT key,state,category,bytes,etag,sha256 FROM objects WHERE version_id=? AND state IN ('present','uploading')",
    )
      .bind(version.id)
      .all<{
        key: string;
        state: string;
        category: string;
        bytes: number;
        etag: string;
        sha256: string;
      }>();
    if (indexed.results.some((o) => o.state !== "present"))
      throw new HttpError(409, "inventory_invalid", "产物仍有未核实上传");
    const indexedObjects = new Map(
      indexed.results.map((object) => [object.key, object]),
    );
    const expectedKeys = names.map((name) => `${version.prefix}${name}`).sort();
    if (
      JSON.stringify([...actualObjects.keys()].sort()) !==
        JSON.stringify(expectedKeys) ||
      JSON.stringify([...indexedObjects.keys()].sort()) !==
        JSON.stringify(expectedKeys)
    )
      throw new HttpError(
        409,
        "inventory_invalid",
        "R2 实际对象、索引与 HLS 引用不一致",
      );
    let total = 0;
    for (const expected of provided) {
      const key = `${version.prefix}${expected.name}`;
      const actual = actualObjects.get(key);
      const indexedObject = indexedObjects.get(key);
      if (
        !actual ||
        !indexedObject ||
        actual.size !== expected.size ||
        indexedObject.bytes !== expected.size ||
        actual.etag !== indexedObject.etag ||
        indexedObject.sha256 !== expected.sha256 ||
        (faststart && indexedObject.category !== "mp4") ||
        (actual.checksums?.sha256 &&
          hexDigest(actual.checksums.sha256) !== expected.sha256)
      )
        throw new HttpError(
          409,
          "object_mismatch",
          "R2 产物缺失或与已核实写入不一致",
        );
      if (
        !faststart &&
        expected.name === "index.m3u8" &&
        actual.etag !== manifest!.etag
      )
        throw new HttpError(409, "manifest_changed", "HLS 清单在核对期间改变");
      total += actual.size;
    }
    const duration = Number(input.durationSeconds);
    if (
      total > plan.maxOutputBytes ||
      !Number.isFinite(duration) ||
      duration <= 0
    )
      throw new HttpError(409, "completion_invalid", "产物超出确认范围");
    let mp4Structure;
    if (faststart) {
      // Reconfirm the immutable input identity as well as the actual output;
      // the container cannot authorize a different source through completion.
      if (
        !video.source_key ||
        plan.sourceKey !== video.source_key ||
        plan.sourceBytes !== video.source_size ||
        plan.sourceRevision !== quote.source_revision ||
        plan.sourceEtag !== quote.source_etag ||
        quote.source_revision !== video.source_revision ||
        quote.source_etag !== video.source_etag
      )
        throw new HttpError(409, "source_changed", "原片与确认范围不一致");
      const source = await this.env.MEDIA.head(video.source_key);
      if (
        !source ||
        source.etag !== quote.source_etag ||
        source.size !== plan.sourceBytes
      )
        throw new HttpError(409, "source_changed", "原片实际对象已改变");
      mp4Structure = await inspectFaststartObject(
        this.env,
        actualObjects.get(`${version.prefix}${outputName}`)!,
        { deadlineAt: job.deadline_at! },
      );
      if (
        !mp4Structure.compatible ||
        mp4Structure.index?.placement !== "before-media" ||
        (validation!.copiedStreams as { type: string }[]).some(
          (s) => s.type === "audio",
        ) !== !!mp4Structure.audioCodec ||
        !mp4Structure.durationSeconds ||
        Math.abs(mp4Structure.durationSeconds - duration) > 0.25
      )
        throw new HttpError(409, "mp4_invalid", "MP4 实际结构与校验证据不一致");
      const currentSource = await this.env.DB.prepare(
        "SELECT source_key,source_size,source_etag,source_revision FROM videos WHERE id=?",
      )
        .bind(video.id)
        .first<Video>();
      const sourceAfter = await this.env.MEDIA.head(video.source_key);
      if (
        !currentSource ||
        currentSource.source_key !== plan.sourceKey ||
        currentSource.source_size !== plan.sourceBytes ||
        currentSource.source_etag !== quote.source_etag ||
        currentSource.source_revision !== quote.source_revision ||
        !sourceAfter ||
        sourceAfter.etag !== quote.source_etag ||
        sourceAfter.size !== plan.sourceBytes
      )
        throw new HttpError(409, "source_changed", "原片在校验期间改变");
      const current = await this.env.DB.prepare(
        "SELECT state,stop_verified,deadline_at FROM jobs WHERE id=?",
      )
        .bind(job.id)
        .first<{ state: string; stop_verified: number; deadline_at: number }>();
      if (
        !current ||
        current.state !== "running" ||
        current.stop_verified ||
        current.deadline_at !== job.deadline_at ||
        now() >= current.deadline_at
      )
        throw new HttpError(409, "task_expired", "任务已结束或到达总时限");
    }
    const recorded = await this.env.DB.prepare(
      "UPDATE versions SET manifest=?,bytes=?,duration=?,validation_json=? WHERE id=? AND state=?" +
        (faststart
          ? " AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND state='running' AND stop_verified=0 AND deadline_at>?) AND EXISTS(SELECT 1 FROM videos WHERE id=? AND source_key=? AND source_size=? AND source_etag=? AND source_revision=?)"
          : ""),
    )
      .bind(
        outputName,
        total,
        duration,
        JSON.stringify({
          ...validation,
          r2PutChecksumsVerified: true,
          completionR2EtagsSizesVerified: true,
          actualR2Objects: provided.length,
          ...(mp4Structure ? { mp4Structure } : {}),
          verifiedAt: now(),
        }),
        version.id,
        "processing",
        ...(faststart
          ? [
              job.id,
              now(),
              video.id,
              plan.sourceKey,
              plan.sourceBytes,
              quote.source_etag,
              quote.source_revision,
            ]
          : []),
      )
      .run();
    if (faststart && recorded.meta.changes !== 1)
      throw new HttpError(409, "task_expired", "任务已结束，产物未接受");
    await processorCall(this.env, job.id, "/finish", {
      jobId: job.id,
      state: "succeeded",
    });
    return json({ validated: true, publication: "administrator_required" });
  }
}
