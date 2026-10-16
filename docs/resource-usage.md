# 自动资源用量 / Automatic resource usage

[项目首页](../README.md) · [中文](#中文) · [English](#english) · [费用](budget.md) · [使用手册](user-guide.md)

## 中文

后台“资源用量”（`/admin/usage`）显示**当前环境的项目资源**，与“播放统计”分开。官方请求量不等于播放次数，项目用量不等于全账户剩余额度。不要求管理员抄录 Cloudflare 数值、账期、完整性或证据 ID。

### 三种时间范围

| 范围 | 含义与缺口 |
| --- | --- |
| 近24小时 | 滚动 24 小时官方分析，不是今天零点以来；查询失败可保留上次成功值，原查询起止/观测时间不刷新伪装 |
| 本账期 | 来自官方 `billable-usage/info` 有效订阅锚点，保留 UTC 时分秒并处理月底；多个不一致周期不合并。未知时明确提示，不能替换成自然月 |
| 累计 | 仅已保存的不重叠官方日窗口和可归属任务记录；每字段有覆盖起点/缺口，未采集和空返回不补零，不冒充整个生命周期 |

页面时间显示 Asia/Singapore。当前对象大小、数量、现存视频/版本和保留日志是**当前状态**，不随范围累加，不把每日大小快照相加成累计空间。

本账期按字段优先采用同一实际周期最后成功的整段官方查询。缺字段时可回退到本项目已保存日窗口，标“本账期已记录用量”，列明原时间及缺口；两种来源不相加。非 UTC 零点开始的账期无法精确拆分首日日桶，因此排除该桶并明确边界缺口，不按日内平均估算。最后成功值仍保留未覆盖尾段和陈旧标识。

### 自动来源与单位

| 资源 | 项目范围/来源 | 如何解释 |
| --- | --- | --- |
| Workers | `workersInvocationsAdaptive`，限定 `scriptName` | 请求、错误和 CPU；`sum.cpuTimeUs` 微秒转毫秒，不由延迟分位数推算 |
| R2 | 按 `bucketName` 的操作、按桶/类别的最新存储观测；项目对象账本另列 | 原片、产物、品牌当前占用和实际上传/处理预留分开；字节大小不是 GB-month |
| D1 | 指定数据库元数据 `file_size` 和 `databaseId` 分析 | 查询次数、读写行数及当前大小分别显示，不能互换 |
| Durable Objects | 显式配置的本项目命名空间 | 请求、周期 GB·秒、SQLite 读写及存储；不混入其他命名空间 |
| Containers | `containersUsageAdaptiveGroups`，限定 `applicationId` | CPU vCPU·秒；内存 byte-seconds ÷ 1024³ 为 GiB·秒；磁盘 ÷ 10⁹ 为 GB·秒；出口为字节 |
| Builds | 指定 Worker tag，最多 5 页 × 100 条，稳定 UUID 去重 | 已采集的构建状态及经过时间；排队/部署时长不是官方计费 Build minutes，不承诺所有历史可恢复 |
| 日志 | 当前 D1 应用日志、错误数及最早保留时间 | 当前保留状态，随清理变化；不是平台 Observability 计费日志累计 |

`RESOURCE_WORKER_NAME`、`RESOURCE_D1_DATABASE_ID`、`RESOURCE_R2_BUCKET`、`RESOURCE_DO_NAMESPACES`、`RESOURCE_CONTAINER_APPLICATION_ID`、`RESOURCE_WORKER_TAG` 指定项目范围，不是秘密；完整部署解析器从自有绑定生成，亦可在私有配置中明确提供。首次 bootstrap Worker 没有 DO/Container 身份时这些指标可能缺失；不能将缺项记为零，后续正常部署读取已存在绑定补全。错误或省略这些配置会造成统计缺口，不授权读取其他项目。

### 持久化与采集成本

每分钟 Cron 中按小时推进 `collectResourceUsage()`，无需打开页面。首次读取可初始化；主动刷新最短间隔 30 秒。正常页面读取已有快照，并由 `waitUntil` 刷新；D1 租约协调多实例。采集用只读 API 和 D1，不扫描整个 R2、不唤醒 DO、不启动 Container，不给每个媒体请求/Range/分片增加资源统计写入。

| 数据表 | 保存内容 |
| --- | --- |
| `resource_usage_state` | 租约、采集时间、已验证账期规则及历史补采游标 |
| `resource_usage_latest` | 滚动/账期成功快照；失败保留原值、原时间并更新诊断 |
| `resource_usage_daily` | 资源和 UTC 日日窗口覆盖写，重复采集及迟到修正不重复累计 |
| `resource_usage_jobs` | 可归属且停止核实的任务容量时间，不随视频/任务详情删除 |
| `resource_usage_builds` | Worker 构建 UUID/时间/状态，翻页去重 |

每轮复查当前日和前一日，并轮巡补采最近 31 天一个较早日期；上游权限/保留期不足只记录成功范围。默认两个 DO 命名空间及最多五页 Builds 时，每轮最多 50 个外部 API 请求；通常每小时写几十个资源汇总/快照，失败不写假零。超过 31 天的已保存日汇总保留，但不承诺上游仍可修正。

近24小时不读永久日历史；本账期使用 `(scope, day_start)` 索引限定范围；累计才汇总保存窗口，读取成本随日窗口增长。资源账本不随普通日志清理、页面刷新、Worker 重启或部署归零。项目范围身份由环境/资源构成，凭据轮换/提交变化不改变它；资源迁移使用新范围，旧记录不混入。

### 估算、空值和失败

有官方 Container 字段时优先使用，**不与任务估算相加**。官方缺字段可使用已保存、已核实停止、有可靠结束/墙钟时间、可归属本任务的 CPU/内存/磁盘容量时间上界；按任务与窗口交集比例分摊。它们不是实际 CPU、峰值容量或最终收费，运行中和未知归属不推断为确定值。后续证明失效时保存旧值和失效标识，移出确定估算。

`ok-data` 表示有观测，不等于 `budgetUsable`；`ok-empty` 是请求成功但无记录，保持 `null`。权限、暂时失败、截断、缺字段、未适配与不完整范围分别诊断。last-good 保留原观测时间/范围，不能恢复账户预算或执行许可。官方分析也可能采样/迟到，连续保存的日窗口不证明完整账单。

资源页只展示，不授予处理费用许可；普通上传按项目空间判断，处理仍按[预算政策](budget.md#中文)单独准入。不保存上游原始计量以外的响应、认证头、付款信息、构建环境变量或其他项目资源名称/ID。

## English

Resource Usage at `/admin/usage` describes **this environment's project resources**, separately from Playback Analytics. Requests are not plays and project usage is not remaining account allowance. No manual Cloudflare transcription, period review or evidence-ID form is required.

### Time ranges

| Range | Meaning |
| --- | --- |
| Rolling 24 hours | Official rolling analysis, not midnight-to-now; last-good values retain the original query/observation time |
| Billing period | Validated official subscription anchor from `billable-usage/info`, including UTC time/month-end behavior; conflicting cycles stay unresolved and unknown is not replaced by a calendar month |
| Cumulative | Saved non-overlapping official day windows and attributed task records, with per-field coverage/gaps; no invented pre-collection history or zero-filled empty intervals |

Display uses Asia/Singapore. Current bytes, objects, videos/versions and retained logs are snapshots, not summed daily storage. Billing fields prefer the last successful whole-period official query, otherwise labeled saved-day fallback with gaps; never add both. A non-midnight cycle excludes the unallocatable first UTC day and labels its boundary gap, without averaging. Last-good fields preserve stale times and uncovered tails.

### Sources and units

| Resource | Scope and interpretation |
| --- | --- |
| Workers | `workersInvocationsAdaptive` filtered by `scriptName`; requests/errors and summed CPU microseconds converted to milliseconds |
| R2 | Bucket-filtered operations/latest class storage plus separately labeled project objects/reservations; current bytes are not GB-month |
| D1 | Database `file_size` and `databaseId` analytics; query counts, billing rows and current size are separate |
| DO | Configured project namespaces; requests, periodic GB-seconds, SQLite rows and storage |
| Containers | `applicationId` scope; vCPU-seconds, memory byte-seconds ÷ 1024³, disk byte-seconds ÷ 10⁹, transmitted bytes |
| Builds | Worker tag, at most 5×100 records, stable UUID deduplication; elapsed queue/deploy time is not billing build minutes or complete lifetime history |
| Logs | Current retained D1 application/error counts and oldest time, not platform Observability billing totals |

`RESOURCE_*` identifiers select this scope and are non-secret deployment parameters. The deployment resolver generates them from owned bindings, or an operator supplies a private configuration. An initial bootstrap lacks DO/Container identity, so those cards can have gaps until a later normal deployment reads existing bindings. Missing configuration remains unknown, never zero, and does not authorize another project's scope.

### Collection and persistence

The minute Cron advances hourly collection without page visits. First read may initialize; explicit refresh has a 30-second minimum. Existing snapshots return immediately with `waitUntil` refresh and a D1 collection lease. Collection uses read-only APIs and D1, without R2 full census, DO wake-up, Container start or per-media-request/segment writes.

`resource_usage_state` stores leases/cycle rules/backfill cursor; `latest` retains successful rolling/period snapshots and old times on failure; `daily` replaces resource/UTC-day windows without duplicate accumulation; `jobs` preserves attributed verified-stop estimates independently of deleted details; `builds` deduplicates IDs/status updates.

Each round retries today/yesterday and rotates one earlier day within 31 days. Actual permissions/API retention define recoverable history. With default two namespaces and five Builds pages, collection has at most 50 external calls and usually writes dozens of hourly snapshots/aggregates. Saved older windows persist without a promise of upstream correction. Rolling views avoid permanent day-history scans, billing uses the scope/day index, and cumulative read cost grows with saved windows.

Log cleanup, refresh, Worker restart or deployment do not reset resource totals. Scope is environment/resource based; credential rotation/commit changes do not change it. A resource migration creates a new scope, retaining earlier records separately.

### Estimates and gaps

Official Container fields take precedence and are **never added to task estimates**. Missing fields may use persisted attributed verified-stop capacity-time upper bounds with reliable end/wall time, proportionally intersected with the selected window. They are not actual CPU, peak capacity or final charges. Running/unknown-attribution records are not certain consumption. Invalidated evidence retains its former value/reliability marker but leaves certain estimates.

`ok-data` does not imply `budgetUsable`; `ok-empty` means a successful response without records and stays `null`. Permissions, failures, truncation, missing fields, unsupported sources and incomplete coverage have distinct diagnostics. Last-good data preserves its old range/time and never restores allowance or execution permission. Sampled/delayed analytics and even contiguous saved windows are not proof of a complete bill.

Usage display grants no paid-task permission. Upload uses project capacity; processing follows [separate budget gates](budget.md#english). Raw upstream payloads beyond selected metrics, authentication/payment information, build environment variables and unrelated resource names/IDs are not retained.

## 官方依据 / Official references

资料核对 / Checked: **2026-10-16**.

- [Workers metrics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)
- [D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/) · [R2 metrics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)
- [DO metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)
- [Container billing fields](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/)
- [Official period anchor](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/paygo_info/)
- [Build list API](https://developers.cloudflare.com/api/resources/workers_builds/subresources/builds/methods/list/)
