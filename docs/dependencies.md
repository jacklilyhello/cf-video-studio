# 依赖与许可 / Dependencies and licenses

[简体中文](#简体中文) · [English](#english) · [中文首页](../README.md) · [English README](../README.en.md)

## 简体中文

### 项目代码的授权状态

cf-video-studio 的项目自有代码与文档采用 [MIT 许可证](../LICENSE)，保留 `Copyright (c) 2026 lily Sally`。项目自有界面与原创演示截图随项目按 MIT 提供；第三方品牌与组件仍保留各自权利。`package.json` 的 `private: true` 仅防止意外发布到 npm；它不是许可证，也不决定 GitHub 仓库是否公开。以下第三方组件保留各自许可，不能统一改称 MIT。

### 浏览器与开发依赖

以下版本及许可来自当前 `package-lock.json`，并核对了本机已安装直接依赖的 `package.json` 与许可文件。

| 范围 | 组件 | 许可 |
| --- | --- | --- |
| 浏览器运行时 | React / React DOM 19.3.0、scheduler 0.28.0 | MIT |
| 浏览器播放器 | hls.js 1.7.3 | Apache-2.0；另保留内含代码的上游声明 |
| 浏览器构建辅助代码、开发工具 | Vite 8.3.4 / React Vite plugin 6.1.2 | MIT |
| 开发工具 | TypeScript 7.0.2 | Apache-2.0 |
| 测试工具 | Vitest 5.0.4 | MIT |
| 配置解析 | jsonc-parser 3.3.1 | MIT |
| Cloudflare 工具与类型 | Wrangler 4.150.0 / Workers types 5.20261013.1 | MIT OR Apache-2.0 |
| React 类型 | @types/react 19.3.0 / @types/react-dom 19.3.0 | MIT |

浏览器资源由 Vite 本地打包，访客不依赖外部播放器 CDN。[浏览器第三方声明](../web/public/third-party-notices.txt)包含 React 家族、hls.js 及其内含 DASH Industry Forum、vtt.js、utf.js 声明，以及 Vite 浏览器辅助代码的许可。构建会将其原样复制到 `/third-party-notices.txt`；再分发构建产物时一并保留该文件。

完整锁文件还包含平台可选依赖与传递依赖。比如 Lightning CSS 及其平台包标为 MPL-2.0，sharp/libvips 的部分预编译平台包标为 LGPL-3.0-or-later 或组合许可；还存在 ISC、BSD-3-Clause、0BSD、CC0-1.0 等许可。它们主要属于开发／部署工具链，锁文件中存在不等于全部进入浏览器或 Worker。软件包可能自带其他组件与声明，不能把直接依赖表当作完整许可清单；分发工具链或镜像时应检查实际包含的软件及其原始许可。

`package-lock.json` 固定 npm 图谱、版本和完整性摘要。升级后应核对实际安装的软件、传递／可选依赖、许可文件、漏洞检查及浏览器第三方声明；不得只沿用旧表。

### 处理镜像与展示素材

处理镜像使用 Node.js、Debian 和 FFmpeg，具体固定版本、GNU 许可、源代码取得方式及镜像记录见 [Container 许可说明](../container/LICENSES.md)。Node 处理程序通过独立进程调用 FFmpeg，没有链接 FFmpeg 库；该事实不免除分发 FFmpeg 可执行文件或依赖时的义务。只公开项目源码与分发预构建镜像应分别核对。

项目 Logo 为代码内的图形；文档界面截图来自项目自身页面。截图说明及演示素材来源见 [界面预览](screenshots/README.md)。上传、发布或再分发媒体须取得相应权利；软件依赖许可不授予视频、音频、字体、商标或编解码专利权。

## English

### Project-owned code

Project-owned cf-video-studio code and documentation use the [MIT License](../LICENSE), retaining `Copyright (c) 2026 lily Sally`. Project-owned UI and original demonstration captures are provided with the project under MIT; third-party brands and components retain their rights. `private: true` in `package.json` prevents accidental npm publication; it is not a license and does not set GitHub visibility. The third-party components below retain their own licenses and must not all be described as MIT.

### Browser and development dependencies

The versions and licenses in the table above come from the current `package-lock.json`, checked against installed direct-dependency manifests and license files. React, React DOM and scheduler are MIT; hls.js is Apache-2.0 with additional upstream notices; Vite and its React plugin are MIT; TypeScript and jsonc-parser are Apache-2.0 and MIT respectively; Vitest is MIT; Wrangler and Workers types offer MIT OR Apache-2.0; React type packages are MIT.

Vite bundles browser assets locally; visitors do not load the player from a third-party CDN. [Browser third-party notices](../web/public/third-party-notices.txt) preserve React-family licenses, hls.js and its included DASH Industry Forum, vtt.js and utf.js notices, and the Vite browser-helper license. The build copies this file unchanged to `/third-party-notices.txt`. Keep it with redistributed browser builds.

The lockfile also includes optional platform packages and transitive dependencies. Lightning CSS packages use MPL-2.0; some prebuilt sharp/libvips platform packages use LGPL-3.0-or-later or combined licenses. Other recorded licenses include ISC, BSD-3-Clause, 0BSD and CC0-1.0. These mainly belong to development/deployment tooling; appearing in the lockfile does not mean every package ships in the browser or Worker. Packages may carry further bundled-component notices, so the direct-dependency table is not a complete license inventory. Review the software actually distributed and its original notices when shipping tools or images.

`package-lock.json` pins the npm graph, versions and integrity hashes. Upgrades require checking installed, transitive and optional packages, license files, vulnerability results and browser notices instead of reusing an outdated table.

### Processing image and presentation assets

The processing image uses Node.js, Debian and FFmpeg. [Container license notes](../container/LICENSES.md) describe pinned versions, GNU licenses, source availability and image records. The Node processor invokes a separate FFmpeg executable without linking to FFmpeg libraries; this does not remove obligations when distributing that executable or its dependencies. Review source publication and prebuilt-image distribution separately.

The project logo is a code-defined shape and documentation screenshots show the application's own pages. See [screenshot and demo sources](screenshots/README.md) for their provenance. Obtain the necessary rights for uploaded, published or redistributed media. Software dependency licenses do not grant rights to video, audio, fonts, trademarks or codec patents.
