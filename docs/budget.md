# 费用与预算 / Billing and budget

[项目首页](../README.md) · [中文](#中文) · [English](#english) · [资源用量](resource-usage.md) · [部署](deployment.md)

## 中文

### 套餐与可能费用

**官方资料核对日期：2026-10-16。** 下表是标准公开套餐摘要，美元计价；Enterprise、税费、地区差异、后续价格变化及账户合同以 Cloudflare 为准。包含额度在账户层面共享，不为本项目单独保留。代码中的资源模型位于 [`src/billing.ts`](../src/billing.ts)，不能替代最终账单。

| 产品 | 官方前提与包含量摘要 | 本项目可能产生的用量 |
| --- | --- | --- |
| [Workers](https://developers.cloudflare.com/workers/platform/pricing/) | Paid 最低 $5/月；含每月 1000 万请求、3000 万 CPU ms，超量分别 $0.30/百万请求、$0.02/百万 CPU ms | 网页/API/鉴权媒体请求、Cron、诊断；`run_worker_first` 路径执行的 Worker 工作按实际规则计量 |
| [R2 Standard](https://developers.cloudflare.com/r2/pricing/) | 每月 10 GB-month、100 万 Class A、1000 万 Class B；超量 $0.015/GB-month、$4.50/百万 A、$0.36/百万 B | 原片/版本/Logo 存储，上传分片、对象列举、HEAD/Range 读取；R2 公网出口免流量费不代表请求/存储免费 |
| [D1 Paid](https://developers.cloudflare.com/d1/platform/pricing/) | 每月 250 亿读行、5000 万写行、5 GB；超量 $0.001/百万读行、$1/百万写行、$0.75/GB-month | 目录、任务、历史、统计、日志、迁移；计费行数不等于查询次数，索引也占存储/写入 |
| [SQLite DO](https://developers.cloudflare.com/durable-objects/platform/pricing/) | Paid 每月 100 万请求、40 万 GB·秒；另有 SQLite 行读写/存储计量 | 上传/删除协调、任务控制及闹钟，不能把协调器称为无成本 |
| [Containers](https://developers.cloudflare.com/containers/platform/pricing/) | 需 Workers Paid；每月含 25 GiB·小时内存、375 vCPU·分钟、200 GB·小时磁盘；超量按资源秒计费，出口另按地区计费 | 明确启动的探测、faststart、HLS 或转码；内存/磁盘按分配容量，CPU 为实际活动用量；Worker/DO 另计 |
| [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/) | Free 每月 3000 分钟；Paid 6000 分钟后 $0.005/分钟 | 构建、测试及应用/镜像交付；与视频处理任务分开 |

完整部署声明了 Container 镜像，按 Workers Paid 与 R2 已启用准备；`PROCESSING_ENABLED=false` 不取消已存在的套餐固定费。平台 Observability/Container 日志如启用也可能收费；仓库默认关闭平台 observability，D1 应用日志仍消耗数据库。R2 包含量仅适用 Standard，Infrequent Access 有读取费和最低保存期，不能套用 Standard 免费量。R2 计费单位会上取整。这里没有“保证永久免费”的承诺。

### 普通上传与处理分开

普通上传只检查本项目实际 R2 文件、对象账本、并发上传/处理/其他存储预留、文件大小及项目硬上限。服务端取实际桶占用与对象账本中较大值，并在真正准入的 D1 条件事务中复查。项目空间无法核实仍阻止上传；实际桶清单有 5 秒、100 页的有界读取，失败/重复分页不当作零。

上传**不查询全账户额度、不要求额外风险批准、不要求人工抄数**，也不会启动 Container。它仍可能产生存储和操作费用。20 GiB 单文件上限不表示处理实例能容纳该文件。复用已核验文件不增加预留；未知上传/取消结果保留预留，直到远端状态核实。

### 视频处理的保护条件

当前策略明确为 **`verified-included-only`**。任务必须同时满足：

1. 管理员鉴权与同源校验，Worker 手动总开关 `PROCESSING_ENABLED=true`。
2. 当前账户套餐、账期、相关资源包含量及实时实例容量可核实；项目空间、预算、并发和停止状态合格。
3. 有效且未改变的报价，绑定原片 revision/ETag、模式、单档画质、实例、产物字节/对象数、整个期限、账期及快照。
4. 管理员对精确任务明确确认；确认时重新读取并原子预留。

报价和资源/全价估算本身不启动计算，缺少账户证据时可显示但标为不可执行。不完整、过期或未知不会转换成“免费剩余”。`monthly_spend_limit_usd` 默认 0；将其设为正数**不会开启付费超额模式**。已发布播放、普通原片预览和管理员停止操作无需完整账户账单。

faststart 与 HLS 无损任务不授权转码；不兼容、升配、改画质或输出范围都必须停止、重新报价及确认。无损至少 standard-1、转码至少 standard-2，还受分辨率内存下限、输入/输出/镜像/临时磁盘和账户实时上限约束。规格目录只是候选，缺少容量权限返回未知，不假装可运行。

整个时限默认 30 分钟，可设置 60 秒至 6 小时，包括启动、传输、探测、处理、上传、验证及停止。faststart 最多一个独立 MP4、最多三次上传，受 R2 单 PUT [5 GiB − 5 MiB](https://developers.cloudflare.com/r2/platform/limits/) 限制；初次未知时长 HLS 对象数上限为 10000，处理器实际执行该范围。

### 估算、停止与已发生消耗

`costUpperUsd` 以已确认规格/范围/完整时限，按全部包含量已耗尽时的标价估算，并计入适用 R2/DO 上取整、一个月产物空间和数据库预算。**它依赖在时限内核实物理停止，不能硬封顶账户账单**。既有订阅固定费独立存在；平台停止延迟、未知停止及范围外后台查询可能带来额外费用。

停止请求成功不等于停止核实。必须确认 `inspect() === null` 且 `running === false`；未核实保留名额和预留并告警。核实后按实际观察的墙钟时间更新资源容量时间估算，不截断为原报价时限。预启动失败也可能已产生 HEAD、D1/DO 操作；仅已证明未使用的 Container/产物量归零，控制操作保守保留。无启动记录却观测到既有实例时，保存未知归属，不能清零其消耗。

已消耗预留只有在官方完整入账水位覆盖停止后 24 小时，才可自动逐指标对账释放。当前适配器没有这种权威水位，因此保守保留，可能与已记录用量重叠、提前耗尽准入额度。旧账期已停止的计算/操作保留为历史未对账，不重复扣新账期；持续存储及未核实停止分别处理。删除文件不会冲回已产生账单。

### 数据证据与未知规则

| 数据 | 用途及边界 |
| --- | --- |
| `billable-usage/info`、`subscriptions` | 实际订阅锚点与套餐覆盖；`covered=true` 不证明每项指标已完整 |
| Billing V1 `billable-usage` | 官方已记录消耗；收费行日期、零金额和查询成功都不是完整入账水位；空结果保持未知 |
| GraphQL 分析 | 请求/操作/容量时间与存储观测，可能采样/延迟；用于估算，不能冒充账单 |
| 账户资源清单 | 核对现有桶/数据库/DO 的范围；不能证明已删除资源的完整历史 |
| 项目对象/任务账本 | 当前占用、预留和可归属任务估算；不是全账户余额 |

自动处理准入对支持的整账期分析要求有效 99% 置信上界、正样本量及 `confidence.isValid=true`，并保留至少 5% 或区间宽度的安全余量。存储要求完整、新鲜、类别/范围正确的观测。上游截断、缺字段、失败或未知覆盖不当作零；已取得可用观测独立显示，保留原范围/时间的 `last-good` 只供查看，不恢复准入。累计项目数据的含义见[资源用量](resource-usage.md#中文)。

运行时仅使用专门的只读 `CF_USAGE_API_TOKEN`，不回退到部署或令牌管理凭据。需要 Billing Read、Account Analytics Read、Workers R2 Storage Metadata Read、D1 Read、Workers Metadata Read-Only、Workers Containers Read，限定自有账户；Cloudflare Builds 列表需要相应 Workers CI Read 能力（可核验的项目统计缺口须保留）。权限名称/兼容性以[官方目录](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)和实际端点核验为准。没有日常手工填账流程；[旧人工接口](manual-usage.md#中文)仅保留退役兼容说明。

## English

### Plans and chargeable operations

**Official references checked: 2026-10-16.** Standard public pricing below is in USD. Enterprise contracts, taxes, regions and future changes follow Cloudflare. Included usage is account-shared, not reserved for this project. [`src/billing.ts`](../src/billing.ts) is a conservative model, not the final bill.

| Product | Public plan summary | Project usage |
| --- | --- | --- |
| [Workers](https://developers.cloudflare.com/workers/platform/pricing/) | Paid minimum $5/month; 10 million requests and 30 million CPU ms/month; overage $0.30/million requests and $0.02/million CPU ms | UI/API/authorized media, Cron, diagnostics; actual Worker work with `run_worker_first` follows billing rules |
| [R2 Standard](https://developers.cloudflare.com/r2/pricing/) | 10 GB-month, 1 million Class A and 10 million Class B/month; overage $0.015/GB-month, $4.50/million A and $0.36/million B | Sources/versions/Logos, multipart writes, list, HEAD/Range reads; free Internet egress does not mean free storage/operations |
| [D1 Paid](https://developers.cloudflare.com/d1/platform/pricing/) | 25 billion reads, 50 million writes and 5 GB/month; overage $0.001/million reads, $1/million writes, $0.75/GB-month | Catalog/jobs/history/analytics/logs/migrations; rows are not query counts, indexes also use writes/storage |
| [SQLite DO](https://developers.cloudflare.com/durable-objects/platform/pricing/) | Paid 1 million requests and 400000 GB-seconds/month, plus SQLite row/storage metrics | Admission/deletion coordination, task control and alarms |
| [Containers](https://developers.cloudflare.com/containers/platform/pricing/) | Workers Paid required; 25 GiB-hours memory, 375 vCPU-minutes and 200 GB-hours disk/month; per-resource-second overage and regional egress | Explicit probe/faststart/HLS/transcode; allocated memory/disk and active CPU; Worker/DO charged separately |
| [Builds](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/) | Free 3000 minutes/month; Paid 6000 then $0.005/minute | Validation and application/image delivery, separate from video processing |

The complete deployment declares a Container image: prepare Workers Paid and enabled R2. Disabling processing does not remove fixed subscriptions. Platform observability/logs may also cost money if enabled; the repository defaults platform observability off, while D1 application logs still consume resources. R2 Standard inclusion does not cover Infrequent Access retrieval/minimum retention, and R2 rounds billing units upward. Free hosting is not guaranteed.

### Upload is independent of processing allowance

Ordinary uploads check the configured project's actual R2 inventory, object ledger, concurrent upload/processing/other storage reservations, file size and hard capacity limit. The larger actual/ledger occupancy is used and the admission transaction checks capacity again. Unknown project space blocks upload; inventory has a five-second/100-page bound and failures are not zero.

Upload makes **no account-wide allowance lookup and needs no extra risk approval or manual data transcription**. It starts no Container but may incur storage/operations. The 20 GiB file limit does not guarantee processing capacity. Verified reuse adds no reservation; uncertain writes/cancellation retain reservations until reconciled.

### Processing gates

The current policy is **`verified-included-only`**. Execution needs administrator/same-origin authorization, manually enabled `PROCESSING_ENABLED`, verified account plans/period/allowances/live instance capacity, project space/budget/concurrency/stop checks, a valid unchanged quote and explicit exact-task confirmation. Confirmation freshly verifies evidence and reserves atomically.

Quotes bind source revision/ETag, mode, one quality, instance, output bytes/count, full deadline, period and snapshot. A quote or full-price estimate starts no compute. Missing account evidence may allow display while execution stays blocked. Unknown/incomplete/stale is never free remaining usage. `monthly_spend_limit_usd` defaults to zero and a positive value **does not enable paid overage**. Existing playback, original preview and administrator stop remain independent of full billing coverage.

Faststart and lossless HLS do not authorize transcoding. Changed codecs/quality/resources/output scope require stop and a new confirmed quote. Lossless tasks require at least standard-1 and transcodes standard-2, plus resolution memory, input/output/image/temp disk and actual account capacity. A catalog entry is only a candidate; missing capacity access remains unknown.

The default whole-task limit is 30 minutes, configurable from 60 seconds to six hours, covering startup/transfers/probe/process/upload/validation/verified stop. Faststart creates one independent MP4 with at most three uploads and the R2 single-PUT [5 GiB minus 5 MiB limit](https://developers.cloudflare.com/r2/platform/limits/). Initial unknown-duration HLS is bounded to 10000 objects and enforced by the processor.

### Estimates, stopping and incurred usage

`costUpperUsd` uses confirmed scope/instance/full lifetime and full list prices before included usage, with applicable rounding, a month of output storage and database reservations. It assumes verified physical stop within the deadline and **is not a hard account-bill cap**. Existing fixed charges, platform stop delays, unknown stop and extra background queries remain possible costs.

Stop success requires `inspect() === null` and `running === false`, not just an acknowledged request. Unknown stops keep reservations/slots and alerts. Verified elapsed wall time updates capacity-time estimates without clipping to the quote deadline. Pre-start failures can incur HEAD/D1/DO work: zero only proven-unused Container/output quantities, retain control estimates. A pre-existing instance without a start record preserves unknown attribution and consumption evidence.

Automatic per-metric reconciliation requires an authoritative completeness watermark through verified stop plus 24 hours. Current adapters have none, so consumed reservations remain conservatively, can overlap recorded consumption and exhaust admission earlier. Stopped previous-period compute/operations remain historical unreconciled data, without double-debiting the new period. Ongoing storage and unverified stops are separate. Deletion does not reverse accrued bills.

### Evidence and unknown values

Subscription info gives real cycle anchors/plans; `covered=true` is not complete metric coverage. Billing V1 gives recorded consumption, not a complete ingestion watermark; charge dates, zero costs, success and empty results do not prove completeness. GraphQL can be sampled/delayed and supplies labeled observations/estimates. Account inventory cannot reconstruct deleted resources. Project ledgers give occupancy/reservations/attributed task bounds, not account balances.

Supported full-cycle analytics admission requires valid 99% upper confidence bounds, positive samples and `confidence.isValid=true`, plus safety headroom of at least 5% or confidence width. Storage requires fresh complete class/scope evidence. Truncation/missing fields/failures remain unknown. Obtained display values survive independently, but last-good data keeps its old range/time and never restores admission. See [resource coverage](resource-usage.md#english).

Runtime uses only dedicated read-only `CF_USAGE_API_TOKEN`, never deploy/manager credentials. Account-scoped permissions include Billing Read, Account Analytics Read, Workers R2 Storage Metadata Read, D1 Read, Workers Metadata Read-Only and Workers Containers Read. Builds collection additionally needs the relevant Workers CI Read access; missing product coverage remains explicit. Verify names/compatibility against the [official catalog](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) and actual endpoints. No daily manual billing forms are required; [legacy manual interfaces](manual-usage.md#english) are retired.

## 官方资料 / Official references

- [Billing permissions](https://developers.cloudflare.com/billing/understand/billing-permissions/) · [Account-owned token compatibility](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
- [Billing V1 API](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_v1/) · [Billing schema](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/billing/usage.ts)
- [GraphQL confidence intervals](https://developers.cloudflare.com/analytics/graphql-api/features/confidence-intervals/) · [Sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/)
- [Containers metrics and units](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/) · [R2 metrics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)
