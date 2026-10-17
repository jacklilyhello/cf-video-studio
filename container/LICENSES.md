# Container 依赖与许可 / Container dependencies and licenses

[简体中文](#简体中文) · [English](#english) · [项目依赖 / Dependencies](../docs/dependencies.md)

## 简体中文

本镜像运行项目的 Node.js 处理程序，通过独立进程调用 FFmpeg，没有将处理程序链接到 FFmpeg 库。这不改变镜像中 FFmpeg 可执行文件及其依赖的许可要求。

| 组件 | Dockerfile 选择 | 许可与依据 |
| --- | --- | --- |
| Node.js | 官方 `node:22.23.3-bookworm-slim`，固定多平台镜像摘要 | MIT，附带依赖的独立声明；[该版本 LICENSE](https://github.com/nodejs/node/blob/v22.23.3/LICENSE) |
| Debian 12 | 官方 Node Bookworm slim 基础镜像 | 各软件包自己的许可；构建镜像中的 `/usr/share/doc/*/copyright` |
| FFmpeg | Debian `7:5.1.9-0+deb12u1` | Debian 构建启用 GPL 组件；不能将该构建称为仅 LGPL。以镜像的 copyright、实际版本和 buildconf 记录为准 |
| libx264 | Debian FFmpeg 的运行时依赖 | GPL-2-or-later；用于管理员逐任务确认的 H.264 转码；[Debian 软件包与源代码](https://packages.debian.org/bookworm/libx264-164) |
| 项目处理程序 | `container/processor.mjs` | 项目自有代码采用 [MIT](../LICENSE)；FFmpeg 及镜像依赖保留各自许可 |

[FFmpeg 官方说明](https://ffmpeg.org/legal.html)解释 GPL 组件对 FFmpeg 本身的影响。[Debian FFmpeg 页面](https://packages.debian.org/bookworm/ffmpeg)提供选定版本的上游源码、Debian 修改、源包描述和版权文件入口。镜像或可执行文件的再分发须保留许可与声明，并提供符合所选 GNU 许可要求的对应源代码取得方式；仅列出一个上游首页链接不能代替这些要求。应保存与实际二进制完全对应的源包和构建记录，避免未来软件源更新后无法对应。

Dockerfile 在**构建时**生成以下记录，保留包内版权文件，并复制 GNU 许可文本：

| 镜像内位置 | 内容 |
| --- | --- |
| `/opt/licenses/project-LICENSE` | 项目处理程序的完整 MIT 许可证与版权署名 |
| `/opt/licenses/packages.tsv` | 实际安装的软件包与版本 |
| `/opt/licenses/ffmpeg-version.txt` | FFmpeg 实际版本 |
| `/opt/licenses/ffmpeg-buildconf.txt` | FFmpeg 实际构建选项 |
| `/opt/licenses/ffmpeg-copyright` | Debian FFmpeg 版权和许可说明 |
| `/opt/licenses/GPL-2`、`GPL-3`、`LGPL-2.1` | GNU 许可文本 |
| `/usr/share/doc/*/copyright` | 软件包自己的版权和许可说明 |

Node 补丁版本、基础镜像摘要和 FFmpeg 软件包版本固定，但 Debian 传递依赖没有全部固定，不能承诺逐字节可复现。新镜像应保存自己的摘要、Git 提交和上述实际记录；源码中的固定版本不是对某个已部署镜像的验证结果。依赖升级需重新构建、核对记录及重复媒体验证。处理任务运行时不会安装软件包或下载程序。

公开源码不等于已经验证镜像分发的全部许可要求；分发前应检查实际镜像及对应记录。本文件也不授予编码媒体或编解码专利的权利。

## English

The image runs the project's Node.js processor and invokes FFmpeg as a separate executable without linking the processor to FFmpeg libraries. This does not remove the license requirements for the executable and dependencies included in the image.

The Dockerfile selects official `node:22.23.3-bookworm-slim` with a pinned multi-platform digest, Debian 12 and FFmpeg `7:5.1.9-0+deb12u1`. Node.js is MIT with bundled third-party notices; Debian packages retain individual licenses. Debian's FFmpeg build includes GPL components and must not be described as LGPL-only. Its libx264 runtime dependency is GPL-2-or-later and is used for individually confirmed H.264 transcodes. Project-owned processor code uses [MIT](../LICENSE); FFmpeg and image dependencies retain their own licenses. The table above links the selected upstream sources.

[FFmpeg's official explanation](https://ffmpeg.org/legal.html) describes the effect of GPL components on FFmpeg. [Debian's package page](https://packages.debian.org/bookworm/ffmpeg) provides the selected upstream source, Debian changes, source-package description and copyright-file links. Redistributing images or executables requires retaining license notices and making corresponding source available as required by the applicable GNU licenses; a generic upstream homepage link is insufficient. Preserve sources and build records that correspond to the exact binaries so future repository updates do not break that correspondence.

At **build time**, the Dockerfile creates the records listed above under `/opt/licenses/`, copies GNU license texts and retains package copyright files under `/usr/share/doc/*/copyright`. They describe the packages, FFmpeg version and configuration actually installed in that image. The image also includes the project processor’s full MIT license and copyright notice at `/opt/licenses/project-LICENSE`.

The Node patch version, base digest and FFmpeg package version are pinned. Debian transitive dependencies are not all pinned, so byte-for-byte reproducibility is not promised. Retain each new image's digest, Git commit and actual build records; a pinned source configuration is not verification of a deployed image. Dependency updates require rebuilding, checking those records and repeating media validation. A running media task neither installs packages nor downloads programs.

Source publication does not establish complete compliance for image redistribution; inspect the actual image and corresponding records before distributing it. These notices do not grant rights to encoded media or codec patents.
