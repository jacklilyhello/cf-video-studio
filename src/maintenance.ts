import type { Env } from "./types";
import { now } from "./http";
import { log } from "./logs";

const CURSOR_KEY = "upload_cleanup_cursor";
const BATCH_SIZE = 10;
const CONTROL_TIMEOUT_MS = 2000;
const CANCEL_TIMEOUT_MS = 5000;
const ELIGIBLE = `expires_at<? AND (
  state IN ('uploading','cancelling','completing') OR
  (state IN ('unknown','creating') AND multipart_id IS NOT NULL AND multipart_id<>'')
)`;

class MaintenanceTimeout extends Error {}

async function bounded<T>(
  operation: Promise<T>,
  milliseconds: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new MaintenanceTimeout());
          onTimeout?.();
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function receipt(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const cancel = () => void reader.cancel().catch(() => {});
  if (signal.aborted) {
    cancel();
    return {};
  }
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2048) return {};
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

export interface UploadCleanupSummary {
  attempted: number;
  cancelled: number;
  skipped: number;
  completedProtected: number;
  failed: number;
  timedOut: number;
  controlFailed: boolean;
  statuses: Record<string, number>;
}

export async function cancelExpiredUploads(
  env: Env,
): Promise<UploadCleanupSummary> {
  const summary: UploadCleanupSummary = {
    attempted: 0,
    cancelled: 0,
    skipped: 0,
    completedProtected: 0,
    failed: 0,
    timedOut: 0,
    controlFailed: false,
    statuses: {},
  };
  let selected: { id: string }[];
  try {
    const saved = await bounded(
      env.DB.prepare("SELECT value FROM settings WHERE key=?")
        .bind(CURSOR_KEY)
        .first<{ value: string }>(),
      CONTROL_TIMEOUT_MS,
    );
    const cursor = saved?.value ?? "";
    const expiresBefore = now();
    const next = await bounded(
      env.DB.prepare(
        `SELECT id FROM uploads WHERE ${ELIGIBLE} AND id>? ORDER BY id LIMIT ?`,
      )
        .bind(expiresBefore, cursor, BATCH_SIZE)
        .all<{ id: string }>(),
      CONTROL_TIMEOUT_MS,
    );
    selected = next.results;
    if (cursor && selected.length < BATCH_SIZE) {
      const wrapped = await bounded(
        env.DB.prepare(
          `SELECT id FROM uploads WHERE ${ELIGIBLE} AND id<=? ORDER BY id LIMIT ?`,
        )
          .bind(expiresBefore, cursor, BATCH_SIZE - selected.length)
          .all<{ id: string }>(),
        CONTROL_TIMEOUT_MS,
      );
      selected = selected.concat(wrapped.results);
    }
    if (!selected.length) return summary;
    // Advance before dispatch: failed or pending cancels cannot monopolize the
    // next cron batch. Skip a stale scan if another run has moved this cursor.
    const claimed = await bounded(
      env.DB.prepare(
        `INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
         WHERE settings.value=?`,
      )
        .bind(CURSOR_KEY, selected.at(-1)!.id, now(), cursor)
        .run(),
      CONTROL_TIMEOUT_MS,
    );
    if (claimed.meta.changes !== 1) return summary;
  } catch {
    summary.controlFailed = true;
    await recordSummary(env, summary);
    return summary;
  }

  for (const upload of selected) {
    summary.attempted++;
    const controller = new AbortController();
    let response: Response | undefined;
    try {
      const result = await bounded(
        (async () => {
          response = await env.COORDINATOR.get(
            env.COORDINATOR.idFromName("admission"),
          ).fetch(
            `https://internal/uploads/${encodeURIComponent(upload.id)}/expire`,
            { method: "POST", signal: controller.signal },
          );
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw new MaintenanceTimeout();
          }
          const acknowledgement =
            response.ok || response.status === 409
              ? await receipt(response, controller.signal)
              : {};
          return { status: response.status, acknowledgement };
        })(),
        CANCEL_TIMEOUT_MS,
        () => controller.abort(),
      );
      const status = String(result.status);
      summary.statuses[status] = (summary.statuses[status] ?? 0) + 1;
      if (
        result.status >= 200 &&
        result.status < 300 &&
        result.acknowledgement.cancelled === true &&
        result.acknowledgement.abortVerified === true
      )
        summary.cancelled++;
      else if (
        result.status >= 200 &&
        result.status < 300 &&
        result.acknowledgement.skipped === true &&
        ((result.acknowledgement.reason === "not_expired" &&
          result.acknowledgement.notExpired === true) ||
          result.acknowledgement.reason === "not_eligible")
      )
        summary.skipped++;
      else if (
        result.status === 409 &&
        (result.acknowledgement.error as { code?: unknown } | undefined)
          ?.code === "already_complete"
      )
        summary.completedProtected++;
      else summary.failed++;
    } catch (error) {
      summary.failed++;
      if (error instanceof MaintenanceTimeout) summary.timedOut++;
    } finally {
      controller.abort();
      void response?.body?.cancel().catch(() => {});
    }
  }
  // The coordinator alone verifies abort/object evidence and changes storage
  // reservations. A timeout here proves no cancellation or released capacity.
  await recordSummary(env, summary);
  return summary;
}

async function recordSummary(env: Env, summary: UploadCleanupSummary) {
  await bounded(
    log(env, {
      stage: "upload_expiry_cleanup",
      level: summary.failed || summary.controlFailed ? "warn" : "info",
      message: "过期上传取消核验汇总；未核实的取消保持空间预留",
      details: { ...summary },
    }),
    CONTROL_TIMEOUT_MS,
  ).catch(() => {});
}
