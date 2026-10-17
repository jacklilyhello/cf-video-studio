# 部署与维护 / Deployment and maintenance

[项目首页](../README.md) · [中文](#中文) · [English](#english) · [使用手册](user-guide.md) · [费用](budget.md)

## 中文

### 部署前提与配置分工

公开项目名为 **cf-video-studio**。仓库迁移只移动已审核的源码、文档与演示截图，不迁移云端业务数据、不切换已有 Workers Builds 仓库连接，也不修改现有实例的站点设置。`wrangler.jsonc` 与脚本保留 `cf-video-hub` 兼容默认名；已有实例必须沿用自己的 Worker／D1／R2／DO／Container 身份，新实例则显式选择自己的资源名称。当前仓库 CI 仅验证代码，不发布应用。

正式应用与 Container 镜像由 **Cloudflare Workers Builds** 构建/发布；GitHub Actions 只运行既有 CI，不发布应用。不要用本地 Docker、GitHub 视频转换或仅上传 Worker 版本来替代配套镜像发布。完整部署需要 Workers Paid、已启用的 R2、D1、SQLite DO、Container 及 Builds 能力；套餐/费用以[费用文档](budget.md#中文)和自己的账户为准。原片播放不启动 Container，但部署声明仍包含它。

| 配置位置 | 内容 | 不应放什么 |
| --- | --- | --- |
| Worker Settings → Variables and Secrets | 下表的运行时 Secret/Text，逐环境填写 | 部署凭据、Token 管理凭据 |
| Workers Builds | 部署 token、构建命令、发布分支及可选私有部署配置 | 管理员密码、观看口令、整个本地 env 文件 |
| 本地 `.env` 或 `CF_VIDEO_ENV_FILE` | 仅运维脚本的凭据；参考 [`.env.operator.example`](../.env.operator.example) | 前端 `VITE_*`、提交到 Git 或截图 |
| 本地 `.dev.vars.test` | Wrangler 本地运行时，参考 [`.env.example`](../.env.example) | 正在使用的生产秘密 |
| `wrangler.jsonc` | 可公开本地模板，零 D1 UUID 仅占位 | 真实秘密、个人账户/资源固定 ID |
| `.local/` | 私有初始化状态及生成 Wrangler 配置 | 提交到 Git、复制进镜像/公开日志 |

初始化脚本默认读取项目 `.env`，`CF_VIDEO_ENV_FILE` 可指向自己的私有文件，进程环境优先。文件须当前用户所有、普通非符号链接且权限 `0600`。`.env.operator.example` 与 `.env.example` 用途不同，不能把部署 Token 注入 Worker 或前端。

### Worker 运行时变量

先创建 bootstrap Worker，再在其面板逐个填写，测试与生产使用独立值。三项敏感字段必须选择 **Secret**，不是 Text：

| 名称 | 类型 | 要求/用途 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Secret | 自选强密码；test ≥10 字符，production ≥12 字符 |
| `SESSION_SECRET` | Secret | 至少32字符的安全随机值；签名管理员、访客历史及独立用途的观看授权 |
| `CF_USAGE_API_TOKEN` | Secret | 该环境专用、目标账户只读用量/容量凭据；权限见[费用](budget.md#中文) |
| `CLOUDFLARE_ACCOUNT_ID` | Text | 自有目标账户 ID，与绑定和部署一致 |
| `APP_ENV` | Text | `test` 或 `production` |
| `PROCESSING_ENABLED` | Text | 初始 `false`；`true` 仍需每任务报价/确认 |

发布前检查字段类型及账户/环境，不读取或打印 Secret 值。`keep_vars:true` 与 `--keep-vars` 保留面板值，但不会将 Text 自动变成 Secret。误将敏感值存为 Text 时，停止发布并由管理员修正类型、按暴露范围决定轮换；Wrangler 配置差异输出可能包含 Text 值。

`RESOURCE_*` 为非秘密项目范围标识，由发布解析器从目标 Worker 的已存在绑定生成，也可在私有配置中提供。首次 bootstrap 没有 DO/Container 标识，相关统计暂缺；后续正常部署读取实际绑定补齐。缺口不等于零。`BUILD_COMMIT` 来自构建，`VERSION` 为 `version_metadata` 绑定，不是手填运行时 Secret。

### 初始化凭据的权限

在 Cloudflare 个人资料 → API Tokens 创建专用管理凭据，按[官方 Token 权限目录](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)核对 User `API Tokens Read` 与 `API Tokens Write/Edit`。Account Token 路径还要求账户成员具备 API Token Provisioning 或 Super Administrator 能力，且不能授予超出其成员权限的能力；见[Account Token 指南](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)。不用 Global API Key，不把管理凭据注册给 Builds。

脚本为未来新建部署 Token 请求目标账户的 Workers Scripts Write、Workers R2 Storage Write、D1 Write、Workers Containers Write（或 Containers Write）、Cloudchamber Write、Workers CI Write、Workers Observability Write、Account Settings Read；只有配置自有 Zone 时才加该 Zone 的 Zone Read、DNS Write、Workers Routes Write。它们包括资源初始化/镜像发布所需写权限，不能用于运行时。用量 Token 的只读权限见[费用文档](budget.md#中文)。如官方目录缺项或账户角色不允许，停止并明确选择手动受限准备或 `--runtime-user`，不要把管理 Token 放进运行时绕过。

### 创建自己的测试实例

这是有状态的 Cloudflare 部署，**并非填写三个 Secret 的一键安装**。以下操作会创建资源/令牌，须在自己的已确认账户执行；应先审阅资源、权限和费用范围。

1. 将代码放入自己的 GitHub 仓库，确认 `origin` 指向该仓库，安装 Node.js ≥22.23.1、npm、Python 3 与 Git，并准备 GitHub 已授权凭据。运行 `npm ci`、`npm run check`。
2. 在账户启用所需产品，选择不与现有资源冲突的项目/Worker/数据库/桶名称。R2 桶须私有，关闭 `r2.dev`/公开域名，不为桶直接配置公开媒体域。
3. `cp .env.operator.example .env`，`chmod 600 .env`；在私有编辑器填写账户 ID 与专用 `CF_TOKEN_MANAGER_API_TOKEN`。管理 Token 用来创建受限 Token；它不进入应用。Account Token 路径还需创建账户 Token 的权限；不要为一个 403 盲目扩大凭据。
4. 按需设置 `CF_VIDEO_PROJECT_NAME`、`CF_VIDEO_WORKER_NAME`、`CF_VIDEO_DATABASE_NAME`、`CF_VIDEO_BUCKET_NAME`（默认项目名和 `-test` 名称）、`CF_VIDEO_LOCATION`（默认 `apac`）。先复核目标名字，脚本会复用同名资源，不能借此接管其他项目。
5. 不需要自定义域时，省略 `CF_VIDEO_ZONE_NAME`，使用该账户 workers.dev。需要自有 Zone 时设置如 `example.com`，另提供具有该 Zone 读取权限的 `CLOUDFLARE_API_TOKEN`；生成的部署 Token 会增加该 Zone 的 DNS/Routes 写权限。脚本不会自动绑定域名。
6. 在确认资源/Token 创建范围后运行 `python3 scripts/provision.py`。它创建/复用测试 D1、私有 R2、bootstrap Worker，生成项目部署 Token、独立 test/production 用量 Token 和会话密钥，保存秘密到私有 env，状态到 `.local/cloudflare.json`；不购买套餐、不填 Worker Secret、不启动 Container、不建生产资源。新 Token 默认 90 天，临时 Account Token provisioner 默认 7 天；可用 `CF_VIDEO_TOKEN_EXPIRES_ON` 指定前者期限。
7. 按上表手动填 Worker 六项变量。状态中 `active_session_variables.test`/`active_usage_variables.test` 记录的是本地变量**名称**，不是秘密值；未覆盖时取 `SESSION_SECRET_TEST` / `CF_USAGE_TEST_API_TOKEN`。在私有编辑器读取对应值后填入该 Worker。不要把变量名误填成秘密。
8. 到 Worker → Settings → Builds，授权 Cloudflare GitHub App 访问自己的仓库；Token 不能替代 GitHub App 授权。设置 `CF_VIDEO_REPOSITORY=your-user/your-repository` 可覆盖从 `origin` 推导的值，`CF_VIDEO_BRANCH=main` 指定发布分支。
9. `python3 scripts/builds.py ensure` 创建/复用仓库连接、Builds 部署 Token 注册和单分支触发器。默认构建 `npm run check`、部署 `npm run release:test`；自定义 Worker 的新触发器自动附带无秘密 Worker 名参数。已有触发器不会静默改写，须核对其命令/分支。已获所有者批准的公开仓库需显式 `CF_VIDEO_ALLOW_PUBLIC_REPOSITORY=true`；此开关仅允许对公开仓库建立部署连接，不改变可见性或 MIT 及第三方许可要求。
10. 在 Builds 设置确认部署 Token 与自有账户。Token 能见多个账户时加构建 Text `CLOUDFLARE_ACCOUNT_ID`；确认自定义 Worker 参数和触发分支。首次发布使用已审核的完整40位提交：`python3 scripts/builds.py trigger YOUR_REVIEWED_40_CHARACTER_COMMIT_SHA`，并用 `python3 scripts/builds.py status BUILD_UUID` 跟踪。
11. 核对 Builds 真正成功、Worker/镜像/绑定/health 的同次读回，再访问自有 HTTPS 入口的 `/admin`；检查登录、上传、原片预览、明确发布/下架、授权及统计。维持处理关闭，真实处理需要另一轮报价/授权。新账户全流程须独立实测；本地检查不代表安装验收。

仅准备基础资源时可用 `python3 scripts/provision.py --bootstrap-only`：不创建用量 Token，仍建测试基础资源/部署 Token/会话密钥。之后须自行准备合格只读用量 Token，或执行完整初始化。受权限限制选择 User Token 替代 Account Token 时用 `--runtime-user`，这必须是运维者明确选择，不应使用高权限管理/部署 Token 兜底运行时。

新建 Runtime Token 包含当前统计所需读取权限；**复用已存在 Token 不自动修改其权限**。较早 Token 可能缺 D1、Worker metadata 或 Builds 读取，需要运维者单独核对。脚本在官方目录缺少较窄 Worker metadata 名称时可使用 `Workers Scripts Read`；该范围较宽，选择前审阅实际权限。

### 配置迁移与自定义绑定

公开模板不包含个人账户/真实资源 ID 或个人健康域默认值。已有实例不应重新建资源或迁移数据：保持 Worker 名不变，发布解析器使用部署凭据 **GET-only** 读取既有 DB/MEDIA/DO/tag，生成忽略的 `.local/wrangler.generated.<env>.json`，再供 Wrangler 使用。脚本不读 Secret 值或改变云端绑定。账户不能唯一发现时明确提供 `CLOUDFLARE_ACCOUNT_ID`。

旧运维脚本不再固定作者电脑路径。现有操作员应显式设置 `CF_VIDEO_ENV_FILE` 指向原私有凭据文件，或配置自己的项目 `.env`，不要重新生成/复制公开秘密。保持 `.local/cloudflare.json` 的已记录 Token ID、active replacement 名和资源状态，避免中断后重复创建或回退已撤销值。

高级配置可用 `CF_VIDEO_CONFIG` 指向**完整**私有 Wrangler JSONC（如 `.local/wrangler.private.jsonc`），保留同样入口、资产路径、`DB`、`MEDIA`、`COORDINATOR`、`PROCESSOR`、`VERSION`、DO SQLite migrations、Container 调度/镜像及 Cron。私有配置在 Builds 中必须实际可用；仅在电脑上设置路径不会上传该文件。生产配置需在 Builds 的受保护配置步骤生成或以足够权限管理，不能把凭据写进该 JSONC。公开默认只有 test 环境，生产不会自动补建。

Wrangler 的 D1 全零 UUID只供 `--local`；不能直接拿它远程迁移。`npm run db:test` 使用同样解析器，是明确的远程写操作，日常发布已自动受保护应用迁移，无需重复执行。不要直接运行未解析模板的远程 `wrangler deploy`。

### 发布、并发与审查分支

GitHub CI 接收 PR 与 main push，只有读取仓库权限。Cloudflare Builds 触发由独立设置控制；上游常规仅 `main`。推送审查分支前核对实际 trigger 的 branch/path，不把 PR 分支接入当前环境。创建 PR 不等于授权合并或部署。

发布检查 runtime 类型、无活动/停止未知任务，取得 D1 发布 fence，应用远程迁移并执行完整 Wrangler deploy，携带环境、`--keep-vars`、精确提交 tag 和配套镜像。版本上传本身不证明镜像更新。

并发构建最多等待五分钟，不接管有效 lease。中断/失败的 fence保留，不能因为“看起来旧”清除；到期自动恢复只接受同一 Builds owner/commit 的官方 stopped 证据并再次原子核对无活动任务。没有可验证 owner 的旧/本地 lease需人工核对。读回共享 60 秒传播窗口，核对同次实际版本、标签、镜像/app关联、零活动/启动实例、所有绑定和 `/health` 的真实 `VERSION`；不能拼接新旧快照。

同提交重复构建只在迁移 ledger完整和上述完整读回成功时跳过 Wrangler并输出 `duplicate_already_deployed`。手动 trigger 先完整分页检索，再给自动推送最多 90 秒延迟窗口；复用已有 build不代表部署已核实，最终仍受 fence/读回约束。

### 自定义域与生产

自定义域属于 Worker，而非公开 R2。域名由 dashboard/API 管理时保留 `route`/`routes` 缺省；添加不完整列表可能替换面板已有域名。测试、生产与每个域名分别核对 HTTPS、登录、Cookie、发布及下架。

生产须另行准备 `env.production`、独立 Worker/D1/R2/DO、对应 runtime Secret/Text，以及 Builds/operator `PRODUCTION_RELEASE_AUTHORIZED=true`。预检在远程查询/迁移前拒绝缺失或与 test 重叠绑定。必须明确提供 `RELEASE_HEALTH_ORIGIN=https://video.example.com` 或该 Worker 自己已启用的 workers.dev origin；不能使用作者个人域名默认值。只接受 HTTPS origin，无凭据/路径/query/fragment/自定义端口，且须实际属于该 Worker，不接受重定向来证明发布。

首次生产发布、域名切换及旧入口关闭均需独立审阅。先记录现有 DNS/routes/domains 和恢复值；临时 workers.dev验证不代表最终域已切换。首次发布没有先前 V3 生产版本，应准备真实旧服务/维护入口的回退方案，不能把测试资源当生产恢复目标。

### 备份、轮换与回退

备份是运维者负责的明确流程，不是已实现的自动媒体备份承诺。变更前在私有记录保存 commit、Worker版本、镜像digest/map、绑定、域名；导出 D1，保存 R2 清单和需要恢复的对象副本。D1导出不包含 R2或DO状态。备份可能含私有标题、口令摘要、历史及 IP/UA，禁止进 Git/公开桶。恢复演练在隔离环境进行，未经演练不能声称可恢复。

代码回退需兼容保留的 schema及媒体模式，使用配套保留镜像；不自动回滚 migrations或恢复已删除文件。旧代码可能不支持 source/faststart版本、观看保护、发布 revision、历史 writeContext或现行上传政策，优先向前修复；必要时先明确切换到兼容且已验证版本或下架，保留原对象/证明/预留。先停止并核实需要中断的任务，回退不能清空未知消耗。

轮换用量 Token先验证新只读凭据，再管理员保存对应 Worker Secret，运行时读取成功后才撤销旧值。部署 Token轮换还需更新 Builds注册，不进入应用。管理员密码轮换使后台会话失效；会话密钥轮换还使访客签名身份/观看授权失效，可能让已有历史无法由旧 Cookie访问，应先说明影响。任何轮换、历史重写或删除均需自己的明确运维决定。

## English

### Prerequisites and configuration roles

The public project is **cf-video-studio**. Repository migration moves reviewed source, documentation and demonstration captures; it does not move cloud business data, switch existing Workers Builds repository connections or change live site settings. `wrangler.jsonc` and scripts retain legacy `cf-video-hub` defaults. Existing instances must keep their Worker/D1/R2/DO/Container identities; new installations should explicitly select their own resource names. This repository's CI validates only and does not publish.

Formal application/image releases run in **Cloudflare Workers Builds**. GitHub Actions only validates; local Docker publishing, GitHub video conversion and Worker-version-only uploads do not replace paired deployment. Prepare Workers Paid, enabled private R2, D1, SQLite DO, Containers and Builds. Original playback starts no Container, but the full deployment still declares its image. See [pricing](budget.md#english).

Worker runtime values, Builds deploy credentials and local operator inputs are separate. `.env.example` is the runtime checklist; `.env.operator.example` is operator-only and defaults to ignored project `.env`. `CF_VIDEO_ENV_FILE` selects another private file; process variables win. Credential files must be current-user owned, regular/non-symlink and mode 0600. `.dev.vars.test` is local Wrangler runtime; `.local/` holds private state/generated config. Neither env nor private state enters Git, Vite or Docker.

| Runtime binding | Cloudflare type | Requirement |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Secret | At least 10 test / 12 production characters |
| `SESSION_SECRET` | Secret | At least 32 secure random characters |
| `CF_USAGE_API_TOKEN` | Secret | Dedicated environment/account read-only usage/capacity token |
| `CLOUDFLARE_ACCOUNT_ID` | Text | Own target account, matching deployment/bindings |
| `APP_ENV` | Text | `test` or `production` |
| `PROCESSING_ENABLED` | Text | Initially `false`; enabling never replaces task confirmation |

Set them manually after bootstrap, separately per environment. Keep deploy/manager tokens out of runtime, passwords/passphrases out of Builds and all secrets out of `VITE_*`. `keep_vars` preserves values, not secret types. Release checks three Secret/three Text types before Wrangler can print differences. If a sensitive binding was Text, stop release, correct type and decide rotation based on exposure. Resource `RESOURCE_*` values are non-secret scope parameters generated from owned bindings; initial DO/Container metrics may be missing until a later normal release discovers them. `BUILD_COMMIT` is built and `VERSION` is metadata, not a manually entered secret.

### Provisioning credential permissions

Create a dedicated management token under Cloudflare profile → API Tokens, checking User `API Tokens Read` and `API Tokens Write/Edit` against the [official catalog](https://developers.cloudflare.com/fundamentals/api/reference/permissions/). Account Token provisioning also requires the account member's API Token Provisioning or Super Administrator capability; granted permissions cannot exceed their membership. See [Account Tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/). Use no Global API Key and never register the manager token with Builds.

New deployment tokens request target-account Workers Scripts Write, Workers R2 Storage Write, D1 Write, Workers Containers Write (or Containers Write), Cloudchamber Write, Workers CI Write, Workers Observability Write and Account Settings Read. An explicitly configured owned zone additionally receives Zone Read, DNS Write and Workers Routes Write. These cover provisioning/image delivery, never application runtime. Usage-token reads are listed in [billing](budget.md#english). Missing permissions/roles require an explicit restricted manual setup or User Token choice, not a manager-token runtime workaround.

### Install an independent test instance

This is stateful provisioning, not a three-secret one-click installer. The following creates resources/tokens only in your selected account; review resources, permissions and costs before execution.

1. Put the code in your own GitHub repository and verify `origin`. Install Node ≥22.23.1, npm, Python 3, Git and authorized GitHub credentials; run `npm ci` and `npm run check`.
2. Enable required products and choose unique owned resource names. Keep R2 private with r2.dev/public bucket domains off.
3. Copy `.env.operator.example` to `.env`, `chmod 600 .env`, privately fill your account and dedicated `CF_TOKEN_MANAGER_API_TOKEN`. The account-token path also needs permission to create Account API Tokens. Do not enlarge permissions blindly after a 403.
4. Optionally choose `CF_VIDEO_PROJECT_NAME`, `CF_VIDEO_WORKER_NAME`, `CF_VIDEO_DATABASE_NAME`, `CF_VIDEO_BUCKET_NAME` and `CF_VIDEO_LOCATION` (default `apac`). Defaults derive project/test names. The script reuses matching names: review them and never adopt unrelated resources.
5. Omit `CF_VIDEO_ZONE_NAME` for workers.dev. For an owned zone such as `example.com`, supply that name plus a zone-read `CLOUDFLARE_API_TOKEN`; the generated deploy token additionally gets that zone's DNS/Routes write scope. Bootstrap does not attach domains.
6. After approving creation scope, run `python3 scripts/provision.py`. It creates/reuses test D1/private R2/bootstrap Worker, deploy token, separate test/production usage tokens and session secrets, saving secrets privately and IDs/state in `.local/cloudflare.json`. It subscribes to no plans, fills no runtime Secret, starts no Container and creates no production resources. New tokens default to 90 days (`CF_VIDEO_TOKEN_EXPIRES_ON` override); the temporary account-token provisioner defaults to seven days.
7. Manually set the six Worker bindings above. State `active_session_variables.test`/`active_usage_variables.test` stores local **variable names**, not values; defaults are `SESSION_SECRET_TEST` / `CF_USAGE_TEST_API_TOKEN`. Privately retrieve the corresponding value, never enter the variable name as the secret.
8. Authorize the Cloudflare GitHub App for your repository under Worker → Settings → Builds. Tokens cannot grant App access. `CF_VIDEO_REPOSITORY=your-user/your-repository` overrides origin-derived identity; `CF_VIDEO_BRANCH=main` selects the release branch.
9. Run `python3 scripts/builds.py ensure` to create/reuse repository connection, Builds token registration and single-branch trigger. Defaults: build `npm run check`, deploy `npm run release:test`; newly created custom-worker triggers carry a non-secret Worker-name argument. Existing triggers are preserved: verify their command/branch. An owner-approved public repository needs `CF_VIDEO_ALLOW_PUBLIC_REPOSITORY=true`; this only permits a public-repository deployment connection and changes neither visibility nor MIT/third-party license requirements.
10. Verify Builds deploy-token/account settings. If the token sees multiple accounts, set Builds Text `CLOUDFLARE_ACCOUNT_ID`; verify custom Worker identity and branch. Release a reviewed full SHA with `python3 scripts/builds.py trigger YOUR_REVIEWED_40_CHARACTER_COMMIT_SHA`, then `python3 scripts/builds.py status BUILD_UUID`.
11. Verify actual build outcome and paired Worker/image/bindings/health readback, then sign in at your HTTPS `/admin`. Check uploads, source preview, explicit publication/unpublication, authorization and statistics. Keep processing off until separate exact-task review. A complete new-account installation requires its own end-to-end acceptance.

`--bootstrap-only` skips usage-token creation while still preparing test resources/deploy token/session secrets; provide qualified usage credentials separately or complete provisioning later. `--runtime-user` explicitly chooses a read-only User Token alternative when Account Token creation is unsuitable; management/deploy credentials are never runtime fallbacks. Newly created tokens include current read permissions; reused tokens are not silently upgraded. Older tokens may need explicit D1/metadata/Builds review. Where the narrower metadata label is unavailable, the script can select broader `Workers Scripts Read`: inspect its scope before choosing.

### Configuration migration

The public template now omits personal account/resource IDs and personal default health domains. Existing instances should retain resources/data. With the same Worker name, the resolver uses **GET-only** discovery of its DB/MEDIA/DO/tag and writes ignored `.local/wrangler.generated.<env>.json` for Wrangler. It reads no Secret value and changes no cloud binding. Supply `CLOUDFLARE_ACCOUNT_ID` when account discovery is ambiguous.

Existing operators must explicitly set `CF_VIDEO_ENV_FILE` to their original private credential file or use their own project `.env`; there is no author-machine path default. Preserve recorded Token IDs, active replacement variable names and resource state to avoid duplicate creation/revoked-value reuse.

`CF_VIDEO_CONFIG` may select a **complete private Wrangler JSONC**, for example `.local/wrangler.private.jsonc`. Preserve entry/assets, DB/MEDIA/COORDINATOR/PROCESSOR/VERSION, SQLite DO migrations, Container scheduling/image and Cron. A local-only file is not automatically available in Builds: prepare it in a protected configuration step. Never place credentials in it. The public template defines test only; production is not inferred.

The zero D1 UUID is for `--local`. `npm run db:test` resolves bindings and explicitly writes remote migrations; guarded release already applies them. Never deploy the unresolved template directly.

### Releases and review branches

GitHub CI handles PRs/main pushes with repository-read permissions. Builds triggers are separate, normally main-only upstream. Inspect actual branch/path filters before pushing a review branch; PR creation grants no merge/deploy authorization.

Release verifies runtime binding types and no active/unverified-stop task, acquires a D1 fence, applies migrations and performs full tagged Wrangler deployment with `--keep-vars` and its image. Concurrent builds wait at most five minutes without taking valid leases. Failed/uncertain fences remain; expiry recovery requires the same Builds owner/commit's official stopped evidence and an atomic no-task recheck. Legacy unverifiable owners require operator reconciliation, not unconditional clearing.

A shared 60-second propagation window verifies one actual version/tag/image/app pair, zero active/starting instances, all bindings and the same health VERSION. Old/new snapshots cannot be combined. Same-commit duplicate skip needs complete migration ledger plus full readback. Manual triggers fully paginate and allow up to 90 seconds for delayed automatic pushes; reusing a build ID alone never proves deployment.

### Domains and production

Attach domains to the Worker, not public R2. Leave `route`/`routes` absent when managed by dashboard/API; partial authoritative lists can replace dashboard additions. Check HTTPS, cookie isolation, media publication and unpublish on every entrance.

Production needs explicitly prepared `env.production`, independent Worker/D1/R2/DO, environment secrets and `PRODUCTION_RELEASE_AUTHORIZED=true` in Builds/operator settings. Preflight rejects missing/shared test resources before remote queries/migrations. Supply `RELEASE_HEALTH_ORIGIN=https://video.example.com` or that Worker's own enabled workers.dev origin. Only a verified owned HTTPS origin is accepted, without credentials/path/query/fragment/custom port or redirected attestation; no personal hostname default remains.

First production release, domain cutover and closing old entrances require separate review. Privately record DNS/routes/domains and rollback values. A staging workers.dev check does not prove final-domain cutover. With no previous V3 production version, prepare an actual previous-service/maintenance rollback, never test-resource substitution.

### Backups, rotation and rollback

Backups are an explicit operator duty, not an implemented automatic-media-backup promise. Privately record commit/version/image digest/bindings/domains; export D1 and preserve R2 inventory plus required object copies. D1 exports exclude R2/DO. Backups may contain private titles, passphrase hashes, history and IP/UA, so keep them out of Git/public buckets. Rehearse restoration in isolation before claiming recovery.

Code rollback needs compatible retained schema/media contracts and paired retained images. It does not reverse migrations or restore deleted files. Earlier code may lack source/faststart, watching protection, publication revisions, history context or current upload policy. Prefer forward fixes; otherwise explicitly switch to compatible verified versions or unpublish, preserving objects/proofs/reservations. Stop and verify interrupted tasks first; rollback never clears unknown consumption.

Verify new usage credentials before an administrator saves the Worker Secret, then confirm runtime access before revoking the old token. Deploy-token rotation also updates Builds registration, never runtime. Administrator password changes invalidate admin sessions; session-secret changes invalidate visitor signatures/watch grants and can prevent old-cookie access to history, so explain first. Rotation, history rewriting and deletion require explicit operator decisions.

## 官方参考 / Official references

- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) · [Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)
- [Container deployment](https://developers.cloudflare.com/containers/guides/deploy/) · [Direct Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) · [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
