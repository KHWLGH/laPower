# AGENTS.md

本文件为在 laPower 仓库工作的编码助手提供项目约定，适用于整个仓库；子目录中的 `AGENTS.md` 可在其作用范围内补充或覆盖这些约定。用户的明确指令优先。

## 项目与入口

laPower 是基于 Tauri v2 的 USB 电力监测与 USB-PD 协议分析桌面应用，支持 WITRN 与 POWER-Z 仪表。后端为 Rust，前端为原生 JavaScript ES Modules，图表使用 uPlot，esbuild 负责生成前端产物。

开始修改前，先查看相关模块与现有实现，并按任务阅读：

- `docs/DEVELOPMENT.md`：环境、构建、测试边界、国际化、发布与截图流程。
- `docs/ARCHITECTURE.md`：线程、IPC、数据流、协议、存储与安全边界。
- `docs/PERFORMANCE.md`：性能测量、数据完整性与基准限制。
- `docs/USAGE.md`：当前用户工作流、设置和文件格式。

命令和配置以 `package.json`、根目录 `Cargo.toml`、`src-tauri/tauri*.conf.json`、`biome.json`、`jsconfig.json` 和 `.github/workflows/ci.yml` 的实际内容为准。

| 路径 | 职责 |
| --- | --- |
| `src/` | 前端源码；`app.js` 装配应用，`shell.js` 管理视图，`state.js` 管理共享状态与类型 |
| `src/views/`、`src/ui/`、`src/styles/` | 页面、界面原语和分层样式 |
| `src-tauri/src/` | Tauri 命令、设备采集、流控制、文件读写和平台集成 |
| `crates/usbpd-parser/` | 独立 USB-PD 解析库 |
| `crates/witrn-hid/` | 独立 WITRN HID 协议库 |
| `crates/km003c/` | 独立 POWER-Z Bulk、AdcQueue 与 CDC 控制库 |
| `test/` | Node 内置测试运行器的核心测试 |
| `bench/` | 性能工具与受版本控制的基准 |
| `tools/showcase/` | 虚拟设备、浏览器预览和文档截图工具 |
| `scripts/`、`changelog/`、`docs/` | 构建与发布脚本、更新日志和多语言文档 |
| `temperature-example/` | 外部 TCP 温度服务示例 |

## 环境与常用命令

在仓库根目录执行命令。使用 Node.js 24、Rust 1.85+ 和 npm；提交并维护 `package-lock.json` 与 `Cargo.lock`，使用锁定在项目中的 Tauri CLI。

```sh
npm ci
npm run build
npx --no-install tauri dev
```

- `npm run build` 从 `src/` 生成 `out/`，合并 CSS，保留原生 JS 模块。
- `npm run build:dist` 生成压缩、合并后的发布前端。
- `npx --no-install tauri build` 构建本机安装包；Tauri 会自动执行发布前端构建。
- `npm run showcase:dev` 启动本机浏览器预览，默认地址为 `http://127.0.0.1:4173`。
- `npm run showcase:capture` 生成文档截图；首次使用前运行 `npx playwright install chromium`。

**Cargo 前置条件：** Tauri 在编译时内嵌 `out/`。在运行工作区的 `cargo build`、`cargo check`、`cargo test` 或 `cargo clippy` 前，先执行 `npm run build`。修改 `src/` 后也要重新生成 `out/` 并重新链接 Rust 二进制，才能验证原生应用中的新界面。项目未配置 `devUrl`，不要假设源码会热更新。

Windows 需要 MSVC 构建环境和 WebView2，macOS 需要 Xcode Command Line Tools；Linux 的系统依赖与 udev 配置见开发文档。平台专属行为应在对应平台验证。

## 实现与风格

- 保持改动聚焦于任务，沿用现有模块、命名与错误处理；保留用户已有修改，避免无关重构和全仓格式化。
- 前端保持原生 ES Modules，保留 `// @ts-check`，使用 JSDoc 描述类型。共享应用类型优先维护在 `src/state.js`，Tauri 全局声明在 `src/global.d.ts`。
- 纯数据处理模块保持不依赖 DOM 或 Tauri；界面逻辑放入现有视图、界面原语或装配模块。
- JavaScript 使用两空格缩进、单引号、分号和 120 字符行宽，以 Biome 为准；Rust 使用四空格缩进和 rustfmt。文件使用 UTF-8、LF 和末尾换行。
- 样式复用 `src/styles/tokens.css` 的令牌及现有分层结构；新增或修改界面时检查浅深主题、窄窗口、缩放和四种语言。
- 三个协议 crate 保持独立于 Tauri，版本通过工作区继承。应用代码采用 GPL-3.0-only，协议库采用 LGPL-3.0-or-later，保留第三方资源的许可证与来源声明。

## 数据、协议与运行边界

- 测量流的 `generation`、连续 `seq`、录制段边界、消费 ACK、背压和末包回执共同保证数据完整性。修改采集、暂停、断开或退出路径时，不把已发送视为已消费，不通过伪造 ACK、静默丢点或放宽退出校验掩盖错误。
- 停止后台任务时保持先生产者、后消费者的顺序；主线程不能同步等待正在向 WebView 发事件的线程。保留异步关闭与显式终态会话处理。
- PD 日志的 `seq` 对应报文下标，分隔行不占序号；清空或导入替换必须切换 `generation`，避免历史文件与实时流混合。
- 原始测量数据使用分块列存储。图表降采样只改变显示投影，光标和统计仍使用原始样本；保护固定快照、缺测区间、录制段和能量积分语义。
- 修改 CSV、PD 捕获或恢复文件时维护历史格式兼容、元数据和分块读写约束。失败时保留可恢复数据，不能为了通过测试删除恢复路径。
- 新设备或固件的字节布局、量程与时序必须由实机样本确认；浏览器模拟结果不能证明硬件协议正确。
- 保持现有 CSP、最小 Tauri capabilities 和受控文件句柄边界。脚本与样式使用本地文件，前端运行依赖保持离线内置，不引入 CDN 加载。
- 更新检查保持用户手动触发，项目链接由后端校验；不要在启动或进入设置时新增自动网络请求。

## 验证与测试边界

按改动范围运行相关现有检查；纯文档修改检查内容、路径、链接和差异即可。代码修改先运行对应领域测试；交付前覆盖受影响的核心检查，不能把未运行的检查记为通过。

```sh
npm run build
npm test
npm run typecheck
npm run lint
npm run components:check
cargo fmt --check --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

- 单独运行前端测试：`node --test test/measurement.test.js`，按领域替换文件名；协议库可用 `cargo test -p usbpd-parser` 等命令定向检查。
- 普通功能增删改、UI 布局、样式、文案和选项变化默认不新增回归测试。仅在数据丢失或损坏、协议兼容、崩溃或死锁、安全边界、发布构建不变量或已确认的高影响历史缺陷涉及的场景补充测试。
- 优先扩展现有核心测试，不为每个小功能新增测试文件、设计文档或 CI job；不要使用仅复述实现的断言。
- 修改 `usbpd-parser` 或 `witrn-hid` 的 feature 门时，按 CI 的 `crate-features` 任务补跑非默认组合的测试与 Clippy。
- 修改前端构建、资产或性能基准时，按需执行 `node bench/packaging.mjs` 与 `node bench/core.mjs --verify-baseline`；性能优化使用同机前后对照，不能手改基准或降低阈值来消除退化。
- 性能 benchmark、Playwright 检查和真机长跑按需运行，不扩展为每次修改必跑的浏览器回归。区分 Node、浏览器模拟、原生 GUI 与真实仪表的验证结果。

## 国际化与文档

- 用户可见文案使用 `src/i18n.js` 的 `t(key, params)`；`src/i18n-messages.js` 的四列依次为英文、简体中文、繁体中文、日文，英文为缺词回退。使用语义键名并保持各语言插值参数一致。
- 静态 HTML 使用现有 `data-i18n*` 属性和英文兜底；包含图标或控件时只翻译文字节点。语言切换不能重新连接设备、清空记录或重建会话数据。
- 后端错误沿用 `{code, params, detail?}`，由前端翻译并保留原始诊断。PD 标准名称、原始报文、单位和文件字段保持兼容。
- 用户文档以简中为内容基准。README、使用指南和开发指南维护四语；架构、性能、协议库 README 与更新日志维护中英双语。相关行为变动时同步对应内容，优先使用同语言链接。
- 不增加翻译哈希、逐条同步检查或文档专用 CI；翻译内容人工校对，不使用翻译 API 生成发布日志。

## 依赖、版本与发布

- 修改 Cargo 运行依赖或内置前端组件后，运行 `npm run components:generate` 更新并提交 `src/third-party-components.json`，再运行 `npm run components:check`。生成脚本依赖锁定的 Cargo 图，缺少缓存时需要联网；不要手改生成清单。
- 版本统一使用 `npm run version:set -- X.Y.Z`，不逐个手改清单或锁文件。发布准备使用 `npm run release:prepare -- X.Y.Z --date YYYY-MM-DD --dry-run` 预览，确认版本和日期后再执行去掉 `--dry-run` 的命令。
- 日常更新日志维护 `changelog/unreleased/zh-CN.md`；发布前整理中文并生成、校对英文。历史正文保存在 `changelog/<version>/`，根目录 `CHANGELOG.md` 只维护索引。
- 每次发布准备必须重新生成并逐张检查四语 × 浅深主题 × 四页面的完整 32 张截图，保存在 `docs/screenshots/`，同步四语 README 的截图说明。详细顺序见开发文档的发布流程。
- 正式发布的安装包统一由 GitHub Actions 构建、校验并上传。本地完成发布文案、截图和必要质量检查后推送版本 Tag，无需本地预构建安装包。
- 推送 `vX.Y.Z` Tag 会触发 CI 打包并自动公开 Release；只在用户明确要求发布时执行。编写文档或普通功能修改不自动升版、归档日志或发布。

## 生成文件与交付

- 修改源文件，构建脚本生成 `out/`；`target/`、`dist/`、`node_modules/`、`output/`、`bench/results/` 与本地工具缓存不提交。
- `src/vendor/` 是随包内置的第三方资源，`src/third-party-components.json`、`bench/baselines/` 和 `docs/screenshots/` 是有意跟踪的文件；按各自维护流程更新，不能一律当作可删缓存。
- 开发模拟和截图逻辑保持在 `tools/showcase/`，不能进入 `src/` 或安装包。
- 提交前查看 `git diff` 和 `git status`，确认没有无关变更。提交标题沿用现有 `fix:`、`feat:`、`docs:` 等简洁前缀。
- 交付时说明实际改动、运行的验证、未验证的平台或硬件路径；遇到环境限制时记录具体原因。
