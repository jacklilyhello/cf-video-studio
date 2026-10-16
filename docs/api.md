# API 参考 / API reference

[项目首页](../README.md) · [中文](#中文) · [English](#english) · [架构](architecture.md) · [使用手册](user-guide.md)

## 中文

### 通用约定

所有路径相对当前站点。写请求要求与 URL 精确匹配的 `Origin`；管理员接口用签名 host-only Cookie，不接受 URL Token或任意跨源调用。观看授权、管理员与匿名历史身份分开。JSON错误为 `{error:{code,message,details?},requestId?}`，响应头提供 `X-Request-ID`，内部详情仅在受保护日志中。JSON及浏览器媒体响应 `Cache-Control:no-store`；内部缓存不能绕过发布/观看资格。

### 公开与观看接口

| 方法/路径 | 行为 |
| --- | --- |
| `GET /api/site` | `{name,logoUrl,searchIndexing,updatedAt}`，默认 `Video Hub/null/false/0`，无内部路径/凭据 |
| `GET/HEAD /site-logo/:hash.:ext` | 仅当前 Logo；64位小写SHA-256，`png/jpg`，旧/身份不符返回404 |
| `GET/HEAD /robots.txt`、`/sitemap.xml` | 收录政策；sitemap关闭时404，仅列合格当前公开页面，目录无法完整核验时503 |
| `GET /api/config`、`GET /health` | 配置/环境/commit与真实版本健康，不返回秘密、不启动处理器 |
| `GET /api/videos?q=&page=&sort=` | 当前已发布、已验证目录，12项/页；`sort=title`按标题，否则按更新时间倒序 |
| `GET /api/videos/:id` | 当前公开版本/时长/时间轴及 `mediaKind`/`mediaName` |
| `GET/HEAD /media/:videoId/:versionId/:name` | 当前已验证公开版本的 HLS、`source.mp4` 或 `optimized.mp4`；先鉴权/发布检查再读缓存/R2 |
| `GET /api/watch/session` | `{enabled,configured,authorized,expiresAt}`，不返回口令/摘要/身份 |
| `POST /api/watch/login`、`/api/watch/logout` | 登录 `{password}`；退出仅清当前主机观看授权 Cookie，保留历史/主题 |
| `POST /api/history/identity` | 签发随机签名历史 Cookie，不返回身份值 |
| `GET /api/history` | `{items,cookieEnabled,writeContext}`，当前主机/Cookie记录 |
| `POST /api/history`、`DELETE /api/history` | 写进度；删除当前身份记录并清历史Cookie |
| `POST /api/analytics/session`、`/api/analytics/event` | 访问/起播会话与有界累计快照，独立于媒体响应 |
| `POST /api/report` | 固定枚举播放错误的只写限量上报 |

`/` 为品牌欢迎页，`/video` 为放映室，`/video?video=<id>` 选片；旧 `/?video=...` 和 `/video/` 用相对303跳转。欢迎页不加载目录/历史。保护开启时，未授权目录/详情/历史/所有媒体在查询或R2前返回 `401 watch_required`；观看配置异常 `503 watch_unavailable`，不降级公开。

观看 Cookie `__Host-vh_watch` 为30天、Secure/HttpOnly/SameSite=Strict/Path=/、无Domain，签名绑定主机/到期/随机值/全局版本。口令错误独立限流；观看授权仍不能读取未发布媒体。

历史写入字段为 `videoId,timelineId,position,duration,playedSeconds,eventAt,eventId,writeContext`，可带 `watched`。`eventAt`为毫秒，`playedSeconds`为新增实际观看秒数。服务端限制位置/时间偏差/增量与重复顺序。写上下文是用途隔离的主机/访客HMAC，不能替代Cookie或选择身份；重试保留事件原上下文。不匹配/缺失返回 `409 history_identity_changed`，旧事件不写到新Cookie。改标题不改时间轴；内容变化需新时间轴/重新恢复。

播放错误只接受 `code,videoId,versionId,nativeErrorCode?,hlsErrorType?`，枚举为 `playback_native_error`、`playback_hls_fatal`、`playback_hls_unsupported`、`playback_loader_failed`，原生码1–4，HLS类型白名单。拒绝原始URL/消息/堆栈/额外字段；正文最多2KiB、限速、未知视频关系使用同样接受响应，不能探测私有目录。上报失败不阻断播放。

### 管理接口

除 session/login/logout 外均需管理员会话；管理写入同源。`/api/admin/usage` 是自动资源面板别名，不是旧人工审批入口。

| 方法/路径 | 字段与作用 |
| --- | --- |
| `GET /api/admin/session`、`POST /api/admin/login`、`POST /api/admin/logout` | 状态、密码登录、退出 |
| `GET/PATCH /api/admin/site` | 名称/收录；PATCH `{name?,searchIndexing?}`，名称最多60字符，空值恢复默认 |
| `POST/DELETE /api/admin/site/logo` | 原始PNG/JPEG body上传/恢复默认引用；非multipart；不删除旧对象 |
| `GET/PATCH /api/admin/watch`、`POST /api/admin/watch/revoke` | 读设置/`{expectedRevision,enabled?,password?}`/`{expectedRevision,confirmed:true}`，冲突409 |
| `GET /api/admin/overview` | 目录/任务/存储/接入概览 |
| `GET /api/admin/videos`、`GET/PATCH /api/admin/videos/:id` | 20项/页目录、状态筛选、详情/标题 |
| `POST /api/admin/videos/:id/publish`、`/unpublish` | `{versionId}`明确发布；下架撤销后续请求与旧排队发布 |
| `GET/HEAD /api/admin/preview/:videoId/:versionId/:name` | 管理会话已验证版本预览，无公开直链Token |
| `GET /api/admin/source/:id/check` | 新原片身份/有界结构检查；`?reuse=1`先核身份再复用匹配证明 |
| `GET/HEAD /api/admin/source/:id/source.mp4` | 完成且受支持原片的流式鉴权预览 |
| `POST /api/admin/source/:id/playback-report` | 管理白名单诊断，不接受原始URL/堆栈 |
| `POST /api/admin/videos/:id/source-version` | 绑定原片身份/新结构检查/实播声明的引用版本，不复制文件/自动发布 |
| `GET /api/admin/uploads?status=unfinished&page=1` | 最多50项/页，状态 `unfinished/complete/cancelled/expired/all` |
| `GET /api/admin/upload-space` | 项目实占/预留/硬上限，不读全账户额度 |
| `POST /api/admin/uploads` | `{name,size,fingerprint,title?}`；核验复用返回 `reused,additionalBytes`，旧 `approvalId`忽略 |
| `PUT /api/admin/uploads/:id/parts/:number` | ≤8MiB二进制、`X-Part-SHA256`，真实长度/摘要验证 |
| `POST /api/admin/uploads/:id/complete`、`/cancel` | 幂等完成/核实中止；未知不释放预留 |
| `POST /api/admin/videos/:id/quote` | `{mode,quality}`，只报价，不运行FFprobe |
| `POST /api/admin/quotes/:id/confirm` | `{confirmation:'START_PAID_TASK'}`；新检查/原子预留；重复返回原任务 |
| `GET /api/admin/jobs`、`POST /api/admin/jobs/:id/cancel` | 任务实际进度/停止监督 |
| `GET /api/admin/resource-usage?range=24h` | `range=24h/billing/all`；`/api/admin/usage`同响应别名 |
| `GET /api/admin/storage?view=videos&q=&page=1` | 视频中心存储每页30项；原对象视图仍供技术详情 |
| `POST /api/admin/storage/reconcile` | `{cursor?}`，批次核对索引，`nextCursor,hasMore`，不删除 |
| `POST /api/admin/storage/plan` | 精确删除范围 `{kind,videoId,versionId?}`，kind为source/version/video/failed |
| `GET /api/admin/storage/plans`、`GET /api/admin/storage/plans/:id` | 未完成计划/原清单与进度，只读不删除 |
| `POST /api/admin/storage/plans/:id/cancel`、`/confirm` | 取消未开始/按原清单最多100项继续，见删除契约 |
| `GET /api/admin/playback-analytics?range=7d&host=&videoId=&page=1` | `today/24h/7d/30d`汇总/趋势/明细/长期与覆盖 |
| `GET /api/admin/logs`、`GET/PATCH /api/admin/settings` | 脱敏日志与有限数值设置 |

旧人工 `GET/POST /api/admin/usage/manual` 在鉴权后返回 `410 manual_usage_retired`，旧上传许可接口退役。旧人工报价需重生成；新报价可含 `executionAllowed:false,executionBlockers`，查看不代表执行许可。

### 原片与版本契约

原片版本 `mode='source',manifest='source.mp4'`，创建绑定 `sourceEtag,sourceRevision` 与 `attestation:{played:true,seeked:true,audioConfirmed:true,durationSeconds,seekFromSeconds,seekToSeconds}`。这是管理员实播/拖动/音画或无音轨声明，与服务端结构证明分别记录，不是完整解码或HLS转换。私有预览不保存访客历史。

当前parser `iso-bmff-source-v5`；证明六字段为 `video_id,object_key,source_revision,source_etag,source_bytes,parser_version`，固定JSON≤4096 UTF-8字节。完整兼容结果和最终身份复核后才存verified。证明跨isolate且不按五分钟过期；所有媒体仍检查身份/真实HEAD。明确重验/创建原片版本撤销旧证明并新验，失败不回落旧证明。90秒元数据时限、页面100秒等待与处理期限独立；完整检查后已发D1条件写可能在HTTP超时后完成，不能把超时等同未保存。

结构限总读取5MiB、moov最多4MiB、完整moof≤64KiB、1024片段、100万fragment samples；普通顶层128个，识别moof后最多4096。4KiB lookahead计入总量，可含小payload前缀但不解码。只支持受限H.264/AVC、可选单AAC-LC双声道、普通/部分fMP4；未知、加密、分组样本、不支持sidx/寻址/flags或超限保守拒绝。

fMP4验证轨道/序号/sample范围、mdat归属、无重叠、decode/presentation连续时间/时长及可选尾索引。tfra仅接受完整一致的实际traf顺序，或FFmpeg所有traf=1的轨道ID兼容约定，每条仍核轨道/offset/time/run/sample/sync；不混用坐标。仅元数据证明，`serverDecoded:false`；兼容映射不声称原始ordinal完全标准化或所有播放器可拖动。

普通MP4支持一段正常速率edit，或前置empty edit加一段正常速率edit；核对组合时长/样本范围，保留实际音画偏移，不剥离/改写。fMP4/MSE的edit支持不因此扩大。MSE完整索引路径闭合Range验证ETag/大小/长度/类型；初始化/尾索引各256KiB、单片16MiB、有限保留32MiB，仅内存改寻址，不改源。附加后失败需明确原生重试。

原片/独立MP4流式返回 `video/mp4`、Accept-Ranges、GET/HEAD、单Range206，非法416及`Content-Range:bytes */size`，支持If-Range。私有准备90秒但返回body没有90秒播放期限；日志的response_started仅表示服务端构造Response，不证明客户端首字节/解码。手动连接诊断HEAD、首尾≤64KiB及416，每项15秒，严格BYOB读不可用时标未核实，不构成实播/发布证据。

faststart报价 `{mode:'faststart',quality:'source'}` 绑定copy-only、一个`optimized.mp4`、最多三次上传及输入/产物上限；生成版本不覆盖原片、不伪造HLS证明。完成要求实际清单/身份/校验和、前moov非分片结构、完整解码、编码payload摘要/数量/时间轴保持，`allowFragmented:false`。发布还需该版本相同形状的实播声明；停止核实独立执行。HLS用完整清单/分片及解码时间轴检查，处理成功不自动发布。

### 删除与统计契约

删除plan固定对象身份/版本/依赖，返回`objects,totalBytes,remainingBytes,warning,requiresUnpublish,expiresAt,state,releasedBytes,remainingCount,failures`等。source可明确`preservePlayback:false,removeDependencies:true`允许移除依赖并下架；保留播放要求独立完整可用MP4/HLS，公开MP4还查实播声明。source版本仅元数据`sourceReferenceOnly:true`，不删除源；缺对象`missing:true`不计释放，重新出现需新plan；无工作`noAction:true`。

确认`{confirmation:'DELETE_LISTED_OBJECTS',unpublish?,removeDependencies?}`，每批≤100，ETag/大小复核、实际删R2、核实缺失后同步。持久回执避免双算；任务、未知停止、新版本/身份变化阻止扩大范围。未开始十分钟过期；pending/building可取消不删；running/partial继续原清单。`releasedBytes`是实占释放，不是退款。

统计session为客户端UUID及`kind:'visit'|'playback'`，播放绑定当前公开视频/版本/服务端Cookie身份；只有play事件创建尝试，playing记录实际开始，挂载不计。event累计字段`id,token,seq,started,playing,ended,error,watchedSeconds,intervals,errors,stalls,startupMs`，正文≤8KiB，每访客每分钟最多20次，顺序去重/单调和耗时核验；观看区间最多128段，不连接跳过空白。ended且覆盖/累积观看≥90%才完成。

统计读返回`range,summary,trend,videos,hosts,countries,browsers,systems,devices,sessions,lifetime,coverage`。today按Asia/Singapore零点，24h滚动，7/30天以当地日期零点；跨范围时长按交集分配，明细是整会话而汇总仅选定范围。实际Host、CF-Connecting-IP、request.cf近似地域/ASN、有限UA、外部Referer host分开，不存Token/完整Cookie/Referer路径query；IP/UA明细与增量30天，每日汇总独立长期保留。管理员预览/机器人/健康/标记自动化排除，失败不阻断媒体。

## English

### Common contract

All paths are relative to the current origin. Mutations require exact `Origin`; administrator routes use signed host-only cookies, never URL tokens/arbitrary cross-origin calls. Watching authorization, administrator and history identities are separate. Safe JSON errors are `{error:{code,message,details?},requestId?}` with `X-Request-ID`; internal details stay in protected logs. JSON/browser media use no-store; internal caches never bypass eligibility.

### Public and watch endpoints

| Method/path | Contract |
| --- | --- |
| `GET /api/site` | `{name,logoUrl,searchIndexing,updatedAt}`, defaults `Video Hub/null/false/0`, without private paths/credentials |
| `GET/HEAD /site-logo/:hash.:ext` | Current SHA-256 Logo only, `png/jpg`; old/mismatched identities 404 |
| `GET/HEAD /robots.txt`, `/sitemap.xml` | Index policy; disabled sitemap 404, eligible current pages only, incomplete catalog 503 |
| `GET /api/config`, `/health` | Safe environment/config/commit/actual version; no processor start |
| `GET /api/videos?q=&page=&sort=`, `/api/videos/:id` | Published verified catalog, 12/page, title or updated-descending sort; selected version/duration/timeline/media kind/name |
| `GET/HEAD /media/:videoId/:versionId/:name` | Current verified public HLS/source.mp4/optimized.mp4, authorization/publication before cache/R2 |
| `GET /api/watch/session` | `{enabled,configured,authorized,expiresAt}`, no passphrase/hash/identity |
| `POST /api/watch/login`, `/api/watch/logout` | `{password}` sign-in; sign-out only clears host viewing authorization, preserving history/theme |
| `POST /api/history/identity`, `GET /api/history` | Issue random signed Cookie; return `{items,cookieEnabled,writeContext}` without identity |
| `POST/DELETE /api/history` | Save progress / delete current host-cookie history and Cookie |
| `POST /api/analytics/session`, `/api/analytics/event`, `/api/report` | Distinct bounded analytics and fixed-code error reporting, independent of media |

`/` only loads branding; `/video?video=<id>` selects media, with relative303 legacy root-video/trailing-slash redirects. With protection enabled, catalog/details/history/media deny before querying/cache/R2 with `401 watch_required`. Broken settings return `503 watch_unavailable`. `__Host-vh_watch` is 30-day Secure/HttpOnly/SameSite=Strict/Path=/ without Domain, signed to host/expiry/nonce/global generation. Watching authorization never grants unpublished media access.

History saves `videoId,timelineId,position,duration,playedSeconds,eventAt,eventId,writeContext` and optional`watched`. Event time is milliseconds, playedSeconds actual additional watching. Bounds/order/overlap are checked. HMAC write context cannot replace Cookie or choose identity; retries keep their original event/context. Missing/stale context returns `409 history_identity_changed` without migrating to a new visitor. Titles retain timelines; changed content requires recovery/reset.

Playback reports only allow fixed code/video/version plus optional native1–4/HLS-enum fields, with four codes `playback_native_error`, `playback_hls_fatal`, `playback_hls_unsupported`, `playback_loader_failed`. Raw URL/message/stack/extras are rejected; ≤2KiB and rate limited. Unknown video relations get the same accepting response, without disclosing private catalog. Failure does not block playback.

### Administrator endpoints

Except session/login/logout, these require administrator cookies; writes are same-origin. `/api/admin/usage` aliases automatic resources, not manual approval.

| Method/path | Contract |
| --- | --- |
| `GET /api/admin/session`, `POST /api/admin/login`, `/api/admin/logout` | Status, password sign-in, sign-out |
| `GET/PATCH /api/admin/site`, `POST/DELETE /api/admin/site/logo` | `{name?,searchIndexing?}`, max 60-character name; raw PNG/JPEG upload/reset reference, retaining old objects |
| `GET/PATCH /api/admin/watch`, `POST /api/admin/watch/revoke` | `{expectedRevision,enabled?,password?}` / `{expectedRevision,confirmed:true}`, conflicts409 |
| `GET /api/admin/overview`, `/api/admin/videos`, `GET/PATCH /api/admin/videos/:id` | Overview; 20/page catalog/status filter; details/title |
| `POST /api/admin/videos/:id/publish`, `/unpublish` | `{versionId}` / immediate revocation including stale queued publication |
| `GET/HEAD /api/admin/preview/:videoId/:versionId/:name` | Session-authenticated verified-version preview |
| `GET /api/admin/source/:id/check`, `GET/HEAD /api/admin/source/:id/source.mp4` | Fresh identity/structure inspection (`?reuse=1` allows matching proof), streaming source preview |
| `POST /api/admin/source/:id/playback-report`, `/api/admin/videos/:id/source-version` | White-listed diagnostics / fresh structure+identity+playback attestation; reference without copying/publishing |
| `GET /api/admin/uploads`, `/api/admin/upload-space`, `POST /api/admin/uploads` | ≤50/page unfinished/complete/cancelled/expired/all; project space; `{name,size,fingerprint,title?}`, verified `reused,additionalBytes`, old approval ignored |
| `PUT /api/admin/uploads/:id/parts/:number`, `POST .../:id/complete`, `POST .../:id/cancel` | ≤8MiB with X-Part-SHA256, idempotent completion/verified cancellation |
| `POST /api/admin/videos/:id/quote`, `/api/admin/quotes/:id/confirm` | `{mode,quality}` / `{confirmation:'START_PAID_TASK'}`, fresh checks/atomic reservation; replays return original task |
| `GET /api/admin/jobs`, `POST /api/admin/jobs/:id/cancel` | Actual progress/stop supervision |
| `GET /api/admin/resource-usage?range=24h`, `/api/admin/usage` | Same response; `range=24h/billing/all` |
| `GET /api/admin/storage?view=videos`, `POST /api/admin/storage/reconcile` | 30-video page / `{cursor?}` existence reconciliation, no deletion |
| `POST /api/admin/storage/plan`, `GET /api/admin/storage/plans`, `GET .../plans/:id` | source/version/video/failed immutable inventory; unfinished plans/read-only progress |
| `POST /api/admin/storage/plans/:id/cancel`, `/confirm` | Cancel unstarted plan / exact inventory batches≤100 |
| `GET /api/admin/playback-analytics` | today/24h/7d/30d with host/videoId/page, summary/trends/details/lifetime/coverage |
| `GET /api/admin/logs`, `GET/PATCH /api/admin/settings` | Redacted diagnostics/bounded numeric settings |

Authenticated legacy manual usage returns `410 manual_usage_retired`; upload approval endpoints are retired. Old manual quotes must be regenerated. New quotes may have `executionAllowed:false,executionBlockers`; estimates are no execution permission.

### Source and version contract

Source versions use `mode='source',manifest='source.mp4'`. Creation binds `sourceEtag,sourceRevision` and `attestation:{played:true,seeked:true,audioConfirmed:true,durationSeconds,seekFromSeconds,seekToSeconds}`. This records human browser playback, seeking and audio/video or no-audio confirmation separately from server structure checks. It is neither full decode nor HLS conversion. Private preview saves no visitor history.

The current parser is `iso-bmff-source-v5`. D1 proofs match video, key, revision, ETag, bytes and parser, contain at most 4096 bytes of fixed-schema JSON, and require complete compatible inspection plus final identity verification. They persist across isolates without a five-minute expiry; media still verifies actual HEAD and identity. Explicit checks and source-version creation invalidate the old proof and scan afresh. Metadata has a 90-second server deadline and a 100-second page wait, separate from processing limits. A conditional D1 write issued after complete inspection may persist after an HTTP timeout.

Inspection bounds are 5 MiB total reads, 4 MiB of moov, 64 KiB per complete moof, 1024 fragments and one million fragment samples. Classic MP4 allows 128 top-level boxes; fragmented scanning permits 4096 after identifying moof. The 4 KiB lookahead counts toward the total and may read a small payload prefix without decoding. Supported H.264/AVC may have one AAC-LC stereo track or no audio. Encrypted/grouped samples, unsupported sidx/addressing/flags, unknown layouts and exceeded bounds fail conservatively.

Fragment checks verify track associations, sequence numbers, sample ranges within mdat, non-overlap, decode/presentation timelines, durations and optional trailing indexes. tfra must consistently use actual traf order or FFmpeg's all-traf=1 track-ID convention. Every track, offset, time, run, sample and sync reference is still checked; mixed coordinates fail. `serverDecoded:false` remains explicit. Compatibility mapping does not normalize raw ordinals or guarantee seeking in every player.

Classic MP4 accepts one normal-rate edit, or a leading empty edit followed by one normal-rate edit. Combined duration and sample ranges are verified, preserving audio/video offsets without rewriting. This does not broaden fragmented/MSE edit handling. Fully indexed MSE uses closed ranges with ETag, size, length and type checks: initialization/index at most 256 KiB each, fragments 16 MiB and retained encoded fragments 32 MiB. Only addressing changes in memory; errors after attachment require explicit native retry.

Source and independent MP4 streams provide video/mp4, GET/HEAD, Accept-Ranges, single-range 206/416 and If-Range. Private response preparation has a 90-second deadline; the returned media body has no such playback deadline. `response_started` proves response construction, not client receipt or decoding. Manual connection checks issue HEAD, first/last ranges of at most 64 KiB and an out-of-range request, waiting at most 15 seconds each. Missing bounded BYOB support leaves body verification unknown and never supplies playback/publication evidence.

Faststart `{mode:'faststart',quality:'source'}` is copy-only with one optimized.mp4, at most three uploads and bound input/output size. It never overwrites the source or claims HLS completion. Validation checks actual inventory, identity/checksum, non-fragmented front-moov structure (`allowFragmented:false`), full decode and preserved encoded payload digests, counts and timelines. Publication needs that exact version's playback statement; physical stop is independently verified. HLS checks its complete inventory, segments, decoding and timelines, without automatically publishing.

### Deletion and analytics contract

Deletion freezes object, version and dependency identities and returns objects, expected/remaining bytes, warnings, publication impact, expiry, state, progress and failures. Source `preservePlayback:false,removeDependencies:true` permits dependent-version removal and unpublication. Preserving playback requires an independently complete usable MP4/HLS; a published MP4 also needs its playback attestation. `sourceReferenceOnly:true` removes metadata without source bytes. Missing objects release zero bytes and reappearance requires a new review. Empty work may return `noAction:true`.

Confirmation `{confirmation:'DELETE_LISTED_OBJECTS',unpublish?,removeDependencies?}` processes at most 100 actual identity-checked removals per batch, verifies absence and synchronizes indexes. Durable receipts prevent double-counted freed bytes. Active tasks, unverified stops and new versions/identities block scope changes. Unstarted plans expire after ten minutes; pending/building cancellation removes no files, while running/partial plans resume their original scope. Freed bytes are not billing refunds.

Analytics sessions use a client UUID and visit/playback kind, bound to the current public version and server-cookie identity. A play event creates an attempt and playing records a start; mounting alone counts neither. Event bodies contain at most 8 KiB of cumulative `id,token,seq,started,playing,ended,error,watchedSeconds,intervals,errors,stalls,startupMs`, with at most 20 reports per visitor per minute plus sequence, monotonicity and elapsed-time checks. Up to 128 actual intervals never join skipped seek gaps. Completion needs ended and at least 90% coverage and accumulated watching.

Analytics reads return range, summary, trend, video/host/client distributions, sessions, lifetime and coverage. Today uses Asia/Singapore midnight, 24 hours is rolling, and seven/30 days start at the corresponding local date's midnight. Watch time is intersected with the selected range; session details describe the whole session. Actual Host, CF-Connecting-IP, approximate request.cf geography/ASN, bounded UA and external Referer host stay separate. Authentication, full cookies and referrer paths/queries are not retained. Raw IP/UA details and increments retain 30 days; independent daily aggregates persist. Administrator previews, bots, health checks and marked automation are excluded; reporting failure never blocks playback.
