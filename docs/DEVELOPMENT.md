[English](en/DEVELOPMENT.md) | **简体中文** | [繁體中文](zh-TW/DEVELOPMENT.md) | [日本語](ja/DEVELOPMENT.md)

← 返回 [README](../README.zh-CN.md)

# 开发与构建

- [环境要求](#环境要求)
- [构建与运行](#构建与运行)
- [发布流程](#发布流程)
- [质量检查](#质量检查)
- [测试与回归边界](#测试与回归边界)
- [无头测试接口](#无头测试接口)
- [开发展示工具](#开发展示工具)
- [性能测量](#性能测量)
- [CI 门禁](#ci-门禁)
- [Linux 自行编译](#linux-自行编译)
- [macOS 自行编译](#macos-自行编译)
- [外部温度服务](#外部温度服务)
- [参与贡献](#参与贡献)

## 语言选择

在「设置 → 外观与语言 → 语言」可选择跟随系统、简体中文、繁體中文、English、日本語。切换立即生效并保存偏好，保留连接、记录、数据、图表范围、筛选和选中报文；重置设置回到自动模式。

Linux 按第一项非空的 LC_ALL → LC_MESSAGES → LANG 检测；Windows／macOS 使用原生系统 locale。原生不可用时采用 WebView 首选语言，最终回退英文。Hans 优先选择简中、Hant 优先选择繁中；否则 CN／SG 和无区域 zh 为简中，TW／HK／MO 为繁中，ja 为日文，其余含 C／POSIX 为英文。统一处理大小写、下划线、编码与修饰后缀；手动选择覆盖自动检测。

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
```

## 词典维护与翻译检查

src/i18n.js 提供 t(key, params)、locale 解析和语言变更订阅，四份词典离线打包，英文作为基准与缺词回退。src/i18n-messages.js 的四列依次为英文、简中、繁中、日文。使用语义键名，保持插值参数名称一致；含数量的消息按需补充单数版本。用户文档以简中版本为内容基准，其他语言的内容由人工校对。

静态 HTML 使用英文兜底和 data-i18n／data-i18n-title／data-i18n-placeholder／data-i18n-aria-label／data-i18n-alt；含图标或输入控件的元素只标记文字 span。动态内容通过 t 生成，持续通知和日志用延迟文字函数。切换只刷新标签、菜单、下拉和图表，不能重新连接或重建数据。

应用后端错误使用 {code, params, detail?}，异步事件保留原有字段并添加 description；前端翻译 code，保留原始诊断，仍兼容插件字符串错误。文件对话框标题与过滤器由前端翻译，原生按钮跟随 OS。PD 标准名、解码字段、原始回复、单位和 CSV／PD 数据格式保持兼容。

```bash
node --test test/i18n.test.js test/settings-persistence.test.js
node tools/showcase/verify-i18n.mjs
npm run showcase:capture -- --language zh-CN,zh-TW,en,ja
```

检查四语、浅深主题、900×600／1280×800、连接和记录／PDM 状态、PD 选择和筛选、CSV／PD 往返、错误、文件入口及无障碍标签。Linux AppImage 的 LANG／LC_* 实机启动验收需在 Linux 完成，浏览器模拟不替代原生或硬件验收。

模拟设备与浏览器检查不能代替 Linux AppImage、macOS GUI、原生文件对话框或真实仪表验收。按需在对应机器检查系统语言、手动语言持久化、记录/PDM、文件对话框和 CSV/PD 往返；历史验收结果不能当作当前构建的保证。


## 环境要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| Rust | 1.85+ | 工作区 `rust-version` |
| Tauri CLI | 2.12.1 | npm 锁定的 `@tauri-apps/cli`，通过 `npx --no-install tauri` 调用 |
| Windows | 10 / 11 | 当前开发与验证平台 |
| macOS | 12+ | 最低部署目标；CI 使用 macOS 26，旧系统兼容性需实机验证 |
| Node.js | 24 | CI、lint / typecheck / test / 前端产物 |

项目使用 npm，提交 `package-lock.json`，CI 使用 `npm ci`。前端是原生 ES Modules，`frontendDist` 指向构建生成的 `out/`；Node 不参与 Rust 编译，但 `npm run build` 必须先于 `cargo build`、`cargo test`、`cargo check` 和 `cargo clippy`。改动 `src/` 后先重建 `out/`，再重新链接 Rust 二进制。

## 构建与运行

```bash
git clone https://github.com/KHWLGH/laPower.git
cd laPower
npm ci
npm run dev
```

日常使用以下快捷入口；原有命令继续可用，npm 使用项目内锁定的 Tauri CLI：

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动原生应用，自动构建开发前端 |
| `npm run dev:web` | 启动模拟设备浏览器预览；可追加 `-- --port 4174` |
| `npm run build` | 单独生成供 Cargo 内嵌的开发前端 |
| `npm run build:app` | 构建本机安装包，自动生成发布前端 |

`dev` 的 `beforeDevCommand` 已负责构建前端，启动前无需重复运行 `npm run build`。它沿用内嵌资源方式，不提供前端热更新；修改前端后重新启动 `dev`，或先构建前端再重新链接 Rust 二进制。

本机未指定 target 时，发布产物位于 `target/release/bundle/`；CI 显式指定 target，产物位于 `target/<target>/release/bundle/`。Tauri CLI 会自动运行 `beforeBuildCommand` 生成压缩前端，打包前无需再手动执行 `npm run build:dist`。直接运行 Cargo 检查时仍须先生成 `out/`。

### Windows 构建脚本被杀毒软件拦截

若 Cargo 在运行 `libc` 的 `build-script-build` 前报「拒绝访问（os error 5）」或文件占用（os error 32），且杀毒软件报告拦截了同一路径，受影响的是编译阶段运行的辅助程序；它不属于应用运行时。已在本机 Windows/MSVC 与 Kaspersky 环境重现 `libc 0.2.189` 的二级优化构建脚本被拦截，而零优化版本正常执行。

根目录 `Cargo.toml` 为 `libc` 单独设置 `[profile.dev.package.libc] opt-level = 0`，其他依赖仍使用二级优化，release 配置不变。该设置也适用于 test 继承的 dev profile，同时影响 `libc` 的开发库。单独添加 `profile.dev.build-override` 无法覆盖现有 `package."*"` 设置。更新配置后直接重新运行原构建命令即可，Cargo 会重建相关产物，无需清空整个 `target/`。

这是针对已验证编译组合的兼容调整，不能保证其他版本或其他文件不会被误报。若仍被拦截，保留杀毒软件的检测名称、路径与文件哈希以核查并向厂商反馈；仅凭 `os error 5` 本身不能确定是误报。

### 分级清理

各档累计包含前一档，等待删除完成后返回；默认保留 Rust 编译缓存、依赖和安装包：

| 命令 | 删除范围 |
| --- | --- |
| `npm run clean` | `out/`、`output/`、`bench/results/`、根目录和 `src/` 下的 `.playwright-cli/`、`src-tauri/gen/schemas/` |
| `npm run clean:incremental` | 再清理 `target/` 与 `src-tauri/target/` 中 `debug/release` 的增量缓存，包含交叉编译目标 |
| `npm run clean:build` | 再清理完整 `target/`、`src-tauri/target/` 与 `dist/` |
| `npm run clean:all` | 再清理 `node_modules/`；下次开发先运行 `npm ci` |

所有档位都支持只预览路径：

```bash
npm run clean:build -- --dry-run
```

清理器需要 Node.js 与 Git，从脚本位置确定仓库根目录，执行前统一检查所有目标与 Git 跟踪状态；目标或祖先目录是符号链接／junction 时拒绝清理。最多并行处理四个目录，输出每项结果和总耗时；占用错误有限重试，最终失败返回非零退出码。先关闭相关开发、构建和预览进程；命令不会主动终止它们。

`output/` 中的检查截图、`bench/results/` 中的原始结果及本地对照快照也会被删除。已跟踪的文档截图、`bench/baselines/`、源码、锁文件、仓库外缓存和应用恢复数据不会清理；自定义 `CARGO_TARGET_DIR` 不在上述路径时需自行管理。清理后启动 `dev` 会重建前端；直接执行 Cargo 仍须先运行 `npm run build`。

### 运行组件清单

关于页使用随包的 `src/third-party-components.json` 组件清单，许可阅读器按需加载 `src/legal-notices.json` 全文目录。修改 Cargo 运行依赖、内置资源或许可输入后，运行 `npm run components:generate` 并提交两份生成结果及必要材料，再用 `npm run components:check` 核对；不要手改生成目录。脚本用锁定、离线的 Cargo metadata/tree 保守合并 Windows x64、Linux x64、macOS Intel 和 Apple Silicon 的 normal 依赖，排除工作区包、纯开发／构建与过程宏包；这不是精确的发布编译单元图。内置资源版本来自其声明，不明时标为随应用内置。

许可材料来自根目录 [`COPYRIGHT`](../COPYRIGHT)、[`LICENSE`](../LICENSE)、[`LICENSE.LGPL-3.0`](../LICENSE.LGPL-3.0)、本地 Cargo 缓存中的真实文件及 `licenses/materials.json` 登记的预存补件。补件记录固定版本、来源、revision、上游路径与 SHA-256，正文仅统一 CRLF 为 LF；默认情况下，缺件、内容漂移或目录校验失败会中止生成／核对。仅接受经过显式审核、绑定固定版本且附理由与证据的上游缺件或许可分支选择例外；例外会随目录离线呈现并由生成／检查报告，不代表恢复了缺失的上游正文。首次准备依赖缓存或补件可能需要另行联网，生成／核对本身不临时下载。普通前端构建只校验并复制已生成材料，不依赖 Cargo 或网络；CI 的 `validate` 继续核对清单。

自有贡献的应用、脚本、工具、测试、基准、温度示例、工作流与项目文档／配置采用 GPL-3.0-only，`crates/` 下库、测试、例子及自有文档／配置采用 LGPL-3.0-or-later；具体资源和生成物范围见 [`COPYRIGHT`](../COPYRIGHT)。保留上游与其他作者的声明，不从 Git 作者记录推定转让，不把第三方材料标成 KHWLGH 原创。项目版权行固定为 `Copyright (C) 2026 KHWLGH`，仅用于其自有贡献；GNU 许可全文保持原文。

发布对应 Tag 的 ZIP／tar.gz 是本仓库源码归档，不含本地依赖缓存或系统 SDK。从归档构建时，用 `cargo fetch --locked` 获取锁定的 Cargo 依赖源码，用 `npm ci` 获取锁定的 npm 构建工具；`Cargo.lock` 与 `package-lock.json` 确定相应依赖版本及可用的完整性校验信息。依赖来源可结合 [`src/third-party-components.json`](../src/third-party-components.json) 组件名单定位。当前工具链、平台 SDK／系统依赖和构建命令见本指南的环境要求与各平台构建段落；单独的 Tag 归档不代表已内含全部依赖源码。

## 发布流程

日常只维护 `changelog/unreleased/zh-CN.md`。发布前由开发助手合并重复项、整理面向用户的中文说明，再生成 `en.md` 并人工校对。更新日志只提供中英双语，不要求逐条或逐句对应，不使用翻译 API。

```bash
npm run release:prepare -- 0.2.5 --date 2026-10-17 --dry-run
npm run release:prepare -- 0.2.5 --date 2026-10-17
npm run release:notes
npm run showcase:capture
```

将示例版本和日期换成实际值。准备命令检查双语文件存在且正文非空，拒绝覆盖已有版本目录，然后归档到 `changelog/<version>/`、同步产品版本、更新根目录入口并生成 `dist/release-notes.md`；完成后才清空草稿。`--dry-run` 只展示计划和预览，不写文件。失败时草稿保留；检查错误和 `git diff`，修复后再试，若已生成部分版本文件需先人工整理。

Release 默认展开英文，简体中文在折叠区，两种语言均包含安装说明。预览与正式发布使用同一渲染逻辑。`GITHUB_REPOSITORY` 优先提供仓库名，本地未设置时从 `origin` 解析。命令不会提交、创建或推送 Tag，也不会公开 Release；校对预览和运行质量检查后再提交及推送新 Tag。

### 发布前更新文档截图

每次发布准备都必须更新文档截图，顺序为：同步产品版本与归档更新日志 → 生成并检查截图 → 运行质量检查 → 提交全部发布改动 → 推送版本 Tag → GitHub Actions 构建、校验并发布安装包。正式发布无需本地预构建安装包。`release:prepare` 只处理版本和文案，截图使用上面的独立命令；已有版本已归档时，直接重新运行 `npm run showcase:capture`，无需再次归档。

首次使用先执行 `npx playwright install chromium`；Linux 缺少浏览器系统依赖时使用 `npx playwright install --with-deps chromium`。截图必须完整覆盖简体中文、繁体中文、英文、日文 × 浅色、深色 × 监控、PD 分析、协议控制、设置，共 32 张，写入 `docs/screenshots/<language>/` 并保留完整标题栏。使用当前版本、统一的 120 秒模拟数据与既定窗口尺寸，不用局部截图替代整套发布图。

生成后逐张查看语言、主题、文字截断、图表、选中报文、协议状态和设置目录，确认没有空白、遮挡或溢出；版本与当前清单一致。同步四语言 README 的截图版本、说明和图片引用，再将 32 张图片与文档一起提交。截图失败或检查不通过时，修复后重新生成，发布前准备尚未完成。截图工具的参数和数据说明见[开发展示工具](#开发展示工具)。

### 文档维护范围

README、使用指南、开发与构建维护英文、简体中文、繁体中文和日文；架构、性能、协议库 README 和更新日志维护中英双语。外部温度服务统一在本指南维护。主要文档优先使用同语言链接，次要文档在繁体页面优先链接简中，在日文页面优先链接英文并注明语言。不增加翻译哈希、逐条同步检查或文档专用 CI。

### 更新日志链接

所有版本正文存放在 `changelog/<version>/`，根目录 `CHANGELOG.md` 只作为版本索引并保留原版本标题锚点。完整历史链接到索引，指定版本直接链接对应语言文件；0.2.2 及以前只有 `zh-CN.md`，不创建英文占位页。正文中的相对链接以文件所在目录为基准，例如中文使用 `../../docs/USAGE.md`、英文使用 `../../docs/en/USAGE.md`；GitHub Release 渲染时统一固定到该版本 Tag。

### 单独设置版本

只需同步版本而不归档发布文案时，仍可使用：

```bash
npm run version:set -- 0.2.4
```

将 `0.2.4` 换成目标版本即可。命令接受不含前导零的 `X.Y.Z`，先校验所有文件，再同步以下位置；重复设置同一版本不会重复写入，也不会创建 Git 提交或 tag、更新依赖或修改更新日志：

| 文件 | 字段 |
| --- | --- |
| `package.json` | `version` |
| `package-lock.json` | 顶层与根包 `version` |
| `Cargo.toml` | `[workspace.package] version` |
| `Cargo.lock` | 所有工作区成员包的 `version` |
| `src-tauri/tauri.conf.json` | `version` |

Rust 成员 crate 继续通过 `version.workspace = true` 继承版本；关于页从 Tauri 读取版本，开发展示工具从 `package.json` 读取版本。更新后重新构建，才能让可执行文件和安装包使用新版本。

`test/version-sync.test.js` 会检查清单与锁文件一致、语义版本格式、workspace 继承关系、统一更新命令和 macOS private API 配置。

### 手动构建与首次验收

将 workflow 提交到默认分支后，在 GitHub 的 **Actions → CI → Run workflow** 选择要验证的分支或 Tag。手动触发会先运行现有质量检查，再打包四个目标；不会创建或公开 Release，即使选择的是版本 Tag。

| 目标 | Runner | Rust target | 安装包 |
| --- | --- | --- | --- |
| Windows x64 | `windows-2022` | `x86_64-pc-windows-msvc` | MSI、NSIS EXE |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | DEB、RPM、AppImage |
| macOS Intel | `macos-26-intel` | `x86_64-apple-darwin` | DMG |
| macOS Apple Silicon | `macos-26` | `aarch64-apple-darwin` | DMG |

每个成功目标提供独立的 `packages-*` 附件，保留 14 天。四目标全部成功后提供 `release-packages`，包含七个安装包与 `SHA256SUMS`；在解压目录中可用 `sha256sum -c SHA256SUMS` 校验。安装包名包含版本与平台架构，NSIS EXE 另带 `_setup`。

首次启用 Tag 自动发布前，先手动构建，检查 Windows 安装、两种 Mac 启动、Linux 安装及配置 udev 后的设备连接。macOS 12 兼容性需要单独实机验证。CI 验证 Mac 的架构、ad-hoc 签名、最低系统版本元数据和 DMG 完整性，不运行 GUI 或连接仪表。

macOS 构建显式使用 `--bundles app,dmg`：Tauri 在仅构建 DMG 时会清理临时 `.app`，同时指定 APP 才能保留应用供后续校验。附件收集仍只包含 DMG，不额外发布 APP。

### 推送版本 Tag 自动发布

完成上述首次验收后，更新版本、整理更新日志、运行质量检查并提交，再推送与清单一致的 Tag，例如：

```bash
git tag v0.2.4
git push origin v0.2.4
```

Tag 必须为 `vX.Y.Z`，且与清单版本一致；不一致会在打包前失败。CI 使用 Node.js 24、Rust stable、固定的 Tauri CLI 2.12.1 和 `tauri-apps/tauri-action@v1`。npm 通过 `npm ci` 安装，Cargo 使用 `--locked`；Rust 缓存按目标区分并指向工作区根目录 `target/`。Linux 固定 Ubuntu 22.04，以减少对较新 glibc 的依赖。

只有全部质量检查与四目标打包成功，才会汇总七个安装包并生成校验和。发布任务使用运行仓库的 `GITHUB_TOKEN` 创建临时草稿，上传七个包与校验文件，再核对远端附件数量、大小和 SHA-256，最后自动公开正式 Release。无需人工点击 Publish，也不需要另设 PAT；只有发布任务获得 `contents: write`，仓库的组织策略需允许这项权限。

`scripts/release.mjs` 从当前版本目录读取中英 Markdown，而不是解析根目录历史长文。Tag 打包前与发布前都复用文案读取逻辑，仅检查双语文件存在且正文非空；相对链接固定到该版本 Tag，不使用 GitHub 自动生成的提交/PR 摘要。`npm run release:notes` 可重新生成本地预览，不修改源文档。

同一 ref 的运行串行处理，不取消正在上传的发布。上传或验证失败时 Release 保持草稿；在 Actions 重跑失败任务即可复用该草稿并替换本次发布的同名附件。草稿若包含其他附件，须人工检查后再重跑；同名 Release 已公开时，任务拒绝自动覆盖。若需修改已发布的二进制，应更新版本并推送新 Tag。

Windows 当前不做证书签名；macOS 使用 ad-hoc 签名，没有 Developer ID 签名和公证；Linux 安装包不会自动设置 udev 权限。本流程不启用自动更新，不构建 Windows/Linux ARM64 或 Mac Universal 包。

## 质量检查

按改动范围选择一个入口：

| 命令 | 适用场景 |
| --- | --- |
| `npm run check` | 日常前端检查 |
| `npm run check:rust` | Rust 检查，自动先生成 `out/` |
| `npm run check:all` | 交付前完整核心检查，包含前两组与组件清单核对 |

`check` 依次运行 `npm test`、`typecheck`、`lint`，不构建前端或运行 Cargo；`check:rust` 先构建一次前端，再运行格式检查、工作区 Clippy 和测试。`check:all` 顺序组合两组检查与 `components:check`，只构建一次前端，所有入口遇错即停。单项命令仍可独立运行；组件清单核对需要 Cargo，缺少依赖缓存时可能联网。原有 CI 检查集合保持不变。

`npm test` 使用 Node 内置测试运行器，只发现 `test/*.test.js`，避免执行输出目录中的历史源码副本。新核心测试沿用该位置及命名，定向检查使用 `node --test test/文件名.test.js`。Biome 跳过输出、依赖和 `.local-*` 本机工具目录，无需临时移动文件。核心测试覆盖纯逻辑、数据处理、协议/文件契约、安全边界和版本同步，主要文件包括：

```text
chart-buckets  chart-columns  chart-extrema  chart-window
csv-codec     csv-import     device-stream  ingest
measurement   pd-capture-file  pd-model      range-stats
recording     recording-spool  security-csp  settings-persistence
version-sync  bench-gate
```

Rust workspace 测试、格式检查、Clippy 和协议 crate 的 feature 组合检查继续保留。涉及 `usbpd-parser` 或 `witrn-hid` 的 feature 门时，按 CI 的组合补跑：

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

- 普通功能增加、删除、重命名，UI 布局、样式、文案和选项列表变化，默认不新增回归测试。
- 只有涉及数据丢失或损坏、协议兼容、崩溃或死锁、安全边界、发布构建不变量，或已经确认的高影响历史缺陷时才增加测试。
- 优先补充现有核心测试，不为每个小功能新建测试文件、设计方案或 CI job。
- 性能 benchmark 和真机检查按需手动运行，不作为每次改动的浏览器自动回归。
- CI 保持固定的核心检查集合，不因单个功能增加专用回归流程。

## 无头测试接口

`tools/showcase/headless.mjs` 为其他 Node 脚本提供可导入的无头接口，复用现有 Playwright、模拟服务器和设备桥接。首次准备运行 `npx playwright install chromium`。它不自带测试场景、测试调度器或 CI 任务；截图工具、现有 UI 检查和浏览器基准共用它。仓库根目录脚本示例：

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

- `createHeadlessHarness({ channel, distribution, timeout })`：默认 Chromium、源码、15 秒操作超时；可指定 `msedge`／`chrome` 或已构建的 `out/`。返回 `url`、`browser`、`openApp`、`close`。
- `openApp({ language, theme, query, context, beforeLoad })`：新建隔离的存储、模拟设备、时钟和下载上下文，等待连接控件及图表就绪。`context` 接收 Playwright 上下文选项；`query` 复用模拟桥参数；异步 `beforeLoad(page)` 在导航前安装路由、事件或初始化脚本。
- `connect(path)`、`record()`、`pause()` 通过真实界面控件操作；`freeze()`／`resume()` 控制虚拟时钟。默认冻结；`advance(ms)` 推进 0–300000 毫秒并等待消费及真实 ACK，自动时钟运行中需先冻结。
- `flush()` 只等待消费边界；`waitForCharts()` 等主图显示任务完成并让出两帧；导出的 `frames(page)` 只等待字体与两帧。它们不保证磁盘持久化、显示器呈现或所有异步任务完成。
- `diagnostics()` 返回 `source`、`stream`、`performance`、未捕获异常 `errors` 和 `consoleErrors`，不隐式开启完整性能采样。断言、截图、trace 和错误处理由调用脚本负责；协议故障等现有模拟钩子可通过 `app.page.evaluate()` 调用 `window.__SHOWCASE__`。
- `app.close()` 关闭当前上下文；`harness.close()` 关闭全部上下文、浏览器和服务器，均可重复调用。Node 24 的 `await using` 在正常结束及异常退出作用域时自动清理；初始化失败也清理已创建资源。错误直接抛给调用者，不吞掉或记作跳过。

固定无头启动，不激活桌面窗口；模拟设备不会连接真实仪表或读取原生设置。现有 `verify-*.mjs` 按涉及领域手动选择；图表专项保留 `bench/chart-transitions.mjs` 和 `bench/chart-raster.mjs`，移除依赖旧内部索引行为且覆盖重复的历史矩阵脚本。核心 `test/` 继续负责数据、协议和构建不变量；不再维护额外的整套工作流验收或浏览器 CI。平台、原生文件系统和硬件采集仍单独验证。

## 开发展示工具

长期记录内存对比使用 `npm run bench:memory`，默认比较 `bench/results/memory-before/` 中修改前的 `state.js`、`csv-codec.js`、`csv-import-core.js`、`measurement.js` 四个纯模块快照与当前源码；也可用 `-- --baseline <目录>` 指定快照位置。测试包含 100 万和 500 万点持续追加、持有导出快照时继续追加、流式 CSV 导入及反复清空，逐列 SHA-256 必须一致，列缓冲至少节省 20%。结果保存到 `bench/results/memory.json`，分别记录独立列缓冲、Node RSS 抽样峰值及 OS 峰值，不能把它们当作 Tauri / WebView2 整个进程树的测量。

Windows 字体检查可运行 `node tools/showcase/verify-appearance.mjs`，覆盖繁体中文浅深主题与 100% / 125% / 150% DPI，检查 DOM 实际使用的字体、Canvas 轴字体和语言切换，截图及结果保存在 `output/appearance-verification/`。

`tools/showcase/` 是独立的浏览器开发工具，提供虚拟 WITRN K2 与 POWER-Z KM003C、确定性的测量曲线、PD 报文和协议控制结果。数据仍经过软件现有摄入与渲染逻辑；完整标题栏使用 decorum 同款控件结构与软件自身的图标、样式，窗口行为虚拟化。工具不连接真实仪表，不进入 `src/`、`out/` 或安装包，无头测试接口复用其服务器。

首次准备：

```bash
npm ci
npx playwright install chromium
```

交互预览与生成全部展示图：

```bash
npm run showcase:dev
npm run showcase:capture
```

预览默认监听 `http://127.0.0.1:4173`，默认显示浅色主题；独立软件视图可用 `/app/?theme=dark` 或 `/app/?theme=system` 指定深色或跟随系统。软件标题栏可选择虚拟设备、连接与断开，记录按钮可开始和暂停。开发工具外层提供「填充 120 秒展示数据」「冻结」「继续模拟」「推进 10 秒」「重置预览」；填充按钮自动连接当前选择的设备与本机温度源并开始记录。协议控制需要选择 POWER-Z 并连接，然后打开 PDM。端口可用 `npm run showcase:dev -- --port 4174` 指定，服务只监听本机。

报告视频导出的原生验收不打开系统保存对话框：debug 构建在 `video_export_pick` 里读取 `LAPOWER_VIDEO_TARGET`，有值就直接为它签发 ticket。该分支只在 `debug_assertions` 下编译，release 构建里路径仍然只能来自原生对话框；它只服务本机自动化，不进设置、文档界面或 CI。

截图命令使用 Chromium、Windows 风格、1280×800 CSS 视口、2 倍像素密度及 100% 界面缩放，生成 2560×1600 PNG。默认使用 POWER-Z、本机温度源与相同的 120 秒模拟数据，先冻结虚拟时间，再等待实际图表、报文详情、字体与控件渲染完成。输出为 `docs/screenshots/<language>/{dark,light}-{record,pd,trigger,settings}.png`，每种语言各 8 张展示图（共 32 张）。

关于页版本读取 package.json，截图命令会校验版本、语言与页面溢出。截图仅写入对应语言子目录，不再生成根目录中的重复副本。

可以只截取指定页面、主题或更改输出目录：

```bash
npm run showcase:capture -- --theme light --page pd,trigger --output output/showcase
npm run showcase:capture -- --help
```

`--language` 支持 zh-CN、zh-TW、en、ja（逗号分隔，默认全部）；`--theme` 支持 `light,dark`，默认按浅色、深色顺序生成；`--page` 支持 `record,pd,trigger,settings`。输出目录相对于仓库根目录，也可使用绝对路径。修改 `tools/showcase/scenario.js` 可以调整虚拟设备信息、随机种子、充电曲线、握手时刻及 PDO / 协议检测结果。`bridge.js` 实现 Tauri 命令、事件、录制段、ACK、内存设置与文件句柄；未实现的调用会明确报错。CSV / PD 导出通过浏览器下载，CSV 导入通过浏览器文件选择器；PD 导入仅支持包含已固化样例原始报文的文件，任意真机报文解码仍应使用原生软件。

`pd-fixtures.json` 保存由现有 `witrn-hid` Rust 解析器产生的原始报文与解码树，普通预览和截图无需 Rust 编译。更改 PD 原始样例后，可在安装 Rust 的环境中运行 `node tools/showcase/generate-pd.mjs` 重新生成；临时生成器写入忽略的 `output/`，编译产物写入 `target/`。

浏览器上下文使用内存设置与文件，不读写真实应用的数据目录。软件使用新的标识 `io.github.khwlgh.lapower`，启动测量工具也已同步该标识；旧 WITRN-RS 设置不会自动迁移。

## 性能测量

`bench/` 保留算法、存储、启动、极值和发货形状检查；浏览器 harness、浏览器长跑和硬件验收已移除。

| 命令 | 用途 |
| --- | --- |
| `node bench/core.mjs` | 列存储、分桶、统计和能量积分基准 |
| `node bench/core.mjs --compare` | 与算法基线比较，结果需结合多轮和主机状态判断 |
| `node bench/core.mjs --verify-baseline` | 单次正确性检查及基线结构校验，不预热、不计时 |
| `node bench/phase2.mjs` | 范围统计和协作切片的前后版本对照 |
| `node bench/phase3.mjs` | 分块存储、统计和能量计算的前后版本对照 |
| `node bench/extrema.mjs` | 扫描与极值索引的算法对照 |
| `node bench/startup.mjs` | 原生二进制冷启动分段，按需手动运行 |
| `node bench/packaging.mjs` | 检查 `out/` 的发货文件和内嵌集合 |
| `cargo bench -p lapower` | Rust 协议解码、编码和选择路径基准 |

发货形状和基线结构检查合并在 `validate`，复用前端构建；算法和 Rust 耗时基准按需在本机运行，不在每次 CI 中重复构建和计时。

## CI 门禁

`.github/workflows/ci.yml` 在每次 push 和 PR 运行固定的核心检查：

| Job | 内容 |
| --- | --- |
| `validate` | Linux 依赖、前端构建、JS 测试、typecheck、lint、Rust fmt、Clippy、workspace test、发货形状与基线结构 |
| `backend-other-platforms` | Windows workspace test；macOS workspace test |
| `crate-features` | 协议 crate 的非默认 feature 组合 Clippy 与 test |
| `package` | 仅版本 Tag push / 手动触发；依赖以上三项检查，四目标并行打包，单个平台失败不会取消其他目标 |
| `package-summary` | 四目标全部成功后验证七个安装包并生成 `SHA256SUMS` |
| `release` | 仅版本 Tag push；上传并核对附件后自动公开 Release |

普通分支 push 和 PR 只运行核心检查，不打包或发布；CI 不安装浏览器，不运行 UI 矩阵、长时间采集或耗时 benchmark。按需使用无头接口调用已有工具；原有 **CI** 手动入口仍会打包。发布脚本的失败、重跑、附件完整性和公开版本保护由 `test/release.test.js` 离线验证。

## Linux 自行编译

Linux 构建与运行未持续接入真实设备验证。Debian / Ubuntu 依赖：

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl file pkg-config libssl-dev libudev-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev patchelf
npm ci
npm run build
npx --no-install tauri build
```

需要访问 WITRN HID 时，按发行版配置 `/dev/hidraw*` 的 udev 规则。

### udev 规则（必需）

Debian / Ubuntu 上可创建 `/etc/udev/rules.d/99-lapower.rules`，仅授予当前桌面用户访问 WITRN HID 和 POWER-Z USB 接口的权限：

```udev
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0716", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0063", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0061", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="5fc9", TAG+="uaccess"
```

随后执行 `sudo udevadm control --reload-rules`，重新插拔设备，再启动软件。`uaccess` 依赖 systemd-logind 的活动本地会话；其他发行版或无桌面会话环境应使用发行版的设备访问组规则。POWER-Z 协议控制还需要访问其 CDC 串口。

## macOS 自行编译

需要 Xcode Command Line Tools、Rust 稳定版和 npm 锁定的 Tauri CLI：

```bash
npm ci
npm run build
npx --no-install tauri build
```

macOS private API 的 Cargo feature 与 Tauri 配置必须保持一致。平台配置使用 `signingIdentity: "-"` 和 `minimumSystemVersion: "12.0"`；CI 同时设置 `MACOSX_DEPLOYMENT_TARGET=12.0`，保留旧系统部署目标，并通过 `CI=true`、`TAURI_BUNDLER_DMG_IGNORE_CI=false` 跳过 Finder 美化。当前没有 Developer ID 签名或 Apple 公证；首次打开方式见 [README 下载与安装](../README.zh-CN.md#-下载与安装)。

普通 macOS CI 做 workspace test；版本 Tag / 手动构建还会生成并验证 DMG，不运行 GUI 或真机检查。

CI 的原生构建检查不代表完成 GUI 或硬件验收。首次发货仍需在 Intel / Apple Silicon Mac 检查应用启动、窗口和设置、文件对话框、记录及真实仪表连接；macOS 12 兼容性单独验证。旧版 WITRN-RS 的一次性构建报告保留于 Git 历史，不作为当前 laPower 操作步骤。

## 外部温度服务

laPower 的温度可以有两个来源：**仪表自带的温度**，或**通过 TCP 连接的外部温度传感器**。WITRN 从 HID 报告读取温度，POWER-Z 从 ADC 快照补齐。外部来源适合把外置热电偶、红外测温模块或其它测温设备的数据接进来，与电压电流一起记录、绘图并导出。

### 选择温度来源

在「监控」Tab 的命令栏点击 `温度服务` 右侧的向下箭头，打开配置浮出面板：

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `来源` | `仪表` = 仪表温度；`外部` = TCP 温度服务 | `外部` |
| `IP` | 温度服务器地址（仅 `外部` 时可用） | `127.0.0.1` |
| `端口` | 温度服务器端口（仅 `外部` 时可用） | `1573` |

连接与断开走命令栏上的 `温度服务` 开关按钮，不在浮出面板里。**连接期间来源不可切换** —— 先断开再改。

选 `仪表` 时不需要任何外部程序，直接使用仪表报文里的温度字段。注意该字段只在部分型号上验证过；数值不可信时解析器会当作「无温度」处理，界面显示 `--`。

`仪表` 温度源的生命周期跟着仪表走：断开或拔出仪表时一并注销，读数回 `--`、`温度服务` 按钮复位、`来源` 重新可选 —— 后端只为 TCP 源发 `temp-disconnected`，仪表源没有可关闭的会话，所以这一步在前端连接状态变化里做。已记录的温度曲线与 `有温度数据` 标记不受影响，只有实时读数会被清掉。`外部` 的 TCP 会话与 HID 流相互独立，拔表不会断开它。

温度接入后即可在读数卡上看到当前值与 `平均` / `最低` / `最高`，在图表里作为第四条 Y 轴曲线，并可通过 `导出CSV` 右侧箭头 → `包含温度` 写进 CSV 的 `Temp(°C)` 列。

### 协议

刻意做得极简，任何语言几行就能实现服务端。

- **传输**：TCP，服务端监听，laPower 作为客户端连入。
- **格式**：每行一个纯十进制数值，以 `\n` 结束。单位为摄氏度。
- **无握手、无心跳、无帧头。**

```
25.125\n
25.250\n
24.875\n
```

#### 行为细节

- **连接超时 5 秒。** 地址会做完整解析，IPv4 优先于 IPv6 依次尝试。
- **发送间隔不限。** 读取侧使用 250 ms 的读超时循环，超时只是继续等待而不断开，因此**发送间隔超过 10 秒也没问题**，连接会在空闲期间保持。
- **半行会被正确续接。** 读超时可能带着半行数据返回，实现上只在整行处理完成后才清空缓冲区，所以数据被 TCP 分片切开不会产生坏值。
- **单行超过 256 字节视为坏数据**并丢弃该行，防止没有换行符的数据流把缓冲区撑爆。
- **服务端关闭连接**（读到 EOF）时，应用会收到断开通知并更新界面状态。

### 示例服务器

仓库里带了一对 Python 示例，不需要任何第三方库：

| 文件 | 用途 |
| --- | --- |
| [`temperature-example/network_server.py`](../temperature-example/network_server.py) | 温度服务器示例，每秒发送一个 0–100 之间的随机值 |
| [`temperature-example/network_client.py`](../temperature-example/network_client.py) | 客户端示例，用于单独验证服务器 |

启动服务器：

```bash
python temperature-example/network_server.py
```

```
温度服务器启动，监听 127.0.0.1:1573
等待客户端连接...
```

然后在应用里把 `来源` 设为 `外部`、地址保持默认的 `127.0.0.1:1573`，点击命令栏的 `温度服务` 连接即可。

#### 自己实现服务端

参照示例改成读取真实传感器即可，核心只有这几行：

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

如果服务器不在本机，记得把绑定地址改为 `0.0.0.0`，并在应用里填写服务器的实际 IP。

### 故障排查

**连接超时** —— 检查 IP 与端口；服务器若在另一台机器上，确认它绑定的是 `0.0.0.0` 而不是 `127.0.0.1`，以及防火墙是否放行该端口。

**连上了但温度一直是 `--`** —— 确认服务器发送的是纯数字加换行。带单位（`25.1°C`）、带 JSON 包装、或不用换行分隔数值都会被判为无效行。LF 和 CRLF 换行均可使用。

**数值跳变或出现明显错误的值** —— 检查是否有多个数值挤在一行里没有换行符。单行超过 256 字节会被整行丢弃。

**切不动 `来源` 单选** —— 温度服务处于连接状态时来源被锁定，先点 `温度服务` 断开。

## 参与贡献

1. Fork 仓库并创建分支。
2. 完成改动后运行上面的核心质量检查。
3. 保持前端模块的 `// @ts-check`，纯逻辑优先抽成可直接测试的模块。
4. 新增设备型号或固件前，用实机样本确认 HID 字节布局与量程。

测试新增遵循“测试与回归边界”规则；不要为普通 UI 或功能表面变化新增独立测试、设计文档或 CI job。
