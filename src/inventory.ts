import type { Env, Version } from "./types";
import { HttpError } from "./http";
import { verifySourceVersion } from "./source";
import { verifyFaststartVersion } from "./faststart";
export async function listPrefix(
  env: Env,
  prefix: string,
): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}
export async function verifyVersionObjects(env: Env, version: Version) {
  if (version.mode === "source") {
    await verifySourceVersion(env, version);
    return;
  }
  if (version.mode === "faststart") {
    await verifyFaststartVersion(env, version, { inspectStructure: true });
    return;
  }
  if (!["probe-remux", "transcode"].includes(version.mode))
    throw new HttpError(409, "version_unverified", "版本处理方式无法核实");
  if (version.state !== "verified")
    throw new HttpError(409, "version_unverified", "版本不在完整校验通过状态");
  let validatedObjectCount: unknown;
  try {
    const validation = JSON.parse(version.validation_json ?? "null");
    validatedObjectCount = validation?.actualR2Objects;
  } catch {
    // An unreadable original validation record cannot prove an independent HLS.
  }
  const expected = await env.DB.prepare(
    `SELECT key,bytes,etag,state FROM objects WHERE version_id=?`,
  )
    .bind(version.id)
    .all<{ key: string; bytes: number; etag: string; state: string }>();
  if (
    !version.manifest ||
    !Number.isSafeInteger(validatedObjectCount) ||
    Number(validatedObjectCount) < 2 ||
    expected.results.length !== validatedObjectCount ||
    expected.results.some((o) => o.state !== "present") ||
    expected.results.reduce((total, o) => total + o.bytes, 0) !==
      version.bytes ||
    !expected.results.some((o) => o.key === version.prefix + version.manifest)
  )
    throw new HttpError(409, "hls_incomplete", "HLS 校验或对象清单不完整");
  const actual = new Map(
    (await listPrefix(env, version.prefix)).map((o) => [o.key, o]),
  );
  if (
    actual.size !== expected.results.length ||
    expected.results.some((o) => {
      const item = actual.get(o.key);
      return !item || item.size !== o.bytes || item.etag !== o.etag;
    })
  )
    throw new HttpError(
      409,
      "objects_changed",
      "实际 HLS 对象缺失或变化，请对账",
    );
}
