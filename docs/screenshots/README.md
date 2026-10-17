# 界面截图 / Interface captures

[项目首页](../../README.md) · [English README](../../README.en.md) · [中文](#中文) · [English](#english)

## 中文

这些截图于 **2026-10-16（Asia/Singapore）** 使用 macOS 的真实 **Safari 27.0.1** 拍摄，运行本仓库的 Worker、React 前端及独立本地 D1/R2。界面与本次文档对应；后台的 `development` 是本地构建标识。

| 文件 | 实际页面 | 展示内容 |
| --- | --- | --- |
| [welcome-light.jpg](welcome-light.jpg) | `/` | 浅色欢迎页与可配置站点名称 |
| [room-dark.jpg](room-dark.jpg) | `/video?video=demo-film-1` | 深色原生播放器，原创演示片实际播放至结束 |
| [admin-overview.jpg](admin-overview.jpg) | `/admin/overview` | 视频、存储、播放摘要及关闭的处理开关 |
| [admin-library.jpg](admin-library.jpg) | `/admin/library` | 已发布演示原片与未发布的示例目录 |
| [admin-storage.jpg](admin-storage.jpg) | `/admin/storage` | 原片与共用原片的播放记录，不重复计入文件空间 |
| [admin-usage.jpg](admin-usage.jpg) | `/admin/usage` | 项目记录及未配置官方统计范围的真实缺口 |

站点名「Moonwater · 演示」、影片名称、目录大小和项目统计仅供展示。三个未发布条目是种入隔离数据库的示例元数据，不是实际上传或处理验收。播放器中的「月色山水 · 原创演示」是专为截图创作的 10 秒 H.264 无声几何动画，由本机 AVFoundation 编码，使用标准 MP4 电影播放轨道标志；不含第三方影片、音乐、照片或人物。

该演示片在 Safari 实际完成了播放、拖动及无音轨核对，再由项目自身流程建立原片播放版本并在**本地演示**发布。没有启动 Container，也没有修改线上媒体、访客记录、预算或发布状态。这些图片不代表 Cloudflare 云端处理、独立新账户安装、可信 HTTPS 登录或生产发布验收。

本地 HTTP 演示使用仅监听回环地址的临时代理，转发本地 Worker 签发的随机演示会话，以适配 Safari 的 Secure Cookie 限制；正式应用的鉴权与 Cookie 属性没有修改。代理、会话、数据库、视频和原始窗口截图均不作为公开素材提交。

最终 JPEG 只保留网页内容：裁去 Safari 工具栏、标签栏与窗口边缘，等比缩至 1600 像素宽并压缩、移除元数据。没有修改页面文字、业务数值或成功/失败状态，没有拼接或生成界面。最终图片已逐张检查排版和隐私；不包含密码、Token、Cookie、账户标识、访客 IP 或私人媒体。

项目自有界面与本目录的原创演示截图随项目按 [MIT 许可证](../../LICENSE) 提供，保留 `Copyright (c) 2026 lily Sally`；演示视频本身不包含在仓库中。Safari、Cloudflare 及其他第三方品牌保留各自权利。第三方软件声明见[应用依赖](../dependencies.md)。

## English

Captured on **16 October 2026 (Asia/Singapore)** in real macOS **Safari 27.0.1**, running this repository's Worker and React UI with isolated local D1/R2. The UI corresponds to this documentation revision; `development` identifies the local build.

The table above maps the six stable image files to their actual routes: light welcome, dark player, administrator overview, library, storage and usage. “Moonwater · 演示”, catalog names/sizes and project metrics are demonstration data. Three unpublished entries are seeded metadata, not evidence of upload or processing acceptance.

The player shows an original ten-second silent geometric H.264 animation authored for these captures, encoded locally with AVFoundation and standard MP4 movie-playback track flags. It uses no third-party film, music, photography or likeness. Safari actually played it to completion and sought it; after checking the silent track, the application's own flow created and published a source playback version **only in the local demonstration**.

No Container ran and no live media, visitor records, budget or publication state changed. The images do not establish cloud processing, independent-account installation, trusted-HTTPS sign-in or production-release acceptance. A temporary loopback-only HTTP bridge forwarded the local Worker's randomly issued demo sessions for Safari's Secure Cookie restriction; application authentication and Cookie attributes were unchanged. The bridge, sessions, database, video and raw window captures are not committed.

Final JPEGs contain webpage content only: Safari chrome and window edges were cropped, images proportionally resized to 1600 pixels wide, compressed and stripped of metadata. No text, business values or success/failure states were edited; no UI was generated or composited. Every final image was individually checked for layout and privacy. They contain no passwords, tokens, cookies, account identifiers, visitor IPs or private media.

Project-owned UI and the original demonstration captures in this directory are provided with the project under the [MIT License](../../LICENSE), retaining `Copyright (c) 2026 lily Sally`; the demonstration video itself is not included. Third-party brands retain their rights. See [dependency notices](../dependencies.md).
