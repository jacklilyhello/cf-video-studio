import { DurableObject } from "cloudflare:workers";
import { changeWatchSettings } from "./watch-access";
import type { Env } from "./types";
import { body, HttpError, json, now, readRequestBytes } from "./http";
import {
  createUpload,
  putPart,
  completeUpload,
  cancelUpload,
  cancelExpiredUpload,
  PART_BYTES,
} from "./uploads";
import { confirmProcessing } from "./jobs";
import { executeDeletion, cancelDeletionPlan } from "./storage";
import { publishVideo, readPublicationRevision } from "./videos";
import { createSourceVersion } from "./source";
import {
  deleteSiteLogo,
  patchSite,
  prepareSiteLogo,
  putSiteLogo,
  type PreparedSiteLogo,
} from "./site";

export class Coordinator extends DurableObject<Env> {
  private tail: Promise<void> = Promise.resolve();
  private pendingParts = 0;
  private pendingSiteBodies = 0;
  async fetch(request: Request) {
    let release: (() => void) | undefined;
    let partSlot = false;
    let siteSlot = false;
    try {
      const path = new URL(request.url).pathname;
      const publication =
        request.method === "POST"
          ? /^\/videos\/([^/]+)\/publish$/.exec(path)
          : null;
      let publicationRevision: number | undefined;
      if (publication) {
        const supplied = request.headers.get("X-Internal-Publication-Revision");
        if (supplied === null)
          publicationRevision = await readPublicationRevision(
            this.env,
            publication[1],
          );
        else {
          if (
            !/^\d+$/.test(supplied) ||
            !Number.isSafeInteger(Number(supplied))
          )
            throw new HttpError(
              400,
              "invalid_publication_revision",
              "发布状态无效",
            );
          publicationRevision = Number(supplied);
        }
      }
      const part =
        request.method === "PUT"
          ? /^\/uploads\/([^/]+)\/parts\/(\d+)$/.exec(path)
          : null;
      let partBytes: Uint8Array | undefined;
      let logo: PreparedSiteLogo | undefined;
      let siteBytes: Uint8Array | undefined;
      const logoUpload = path === "/site/logo" && request.method === "POST";
      const sitePatch = path === "/site" && request.method === "PATCH";
      const watchPatch =
        (path === "/watch" && request.method === "PATCH") ||
        (path === "/watch/revoke" && request.method === "POST");
      if (logoUpload || sitePatch || watchPatch) {
        if (this.pendingSiteBodies >= 2)
          throw new HttpError(429, "site_busy", "设置请求过多，请稍后重试");
        this.pendingSiteBodies++;
        siteSlot = true;
        // Receive and validate slow bodies before joining the mutation queue.
        if (logoUpload) logo = await prepareSiteLogo(request);
        else siteBytes = await readRequestBytes(request, 4096);
      }
      if (part) {
        if (this.pendingParts >= 2)
          throw new HttpError(429, "upload_busy", "分片请求过多，请稍后重试");
        this.pendingParts++;
        partSlot = true;
        // Slow request ingress must not hold the shared control/mutation queue.
        // The slot also covers queued buffers and the eventual R2 mutation.
        partBytes = await readRequestBytes(request, PART_BYTES, {
          idleTimeoutMs: 30000,
          totalTimeoutMs: 5 * 60 * 1000,
        });
      }
      const previous = this.tail;
      this.tail = new Promise<void>((resolve) => (release = resolve));
      await previous;
      if ((logoUpload || sitePatch || watchPatch) && request.signal.aborted)
        throw new HttpError(
          408,
          "request_aborted",
          "请求已中断，请核对设置后重试",
        );
      if (sitePatch)
        return await patchSite(
          new Request(request.url, {
            method: "PATCH",
            headers: request.headers,
            body: siteBytes as BodyInit,
          }),
          this.env,
        );
      if (watchPatch)
        return await changeWatchSettings(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: siteBytes as BodyInit,
          }),
          this.env,
          path === "/watch/revoke",
        );
      if (logoUpload) return await putSiteLogo(this.env, logo!);
      if (path === "/site/logo" && request.method === "DELETE")
        return await deleteSiteLogo(this.env);
      if (path === "/rate") {
        const { key, limit, windowMs } = await body<{
          key: string;
          limit: number;
          windowMs: number;
        }>(request, 4096);
        const saved = await this.ctx.storage.get<{
          count: number;
          expires: number;
        }>(`rate:${key}`);
        const entry =
          saved && saved.expires > now()
            ? saved
            : { count: 0, expires: now() + windowMs };
        if (entry.count >= limit) return json({ limited: true }, 429);
        entry.count++;
        await this.ctx.storage.put(`rate:${key}`, entry);
        if (!(await this.ctx.storage.getAlarm()))
          await this.ctx.storage.setAlarm(now() + 60 * 1000);
        return json({ allowed: true });
      }
      if (path === "/uploads" && request.method === "POST")
        return await createUpload(request, this.env);
      if (path === "/upload-approvals" || path.startsWith("/upload-approvals/"))
        return json(
          {
            error: {
              code: "upload_approval_retired",
              message: "普通上传已取消额外批准，请刷新页面后直接选择文件上传",
            },
          },
          410,
        );
      if (part)
        return await putPart(
          request,
          this.env,
          part[1],
          Number(part[2]),
          partBytes,
        );
      const expired = /^\/uploads\/([^/]+)\/expire$/.exec(path);
      if (expired && request.method === "POST")
        return await cancelExpiredUpload(
          this.env,
          expired[1],
          this.ctx.storage,
        );
      let match = /^\/uploads\/([^/]+)\/(complete|cancel)$/.exec(path);
      if (match)
        return match[2] === "complete"
          ? await completeUpload(this.env, match[1])
          : await cancelUpload(this.env, match[1], this.ctx.storage);
      match = /^\/quotes\/([^/]+)\/confirm$/.exec(path);
      if (match) return await confirmProcessing(this.env, match[1]);
      match = /^\/deletions\/([^/]+)\/cancel$/.exec(path);
      if (match && request.method === "POST")
        return await cancelDeletionPlan(this.env, match[1]);
      match = /^\/deletions\/([^/]+)\/confirm$/.exec(path);
      if (match)
        return await executeDeletion(
          request,
          this.env,
          match[1],
          this.ctx.storage,
        );
      if (publication)
        return await publishVideo(
          request,
          this.env,
          publication[1],
          publicationRevision,
        );
      match = /^\/videos\/([^/]+)\/source-version$/.exec(path);
      if (match && request.method === "POST")
        return await createSourceVersion(request, this.env, match[1]);
      return json({ error: { code: "not_found", message: "Not found" } }, 404);
    } catch (error) {
      if (error instanceof HttpError)
        return json(
          {
            error: {
              code: error.code,
              message: error.message,
              ...(error.details ? { details: error.details } : {}),
            },
          },
          error.status,
        );
      return json(
        {
          error: {
            code: "internal_error",
            message: "操作结果未能确认，请刷新后核对",
          },
        },
        500,
      );
    } finally {
      release?.();
      if (partSlot) this.pendingParts--;
      if (siteSlot) this.pendingSiteBodies--;
    }
  }
  async alarm() {
    const cursor = await this.ctx.storage.get<string>("rate-cleanup-cursor");
    const entries = await this.ctx.storage.list<{ expires: number }>({
      prefix: "rate:",
      limit: 1000,
      ...(cursor ? { startAfter: cursor } : {}),
    });
    for (const [key, value] of entries)
      if (value.expires <= now()) await this.ctx.storage.delete(key);
    if (entries.size === 1000)
      await this.ctx.storage.put(
        "rate-cleanup-cursor",
        [...entries.keys()].at(-1),
      );
    else await this.ctx.storage.delete("rate-cleanup-cursor");
    if (entries.size)
      await this.ctx.storage.setAlarm(
        now() + (entries.size === 1000 ? 1000 : 60 * 1000),
      );
  }
}
