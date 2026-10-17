import type { Env } from "./types";
import { body, HttpError, json, readRequestBytes, sha256 } from "./http";

export const DEFAULT_SITE_NAME = "Video Hub";
export const MAX_SITE_LOGO_BYTES = 512 * 1024;
const SETTING = "site_branding_json";
const PREFIX = "site/branding/";
// Same project-bucket census bound as upload/processing admission. No account API.
const PROJECT_STORAGE_CENSUS_MAX_PAGES = 100;
const HASH = /^[a-f0-9]{64}$/;
const ETAG = /^[a-zA-Z0-9_-]{1,128}$/;
type LogoFormat = "png" | "jpg";
export interface SiteLogo {
  hash: string;
  ext: LogoFormat;
  width: number;
  height: number;
  bytes: number;
  etag: string;
}
export interface SiteState {
  name: string;
  searchIndexing: boolean;
  logo: SiteLogo | null;
  updatedAt: number;
}
export const DEFAULT_SITE_SETTINGS: Readonly<SiteState> = Object.freeze({
  name: DEFAULT_SITE_NAME,
  logo: null,
  searchIndexing: false,
  updatedAt: 0,
});
export interface PreparedSiteLogo {
  bytes: Uint8Array;
  hash: string;
  ext: LogoFormat;
  width: number;
  height: number;
}
const invalidLogo = () =>
  new HttpError(400, "invalid_logo", "Logo 必须是结构完整的 PNG 或 JPEG 图片");
function dimensions(width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 32 ||
    height < 32 ||
    width > 2048 ||
    height > 2048 ||
    width * height > 4_000_000
  )
    throw new HttpError(
      400,
      "logo_dimensions",
      "Logo 宽高须为 32–2048 像素，总像素不超过 400 万",
    );
}
function siteName(input: unknown) {
  if (
    typeof input !== "string" ||
    /[\u0000-\u001f\u007f]/.test(input) ||
    Array.from(input.trim()).length > 60
  )
    throw new HttpError(400, "site_name", "站点名称最多 60 个字符");
  return input.trim() || DEFAULT_SITE_NAME;
}
function keys(value: object, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
export async function readSiteSettings(env: Env): Promise<SiteState> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?")
    .bind(SETTING)
    .first<{ value: string }>();
  if (!row) return { ...DEFAULT_SITE_SETTINGS };
  try {
    if (typeof row.value !== "string" || row.value.length > 4096)
      throw new Error();
    const value = JSON.parse(row.value);
    if (
      !value ||
      Array.isArray(value) ||
      typeof value !== "object" ||
      !keys(value, ["name", "searchIndexing", "logo", "updatedAt"]) ||
      typeof value.searchIndexing !== "boolean" ||
      !Number.isSafeInteger(value.updatedAt) ||
      value.updatedAt < 0 ||
      siteName(value.name) !== value.name
    )
      throw new Error();
    if (value.logo !== null) {
      const logo = value.logo;
      if (
        !logo ||
        Array.isArray(logo) ||
        typeof logo !== "object" ||
        !keys(logo, ["hash", "ext", "width", "height", "bytes", "etag"]) ||
        !HASH.test(logo.hash) ||
        !["png", "jpg"].includes(logo.ext) ||
        !Number.isSafeInteger(logo.bytes) ||
        logo.bytes < 1 ||
        logo.bytes > MAX_SITE_LOGO_BYTES ||
        typeof logo.etag !== "string" ||
        !ETAG.test(logo.etag)
      )
        throw new Error();
      dimensions(logo.width, logo.height);
    }
    return value as SiteState;
  } catch {
    throw new HttpError(503, "site_unavailable", "站点设置暂时无法核验");
  }
}
function publicState(site: SiteState) {
  return {
    name: site.name,
    logoUrl: site.logo ? `/site-logo/${site.logo.hash}.${site.logo.ext}` : null,
    searchIndexing: site.searchIndexing,
    updatedAt: site.updatedAt,
  };
}
export async function getSite(env: Env, admin = false) {
  const site = await readSiteSettings(env);
  return json({
    ...publicState(site),
    ...(admin
      ? {
          logo: site.logo
            ? {
                width: site.logo.width,
                height: site.logo.height,
                bytes: site.logo.bytes,
              }
            : null,
        }
      : {}),
  });
}
async function saveSite(env: Env, site: SiteState) {
  await env.DB.prepare(
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
  )
    .bind(SETTING, JSON.stringify(site), site.updatedAt)
    .run();
  return json({
    ...publicState(site),
    logo: site.logo
      ? {
          width: site.logo.width,
          height: site.logo.height,
          bytes: site.logo.bytes,
        }
      : null,
  });
}
export async function patchSite(request: Request, env: Env) {
  const input = await body(request, 4096);
  if (
    !keys(input, ["name", "searchIndexing"]) ||
    !Object.keys(input).length ||
    ("searchIndexing" in input && typeof input.searchIndexing !== "boolean")
  )
    throw new HttpError(400, "site_settings", "站点设置格式错误");
  const name = "name" in input ? siteName(input.name) : undefined;
  const site = await readSiteSettings(env);
  return saveSite(env, {
    ...site,
    name: name ?? site.name,
    searchIndexing:
      input.searchIndexing === undefined
        ? site.searchIndexing
        : (input.searchIndexing as boolean),
    updatedAt: Date.now(),
  });
}
export async function deleteSiteLogo(env: Env) {
  const site = await readSiteSettings(env);
  return saveSite(env, { ...site, logo: null, updatedAt: Date.now() });
}

const crcTable = new Uint32Array(256).map((_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
async function png(bytes: Uint8Array) {
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte))
    throw invalidLogo();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 8,
    width = 0,
    height = 0,
    channels = 0,
    palette = false,
    seenData = false,
    endedData = false,
    ended = false,
    count = 0;
  const compressed: Uint8Array[] = [];
  while (position < bytes.length) {
    if (++count > 1024 || position + 12 > bytes.length) throw invalidLogo();
    const length = view.getUint32(position),
      end = position + 12 + length;
    if (end > bytes.length) throw invalidLogo();
    const type = String.fromCharCode(
      ...bytes.subarray(position + 4, position + 8),
    );
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      crc32(bytes.subarray(position + 4, end - 4)) !== view.getUint32(end - 4)
    )
      throw invalidLogo();
    const data = position + 8;
    if (count === 1 && type !== "IHDR") throw invalidLogo();
    if (type === "IHDR") {
      if (count !== 1 || length !== 13) throw invalidLogo();
      width = view.getUint32(data);
      height = view.getUint32(data + 4);
      dimensions(width, height);
      const color = bytes[data + 9];
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[
        color
      ];
      // Deliberately support the common static, 8-bit, non-interlaced subset.
      if (
        bytes[data + 8] !== 8 ||
        !channels ||
        bytes[data + 10] !== 0 ||
        bytes[data + 11] !== 0 ||
        bytes[data + 12] !== 0
      )
        throw invalidLogo();
    } else if (type === "PLTE") {
      if (
        palette ||
        seenData ||
        !length ||
        length > 768 ||
        length % 3 ||
        [0, 4].includes(bytes[25])
      )
        throw invalidLogo();
      palette = true;
    } else if (type === "IDAT") {
      if (endedData || (bytes[25] === 3 && !palette)) throw invalidLogo();
      seenData = true;
      compressed.push(bytes.subarray(data, data + length));
    } else if (type === "IEND") {
      if (length !== 0 || !seenData || end !== bytes.length)
        throw invalidLogo();
      ended = true;
    } else {
      if (seenData) endedData = true;
      if (
        type[0] === type[0].toUpperCase() ||
        ["acTL", "fcTL", "fdAT"].includes(type)
      )
        throw invalidLogo();
    }
    position = end;
  }
  if (!ended) throw invalidLogo();
  const size = compressed.reduce((sum, value) => sum + value.length, 0);
  if (!size) throw invalidLogo();
  const input = new Uint8Array(size);
  let offset = 0;
  for (const part of compressed) {
    input.set(part, offset);
    offset += part.length;
  }
  const expected = (width * channels + 1) * height;
  let scanlines: Uint8Array;
  try {
    const output = new Response(input as BodyInit).body!.pipeThrough(
      new DecompressionStream("deflate"),
    );
    scanlines = await readRequestBytes(
      new Request("https://logo.internal/validate", {
        method: "POST",
        body: output,
        duplex: "half",
      } as RequestInit),
      expected + 1,
      { idleTimeoutMs: 5000, totalTimeoutMs: 5000 },
    );
  } catch {
    throw invalidLogo();
  }
  if (scanlines.length !== expected) throw invalidLogo();
  for (let row = 0; row < height; row++)
    if (scanlines[row * (width * channels + 1)] > 4) throw invalidLogo();
  return { width, height, ext: "png" as const };
}
function jpeg(bytes: Uint8Array) {
  if (bytes[0] !== 255 || bytes[1] !== 216) throw invalidLogo();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 2,
    width = 0,
    height = 0,
    frame = 0,
    markers = 0,
    scans = 0,
    restartInterval = 0;
  const components = new Map<number, number>(),
    quantization = new Set<number>(),
    huffman = new Set<number>(),
    scanned = new Set<number>();
  while (p < bytes.length) {
    if (++markers > 2048 || bytes[p++] !== 255) throw invalidLogo();
    while (bytes[p] === 255) p++;
    const marker = bytes[p++];
    if (marker === 217) {
      if (
        p !== bytes.length ||
        !frame ||
        !scans ||
        scanned.size !== components.size
      )
        throw invalidLogo();
      return { width, height, ext: "jpg" as const };
    }
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 216 ||
      (marker >= 208 && marker <= 215) ||
      p + 2 > bytes.length
    )
      throw invalidLogo();
    const length = view.getUint16(p),
      start = p + 2,
      end = p + length;
    if (length < 2 || end > bytes.length) throw invalidLogo();
    if (marker === 192 || marker === 194) {
      if (frame || length < 8 || bytes[start] !== 8) throw invalidLogo();
      height = view.getUint16(start + 1);
      width = view.getUint16(start + 3);
      dimensions(width, height);
      const count = bytes[start + 5];
      if (![1, 3].includes(count) || length !== 8 + 3 * count)
        throw invalidLogo();
      for (let i = 0; i < count; i++) {
        const q = start + 6 + i * 3,
          sampling = bytes[q + 1];
        if (
          components.has(bytes[q]) ||
          sampling >> 4 < 1 ||
          sampling >> 4 > 4 ||
          (sampling & 15) < 1 ||
          (sampling & 15) > 4 ||
          bytes[q + 2] > 3
        )
          throw invalidLogo();
        components.set(bytes[q], bytes[q + 2]);
      }
      frame = marker;
    } else if (marker === 219) {
      let q = start;
      while (q < end) {
        const info = bytes[q++],
          precision = info >> 4;
        if (precision > 1 || (info & 15) > 3 || q + 64 * (precision + 1) > end)
          throw invalidLogo();
        for (let n = 0; n < 64; n++)
          if ((precision ? view.getUint16(q + n * 2) : bytes[q + n]) === 0)
            throw invalidLogo();
        quantization.add(info & 15);
        q += 64 * (precision + 1);
      }
    } else if (marker === 196) {
      let q = start;
      while (q < end) {
        if (q + 17 > end) throw invalidLogo();
        const info = bytes[q++];
        if (info >> 4 > 1 || (info & 15) > 3) throw invalidLogo();
        let symbols = 0,
          slots = 1;
        for (let n = 0; n < 16; n++) {
          const count = bytes[q++];
          symbols += count;
          slots = slots * 2 - count;
          if (slots < 0) throw invalidLogo();
        }
        if (!symbols || symbols > 256 || q + symbols > end) throw invalidLogo();
        huffman.add(info);
        q += symbols;
      }
    } else if (marker === 221) {
      if (length !== 4) throw invalidLogo();
      restartInterval = view.getUint16(start);
    } else if (marker === 218) {
      if (!frame || ++scans > 256) throw invalidLogo();
      const count = bytes[start];
      if (!count || count > components.size || length !== 6 + count * 2)
        throw invalidLogo();
      const spectralStart = bytes[start + 1 + count * 2],
        spectralEnd = bytes[start + 2 + count * 2],
        approximation = bytes[start + 3 + count * 2];
      if (
        frame === 192
          ? spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0
          : spectralStart > spectralEnd ||
            spectralEnd > 63 ||
            (spectralStart === 0 && spectralEnd !== 0) ||
            (spectralStart > 0 && count !== 1) ||
            approximation >> 4 > 13 ||
            (approximation & 15) > 13 ||
            (approximation >> 4 &&
              approximation >> 4 !== (approximation & 15) + 1)
      )
        throw invalidLogo();
      const ids = new Set<number>();
      for (let i = 0; i < count; i++) {
        const q = start + 1 + i * 2,
          track = bytes[q],
          tables = bytes[q + 1];
        if (
          ids.has(track) ||
          !components.has(track) ||
          !quantization.has(components.get(track)!) ||
          tables >> 4 > 3 ||
          (tables & 15) > 3 ||
          (spectralStart === 0 && !huffman.has(tables >> 4)) ||
          (spectralEnd > 0 && !huffman.has(16 | (tables & 15)))
        )
          throw invalidLogo();
        ids.add(track);
        if (spectralStart === 0) scanned.add(track);
      }
      p = end;
      const entropyStart = p;
      while (p < bytes.length) {
        if (bytes[p++] !== 255) continue;
        const markerStart = p - 1;
        while (bytes[p] === 255) p++;
        if (bytes[p] === 0) {
          p++;
          continue;
        }
        if (bytes[p] >= 208 && bytes[p] <= 215) {
          if (!restartInterval) throw invalidLogo();
          p++;
          continue;
        }
        p = markerStart;
        break;
      }
      if (p === entropyStart || p >= bytes.length) throw invalidLogo();
      continue;
    } else if (!(marker >= 224 && marker <= 239) && marker !== 254) {
      // Reject arithmetic/lossless/hierarchical/JPEG extensions not implemented.
      throw invalidLogo();
    }
    p = end;
  }
  throw invalidLogo();
}
export async function prepareSiteLogo(
  request: Request,
): Promise<PreparedSiteLogo> {
  const type = request.headers
    .get("Content-Type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (type !== "image/png" && type !== "image/jpeg")
    throw new HttpError(
      415,
      "logo_type",
      "Logo 仅支持 PNG 或 JPEG，不支持 SVG 或外部地址",
    );
  const bytes = await readRequestBytes(request, MAX_SITE_LOGO_BYTES);
  const image = type === "image/png" ? await png(bytes) : jpeg(bytes);
  return { ...image, bytes, hash: await sha256(bytes) };
}

function bounded<T>(
  pending: Promise<T>,
  code = "logo_storage_unverified",
  timeoutMs = 5000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  void pending.catch(() => {});
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new HttpError(503, code, "Logo 存储状态暂时无法核验，请重试")),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
function logoKey(logo: Pick<SiteLogo, "hash" | "ext">) {
  return `${PREFIX}${logo.hash}.${logo.ext}`;
}
const storageFence = `MAX((SELECT COALESCE(SUM(bytes),0) FROM objects WHERE state='present'),?)
 + (SELECT COALESCE(SUM(reserved_bytes),0) FROM uploads WHERE state NOT IN ('complete','cancelled','expired'))
 + (SELECT COALESCE(SUM(COALESCE(json_extract(amounts_json,'$.r2CurrentBytes'),0)),0) FROM reservations WHERE kind!='upload_approval' AND state NOT IN ('released','reconciled') AND id!=?)
 + ? <= MIN(?,CAST(COALESCE((SELECT value FROM settings WHERE key='storage_limit_bytes'),?) AS INTEGER))`;
async function reserveLogo(
  env: Env,
  reservationId: string,
  key: string,
  bytes: number,
) {
  let actual = 0,
    cursor: string | undefined;
  const seen = new Set<string>(),
    cursors = new Set<string>(),
    until = Date.now() + 5000;
  for (let page = 0; ; page++) {
    if (page >= PROJECT_STORAGE_CENSUS_MAX_PAGES || Date.now() >= until)
      throw new HttpError(503, "storage_unknown", "项目实际空间无法完整核验");
    const result = await bounded(
      env.MEDIA.list({ cursor, limit: 1000 }),
      "storage_unknown",
      Math.max(1, until - Date.now()),
    );
    if (
      Date.now() >= until ||
      !Array.isArray(result.objects) ||
      result.objects.length > 1000 ||
      typeof result.truncated !== "boolean"
    )
      throw new HttpError(503, "storage_unknown", "项目实际空间无法完整核验");
    for (const object of result.objects) {
      if (
        !object.key ||
        seen.has(object.key) ||
        !Number.isSafeInteger(object.size) ||
        object.size < 0 ||
        !Number.isSafeInteger(actual + object.size)
      )
        throw new HttpError(503, "storage_unknown", "项目实际空间无法完整核验");
      seen.add(object.key);
      actual += object.size;
    }
    if (!result.truncated) break;
    if (!result.cursor || cursors.has(result.cursor))
      throw new HttpError(503, "storage_unknown", "项目实际空间无法完整核验");
    cursor = result.cursor;
    cursors.add(cursor);
  }
  const row = await env.DB.prepare(
    `SELECT
    COALESCE((SELECT value FROM settings WHERE key='storage_limit_bytes'),'10737418240') AS limit_value,
    (SELECT COALESCE(SUM(bytes),0) FROM objects WHERE state='present') AS stored,
    (SELECT COALESCE(SUM(reserved_bytes),0) FROM uploads WHERE state NOT IN ('complete','cancelled','expired')) AS uploads,
    (SELECT COALESCE(SUM(CASE WHEN json_valid(amounts_json) THEN COALESCE(json_extract(amounts_json,'$.r2CurrentBytes'),0) ELSE 0 END),0) FROM reservations WHERE kind!='upload_approval' AND state NOT IN ('released','reconciled') AND id!=?) AS reservations,
    (SELECT COUNT(*) FROM reservations WHERE state NOT IN ('released','reconciled') AND CASE WHEN json_valid(amounts_json) THEN CASE WHEN json_type(amounts_json)='object' AND (json_type(amounts_json,'$.r2CurrentBytes') IS NULL OR (json_type(amounts_json,'$.r2CurrentBytes') IN ('integer','real') AND json_extract(amounts_json,'$.r2CurrentBytes')>=0 AND json_extract(amounts_json,'$.r2CurrentBytes')<=9007199254740991 AND json_extract(amounts_json,'$.r2CurrentBytes')=CAST(json_extract(amounts_json,'$.r2CurrentBytes') AS INTEGER))) THEN 0 ELSE 1 END ELSE 1 END) AS invalid`,
  )
    .bind(reservationId)
    .first<{
      limit_value: string;
      stored: number;
      uploads: number;
      reservations: number;
      invalid: number;
    }>();
  if (
    !row ||
    row.invalid ||
    ![row.stored, row.uploads, row.reservations, Number(row.limit_value)].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    throw new HttpError(503, "storage_unknown", "项目空间预留账本无法核验");
  const limit = Number(row.limit_value),
    timestamp = Date.now();
  const values = [actual, reservationId, bytes, limit, limit];
  const result = await env.DB.prepare(
    `INSERT INTO reservations(id,owner_id,kind,amounts_json,state,created_at) SELECT ?,?,'branding',?,'active',? WHERE ${storageFence} ON CONFLICT(id) DO UPDATE SET amounts_json=excluded.amounts_json,state='active',released_at=NULL WHERE reservations.owner_id=excluded.owner_id AND reservations.kind='branding'`,
  )
    .bind(
      reservationId,
      key,
      JSON.stringify({ r2CurrentBytes: bytes }),
      timestamp,
      ...values,
    )
    .run();
  if (result.meta.changes !== 1)
    throw new HttpError(
      409,
      "storage_limit",
      "Logo、实际对象和在途预留超过项目存储上限",
    );
}
async function verifyStoredLogo(
  env: Env,
  key: string,
  prepared: PreparedSiteLogo,
): Promise<R2Object | null> {
  const head = await bounded(env.MEDIA.head(key));
  if (!head) return null;
  if (head.size !== prepared.bytes.length || !ETAG.test(head.etag))
    throw new HttpError(
      409,
      "logo_conflict",
      "同名 Logo 对象内容无法核验，未覆盖已有对象",
    );
  let closed = false;
  const pending = env.MEDIA.get(key, {
    onlyIf: { etagMatches: head.etag },
  }).then((object) => {
    if (closed && object && "body" in object)
      void object.body.cancel().catch(() => {});
    return object;
  });
  try {
    const object = await bounded(pending);
    if (
      !object ||
      !("body" in object) ||
      object.etag !== head.etag ||
      object.size !== head.size
    ) {
      if (object && "body" in object) void object.body.cancel().catch(() => {});
      throw new Error();
    }
    const bytes = await readRequestBytes(
      new Request("https://logo.internal/verify", {
        method: "POST",
        body: object.body,
        duplex: "half",
      } as RequestInit),
      MAX_SITE_LOGO_BYTES,
      { idleTimeoutMs: 5000, totalTimeoutMs: 5000 },
    );
    if (
      bytes.length !== prepared.bytes.length ||
      (await sha256(bytes)) !== prepared.hash
    )
      throw new Error();
    return head;
  } catch {
    throw new HttpError(
      503,
      "logo_storage_unverified",
      "Logo 实际对象内容暂时无法核验，原设置未改变",
    );
  } finally {
    closed = true;
  }
}
/** The caller serializes admission with uploads; no request stream is held here. */
export async function putSiteLogo(env: Env, prepared: PreparedSiteLogo) {
  // Prepared data is an internal convenience, never an alternative trust boundary.
  if (
    !(prepared.bytes instanceof Uint8Array) ||
    prepared.bytes.length > MAX_SITE_LOGO_BYTES ||
    !["png", "jpg"].includes(prepared.ext)
  )
    throw invalidLogo();
  const validated = await prepareSiteLogo(
    new Request("https://logo.internal/upload", {
      method: "POST",
      headers: {
        "Content-Type": prepared.ext === "png" ? "image/png" : "image/jpeg",
      },
      body: prepared.bytes as BodyInit,
    }),
  );
  if (
    validated.hash !== prepared.hash ||
    validated.width !== prepared.width ||
    validated.height !== prepared.height
  )
    throw invalidLogo();
  const site = await readSiteSettings(env),
    key = logoKey(validated),
    reservationId = `branding:${validated.hash}`;
  const indexed = await env.DB.prepare(
    "SELECT category,video_id,version_id FROM objects WHERE key=?",
  )
    .bind(key)
    .first<{
      category: string;
      video_id: string | null;
      version_id: string | null;
    }>();
  if (
    indexed &&
    (indexed.category !== "branding" ||
      indexed.video_id !== null ||
      indexed.version_id !== null)
  )
    throw new HttpError(409, "logo_conflict", "Logo 对象索引冲突");
  let object = await verifyStoredLogo(env, key, validated);
  if (!object) {
    await reserveLogo(env, reservationId, key, validated.bytes.length);
    await bounded(
      env.MEDIA.put(key, validated.bytes, {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        sha256: validated.hash,
        httpMetadata: {
          contentType: validated.ext === "png" ? "image/png" : "image/jpeg",
          cacheControl: "no-store",
        },
        customMetadata: { siteLogo: "v1", sha256: validated.hash },
      }),
    );
    object = await verifyStoredLogo(env, key, validated);
    if (!object)
      throw new HttpError(
        503,
        "logo_storage_unverified",
        "Logo 写入结果暂时无法核验，空间预留保留",
      );
  }
  const timestamp = Date.now(),
    next: SiteState = {
      ...site,
      logo: {
        hash: validated.hash,
        ext: validated.ext,
        width: validated.width,
        height: validated.height,
        bytes: validated.bytes.length,
        etag: object.etag,
      },
      updatedAt: timestamp,
    };
  const result = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO objects(key,category,bytes,etag,sha256,state,updated_at) VALUES(?,'branding',?,?,?,'present',?) ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes,etag=excluded.etag,sha256=excluded.sha256,state='present',updated_at=excluded.updated_at WHERE objects.category='branding' AND objects.video_id IS NULL AND objects.version_id IS NULL",
    ).bind(key, validated.bytes.length, object.etag, validated.hash, timestamp),
    env.DB.prepare(
      "INSERT INTO settings(key,value,updated_at) SELECT ?,?,? WHERE changes()=1 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    ).bind(SETTING, JSON.stringify(next), timestamp),
    env.DB.prepare(
      "UPDATE reservations SET state='released',amounts_json='{}',released_at=? WHERE id=? AND kind='branding' AND changes()=1",
    ).bind(timestamp, reservationId),
  ]);
  if (result[0].meta.changes !== 1 || result[1].meta.changes !== 1)
    throw new HttpError(409, "logo_conflict", "Logo 登记冲突，原设置未改变");
  return json({
    ...publicState(next),
    logo: {
      width: validated.width,
      height: validated.height,
      bytes: validated.bytes.length,
    },
  });
}
export async function serveSiteLogo(
  request: Request,
  env: Env,
  hash: string,
  ext: string,
) {
  const unavailable = () =>
    new HttpError(404, "logo_unavailable", "Logo 不存在");
  if (
    !HASH.test(hash) ||
    !["png", "jpg"].includes(ext) ||
    !["GET", "HEAD"].includes(request.method)
  )
    throw unavailable();
  const site = await readSiteSettings(env),
    logo = site.logo;
  if (!logo || logo.hash !== hash || logo.ext !== ext) throw unavailable();
  const key = logoKey(logo),
    indexed = await env.DB.prepare(
      "SELECT bytes,etag,sha256 FROM objects WHERE key=? AND category='branding' AND video_id IS NULL AND version_id IS NULL AND state='present'",
    )
      .bind(key)
      .first<{ bytes: number; etag: string; sha256: string }>();
  if (
    !indexed ||
    indexed.bytes !== logo.bytes ||
    indexed.etag !== logo.etag ||
    indexed.sha256 !== hash
  )
    throw unavailable();
  const object =
    request.method === "HEAD"
      ? await env.MEDIA.head(key)
      : await env.MEDIA.get(key, { onlyIf: { etagMatches: logo.etag } });
  if (
    !object ||
    object.size !== logo.bytes ||
    object.etag !== logo.etag ||
    (request.method === "GET" && !("body" in object))
  ) {
    if (object && "body" in object)
      void (object as R2ObjectBody).body.cancel().catch(() => {});
    throw unavailable();
  }
  return new Response(
    request.method === "HEAD" ? null : (object as R2ObjectBody).body,
    {
      headers: {
        "Content-Type": ext === "png" ? "image/png" : "image/jpeg",
        "Content-Length": String(logo.bytes),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        ETag: `"${logo.etag}"`,
      },
    },
  );
}
