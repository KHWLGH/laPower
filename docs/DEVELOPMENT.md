[English](en/DEVELOPMENT.md) | **简体中文** | [繁體中文](zh-TW/DEVELOPMENT.md) | [日本語](ja/DEVELOPMENT.md)

← 返回 [README](../README.zh-CN.md)

# 开发与构建

- [环境要求](#环境要求)
- [构建与运行](#构建与运行)
- [发布流程](#发布流程)
- [质量检查](#质量检查)
- [测试与回归边界](#测试与回归边界)
- [语言选择](#语言选择)
- [词典维护与翻译检查](#词典维护与翻译检查)
- [无头测试接口](#无头测试接口)
- [开发展示工具](#开发展示工具)
- [性能测量](#性能测量)
- [CI 门禁](#ci-门禁)
- [Linux 自行编译](#linux-自行编译)
- [macOS 自行编译](#macos-自行编译)
- [外部温度服务](#外部温度服务)
- [参与贡献](#参与贡献)

## 环境要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| Rust | 1.85+ | 工作区 `rust-version` |
| Tauri CLI | 2.12.1 | npm 锁定的 `@tauri-apps/cli`，通过 `npx --no-install tauri` 调用 |
| Windows | 10 / 11 | 当前开发与验证平台 |
| macOS | 12+ | 最低部署目标；CI 使用 macOS 26，旧系统兼容性需实机验证 |
| Node.js | 24 | CI、lint / typecheck / test / 前端产物 |

项目使用 npm 并提交 `package-lock.json`（CI 使用 `npm ci`）。前端为原生 ES Modules，`frontendDist` 指向生成的 `out/`。虽然 Node 不参与 Rust 编译，但 `npm run build` 必须先于 `cargo build`、`cargo test`、`cargo check` 和 `cargo clippy`；修改 `src/` 后需重建 `out/` 并重新链接 Rust 二进制。

## 构建与运行

```bash
git clone https://github.com/KHWLGH/laPower.git
cd laPower
npm ci
npm run dev
```

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 自动生成开发前端并启动原生应用 |
| `npm run dev:web` | 启动模拟设备浏览器预览（可加 `-- --port 4174` 改端口） |
| `npm run build` | 单独生成供 Cargo 内嵌的开发前端 `out/` |
| `npm run build:app` | 自动生成压缩前端并构建本机安装包 |

`dev` 的 `beforeDevCommand` 与打包的 `beforeBuildCommand` 会自动构建对应前端，无需手动前置运行 `npm run build` 或 `npm run build:dist`；但直接执行 Cargo 检查前仍须先生成 `out/`。开发模式不提供前端热更新，修改 `src/` 后需重启 `dev` 或重新链接。本机发布产物默认输出到 `target/release/bundle/`，CI 按目标输出到 `target/<target>/release/bundle/`。

### Windows 构建脚本被杀毒软件拦截

若 Cargo 在运行 `libc` 的 `build-script-build` 前报「拒绝访问（os error 5）」或文件占用（os error 32）且被杀毒软件拦截，受影响的仅为编译期辅助程序而非应用运行时。已在本机 Windows/MSVC 与 Kaspersky 环境验证 `libc 0.2.189` 在 `opt-level = 2` 时触发拦截、设为 `0` 时正常。

根目录 `Cargo.toml` 为此在 `[profile.dev.package.libc]` 设置 `opt-level = 0`（同时作用于 dev 与 test，不影响 release 及其余依赖；`profile.dev.build-override` 无法覆盖已有 `package."*"`）。更新配置后直接重跑构建即可，无需清空 `target/`。若仍被拦截，请保留杀毒软件的检测名、路径与哈希以便核查反馈。

### 分级清理

各档累加包含前一档并在删除完成后返回，默认保留 Rust 编译缓存、依赖与安装包：

| 命令 | 删除范围 |
| --- | --- |
| `npm run clean` | `out/`、`output/`、`bench/results/`、根目录和 `src/` 下的 `.playwright-cli/`、`src-tauri/gen/schemas/` |
| `npm run clean:incremental` | 再清理 `target/` 与 `src-tauri/target/` 中 `debug/release` 的增量缓存（含交叉编译目标） |
| `npm run clean:build` | 再清理完整 `target/`、`src-tauri/target/` 与 `dist/` |
| `npm run clean:all` | 再清理 `node_modules/`（下次开发前需先运行 `npm ci`） |

支持预览而不实际删除：

```bash
npm run clean:build -- --dry-run
```

清理器在执行前检查全部目标及 Git 跟踪状态，若目标或祖先目录为符号链接 / junction 则拒绝删除；最多并行处理 4 个目录，占用错误有限重试，最终失败返回非零退出码。请先关闭开发、构建与预览进程；已跟踪截图、`bench/baselines/`、源码、锁文件及仓库外缓存（含自定义 `CARGO_TARGET_DIR`）不会被清理。

### 运行组件清单

关于页使用随包生成的 `src/third-party-components.json` 组件清单与按需加载的 `src/legal-notices.json` 全文目录。修改 Cargo 运行依赖、内置资源或许可输入后，运行 `npm run components:generate` 并提交产物与补充材料，再用 `npm run components:check` 校验（勿手改生成文件）。

脚本通过离线 `--locked` 的 Cargo metadata/tree 保守合并四个桌面目标的 normal 依赖（排除工作区、纯开发/构建及过程宏包；依赖缓存缺失时需先联网 `cargo fetch --locked`）。许可全文来自 [`COPYRIGHT`](../COPYRIGHT)、[`LICENSE`](../LICENSE)、[`LICENSE.LGPL-3.0`](../LICENSE.LGPL-3.0)、本地 Cargo 缓存及 `licenses/materials.json` 登记的预存补件（记录版本、revision、上游路径与 SHA-256；仅经审核的固定版本例外可绕过缺件检查）。普通前端构建只校对并复制已有清单，不调用 Cargo 或网络。

发布 Tag 的源码归档不含本地缓存或系统 SDK，从归档离线/复现构建前需通过 `cargo fetch --locked` 与 `npm ci` 获取锁定的依赖源码与工具链。自有贡献版权行固定为 `Copyright (C) 2026 KHWLGH`，不因 Git 作者推定转让，范围细节见 [`COPYRIGHT`](../COPYRIGHT)。

## 发布流程

日常仅维护 `changelog/unreleased/zh-CN.md`。发布前由开发助手整理合并重复项、编写面向用户的简中说明并生成校对 `en.md`（不要求逐句对应，不使用翻译 API）。

```bash
npm run release:prepare -- 0.3.0 --date 2026-11-22 --dry-run
npm run release:prepare -- 0.3.0 --date 2026-11-22
npm run release:notes
npm run showcase:capture
```

将示例版本与日期替换为目标值。`release:prepare` 校验双语草稿非空且目标版本目录不存在，随后归档至 `changelog/<version>/`、同步版本、更新根目录 `CHANGELOG.md` 索引并生成 `dist/release-notes.md`，最后清空草稿（`--dry-run` 仅预览不写盘；失败时保留草稿以便排查）。Release 说明默认展开英文并折叠简体中文，均附带三平台安装说明；命令不自动提交、打 Tag 或发布。

### 发布前更新文档截图

每次发布须按以下顺序完成：**同步版本与归档更新日志 → 生成并逐张检查截图 → 运行核心质量检查 → 提交改动 → 推送版本 Tag → 由 GitHub Actions 构建发布**（无需本地预编译安装包；若版本已归档则直接重跑 `npm run showcase:capture`）。

首次使用先执行 `npx playwright install chromium`（Linux 缺少依赖时用 `--with-deps`）。截图默认生成 **72 张**（40 张主界面 + 32 张报告样式），写入 `docs/screenshots/<language>/`：

- 基础 32 张（必须全量更新）：四语言 × 浅/深主题 × 监控、PD 分析、协议控制、设置（保留完整标题栏、120 秒统一模拟数据、一致版本号）。
- 额外 40 张：协议检测主界面 8 张 + 16:9 图片报告、长图、视频帧与协议检测报告样式 32 张。

生成后逐张核对语言、主题、文字截断、图表、协议状态、导航与版本一致性，同步更新四语言 README 中的版本号与截图引用后一并提交。

### 文档维护范围

README、使用指南和本开发指南维护中（简/繁）、英、日四语；技术架构、性能说明、协议库 README 和更新日志维护中英双语（0.2.2 及以前仅保留简中，不补英文占位页）。主要文档优先链接同语言版本，繁体页面对次要文档优先链接简中，日文页面优先链接英文并注明语言。不增加翻译哈希或文档专用 CI。

### 更新日志链接

版本正文存放于 `changelog/<version>/`，根目录 `CHANGELOG.md` 仅作为版本索引并保留原锚点。正文内部相对链接以文件所在目录为基准（如 `../../docs/USAGE.md`），GitHub Release 渲染时自动固定到对应版本 Tag。

### 单独设置版本

仅需同步版本号而不归档日志时使用：

```bash
npm run version:set -- 0.3.0
```

命令校验 `X.Y.Z` 格式后原子同步 `package.json`、`package-lock.json`、`Cargo.toml`（`[workspace.package] version`）、`Cargo.lock` 与 `src-tauri/tauri.conf.json`（Rust 成员 crate 通过 `version.workspace = true` 继承；重复同版本不产生改动，也不创建提交或 Tag）。`test/version-sync.test.js` 持续验证版本一致性。

### 手动构建与首次验收

在 GitHub **Actions → CI → Run workflow** 选择分支或 Tag 可手动触发打包（不会创建或公开 Release）：

| 目标 | Runner | Rust target | 安装包 |
| --- | --- | --- | --- |
| Windows x64 | `windows-2022` | `x86_64-pc-windows-msvc` | MSI、NSIS EXE（`_setup`）、便携 ZIP |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | DEB、RPM、AppImage |
| macOS Intel | `macos-26-intel` | `x86_64-apple-darwin` | DMG |
| macOS Apple Silicon | `macos-26` | `aarch64-apple-darwin` | DMG |

四目标全部成功后汇总 `release-packages`（含全部八个产物及 `SHA256SUMS`，可用 `sha256sum -c SHA256SUMS` 校验）。Windows 便携 ZIP 命名为 `laPower_<版本>_windows-x64_portable.zip`，解压后直接运行 `laPower.exe`（需 WebView2 Runtime，配置仍读取标准用户数据目录）。macOS 构建显式传递 `--bundles app,dmg` 以保留 `.app` 供签名与元数据校验（仅发布 DMG）。首次启用自动发布前，须在实机验收 Windows、两架构 Mac（含 macOS 12 兼容性）及配置 udev 后的 Linux 设备连接。

### 推送版本 Tag 自动发布

完成验证并提交发布变更后，推送与清单一致的 `vX.Y.Z` Tag：

```bash
git tag v0.3.0
git push origin v0.3.0
```

CI 使用 Node.js 24、Rust stable、Tauri CLI 2.12.1 与 `tauri-apps/tauri-action@v1`（Linux 固定 Ubuntu 22.04 以控制 glibc 依赖版本）。全部质量检查与四平台打包通过后，发布任务通过 `GITHUB_TOKEN`（需 `contents: write` 权限）创建草稿、上传八个产物与 `SHA256SUMS`、校验远端文件大小与 SHA-256 后自动公开 Release。同 ref 串行执行且不取消正在上传的任务；上传失败保留草稿供重跑替换，已公开的同名 Release 拒绝覆盖。Windows 安装包未证书签名，macOS 为 ad-hoc 签名，Linux 安装包不配置 udev 权限。

## 质量检查

按改动范围选择入口（所有入口遇错即停）：

| 命令 | 适用场景 |
| --- | --- |
| `npm run check` | 日常前端检查（依次运行 `npm test`、`typecheck`、`lint`，不构建前端） |
| `npm run check:rust` | Rust 检查（先构建 `out/`，再运行 `cargo fmt`、workspace Clippy 与测试） |
| `npm run check:all` | 交付前完整核心检查（组合以上两组与 `components:check`，只构建一次前端） |

`npm test` 仅扫描 `test/*.test.js`（定向执行用 `node --test test/文件名.test.js`）；Biome 自动跳过输出目录与 `.local-*` 目录。核心测试覆盖纯逻辑、数据处理、协议/文件契约、安全边界与发布同步，包括：

```text
bench-gate        chart-binding     chart-buckets    chart-columns     chart-cooperative
chart-cursor      chart-extrema     chart-feedback   chart-fill        chart-pacing
chart-window      clean             csv-codec        csv-import        device-stream
export-workflows  frame-scheduler   i18n             ingest            km003c-model
macos-menu        marker-ui         markers          measurement       pd-capture-file
pd-model          provenance        range-stats      recording         recording-spool
release           security-csp      settings-persistence shortcuts     tauri-config
temp-disconnect   third-party-components version-sync video-export
```

修改 `usbpd-parser` 或 `witrn-hid` 的 feature 门时，须补跑 CI 的非默认 feature 组合检查：

```bash
for combo in \
  "-p usbpd-parser --no-default-features" \
  "-p usbpd-parser --no-default-features --features serde" \
  "-p usbpd-parser --no-default-features --features vendor-ids" \
  "-p usbpd-parser --all-features" \
  "-p witrn-hid --no-default-features" \
  "-p witrn-hid --all-features"; do
  cargo clippy $combo --all-targets -- -D warnings && cargo test $combo
done
```

## 测试与回归边界

- 普通功能增删改、UI 布局、样式、文案和选项变化默认不新增回归测试。
- 仅在涉及数据丢失/损坏、协议兼容、崩溃/死锁、安全边界、发布构建不变量或已确认的高影响历史缺陷时补充测试。
- 优先扩展现有核心测试，不为每个小功能新建测试文件、设计方案或 CI job。
- 性能 benchmark 与真机检查按需手动运行，不加入每次改动的浏览器自动回归或额外 CI workflow。

## 语言选择

在「设置 → 外观与语言 → 语言」可选择跟随系统、简体中文、繁體中文、English、日本語；切换立即生效并保存偏好，保留连接、记录、数据、图表范围、筛选与选中报文（重置设置回到自动模式）。

Linux 按第一项非空的 `LC_ALL → LC_MESSAGES → LANG` 检测；Windows / macOS 使用原生系统 locale，不可用时取 WebView 首选语言，最终回退英文。脚本标签 `Hans` / `Hant` 优先于区域判定；否则 `CN`/`SG` 与无区域 `zh` 对应简中，`TW`/`HK`/`MO` 对应繁中，`ja` 对应日文，其余含 `C`/`POSIX` 对应英文（统一规范化大小写、下划线与编码后缀；手动选择覆盖自动检测）。

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
```

## 词典维护与翻译检查

`src/i18n.js` 提供 `t(key, params)`、locale 解析与订阅；`src/i18n-messages.js` 四列依次为英文（基准与缺词回退）、简中、繁中、日文。使用语义键名并保持插值参数名一致；用户文档以简中为基准，其余语种人工校对。

静态 HTML 保留英文兜底文本与 `data-i18n*` 属性（含图标或控件时仅标记文字 span）；动态文本与持续通知使用 `t` 或延迟函数生成。切换语言只刷新文案与图表标签，不得重连设备或重建数据。后端错误沿用 `{code, params, detail?}`，由前端翻译 `code` 并保留原始诊断（兼容字符串错误）；PD 标准名称、原始回复、单位与 CSV/PD 数据格式保持不变。

```bash
node --test test/i18n.test.js test/settings-persistence.test.js
node tools/showcase/verify-i18n.mjs
npm run showcase:capture -- --language zh-CN,zh-TW,en,ja
```

核对四语、浅深主题、900×600 / 1280×800、连接与记录/PDM 状态、PD 筛选、CSV/PD 往返及无障碍标签。模拟检查不替代 Linux `LANG`/`LC_*` 实机启动、macOS GUI、原生对话框或真实仪表验收。

## 无头测试接口

`tools/showcase/headless.mjs` 为 Node 脚本提供可复用的 Playwright 无头封装（依赖 `npx playwright install chromium`），不附带测试调度器或 CI 任务：

```js
import { createHeadlessHarness } from './tools/showcase/headless.mjs';

await using harness = await createHeadlessHarness();
await using app = await harness.openApp({ language: 'zh-CN', theme: 'dark' });
await app.connect('showcase:km003c');
await app.record();
await app.advance(1000);
await app.pause();
await app.waitForCharts();
console.log(await app.diagnostics());
// app.page / app.context: ordinary Playwright APIs
```

- `createHeadlessHarness({ channel, distribution, timeout })`：默认 Chromium、源码模式、`15 s` 超时；可切换 `msedge`/`chrome` 或 `out/`。
- `openApp({ language, theme, query, context, beforeLoad })`：创建隔离的存储、虚拟设备、冻结时钟与下载上下文并等待界面就绪。
- `connect(path)`、`record()`、`pause()` 驱动真实界面控件；`freeze()`/`resume()` 与 `advance(ms)`（0–300000 ms）推进虚拟时间并等待消费 ACK；`flush()` 等待消费边界，`waitForCharts()` 等主图显示任务及两帧。
- `diagnostics()` 返回 `source`、`stream`、`performance`、未捕获 `errors` 与 `consoleErrors`；可用 `app.page.evaluate()` 访问 `window.__SHOWCASE__` 故障钩子。`await using`（Node 24）在离开作用域时自动清理资源并向上抛出错误。

## 开发展示工具

`tools/showcase/` 是独立浏览器开发工具，提供虚拟 WITRN K2 与 POWER-Z KM003C、确定性曲线、PD 报文及协议控制结果（标题栏采用与主应用一致的图标与样式；工具不连真机且不进入 `src/`、`out/` 或安装包）。

```bash
npm ci
npx playwright install chromium
npm run showcase:dev
npm run showcase:capture
```

- **交互预览**：监听 `http://127.0.0.1:4173`（支持 `-- --port 4174` 改端口、`/app/?theme=dark` 或 `/app/?theme=system`），外层工具栏支持一键填充 120 秒展示数据、冻结/继续模拟、步进 10 秒与重置预览。
- **截图生成**：Chromium 1280×800 × 2× DPI 生成 2560×1600 主界面图（保留完整标题栏），以及 1920×1080 / 1920×1340 报告样式图（监控报告经 `cargo run --locked -p lapower --example showcase-reports` 渲染；仅抓主界面可用 `--page record,pd,trigger,detection,settings` 跳过 Rust 编译）。可用 `--language`、`--theme`、`--page`、`--output` 筛选；详细参数见 `npm run showcase:capture -- --help`。
- **样例与固件调试**：修改 `tools/showcase/scenario.js` 调整虚拟曲线与 PDO；修改原始 PD 样例后用 `node tools/showcase/generate-pd.mjs` 重建 `pd-fixtures.json`（临时产物写入 `output/`）。debug 构建中 `video_export_pick` 支持读取 `LAPOWER_VIDEO_TARGET` 跳过原生保存对话框以服务本机自动化（release 构建仅走原生对话框）。
- **外观字体核查**：运行 `node tools/showcase/verify-appearance.mjs` 检查繁体中文浅深主题与 100% / 125% / 150% DPI 下的 DOM 与 Canvas 字体，结果写入 `output/appearance-verification/`。

## 性能测量

`bench/` 保留算法、存储、内存、缩放渲染、启动与发货形状基准（细节见 [性能基准与边界](PERFORMANCE.md)）：

| 命令 | 用途 |
| --- | --- |
| `node bench/core.mjs` | 列存储、分桶、范围统计与能量积分基准 |
| `node bench/core.mjs --compare` | 与 `bench/baselines/` 基线进行多轮对照 |
| `node bench/core.mjs --verify-baseline` | 单次正确性与基线结构校验（不计时，供 CI 使用） |
| `npm run bench:memory` | 100 万 / 500 万点追加与流式 CSV 导入内存对比（默认对比 `bench/results/memory-before/`，支持 `-- --baseline <目录>`，校验列 SHA-256 一致且列缓冲节省 ≥ 20%，输出 `bench/results/memory.json`） |
| `node bench/chart-zoom.mjs` | 滚轮缩放／平移帧耗与 Canvas 2D 渲染管线基准 |
| `node bench/phase2.mjs` | 范围统计与协作切片前后对照 |
| `node bench/phase3.mjs` | 分块存储、统计与能量计算前后对照 |
| `node bench/extrema.mjs` | 逐点扫描与极值索引算法对照 |
| `node bench/startup.mjs` | 原生冷启动分段探测（按需手动运行） |
| `node bench/packaging.mjs` | 检查 `out/` 发货文件集合与资源引用 |
| `cargo bench -p lapower` | Rust 协议解码、编码与选择路径基准 |

## CI 门禁

`.github/workflows/ci.yml` 在每次 push 与 PR 运行固定检查：

| Job | 内容 |
| --- | --- |
| `validate` | Linux 依赖、前端构建、JS 测试、typecheck、lint、Rust fmt、Clippy、workspace test、发货形状与基线结构 |
| `backend-other-platforms` | Windows 与 macOS workspace test |
| `crate-features` | 协议 crate 非默认 feature 组合的 Clippy 与 test |
| `package` | 仅版本 Tag push 或手动触发；四目标并行打包，单目标失败不取消其余平台 |
| `package-summary` | 四目标全部成功后校验八个安装包并生成 `SHA256SUMS` |
| `release` | 仅版本 Tag push；上传并校验远端附件后自动公开 Release |

CI 不安装浏览器，不运行 UI 矩阵或长时采集；发布脚本的失败与校验保护由 `test/release.test.js` 离线覆盖。

## Linux 自行编译

Debian / Ubuntu 编译依赖与构建步骤（Linux 未接入持续硬件回归）：

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl file pkg-config libssl-dev libudev-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev patchelf
npm ci
npm run build
npx --no-install tauri build
```

### udev 规则（必需）

Debian / Ubuntu 可创建 `/etc/udev/rules.d/99-lapower.rules`，向活动本地桌面会话授予 WITRN HID 与 POWER-Z Bulk / CDC 串口权限：

```udev
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0716", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0063", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0061", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="5fc9", TAG+="uaccess"
```

执行 `sudo udevadm control --reload-rules` 后重新插拔仪表再启动应用。无 systemd-logind 桌面会话的环境请改用发行版设备组权限规则。

## macOS 自行编译

需 Xcode Command Line Tools、Rust 稳定版与 npm 锁定的 Tauri CLI：

```bash
npm ci
npm run build
npx --no-install tauri build
```

macOS private API 的 Cargo feature 与 `tauri.macos.conf.json` 须保持一致。构建使用 `signingIdentity: "-"`（ad-hoc 签名）与 `minimumSystemVersion: "12.0"`（CI 设置 `MACOSX_DEPLOYMENT_TARGET=12.0` 及 `TAURI_BUNDLER_DMG_IGNORE_CI=false`）。首次打开方式见 [README 下载与安装](../README.zh-CN.md#-下载与安装)；正式发布前仍需在 Intel / Apple Silicon Mac（含 macOS 12）实机验收 GUI 与硬件连接。

## 外部温度服务

laPower 支持**仪表自带温度**与**外部 TCP 温度服务**两种来源（WITRN 取自 HID 报告，POWER-Z 取自 ADC 快照）。

### 选择温度来源

在「监控」命令栏展开 `温度服务` 右侧箭头配置：

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `来源` | `仪表` = 仪表温度；`外部` = TCP 温度服务 | `外部` |
| `IP` | 服务器地址（仅 `外部` 可用） | `127.0.0.1` |
| `端口` | 服务器端口（仅 `外部` 可用） | `1573` |

连接/断开通过主按钮操作，**连接期间不可切换来源**。`仪表` 源随仪表断开自动复位（前端在连接状态变化时清除实时读数并解锁来源选择）；`外部` TCP 会话独立于仪表连接。接入后可在读数卡、`显示` 第四个 Y 轴及 CSV `Temp(°C)` 列中使用。

### 协议与示例

极简明文 TCP 协议（laPower 作为客户端连入，无握手或心跳，每行一个摄氏度十进制数并以 `\n` 结尾，如 `25.125\n`）：

- **连接超时 5 秒**（IPv4 优先于 IPv6）。
- **发送间隔不限**：250 ms 读超时循环仅继续等待而不主动断线；支持 TCP 分片半行续接，单行超过 256 字节按坏行丢弃至下一换行；服务端 EOF 触发前端断开状态。

仓库内置无第三方依赖的 Python 示例（[`temperature-example/network_server.py`](../temperature-example/network_server.py) 与 [`temperature-example/network_client.py`](../temperature-example/network_client.py)）：

```bash
python temperature-example/network_server.py
```

自建服务端示例核心（跨机访问请绑定 `0.0.0.0`）：

```python
import socket

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("0.0.0.0", 1573))
server.listen(1)

conn, addr = server.accept()
while True:
    temperature = read_your_sensor()      # 返回 float
    conn.sendall(f"{temperature}\n".encode())
```

### 故障排查

- **连接超时**：检查 IP、端口、跨机服务端是否绑定 `0.0.0.0` 及防火墙放行情况。
- **已连接但显示 `--`**：确保仅发送纯数字加换行（LF/CRLF 均可），勿附带单位或 JSON 包装。
- **数值异常跳变**：检查是否缺失换行符导致多条数据拼接并超过 256 字节被丢弃。
- **无法切换 `来源`**：先点击 `温度服务` 主按钮断开连接。

## 参与贡献

1. Fork 仓库并创建分支。
2. 完成改动后运行对应范围的核心质量检查（`npm run check:all`）。
3. 保持前端模块 `// @ts-check`，纯数据处理逻辑与 DOM / Tauri 解耦。
4. 新增设备型号或固件前，须以实机样本确认字节布局与量程，并遵守[测试与回归边界](#测试与回归边界)。
