import type { Env } from "./types";
import { HttpError, body, json, now, sameOrigin, sha256 } from "./http";

const ADMIN_COOKIE = "__Host-vh_admin";
const VISITOR_COOKIE = "__Host-vh_visitor";
const SESSION_MS = 8 * 3600 * 1000;
export function cookie(request: Request, name: string): string | null {
  return (
    request.headers
      .get("Cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? null
  );
}
export function cookieHeader(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}
export async function sign(env: Env, value: string) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
    throw new HttpError(503, "not_configured", "管理员会话密钥尚未配置");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function equal(a: string, b: string) {
  return (await sha256(a)) === (await sha256(b));
}
export function configured(env: Env) {
  return !!(
    env.ADMIN_PASSWORD &&
    env.ADMIN_PASSWORD.length >= (env.APP_ENV === "test" ? 10 : 12) &&
    env.SESSION_SECRET &&
    env.SESSION_SECRET.length >= 32
  );
}
export async function isAdmin(request: Request, env: Env): Promise<boolean> {
  if (!configured(env)) return false;
  const value = cookie(request, ADMIN_COOKIE);
  if (!value || value.length > 600) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const expiry = Number(parts[0]);
  if (
    !Number.isSafeInteger(expiry) ||
    expiry <= now() ||
    expiry > now() + SESSION_MS
  )
    return false;
  const payload = `admin:${new URL(request.url).host}:${parts[0]}:${parts[1]}`;
  // Password changes invalidate already issued sessions without storing the password in the cookie.
  return equal(
    parts[2],
    await sign(env, `${payload}:${await sha256(env.ADMIN_PASSWORD!)}`),
  );
}
export async function requireAdmin(request: Request, env: Env) {
  if (!configured(env))
    throw new HttpError(
      503,
      "not_configured",
      "请先手工配置管理员密码和会话密钥",
    );
  if (!(await isAdmin(request, env)))
    throw new HttpError(401, "login_required", "请登录管理员后台");
}
export async function rateLimit(
  env: Env,
  key: string,
  limit: number,
  windowMs: number,
) {
  const response = await env.COORDINATOR.get(
    env.COORDINATOR.idFromName("admission"),
  ).fetch("https://internal/rate", {
    method: "POST",
    body: JSON.stringify({ key: await sha256(key), limit, windowMs }),
  });
  if (!response.ok)
    throw new HttpError(429, "rate_limited", "请求过于频繁，请稍后再试");
}
export async function login(request: Request, env: Env) {
  sameOrigin(request);
  if (!configured(env))
    throw new HttpError(503, "not_configured", "后台尚未配置");
  const host = new URL(request.url).host;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  await rateLimit(env, `login:${host}:${ip}`, 8, 15 * 60 * 1000);
  await rateLimit(env, `login-global:${host}`, 80, 15 * 60 * 1000);
  const data = await body(request, 2048);
  if (
    typeof data.password !== "string" ||
    data.password.length > 1024 ||
    !(await equal(data.password, env.ADMIN_PASSWORD!))
  )
    throw new HttpError(401, "invalid_password", "密码错误");
  const expiry = now() + SESSION_MS;
  const nonce = crypto.randomUUID();
  const signature = await sign(
    env,
    `admin:${host}:${expiry}:${nonce}:${await sha256(env.ADMIN_PASSWORD!)}`,
  );
  return json({ authenticated: true, expiresAt: expiry }, 200, {
    "Set-Cookie": cookieHeader(
      ADMIN_COOKIE,
      `${expiry}.${nonce}.${signature}`,
      SESSION_MS / 1000,
    ),
  });
}
export function logout(request: Request) {
  sameOrigin(request);
  return json({ authenticated: false }, 200, {
    "Set-Cookie": cookieHeader(ADMIN_COOKIE, "", 0),
  });
}
export async function visitor(
  request: Request,
  env: Env,
): Promise<string | null> {
  const value = cookie(request, VISITOR_COOKIE);
  if (!value || value.length > 200) return null;
  const [nonce, signature, ...rest] = value.split(".");
  if (rest.length || !nonce || !signature) return null;
  if (
    !(await equal(
      signature,
      await sign(env, `visitor:${new URL(request.url).host}:${nonce}`),
    ))
  )
    return null;
  return sha256(`${new URL(request.url).host}:${nonce}`);
}
export async function historyWriteContext(
  request: Request,
  env: Env,
  identity: string,
): Promise<string> {
  return sign(env, `history-write:${new URL(request.url).host}:${identity}`);
}
export async function validHistoryWriteContext(
  request: Request,
  env: Env,
  identity: string,
  context: unknown,
): Promise<boolean> {
  return (
    typeof context === "string" &&
    /^[a-f0-9]{64}$/.test(context) &&
    (await equal(context, await historyWriteContext(request, env, identity)))
  );
}
export async function visitorIdentity(request: Request, env: Env) {
  sameOrigin(request);
  await rateLimit(
    env,
    `visitor-identity:${new URL(request.url).host}:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
    60,
    60 * 1000,
  );
  if (await visitor(request, env)) return json({ identityIssued: true });
  const nonce = crypto.randomUUID();
  const signature = await sign(
    env,
    `visitor:${new URL(request.url).host}:${nonce}`,
  );
  return json({ identityIssued: true }, 200, {
    "Set-Cookie": cookieHeader(
      VISITOR_COOKIE,
      `${nonce}.${signature}`,
      180 * 24 * 3600,
    ),
  });
}
export function clearVisitorCookie() {
  return cookieHeader(VISITOR_COOKIE, "", 0);
}
