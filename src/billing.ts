import type { Env, Quote, Video } from "./types";
import { HttpError, id } from "./http";

const API = "https://api.cloudflare.com/client/v4";
const GiB = 1024 ** 3;
const GB = 1e9;
const DAY = 86400000;
const MAX_AGE = 5 * 60 * 1000;
const LIMIT = 10000;
const PROJECT_STORAGE_CENSUS_MAX_PAGES = 100;
const ACCOUNT_INVENTORY_MAX_PAGES = 10;
const ACCOUNT_INVENTORY_PAGE_SIZE = 1000;
const R2_JURISDICTIONS = [
  "default",
  "eu",
  "us",
  "fedramp",
  "fedramp-high",
] as const;
type R2Jurisdiction = (typeof R2_JURISDICTIONS)[number];
type Row = Record<string, unknown>;
type Amounts = Record<string, number>;
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(record) : [];
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const string = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const iso = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

export type UsageDisplayStatus =
  | "ok-data"
  | "ok-empty"
  | "delayed-incomplete"
  | "permissions"
  | "temporary-failure"
  | "adapter-not-implemented"
  | "automatic-unavailable";
export interface UsageDisplay {
  status: UsageDisplayStatus;
  value: number | null;
  basis:
    | "official-recorded"
    | "analytics-estimate"
    | "current-snapshot"
    | "last-good"
    | "unknown";
  source: string;
  scope: "account" | "project";
  fetchedAt: number;
  periodStart: string | null;
  periodEnd: string | null;
  stale: boolean;
  admissionUnconfirmed: boolean;
  reason: string;
}
export interface UsageInventory {
  product: "d1" | "r2" | "do";
  status: UsageDisplayStatus;
  scope: "account";
  complete: boolean;
  pages: number;
  listed: number;
  matched: number | null;
  missing: number | null;
  currentBytes: number | null;
  fetchedAt: number;
  reason: string;
  newlyCreated?: number;
  emptyConfirmed?: number;
  unmatchedObserved?: number;
  observedAt?: number | null;
  pendingMultipartUploads?: number | null;
  scopes?: {
    jurisdiction: R2Jurisdiction;
    status: UsageDisplayStatus;
    complete: boolean;
    pages: number;
    listed: number;
    httpStatus: number | null;
    errorCodes: number[];
    automatic: boolean;
    fetchedAt: number | null;
    reason: string;
  }[];
  classScope?: {
    scope: "account";
    basis: "documented-account-metrics";
    complete: boolean;
    status: UsageDisplayStatus;
    fetchedAt: number;
    reason: string;
  };
  classes?: {
    name: "Standard" | "InfrequentAccess";
    publishedBytes: number | null;
    uploadedBytes: number | null;
  }[];
}
export interface SourceStatus {
  name: string;
  url: string;
  status: "ok" | "unavailable" | "restricted";
  httpStatus: number | null;
  errorCodes: number[];
  rows: number | null;
  requestedStart: string | null;
  requestedEnd: string | null;
  displayStatus?: UsageDisplayStatus;
  reason?: string;
  automatic?: boolean;
  fetchedAt?: number;
}
export interface UsageResource {
  key: string;
  label: string;
  unit: string;
  included: number | null;
  inclusion: "free" | "paid-plan" | "unknown";
  officialRecorded: number | null;
  unbilledEstimate: number | null;
  projectedFuture: number | null;
  reserved: number;
  requested: number;
  remaining: number | null;
  source: string;
  requestedStart: string | null;
  requestedEnd: string | null;
  recordedStart: string | null;
  recordedEnd: string | null;
  sourceCompleteThrough: string | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  budgetUsable: boolean;
  remainingIsEstimate: boolean;
  confidenceLevel: number | null;
  safetyHeadroom: number;
  notes: string[];
  display?: UsageDisplay;
}
export interface UsageSnapshot {
  id: string;
  scope?: "upload" | "all";
  fetchedAt: number;
  expiresAt: number;
  periodStart: string | null;
  periodEnd: string | null;
  coverageEnd: string | null;
  complete: boolean;
  processingAllowed: boolean;
  storageAllowed: boolean;
  blockers: string[];
  resources: UsageResource[];
  policy: { storageLimitBytes: number; monthlySpendLimitUsd: number };
  project: {
    storedBytes: number | null;
    reservedBytes: number;
    ledgerValid?: boolean;
    actualBytes?: number;
  };
  sources: SourceStatus[];
  priorPeriodUnreconciled: Record<string, number>;
  historical: {
    periodStart: string;
    metric: string;
    quantity: number;
    unit: string;
    coverageEnd: string | null;
  }[];
  warnings: string[];
  inventories?: UsageInventory[];
}
export interface ContainerInstance {
  name: string;
  vcpu: number;
  memoryBytes: number;
  diskBytes: number;
}
export interface QuoteDraft {
  executionAllowed: boolean;
  executionBlockers: string[];
  approvalPolicyVersion: 3;
  feePolicy: "verified-included-only";
  executionNextStep: string;
  snapshotId: string;
  periodStart: string;
  instance: ContainerInstance;
  mode: "probe-remux" | "transcode" | "faststart";
  quality: "source" | "1080p" | "720p";
  sourceRevision: string;
  sourceEtag: string;
  sourceKey: string;
  sourceBytes: number;
  outputKind: "hls" | "mp4";
  outputName: "index.m3u8" | "optimized.mp4";
  encoding: "copy-only" | "h264-aac";
  maxUploadAttempts: 3;
  maxOutputBytes: number;
  totalTimeoutSeconds: number;
  costUpperUsd: number;
  costBreakdown?: {
    key: string;
    label: string;
    upperUsd: number;
    billingRule: string;
  }[];
  resourceAmounts: Amounts;
  expiresAt: number;
  codec: string;
  audio: string;
  estimatedSeconds: [number, number] | null;
  maxMediaObjects: number;
  warnings: string[];
  accountCapacity: {
    vcpu: number;
    memoryBytes: number;
    diskBytes: number;
    checkedAt: number;
  };
}

interface ApiResult {
  status: SourceStatus;
  body: Row;
}
async function api(
  env: Env,
  path: string,
  name: string,
  query?: string,
  interval?: { start: string; end: string },
  deadline?: number,
  jurisdiction?: R2Jurisdiction,
): Promise<ApiResult> {
  const status: SourceStatus = {
    name,
    // Cursors may encode bucket names. Product IDs and query strings do not
    // belong in a persisted display source descriptor.
    url: `${API}${path
      .split("?")[0]
      .replace(env.CLOUDFLARE_ACCOUNT_ID || "---", "{account_id}")
      .replace(/(\/d1\/database|\/namespaces)\/[^/]+/, "$1/{resource_id}")}`,
    status: "unavailable",
    httpStatus: null,
    errorCodes: [],
    rows: null,
    requestedStart: interval?.start || null,
    requestedEnd: interval?.end || null,
    automatic: true,
    fetchedAt: Date.now(),
  };
  if (
    !env.CF_USAGE_API_TOKEN ||
    !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || "") ||
    (deadline !== undefined && Date.now() >= deadline)
  ) {
    status.reason =
      deadline !== undefined && Date.now() >= deadline
        ? "本次有界读取时间已用完，接口未再请求。"
        : "运行时只读凭据或账户范围尚未配置。";
    return { status, body: {} };
  }
  try {
    const response = await fetch(`${API}${path}`, {
      method: query ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${env.CF_USAGE_API_TOKEN}`,
        "Content-Type": "application/json",
        ...(jurisdiction ? { "cf-r2-jurisdiction": jurisdiction } : {}),
      },
      ...(query ? { body: JSON.stringify({ query }) } : {}),
      signal: AbortSignal.timeout(
        deadline === undefined
          ? 15000
          : Math.max(1, Math.min(15000, deadline - Date.now())),
      ),
    });
    status.httpStatus = response.status;
    // Never retain or expose Cloudflare error bodies, account identities, or client_secrets.
    const body = record(await response.json());
    status.errorCodes = rows(body.errors)
      .map((e) => number(e.code))
      .filter((e): e is number => e !== null);
    const failed =
      !response.ok || body.success === false || rows(body.errors).length > 0;
    status.status = failed
      ? [401, 403].includes(response.status)
        ? "restricted"
        : "unavailable"
      : "ok";
    status.rows = Array.isArray(body.result) ? body.result.length : null;
    if (failed)
      status.reason =
        status.status === "restricted"
          ? "运行时只读凭据访问此接口被拒绝；不代表零用量。"
          : "接口返回失败或暂不可用；原始错误响应未保留。";
    return { status, body: failed ? {} : body };
  } catch {
    status.reason = "有界请求超时、网络失败或响应格式不可读；不代表零用量。";
    return { status, body: {} };
  }
}

/** Recurrence uses the actual subscription anchor, preserving UTC time and month-end clamping. */
export function billingPeriod(
  anchor: string,
  at: number,
): { start: string; end: string } | null {
  const d = new Date(anchor);
  if (!Number.isFinite(d.getTime()) || d.getTime() > at) return null;
  const current = new Date(at);
  const boundary = (year: number, month: number) =>
    new Date(
      Date.UTC(
        year,
        month,
        Math.min(
          d.getUTCDate(),
          new Date(Date.UTC(year, month + 1, 0)).getUTCDate(),
        ),
        d.getUTCHours(),
        d.getUTCMinutes(),
        d.getUTCSeconds(),
      ),
    );
  let start = boundary(current.getUTCFullYear(), current.getUTCMonth());
  if (start.getTime() > at)
    start = boundary(current.getUTCFullYear(), current.getUTCMonth() - 1);
  const end = boundary(start.getUTCFullYear(), start.getUTCMonth() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

interface MetricSpec {
  key: string;
  label: string;
  unit: string;
  match: RegExp;
  factor: number;
  included: number;
  paid: boolean;
}
const METRICS: MetricSpec[] = [
  {
    key: "containerCpuSeconds",
    label: "Containers CPU",
    unit: "vCPU-seconds",
    match: /^Container vCPU\b/,
    factor: 1,
    included: 375 * 60,
    paid: true,
  },
  {
    key: "containerMemoryByteSeconds",
    label: "Containers 内存",
    unit: "byte-seconds",
    match: /^Container Memory\b/,
    factor: GiB,
    included: 25 * GiB * 3600,
    paid: true,
  },
  {
    key: "containerDiskByteSeconds",
    label: "Containers 磁盘",
    unit: "byte-seconds",
    match: /^Container Disk\b/,
    factor: GB,
    included: 200 * GB * 3600,
    paid: true,
  },
  {
    key: "containerEgressBytes",
    label: "Containers 出口（全部地区保守共享下限）",
    unit: "bytes",
    match: /^Container Egress,/,
    factor: GB,
    included: 500 * GB,
    paid: true,
  },
  {
    key: "r2StorageGbMonths",
    label: "R2 当期累计存储",
    unit: "GB-months",
    match: /^R2 Data Storage\b/,
    factor: 1,
    included: 10,
    paid: false,
  },
  {
    key: "r2ClassA",
    label: "R2 Class A",
    unit: "requests",
    match: /^R2 Storage Class A Operations\b/,
    factor: 1,
    included: 1e6,
    paid: false,
  },
  {
    key: "r2ClassB",
    label: "R2 Class B",
    unit: "requests",
    match: /^R2 Storage Class B Operations\b/,
    factor: 1,
    included: 1e7,
    paid: false,
  },
  {
    key: "workersRequests",
    label: "Workers 请求",
    unit: "requests",
    match: /^Workers Standard Requests\b/,
    factor: 1,
    included: 1e7,
    paid: true,
  },
  {
    key: "workersCpuMilliseconds",
    label: "Workers CPU",
    unit: "milliseconds",
    match: /^Workers CPU ms\b/,
    factor: 1,
    included: 3e7,
    paid: true,
  },
  {
    key: "d1RowsRead",
    label: "D1 读取",
    unit: "rows",
    match: /^D1 - Rows Read\b/,
    factor: 1,
    included: 25e9,
    paid: true,
  },
  {
    key: "d1RowsWritten",
    label: "D1 写入",
    unit: "rows",
    match: /^D1 - Rows Written\b/,
    factor: 1,
    included: 5e7,
    paid: true,
  },
  {
    key: "d1StorageGbMonths",
    label: "D1 存储",
    unit: "GB-months",
    match: /^D1 - Storage GB-mo\b/,
    factor: 1,
    included: 5,
    paid: true,
  },
  {
    key: "doRequests",
    label: "Durable Objects 请求",
    unit: "requests",
    match: /^Durable Objects Compute Requests\b/,
    factor: 1,
    included: 1e6,
    paid: true,
  },
  {
    key: "doDurationGbSeconds",
    label: "Durable Objects 运行",
    unit: "GB-seconds",
    match: /^Durable Objects Compute Duration\b/,
    factor: 1,
    included: 4e5,
    paid: true,
  },
  {
    key: "doRowsRead",
    label: "Durable Objects SQL 读取",
    unit: "rows",
    match: /^Durable Objects Storage Rows Read\b/,
    factor: 1,
    included: 25e9,
    paid: true,
  },
  {
    key: "doRowsWritten",
    label: "Durable Objects SQL 写入",
    unit: "rows",
    match: /^Durable Objects Storage Rows Written\b/,
    factor: 1,
    included: 5e7,
    paid: true,
  },
  {
    key: "doStorageGbMonths",
    label: "Durable Objects SQL 存储",
    unit: "GB-months",
    match: /^Durable Objects SQL Storage\b/,
    factor: 1,
    included: 5,
    paid: true,
  },
  {
    key: "logsEvents",
    label: "Workers Observability 日志",
    unit: "events",
    match: /^Observability - Logs\b/,
    factor: 1e6,
    included: 2e7,
    paid: true,
  },
  {
    key: "buildMinutes",
    label: "Workers Builds",
    unit: "minutes",
    match: /^Workers Builds\b/,
    factor: 1,
    included: 6000,
    paid: true,
  },
];
const STORAGE_KEYS = [
  "r2CurrentBytes",
  "r2StorageGbMonths",
  "r2ClassA",
  "r2ClassB",
  "d1RowsRead",
  "d1RowsWritten",
  "d1StorageGbMonths",
];
const PROCESS_KEYS = [
  ...STORAGE_KEYS,
  "containerCpuSeconds",
  "containerMemoryByteSeconds",
  "containerDiskByteSeconds",
  "containerEgressBytes",
  "doRequests",
  "doDurationGbSeconds",
  "doRowsRead",
  "doRowsWritten",
  "doStorageGbMonths",
];

interface GraphSpec {
  node: string;
  selection: string;
  amounts: [string, string, number][];
}
const GRAPH: GraphSpec[] = [
  {
    node: "containersUsageAdaptiveGroups",
    selection: "sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }",
    amounts: [
      ["containerCpuSeconds", "cpuTimeSec", 1],
      ["containerMemoryByteSeconds", "allocatedMemory", 1],
      ["containerDiskByteSeconds", "allocatedDisk", 1],
      ["containerEgressBytes", "txBytes", 1],
    ],
  },
  {
    node: "r2OperationsAdaptiveGroups",
    selection: "sum { requests }",
    amounts: [],
  },
  {
    node: "d1AnalyticsAdaptiveGroups",
    selection: "sum { rowsRead rowsWritten }",
    amounts: [
      ["d1RowsRead", "rowsRead", 1],
      ["d1RowsWritten", "rowsWritten", 1],
    ],
  },
  {
    node: "workersInvocationsAdaptive",
    selection: "sum { requests cpuTimeUs }",
    amounts: [
      ["workersRequests", "requests", 1],
      ["workersCpuMilliseconds", "cpuTimeUs", 0.001],
    ],
  },
  {
    node: "durableObjectsInvocationsAdaptiveGroups",
    selection: "sum { requests }",
    amounts: [["doRequests", "requests", 1]],
  },
  {
    node: "durableObjectsPeriodicGroups",
    selection: "sum { duration rowsRead rowsWritten inboundWebsocketMsgCount }",
    amounts: [
      ["doDurationGbSeconds", "duration", 1],
      ["doRowsRead", "rowsRead", 1],
      ["doRowsWritten", "rowsWritten", 1],
    ],
  },
  {
    node: "workersBuildsBuildMinutesAdaptiveGroups",
    selection: "sum { buildMinutes }",
    amounts: [["buildMinutes", "buildMinutes", 1]],
  },
];

function account(body: Row): Row | null {
  const accounts = rows(record(record(body.data).viewer).accounts);
  return accounts.length === 1 ? accounts[0] : null;
}
function resource(key: string, label: string, unit: string): UsageResource {
  return {
    key,
    label,
    unit,
    included: null,
    inclusion: "unknown",
    officialRecorded: null,
    unbilledEstimate: null,
    projectedFuture: null,
    reserved: 0,
    requested: 0,
    remaining: null,
    source: "无法确认",
    requestedStart: null,
    requestedEnd: null,
    recordedStart: null,
    recordedEnd: null,
    sourceCompleteThrough: null,
    coverageStart: null,
    coverageEnd: null,
    budgetUsable: false,
    remainingIsEstimate: false,
    confidenceLevel: null,
    safetyHeadroom: 0,
    notes: [],
  };
}
function sumField(data: Row[], field: string): number | null {
  if (!data.length) return null;
  const values = data.map((d) => number(record(d.sum)[field]));
  return values.some((v) => v === null)
    ? null
    : values.reduce<number>((a, b) => a + (b || 0), 0);
}
function r2StorageKey(dimensions: Row): string | null {
  const bucket = string(dimensions.bucketName);
  const storageClass = string(dimensions.storageClass);
  return bucket?.trim() && storageClass?.trim()
    ? JSON.stringify([bucket, storageClass.toLowerCase()])
    : null;
}

interface ConfidenceBound {
  upper: number;
  width: number;
}
function confidenceSum(
  data: Row[],
  field: string,
  factor = 1,
): ConfidenceBound | null {
  if (!data.length) return null;
  let upper = 0;
  let width = 0;
  for (const row of data) {
    const point = number(record(row.sum)[field]);
    const bound = record(record(record(row.confidence).sum)[field]);
    const estimate = number(bound.estimate);
    const lower = number(bound.lower);
    const high = number(bound.upper);
    const samples = number(bound.sampleSize);
    if (
      bound.isValid !== true ||
      point === null ||
      estimate === null ||
      lower === null ||
      high === null ||
      samples === null ||
      samples <= 0 ||
      high < estimate ||
      lower > estimate ||
      Math.abs(estimate - point) > Math.max(1, estimate) * 1e-9
    )
      return null;
    upper += high * factor;
    width += (high - lower) * factor;
  }
  return Number.isFinite(upper) && Number.isFinite(width)
    ? { upper, width }
    : null;
}

type ReadUsageApi = (
  env: Env,
  path: string,
  name: string,
  query?: string,
  interval?: { start: string; end: string },
  jurisdiction?: R2Jurisdiction,
) => Promise<ApiResult>;
interface InventoryResult {
  items: Row[];
  summary: UsageInventory;
  status: SourceStatus;
  sources?: SourceStatus[];
}
function sourceDisplayStatus(status: SourceStatus): UsageDisplayStatus {
  return (
    status.displayStatus ||
    (status.status === "restricted"
      ? "permissions"
      : status.status !== "ok"
        ? "temporary-failure"
        : status.rows === 0
          ? "ok-empty"
          : "ok-data")
  );
}
/** Complete current inventory is distinct from historical billing completeness. */
async function readInventory(
  env: Env,
  product: UsageInventory["product"],
  read: ReadUsageApi,
  jurisdiction?: R2Jurisdiction,
): Promise<InventoryResult> {
  const path =
    product === "r2"
      ? "/r2/buckets"
      : product === "d1"
        ? "/d1/database"
        : "/workers/durable_objects/namespaces";
  const name =
    product === "r2"
      ? `R2 ${jurisdiction || "default"} bucket inventory`
      : product === "d1"
        ? "D1 account database inventory"
        : "Durable Objects account namespace inventory";
  const key = product === "r2" ? "name" : product === "d1" ? "uuid" : "id";
  const items: Row[] = [],
    seen = new Set<string>(),
    cursors = new Set<string>();
  let cursor: string | null = null,
    total: number | null = null;
  let result!: ApiResult;
  const summary: UsageInventory = {
    product,
    status: "temporary-failure",
    scope: "account",
    complete: false,
    pages: 0,
    listed: 0,
    matched: null,
    missing: null,
    currentBytes: null,
    fetchedAt: Date.now(),
    reason: "资源清单尚未取得。",
  };
  for (let page = 1; page <= ACCOUNT_INVENTORY_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      per_page: String(ACCOUNT_INVENTORY_PAGE_SIZE),
      ...(product === "r2"
        ? cursor
          ? { cursor }
          : {}
        : { page: String(page) }),
    });
    result = await read(
      env,
      `/accounts/${env.CLOUDFLARE_ACCOUNT_ID || "unconfigured"}${path}?${params}`,
      name,
      undefined,
      undefined,
      jurisdiction,
    );
    summary.pages++;
    summary.status = sourceDisplayStatus(result.status);
    if (result.status.status !== "ok") {
      if (product === "r2" && result.status.httpStatus === 400)
        summary.status = "delayed-incomplete";
      summary.reason =
        product === "r2" && result.status.httpStatus === 400
          ? "此 jurisdiction 请求返回 HTTP 400，接口支持或资格尚未核实；不能解释为空清单。"
          : summary.status === "permissions"
            ? "只读凭据访问资源清单被拒绝，权限或资格尚未证明；不等于没有资源。"
            : "资源清单请求暂时失败；已取得的部分不能证明完整账户清单。";
      break;
    }
    const raw =
      product === "r2"
        ? record(result.body.result).buckets
        : result.body.result;
    const data = rows(raw),
      info = record(result.body.result_info);
    if (
      !Array.isArray(raw) ||
      data.length > ACCOUNT_INVENTORY_PAGE_SIZE ||
      new Set(data.map((row) => row[key])).size !== data.length ||
      data.some(
        (row) =>
          typeof row[key] !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(String(row[key])) ||
          (product === "r2" &&
            row.jurisdiction !== undefined &&
            row.jurisdiction !== (jurisdiction || "default")) ||
          seen.has(String(row[key])),
      )
    ) {
      summary.status = "delayed-incomplete";
      summary.reason = "资源清单字段、分页大小或重复项异常；不能宣称清单完整。";
      break;
    }
    for (const row of data) {
      seen.add(String(row[key]));
      items.push(
        product === "r2" && jurisdiction && jurisdiction !== "default"
          ? { ...row, name: `${jurisdiction}_${row.name}` }
          : row,
      );
    }
    summary.listed = items.length;
    if (product === "r2") {
      // The documented terminal cursor is optional. A full page with no cursor
      // is ambiguous, so it cannot prove the end of the inventory.
      const next = info.cursor ?? record(result.body.result).cursor;
      if (next === undefined || next === null || next === "") {
        summary.complete = data.length < ACCOUNT_INVENTORY_PAGE_SIZE;
        break;
      }
      if (
        typeof next !== "string" ||
        next.length > 4096 ||
        !next ||
        cursors.has(next) ||
        !data.length
      )
        break;
      cursors.add(next);
      cursor = next;
    } else {
      const count = number(info.total_count),
        infoPage = number(info.page),
        perPage = number(info.per_page),
        returned = number(info.count);
      if (
        count === null ||
        !Number.isSafeInteger(count) ||
        infoPage !== page ||
        perPage !== ACCOUNT_INVENTORY_PAGE_SIZE ||
        (returned !== null && returned !== data.length) ||
        count < items.length ||
        (total !== null && count !== total)
      )
        break;
      total = count;
      if (items.length === total) {
        summary.complete = true;
        break;
      }
      if (!data.length || data.length < ACCOUNT_INVENTORY_PAGE_SIZE) break;
    }
  }
  if (result.status.status === "ok") {
    summary.status = summary.complete
      ? items.length
        ? "ok-data"
        : "ok-empty"
      : "delayed-incomplete";
    summary.reason = summary.complete
      ? "当前资源清单分页已结束；清单完整不等于历史计量完整，也不能把缺少统计的资源补零。"
      : "资源清单分页未完整核实，可能缺元数据、重复游标、发生变化或达到安全页数；仅展示已取得部分。";
  }
  result.status.rows = items.length;
  result.status.displayStatus = summary.status;
  result.status.reason = summary.reason;
  return { items, summary, status: result.status };
}
const R2_RESTRICTED_CACHE_KEY = "r2_inventory_restricted_cache_v1";
interface RestrictedR2Scope {
  jurisdiction: "fedramp" | "fedramp-high";
  httpStatus: 400 | 403;
  errorCodes: number[];
  fetchedAt: number;
}
async function readR2Inventory(
  env: Env,
  read: ReadUsageApi,
  refreshRestricted: boolean,
): Promise<InventoryResult> {
  const credentialHash = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([
            env.CLOUDFLARE_ACCOUNT_ID,
            env.APP_ENV,
            env.CF_USAGE_API_TOKEN,
          ]),
        ),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  let cached: RestrictedR2Scope[] = [];
  if (!refreshRestricted) {
    try {
      const stored = await env.DB.prepare(
        "SELECT value FROM settings WHERE key=?",
      )
        .bind(R2_RESTRICTED_CACHE_KEY)
        .first<{ value: string }>();
      const value =
        stored && stored.value.length <= 8192
          ? record(JSON.parse(stored.value))
          : {};
      if (
        value.schemaVersion === 1 &&
        value.credentialHash === credentialHash &&
        Array.isArray(value.entries) &&
        value.entries.length <= 2
      )
        cached = value.entries.filter((entry): entry is RestrictedR2Scope => {
          const row = record(entry);
          return (
            ["fedramp", "fedramp-high"].includes(String(row.jurisdiction)) &&
            (row.httpStatus === 400 || row.httpStatus === 403) &&
            Number.isSafeInteger(row.fetchedAt) &&
            Number(row.fetchedAt) >= 0 &&
            Number(row.fetchedAt) <= Date.now() &&
            Array.isArray(row.errorCodes) &&
            row.errorCodes.length <= 16 &&
            row.errorCodes.every(
              (code) => Number.isSafeInteger(code) && code >= 0,
            )
          );
        });
    } catch {
      /* Cache failure never supplies completeness or allowance. */
    }
  }
  const scoped = await Promise.all(
    R2_JURISDICTIONS.map((jurisdiction) => {
      const prior = cached.find((entry) => entry.jurisdiction === jurisdiction);
      if (!prior) return readInventory(env, "r2", read, jurisdiction);
      const status: SourceStatus = {
        name: `R2 ${jurisdiction} bucket inventory`,
        url: `${API}/accounts/{account_id}/r2/buckets`,
        status: prior.httpStatus === 403 ? "restricted" : "unavailable",
        httpStatus: prior.httpStatus,
        errorCodes: prior.errorCodes,
        rows: null,
        requestedStart: null,
        requestedEnd: null,
        automatic: false,
        fetchedAt: prior.fetchedAt,
        displayStatus:
          prior.httpStatus === 403 ? "permissions" : "delayed-incomplete",
        reason:
          "此前 jurisdiction 请求被拒绝，权限/资格或接口支持尚未证明；已暂停自动重复查询，须显式重试或更换凭据。原失败不是空清单。",
      };
      return Promise.resolve({
        items: [],
        status,
        summary: {
          product: "r2",
          scope: "account",
          status: status.displayStatus!,
          complete: false,
          pages: 0,
          listed: 0,
          matched: null,
          missing: null,
          currentBytes: null,
          fetchedAt: prior.fetchedAt,
          reason: status.reason!,
        },
      } as InventoryResult);
    }),
  );
  const restricted = scoped.flatMap((result, index): RestrictedR2Scope[] => {
    const jurisdiction = R2_JURISDICTIONS[index],
      status = result.status;
    return (jurisdiction === "fedramp" || jurisdiction === "fedramp-high") &&
      (status.httpStatus === 400 || status.httpStatus === 403) &&
      (status.automatic === false ||
        (result.summary.pages === 1 && result.summary.listed === 0)) &&
      status.fetchedAt !== undefined
      ? [
          {
            jurisdiction,
            httpStatus: status.httpStatus,
            errorCodes: status.errorCodes.slice(0, 16),
            fetchedAt: status.fetchedAt,
          },
        ]
      : [];
  });
  try {
    await env.DB.prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    )
      .bind(
        R2_RESTRICTED_CACHE_KEY,
        JSON.stringify({
          schemaVersion: 1,
          credentialHash,
          entries: restricted,
        }),
        Date.now(),
      )
      .run();
  } catch {
    /* A cache write failure means later reads may retry, never admit. */
  }
  const scopes = scoped.map((result, index) => ({
    jurisdiction: R2_JURISDICTIONS[index],
    status: result.summary.status,
    complete: result.summary.complete,
    pages: result.summary.pages,
    listed: result.summary.listed,
    httpStatus: result.status.httpStatus,
    errorCodes: result.status.errorCodes,
    automatic: result.status.automatic !== false,
    fetchedAt: result.status.fetchedAt ?? null,
    reason: result.summary.reason,
  }));
  const items = scoped.flatMap((result) => result.items),
    unique = new Map(items.map((item) => [String(item.name), item])),
    complete =
      scoped.every((result) => result.summary.complete) &&
      unique.size === items.length;
  const summary: UsageInventory = {
    product: "r2",
    scope: "account",
    complete,
    status: complete
      ? items.length
        ? "ok-data"
        : "ok-empty"
      : "delayed-incomplete",
    pages: scopes.reduce((sum, scope) => sum + scope.pages, 0),
    listed: unique.size,
    matched: null,
    missing: null,
    currentBytes: null,
    fetchedAt: Date.now(),
    scopes,
    reason: complete
      ? "五个 jurisdiction 的当前桶清单均完成分页；清单完整仍不证明历史计量或入账水位。"
      : "只展示已取得的 jurisdiction 清单；未成功或未完整分页的范围不是空清单，不能宣称全账户完整。",
  };
  return {
    items: [...unique.values()],
    summary,
    status: scoped[0].status,
    sources: scoped.map((result) => result.status),
  };
}
function matchInventory(
  inventory: InventoryResult,
  data: Row[],
  dimension: string,
  fields: string[],
  dateField: string,
  at: number,
) {
  const listed = new Set(
    inventory.items.map((row) =>
      String(
        row[
          inventory.summary.product === "r2"
            ? "name"
            : inventory.summary.product === "d1"
              ? "uuid"
              : "id"
        ],
      ),
    ),
  );
  const latest = new Map<string, Row>();
  let valid = true;
  for (const row of data) {
    const dimensions = record(row.dimensions),
      identifier = string(dimensions[dimension]);
    const when =
      dateField === "date"
        ? iso(`${dimensions.date}T00:00:00Z`)
        : iso(dimensions[dateField]);
    if (
      !identifier ||
      !when ||
      Date.parse(when) > at ||
      fields.some((field) => number(record(row.max)[field]) === null)
    ) {
      valid = false;
      continue;
    }
    const key =
      inventory.summary.product === "r2"
        ? r2StorageKey(dimensions)
        : identifier;
    if (key === null) {
      valid = false;
      continue;
    }
    const prior = latest.get(key);
    const priorDate = prior && string(record(prior.dimensions)[dateField]);
    if (!prior || String(dimensions[dateField]) > String(priorDate))
      latest.set(key, row);
  }
  const observed = new Set(
    [...latest.values()].map((row) =>
      String(record(row.dimensions)[dimension]),
    ),
  );
  const matched = [...listed].filter((identifier) => observed.has(identifier));
  inventory.summary.matched = matched.length;
  inventory.summary.missing = listed.size - matched.length;
  inventory.summary.unmatchedObserved = [...observed].filter(
    (identifier) => !listed.has(identifier),
  ).length;
  const sizes = [...latest.values()]
    .filter((row) => listed.has(String(record(row.dimensions)[dimension])))
    .map((row) =>
      fields.reduce((sum, field) => sum + number(record(row.max)[field])!, 0),
    );
  inventory.summary.currentBytes =
    sizes.length && valid ? sizes.reduce((sum, size) => sum + size, 0) : null;
  const dates = [...latest.values()]
    .filter((row) => listed.has(String(record(row.dimensions)[dimension])))
    .map((row) =>
      Date.parse(
        dateField === "date"
          ? `${record(row.dimensions).date}T00:00:00Z`
          : String(record(row.dimensions)[dateField]),
      ),
    );
  inventory.summary.observedAt =
    dates.length && dates.every(Number.isFinite) ? Math.min(...dates) : null;
  if (
    !valid ||
    data.length >= LIMIT ||
    inventory.summary.missing > 0 ||
    inventory.summary.unmatchedObserved > 0 ||
    !inventory.summary.complete
  ) {
    if (inventory.status.status === "ok")
      inventory.summary.status = "delayed-incomplete";
    inventory.summary.reason +=
      " 当前统计与清单不能完全匹配；只显示观测到的字节，缺行不是零，当前清单也不能补证已删除资源的历史。";
  }
  return latest;
}
function usageDisplay(
  resource: UsageResource,
  source: SourceStatus | undefined,
  at: number,
  period: { start: string; end: string } | null,
  value: number | null = null,
  basis: UsageDisplay["basis"] = "unknown",
): UsageDisplay {
  const observed = value ?? resource.officialRecorded;
  return {
    status: source ? sourceDisplayStatus(source) : "adapter-not-implemented",
    value: observed,
    basis:
      value !== null
        ? basis
        : resource.officialRecorded !== null
          ? "official-recorded"
          : "unknown",
    source: source?.name || resource.source,
    scope: "account",
    fetchedAt: source?.fetchedAt ?? at,
    periodStart: resource.requestedStart ?? period?.start ?? null,
    periodEnd: resource.requestedEnd ?? period?.end ?? null,
    stale: false,
    admissionUnconfirmed: !resource.budgetUsable,
    reason:
      observed === null
        ? "尚无可展示的已确认数值；成功的空统计也不表示零用量。"
        : "已取得数值可用于展示；是否可准入仍由独立的完整性、精度及额度校验决定。",
  };
}
async function retainLastDisplay(
  env: Env,
  resources: UsageResource[],
  at: number,
) {
  try {
    const row = await env.DB.prepare(
      "SELECT data_json FROM usage_snapshots WHERE COALESCE(json_extract(data_json,'$.scope'),'all')='all' ORDER BY fetched_at DESC LIMIT 1",
    ).first<{ data_json: string }>();
    if (
      !row ||
      typeof row.data_json !== "string" ||
      row.data_json.length > 512 * 1024
    )
      return;
    const previous = rows(record(JSON.parse(row.data_json)).resources);
    for (const resource of resources) {
      const display = resource.display;
      if (!display || display.value !== null) continue;
      const old = record(
        previous.find((row) => row.key === resource.key)?.display,
      );
      const value = number(old.value),
        fetchedAt = number(old.fetchedAt);
      if (
        value === null ||
        fetchedAt === null ||
        !Number.isSafeInteger(fetchedAt) ||
        fetchedAt > at ||
        old.scope !== "account" ||
        typeof old.source !== "string" ||
        old.source.length > 200
      )
        continue;
      resource.display = {
        ...display,
        value,
        fetchedAt,
        source: old.source,
        basis: "last-good",
        periodStart: iso(old.periodStart),
        periodEnd: iso(old.periodEnd),
        stale: true,
        admissionUnconfirmed: true,
        reason:
          "本次没有取得新的有效数值；保留上次成功观测及原时间/范围，仅供展示，不能用于当前额度准入。",
      };
    }
  } catch {
    // Display persistence is optional and cannot rescue or invalidate admission.
  }
}

export async function getUsage(
  env: Env,
  options: {
    refreshRestrictedR2?: boolean;
  } = {},
): Promise<UsageSnapshot> {
  const at = Date.now();
  const readApi = (
    readEnv: Env,
    path: string,
    name: string,
    query?: string,
    interval?: { start: string; end: string },
    jurisdiction?: R2Jurisdiction,
  ) => api(readEnv, path, name, query, interval, at + 25000, jurisdiction);
  const a = env.CLOUDFLARE_ACCOUNT_ID || "unconfigured";
  const [info, v1, plans, inventory, d1Inventory, doInventory, accountStorage] =
    await Promise.all([
      readApi(env, `/accounts/${a}/billable-usage/info`, "Billing V1 coverage"),
      readApi(
        env,
        `/accounts/${a}/billable-usage`,
        "Billing V1 official consumed usage",
      ),
      readApi(
        env,
        `/accounts/${a}/subscriptions`,
        "Active subscription catalog",
      ),
      readR2Inventory(env, readApi, options.refreshRestrictedR2 === true),
      readInventory(env, "d1", readApi),
      readInventory(env, "do", readApi),
      readApi(
        env,
        `/accounts/${a}/r2/metrics`,
        "R2 account class storage totals",
      ),
    ]);
  const sources = [
    info.status,
    v1.status,
    {
      name: "Billing V2 (Alpha, Restricted)",
      url: `${API}/accounts/{account_id}/billable/usage`,
      status: "restricted" as const,
      httpStatus: null,
      errorCodes: [],
      rows: null,
      requestedStart: null,
      requestedEnd: null,
      displayStatus: "automatic-unavailable" as const,
      automatic: false,
      reason:
        "官方受限 Alpha 接口，已停止自动轮询；需要账户资格核实后按需复核，未查询不能当作零或当前权限错误。",
    },
    plans.status,
    ...(inventory.sources || [inventory.status]),
    d1Inventory.status,
    ...(doInventory ? [doInventory.status] : []),
    accountStorage.status,
  ];
  const subscriptions = rows(record(info.body.result).subscriptions).filter(
    (s) => !s.end_timestamp || Date.parse(String(s.end_timestamp)) > at,
  );
  const periods = subscriptions
    .map((s) => billingPeriod(String(s.billing_cycle_anchor_timestamp), at))
    .filter((p): p is { start: string; end: string } => p !== null);
  const period =
    record(info.body.result).covered === true && periods.length === 1
      ? periods[0]
      : null;
  const activePlans = rows(plans.body.result).filter(
    (p) => p.state === "Paid" || p.state === "Active",
  );
  const paid = activePlans.some(
    (p) => record(p.rate_plan).id === "workers_paid",
  );
  const r2Active = activePlans.some(
    (p) => record(p.rate_plan).id === "r2_paid",
  );
  const currentRows = rows(v1.body.result).filter(
    (r) =>
      iso(r.BillingPeriodStart) === period?.start &&
      number(r.ConsumedQuantity) !== null,
  );
  const resources = METRICS.map((m) => {
    const r = resource(m.key, m.label, m.unit);
    if ((m.paid && paid) || (!m.paid && r2Active)) {
      r.included = m.included;
      r.inclusion = m.paid ? "paid-plan" : "free";
    }
    const matched = currentRows.filter((row) =>
      m.match.test(String(row.ServiceName || "")),
    );
    if (matched.length) {
      r.officialRecorded = matched.reduce(
        (n, row) => n + (number(row.ConsumedQuantity) || 0) * m.factor,
        0,
      );
      const starts = matched
        .map((row) => iso(row.ChargePeriodStart))
        .filter((d): d is string => d !== null);
      const ends = matched
        .map((row) => iso(row.ChargePeriodEnd))
        .filter((d): d is string => d !== null);
      r.recordedStart =
        starts.length === matched.length ? starts.sort()[0] : null;
      r.recordedEnd =
        ends.length === matched.length ? ends.sort().at(-1)! : null;
      r.source = "Cloudflare Billing V1 / ConsumedQuantity";
      r.notes.push(
        "收费行日期只说明已有记录的区间；V1 未提供完整入账水位，不能据此证明其他日期没有用量。",
      );
    }
    r.notes.push("账户总量包含其他项目；已记录消耗不等于金额或可计费超额量。");
    return r;
  });
  const current = resource("r2CurrentBytes", "R2 当前账户实际占用", "bytes");
  current.included = r2Active ? 10 * GB : null;
  current.inclusion = r2Active ? "free" : "unknown";
  current.notes.push(
    "10 GB 为持续整月占用参考；实际免费计量为 10 GB-month，删除不冲回累计计量。",
  );
  resources.unshift(current);
  const byKey = new Map(resources.map((r) => [r.key, r]));
  for (const r of resources) {
    r.display = usageDisplay(r, v1.status, at, period);
    if (r.officialRecorded === null && v1.status.status === "ok")
      r.display.status = "delayed-incomplete";
  }
  const inventories = [
    inventory.summary,
    d1Inventory.summary,
    ...(doInventory ? [doInventory.summary] : []),
  ];
  const analyticsCoverage = new Set<string>();
  if (env.CF_USAGE_API_TOKEN) {
    // Display available 24h analytics even when the billing anchor is unavailable.
    // Without a real period the final admission checks still fail closed.
    const queryPeriod = period || {
      start: new Date(at - DAY).toISOString(),
      end: new Date(at).toISOString(),
    };
    const interval = {
      start: queryPeriod.start,
      end: new Date(at).toISOString(),
    };
    const boundedDatasets: Record<string, string[]> = {
      containersUsageAdaptiveGroups: [
        "cpuTimeSec",
        "allocatedMemory",
        "allocatedDisk",
        "txBytes",
      ],
      durableObjectsInvocationsAdaptiveGroups: ["requests"],
      durableObjectsPeriodicGroups: [
        "duration",
        "rowsRead",
        "rowsWritten",
        "inboundWebsocketMsgCount",
      ],
    };
    const settings = await readApi(
      env,
      "/graphql",
      "GraphQL Containers/DO dataset availability",
      `{viewer{accounts(filter:{accountTag:${JSON.stringify(a)}}){settings{${Object.keys(
        boundedDatasets,
      )
        .map(
          (node) =>
            `${node}{enabled availableFields maxDuration notOlderThan maxPageSize}`,
        )
        .join(" ")}}}}}`,
    );
    sources.push(settings.status);
    // Availability/retention proves that the requested interval is queryable,
    // not that every metric has been ingested through the request's end.
    const intervalQueryable = (node: string): boolean => {
      const limits = record(record(account(settings.body)?.settings)[node]);
      const fields = Array.isArray(limits.availableFields)
        ? limits.availableFields
        : [];
      const maxDuration = number(limits.maxDuration);
      const notOlderThan = number(limits.notOlderThan);
      const maxPageSize = number(limits.maxPageSize);
      return (
        !!period &&
        settings.status.status === "ok" &&
        limits.enabled === true &&
        maxDuration !== null &&
        notOlderThan !== null &&
        maxPageSize !== null &&
        maxPageSize >= LIMIT &&
        at - Date.parse(queryPeriod.start) <= maxDuration * 1000 &&
        at - Date.parse(queryPeriod.start) <= notOlderThan * 1000 &&
        boundedDatasets[node].every((field) => fields.includes(`sum_${field}`))
      );
    };
    let doInvocationBound: ConfidenceBound | null = null;
    let doInboundBound: ConfidenceBound | null = null;
    // Each dataset is isolated so one unavailable product does not erase other evidence.
    const graphResults = await Promise.all(
      GRAPH.map(async (spec) => {
        const confidenceFields =
          spec.node === "r2OperationsAdaptiveGroups"
            ? ["requests"]
            : spec.node === "d1AnalyticsAdaptiveGroups"
              ? ["rowsRead", "rowsWritten"]
              : boundedDatasets[spec.node] || [];
        const confidence = confidenceFields.length
          ? `confidence(level:0.99){sum{${confidenceFields.map((field) => `${field}{estimate lower upper sampleSize isValid}`).join(" ")}}}`
          : "";
        const q = `{viewer{accounts(filter:{accountTag:${JSON.stringify(a)}}){${spec.node}(limit:${LIMIT},filter:{datetime_geq:${JSON.stringify(queryPeriod.start)},datetime_lt:${JSON.stringify(new Date(at).toISOString())}}){${spec.selection} ${confidence}}}}}`;
        return {
          spec,
          result: await readApi(
            env,
            "/graphql",
            `GraphQL ${spec.node}`,
            q,
            interval,
          ),
        };
      }),
    );
    for (const { spec, result } of graphResults) {
      sources.push(result.status);
      const queriedKeys =
        spec.node === "r2OperationsAdaptiveGroups"
          ? ["r2ClassA", "r2ClassB"]
          : spec.amounts.map(([key]) => key);
      for (const key of queriedKeys) {
        const r = byKey.get(key)!;
        r.requestedStart = interval.start;
        r.requestedEnd = interval.end;
      }
      const data = rows(account(result.body)?.[spec.node]);
      result.status.rows = data.length;
      for (const key of queriedKeys)
        byKey.get(key)!.display = usageDisplay(
          byKey.get(key)!,
          result.status,
          at,
          period,
        );
      if (result.status.status !== "ok" || data.length === LIMIT) continue;
      for (const [key, field, factor] of spec.amounts) {
        const r = byKey.get(key)!;
        const total = sumField(data, field);
        if (total !== null) {
          r.display = usageDisplay(
            r,
            result.status,
            at,
            period,
            total * factor,
            "analytics-estimate",
          );
          // Analytics remains an estimate even when an explicit upper bound can support admission.
          r.unbilledEstimate =
            r.officialRecorded === null
              ? total * factor
              : Math.max(0, total * factor - r.officialRecorded);
          r.notes.push(
            `账户分析估计：${spec.node}，读取至 ${new Date(at).toISOString()}；可能有入账延迟或采样。`,
          );
          if (r.officialRecorded === null)
            r.source = `Cloudflare GraphQL ${spec.node}（估计，官方账期数据缺失）`;
          if (
            spec.node === "d1AnalyticsAdaptiveGroups" ||
            (boundedDatasets[spec.node] && intervalQueryable(spec.node))
          ) {
            const bound = confidenceSum(data, field, factor);
            if (
              bound !== null &&
              bound.upper >= total * factor &&
              r.included !== null
            ) {
              r.unbilledEstimate =
                r.officialRecorded === null
                  ? bound.upper
                  : Math.max(0, bound.upper - r.officialRecorded);
              r.confidenceLevel = 0.99;
              r.safetyHeadroom = Math.max(r.included * 0.05, bound.width);
              if (key === "doRequests") doInvocationBound = bound;
              else analyticsCoverage.add(key);
            } else
              r.notes.push(
                "上游置信区间未明确 isValid=true，或数值/样本证据不完整，点估计不能用于准入。",
              );
          }
          if (boundedDatasets[spec.node] && !intervalQueryable(spec.node))
            r.notes.push(
              "数据集可用字段或全账期查询范围未获验证，分析值不能用于准入。",
            );
        }
      }
      if (
        spec.node === "durableObjectsPeriodicGroups" &&
        intervalQueryable(spec.node)
      )
        doInboundBound = confidenceSum(data, "inboundWebsocketMsgCount");
      if (spec.node === "r2OperationsAdaptiveGroups" && data.length) {
        const bound = confidenceSum(data, "requests");
        const total = sumField(data, "requests");
        for (const key of ["r2ClassA", "r2ClassB"]) {
          const r = byKey.get(key)!;
          r.display = usageDisplay(
            r,
            result.status,
            at,
            period,
            total,
            "analytics-estimate",
          );
          r.display.reason =
            "账户全部操作点估计；尚未按 A/B 精确分类，预算分别保守计入两类，不能视作两组独立实际请求。";
          if (bound === null)
            r.notes.push(
              "R2 操作置信区间未明确 isValid=true，或统计证据不完整；不能使用其有限上下界放行上传。",
            );
          if (
            bound !== null &&
            total !== null &&
            bound.upper >= total &&
            r.included !== null
          ) {
            // Count all operations against both classes, conservatively including unknown action types.
            r.unbilledEstimate =
              r.officialRecorded === null
                ? bound.upper
                : Math.max(0, bound.upper - r.officialRecorded);
            r.confidenceLevel = 0.99;
            r.safetyHeadroom = Math.max(r.included * 0.05, bound.width);
            analyticsCoverage.add(key);
            r.notes.push(
              "所有账户 R2 操作的 99% 置信上界分别计入 A/B 两类，避免未知动作漏计；不是精确分类用量。",
            );
          }
        }
      }
    }
    const requests = byKey.get("doRequests")!;
    // Invocation analytics omits messages on non-hibernating WebSockets. Count
    // all periodic inbound messages as full requests, conservatively ignoring
    // the billing-only 20:1 discount and possible overlap with wakeup events.
    if (doInvocationBound && doInboundBound && requests.included !== null) {
      const upper = doInvocationBound.upper + doInboundBound.upper;
      const width = doInvocationBound.width + doInboundBound.width;
      if (Number.isFinite(upper) && Number.isFinite(width)) {
        requests.unbilledEstimate =
          requests.officialRecorded === null
            ? upper
            : Math.max(0, upper - requests.officialRecorded);
        // Two marginal 99% intervals do not form a joint 99% interval.
        requests.confidenceLevel = null;
        requests.safetyHeadroom = Math.max(requests.included * 0.05, width);
        analyticsCoverage.add("doRequests");
        requests.notes.push(
          "调用请求与周期入站 WebSocket 消息各取有效的 99% 上界后相加，消息保守按 1:1 计请求；两项之和没有联合 99% 置信保证。",
        );
      }
    } else {
      requests.unbilledEstimate = null;
      requests.confidenceLevel = null;
      requests.notes.push(
        "请求预算还需有效的周期入站 WebSocket 消息上界，不能只依赖 invocation 请求计数。",
      );
    }
    // Daily coverage belongs to each bucket/class pair; one bucket cannot fill
    // another's missing day. Current snapshots are checked against these keys below.
    const r2CoveredDailyKeys = new Set<string>();
    let r2DailyCoverageValid = false;
    const requiredDates = new Set<string>();
    const firstDay = Date.parse(`${queryPeriod.start.slice(0, 10)}T00:00:00Z`);
    const today = Date.parse(`${interval.end.slice(0, 10)}T00:00:00Z`);
    for (let day = firstDay; day <= today; day += DAY)
      requiredDates.add(new Date(day).toISOString().slice(0, 10));
    for (const spec of [
      {
        node: "r2StorageAdaptiveGroups",
        key: "r2StorageGbMonths",
        dimensions: "bucketName storageClass date",
        field: "payloadSize metadataSize",
        names: ["payloadSize", "metadataSize"],
      },
      {
        node: "d1StorageAdaptiveGroups",
        key: "d1StorageGbMonths",
        dimensions: "databaseId date",
        field: "databaseSizeBytes",
        names: ["databaseSizeBytes"],
      },
      {
        node: "durableObjectsSqlStorageGroups",
        key: "doStorageGbMonths",
        dimensions: "namespaceId date",
        field: "storedBytes",
        names: ["storedBytes"],
      },
    ]) {
      const q = `{viewer{accounts(filter:{accountTag:${JSON.stringify(a)}}){${spec.node}(limit:${LIMIT},filter:{datetime_geq:${JSON.stringify(queryPeriod.start)},datetime_lt:${JSON.stringify(new Date(at).toISOString())}}){dimensions{${spec.dimensions}} max{${spec.field}}}}}}`;
      const result = await readApi(
        env,
        "/graphql",
        `GraphQL ${spec.node} daily peak storage`,
        q,
        interval,
      );
      sources.push(result.status);
      const resource = byKey.get(spec.key)!;
      resource.requestedStart = interval.start;
      resource.requestedEnd = interval.end;
      if (spec.key === "d1StorageGbMonths")
        resource.notes.push(
          d1Inventory.summary.complete
            ? "当前数据库清单已完整分页；当前资源与统计匹配仍不能证明账期内已删除数据库的历史消耗或完整入账水位。"
            : "缺少完整账户数据库清单，逐日观测不能证明没有遗漏数据库；保留观测估计，但不用于存储准入或全部未来占用预测。",
        );
      const data = rows(account(result.body)?.[spec.node]);
      result.status.rows = data.length;
      resource.display = usageDisplay(resource, result.status, at, period);
      if (spec.key === "d1StorageGbMonths" && result.status.status === "ok")
        matchInventory(d1Inventory, data, "databaseId", spec.names, "date", at);
      if (
        spec.key === "doStorageGbMonths" &&
        doInventory &&
        result.status.status === "ok"
      )
        matchInventory(
          doInventory,
          data,
          "namespaceId",
          spec.names,
          "date",
          at,
        );
      if (
        result.status.status !== "ok" ||
        !data.length ||
        data.length === LIMIT
      )
        continue;
      const amounts = data.map((d) =>
        spec.names.map((name) => number(record(d.max)[name])),
      );
      if (amounts.some((values) => values.some((v) => v === null))) continue;
      const total =
        amounts.reduce(
          (sum, values) =>
            sum + values.reduce<number>((a, b) => a + (b || 0), 0),
          0,
        ) /
        GB /
        30;
      if (!Number.isFinite(total)) continue;
      const r = byKey.get(spec.key)!;
      r.display = usageDisplay(
        r,
        result.status,
        at,
        period,
        total,
        "analytics-estimate",
      );
      r.display.status = "delayed-incomplete";
      r.display.reason =
        "已观测逐日峰值折算的 GB-month；当前资源清单不证明完整历史，不能把未出现的资源/日期补零。";
      r.unbilledEstimate =
        r.officialRecorded === null
          ? total
          : Math.max(0, total - r.officialRecorded);
      r.notes.push(
        "分析估计按每日对象/数据库峰值累计计算，采用 30 天计量基线；当前占用与累计计量不同。",
      );
      if (spec.key === "doStorageGbMonths") {
        r.source =
          "Cloudflare GraphQL 已观测 SQL 命名空间逐日峰值（账户完整性未知）";
        r.notes.push(
          "按 namespaceId 分组后累加峰值，避免只取最大命名空间；缺少全量命名空间清单与完整存储证据，当前值仅为已观测范围，不能用于准入或预测全部后续占用。",
        );
      }
      if (spec.key === "d1StorageGbMonths") {
        r.source = "Cloudflare GraphQL 已观测数据库逐日峰值（账户完整性未知）";
      }
      if (spec.key === "r2StorageGbMonths") {
        const datesByKey = new Map<string, Set<string>>();
        let dimensionsValid = true;
        for (const row of data) {
          const dimensions = record(row.dimensions);
          const key = r2StorageKey(dimensions);
          const date = string(dimensions.date);
          if (
            key === null ||
            date === null ||
            !requiredDates.has(date) ||
            string(dimensions.storageClass)?.toLowerCase() !== "standard"
          ) {
            dimensionsValid = false;
            continue;
          }
          const dates = datesByKey.get(key) || new Set<string>();
          dates.add(date);
          datesByKey.set(key, dates);
        }
        for (const [key, dates] of datesByKey)
          if ([...requiredDates].every((date) => dates.has(date)))
            r2CoveredDailyKeys.add(key);
        r2DailyCoverageValid =
          dimensionsValid &&
          datesByKey.size > 0 &&
          r2CoveredDailyKeys.size === datesByKey.size;
        if (!r2DailyCoverageValid)
          r.notes.push(
            "R2 某桶/类别缺少账期内逐日峰值，或维度/类别字段无法确认；其他桶的日期不能填补其历史缺口。",
          );
      }
    }
    const storageQuery = `{viewer{accounts(filter:{accountTag:${JSON.stringify(a)}}){r2StorageAdaptiveGroups(limit:${LIMIT},filter:{datetime_geq:${JSON.stringify(new Date(at - DAY).toISOString())},datetime_lt:${JSON.stringify(new Date(at).toISOString())}},orderBy:[datetime_DESC]){dimensions{bucketName storageClass datetime} max{payloadSize metadataSize objectCount uploadCount}}}}}`;
    const storage = await readApi(
      env,
      "/graphql",
      "GraphQL R2 current storage",
      storageQuery,
      { start: new Date(at - DAY).toISOString(), end: interval.end },
    );
    sources.push(storage.status);
    current.requestedStart = new Date(at - DAY).toISOString();
    current.requestedEnd = interval.end;
    const data = rows(account(storage.body)?.r2StorageAdaptiveGroups);
    storage.status.rows = data.length;
    current.display = usageDisplay(current, storage.status, at, period);
    if (storage.status.status === "ok") {
      const latest = matchInventory(
        inventory,
        data,
        "bucketName",
        ["payloadSize", "metadataSize"],
        "datetime",
        at,
      );
      inventory.summary.newlyCreated = inventory.items.filter((item) => {
        const date = iso(item.creation_date);
        return (
          date !== null &&
          Date.parse(date) >= Date.parse(queryPeriod.start) &&
          Date.parse(date) <= at
        );
      }).length;
      const listedBuckets = new Set(
          inventory.items.map((item) => String(item.name)),
        ),
        bucketClasses = new Map<string, Row[]>();
      for (const row of latest.values()) {
        const name = String(record(row.dimensions).bucketName);
        if (!listedBuckets.has(name)) continue;
        const classes = bucketClasses.get(name) || [];
        classes.push(row);
        bucketClasses.set(name, classes);
      }
      // Count buckets, not storage-class rows. Missing class observations are
      // not zero: both supported classes must explicitly confirm emptiness.
      inventory.summary.emptyConfirmed = [...bucketClasses.values()].filter(
        (classes) => {
          const names = new Set(
            classes.map((row) =>
              String(record(row.dimensions).storageClass).toLowerCase(),
            ),
          );
          return (
            names.size === 2 &&
            names.has("standard") &&
            names.has("infrequentaccess") &&
            classes.every((row) => {
              const max = record(row.max),
                date = iso(record(row.dimensions).datetime);
              return (
                date !== null &&
                Date.parse(date) <= at &&
                at - Date.parse(date) < DAY &&
                [
                  "payloadSize",
                  "metadataSize",
                  "objectCount",
                  "uploadCount",
                ].every((field) => number(max[field]) === 0)
              );
            })
          );
        },
      ).length;
      const pending = [...latest.values()].map((row) =>
        number(record(row.max).uploadCount),
      );
      inventory.summary.pendingMultipartUploads =
        pending.length && pending.every((value) => value !== null)
          ? pending.reduce<number>((sum, value) => sum + value!, 0)
          : null;
    }
    if (storage.status.status !== "ok")
      current.notes.push("R2 当前快照查询失败或不可用，不能确认实际账户占用。");
    else if (data.length === 0)
      current.notes.push("R2 当前快照没有返回记录；空结果不能当作账户零用量。");
    else if (data.length >= LIMIT)
      current.notes.push("R2 当前快照达到查询行数上限，完整性无法确认。");
    if (
      storage.status.status === "ok" &&
      data.length > 0 &&
      data.length < LIMIT
    ) {
      const latest = new Map<string, Row>();
      let currentDimensionsValid = true;
      for (const row of data) {
        const d = record(row.dimensions);
        const key = r2StorageKey(d);
        if (key === null) {
          currentDimensionsValid = false;
          continue;
        }
        if (string(d.storageClass)?.toLowerCase() !== "standard")
          currentDimensionsValid = false;
        if (!latest.has(key)) latest.set(key, row);
      }
      if (!currentDimensionsValid)
        current.notes.push(
          "R2 当前快照的桶/存储类别维度缺失、无效或含非 Standard 类别，不能确认完整账户占用。",
        );
      const sizes = [...latest.values()].map((row) => {
        const max = record(row.max);
        const x = number(max.payloadSize),
          y = number(max.metadataSize);
        return x === null || y === null ? null : x + y;
      });
      if (latest.size > 0 && sizes.every((s) => s !== null)) {
        current.officialRecorded = sizes.reduce<number>(
          (n, s) => n + (s || 0),
          0,
        );
        current.source =
          "Cloudflare GraphQL r2StorageAdaptiveGroups（最新桶快照）";
        current.display = usageDisplay(
          current,
          storage.status,
          at,
          period,
          current.officialRecorded,
          "current-snapshot",
        );
        const dates = [...latest.values()].map((row) =>
          iso(record(row.dimensions).datetime),
        );
        current.coverageStart = queryPeriod.start;
        current.coverageEnd = dates.every((d) => d !== null)
          ? dates.map((d) => d!).sort()[0] || null
          : null;
        const bucketRows = inventory.items;
        const names = bucketRows.map((b) => string(b.name));
        const observed = new Set(
          [...latest.values()].map((row) =>
            string(record(row.dimensions).bucketName),
          ),
        );
        const inventoryComplete =
          inventory.summary.complete &&
          names.length > 0 &&
          names.every((name) => name !== null && observed.has(name));
        const metrics = record(accountStorage.body.result);
        const classAmounts: Record<string, number | null> = {};
        for (const className of ["standard", "infrequentAccess"]) {
          const values = ["published", "uploaded"].flatMap((state) =>
            ["payloadSize", "metadataSize"].map((field) =>
              number(record(record(metrics[className])[state])[field]),
            ),
          );
          classAmounts[className] = values.some((v) => v === null)
            ? null
            : values.reduce<number>((sum, value) => sum + (value || 0), 0);
        }
        const classesKnown =
          accountStorage.status.status === "ok" &&
          classAmounts.standard !== null &&
          classAmounts.infrequentAccess === 0;
        if (classesKnown)
          current.officialRecorded = Math.max(
            current.officialRecorded!,
            classAmounts.standard!,
          );
        current.budgetUsable =
          currentDimensionsValid &&
          inventoryComplete &&
          classesKnown &&
          current.coverageEnd !== null &&
          Date.parse(current.coverageEnd) <= at &&
          at - Date.parse(current.coverageEnd) < DAY;
        if (current.coverageEnd === null)
          current.notes.push(
            "R2 当前快照缺少有效观测时间，无法判断数据是否新鲜。",
          );
        else if (Date.parse(current.coverageEnd) > at)
          current.notes.push("R2 当前快照观测时间位于未来，时间证据无效。");
        else if (at - Date.parse(current.coverageEnd) >= DAY)
          current.notes.push(
            "R2 当前快照已陈旧至少 24 小时，不能据此确认当前账户占用。",
          );
        if (!inventoryComplete)
          current.notes.push(
            "R2 账户桶清单无法完整核验，或某桶缺少新鲜快照；禁止按部分桶数据放行。",
          );
        if (!classesKnown)
          current.notes.push(
            "R2 存储类别无法确认，或存在尚不支持预算核算的 Infrequent Access 占用。",
          );
        const historyCoversCurrent = [...latest.keys()].every((key) =>
          r2CoveredDailyKeys.has(key),
        );
        if (
          current.budgetUsable &&
          r2DailyCoverageValid &&
          historyCoversCurrent
        )
          analyticsCoverage.add("r2StorageGbMonths");
        else if (!historyCoversCurrent)
          byKey
            .get("r2StorageGbMonths")!
            .notes.push(
              "当前桶/类别快照存在未获完整逐日历史覆盖的组合，累计存储预算保持未知。",
            );
      } else
        current.notes.push(
          "R2 当前快照缺少有效桶记录或 payload/metadata 字节数，实际占用无法确认。",
        );
    }
    if (period && current.officialRecorded !== null && current.budgetUsable) {
      byKey.get("r2StorageGbMonths")!.projectedFuture =
        ((current.officialRecorded / GB) *
          Math.ceil((Date.parse(period.end) - at) / DAY)) /
        30;
    }
  }
  // Class totals are independently obtained even if the billing period or
  // GraphQL data is unavailable. They remain display observations, not proof
  // that every bucket/history date or multipart state is covered.
  const classMetrics = record(accountStorage.body.result);
  const bytesFor = (className: string, state: string): number | null => {
    const value = record(record(classMetrics[className])[state]);
    const payload = number(value.payloadSize),
      metadata = number(value.metadataSize);
    return payload === null || metadata === null ? null : payload + metadata;
  };
  inventory.summary.classes = [
    {
      name: "Standard",
      publishedBytes: bytesFor("standard", "published"),
      uploadedBytes: bytesFor("standard", "uploaded"),
    },
    {
      name: "InfrequentAccess",
      publishedBytes: bytesFor("infrequentAccess", "published"),
      uploadedBytes: bytesFor("infrequentAccess", "uploaded"),
    },
  ];
  inventory.summary.classScope = {
    scope: "account",
    basis: "documented-account-metrics",
    complete:
      accountStorage.status.status === "ok" &&
      inventory.summary.classes.every(
        (item) => item.publishedBytes !== null && item.uploadedBytes !== null,
      ),
    status: sourceDisplayStatus(accountStorage.status),
    fetchedAt: accountStorage.status.fetchedAt ?? at,
    reason:
      "官方 /r2/metrics 覆盖账户全部桶，无 jurisdiction 参数；聚合可能延迟，字段完整不等于实时占用、历史完整或入账水位。",
  };
  if (
    accountStorage.status.status === "ok" &&
    (current.display?.value === null || current.display?.value === undefined)
  ) {
    const values = inventory.summary.classes.flatMap((value) => [
      value.publishedBytes,
      value.uploadedBytes,
    ]);
    if (values.every((value) => value !== null)) {
      current.display = usageDisplay(
        current,
        accountStorage.status,
        at,
        period,
        values.reduce<number>((sum, value) => sum + value!, 0),
        "current-snapshot",
      );
      current.display.status = "delayed-incomplete";
      current.display.reason =
        "已取得账户类别合计；桶清单、采集时间及历史完整性仍须独立核实，不能自动补证余额。";
    }
  }
  let storedBytes: number | null = null;
  let reservedBytes = 0;
  const reserved: Amounts = {};
  const priorPeriodUnreconciled: Amounts = {};
  let storageLimitBytes = 10 * GiB;
  let monthlySpendLimitUsd = 0;
  let ledgerValid = true;
  try {
    const settings = await env.DB.prepare(
      "SELECT key,value FROM settings WHERE key IN ('storage_limit_bytes','monthly_spend_limit_usd')",
    ).all<{ key: string; value: string }>();
    for (const s of settings.results || []) {
      const value = Number(s.value);
      if (!Number.isFinite(value) || value < 0)
        throw new Error("invalid_policy");
      if (s.key === "storage_limit_bytes") storageLimitBytes = value;
      else monthlySpendLimitUsd = value;
    }
    const total = await env.DB.prepare(
      "SELECT COALESCE(SUM(bytes),0) AS bytes FROM objects WHERE state='present'",
    ).first<{ bytes: number }>();
    storedBytes = number(total?.bytes);
    if (storedBytes !== null && current.officialRecorded !== null) {
      current.unbilledEstimate = Math.max(
        0,
        storedBytes - current.officialRecorded,
      );
      if (period)
        byKey.get("r2StorageGbMonths")!.projectedFuture =
          (((current.officialRecorded + current.unbilledEstimate) / GB) *
            Math.ceil((Date.parse(period.end) - at) / DAY)) /
          30;
    }
    const uploads = await env.DB.prepare(
      "SELECT COALESCE(SUM(reserved_bytes),0) AS bytes FROM uploads WHERE state NOT IN ('complete','cancelled','expired')",
    ).first<{ bytes: number }>();
    const uploadBytes = number(uploads?.bytes);
    if (uploadBytes === null) throw new Error("upload_ledger_missing");
    reservedBytes = uploadBytes;
    // Keep consumed/stop-unverified reservations until an explicit reconciliation releases them.
    const reservations = await env.DB.prepare(
      "SELECT id,owner_id,kind,state,period_start,amounts_json FROM reservations WHERE kind!='upload_approval' AND state NOT IN ('released','reconciled')",
    ).all<{
      id: string;
      owner_id: string;
      kind: string;
      state: string;
      period_start: string;
      amounts_json: string;
    }>();
    for (const row of reservations.results || []) {
      const amounts = record(JSON.parse(row.amounts_json));
      let stoppedBeforePeriod = false;
      if (row.state === "consumed") {
        const job =
          row.kind === "processing"
            ? await env.DB.prepare(
                "SELECT finished_at,stop_verified FROM jobs WHERE id=?",
              )
                .bind(row.owner_id)
                .first<{ finished_at: number | null; stop_verified: number }>()
            : null;
        const upload =
          row.kind === "upload"
            ? await env.DB.prepare(
                "SELECT state,updated_at FROM uploads WHERE id=?",
              )
                .bind(row.owner_id)
                .first<{ state: string; updated_at: number }>()
            : null;
        const verifiedAt =
          job?.stop_verified === 1
            ? job.finished_at
            : upload &&
                ["complete", "cancelled", "expired"].includes(upload.state)
              ? upload.updated_at
              : null;
        if (verifiedAt !== null && verifiedAt !== undefined) {
          stoppedBeforePeriod =
            !!period && verifiedAt < Date.parse(period.start);
          const coveredAfter = verifiedAt + DAY;
          let changed = false;
          for (const key of Object.keys(amounts)) {
            const r = byKey.get(key);
            const storageKey =
              key === "r2CurrentBytes" || key === "r2StorageGbMonths";
            const cumulative = byKey.get("r2StorageGbMonths")!;
            // Charge-row boundaries and sampled query ranges are not ingestion
            // watermarks. Current APIs expose no complete-through evidence, so
            // consumption stays reserved even when a charge row overlaps a stop.
            const covered =
              row.period_start === period?.start &&
              r?.sourceCompleteThrough != null &&
              r.coverageStart === row.period_start &&
              r.officialRecorded !== null &&
              Date.parse(r.sourceCompleteThrough) >= coveredAfter;
            const storageCovered =
              current.budgetUsable &&
              current.sourceCompleteThrough !== null &&
              Date.parse(current.sourceCompleteThrough) >= coveredAfter &&
              cumulative.sourceCompleteThrough !== null &&
              Date.parse(cumulative.sourceCompleteThrough) >= coveredAfter &&
              cumulative.officialRecorded !== null;
            if (storageKey ? storageCovered : covered) {
              delete amounts[key];
              changed = true;
            }
          }
          if (changed) {
            // Compare the original payload so concurrent UI reads cannot overwrite a newer reservation.
            const updated = await env.DB.prepare(
              "UPDATE reservations SET amounts_json=?,state=? WHERE id=? AND amounts_json=? AND state='consumed'",
            )
              .bind(
                JSON.stringify(amounts),
                Object.keys(amounts).length ? "consumed" : "reconciled",
                row.id,
                row.amounts_json,
              )
              .run();
            if (updated.meta?.changes !== 1) throw new Error("ledger_changed");
          }
        }
      }
      for (const [key, value] of Object.entries(amounts)) {
        const amount = number(value);
        if (amount === null) throw new Error("invalid_reservation");
        if (
          stoppedBeforePeriod &&
          row.period_start !== period?.start &&
          ![
            "r2CurrentBytes",
            "r2StorageGbMonths",
            "d1StorageGbMonths",
            "doStorageGbMonths",
          ].includes(key)
        )
          priorPeriodUnreconciled[key] =
            (priorPeriodUnreconciled[key] || 0) + amount;
        else reserved[key] = (reserved[key] || 0) + amount;
      }
    }
    reservedBytes += reserved.r2CurrentBytes || 0;
  } catch {
    ledgerValid = false;
  }
  for (const r of resources) {
    r.safetyHeadroom = Math.max(r.safetyHeadroom, (r.included || 0) * 0.05);
    r.reserved =
      (reserved[r.key] || 0) +
      (r.key === "r2CurrentBytes"
        ? reservedBytes - (reserved.r2CurrentBytes || 0)
        : 0);
    if (r.key !== "r2CurrentBytes") {
      r.budgetUsable =
        !!period &&
        r.coverageStart === period.start &&
        r.sourceCompleteThrough !== null &&
        Date.parse(r.sourceCompleteThrough) <= at &&
        at - Date.parse(r.sourceCompleteThrough) <= DAY &&
        r.officialRecorded !== null &&
        r.unbilledEstimate !== null;
      if (
        !r.budgetUsable &&
        analyticsCoverage.has(r.key) &&
        r.unbilledEstimate !== null &&
        period &&
        (r.key !== "r2StorageGbMonths" || current.budgetUsable)
      ) {
        r.budgetUsable = true;
        r.remainingIsEstimate = true;
        r.coverageStart = period.start;
        r.coverageEnd = new Date(at).toISOString();
        r.source =
          r.key === "doRequests"
            ? "Cloudflare GraphQL 全账期两项有效 99% 上界之和（无联合 99% 保证）"
            : `Cloudflare GraphQL 全账期${r.confidenceLevel ? " 99% 置信上界" : "逐日峰值保守估计"}`;
        r.notes.push(
          "官方当期完整入账覆盖仍无法确认；预算采用已记录量与全账期分析上界的较大值，余量为估计，不能解读为官方账单余额。",
        );
        r.notes.push(
          "分析请求范围不代表完整入账水位；置信区间不覆盖采集延迟或其他项目后续消耗，不能用于自动释放预留。",
        );
      }
      if (!r.budgetUsable)
        r.notes.push(
          "当前账期覆盖或尚未入账估计无法确认，不能据此启动新增收费工作。",
        );
    }
    if (
      r.included !== null &&
      (r.officialRecorded !== null || r.remainingIsEstimate) &&
      r.budgetUsable
    )
      r.remaining = Math.max(
        0,
        r.included -
          (r.officialRecorded || 0) -
          (r.unbilledEstimate || 0) -
          (r.projectedFuture || 0) -
          r.reserved,
      );
  }
  const available = (keys: string[]) =>
    ledgerValid &&
    storedBytes !== null &&
    !!period &&
    keys.every((key) => {
      const r = byKey.get(key)!;
      return (
        r.budgetUsable &&
        r.included !== null &&
        r.remaining !== null &&
        r.remaining > r.safetyHeadroom
      );
    });
  const blockers: string[] = [];
  if (!env.CF_USAGE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID)
    blockers.push("运行时只读用量凭据尚未配置。");
  if (!period)
    blockers.push("账户实际账期无法确认，或存在多个无法归并的订阅账期。");
  if (!ledgerValid || storedBytes === null)
    blockers.push("项目存储或预算预留账本无法读取。");
  for (const key of PROCESS_KEYS) {
    const r = byKey.get(key)!;
    if (!r.budgetUsable || r.included === null)
      blockers.push(`${r.label}：当前额度和覆盖无法确认。`);
    else if (r.remaining === 0)
      blockers.push(`${r.label}：已没有可确认剩余额度。`);
  }
  const ends = PROCESS_KEYS.map((key) => byKey.get(key)!)
    .map((r) => r.sourceCompleteThrough)
    .filter((end): end is string => end !== null)
    .sort();
  const snapshot: UsageSnapshot = {
    id: id(),
    scope: "all",
    fetchedAt: at,
    expiresAt: at + MAX_AGE,
    periodStart: period?.start || null,
    periodEnd: period?.end || null,
    coverageEnd: ends.length === PROCESS_KEYS.length ? ends[0] : null,
    complete:
      ledgerValid &&
      PROCESS_KEYS.every(
        (key) =>
          byKey.get(key)!.budgetUsable &&
          byKey.get(key)!.included !== null &&
          byKey.get(key)!.sourceCompleteThrough !== null,
      ),
    processingAllowed: available(PROCESS_KEYS),
    storageAllowed: available(STORAGE_KEYS),
    blockers,
    resources,
    inventories,
    policy: { storageLimitBytes, monthlySpendLimitUsd },
    project: { storedBytes, reservedBytes, ledgerValid },
    priorPeriodUnreconciled,
    sources,
    historical: rows(v1.body.result)
      .filter(
        (r) =>
          iso(r.BillingPeriodStart) !== period?.start &&
          number(r.ConsumedQuantity) !== null,
      )
      .map((r) => ({
        periodStart: iso(r.BillingPeriodStart) || "unknown",
        metric: String(r.ServiceName || "unknown"),
        quantity: number(r.ConsumedQuantity)!,
        unit: String(r.ConsumedUnit || r.PricingUnit || "unknown"),
        coverageEnd: iso(r.ChargePeriodEnd),
      })),
    warnings: [
      "其他项目仍可消耗账户额度；账单和分析存在延迟，不承诺绝对零超额。",
      "免费额度和已付套餐包含量分开展示。删除减少后续占用，不抵销已经累计的存储计量。",
      "Workers 播放额外用量已获接受；R2、D1、DO、日志和持续存储费用另行核算。",
    ],
  };
  for (const r of resources) {
    if (r.display) {
      r.display.admissionUnconfirmed = !r.budgetUsable;
      if (
        r.key === "r2CurrentBytes" &&
        !r.budgetUsable &&
        r.display.value !== null
      ) {
        r.display.status = "delayed-incomplete";
        r.display.reason =
          "已观测账户存储；桶/类别匹配、当前采集时间或逐日覆盖仍不完整，不能据此证明自动准入余额。";
      }
    }
  }
  const logsResource = byKey.get("logsEvents")!;
  if (logsResource.officialRecorded === null) {
    logsResource.display = usageDisplay(logsResource, undefined, at, period);
    logsResource.display.reason =
      "当前没有实时日志计量适配；缺少收费行不能解释为日志零用量，需官方面板核验。";
  }
  for (const source of sources)
    source.displayStatus ??= sourceDisplayStatus(source);
  await retainLastDisplay(env, resources, at);
  await env.DB.prepare(
    "INSERT INTO usage_snapshots(id,period_start,period_end,fetched_at,coverage_end,complete,data_json) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(
      snapshot.id,
      snapshot.periodStart,
      snapshot.periodEnd,
      at,
      snapshot.coverageEnd,
      snapshot.complete ? 1 : 0,
      JSON.stringify(snapshot),
    )
    .run();
  return snapshot;
}

function requireAmounts(snapshot: UsageSnapshot, amounts: Amounts): void {
  for (const [key, amount] of Object.entries(amounts)) {
    if (!Number.isFinite(amount) || amount < 0)
      throw new HttpError(400, "invalid_budget", "预算消耗参数无效");
    const r = snapshot.resources.find((r) => r.key === key);
    if (!r?.budgetUsable || r.remaining === null)
      throw new HttpError(
        503,
        "budget_unknown",
        `${r?.label || key}额度无法确认，请在费用面板检查数据覆盖。`,
      );
    // A spend allowance cannot turn missing usage into known usage. Zero-overage admission uses included quantities.
    if (amount > r.remaining - r.safetyHeadroom)
      throw new HttpError(
        409,
        "budget_exceeded",
        `${r.label}包含额度不足（保留至少包含量 5% 或观测置信区间宽度的安全余量）。`,
      );
    r.requested = amount;
  }
}
/** Ordinary upload checks only this configured project, never account billing. */
export async function requireStorageBudget(
  env: Env,
  bytes: number,
): Promise<UsageSnapshot> {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 20 * GiB)
    throw new HttpError(413, "upload_size", "单文件硬上限为 20 GiB");
  const at = Date.now();
  const [policy, objects, uploads, reservations] = await Promise.all([
    env.DB.prepare(
      "SELECT value FROM settings WHERE key='storage_limit_bytes'",
    ).first<{ value: string }>(),
    env.DB.prepare("SELECT bytes FROM objects WHERE state='present'").all<{
      bytes: number;
    }>(),
    env.DB.prepare(
      "SELECT reserved_bytes FROM uploads WHERE state NOT IN ('complete','cancelled','expired')",
    ).all<{ reserved_bytes: number }>(),
    env.DB.prepare(
      "SELECT amounts_json FROM reservations WHERE kind!='upload_approval' AND state NOT IN ('released','reconciled')",
    ).all<{ amounts_json: string }>(),
  ]);
  let storedBytes = 0,
    reservedBytes = 0;
  const storageLimitBytes = Number(policy?.value);
  try {
    if (
      !policy ||
      !Number.isSafeInteger(storageLimitBytes) ||
      storageLimitBytes < 0
    )
      throw new Error("storage_policy");
    const add = (total: number, value: unknown) => {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        !Number.isSafeInteger(total + value)
      )
        throw new Error("storage_ledger");
      return total + value;
    };
    for (const row of objects.results)
      storedBytes = add(storedBytes, row.bytes);
    for (const row of uploads.results)
      reservedBytes = add(reservedBytes, row.reserved_bytes);
    for (const row of reservations.results) {
      const amounts = JSON.parse(row.amounts_json);
      if (!amounts || typeof amounts !== "object" || Array.isArray(amounts))
        throw new Error("storage_reservation");
      if (amounts.r2CurrentBytes !== undefined)
        reservedBytes = add(reservedBytes, amounts.r2CurrentBytes);
    }
  } catch {
    throw new HttpError(
      503,
      "project_storage_unknown",
      "项目空间上限、文件目录或在途预留无法核实，请在存储管理中检查；账户账单不会用于阻止上传",
    );
  }
  const actualBytes = await actualProjectBytes(env).catch((error: unknown) => {
    // This refusal occurs before multipart creation. Keep the project-storage
    // category so clients can safely cancel locally and reselect the file.
    if (error instanceof HttpError && error.code === "budget_unknown")
      throw new HttpError(
        error.status,
        "project_storage_unknown",
        error.message,
        error.details,
      );
    throw error;
  });
  const usedBytes = Math.max(storedBytes, actualBytes);
  if (
    bytes > 0 &&
    (usedBytes > storageLimitBytes ||
      reservedBytes > storageLimitBytes - usedBytes ||
      bytes > storageLimitBytes - usedBytes - reservedBytes)
  )
    throw new HttpError(
      409,
      "storage_limit",
      "原片、已有文件、上传和处理预留加上本文件将超过项目空间上限",
      {
        usedBytes,
        reservedBytes,
        additionalBytes: bytes,
        limitBytes: storageLimitBytes,
      },
    );
  return {
    id: `project-storage-${at}`,
    scope: "upload",
    fetchedAt: at,
    expiresAt: at + MAX_AGE,
    periodStart: null,
    periodEnd: null,
    coverageEnd: null,
    complete: true,
    processingAllowed: false,
    storageAllowed: true,
    blockers: [],
    resources: [],
    policy: { storageLimitBytes, monthlySpendLimitUsd: 0 },
    project: { storedBytes, actualBytes, reservedBytes, ledgerValid: true },
    sources: [],
    priorPeriodUnreconciled: {},
    historical: [],
    warnings: [],
  };
}

export function uploadResourceAmounts(bytes: number): Amounts {
  const parts = Math.ceil(bytes / (8 * 1024 * 1024));
  const modeledAttempts = 3;
  const rowsPerPartAttempt = 8;
  return {
    r2StorageGbMonths: bytes / GB,
    r2ClassA: parts + 3,
    r2ClassB: 2,
    // Each part reads upload/part identities and writes upload_parts plus its
    // composite PK index, then uploads plus uploads_state(expires_at). Allow
    // eight rows per attempt for index maintenance/completion/resume scans,
    // three modeled attempts, and 500 rows for catalog/control work.
    // This is a conservative allowance, not an enforced retry or invoice cap:
    // additional retries, growing directory scans and other traffic add usage.
    d1RowsRead: modeledAttempts * rowsPerPartAttempt * parts + 500,
    d1RowsWritten: modeledAttempts * rowsPerPartAttempt * parts + 500,
    d1StorageGbMonths: (1024 * 1024) / GB,
  };
}

async function actualProjectBytes(env: Env): Promise<number> {
  const seen = new Set<string>(),
    cursors = new Set<string>();
  const deadline = Date.now() + 5000;
  let cursor: string | undefined;
  let bytes = 0;
  for (let page = 0; page < PROJECT_STORAGE_CENSUS_MAX_PAGES; page++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        env.MEDIA.list({ cursor, limit: 1000 }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("storage_timeout")),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
      if (
        !Array.isArray(result.objects) ||
        result.objects.length > 1000 ||
        typeof result.truncated !== "boolean"
      )
        throw new Error("storage_page_unknown");
      for (const object of result.objects) {
        if (
          typeof object.key !== "string" ||
          !object.key ||
          seen.has(object.key) ||
          !Number.isSafeInteger(object.size) ||
          object.size < 0
        )
          throw new Error("storage_object_unknown");
        seen.add(object.key);
        bytes += object.size;
        if (!Number.isSafeInteger(bytes)) throw new Error("storage_overflow");
      }
      if (!result.truncated) return bytes;
      if (
        !result.cursor ||
        cursors.has(result.cursor) ||
        Date.now() >= deadline
      )
        throw new Error("storage_pagination_unknown");
      cursor = result.cursor;
      cursors.add(cursor);
    } catch {
      throw new HttpError(
        503,
        "budget_unknown",
        "项目 R2 文件清单暂时无法完整读取，无法确认项目空间；请检查存储权限或稍后刷新。",
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw new HttpError(
    503,
    "budget_unknown",
    "项目 R2 对象清单超过安全页数，需先核对实际空间。",
  );
}

async function requireProcessingProjectStorage(
  env: Env,
  snapshot: UsageSnapshot,
  bytes: number,
): Promise<void> {
  const { storedBytes, reservedBytes, ledgerValid } = snapshot.project;
  const limit = snapshot.policy.storageLimitBytes;
  if (
    ledgerValid !== true ||
    storedBytes === null ||
    ![storedBytes, reservedBytes, limit].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new HttpError(
      503,
      "budget_unknown",
      "项目存储、预留或硬上限无法核验，不能启动处理",
    );
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new HttpError(409, "quote_changed", "报价产物空间预留无效");
  const check = (stored: number) => {
    if (
      stored > limit ||
      reservedBytes > limit - stored ||
      bytes > limit - stored - reservedBytes
    )
      throw new HttpError(
        409,
        "storage_limit",
        "实际原片、已有产物、在途预留与报价空间超过项目存储上限",
      );
  };
  check(storedBytes);
  // Reuse the bounded census of this configured project bucket, including
  // unregistered objects. It is not an account-wide external-write lock.
  const actual = await actualProjectBytes(env);
  snapshot.project.actualBytes = actual;
  check(Math.max(actual, storedBytes));
}

export const INSTANCES: ContainerInstance[] = [
  { name: "standard-1", vcpu: 0.5, memoryBytes: 4 * GiB, diskBytes: 8 * GB },
  { name: "standard-2", vcpu: 1, memoryBytes: 6 * GiB, diskBytes: 12 * GB },
  { name: "standard-3", vcpu: 2, memoryBytes: 8 * GiB, diskBytes: 16 * GB },
  { name: "standard-4", vcpu: 4, memoryBytes: 12 * GiB, diskBytes: 20 * GB },
];
async function verifyCapacity(
  env: Env,
  instance: ContainerInstance,
): Promise<QuoteDraft["accountCapacity"]> {
  const result = await api(
    env,
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID || "unconfigured"}/containers/me`,
    "Containers account capacity",
  );
  const limits = record(record(result.body.result).limits);
  const vcpu = number(limits.vcpu_per_deployment),
    memoryMib = number(limits.memory_mib_per_deployment),
    diskMb = number(limits.disk_mb_per_deployment);
  if (
    result.status.status !== "ok" ||
    vcpu === null ||
    memoryMib === null ||
    diskMb === null
  )
    throw new HttpError(
      503,
      "capacity_unknown",
      "账户当前 Container 规格和容量上限无法确认。",
    );
  if (
    instance.vcpu > vcpu ||
    instance.memoryBytes > memoryMib * 1024 * 1024 ||
    instance.diskBytes > diskMb * 1e6
  )
    throw new HttpError(
      409,
      "processing_resources",
      "报价规格超过账户当前支持的 Container 上限。",
    );
  return {
    vcpu,
    memoryBytes: memoryMib * 1024 * 1024,
    diskBytes: diskMb * 1e6,
    checkedAt: Date.now(),
  };
}
async function sourceHead(env: Env, video: Video): Promise<R2Object> {
  if (!video.source_key || !video.source_etag)
    throw new HttpError(409, "source_missing", "原片尚未完成或已经删除");
  const head = await env.MEDIA.head(video.source_key);
  if (
    !head ||
    head.size !== video.source_size ||
    head.etag !== video.source_etag
  )
    throw new HttpError(
      409,
      "source_changed",
      "原片对象或版本已变化，需要重新核对",
    );
  return head;
}
// Official limits footnote 4, verified 2026-10-14: single upload is 5 GiB - 5 MiB.
// https://developers.cloudflare.com/r2/platform/limits/
export const R2_SINGLE_PUT_MAX_BYTES = 5 * GiB - 5 * 1024 ** 2;
const OUTPUT_UPLOAD_ATTEMPTS = 3;
export function processingOutputBounds(
  sourceBytes: number,
  mode: QuoteDraft["mode"],
  quality: QuoteDraft["quality"],
  duration: number | null,
): Pick<
  QuoteDraft,
  | "maxOutputBytes"
  | "maxMediaObjects"
  | "outputKind"
  | "outputName"
  | "encoding"
  | "maxUploadAttempts"
> {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes <= 0)
    throw new HttpError(409, "source_changed", "原片字节范围无效");
  if (mode !== "transcode" && quality !== "source")
    throw new HttpError(400, "invalid_processing", "无损处理必须保留原片画质");
  if (
    mode === "transcode" &&
    (!duration || !Number.isFinite(duration) || duration <= 0)
  )
    throw new HttpError(409, "probe_required", "转码需要可信时长");
  if (mode === "faststart" && sourceBytes > R2_SINGLE_PUT_MAX_BYTES)
    throw new HttpError(
      409,
      "processing_single_put_limit",
      "原片超过当前单次 R2 PUT 实际上限，不能使用单对象 MP4 优化；原片上传上限不变。需先实现独立确认的 multipart 产物传输方案。",
    );
  const maxOutputBytes =
    mode === "transcode"
      ? Math.ceil(
          Math.max(
            sourceBytes,
            (duration! *
              ((quality === "720p" ? 5e6 : quality === "1080p" ? 10e6 : 20e6) +
                256000)) /
              8,
          ) * 1.15,
        )
      : mode === "faststart"
        ? Math.min(Math.ceil(sourceBytes * 2), R2_SINGLE_PUT_MAX_BYTES)
        : Math.ceil(sourceBytes * 2);
  const maxMediaObjects =
    mode === "faststart" ? 1 : duration ? Math.ceil(duration / 6) + 32 : 10000;
  if (maxMediaObjects > 10000)
    throw new HttpError(
      409,
      "processing_resources",
      "预计 HLS 对象数量超出本任务受控上限",
    );
  return {
    maxOutputBytes,
    maxMediaObjects,
    maxUploadAttempts: OUTPUT_UPLOAD_ATTEMPTS,
    outputKind: mode === "faststart" ? "mp4" : "hls",
    outputName: mode === "faststart" ? "optimized.mp4" : "index.m3u8",
    encoding: mode === "transcode" ? "h264-aac" : "copy-only",
  };
}
export function processingResourceAmounts(
  instance: ContainerInstance,
  bounds: Pick<
    QuoteDraft,
    "mode" | "maxOutputBytes" | "maxMediaObjects" | "totalTimeoutSeconds"
  >,
): Amounts {
  const { mode, maxOutputBytes, maxMediaObjects, totalTimeoutSeconds } = bounds;
  if (
    !Number.isSafeInteger(maxMediaObjects) ||
    maxMediaObjects < (mode === "faststart" ? 1 : 2) ||
    maxMediaObjects > 10000 ||
    (mode === "faststart" && maxMediaObjects !== 1) ||
    !Number.isSafeInteger(totalTimeoutSeconds) ||
    totalTimeoutSeconds < 60 ||
    totalTimeoutSeconds > 21600
  )
    throw new HttpError(400, "invalid_budget", "处理对象数量或总时限无效");
  const eventBound = Math.ceil(totalTimeoutSeconds / 1.5) + 100;
  const alarmBound = Math.ceil(totalTimeoutSeconds / 5) + 100;
  const uploadRequests = maxMediaObjects * OUTPUT_UPLOAD_ATTEMPTS;
  // Progress bodies are limited to 64 KiB. Fixed allowance covers probe/completion
  // reports and startup/control traffic; each PUT also reserves 4 KiB of headers.
  // This transport model is conservative, not a physical network/bill hard cap.
  const controlEgressBytes =
    eventBound * 64 * 1024 + uploadRequests * 4096 + 8 * 1024 ** 2;
  // Completion and publication each inspect at most 128 top-level boxes (up to
  // two range reads per header), bounded payload reads and a final identity HEAD.
  const structureReads = mode === "faststart" ? 2 * (128 * 2 + 4 + 1) : 0;
  // TaskBridge checks SUM(bytes) and COUNT(*) across this version before each
  // output PUT, including retries. Budget both scans over all M objects for
  // all three attempts, with two row/index accesses per scan. Linear reads
  // cover context, conflict lookup and completion; two object writes per
  // attempt include the table, primary-key and version/state indexes.
  // These are conservative modeled row quantities, not SQLite VM steps or
  // exact Cloudflare metering. M<=10,000 keeps every row bound a safe integer.
  const outputRowsRead =
    OUTPUT_UPLOAD_ATTEMPTS * (4 * maxMediaObjects ** 2 + 16 * maxMediaObjects);
  const outputRowsWritten = OUTPUT_UPLOAD_ATTEMPTS * 8 * maxMediaObjects;
  return {
    containerCpuSeconds: instance.vcpu * totalTimeoutSeconds,
    containerMemoryByteSeconds: instance.memoryBytes * totalTimeoutSeconds,
    containerDiskByteSeconds: instance.diskBytes * totalTimeoutSeconds,
    containerEgressBytes:
      maxOutputBytes * OUTPUT_UPLOAD_ATTEMPTS + controlEgressBytes,
    r2CurrentBytes: maxOutputBytes,
    r2StorageGbMonths: maxOutputBytes / GB,
    r2ClassA:
      uploadRequests +
      2 * Math.ceil(maxMediaObjects / 1000) +
      // The quote and its confirmation each census at most 100 project pages.
      2 * PROJECT_STORAGE_CENSUS_MAX_PAGES +
      10,
    r2ClassB: uploadRequests + structureReads + 10,
    d1RowsRead: outputRowsRead + eventBound * 8 + alarmBound * 4 + 10000,
    d1RowsWritten: outputRowsWritten + eventBound * 4 + 10000,
    d1StorageGbMonths: (maxMediaObjects * 4096 + 20e6) / GB,
    doRequests: alarmBound * 3 + eventBound + uploadRequests + 1000,
    doDurationGbSeconds: totalTimeoutSeconds * 0.128 * 2,
    doRowsRead: alarmBound * 4 + 1000,
    doRowsWritten: alarmBound * 4 + 1000,
    doStorageGbMonths: (64 * 1024 * 1024) / GB,
  };
}
export async function quoteProcessing(
  env: Env,
  video: Video,
  options: { mode: unknown; quality: unknown; manualEvidenceIds?: unknown },
): Promise<QuoteDraft> {
  if (options.manualEvidenceIds !== undefined)
    throw new HttpError(
      409,
      "quote_changed",
      "人工填报流程已停用，请刷新页面并重新生成报价",
    );
  const mode =
    options.mode === "transcode"
      ? "transcode"
      : options.mode === "probe-remux"
        ? "probe-remux"
        : options.mode === "faststart"
          ? "faststart"
          : null;
  const quality =
    options.quality === "source" ||
    options.quality === "1080p" ||
    options.quality === "720p"
      ? options.quality
      : null;
  if (!mode || !quality || (mode !== "transcode" && quality !== "source"))
    throw new HttpError(400, "invalid_processing", "处理方式或画质无效");
  await sourceHead(env, video);
  const probe = video.probe_json ? record(JSON.parse(video.probe_json)) : {};
  const duration = number(probe.durationSeconds);
  const width = number(probe.width);
  const height = number(probe.height);
  if (mode === "transcode" && (!duration || !width || !height))
    throw new HttpError(
      409,
      "probe_required",
      "先确认探测任务并保存可信时长、分辨率和音轨信息",
    );
  if (
    mode === "transcode" &&
    ((quality === "1080p" && height! < 1080) ||
      (quality === "720p" && height! < 720))
  )
    throw new HttpError(409, "upscale_denied", "原片分辨率不足，不能默认放大");
  const timeoutRow = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='task_timeout_seconds'",
  ).first<{ value: string }>();
  const totalTimeoutSeconds = Number(timeoutRow?.value || 1800);
  if (
    !Number.isSafeInteger(totalTimeoutSeconds) ||
    totalTimeoutSeconds < 60 ||
    totalTimeoutSeconds > 21600
  )
    throw new HttpError(503, "invalid_timeout", "总任务时限配置无效");
  const output = processingOutputBounds(
    video.source_size,
    mode,
    quality,
    duration,
  );
  const { maxOutputBytes, maxMediaObjects } = output;
  const diskNeeded = video.source_size + maxOutputBytes + 2 * GB; // Image/programs + temporary overhead; disk is decimal GB.
  const minimumMemory = Math.max(
    mode === "transcode" ? 6 * GiB : 4 * GiB,
    width && height ? Math.ceil(width * height * 48) : 0,
  );
  const instance = INSTANCES.find(
    (i) =>
      i.diskBytes >= diskNeeded &&
      i.memoryBytes >= minimumMemory &&
      (mode !== "transcode" || i.vcpu >= 1),
  );
  if (!instance)
    throw new HttpError(
      409,
      "processing_resources",
      "原片可上传，但输入、输出、镜像、临时空间或内存超过当前支持规格；不能自动升配。",
    );
  const accountCapacity = await verifyCapacity(env, instance);
  const snapshot = await getUsage(env);
  await requireProcessingProjectStorage(env, snapshot, maxOutputBytes);
  const crossesPeriod =
    !!snapshot.periodEnd &&
    Date.now() + totalTimeoutSeconds * 1000 >= Date.parse(snapshot.periodEnd);
  const resourceAmounts = processingResourceAmounts(instance, {
    mode,
    maxOutputBytes,
    maxMediaObjects,
    totalTimeoutSeconds,
  });
  // Viewing an estimate is separate from execution authorization. Missing
  // account coverage never requires an administrator to transcribe metrics.
  const executionBlockers: string[] = [];
  const unconfirmed = PROCESS_KEYS.filter((key) => {
    const resource = snapshot.resources.find((item) => item.key === key);
    return (
      !resource?.budgetUsable ||
      resource.included === null ||
      resource.remaining === null
    );
  });
  if (!snapshot.periodStart || !snapshot.periodEnd || unconfirmed.length)
    executionBlockers.push(
      "当前费用政策只允许已核实的套餐包含额度内处理。账户接口不能证明本任务全部在包含额度内，启动可能产生尚未授权的额外费用。",
    );
  else {
    try {
      requireAmounts(snapshot, resourceAmounts);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      executionBlockers.push(error.message);
    }
  }
  if (crossesPeriod)
    executionBlockers.push("任务可能跨账期，请在新账期重新报价");
  // Gross marginal ceiling before included quantities; R2 rounds up billable units.
  const costUpperUsd =
    resourceAmounts.containerCpuSeconds * 0.00002 +
    (resourceAmounts.containerMemoryByteSeconds / GiB) * 0.0000025 +
    (resourceAmounts.containerDiskByteSeconds / GB) * 0.00000007 +
    (resourceAmounts.containerEgressBytes / GB) * 0.05 +
    Math.ceil(resourceAmounts.r2StorageGbMonths) * 0.015 +
    Math.ceil(resourceAmounts.r2ClassA / 1e6) * 4.5 +
    Math.ceil(resourceAmounts.r2ClassB / 1e6) * 0.36 +
    ((resourceAmounts.d1RowsRead + resourceAmounts.doRowsRead) / 1e6) * 0.001 +
    (resourceAmounts.d1RowsWritten + resourceAmounts.doRowsWritten) / 1e6 +
    Math.ceil(resourceAmounts.doRequests / 1e6) * 0.15 +
    Math.ceil(resourceAmounts.doDurationGbSeconds / 1e6) * 12.5 +
    resourceAmounts.d1StorageGbMonths * 0.75 +
    resourceAmounts.doStorageGbMonths * 0.2;
  return {
    executionAllowed: executionBlockers.length === 0,
    executionBlockers,
    approvalPolicyVersion: 3,
    feePolicy: "verified-included-only",
    executionNextStep: executionBlockers.length
      ? crossesPeriod
        ? "任务最长时限可能跨账期，请在新账期重新获取报价。"
        : "如需执行，请另行明确批准这一个任务的处理方式、规格、最长运行时间及下列费用估算风险。开启处理开关或勾选本弹窗不会自动扩大费用政策；无需手工抄录账户账单。费用政策获准后必须重新报价。"
      : "核对下列范围并确认后，仅启动这一个任务；不会自动转码、升配或延长时间。",
    snapshotId: snapshot.id,
    periodStart: snapshot.periodStart || "unconfirmed",
    instance,
    accountCapacity,
    mode,
    quality,
    sourceRevision: video.source_revision,
    sourceEtag: video.source_etag!,
    sourceKey: video.source_key!,
    sourceBytes: video.source_size,
    ...output,
    totalTimeoutSeconds,
    costUpperUsd: Math.ceil(costUpperUsd * 10000) / 10000,
    costBreakdown: [
      {
        key: "container",
        label: "视频处理计算与传输",
        upperUsd:
          resourceAmounts.containerCpuSeconds * 0.00002 +
          (resourceAmounts.containerMemoryByteSeconds / GiB) * 0.0000025 +
          (resourceAmounts.containerDiskByteSeconds / GB) * 0.00000007 +
          (resourceAmounts.containerEgressBytes / GB) * 0.05,
        billingRule: "按本报价规格及最长运行时间估算",
      },
      {
        key: "r2-operations",
        label: "文件读写操作",
        upperUsd:
          Math.ceil(resourceAmounts.r2ClassA / 1e6) * 4.5 +
          Math.ceil(resourceAmounts.r2ClassB / 1e6) * 0.36,
        billingRule: "R2 读、写分别按百万次计费单位向上取整",
      },
      {
        key: "r2-storage",
        label: "新增文件持续存储",
        upperUsd: Math.ceil(resourceAmounts.r2StorageGbMonths) * 0.015,
        billingRule: "按一个月产物上限占用，以 GB·月计费单位向上取整",
      },
      {
        key: "coordination-duration",
        label: "任务协调运行时间",
        upperUsd: Math.ceil(resourceAmounts.doDurationGbSeconds / 1e6) * 12.5,
        billingRule: "Durable Objects 超额运行量按百万 GB·秒计费单位向上取整",
      },
      {
        key: "coordination-requests",
        label: "任务协调请求",
        upperUsd: Math.ceil(resourceAmounts.doRequests / 1e6) * 0.15,
        billingRule: "Durable Objects 超额请求按百万次计费单位向上取整",
      },
      {
        key: "database",
        label: "任务记录读写与存储",
        upperUsd:
          ((resourceAmounts.d1RowsRead + resourceAmounts.doRowsRead) / 1e6) *
            0.001 +
          (resourceAmounts.d1RowsWritten + resourceAmounts.doRowsWritten) /
            1e6 +
          resourceAmounts.d1StorageGbMonths * 0.75 +
          resourceAmounts.doStorageGbMonths * 0.2,
        billingRule: "按本报价的数据库读写及存储资源上界估算",
      },
    ],
    resourceAmounts,
    expiresAt: Math.min(
      Date.now() + MAX_AGE,
      snapshot.periodEnd && !crossesPeriod
        ? Date.parse(snapshot.periodEnd) - totalTimeoutSeconds * 1000
        : Infinity,
    ),
    codec:
      mode !== "transcode"
        ? "兼容时复制视频与音频编码；不兼容则停止，重新报价"
        : "H.264 / CRF 23 / yuv420p / capped bitrate",
    audio:
      mode !== "transcode"
        ? "仅兼容音轨无损复制；额外音轨、字幕、HDR 必须明确复核"
        : "AAC 192 kbps；多音轨、字幕、HDR 检测后需明确确认，不能静默丢弃",
    estimatedSeconds: null,
    warnings: [
      ...executionBlockers,
      ...(mode === "faststart"
        ? [
            "仅在本次已确认任务内探测 MP4；兼容时复制编码优化索引，不兼容则停止等待重新确认。唯一产物 optimized.mp4，不自动转码或发布。",
            `单对象输出上限 ${maxOutputBytes} 字节，受 R2 单次 PUT 实际上限约束；超限停止，不能自动扩大范围或切换 multipart。`,
          ]
        : []),
      "运行时间范围包括启动、下载、探测、处理、上传、校验与核实停止。无法预知可信耗时下界。",
      "费用范围为 0 至下列保守估算上界，按包含额度全部耗尽及适用取整计算；既有套餐固定费用另计。当前执行政策只允许已核实包含额度内任务；未知账户数据不会被视为零消耗。",
      "费用估算以在确认的总时限内核实物理停止为前提；平台停止延迟可能超过估算，未核实停止继续保留预留并告警，不承诺硬支付封顶。",
      "仅本报价指定规格与单套画质有效；超出范围立即停止后再次确认。",
    ],
  };
}
export async function validateQuoteBudget(
  env: Env,
  quote: Quote,
): Promise<UsageSnapshot> {
  if (quote.expires_at <= Date.now() || quote.state !== "open")
    throw new HttpError(
      409,
      "quote_expired",
      "报价已过期或已经使用，请重新报价",
    );
  const draft = record(JSON.parse(quote.data_json));
  if (draft.manualEvidenceIds !== undefined || draft.manualBudget !== undefined)
    throw new HttpError(
      409,
      "quote_changed",
      "旧人工核验报价已停用，请重新生成报价；不会沿用或扩大旧授权",
    );
  if (draft.executionAllowed === false)
    throw new HttpError(
      409,
      "quote_requires_review",
      "本任务尚未获准承担包含额度外的费用风险。请先针对本任务明确费用政策，再重新获取报价；无需人工填报账户用量。",
    );
  if (
    draft.sourceRevision !== quote.source_revision ||
    draft.sourceEtag !== quote.source_etag ||
    draft.periodStart !== quote.period_start
  )
    throw new HttpError(409, "quote_changed", "报价绑定数据不一致");
  const video = await env.DB.prepare("SELECT * FROM videos WHERE id=?")
    .bind(quote.video_id)
    .first<Video>();
  if (
    !video ||
    video.source_revision !== quote.source_revision ||
    video.source_etag !== quote.source_etag
  )
    throw new HttpError(409, "source_changed", "原片版本已变化");
  if (
    quote.mode === "faststart" &&
    (draft.mode !== "faststart" ||
      quote.quality !== "source" ||
      draft.quality !== "source" ||
      draft.sourceKey !== video.source_key ||
      draft.sourceBytes !== video.source_size ||
      draft.outputKind !== "mp4" ||
      draft.outputName !== "optimized.mp4" ||
      draft.encoding !== "copy-only" ||
      draft.maxMediaObjects !== 1 ||
      draft.maxUploadAttempts !== OUTPUT_UPLOAD_ATTEMPTS ||
      !Number.isSafeInteger(draft.maxOutputBytes) ||
      Number(draft.maxOutputBytes) <= 0 ||
      Number(draft.maxOutputBytes) > R2_SINGLE_PUT_MAX_BYTES ||
      video.source_size > R2_SINGLE_PUT_MAX_BYTES)
  )
    throw new HttpError(
      409,
      "quote_changed",
      "MP4 优化报价身份、单对象范围或无损复制规格无效，请重新报价",
    );
  await sourceHead(env, video);
  const quotedInstance = record(draft.instance);
  const instance = INSTANCES.find(
    (i) =>
      i.name === quotedInstance.name &&
      i.vcpu === quotedInstance.vcpu &&
      i.memoryBytes === quotedInstance.memoryBytes &&
      i.diskBytes === quotedInstance.diskBytes,
  );
  if (!instance) throw new HttpError(409, "quote_changed", "报价规格无效");
  const mode =
    quote.mode === "faststart" ||
    quote.mode === "probe-remux" ||
    quote.mode === "transcode"
      ? quote.mode
      : null;
  const timeout = number(draft.totalTimeoutSeconds);
  const outputBytes = number(draft.maxOutputBytes);
  // Older HLS tasks already used the same 10,000-object default when omitted.
  const objects = number(draft.maxMediaObjects ?? 10000);
  if (
    !mode ||
    (draft.mode !== undefined && draft.mode !== mode) ||
    timeout === null ||
    !Number.isSafeInteger(timeout) ||
    timeout < 60 ||
    timeout > 21600 ||
    outputBytes === null ||
    !Number.isSafeInteger(outputBytes) ||
    outputBytes <= 0 ||
    objects === null ||
    !Number.isSafeInteger(objects) ||
    objects < (mode === "faststart" ? 1 : 2) ||
    objects > 10000 ||
    (draft.maxUploadAttempts !== undefined &&
      draft.maxUploadAttempts !== OUTPUT_UPLOAD_ATTEMPTS)
  )
    throw new HttpError(
      409,
      "quote_changed",
      "报价处理范围或总时限无效，请重新报价",
    );
  const minimum = processingResourceAmounts(instance, {
    mode,
    maxOutputBytes: outputBytes,
    maxMediaObjects: objects,
    totalTimeoutSeconds: timeout,
  });
  const quoted = record(draft.resourceAmounts);
  // A deployment may raise resource bounds while an older quote is still open.
  // Reject under-reserved scopes; never silently enlarge the approved amounts.
  // Sufficient legacy HLS quotes do not need the newly introduced identity fields.
  if (
    Object.entries(minimum).some(
      ([key, value]) => (number(quoted[key]) ?? -1) < value,
    )
  )
    throw new HttpError(
      409,
      "quote_changed",
      "报价资源预留低于当前处理要求，请重新报价",
    );
  const amounts = record(draft.resourceAmounts);
  const safe: Amounts = {};
  for (const [key, value] of Object.entries(amounts)) {
    const amount = number(value);
    if (amount === null)
      throw new HttpError(409, "quote_changed", "报价资源数据无效");
    safe[key] = amount;
  }
  if (!Object.keys(safe).length)
    throw new HttpError(409, "quote_changed", "报价缺少预算资源");
  await verifyCapacity(env, instance);
  const snapshot = await getUsage(env);
  // Admission inserts these exact quoted amounts. A sufficient legacy quote
  // may reserve more storage than maxOutputBytes; never silently shrink it.
  await requireProcessingProjectStorage(env, snapshot, safe.r2CurrentBytes);
  if (
    !snapshot.periodStart ||
    !snapshot.periodEnd ||
    snapshot.periodStart !== quote.period_start
  )
    throw new HttpError(
      503,
      "budget_unknown",
      "当前费用数据不完整或已跨账期，不能启动处理",
    );
  if (!snapshot.processingAllowed)
    throw new HttpError(
      503,
      "budget_unknown",
      "当前费用数据不完整，不能启动处理",
    );
  requireAmounts(snapshot, safe);
  return snapshot;
}
