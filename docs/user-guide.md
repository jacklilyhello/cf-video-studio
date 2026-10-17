# 使用手册 / User guide

[项目首页](../README.md) · [中文](#中文) · [English](#english) · [部署](deployment.md) · [费用](budget.md) · [API](api.md)

## 中文

### 入口与两种密码

| 入口 | 用途 |
| --- | --- |
| `/` | 公开欢迎页，只加载站点品牌；不初始化视频目录、历史或播放器 |
| `/video`、`/video?video=<id>` | 放映室、选定视频；仅显示已发布且有效的版本 |
| `/admin` | 管理员登录与工作区；需手动访问，无公开导航链接 |

管理员使用 Worker 的 `ADMIN_PASSWORD`，测试环境至少 10 字符、生产至少 12 字符；缺少必需运行时配置时拒绝登录。管理员会话最多 8 小时，修改管理员密码或 `SESSION_SECRET` 会使旧会话失效。

**访客观看口令**在后台“站点设置”中单独设置（8–128 字符），默认关闭；它不授予后台权限。开启后，欢迎页仍公开，放映室、目录、详情、历史和媒体均要求观看授权；管理员可使用自己的独立会话。授权最长 30 天。

在同一 Worker 连接多个域名时，目录、发布状态和观看设置共用；管理员登录、观看 Cookie 和浏览器历史按域名隔离，不跨域搬迁。Cookie 为 `Secure`、`HttpOnly`、host-only，部署应使用 HTTPS。主题偏好保存在 localStorage，不作为身份。

### 上传与恢复

1. 打开“视频库 → 上传队列”，选择一个或多个文件。文件须非空，每个不超过 **20 GiB**；项目实际占用加在途上传、处理等预留须低于设置的硬上限。
2. 每个文件使用 **8 MiB** 分片，客户端最多并行处理两个文件。可查看分项/总进度，暂停、继续、取消和重试。
3. 普通上传只核对本项目 R2 清单、对象账本、大小和并发预留，**不查询全账户余额，不要求额外额度审批或人工抄数**。清单/账本不可核实、项目空间不足、权限或真实存储失败仍会阻止上传。
4. 刷新或断网后重新选择原文件。客户端对全内容分块取指纹，并包含名称、大小、修改时间；文件身份变化可能形成新上传。核验复用时不新增预留。
5. 完成后仅保存未发布原片，不启动探测或 Container。取消须核实远端状态才释放预留；不活动上传的窗口为 48 小时，未知结果不能当作已取消。

20 GiB 是上传上限，**不是可处理大小保证**。Container 还需同时容纳镜像、输入、输出和临时文件；当前最大候选磁盘 20 GB，小于 20 GiB。

### 原片优先与媒体范围

优先在视频管理中选择“原片直接播放 / 预览原片”。兼容 MP4 通过已鉴权 Worker 从私有 R2 流式播放，无需先生成 HLS。

| 路径 | 当前支持与限制 |
| --- | --- |
| 原片直接播放 | 保守支持普通 MP4 与部分 fMP4；受支持的 H.264/AVC 视频，可有一条 AAC-LC 双声道音轨或无音轨；加密、未知或复杂结构拒绝，不自动转码 |
| fMP4 原片 MSE | 仅完整受支持索引子集；按需读取初始化、尾部索引与片段，仅在内存调整寻址头，不改变编码数据/时间戳或 R2 原片；不支持时预先选原生播放，附加后失败需明确原生重试 |
| MP4 faststart | 独立的 copy-only 优化任务；输出非分片、前置索引的 `optimized.mp4`；输入受单次 R2 PUT **5 GiB − 5 MiB** 限制，与 20 GiB 上传上限分开 |
| HLS 无损封装 | 经真实探测确认兼容的 H.264/AAC-LC 输入，输出 VOD 播放列表及 TS 分片；不授权重新编码 |
| 转码 | 需可信探测信息和新报价；一次确认选择原分辨率、1080p 或 720p 一档，H.264/AAC，默认不放大小源 |

多轨、字幕、附件、HDR、旋转及超出内存/磁盘范围的处理会停止等待审阅；本版本没有自动保留这些复杂特性的通用流程。浏览器可否解码仍取决于具体文件、平台和浏览器；结构支持不是所有设备兼容保证。

### 三种检查证据

| 证据 | 能说明什么 | 不能说明什么 |
| --- | --- | --- |
| 服务端结构检查 | 当前 R2 对象身份及有界 MP4 元数据/样本表/索引符合支持范围；总读取最多 5 MiB | 原片已被 FFprobe/完整解码、浏览器可持续播放或音画正常 |
| 浏览器实际播放与拖动 | 本次浏览器实际加载、起播及拖动表现；手动媒体连接诊断另查 HEAD/Range | 所有浏览器、所有时间位置均可用或声音正确 |
| 管理员人工确认 | 实际检查所选版本的画面、声音/无音轨及拖动，声明绑定版本/对象身份 | 自动测试、结构检查或处理器日志代替人工判断 |

普通预览先核对最新对象身份，再复用匹配的完整结构证明；“重新检查原片”和创建原片版本仍执行新检查。证明持久保存但不绕过 R2 HEAD、鉴权或公开发布检查。结构检查服务器等待上限 90 秒，页面等待最多 100 秒；超时或读取未核实不等于不兼容，也不证明远端写入未发生，应刷新核对状态。

“检查媒体连接”只做 HEAD、首尾各最多 64 KiB Range 和越界响应验证；不支持严格限量读取的浏览器会标为正文未核实，不以此宣称解码成功。“重新加载播放器”清除本次实播/拖动声明，不重新完整扫描。后台起播计时区分准备、元数据、媒体数据、就绪和呈现反馈，不能据此声称浏览器冷缓存或硬件解码已证明。

原片预览是私有管理行为，不保存访客 Cookie 对应的 D1 观看进度。原片版本引用原对象，不复制视频；创建版本后仍需明确发布。

### 可选处理、报价与发布

上传、原片预览、报价、资源面板和普通健康检查都不会启动 Container。处理需要管理员在 Worker 面板设置 `PROCESSING_ENABLED=true`，并对**每个任务**审阅和确认报价。

报价绑定原片版本/ETag、处理模式、单档画质、实例、输出空间/对象数、完整任务时限、账期和用量快照。当前为 `verified-included-only` 政策：无法核实账户包含量时可展示资源与全价估算，但明确不可执行；提高月费用设置不启用付费超额处理。不要通过手工抄数绕过阻断。

探测、兼容 HLS 封装或 faststart 与转码分别确认。发现需转码、升配、改变质量或产物范围时先停止，再生成新报价。任务期限覆盖启动、下载、探测、处理、上传、验证及停止核实；关闭后台不停止监督。停止请求成功不等于物理停止已核实，未知停止继续占用任务名额和预留。

处理器会验证生成物，包括文件清单、身份、时长、完整解码和模式对应的时间轴/数据保留要求；这些仍不替代浏览器实播和人工音画确认。成功结果先成为独立版本，不自动发布或替换现有版本。

| 操作 | 对文件与公开播放的影响 |
| --- | --- |
| 上传 | 保存私有原片，不公开、不启动处理 |
| 创建播放版本 | 原片引用或独立生成物，记录对应证明；不自动公开 |
| 发布 | 明确选择已验证版本，成为当前公开版本；原片/faststart 需对应实播声明 |
| 下架 | 撤销后续公开媒体请求资格，保留文件与版本；此前排队的旧发布请求也不能重新发布 |
| 删除 | 另行审阅对象和依赖，按确认清单物理移除或仅清除元数据；可能要求下架 |

每次公开 GET/HEAD/Range/HLS 请求都在缓存及 R2 读取前核对最新公开状态。已经下载或缓冲的数据无法收回。后台预览使用独立管理员鉴权入口。

### 观看授权与历史

“退出观看”立即关闭播放器；成功只清当前域名的观看授权，保留历史和主题。退出结果未知时保持关闭并允许重试。“撤销全部访客授权”影响同一 Worker 的所有域名；修改观看口令、关闭/重开保护或更改观看设置也使旧授权失效。页面聚焦及约每 30 秒复核，授权过期/撤销会停止播放器；新媒体请求始终在服务端校验。收录开关不能代替观看保护。

历史身份来自随机签名 host-only Cookie，不用 IP、设备指纹或 localStorage 身份。按配置每 15–30 秒合并保存，并在暂停、切片和隐藏页面时补存。可继续观看、从头播放、标记看过或清除当前浏览器历史。改标题保留进度；内容时间轴变化需匹配新记录或从零开始。

清 Cookie、无痕窗口及不同域名产生独立身份。保护关闭时，即使浏览器拒绝历史 Cookie 仍可播放但不能保存历史；保护开启时必须有有效观看授权。未确认的历史重试绑定事件创建时的访客上下文，不能迁移到新 Cookie 身份；超过五分钟或上下文变化时按页面提示重新开始记录。历史保存失败本身不强制中断播放；授权失败则关闭访问。清历史会通知同源其他标签页，未播放的暂停页面不会立即重建历史。

### 存储与删除

“R2 存储”按视频汇总原片、生成 MP4/HLS、使用状态和占用；技术详情可展开分片。“检查文件存在”仅核对索引，不删除对象。

- 删除原片播放版本仅移除引用元数据，释放 **0** 物理字节。
- 删除生成版本只删除该版本产物，保留原片及其他版本。
- 删除原片可保留独立且完整可用的 MP4/HLS；必要时明确切换公开版本。也可明确移除依赖原片的版本并下架，不要求先付费转换。
- 整个视频也可删除，包括只有原片的视频；需审阅全部影响。

确认页列出删除/保留内容、公开播放影响和预计释放空间。物理删除须确认并输入“删除”；仅元数据清理不要求物理删除短语。活动上传、处理及停止未核实阻止删除。未开始计划十分钟后过期，取消不删除文件；部分完成在“继续删除”中按原不可变清单续做，每批最多 100 个对象。身份、依赖或范围变化需新审阅，不能自动扩大旧清单。不存在的文件只同步索引，不虚报释放；已经删除的文件不可恢复，释放空间不抵销已产生账单。

自定义 Logo 最多 512 KiB，PNG/JPEG，宽高 32–2048、总像素不超过 400 万。替换/恢复默认仅改变引用，旧 Logo 仍保存、计入占用且不再公开；不要把操作理解为清除所有旧图片。

### 资源用量、播放统计与搜索

“资源用量”自动展示本项目 Workers/R2/D1/DO/Containers/Builds 和保留日志；滚动近24小时、本账期、累计使用不同来源和覆盖范围。官方值、项目记录、估算及缺口分开，项目空间条不是全账户余额。无需手工核验表，详见[资源说明](resource-usage.md#中文)。

“播放统计”独立提供今天（Asia/Singapore）、近24小时、7天、30天，按实际域名/视频筛选。页面访问、用户触发播放尝试和实际起播分别计数；播放次数为起播会话，不是 Range/分片请求数。访客按域名内 Cookie 去重，不把 IP 当作自然人或跨域追踪。

观看时长只累积实际连续媒体进度，排除暂停、缓冲和跳过区间。完成要求 ended 且实际覆盖及累积观看均达 90%；“最近活跃”为过去五分钟内有播放事件的身份，不是精确实时并发。明细含请求 IP、近似地域/ASN、有限 UA、外部来源主机，仅管理员可见；**IP/UA 会话明细与区间增量保留 30 天，独立每日汇总长期保留**。首次采集前历史不补造。管理员预览、健康检查、机器人和标记的自动化不计普通播放统计，上报失败不阻断播放。

验收时使用 `/video?acceptance=1` 在当前域名/标签页排除演示统计，结束以 `?acceptance=0` 清除并刷新。标记依赖当前标签页 sessionStorage；它不授予任何访问权限，不删除已报记录。

搜索收录默认关闭，通过 HTML robots、响应头、robots.txt/sitemap 控制；开启仅允许符合公开资格的页面/当前视频，后台/API/错误仍 noindex。观看保护开启时放映室保持 noindex；关闭收录不会立即删除搜索引擎已有结果，也不能阻止持有已授权内容的人复制。设置名称/Logo/收录不启动处理器。

## English

### Entrances and credentials

`/` is the public welcome page and only loads branding. `/video` and `/video?video=<id>` load the room and eligible published media. Visit `/admin` manually for administration; it has no public navigation link.

The Worker `ADMIN_PASSWORD` requires at least 10 characters in test or 12 in production. Missing runtime configuration denies sign-in. Administrator sessions last at most eight hours; a password or session-secret change invalidates them. The optional visitor passphrase is separately configured in Settings (8–128 characters), defaults to off and grants no administrator access. When enabled, the room, catalog, details, history and media need viewing authorization, while the welcome page remains open. Viewing authorization lasts at most 30 days; administrators retain their separate session.

Domains on one Worker share catalog, publication and watch settings. Administrator sessions, viewing authorization and history remain host-isolated. Cookies are Secure, HttpOnly and host-only; use HTTPS. localStorage only remembers the theme, not visitor identity.

### Upload and recovery

Choose files under Library → Upload queue. Files must be nonempty and at most **20 GiB** each, with actual project occupancy and concurrent reservations below the project ceiling. The client uses **8 MiB** parts and up to two active files, with pause/resume/cancel/retry and total/per-file progress.

Ordinary upload checks project R2 inventory, its object ledger, size and reservations. It makes no account-balance lookup and needs no extra allowance approval or manual usage transcription. Unknown project capacity, storage limits, permissions and actual storage failures remain enforced. After refresh, reselect the original file. The full-content chunk fingerprint includes filename, size and modification time, so changes may create another identity. Verified reuse makes no additional reservation.

Completion saves an unpublished source without probing or starting a Container. Cancellation releases space only after remote reconciliation; inactive uploads have a 48-hour window. An unknown result never proves cancellation. A 20 GiB upload is not necessarily processable: image, input, output and temporary space must fit the selected instance, whose current candidate maximum disk is 20 GB.

### Originals and supported media

Prefer Original playback / Preview original. Compatible MP4 streams from private R2 through the authenticated Worker without generating HLS.

| Path | Scope |
| --- | --- |
| Direct original | Supported classic MP4 and some fMP4; supported H.264/AVC, optional single AAC-LC stereo track or no audio; encrypted/unknown/complex structures are rejected without automatic transcode |
| fMP4 MSE | Supported complete-index subset, bounded initialization/index/fragment reads and in-memory addressing adjustment; encoded data, timestamps and source remain unchanged. Unsupported cases select native playback before attachment; later failures require explicit native retry |
| MP4 faststart | Separately confirmed copy-only task, producing independent non-fragmented front-index `optimized.mp4`; input limit **5 GiB − 5 MiB** from the R2 single-PUT path |
| Lossless HLS | Actually probed compatible H.264/AAC-LC input; VOD playlist and TS segments; no re-encoding authorization |
| Transcode | Trusted probe and new quote, one source-resolution/1080p/720p quality, H.264/AAC and no default upscaling |

Multiple tracks, subtitles, attachments, HDR, rotation and exceeded memory/disk stop for review. General preservation of these complex features is not implemented. Actual decoding depends on the file, platform and browser; structural support does not guarantee every device.

### Three kinds of evidence

Server structure inspection proves supported bounded MP4 metadata/sample/index structure and current R2 identity, reading at most 5 MiB. It does **not** mean FFprobe ran or the source was fully decoded. Browser playback and seeking demonstrate that browser's behavior; a connection diagnostic only verifies transport. Human confirmation records an administrator's actual video/audio-or-no-audio and seek check for the exact version/identity. These cannot substitute for one another.

Normal preview freshly verifies source identity before reusing a matching complete persistent proof. Recheck and source-version creation perform a fresh scan. Proofs never bypass HEAD, authorization or publication. Server metadata checks have a 90-second deadline and page requests wait at most 100 seconds; timeout or unverified reads do not mean incompatibility or prove a remote write did not persist. Refresh and reconcile.

Check media connection issues HEAD, up to 64 KiB at each end and an out-of-range request; browsers without bounded reads report unverified bodies. Reload player clears playback/seek evidence without a full scan. Startup measurements distinguish preparation, metadata, data, readiness and frame feedback; they do not establish a cold browser cache or hardware decoding. Private source preview saves no visitor-linked D1 progress. Source playback versions reference the source without copying it and still need explicit publication.

### Optional processing and publication

Upload, source preview, quotes, usage and ordinary health checks never start Containers. Processing needs `PROCESSING_ENABLED=true` in the Worker dashboard and **exact-task** quote review and confirmation. Quotes bind source revision/ETag, mode, one quality, instance, output bytes/count, full deadline, billing period and usage snapshot.

The current policy is `verified-included-only`. Missing account allowance evidence may leave a viewable resource/full-price estimate but execution is blocked. Raising the spend setting does not enable paid overage. Manual transcription is not a workaround. Probe/compatible HLS remux/faststart and transcode have separate scopes; changed codecs, quality, resources or outputs require stop and a new quote.

Deadlines include startup, download, probe, processing, upload, validation and verified stop. Closing the page does not end supervision. A successful stop request does not prove physical stop; unknown stops retain slots and reservations. Generated-output checks include inventory/identity, duration, full decode and mode-specific timelines/payload preservation, still followed by browser preview and human audio/video confirmation. Success creates an independent version without publishing or replacing the selected one.

| Action | Effect |
| --- | --- |
| Upload | Private source; no publication or processing |
| Create version | Source reference or independent output plus its evidence; no automatic publication |
| Publish | Explicitly choose an eligible verified version; source/faststart also require the corresponding playback statement |
| Unpublish | Revoke future public media eligibility and invalidate queued earlier publication attempts; preserve data |
| Delete | Separate exact inventory/dependency confirmation; physical or metadata-only removal, possibly requiring unpublication |

Every public GET/HEAD/Range/HLS request checks current publication before cache or R2. Previously delivered/buffered data cannot be recalled. Private preview has its own administrator-authenticated route.

### Viewing authorization and history

Sign out of viewing immediately closes playback and, once confirmed, clears only this host's viewing authorization, preserving history/theme. An unconfirmed sign-out stays closed with retry. Revoke all visitor authorizations affects every domain on the Worker. Passphrase or setting changes and protection off/on also invalidate old cookies. Focus and approximately 30-second checks close the player after revocation; new media requests always check on the server.

History uses a random signed host-only cookie, not IP, fingerprints or localStorage identity. Saves are coalesced every configured 15–30 seconds plus pause, video switch and page hiding. Continue, start over, mark watched and clear history are available. Renaming preserves position; changed timelines require matching history or a reset.

Different domains, cleared cookies and private windows are separate identities. With protection off, cookie rejection prevents history saving but permits playback; protection on requires viewing authorization. Unacknowledged retries retain the event's original visitor write context and cannot migrate to another cookie. After five minutes/context changes, restart recording as prompted. History failures alone do not stop playback; authorization failures do. Clearing history notifies other same-origin tabs, and unchanged paused media does not recreate it.

### Storage and deletion

R2 Storage groups sources, generated MP4/HLS and usage by video, with collapsed segment details. Existence reconciliation updates the index without deleting files. Removing a source playback version frees **zero** physical bytes. Deleting a generated version removes only its outputs. Source deletion can preserve independently complete usable MP4/HLS playback, with an explicit switch when needed; alternatively remove source dependencies and unpublish, without requiring paid conversion first. Whole-video deletion also works for source-only videos.

Review deleted/retained items, playback impact and expected freed space. Physical deletion requires acknowledgement and typing the displayed deletion phrase; metadata-only cleanup does not. Active uploads/jobs/unverified stops block it. Unstarted plans expire after ten minutes; cancellation deletes nothing. Partial failures resume the immutable inventory in batches of at most 100 objects. Changed identity/dependencies/scope need a new review. Missing files only update indexes and free zero bytes; physical deletion is irreversible and does not refund accrued bills.

Logos accept PNG/JPEG up to 512 KiB, dimensions 32–2048 and at most four million pixels. Replacement/reset only changes the reference: old objects remain stored/accounted but no longer public.

### Usage, analytics and search

Resource Usage automatically separates official project observations, local records and estimates across rolling 24 hours, billing period and cumulative ranges. Gaps remain explicit; project capacity is not an account balance. No manual forms are required. See [resource coverage](resource-usage.md#english).

Playback Analytics supports today (Asia/Singapore), 24 hours, seven days and 30 days, filtered by actual host/video. Visits, user-triggered attempts and actual starts are distinct. Plays count started sessions, not Range/segment requests. Cookie visitors deduplicate within each host, without identifying people by IP or cross-domain tracking. Watch time follows continuous media progress, excluding pause/buffer/seek gaps. Completion needs ended plus 90% actual coverage and accumulated watching. Recently active means a playing identity with an event in the last five minutes, not exact live concurrency.

Administrator-only details contain request IP, approximate geography/ASN, bounded UA and external referrer host. **IP/UA details and interval increments retain 30 days; independent daily aggregates persist.** Earlier history is not reconstructed. Previews, health, bots and marked automation are excluded. Reporting failure never blocks playback. Use `/video?acceptance=1` to exclude browser acceptance in the current host/tab, then `?acceptance=0` and reload afterwards. This sessionStorage marker grants no access and does not remove old reports.

Search indexing defaults off and uses HTML robots, response headers, robots.txt and a sitemap. Enabling only permits eligible public pages/current videos; admin/API/errors remain noindex. A protected room remains noindex. Disabling cannot instantly erase existing search results and is not access control or copying prevention. Branding/indexing changes never start processing.
