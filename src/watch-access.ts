import type { Env } from "./types";
import { body, HttpError, json, now, sameOrigin } from "./http";
import { cookie, cookieHeader, equal, isAdmin, rateLimit, sign } from "./auth";

const KEY = "watch_access_json";
const COOKIE = "__Host-vh_watch";
export const WATCH_SESSION_MS = 30 * 24 * 3600 * 1000;
const ITERATIONS = 100000;
interface WatchSettings {
  enabled: boolean;
  revision: number;
  updatedAt: number;
  salt: string | null;
  digest: string | null;
}
const defaults = (): WatchSettings => ({
  enabled: false,
  revision: 0,
  updatedAt: 0,
  salt: null,
  digest: null,
});
function unavailable(): never {
  throw new HttpError(
    503,
    "watch_unavailable",
    "观看授权暂时不可用，请稍后重试",
  );
}
async function watchSign(env: Env, value: string) {
  try {
    return await sign(env, value);
  } catch {
    return unavailable();
  }
}
export async function readWatchSettings(env: Env): Promise<WatchSettings> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?")
      .bind(KEY)
      .first<{ value: string }>();
    if (!row) return defaults();
    const v = JSON.parse(row.value) as WatchSettings;
    if (
      !v ||
      typeof v.enabled !== "boolean" ||
      !Number.isSafeInteger(v.revision) ||
      v.revision < 0 ||
      !Number.isSafeInteger(v.updatedAt) ||
      v.updatedAt < 0 ||
      !(
        v.salt === null ||
        (typeof v.salt === "string" && /^[a-f0-9]{32}$/.test(v.salt))
      ) ||
      !(
        v.digest === null ||
        (typeof v.digest === "string" && /^[a-f0-9]{64}$/.test(v.digest))
      ) ||
      (v.salt === null) !== (v.digest === null) ||
      (v.enabled && !v.digest)
    )
      unavailable();
    return v;
  } catch {
    return unavailable();
  }
}
function publicSettings(v: WatchSettings) {
  return {
    enabled: v.enabled,
    configured: !!v.digest,
    revision: v.revision,
    updatedAt: v.updatedAt,
  };
}
export async function getWatchSettings(env: Env) {
  return json(publicSettings(await readWatchSettings(env)));
}
async function derive(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: ITERATIONS,
      salt: Uint8Array.from(salt.match(/../g)!, (b) => parseInt(b, 16)),
    },
    key,
    256,
  );
  return [...new Uint8Array(bits)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
/** Called only inside the serialized administrative mutation queue. */
export async function changeWatchSettings(
  request: Request,
  env: Env,
  revoke = false,
) {
  const data = await body<Record<string, unknown>>(request, 2048);
  const current = await readWatchSettings(env);
  const allowed = revoke
    ? ["expectedRevision", "confirmed"]
    : ["expectedRevision", "enabled", "password"];
  if (
    Object.keys(data).some((k) => !allowed.includes(k)) ||
    !Number.isSafeInteger(data.expectedRevision) ||
    data.expectedRevision !== current.revision
  )
    throw new HttpError(
      409,
      "watch_settings_changed",
      "观看设置已变化，请刷新后重试",
    );
  if (revoke && data.confirmed !== true)
    throw new HttpError(
      400,
      "confirmation_required",
      "请确认撤销此前签发的全部访客观看授权",
    );
  if (
    !revoke &&
    !Object.hasOwn(data, "enabled") &&
    !Object.hasOwn(data, "password")
  )
    throw new HttpError(
      400,
      "invalid_watch_settings",
      "请选择要修改的观看设置",
    );
  if (Object.hasOwn(data, "enabled") && typeof data.enabled !== "boolean")
    throw new HttpError(400, "invalid_watch_settings", "观看保护设置无效");
  const next = { ...current, revision: current.revision + 1, updatedAt: now() };
  if (!Number.isSafeInteger(next.revision)) unavailable();
  if (!revoke && Object.hasOwn(data, "password")) {
    if (
      typeof data.password !== "string" ||
      data.password.length < 8 ||
      data.password.length > 128 ||
      !data.password.trim()
    )
      throw new HttpError(
        400,
        "invalid_watch_password",
        "观看口令须为 8–128 个字符",
      );
    next.salt = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    next.digest = await derive(data.password, next.salt);
  }
  if (!revoke && typeof data.enabled === "boolean") next.enabled = data.enabled;
  if (next.enabled && !next.digest)
    throw new HttpError(
      400,
      "watch_password_required",
      "请先设置有效观看口令再开启保护",
    );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    ).bind(KEY, JSON.stringify(next), next.updatedAt),
    env.DB.prepare(
      "INSERT INTO logs(id,level,stage,message,created_at) VALUES(?,'info','watch_settings',?,?)",
    ).bind(
      crypto.randomUUID(),
      revoke
        ? "已撤销全部此前访客观看授权"
        : "已更新观看保护设置并撤销旧访客授权",
      next.updatedAt,
    ),
  ]);
  return json(publicSettings(next));
}
async function authorized(request: Request, env: Env, settings: WatchSettings) {
  if (!settings.enabled) return { authorized: true, expiresAt: null };
  if (await isAdmin(request, env)) return { authorized: true, expiresAt: null };
  const value = cookie(request, COOKIE);
  if (!value || value.length > 250)
    return { authorized: false, expiresAt: null };
  const p = value.split(".");
  if (
    p.length !== 4 ||
    !/^\d+$/.test(p[0]) ||
    !/^\d+$/.test(p[1]) ||
    !/^[a-f0-9-]{36}$/.test(p[2]) ||
    !/^[a-f0-9]{64}$/.test(p[3])
  )
    return { authorized: false, expiresAt: null };
  const expiry = Number(p[0]);
  if (
    !Number.isSafeInteger(expiry) ||
    expiry <= now() ||
    expiry > now() + WATCH_SESSION_MS ||
    Number(p[1]) !== settings.revision
  )
    return { authorized: false, expiresAt: null };
  const signature = await watchSign(
    env,
    `watch:${new URL(request.url).host}:${p[0]}:${p[1]}:${p[2]}`,
  );
  return { authorized: await equal(p[3], signature), expiresAt: expiry };
}
export async function watchSession(request: Request, env: Env) {
  const settings = await readWatchSettings(env);
  return json({
    enabled: settings.enabled,
    configured: !!settings.digest,
    ...(await authorized(request, env, settings)),
  });
}
export async function requireViewing(request: Request, env: Env) {
  const settings = await readWatchSettings(env);
  if (!(await authorized(request, env, settings)).authorized)
    throw new HttpError(401, "watch_required", "请输入观看口令");
}
export async function watchLogin(request: Request, env: Env) {
  sameOrigin(request);
  const settings = await readWatchSettings(env);
  if (!settings.enabled)
    return json({ enabled: false, authorized: true, expiresAt: null });
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  await rateLimit(env, `watch-login:${ip}`, 12, 15 * 60 * 1000);
  // An account-wide ceiling is intentionally generous; normal visitors cannot
  // exhaust the administrator login limiter, which uses separate keys.
  await rateLimit(env, "watch-login-global", 500, 15 * 60 * 1000);
  const data = await body<Record<string, unknown>>(request, 2048);
  if (
    typeof data.password !== "string" ||
    data.password.length < 8 ||
    data.password.length > 128 ||
    !(await equal(
      await derive(data.password, settings.salt!),
      settings.digest!,
    ))
  )
    throw new HttpError(401, "invalid_watch_password", "观看口令不正确");
  // A passphrase change/revocation during derivation must not issue fresh access.
  const latest = await readWatchSettings(env);
  if (!latest.enabled || latest.revision !== settings.revision)
    throw new HttpError(
      409,
      "watch_settings_changed",
      "观看设置已变化，请重试",
    );
  const expiresAt = now() + WATCH_SESSION_MS;
  const nonce = crypto.randomUUID();
  const signature = await watchSign(
    env,
    `watch:${new URL(request.url).host}:${expiresAt}:${settings.revision}:${nonce}`,
  );
  return json({ enabled: true, authorized: true, expiresAt }, 200, {
    "Set-Cookie": cookieHeader(
      COOKIE,
      `${expiresAt}.${settings.revision}.${nonce}.${signature}`,
      WATCH_SESSION_MS / 1000,
    ),
  });
}
export async function watchLogout(request: Request, env: Env) {
  sameOrigin(request);
  const settings = await readWatchSettings(env).catch(() => ({
    enabled: true,
  }));
  return json(
    {
      enabled: settings.enabled,
      authorized: !settings.enabled,
      expiresAt: null,
    },
    200,
    {
      "Set-Cookie": cookieHeader(COOKIE, "", 0),
    },
  );
}
