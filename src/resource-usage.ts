import type { Env } from "./types";
import { BUILD_COMMIT } from "./build-info";
import { billingPeriod } from "./billing";

export type ResourceUnit =
  | "count"
  | "bytes"
  | "seconds"
  | "milliseconds"
  | "gb-seconds"
  | "gib-seconds"
  | "vcpu-seconds"
  | "text";
export interface ResourceMetric {
  key: string;
  label: string;
  value: number | string;
  unit: ResourceUnit;
  source: "official" | "project" | "estimate";
  observedAt: number;
  note?: string;
  coverage?: {
    kind: "billing-snapshot" | "daily-ledger";
    rangeStart: number;
    rangeEnd: number;
    intervals: { start: number; end: number }[];
    gapMilliseconds: number;
  };
}
export interface ResourceDiagnostic {
  source: string;
  state:
    | "ok"
    | "empty"
    | "restricted"
    | "unavailable"
    | "unconfigured"
    | "stale"
    | "partial";
  checkedAt: number;
  dataAt?: number;
  httpStatus?: number;
  codes?: number[];
  note: string;
}
export interface ResourceCard {
  key: string;
  title: string;
  scope: string;
  metrics: ResourceMetric[];
  notes: string[];
  links: { label: string; url: string; note?: string }[];
  diagnostics: ResourceDiagnostic[];
  limit?: { usedBytes: number; reservedBytes: number; limitBytes: number };
}
export interface ResourceUsageSnapshot {
  fetchedAt: number;
  cached: boolean;
  nextRefreshAt: number;
  environment: string;
  worker: string | null;
  period: { start: string; end: string; label: string };
  range?: ResourceRange;
  collection?: {
    checkedAt: number;
    status?: "pending" | "collecting" | "partial" | "ready";
    retryAt?: number;
    scope?: string;
    intervalMinutes: number;
    coverageStart: number | null;
    note: string;
  };
  cards: ResourceCard[];
  policy: {
    processingEnabled: boolean;
    monthlyIncrementalBudgetUsd: number | null;
  };
}

type Row = Record<string, unknown>;
interface ReadResult {
  body: Row;
  diagnostic: ResourceDiagnostic;
}
interface OfficialResult {
  truncated?: boolean;
  builds?: { id: string; start: number; end: number | null; outcome: string }[];
  metrics: ResourceMetric[];
  diagnostics: ResourceDiagnostic[];
}
export type ResourceRange = "24h" | "billing" | "all";
interface CollectionAttempt {
  promise: Promise<void>;
  controller: AbortController;
  deadline: number;
}
const inFlight = new Map<string, CollectionAttempt>();
const TTL = 60 * 60_000;
const RETRY = 30_000;
// waitUntil has a finite lifetime after the response closes. Leave time for
// saving the failure state; a lost isolate is recovered by the D1 lease.
const COLLECTION_TIMEOUT = 25_000;
const LEASE_TIME = 35_000;
const collectionContext = Symbol("resource collection");
type CollectionEnv = Env & {
  [collectionContext]?: { signal: AbortSignal; scope: string; lease: number };
};
function active(env: CollectionEnv) {
  if (env[collectionContext]?.signal.aborted)
    throw new Error("Resource collection timed out");
}
function interrupted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Resource collection timed out"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}
function ownership(env: CollectionEnv): [string, unknown[]] {
  active(env);
  const context = env[collectionContext];
  return context
    ? [
        "EXISTS(SELECT 1 FROM resource_usage_state WHERE scope=? AND lease_until=?)",
        [context.scope, context.lease],
      ]
    : ["1", []];
}
const DAY = 86_400_000;
const API = "https://api.cloudflare.com/client/v4";
const record = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.map(record) : []);
const numeric = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const hex = (v: unknown) =>
  typeof v === "string" && /^[a-f0-9]{32}$/i.test(v) ? v : null;
const uuid = (v: unknown) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v)
    ? v
    : null;
const name = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(v)
    ? v
    : null;

function namespaces(env: Env): { id: string; name: string }[] {
  try {
    const value: unknown = JSON.parse(env.RESOURCE_DO_NAMESPACES || "[]");
    if (!Array.isArray(value) || value.length > 8) return [];
    const result = value
      .map(record)
      .map((v) => ({ id: hex(v.id), name: name(v.name) }));
    if (result.some((v) => !v.id || !v.name)) return [];
    const ids = new Set(result.map((v) => v.id));
    return ids.size === result.length
      ? (result as { id: string; name: string }[])
      : [];
  } catch {
    return [];
  }
}

async function read(
  env: CollectionEnv,
  path: string,
  source: string,
  query?: string,
): Promise<ReadResult> {
  active(env);
  const checkedAt = Date.now();
  const diagnostic: ResourceDiagnostic = {
    source,
    state: "unconfigured",
    checkedAt,
    note: "运行时只读用量凭据或资源范围未配置；继续展示项目账本。",
  };
  if (!hex(env.CLOUDFLARE_ACCOUNT_ID) || !env.CF_USAGE_API_TOKEN)
    return { body: {}, diagnostic };
  const controller = new AbortController();
  const parent = env[collectionContext]?.signal;
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 10_000);
  try {
    const response = await interrupted(
      fetch(API + path, {
        method: query ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${env.CF_USAGE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        ...(query ? { body: JSON.stringify({ query }) } : {}),
        signal: controller.signal,
      }),
      controller.signal,
    );
    diagnostic.httpStatus = response.status;
    const body = record(await interrupted(response.json(), controller.signal));
    const errors = rows(body.errors);
    diagnostic.codes = errors
      .map((v) => numeric(v.code))
      .filter((v): v is number => v !== null);
    if (!response.ok || body.success === false || errors.length) {
      diagnostic.state = [401, 403].includes(response.status)
        ? "restricted"
        : "unavailable";
      diagnostic.note =
        diagnostic.state === "restricted"
          ? "运行时只读凭据访问被拒绝；不是零用量。"
          : "官方查询失败、字段不可用或响应不完整；保留其他来源的数据。";
      return { body: {}, diagnostic };
    }
    diagnostic.state = "ok";
    diagnostic.note =
      "官方接口正常；分析统计可能延迟或采样，不是完整账单或免费余额证明。";
    return { body, diagnostic };
  } catch {
    active(env);
    diagnostic.state = "unavailable";
    diagnostic.note = "官方查询超时、网络异常或响应不可读；不会改写成零。";
    return { body: {}, diagnostic };
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}
function graphAccount(body: Row, expected: string | undefined): Row | null {
  const accounts = rows(record(record(body.data).viewer).accounts);
  return accounts.length === 1 && accounts[0].accountTag === expected
    ? accounts[0]
    : null;
}
function metric(
  key: string,
  label: string,
  value: number | string,
  unit: ResourceUnit,
  source: ResourceMetric["source"],
  observedAt: number,
  note?: string,
): ResourceMetric {
  return {
    key,
    label,
    value,
    unit,
    source,
    observedAt,
    ...(note ? { note } : {}),
  };
}
function unconfigured(source: string): OfficialResult {
  return {
    metrics: [],
    diagnostics: [
      {
        source,
        state: "unconfigured",
        checkedAt: Date.now(),
        note: "此部署未配置可核验的项目资源标识；未查询或混入整个账户。",
      },
    ],
  };
}
async function graph(
  env: Env,
  source: string,
  node: string,
  selection: string,
  filter: string,
  fields: [string, string, ResourceUnit, number?][],
  at: number,
  order = "",
  start = at - DAY,
): Promise<OfficialResult> {
  const interval = `datetime_geq:${JSON.stringify(new Date(start).toISOString())},datetime_lt:${JSON.stringify(new Date(at).toISOString())}`;
  const result = await read(
    env,
    "/graphql",
    source,
    `{viewer{accounts(filter:{accountTag:${JSON.stringify(env.CLOUDFLARE_ACCOUNT_ID)}}){accountTag ${node}(limit:100,filter:{${interval},${filter}}${order}){${selection}}}}}`,
  );
  if (result.diagnostic.state !== "ok")
    return { metrics: [], diagnostics: [result.diagnostic] };
  const account = graphAccount(result.body, env.CLOUDFLARE_ACCOUNT_ID);
  if (!account || !Array.isArray(account[node])) {
    result.diagnostic.state = "unavailable";
    result.diagnostic.note = "官方接口缺少预期的项目数据字段；没有填零。";
    return { metrics: [], diagnostics: [result.diagnostic] };
  }
  const entries = rows(account[node]);
  if (!entries.length) {
    result.diagnostic.state = "empty";
    result.diagnostic.note =
      "官方接口正常，此项目资源在最近 24 小时没有返回记录；不能据此证明账户用量为零。";
    return { metrics: [], diagnostics: [result.diagnostic] };
  }
  if (entries.length >= 100) {
    result.diagnostic.state = "partial";
    result.diagnostic.note = "项目查询达到有界记录上限，仅显示已返回部分。";
  }
  const metrics: ResourceMetric[] = [];
  for (const [key, label, unit, factor = 1] of fields) {
    const values = entries.map((entry) => numeric(record(entry.sum)[key]));
    if (values.some((value) => value === null)) {
      result.diagnostic.state = "partial";
      result.diagnostic.note =
        "官方返回部分计量字段，缺失字段已省略；其他数据保留。";
      continue;
    }
    metrics.push(
      metric(
        key,
        label,
        values.reduce<number>((sum, value) => sum + value!, 0) * factor,
        unit,
        "official",
        at,
      ),
    );
  }
  return {
    metrics,
    diagnostics: [result.diagnostic],
    ...(entries.length >= 100 ? { truncated: true } : {}),
  };
}
async function latestStorage(
  env: Env,
  source: string,
  node: string,
  filter: string,
  field: string,
  label: string,
  at: number,
): Promise<OfficialResult> {
  const result = await read(
    env,
    "/graphql",
    source,
    `{viewer{accounts(filter:{accountTag:${JSON.stringify(env.CLOUDFLARE_ACCOUNT_ID)}}){accountTag ${node}(limit:1,filter:{datetime_geq:${JSON.stringify(new Date(at - DAY).toISOString())},datetime_lt:${JSON.stringify(new Date(at).toISOString())},${filter}},orderBy:[datetime_DESC]){dimensions{datetime} max{${field}}}}}}`,
  );
  if (result.diagnostic.state !== "ok")
    return { metrics: [], diagnostics: [result.diagnostic] };
  const account = graphAccount(result.body, env.CLOUDFLARE_ACCOUNT_ID);
  if (!account || !Array.isArray(account[node])) {
    result.diagnostic.state = "unavailable";
    result.diagnostic.note = "官方响应缺少项目存储字段。";
    return { metrics: [], diagnostics: [result.diagnostic] };
  }
  const entries = rows(account[node]);
  if (!entries.length) {
    result.diagnostic.state = "empty";
    result.diagnostic.note = "最近 24 小时没有项目存储快照；未解释为零。";
    return { metrics: [], diagnostics: [result.diagnostic] };
  }
  const size = numeric(record(entries[0].max)[field]);
  const timestamp = Date.parse(
    String(record(entries[0].dimensions).datetime || ""),
  );
  if (
    size === null ||
    !Number.isFinite(timestamp) ||
    timestamp > at ||
    timestamp < at - DAY
  ) {
    result.diagnostic.state = "unavailable";
    result.diagnostic.note = "官方存储快照缺少有效数值或采集时间。";
    return { metrics: [], diagnostics: [result.diagnostic] };
  }
  result.diagnostic.dataAt = timestamp;
  return {
    metrics: [
      metric(
        field,
        label,
        size,
        "bytes",
        "official",
        timestamp,
        "最新官方存储快照；当前占用，不是当期 GB-month 累计。",
      ),
    ],
    diagnostics: [result.diagnostic],
  };
}
function merge(results: OfficialResult[]): OfficialResult {
  return {
    metrics: results.flatMap((v) => v.metrics),
    diagnostics: results.flatMap((v) => v.diagnostics),
  };
}

async function official(
  env: Env,
  at: number,
  start = at - DAY,
  countersOnly = false,
  onSource?: (source: string, result: OfficialResult) => Promise<void>,
): Promise<Record<string, OfficialResult>> {
  const worker = name(env.RESOURCE_WORKER_NAME),
    db = uuid(env.RESOURCE_D1_DATABASE_ID),
    bucket = name(env.RESOURCE_R2_BUCKET),
    doNamespaces = namespaces(env),
    application = hex(env.RESOURCE_CONTAINER_APPLICATION_ID),
    tag = hex(env.RESOURCE_WORKER_TAG);
  const jobs: [string, Promise<OfficialResult>][] = [
    [
      "workers",
      worker
        ? graph(
            env,
            "Workers · 指定 scriptName",
            "workersInvocationsAdaptive",
            "sum{requests errors cpuTimeUs}",
            `scriptName:${JSON.stringify(worker)}`,
            [
              ["requests", "请求数 · 最近 24 小时", "count"],
              ["errors", "运行错误 · 最近 24 小时", "count"],
              ["cpuTimeUs", "累计 CPU · 最近 24 小时", "milliseconds", 0.001],
            ],
            at,
            "",
            start,
          )
        : Promise.resolve(unconfigured("Workers")),
    ],
    [
      "d1-analytics",
      db
        ? graph(
            env,
            "D1 · 指定 databaseId",
            "d1AnalyticsAdaptiveGroups",
            "sum{rowsRead rowsWritten readQueries writeQueries}",
            `databaseId:${JSON.stringify(db)}`,
            [
              ["rowsRead", "读取行数 · 最近 24 小时", "count"],
              ["rowsWritten", "写入行数 · 最近 24 小时", "count"],
              ["readQueries", "读查询次数 · 最近 24 小时", "count"],
              ["writeQueries", "写查询次数 · 最近 24 小时", "count"],
            ],
            at,
            "",
            start,
          )
        : Promise.resolve(unconfigured("D1 analytics")),
    ],
    [
      "d1-storage",
      !countersOnly && db
        ? (async () => {
            const result = await read(
              env,
              `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${db}`,
              "D1 · 指定数据库元数据",
            );
            const size = numeric(record(result.body.result).file_size);
            if (result.diagnostic.state === "ok" && size === null) {
              result.diagnostic.state = "partial";
              result.diagnostic.note =
                "数据库元数据可读取，但没有返回 file_size。";
            }
            return {
              metrics:
                size === null
                  ? []
                  : [
                      metric(
                        "databaseBytes",
                        "数据库当前大小",
                        size,
                        "bytes",
                        "official",
                        at,
                      ),
                    ],
              diagnostics: [result.diagnostic],
            };
          })()
        : Promise.resolve(unconfigured("D1 storage")),
    ],
    [
      "r2-operations",
      bucket
        ? graph(
            env,
            "R2 · 指定 bucketName",
            "r2OperationsAdaptiveGroups",
            "sum{requests}",
            `bucketName:${JSON.stringify(bucket)}`,
            [["requests", "桶操作次数 · 最近 24 小时", "count"]],
            at,
            "",
            start,
          )
        : Promise.resolve(unconfigured("R2 operations")),
    ],
    [
      "r2-storage",
      !countersOnly && bucket
        ? (async () => {
            const result = await read(
              env,
              "/graphql",
              "R2 · 指定桶及存储类别快照",
              `{viewer{accounts(filter:{accountTag:${JSON.stringify(env.CLOUDFLARE_ACCOUNT_ID)}}){accountTag r2StorageAdaptiveGroups(limit:100,filter:{datetime_geq:${JSON.stringify(new Date(at - DAY).toISOString())},datetime_lt:${JSON.stringify(new Date(at).toISOString())},bucketName:${JSON.stringify(bucket)}},orderBy:[datetime_DESC]){dimensions{datetime storageClass} max{payloadSize}}}}}`,
            );
            if (result.diagnostic.state !== "ok")
              return { metrics: [], diagnostics: [result.diagnostic] };
            const account = graphAccount(
              result.body,
              env.CLOUDFLARE_ACCOUNT_ID,
            );
            if (!account || !Array.isArray(account.r2StorageAdaptiveGroups)) {
              result.diagnostic.state = "unavailable";
              result.diagnostic.note = "官方响应缺少桶存储快照。";
              return { metrics: [], diagnostics: [result.diagnostic] };
            }
            const entries = rows(account.r2StorageAdaptiveGroups),
              latest = new Map<string, { size: number; time: number }>();
            for (const entry of entries) {
              const dimension = record(entry.dimensions),
                storageClass = String(dimension.storageClass || ""),
                size = numeric(record(entry.max).payloadSize),
                time = Date.parse(String(dimension.datetime || ""));
              if (
                !/^[A-Za-z_ -]{1,32}$/.test(storageClass) ||
                size === null ||
                !Number.isFinite(time) ||
                time > at ||
                time < at - DAY
              )
                continue;
              if (
                !latest.has(storageClass) ||
                latest.get(storageClass)!.time < time
              )
                latest.set(storageClass, { size, time });
            }
            const metrics = Array.from(latest, ([storageClass, value]) =>
              metric(
                `bucketPayload-${storageClass}`,
                `桶载荷快照 · ${storageClass}`,
                value.size,
                "bytes",
                "official",
                value.time,
                "仅此存储类别最新快照；不同类别时间可能不同，不冒充当期累计存储。",
              ),
            );
            if (!entries.length) {
              result.diagnostic.state = "empty";
              result.diagnostic.note =
                "最近 24 小时没有桶存储快照；项目对象索引继续展示，没有填零。";
            } else if (!metrics.length || entries.length >= 100) {
              result.diagnostic.state = "partial";
              result.diagnostic.note =
                "只展示已返回且有有效时间的存储类别快照，不推算遗漏类别或完整账户。";
            }
            return { metrics, diagnostics: [result.diagnostic] };
          })()
        : Promise.resolve(unconfigured("R2 storage")),
    ],
    [
      "containers",
      application
        ? graph(
            env,
            "Containers · 指定 applicationId",
            "containersUsageAdaptiveGroups",
            "sum{cpuTimeSec allocatedMemory allocatedDisk txBytes}",
            `applicationId:${JSON.stringify(application)}`,
            [
              ["cpuTimeSec", "官方累计 CPU · 最近 24 小时", "vcpu-seconds"],
              [
                "allocatedMemory",
                "官方分配内存时间 · 最近 24 小时",
                "gib-seconds",
                1 / 1024 ** 3,
              ],
              [
                "allocatedDisk",
                "官方分配磁盘时间 · 最近 24 小时",
                "gb-seconds",
                1 / 1e9,
              ],
              ["txBytes", "官方发送流量 · 最近 24 小时", "bytes"],
            ],
            at,
            "",
            start,
          )
        : Promise.resolve(unconfigured("Containers")),
    ],
    [
      "builds",
      !countersOnly && tag
        ? (async () => {
            const records = new Map<
              string,
              { id: string; start: number; end: number | null; outcome: string }
            >();
            const diagnostics: ResourceDiagnostic[] = [];
            let complete = false;
            // Bounded pagination, stable build UUID deduplication; never retain trigger/env metadata.
            for (let page = 1; page <= 5; page++) {
              const result = await read(
                env,
                `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/builds/workers/${tag}/builds?page=${page}&per_page=100`,
                "Workers Builds · 指定 Worker tag",
              );
              diagnostics.push(result.diagnostic);
              if (result.diagnostic.state !== "ok") break;
              if (!Array.isArray(result.body.result)) {
                result.diagnostic.state = "unavailable";
                result.diagnostic.note = "构建接口缺少记录列表。";
                break;
              }
              const entries = rows(result.body.result);
              for (const entry of entries) {
                const id = uuid(entry.build_uuid),
                  begin = Date.parse(String(entry.created_on || "")),
                  end = Date.parse(String(entry.stopped_on || ""));
                if (!id || !Number.isFinite(begin) || begin > at) {
                  result.diagnostic.state = "partial";
                  result.diagnostic.note =
                    "缺少稳定构建 ID 或有效时间的记录未计入累计。";
                  continue;
                }
                records.set(id, {
                  id,
                  start: begin,
                  end:
                    Number.isFinite(end) && end >= begin && end <= at
                      ? end
                      : null,
                  outcome: [
                    "success",
                    "fail",
                    "cancelled",
                    "skipped",
                    "terminated",
                  ].includes(String(entry.build_outcome))
                    ? String(entry.build_outcome)
                    : "pending",
                });
              }
              const info = record(result.body.result_info),
                pages = numeric(info.total_pages);
              if (
                (pages !== null && page >= pages) ||
                (pages === null && entries.length < 100)
              ) {
                complete = true;
                break;
              }
            }
            if (!complete && diagnostics.length) {
              const last = diagnostics[diagnostics.length - 1];
              if (last.state === "ok") last.state = "partial";
              last.note =
                "本轮最多采集 5 页构建；累计仅包含已保存的稳定 ID，不能视为全部历史。";
            }
            if (
              complete &&
              diagnostics.length &&
              diagnostics.every((d) => d.state === "ok")
            )
              diagnostics[0].note =
                "本轮已遍历接口返回的构建页；更早的接口保留范围仍未知，经过时间不是计费分钟。";
            return { metrics: [], diagnostics, builds: [...records.values()] };
          })()
        : Promise.resolve(unconfigured("Workers Builds")),
    ],
  ];
  for (const ns of doNamespaces) {
    const filter = `namespaceId:${JSON.stringify(ns.id)}`;
    jobs.push([
      `do-${ns.name}-requests`,
      graph(
        env,
        `Durable Objects · ${ns.name} 请求`,
        "durableObjectsInvocationsAdaptiveGroups",
        "sum{requests}",
        filter,
        [["requests", `${ns.name} 请求 · 最近 24 小时`, "count"]],
        at,
        "",
        start,
      ),
    ]);
    jobs.push([
      `do-${ns.name}-periodic`,
      graph(
        env,
        `Durable Objects · ${ns.name} 运行`,
        "durableObjectsPeriodicGroups",
        "sum{duration rowsRead rowsWritten}",
        filter,
        [
          ["duration", `${ns.name} 运行 · 最近 24 小时`, "gb-seconds"],
          ["rowsRead", `${ns.name} 读取行数 · 最近 24 小时`, "count"],
          ["rowsWritten", `${ns.name} 写入行数 · 最近 24 小时`, "count"],
        ],
        at,
        "",
        start,
      ),
    ]);
    if (!countersOnly)
      jobs.push([
        `do-${ns.name}-storage`,
        latestStorage(
          env,
          `Durable Objects · ${ns.name} SQLite 存储`,
          "durableObjectsSqlStorageGroups",
          filter,
          "storedBytes",
          `${ns.name} 最新存储`,
          at,
        ),
      ]);
  }
  if (!doNamespaces.length)
    jobs.push([
      "do-unconfigured",
      Promise.resolve(unconfigured("Durable Objects")),
    ]);
  return Object.fromEntries(
    await Promise.all(
      jobs.map(async ([key, promise]) => {
        const result = await promise;
        await onSource?.(key, result);
        return [key, result];
      }),
    ),
  );
}

async function projectCards(env: Env, at: number): Promise<ResourceCard[]> {
  // These aggregate existing project records; no per-request telemetry rows,
  // R2 bucket-wide listing, DO wake-up or Container calls are introduced.
  const results = await env.DB.batch([
    env.DB.prepare(
      "SELECT category,COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM objects WHERE state='present' GROUP BY category",
    ),
    env.DB.prepare(
      "SELECT COUNT(*) AS n,COALESCE(SUM(reserved_bytes),0) AS reserved,MIN(created_at) AS first FROM uploads WHERE state NOT IN ('complete','cancelled','expired')",
    ),
    env.DB.prepare(
      "SELECT COUNT(*) AS n,COUNT(CASE WHEN started_at IS NOT NULL THEN 1 END) AS dispatched,COUNT(CASE WHEN started_at IS NOT NULL AND stop_verified=0 THEN 1 END) AS unresolved,MIN(created_at) AS first FROM jobs",
    ),
    env.DB.prepare(
      "SELECT COUNT(*) AS n,COUNT(CASE WHEN level='error' THEN 1 END) AS errors,MIN(created_at) AS first FROM logs",
    ),
    env.DB.prepare(
      "SELECT key,value FROM settings WHERE key IN ('storage_limit_bytes','monthly_spend_limit_usd','log_retention_days')",
    ),
    env.DB.prepare(
      "SELECT COUNT(*) AS videos,COUNT(CASE WHEN published=1 THEN 1 END) AS published,MIN(created_at) AS first FROM videos",
    ),
    env.DB.prepare(
      "SELECT COUNT(*) AS n,MIN(created_at) AS first FROM versions",
    ),
    env.DB.prepare(
      "SELECT COALESCE(SUM(CASE WHEN json_valid(amounts_json) THEN json_extract(amounts_json,'$.r2CurrentBytes') END),0) AS bytes FROM reservations WHERE state NOT IN ('released','reconciled')",
    ),
  ]);
  if (results.some((result) => record(result).success === false))
    throw new Error("Project resource aggregates unavailable");
  const objectRows = rows(results[0].results),
    upload = rows(results[1].results)[0] || {},
    jobs = rows(results[2].results)[0] || {},
    logs = rows(results[3].results)[0] || {},
    settings = Object.fromEntries(
      rows(results[4].results).map((v) => [String(v.key), v.value]),
    ),
    videos = rows(results[5].results)[0] || {},
    versions = rows(results[6].results)[0] || {},
    reservations = rows(results[7].results)[0] || {};
  const number = (v: unknown) => numeric(v) ?? 0;
  const storedBytes = objectRows.reduce((sum, v) => sum + number(v.bytes), 0),
    objectCount = objectRows.reduce((sum, v) => sum + number(v.n), 0),
    source = objectRows.filter((v) => v.category === "source"),
    branding = objectRows.filter((v) => v.category === "branding"),
    generated = objectRows.filter(
      (v) => v.category !== "source" && v.category !== "branding",
    );
  const rowBytes = (data: Row[]) =>
    data.reduce((sum, v) => sum + number(v.bytes), 0);
  const storedLimit = Number(settings.storage_limit_bytes),
    reservedBytes = number(upload.reserved) + number(reservations.bytes);
  const worker = name(env.RESOURCE_WORKER_NAME),
    bucket = name(env.RESOURCE_R2_BUCKET),
    db = uuid(env.RESOURCE_D1_DATABASE_ID),
    ns = namespaces(env),
    account = hex(env.CLOUDFLARE_ACCOUNT_ID);
  const base = account
    ? `https://dash.cloudflare.com/${account}`
    : "https://dash.cloudflare.com";
  const link = (label: string, path: string, note?: string) => ({
    label,
    url: base + (account ? path : ""),
    ...(note ? { note } : {}),
  });
  const buildLink = link(
    "在 Cloudflare 查看此 Worker 构建",
    worker
      ? `/workers/services/view/${encodeURIComponent(worker)}/production`
      : "/workers-and-pages",
    "进入此 Worker → Builds；页面上的 Production 表示构建分支环境，不代表本站业务生产。",
  );
  const localMetric = (
    key: string,
    label: string,
    value: number | string,
    unit: ResourceUnit,
    note?: string,
  ) => metric(key, label, value, unit, "project", at, note);
  const firstRecord = [
    numeric(videos.first),
    numeric(jobs.first),
    numeric(versions.first),
  ].filter((v): v is number => v !== null);
  const historyNote = firstRecord.length
    ? `项目现存记录最早于 ${new Date(Math.min(...firstRecord)).toISOString()}；不是整个账期账单。`
    : "项目账本尚无媒体或处理记录；不推算之前的用量。";
  return [
    {
      key: "r2",
      title: "R2 对象存储",
      scope: bucket ? `本项目桶 · ${bucket}` : "本项目 MEDIA 绑定的对象索引",
      metrics: [
        localMetric(
          "registeredBytes",
          "已登记对象占用",
          storedBytes,
          "bytes",
          "仅 state=present 的项目对象索引；桶最新官方快照另列。",
        ),
        localMetric("registeredObjects", "已登记对象", objectCount, "count"),
        localMetric("sourceBytes", "原片", rowBytes(source), "bytes"),
        localMetric("generatedBytes", "播放产物", rowBytes(generated), "bytes"),
        localMetric("brandingBytes", "站点图片", rowBytes(branding), "bytes"),
        localMetric("pendingUploads", "未完成上传", number(upload.n), "count"),
        localMetric(
          "uploadReservedBytes",
          "上传与任务空间预留",
          reservedBytes,
          "bytes",
        ),
      ],
      notes: [
        "空间上限属于本项目，不是 Cloudflare 账户免费余额。官方桶快照与项目索引的时间、范围可能不同。",
      ],
      links: [
        link(
          "在 Cloudflare 查看 R2",
          "/r2/overview",
          bucket ? `选择 ${bucket} → Metrics。` : "选择本项目桶 → Metrics。",
        ),
      ],
      diagnostics: [],
      ...(Number.isSafeInteger(storedLimit) && storedLimit >= 0
        ? {
            limit: {
              usedBytes: storedBytes,
              reservedBytes,
              limitBytes: storedLimit,
            },
          }
        : {}),
    },
    {
      key: "d1",
      title: "D1 数据库",
      scope: db ? "本项目 DB 数据库 · 已按 databaseId 限定" : "本项目 DB 绑定",
      metrics: [
        localMetric("videos", "视频记录", number(videos.videos), "count"),
        localMetric("versions", "播放版本", number(versions.n), "count"),
      ],
      notes: [
        "读取行数与查询次数分别展示；不由响应时间推算计费 CPU。",
        historyNote,
      ],
      links: [
        link(
          "在 Cloudflare 查看 D1 数据库",
          "/workers/d1",
          "选择本项目数据库 → Metrics。",
        ),
      ],
      diagnostics: [],
    },
    {
      key: "workers",
      title: "Workers",
      scope: worker
        ? `本项目 Worker · ${worker}`
        : "本项目 Worker · 未配置统计名称",
      metrics: [localMetric("release", "当前应用提交", BUILD_COMMIT, "text")],
      notes: [
        "累计 CPU 仅使用官方 sum.cpuTimeUs，不使用延迟、墙钟时间或分位数换算。",
      ],
      links: [
        link(
          "在 Cloudflare 查看此 Worker",
          worker
            ? `/workers/services/view/${encodeURIComponent(worker)}/production`
            : "/workers-and-pages",
          "进入 Worker → Metrics。",
        ),
      ],
      diagnostics: [],
    },
    {
      key: "do",
      title: "Durable Objects",
      scope: ns.length
        ? `本项目命名空间 · ${ns.map((v) => v.name).join("、")}`
        : "本项目命名空间 · 未配置统计标识",
      metrics: [
        localMetric(
          "configuredNamespaces",
          "已限定的命名空间",
          ns.length,
          "count",
        ),
      ],
      notes: [
        "仅查询配置的命名空间；没有统计记录的命名空间不填零。SQLite 存储显示各自最新快照，不是完整账户余额。",
      ],
      links: [
        link(
          "在 Cloudflare 查看 Durable Objects",
          "/workers/durable-objects",
          "选择本项目命名空间 → Metrics。",
        ),
      ],
      diagnostics: [],
    },
    {
      key: "containers",
      title: "Containers",
      scope: "本项目处理任务与指定 application",
      metrics: [
        localMetric("tasks", "已记录处理任务", number(jobs.n), "count"),
        localMetric(
          "dispatched",
          "任务派发次数",
          number(jobs.dispatched),
          "count",
          "started_at 表示任务派发，不冒充容器成功启动计量。",
        ),
        ...(number(jobs.n) === 0
          ? [
              localMetric(
                "ownedStarts",
                "项目任务启动记录",
                0,
                "count",
                "本项目没有处理任务；不代表整个账户或手工创建实例为零。一个现有任务不能证明一次且仅一次物理启动。",
              ),
            ]
          : []),
        localMetric(
          "unresolved",
          "尚未核验停止的已派发任务",
          number(jobs.unresolved),
          "count",
        ),
      ],
      notes: [
        historyNote,
        "查询此页不会启动 Container。处理仍须逐任务报价及明确确认；官方空记录不会代替账户余额。",
      ],
      links: [
        link(
          "在 Cloudflare 查看 Containers",
          "",
          "进入 Workers & Pages → Containers，再选择本项目 application。",
        ),
      ],
      diagnostics: [],
    },
    {
      key: "builds",
      title: "Workers Builds",
      scope: worker ? `本项目 Worker · ${worker}` : "本项目 Worker",
      metrics: [],
      notes: [
        "构建状态与创建/结束时间来自此 Worker 的有界记录。经过时间包含排队和部署，不当作计费构建分钟。",
      ],
      links: [buildLink],
      diagnostics: [],
    },
    {
      key: "logs",
      title: "日志",
      scope: "本项目 D1 应用日志 · 当前保留记录",
      metrics: [
        localMetric("applicationLogs", "应用日志记录", number(logs.n), "count"),
        localMetric(
          "applicationErrors",
          "应用错误记录",
          number(logs.errors),
          "count",
        ),
        ...(numeric(logs.first) !== null
          ? [
              localMetric(
                "oldestLog",
                "当前最早日志",
                new Date(number(logs.first)).toISOString(),
                "text",
              ),
            ]
          : []),
      ],
      notes: [
        `按现有保留规则（${Number(settings.log_retention_days) || 30} 天）清理，条数不是 Cloudflare 平台计费日志量；未提供后者的占位余额。`,
      ],
      links: [
        link(
          "在 Cloudflare 查看 Worker 日志",
          worker
            ? `/workers/services/view/${encodeURIComponent(worker)}/production`
            : "/workers-and-pages",
          "进入此 Worker → Observability；平台采集可能未启用。",
        ),
      ],
      diagnostics: [],
    },
  ];
}

interface CollectionState {
  checked_at: number;
  lease_until: number;
  anchor: string | null;
  anchor_checked_at: number | null;
  backfill_day: number | null;
  diagnostics_json: string;
}
interface SavedResult {
  source: string;
  range_start: number;
  range_end: number;
  result_json: string;
  observed_at: number;
  diagnostics_json: string;
  checked_at: number;
}
interface SavedDay {
  source: string;
  day_start: number;
  covered_end: number;
  result_json: string;
  observed_at: number;
}
function parsed<T>(value: string, fallback: T): T {
  try {
    return (JSON.parse(value) ?? fallback) as T;
  } catch {
    return fallback;
  }
}
async function scopeIdentity(env: Env): Promise<string> {
  // Stable across releases and credential rotation; changed resources/environment get separate ledgers.
  const input = JSON.stringify([
    env.APP_ENV,
    env.CLOUDFLARE_ACCOUNT_ID,
    env.RESOURCE_WORKER_NAME,
    env.RESOURCE_D1_DATABASE_ID,
    env.RESOURCE_R2_BUCKET,
    namespaces(env).sort((a, b) => a.id.localeCompare(b.id)),
    env.RESOURCE_CONTAINER_APPLICATION_ID,
    env.RESOURCE_WORKER_TAG,
  ]);
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
const isCounterSource = (source: string) =>
  ["workers", "d1-analytics", "r2-operations", "containers"].includes(source) ||
  /^do-.*-(requests|periodic)$/.test(source);
const good = (result: OfficialResult) =>
  !result.truncated &&
  result.metrics.length > 0 &&
  result.diagnostics.every(
    (item) => item.state === "ok" || item.state === "partial",
  );
async function saveLatest(
  env: CollectionEnv,
  scope: string,
  kind: string,
  start: number,
  end: number,
  raw: Record<string, OfficialResult>,
  at: number,
) {
  const statements: D1PreparedStatement[] = [];
  for (const [source, result] of Object.entries(raw)) {
    // A failure updates diagnosis but keeps the successful payload and its original range/time.
    // A partially missing field is preserved only with its own original observation time.
    const previous = await env.DB.prepare(
      "SELECT result_json,range_start,range_end FROM resource_usage_latest WHERE scope=? AND source=? AND kind=?",
    )
      .bind(scope, source, kind)
      .first<{ result_json: string; range_start: number; range_end: number }>();
    let metrics = result.metrics;
    if (
      good(result) &&
      previous &&
      (kind === "24h" || previous.range_start === start) &&
      result.diagnostics.some((d) => d.state === "partial")
    ) {
      const prior = parsed<OfficialResult>(previous.result_json, {
        metrics: [],
        diagnostics: [],
      });
      const seen = new Set(metrics.map((m) => m.key));
      metrics = [
        ...metrics,
        ...prior.metrics
          .filter((m) => !seen.has(m.key))
          .map((m) => ({
            ...m,
            note: `上游此字段暂未返回；保留此前成功值，统计范围 ${new Date(previous.range_start).toISOString()} 至 ${new Date(previous.range_end).toISOString()}。`,
          })),
      ];
    }
    const success =
      good(result) || (source === "builds" && !!result.builds?.length);
    const [owned, owner] = ownership(env);
    statements.push(
      env.DB.prepare(
        `INSERT INTO resource_usage_latest(scope,source,kind,range_start,range_end,result_json,observed_at,diagnostics_json,checked_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${owned} ON CONFLICT(scope,source,kind) DO UPDATE SET
      range_start=CASE WHEN ? THEN excluded.range_start ELSE range_start END,
      range_end=CASE WHEN ? THEN excluded.range_end ELSE range_end END,
      result_json=CASE WHEN ? THEN excluded.result_json ELSE result_json END,
      observed_at=CASE WHEN ? THEN excluded.observed_at ELSE observed_at END,
      diagnostics_json=excluded.diagnostics_json,checked_at=excluded.checked_at
      WHERE resource_usage_latest.checked_at<=excluded.checked_at`,
      ).bind(
        scope,
        source,
        kind,
        start,
        end,
        JSON.stringify({
          metrics: success ? metrics : [],
          diagnostics: result.diagnostics,
        }),
        success ? at : 0,
        JSON.stringify(result.diagnostics),
        at,
        ...owner,
        +success,
        +success,
        +success,
        +success,
      ),
    );
    for (const build of result.builds || [])
      statements.push(
        env.DB.prepare(
          `INSERT INTO resource_usage_builds(scope,build_id,started_at,ended_at,outcome,observed_at) SELECT ?,?,?,?,?,? WHERE ${owned}
        ON CONFLICT(scope,build_id) DO UPDATE SET ended_at=excluded.ended_at,outcome=excluded.outcome,observed_at=excluded.observed_at
        WHERE resource_usage_builds.observed_at<=excluded.observed_at AND (resource_usage_builds.ended_at IS NOT excluded.ended_at OR resource_usage_builds.outcome<>excluded.outcome)`,
        ).bind(
          scope,
          build.id,
          build.start,
          build.end,
          build.outcome,
          at,
          ...owner,
        ),
      );
  }
  active(env);
  if (statements.length) await env.DB.batch(statements);
}

/** Task capacity is allocated over the observed interval, never counted wholly in both ranges. */
export function allocateTaskConsumption(
  entry: { started_at: number; ended_at: number; consumption_json: string },
  start: number,
  end: number,
): Record<string, number> {
  const consumed = parsed<Row>(entry.consumption_json, {});
  if (consumed.reliability === "invalidated") return {};
  const duration = entry.ended_at - entry.started_at;
  if (duration < 0 || entry.ended_at < start || entry.started_at >= end)
    return {};
  const overlap = Math.max(
    0,
    Math.min(end, entry.ended_at) - Math.max(start, entry.started_at),
  );
  const fraction =
    duration > 0
      ? overlap / duration
      : entry.ended_at >= start && entry.ended_at < end
        ? 1
        : 0;
  const result: Record<string, number> = {};
  for (const field of [
    "wallSeconds",
    "cpuVcpuSecondsUpper",
    "memoryGibSecondsUpper",
    "diskGbSecondsUpper",
  ]) {
    const value = numeric(consumed[field]);
    if (value !== null && fraction > 0) result[field] = value * fraction;
  }
  return result;
}
async function retainTaskConsumption(
  env: CollectionEnv,
  scope: string,
  at: number,
) {
  // No FK: later removal of a video or detailed task must not erase incurred cumulative usage.
  const tasks = await env.DB.prepare(
    `SELECT id,started_at,finished_at,stop_verified,stop_evidence_json,consumption_json,updated_at FROM jobs
    WHERE EXISTS(SELECT 1 FROM resource_usage_jobs r WHERE r.scope=? AND r.job_id=jobs.id AND r.observed_at<jobs.updated_at)
    OR (stop_verified=1 AND json_valid(consumption_json) AND finished_at IS NOT NULL
      AND CASE WHEN json_valid(consumption_json) THEN json_type(consumption_json,'$.wallSeconds') IN ('integer','real') END
      AND CASE WHEN json_valid(consumption_json) THEN COALESCE(json_extract(consumption_json,'$.unattributedContainerObserved'),0)=0 END
      AND CASE WHEN json_valid(consumption_json) THEN COALESCE(json_extract(consumption_json,'$.containerUsageStatus'),'') NOT LIKE '%unknown%' END
      AND CASE WHEN json_valid(consumption_json) THEN COALESCE(json_extract(consumption_json,'$.source'),'') NOT LIKE '%unattributed%' END
      AND NOT EXISTS(SELECT 1 FROM resource_usage_jobs r WHERE r.scope=? AND r.job_id=jobs.id AND r.observed_at>=jobs.updated_at)
    ) ORDER BY updated_at LIMIT 500`,
  )
    .bind(scope, scope)
    .all<Row>();
  const statements: D1PreparedStatement[] = [];
  for (const task of tasks.results) {
    const [owned, owner] = ownership(env);
    const consumed = parsed<Row>(String(task.consumption_json), {}),
      evidence = parsed<Row>(String(task.stop_evidence_json), {});
    const wall = numeric(consumed.wallSeconds),
      finish = numeric(evidence.verifiedAt) ?? numeric(task.finished_at);
    const start = wall !== null && finish !== null ? finish - wall * 1000 : -1;
    // Corrections to stop/ownership evidence must also invalidate an earlier
    // retained estimate. Keep its historical values for diagnosis; do not count
    // it as determined consumption after its evidence is withdrawn.
    if (
      task.stop_verified !== 1 ||
      numeric(task.finished_at) === null ||
      wall === null ||
      finish === null ||
      finish > at ||
      (wall > 0 && numeric(task.started_at) === null) ||
      consumed.unattributedContainerObserved ||
      /unknown|unattributed/.test(
        String(consumed.containerUsageStatus || ""),
      ) ||
      /unattributed/.test(String(consumed.source || "")) ||
      start < 0 ||
      (numeric(task.started_at) !== null &&
        start + 1000 < Number(task.started_at))
    ) {
      statements.push(
        env.DB.prepare(
          `UPDATE resource_usage_jobs SET consumption_json=json_set(consumption_json,'$.reliability','invalidated'),observed_at=? WHERE scope=? AND job_id=? AND observed_at<=? AND ${owned}`,
        ).bind(
          Number(task.updated_at),
          scope,
          String(task.id),
          Number(task.updated_at),
          ...owner,
        ),
      );
      continue;
    }
    const values: Row = {};
    for (const field of [
      "wallSeconds",
      "cpuVcpuSecondsUpper",
      "memoryGibSecondsUpper",
      "diskGbSecondsUpper",
    ])
      if (numeric(consumed[field]) !== null) values[field] = consumed[field];
    statements.push(
      env.DB.prepare(
        `INSERT INTO resource_usage_jobs(scope,job_id,started_at,ended_at,consumption_json,observed_at)
      SELECT ?,?,?,?,?,? WHERE ${owned} ON CONFLICT(scope,job_id) DO UPDATE SET started_at=excluded.started_at,ended_at=excluded.ended_at,
      consumption_json=excluded.consumption_json,observed_at=excluded.observed_at WHERE resource_usage_jobs.observed_at<=excluded.observed_at`,
      ).bind(
        scope,
        String(task.id),
        start,
        finish,
        JSON.stringify(values),
        Number(task.updated_at),
        ...owner,
      ),
    );
  }
  active(env);
  if (statements.length) await env.DB.batch(statements);
}
async function resolveAnchor(env: Env, state: CollectionState, at: number) {
  const priorDiagnostics = parsed<ResourceDiagnostic[]>(
    state.diagnostics_json,
    [],
  ).filter((item) => item.source === "Cloudflare 实际账期");
  const anchorTtl = priorDiagnostics.some((item) =>
    ["unavailable", "restricted", "unconfigured"].includes(item.state),
  )
    ? RETRY
    : DAY;
  if (state.anchor_checked_at && at - state.anchor_checked_at < anchorTtl)
    return {
      anchor: state.anchor,
      diagnostics: priorDiagnostics,
      checkedAt: state.anchor_checked_at,
    };
  const response = await read(
    env,
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/billable-usage/info`,
    "Cloudflare 实际账期",
  );
  const result = record(response.body.result),
    periods = rows(result.subscriptions)
      .filter(
        (item) =>
          (!item.end_timestamp ||
            Date.parse(String(item.end_timestamp)) > at) &&
          (!item.start_timestamp ||
            Date.parse(String(item.start_timestamp)) <= at),
      )
      .map((item) => String(item.billing_cycle_anchor_timestamp || ""))
      .filter((anchor) => billingPeriod(anchor, at));
  const distinct = new Map(
    periods.map((anchor) => [
      JSON.stringify(billingPeriod(anchor, at)),
      anchor,
    ]),
  );
  if (
    response.diagnostic.state === "ok" &&
    result.covered === true &&
    distinct.size === 1
  )
    return {
      anchor: [...distinct.values()][0],
      diagnostics: [response.diagnostic],
      checkedAt: at,
    };
  if (response.diagnostic.state === "ok") {
    response.diagnostic.state = "partial";
    response.diagnostic.note =
      "官方未提供唯一、有效的账期规则；未用自然月代替。";
    // A successful contradictory/ambiguous catalog supersedes an old anchor.
    return { anchor: null, diagnostics: [response.diagnostic], checkedAt: at };
  }
  // Existing admission snapshots came from validated official subscription anchors.
  let anchor = state.anchor;
  if (!anchor) {
    const prior = await env.DB.prepare(
      "SELECT period_start,period_end FROM usage_snapshots WHERE complete=1 AND period_start IS NOT NULL AND period_end IS NOT NULL ORDER BY fetched_at DESC LIMIT 1",
    ).first<{ period_start: string; period_end: string }>();
    if (prior) {
      const validated = billingPeriod(
        prior.period_start,
        Date.parse(prior.period_start),
      );
      const end = Date.parse(prior.period_end);
      if (
        Number.isFinite(end) &&
        validated?.end === new Date(end).toISOString()
      )
        anchor = prior.period_start;
    }
  }
  if (anchor)
    response.diagnostic.note =
      "本轮账期接口未确认；沿用此前已验证的官方账期规则。";
  return { anchor, diagnostics: [response.diagnostic], checkedAt: at };
}

async function saveDay(
  env: CollectionEnv,
  scope: string,
  day: number,
  at: number,
): Promise<Record<string, OfficialResult>> {
  const end = Math.min(at, day + DAY);
  if (end <= day) return {};
  const daily = await official(env, end, day, true),
    statements: D1PreparedStatement[] = [];
  for (const [source, result] of Object.entries(daily)) {
    if (!isCounterSource(source) || !good(result)) continue;
    if (result.diagnostics.some((d) => d.state === "partial")) {
      const previous = await env.DB.prepare(
        "SELECT result_json FROM resource_usage_daily WHERE scope=? AND source=? AND day_start=?",
      )
        .bind(scope, source, day)
        .first<{ result_json: string }>();
      const prior = previous
        ? parsed<OfficialResult>(previous.result_json, {
            metrics: [],
            diagnostics: [],
          })
        : null;
      const seen = new Set(result.metrics.map((m) => m.key));
      if (prior)
        result.metrics.push(
          ...prior.metrics
            .filter((m) => !seen.has(m.key))
            .map((m) => ({
              ...m,
              note: "此字段本轮缺失，保留原观测时间与数值。",
            })),
        );
    }
    const [owned, owner] = ownership(env);
    statements.push(
      env.DB.prepare(
        `INSERT INTO resource_usage_daily(scope,source,day_start,covered_end,result_json,observed_at)
      SELECT ?,?,?,?,?,? WHERE ${owned}
      ON CONFLICT(scope,source,day_start) DO UPDATE SET covered_end=excluded.covered_end,result_json=excluded.result_json,observed_at=excluded.observed_at
      WHERE resource_usage_daily.observed_at<=excluded.observed_at`,
      ).bind(scope, source, day, end, JSON.stringify(result), at, ...owner),
    );
  }
  active(env);
  if (statements.length) await env.DB.batch(statements);
  return daily;
}

/** Hourly Cron collection, safely bootstrapped by authenticated reads. Never starts a Container. */
export async function collectResourceUsage(
  env: Env,
  options: { force?: boolean; at?: number } = {},
): Promise<void> {
  const scope = await scopeIdentity(env);
  const previous = inFlight.get(scope);
  if (previous && previous.deadline > Date.now()) return previous.promise;
  if (previous) {
    previous.controller.abort();
    inFlight.delete(scope);
  }
  const controller = new AbortController();
  const attempt: CollectionAttempt = {
    controller,
    deadline: Date.now() + COLLECTION_TIMEOUT,
    promise: Promise.resolve(),
  };
  const timer = setTimeout(() => controller.abort(), COLLECTION_TIMEOUT);
  let ownedLease: number | null = null;
  let anchorDiagnostics: ResourceDiagnostic[] = [];
  let nextPhase = 0;
  const at = options.at ?? Date.now();
  const progress = (
    note: string,
    state: ResourceDiagnostic["state"] = "partial",
  ) =>
    JSON.stringify([
      ...anchorDiagnostics,
      { source: "持续采集", state, checkedAt: Date.now(), note, nextPhase },
    ]);
  const work = async () => {
    active({
      ...env,
      [collectionContext]: { signal: controller.signal, scope, lease: 0 },
    });
    await env.DB.prepare(
      "INSERT OR IGNORE INTO resource_usage_state(scope) VALUES(?)",
    )
      .bind(scope)
      .run();
    if (controller.signal.aborted) return;
    // Scheduled data windows can predate this acquisition after maintenance.
    // Exclusivity and expiry use the current clock, independently of that window.
    const leaseAt = Date.now(),
      leaseValue = leaseAt + LEASE_TIME;
    const lease = await env.DB.prepare(
      `UPDATE resource_usage_state SET lease_until=?,checked_at=?
      WHERE scope=? AND lease_until<=? AND (checked_at<=? OR lease_until>0 OR
        (checked_at<=? AND EXISTS(SELECT 1 FROM json_each(diagnostics_json)
          WHERE json_extract(value,'$.source')='持续采集' AND json_extract(value,'$.state')='unavailable')))
      RETURNING *`,
    )
      .bind(
        leaseValue,
        at,
        scope,
        leaseAt,
        at - (options.force ? RETRY : TTL),
        at - RETRY,
      )
      .first<CollectionState>();
    if (!lease) return;
    ownedLease = leaseValue;
    const continuation = parsed<Row[]>(lease.diagnostics_json, []).find(
      (d) => d.source === "持续采集",
    )?.nextPhase;
    if (
      typeof continuation === "number" &&
      Number.isInteger(continuation) &&
      continuation >= 0 &&
      continuation < 4
    )
      nextPhase = continuation;
    anchorDiagnostics = parsed<ResourceDiagnostic[]>(
      lease.diagnostics_json,
      [],
    ).filter((item) => item.source === "Cloudflare 实际账期");
    const collecting: CollectionEnv = {
      ...env,
      [collectionContext]: {
        signal: controller.signal,
        scope,
        lease: leaseValue,
      },
    };
    active(collecting);
    const anchor = await resolveAnchor(collecting, lease, at);
    anchorDiagnostics = anchor.diagnostics;
    active(collecting);
    await env.DB.prepare(
      "UPDATE resource_usage_state SET anchor=?,anchor_checked_at=?,diagnostics_json=? WHERE scope=? AND lease_until=?",
    )
      .bind(
        anchor.anchor,
        anchor.checkedAt,
        progress(
          "账期检查已保存；优先采集当日日窗口，已有记录不变为完整记录。",
        ),
        scope,
        leaseValue,
      )
      .run();
    const period = anchor.anchor ? billingPeriod(anchor.anchor, at) : null;
    let partial = !period || anchorDiagnostics.some((d) => d.state !== "ok");
    const assess = (
      raw: Record<string, OfficialResult>,
      countersOnly = false,
    ) => {
      partial ||= Object.entries(raw).some(
        ([source, result]) =>
          (!countersOnly || isCounterSource(source)) &&
          result.diagnostics.some((d) => d.state !== "ok"),
      );
    };
    const today = Math.floor(at / DAY) * DAY,
      oldest = today - 30 * DAY;
    let backfill = lease.backfill_day ?? today - 2 * DAY;
    if (backfill < oldest || backfill > today - 2 * DAY)
      backfill = today - 2 * DAY;
    // Save today's cumulative window before slower optional historical queries.
    assess(await saveDay(collecting, scope, today, at), true);
    await retainTaskConsumption(collecting, scope, at);
    const firstPhase = nextPhase;
    // Rotate the next attempt's starting stage exactly once, independently of
    // how many stages fit this attempt. Advancing on each attempted stage can
    // repeatedly put the same stages in the unfinished tail of the deadline.
    nextPhase = (firstPhase + 1) % 4;
    for (let offset = 0; offset < 4; offset++) {
      const phase = (firstPhase + offset) % 4;
      active(collecting);
      await env.DB.prepare(
        "UPDATE resource_usage_state SET diagnostics_json=? WHERE scope=? AND lease_until=?",
      )
        .bind(
          progress(
            "当日日窗口已检查；正在按持久阶段游标采集近24小时、账期及历史窗口。",
          ),
          scope,
          leaseValue,
        )
        .run();
      if (phase === 0) {
        const raw = await official(
          collecting,
          at,
          at - DAY,
          false,
          (source, result) =>
            saveLatest(
              collecting,
              scope,
              "24h",
              at - DAY,
              at,
              { [source]: result },
              at,
            ),
        );
        assess(raw);
      } else if (phase === 1 && period) {
        const start = Date.parse(period.start);
        const billing = await official(
          collecting,
          at,
          start,
          true,
          async (source, result) => {
            if (isCounterSource(source))
              await saveLatest(
                collecting,
                scope,
                "billing",
                start,
                at,
                { [source]: result },
                at,
              );
          },
        );
        assess(billing, true);
      } else if (phase === 2) {
        assess(await saveDay(collecting, scope, today - DAY, at), true);
      } else if (phase === 3) {
        assess(await saveDay(collecting, scope, backfill, at), true);
        active(collecting);
        await env.DB.prepare(
          "UPDATE resource_usage_state SET backfill_day=? WHERE scope=? AND lease_until=?",
        )
          .bind(backfill - DAY, scope, leaseValue)
          .run();
      }
    }
    active(collecting);
    await env.DB.prepare(
      "UPDATE resource_usage_state SET lease_until=0,diagnostics_json=? WHERE scope=? AND lease_until=?",
    )
      .bind(
        progress(
          partial
            ? "本轮检查结束；部分来源未返回或覆盖不全，已保存数据继续展示，没有补零。"
            : "本轮采集检查结束；分析统计仍可能延迟，不证明账单完整入账。",
          partial ? "partial" : "ok",
        ),
        scope,
        leaseValue,
      )
      .run();
  };
  attempt.promise = (async () => {
    try {
      await interrupted(work(), controller.signal);
    } catch {
      // A late completion cannot clear another isolate's lease or overwrite newer snapshots.
      if (ownedLease !== null) {
        const cleanup = new AbortController();
        const cleanupTimer = setTimeout(() => cleanup.abort(), 2_000);
        try {
          await interrupted(
            env.DB.prepare(
              "UPDATE resource_usage_state SET lease_until=0,diagnostics_json=? WHERE scope=? AND lease_until=?",
            )
              .bind(
                progress(
                  "本轮采集超时或中断；仅保留已成功保存的来源和窗口，稍后重试。",
                  "unavailable",
                ),
                scope,
                ownedLease,
              )
              .run(),
            cleanup.signal,
          );
        } catch {
          /* The short D1 lease also recovers a lost cleanup or isolate. */
        } finally {
          clearTimeout(cleanupTimer);
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (inFlight.get(scope) === attempt) inFlight.delete(scope);
    }
  })();
  inFlight.set(scope, attempt);
  return attempt.promise;
}

function latestResult(
  row: SavedResult,
  expectedStart?: number,
): OfficialResult {
  const diagnostics = parsed<ResourceDiagnostic[]>(row.diagnostics_json, []);
  if (expectedStart !== undefined && row.range_start !== expectedStart)
    return {
      metrics: [],
      diagnostics: [
        ...diagnostics,
        {
          source: row.source,
          state: "stale",
          checkedAt: row.checked_at,
          note: "此前结果属于另一账期，未计入本账期。",
        },
      ],
    };
  const result = parsed<OfficialResult>(row.result_json, {
    metrics: [],
    diagnostics: [],
  });
  const stale =
    row.observed_at &&
    (diagnostics.some((d) =>
      ["unavailable", "restricted", "empty"].includes(d.state),
    ) ||
      row.observed_at < row.checked_at);
  const retainedNote = `保留最后成功数据；统计范围 ${new Date(row.range_start).toISOString()} 至 ${new Date(row.range_end).toISOString()}，没有填零。`;
  if (stale)
    diagnostics.push({
      source: row.source,
      state: "stale",
      checkedAt: row.checked_at,
      dataAt: row.observed_at,
      note: retainedNote,
    });
  return {
    metrics: stale
      ? result.metrics.map((item) => ({
          ...item,
          note: [item.note, retainedNote].filter(Boolean).join(" "),
        }))
      : result.metrics,
    diagnostics,
  };
}

function billingCoverage(
  kind: NonNullable<ResourceMetric["coverage"]>["kind"],
  start: number,
  end: number,
  windows: { start: number; end: number }[],
): NonNullable<ResourceMetric["coverage"]> {
  const intervals: { start: number; end: number }[] = [];
  for (const window of windows.sort((a, b) => a.start - b.start)) {
    const last = intervals.at(-1);
    if (last && window.start <= last.end)
      last.end = Math.max(last.end, window.end);
    else intervals.push({ ...window });
  }
  return {
    kind,
    rangeStart: start,
    rangeEnd: end,
    intervals,
    gapMilliseconds:
      end -
      start -
      intervals.reduce((sum, item) => sum + item.end - item.start, 0),
  };
}

function billingCoverageNote(
  coverage: NonNullable<ResourceMetric["coverage"]>,
) {
  const date = (at: number) =>
    new Date(at).toLocaleString("zh-CN", {
      timeZone: "Asia/Singapore",
      hour12: false,
    });
  const intervals = coverage.intervals
    .map((item) => `${date(item.start)} 至 ${date(item.end)}`)
    .join("；");
  const gap =
    coverage.gapMilliseconds >= 3600_000
      ? `${(coverage.gapMilliseconds / 3600_000).toFixed(2)} 小时`
      : `${Math.ceil(coverage.gapMilliseconds / 1000)} 秒`;
  return `实际覆盖 ${intervals}（Asia/Singapore）；${
    coverage.gapMilliseconds > 0
      ? `覆盖不完整，已知缺口 ${gap}，未按零补齐`
      : "已保存窗口覆盖至本次查询结束"
  }。分析统计仍可能采样或迟到，不代表完整账单或账户剩余额度。`;
}

/** Prefer one validated same-cycle snapshot per field; never add overlapping sources. */
function billingSnapshot(
  row: SavedResult,
  start: number,
  end: number,
): OfficialResult {
  const result = latestResult(row, start);
  const metrics =
    row.range_start !== start || row.range_end > end || row.range_end <= start
      ? []
      : result.metrics.flatMap((item) => {
          const coveredEnd = Math.min(row.range_end, item.observedAt);
          if (numeric(item.value) === null || coveredEnd <= start) return [];
          const coverage = billingCoverage("billing-snapshot", start, end, [
            { start, end: coveredEnd },
          ]);
          return [
            {
              ...item,
              coverage,
              note: [
                item.note,
                "优先使用本账期最后成功的官方整段查询；不叠加每日记录。",
                billingCoverageNote(coverage),
              ]
                .filter(Boolean)
                .join(" "),
            },
          ];
        });
  return { ...result, metrics };
}

function recordedBillingUsage(
  daily: SavedDay[],
  start: number,
  end: number,
  checkedAt: number,
): Record<string, OfficialResult> {
  const fields = new Map<
    string,
    Map<
      string,
      {
        metric: ResourceMetric;
        windows: { start: number; end: number }[];
      }
    >
  >();
  for (const row of daily) {
    // A daily total that crosses the cycle boundary cannot be split without
    // exact upstream evidence. In particular, never prorate requests by time.
    if (
      !isCounterSource(row.source) ||
      row.day_start < start ||
      row.day_start % DAY !== 0 ||
      row.covered_end > end ||
      row.covered_end > row.day_start + DAY
    )
      continue;
    const result = parsed<OfficialResult>(row.result_json, {
      metrics: [],
      diagnostics: [],
    });
    if (!good(result)) continue;
    const byKey = fields.get(row.source) || new Map();
    for (const item of result.metrics) {
      const coveredEnd = Math.min(row.covered_end, item.observedAt);
      if (
        numeric(item.value) === null ||
        item.source !== "official" ||
        coveredEnd <= row.day_start
      )
        continue;
      const prior = byKey.get(item.key);
      byKey.set(item.key, {
        metric: {
          ...item,
          value: Number(prior?.metric.value ?? 0) + Number(item.value),
          observedAt: Math.max(prior?.metric.observedAt ?? 0, item.observedAt),
        },
        windows: [
          ...(prior?.windows || []),
          { start: row.day_start, end: coveredEnd },
        ],
      });
    }
    if (byKey.size) fields.set(row.source, byKey);
  }
  return Object.fromEntries(
    [...fields].map(([source, byKey]) => {
      const metrics = [...byKey.values()].map(({ metric: item, windows }) => {
        const coverage = billingCoverage("daily-ledger", start, end, windows);
        return {
          ...item,
          coverage,
          note: `本账期已记录用量，来自本项目已保存的官方每日数据；仅汇总完整落在实际账期内的日窗口。${billingCoverageNote(coverage)}`,
        };
      });
      return [
        source,
        {
          metrics,
          diagnostics: [
            {
              source: `${source} · 本账期每日记录回退`,
              state: metrics.some((item) => item.coverage.gapMilliseconds > 0)
                ? "partial"
                : "ok",
              checkedAt,
              dataAt: Math.max(...metrics.map((item) => item.observedAt)),
              note: "仅缺少可用官方账期值的字段使用已保存每日记录；来源不相加，缺失不补零，跨账期日窗口不按时间比例估算。",
            },
          ],
        } satisfies OfficialResult,
      ];
    }),
  );
}

/** Authenticated project dashboard. Persistent source results survive releases and isolate restarts. */
export async function resourceUsage(
  env: Env,
  options: {
    refresh?: boolean;
    range?: ResourceRange;
    waitUntil?: (promise: Promise<void>) => void;
  } = {},
): Promise<ResourceUsageSnapshot> {
  const at = Date.now(),
    scope = await scopeIdentity(env),
    range = options.range || "24h";
  let collectionFailed = false;
  const pending = collectResourceUsage(env, { force: options.refresh, at });
  if (options.waitUntil) options.waitUntil(pending.catch(() => {}));
  else
    try {
      await pending;
    } catch {
      collectionFailed = true;
    }
  const [cards, state, saved, coverage] = await Promise.all([
    projectCards(env, at),
    env.DB.prepare("SELECT * FROM resource_usage_state WHERE scope=?")
      .bind(scope)
      .first<CollectionState>(),
    env.DB.prepare(
      "SELECT * FROM resource_usage_latest WHERE scope=? AND kind IN ('24h',?)",
    )
      .bind(scope, range === "billing" ? "billing" : "24h")
      .all<SavedResult & { kind: string }>(),
    env.DB.prepare(
      range === "all"
        ? `SELECT (SELECT MIN(day_start) FROM resource_usage_daily WHERE scope=?) AS day,
      (SELECT MIN(started_at) FROM resource_usage_jobs WHERE scope=? AND json_extract(consumption_json,'$.reliability') IS NOT 'invalidated') AS task,
      (SELECT MIN(started_at) FROM resource_usage_builds WHERE scope=?) AS build`
        : // Keep the public collection start via a single indexed MIN lookup.
          // Short-range starts never need the permanent task/build history.
          "SELECT MIN(day_start) AS day,NULL AS task,NULL AS build FROM resource_usage_daily WHERE scope=?",
    )
      .bind(...(range === "all" ? [scope, scope, scope] : [scope]))
      .first<{
        day: number | null;
        task: number | null;
        build: number | null;
      }>(),
  ]);
  const period = state?.anchor ? billingPeriod(state.anchor, at) : null;
  const coverageStart = coverage?.day ?? null;
  const taskStart = coverage?.task ?? null;
  const buildStart = coverage?.build ?? null;
  const starts = [coverageStart, taskStart, buildStart].filter(
    (v): v is number => v !== null,
  );
  const start =
    range === "24h"
      ? at - DAY
      : range === "billing"
        ? period
          ? Date.parse(period.start)
          : at
        : starts.length
          ? Math.min(...starts)
          : at;
  // Billing reads only this scope and cycle; the dedicated range index avoids
  // scanning the permanent ledger. A crossing first-day total is left as a gap.
  const [daily, tasks, builds] = await Promise.all([
    range === "all"
      ? env.DB.prepare(
          "SELECT source,day_start,covered_end,result_json,observed_at FROM resource_usage_daily WHERE scope=? ORDER BY day_start",
        )
          .bind(scope)
          .all<SavedDay>()
      : range === "billing" && period
        ? env.DB.prepare(
            "SELECT source,day_start,covered_end,result_json,observed_at FROM resource_usage_daily WHERE scope=? AND day_start>=? AND day_start<? ORDER BY day_start",
          )
            .bind(scope, start, at)
            .all<SavedDay>()
        : Promise.resolve({ results: [] }),
    env.DB.prepare(
      "SELECT started_at,ended_at,consumption_json FROM resource_usage_jobs WHERE scope=? AND ended_at>=? AND started_at<?",
    )
      .bind(scope, start, at)
      .all<{
        started_at: number;
        ended_at: number;
        consumption_json: string;
      }>(),
    env.DB.prepare(
      "SELECT started_at,ended_at,outcome,observed_at FROM resource_usage_builds WHERE scope=? AND started_at>=? AND started_at<?",
    )
      .bind(scope, start, at)
      .all<{
        started_at: number;
        ended_at: number | null;
        outcome: string;
        observed_at: number;
      }>(),
  ]);
  const raw: Record<string, OfficialResult> = {};
  for (const row of saved.results) {
    if (isCounterSource(row.source) && range !== "24h") {
      if (range === "billing" && row.kind === "billing" && period)
        raw[row.source] = billingSnapshot(row, start, at);
    } else if (row.kind === "24h") raw[row.source] = latestResult(row);
  }
  if (range === "billing" && period) {
    for (const [source, recorded] of Object.entries(
      recordedBillingUsage(daily.results, start, at, state?.checked_at || 0),
    )) {
      const preferred = raw[source] || { metrics: [], diagnostics: [] };
      const present = new Set(preferred.metrics.map((item) => item.key));
      const fallback = recorded.metrics.filter(
        (item) => !present.has(item.key),
      );
      raw[source] = {
        metrics: [...preferred.metrics, ...fallback],
        diagnostics: [
          ...preferred.diagnostics,
          ...(fallback.length
            ? recorded.diagnostics.map((item) => ({
                ...item,
                state: fallback.some(
                  (field) => field.coverage!.gapMilliseconds > 0,
                )
                  ? ("partial" as const)
                  : ("ok" as const),
                dataAt: Math.max(...fallback.map((field) => field.observedAt)),
              }))
            : []),
        ],
      };
    }
  }
  if (range === "all") {
    const totals = new Map<string, Map<string, ResourceMetric>>(),
      windows = new Map<string, { start: number; end: number }[]>();
    for (const row of daily.results) {
      const result = parsed<OfficialResult>(row.result_json, {
        metrics: [],
        diagnostics: [],
      });
      const byKey = totals.get(row.source) || new Map<string, ResourceMetric>();
      for (const item of result.metrics) {
        if (typeof item.value !== "number") continue;
        const prior = byKey.get(item.key);
        byKey.set(item.key, {
          ...item,
          value: Number(prior?.value ?? 0) + item.value,
          observedAt: Math.max(prior?.observedAt ?? 0, item.observedAt),
        });
        const windowKey = `${row.source}/${item.key}`,
          ranges = windows.get(windowKey) || [];
        ranges.push({
          start: row.day_start,
          end: Math.min(row.covered_end, item.observedAt),
        });
        windows.set(windowKey, ranges);
      }
      totals.set(row.source, byKey);
    }
    for (const [source, metrics] of totals) {
      let hasGaps = false;
      const combined = [...metrics.values()].map((item) => {
        const ranges = windows.get(`${source}/${item.key}`)!;
        let covered = ranges[0].start,
          gaps = 0;
        for (const r of ranges) {
          if (r.start > covered) gaps += r.start - covered;
          covered = Math.max(covered, r.end);
        }
        if (covered < at) gaps += at - covered;
        hasGaps ||= gaps > 0;
        return {
          ...item,
          note: `仅累加此字段已保存的不重叠日窗口；从 ${new Date(ranges[0].start).toISOString()} 起，已知缺口 ${(gaps / 3600_000).toFixed(1)} 小时。更早历史不可恢复；采样、迟到修正可能改变数值。`,
        };
      });
      raw[source] = {
        metrics: combined,
        diagnostics: [
          {
            source,
            state: hasGaps ? "partial" : "ok",
            checkedAt: state?.checked_at || 0,
            note: hasGaps
              ? "累计中存在未采集、未返回或失败的时间段；没有按零补齐。"
              : "累计保留已采集窗口；分析接口未证明账单完整入账。",
          },
        ],
      };
    }
    for (const row of saved.results.filter(
      (row) => row.kind === "24h" && isCounterSource(row.source),
    )) {
      const diagnosis = parsed<ResourceDiagnostic[]>(row.diagnostics_json, []);
      if (!raw[row.source])
        raw[row.source] = { metrics: [], diagnostics: diagnosis };
      else
        raw[row.source].diagnostics.push(
          ...diagnosis.filter((item) => item.state !== "ok"),
        );
    }
  }
  const rangeLabel =
    range === "24h"
      ? "近 24 小时"
      : range === "billing"
        ? period
          ? "本账期（Cloudflare 实际周期）"
          : "本账期暂未确认"
        : "累计（有可靠记录的范围）";
  for (const card of cards) {
    const keys =
      card.key === "r2"
        ? ["r2-operations", "r2-storage"]
        : card.key === "d1"
          ? ["d1-analytics", "d1-storage"]
          : card.key === "do"
            ? Object.keys(raw).filter((key) => key.startsWith("do-"))
            : [card.key];
    const data = merge(keys.map((key) => raw[key]).filter(Boolean));
    card.metrics.unshift(
      ...data.metrics.map((item) => ({
        ...item,
        label: item.label.replace(
          /最近 24 小时/g,
          item.coverage?.kind === "daily-ledger"
            ? "本账期已记录用量"
            : rangeLabel,
        ),
      })),
    );
    card.diagnostics.push(...data.diagnostics);
    if (card.key !== "containers" && card.key !== "builds")
      card.notes.push(
        "容量、对象数、视频和当前保留日志始终显示当前状态；不会把每日存储快照相加成累计空间。",
      );
    if (collectionFailed)
      card.diagnostics.push({
        source: "持续采集",
        state: "unavailable",
        checkedAt: at,
        note: "本轮采集未完成，已保存数据继续显示；稍后自动重试。",
      });
    if (range === "billing" && !period)
      card.notes.push(
        "尚无可信的 Cloudflare 账期规则；当前状态继续显示，用量未套用自然月。",
      );
  }
  const container = cards.find((card) => card.key === "containers")!;
  if (tasks.results.length)
    container.metrics = container.metrics.filter(
      (item) => item.key !== "ownedStarts",
    );
  const amounts: Record<string, number> = {},
    counts: Record<string, number> = {};
  for (const task of tasks.results)
    for (const [field, value] of Object.entries(
      allocateTaskConsumption(task, start, at),
    )) {
      amounts[field] = (amounts[field] || 0) + value;
      counts[field] = (counts[field] || 0) + 1;
    }
  for (const [field, key, label, unit, officialKey] of [
    ["wallSeconds", "wallSeconds", "已停止任务观察运行时间", "seconds", ""],
    [
      "cpuVcpuSecondsUpper",
      "cpuUpper",
      "CPU 容量时间上界",
      "vcpu-seconds",
      "cpuTimeSec",
    ],
    [
      "memoryGibSecondsUpper",
      "memoryUpper",
      "内存容量时间上界",
      "gib-seconds",
      "allocatedMemory",
    ],
    [
      "diskGbSecondsUpper",
      "diskUpper",
      "磁盘容量时间上界",
      "gb-seconds",
      "allocatedDisk",
    ],
  ] as const) {
    if (
      counts[field] &&
      (!officialKey ||
        !container.metrics.some((item) => item.key === officialKey))
    )
      container.metrics.push(
        metric(
          key,
          label,
          amounts[field],
          unit,
          "estimate",
          at,
          `${counts[field]} 个已核实停止、可归属的任务；规格 × 观察时间，跨范围按时间占比分摊。不是实际 CPU、峰值或账单；缺失字段未推算。`,
        ),
      );
  }
  container.notes.push(
    "官方值与任务估算分别取用，不相加。未核验停止或无法归属的记录不记作确定消耗。",
  );
  const buildCard = cards.find((card) => card.key === "builds")!,
    selectedBuilds = builds.results.filter(
      (build) => build.started_at >= start && build.started_at < at,
    );
  if (selectedBuilds.length) {
    buildCard.metrics = [
      metric(
        "buildCount",
        "已采集构建记录",
        selectedBuilds.length,
        "count",
        "official",
        Math.max(...selectedBuilds.map((b) => b.observed_at)),
        "按创建时间筛选、稳定构建 ID 去重；不承诺接口保留期之前的完整历史。",
      ),
    ];
    for (const [outcome, label] of [
      ["success", "成功"],
      ["fail", "失败"],
      ["cancelled", "取消"],
      ["skipped", "跳过"],
      ["pending", "尚未结束"],
    ])
      buildCard.metrics.push(
        metric(
          `build-${outcome}`,
          label,
          selectedBuilds.filter((b) => b.outcome === outcome).length,
          "count",
          "official",
          at,
        ),
      );
    const timed = selectedBuilds.filter((b) => b.ended_at !== null);
    if (timed.length)
      buildCard.metrics.push(
        metric(
          "buildWallSeconds",
          "构建记录经过时间",
          timed.reduce(
            (total, b) => total + (b.ended_at! - b.started_at) / 1000,
            0,
          ),
          "seconds",
          "official",
          at,
          "创建至结束包含排队和部署；不是官方计费构建分钟。",
        ),
      );
  }
  const budgetResult = await env.DB.prepare(
      "SELECT value FROM settings WHERE key='monthly_spend_limit_usd'",
    ).first<{ value: string }>(),
    budget = Number(budgetResult?.value ?? NaN);
  const collectionDiagnostic = parsed<ResourceDiagnostic[]>(
    state?.diagnostics_json || "[]",
    [],
  ).find((item) => item.source === "持续采集");
  const collecting = !!state && state.lease_until > at;
  const status = collecting
    ? "collecting"
    : !state?.checked_at
      ? "pending"
      : state.lease_until > 0 ||
          collectionDiagnostic?.state === "unavailable" ||
          collectionDiagnostic?.state === "partial"
        ? "partial"
        : "ready";
  const retryAt = collecting
    ? state.lease_until
    : state?.lease_until
      ? at
      : (state?.checked_at || at) +
        (collectionDiagnostic?.state === "unavailable" ? RETRY : TTL);
  return {
    fetchedAt: at,
    cached: !!state && state.checked_at < at,
    nextRefreshAt: retryAt,
    environment: env.APP_ENV || "unconfigured",
    worker: name(env.RESOURCE_WORKER_NAME),
    range,
    period: {
      start: new Date(start).toISOString(),
      end: new Date(at).toISOString(),
      label: `${rangeLabel} · ${new Date(start).toLocaleString("zh-CN", { timeZone: "Asia/Singapore" })} 至 ${new Date(at).toLocaleString("zh-CN", { timeZone: "Asia/Singapore" })}（Asia/Singapore）`,
    },
    cards,
    collection: {
      checkedAt: state?.checked_at || 0,
      status,
      retryAt,
      scope: `${env.APP_ENV || "unconfigured"} / ${name(env.RESOURCE_WORKER_NAME) || "unconfigured"}`,
      intervalMinutes: 60,
      coverageStart,
      note: [
        collecting
          ? "正在后台采集；先展示项目记录及已保存用量，无需保持页面打开。"
          : status === "pending"
            ? "首次后台采集已安排；暂时展示项目记录，没有把未知用量填零。"
            : state?.lease_until
              ? "上轮采集中断；后台将重试，已有数据继续展示。"
              : collectionDiagnostic?.note,
        "每小时保存；近两天重查迟到数据，轮巡补采最近31天。采集检查时间不代表所有来源完整；没有记录的历史不补零。",
      ]
        .filter(Boolean)
        .join(" "),
    },
    policy: {
      processingEnabled: env.PROCESSING_ENABLED === "true",
      monthlyIncrementalBudgetUsd:
        Number.isFinite(budget) && budget >= 0 ? budget : null,
    },
  };
}
