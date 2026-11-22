[English](../en/DEVELOPMENT.md) | [简体中文](../DEVELOPMENT.md) | **繁體中文** | [日本語](../ja/DEVELOPMENT.md)

← 返回 [README](../../README.zh-TW.md)

# 開發與建置

- [環境要求](#環境要求)
- [建置與運行](#建置與運行)
- [發佈流程](#發佈流程)
- [質量檢查](#質量檢查)
- [測試與迴歸邊界](#測試與迴歸邊界)
- [語言選擇](#語言選擇)
- [詞典維護與翻譯檢查](#詞典維護與翻譯檢查)
- [無頭測試介面](#無頭測試介面)
- [開發展示工具](#開發展示工具)
- [效能測量](#效能測量)
- [CI 門禁](#ci-門禁)
- [Linux 自行編譯](#linux-自行編譯)
- [macOS 自行編譯](#macos-自行編譯)
- [外部溫度服務](#外部溫度服務)
- [參與貢獻](#參與貢獻)

## 環境要求

| 組件 | 要求 | 說明 |
| --- | --- | --- |
| Rust | 1.85+ | 工作區 `rust-version` |
| Tauri CLI | 2.12.1 | npm 鎖定的 `@tauri-apps/cli`，透過 `npx --no-install tauri` 呼叫 |
| Windows | 10 / 11 | 當前開發與驗證平台 |
| macOS | 12+ | 最低部署目標；CI 使用 macOS 26，舊系統相容性需實機驗證 |
| Node.js | 24 | CI、lint / typecheck / test / 前端產物 |

專案使用 npm 並提交 `package-lock.json`（CI 使用 `npm ci`）。前端為原生 ES Modules，`frontendDist` 指向產生的 `out/`。雖然 Node 不參與 Rust 編譯，但 `npm run build` 必須先於 `cargo build`、`cargo test`、`cargo check` 和 `cargo clippy`；修改 `src/` 後需重建 `out/` 並重新連結 Rust 二進位檔。

## 建置與運行

```bash
git clone https://github.com/KHWLGH/laPower.git
cd laPower
npm ci
npm run dev
```

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 自動產生開發前端並啟動原生應用程式 |
| `npm run dev:web` | 啟動模擬裝置瀏覽器預覽（可加 `-- --port 4174` 改連接埠） |
| `npm run build` | 單獨產生供 Cargo 內嵌的開發前端 `out/` |
| `npm run build:app` | 自動產生壓縮前端並建置本機安裝包 |

`dev` 的 `beforeDevCommand` 與打包的 `beforeBuildCommand` 會自動建置對應前端，無需手動前置執行 `npm run build` 或 `npm run build:dist`；但直接執行 Cargo 檢查前仍須先產生 `out/`。開發模式不提供前端熱更新，修改 `src/` 後需重啟 `dev` 或重新連結。本機發佈產物預設輸出到 `target/release/bundle/`，CI 依目標輸出到 `target/<target>/release/bundle/`。

### Windows 建置指令碼遭防毒軟體攔截

若 Cargo 在執行 `libc` 的 `build-script-build` 前回報「拒絕存取（os error 5）」或檔案占用（os error 32）且遭防毒軟體攔截，受影響的僅為編譯期輔助程式而非應用程式執行階段。已在本機 Windows/MSVC 與 Kaspersky 環境驗證 `libc 0.2.189` 在 `opt-level = 2` 時觸發攔截、設為 `0` 時正常。

根目錄 `Cargo.toml` 為此在 `[profile.dev.package.libc]` 設定 `opt-level = 0`（同時作用於 dev 與 test，不影響 release 及其餘相依套件；`profile.dev.build-override` 無法覆蓋既有 `package."*"`）。更新設定後直接重跑建置即可，無需清空 `target/`。若仍遭攔截，請保留防毒軟體的偵測名、路徑與雜湊以便查核回報。

### 分級清理

各級累加包含前一級並在刪除完成後返回，預設保留 Rust 編譯快取、相依套件與安裝包：

| 命令 | 刪除範圍 |
| --- | --- |
| `npm run clean` | `out/`、`output/`、`bench/results/`、根目錄和 `src/` 下的 `.playwright-cli/`、`src-tauri/gen/schemas/` |
| `npm run clean:incremental` | 再清理 `target/` 與 `src-tauri/target/` 中 `debug/release` 的增量快取（含交叉編譯目標） |
| `npm run clean:build` | 再清理完整 `target/`、`src-tauri/target/` 與 `dist/` |
| `npm run clean:all` | 再清理 `node_modules/`（下次開發前需先執行 `npm ci`） |

支援預覽而不實際刪除：

```bash
npm run clean:build -- --dry-run
```

清理器在執行前檢查全部目標及 Git 追蹤狀態，若目標或祖先目錄為符號連結 / junction 則拒絕刪除；最多平行處理 4 個目錄，占用錯誤有限重試，最終失敗傳回非零結束碼。請先關閉開發、建置與預覽程序；已追蹤截圖、`bench/baselines/`、原始碼、鎖定檔及儲存庫外快取（含自訂 `CARGO_TARGET_DIR`）不會被清理。

### 執行元件清單

關於頁使用隨包產生的 `src/third-party-components.json` 元件清單與按需載入的 `src/legal-notices.json` 全文目錄。修改 Cargo 執行相依套件、內建資源或授權輸入後，執行 `npm run components:generate` 並提交產物與補充材料，再用 `npm run components:check` 校對（勿手改產生檔案）。

指令碼透過離線 `--locked` 的 Cargo metadata/tree 保守合併四個桌面目標的 normal 相依套件（排除工作區、純開發/建置及程序巨集套件；相依快取缺失時需先連網 `cargo fetch --locked`）。授權全文來自 [`COPYRIGHT`](../../COPYRIGHT)、[`LICENSE`](../../LICENSE)、[`LICENSE.LGPL-3.0`](../../LICENSE.LGPL-3.0)、本機 Cargo 快取及 `licenses/materials.json` 登記的預存補件（記錄版本、revision、上游路徑與 SHA-256；僅經審核的固定版本例外可繞過缺件檢查）。一般前端建置只校對並複製已有清單，不呼叫 Cargo 或網路。

發佈 Tag 的原始碼封存不含本機快取或系統 SDK，從封存離線/復現建置前需透過 `cargo fetch --locked` 與 `npm ci` 取得鎖定的相依原始碼與工具鏈。自有貢獻著作權行固定為 `Copyright (C) 2026 KHWLGH`，不因 Git 作者推定轉讓，範圍細節見 [`COPYRIGHT`](../../COPYRIGHT)。

## 發佈流程

日常僅維護 `changelog/unreleased/zh-CN.md`。發佈前由開發助手整理合併重複項目、編寫面向使用者的簡體中文說明並產生校對 `en.md`（不要求逐句對應，不使用翻譯 API）。

```bash
npm run release:prepare -- 0.3.0 --date 2026-11-22 --dry-run
npm run release:prepare -- 0.3.0 --date 2026-11-22
npm run release:notes
npm run showcase:capture
```

將範例版本與日期替換為目標值。`release:prepare` 校驗雙語草稿非空且目標版本目錄不存在，隨後封存至 `changelog/<version>/`、同步版本、更新根目錄 `CHANGELOG.md` 索引並產生 `dist/release-notes.md`，最後清空草稿（`--dry-run` 僅預覽不寫盤；失敗時保留草稿以便排查）。Release 說明預設展開英文並摺疊簡體中文，均附帶三平台安裝說明；命令不自動提交、打 Tag 或發佈。

### 發佈前更新文件截圖

每次發佈須按以下順序完成：**同步版本與封存更新記錄 → 產生並逐張檢查截圖 → 執行核心質量檢查 → 提交改動 → 推送版本 Tag → 由 GitHub Actions 建置發佈**（無需本機預編譯安裝包；若版本已封存則直接重跑 `npm run showcase:capture`）。

首次使用先執行 `npx playwright install chromium`（Linux 缺少依賴時用 `--with-deps`）。截圖預設產生 **72 張**（40 張主介面 + 32 張報告樣式），寫入 `docs/screenshots/<language>/`：

- 基礎 32 張（必須全量更新）：四語言 × 淺/深主題 × 監控、PD 分析、協定控制、設定（保留完整標題列、120 秒統一模擬資料、一致版本號）。
- 額外 40 張：協定偵測主介面 8 張 + 16:9 圖片報告、長圖、影片影格與協定偵測報告樣式 32 張。

產生後逐張核對語言、主題、文字截斷、圖表、協定狀態、導覽與版本一致性，同步更新四語言 README 中的版本號與截圖引用後一併提交。

### 文件維護範圍

README、使用指南和本開發指南維護中（簡/繁）、英、日四語；技術架構、效能說明、協定庫 README 和更新記錄維護中英雙語（0.2.2 及以前僅保留簡中，不補英文佔位頁）。主要文件優先連結同語言版本，繁體頁面對次要文件優先連結簡中，日文頁面優先連結英文並註明語言。不新增翻譯雜湊或文件專用 CI。

### 更新記錄連結

版本正文存放於 `changelog/<version>/`，根目錄 `CHANGELOG.md` 僅作為版本索引並保留原錨點。正文內部相對連結以檔案所在目錄為基準（如 `../../docs/USAGE.md`），GitHub Release 渲染時自動固定到對應版本 Tag。

### 單獨設定版本

僅需同步版本號而不封存記錄時使用：

```bash
npm run version:set -- 0.3.0
```

命令校驗 `X.Y.Z` 格式後原子同步 `package.json`、`package-lock.json`、`Cargo.toml`（`[workspace.package] version`）、`Cargo.lock` 與 `src-tauri/tauri.conf.json`（Rust 成員 crate 透過 `version.workspace = true` 繼承；重複同版本不產生改動，也不建立提交或 Tag）。`test/version-sync.test.js` 持續驗證版本一致性。

### 手動建置與首次驗收

在 GitHub **Actions → CI → Run workflow** 選擇分支或 Tag 可手動觸發打包（不會建立或公開 Release）：

| 目標 | Runner | Rust target | 安裝包 |
| --- | --- | --- | --- |
| Windows x64 | `windows-2022` | `x86_64-pc-windows-msvc` | MSI、NSIS EXE（`_setup`）、便攜 ZIP |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | DEB、RPM、AppImage |
| macOS Intel | `macos-26-intel` | `x86_64-apple-darwin` | DMG |
| macOS Apple Silicon | `macos-26` | `aarch64-apple-darwin` | DMG |

四目標全部成功後彙總 `release-packages`（含全部八個產物及 `SHA256SUMS`，可用 `sha256sum -c SHA256SUMS` 校驗）。Windows 便攜 ZIP 命名為 `laPower_<版本>_windows-x64_portable.zip`，解壓後直接執行 `laPower.exe`（需 WebView2 Runtime，設定仍讀取標準使用者資料目錄）。macOS 建置顯式傳遞 `--bundles app,dmg` 以保留 `.app` 供簽章與中繼資料校驗（僅發佈 DMG）。首次啟用自動發佈前，須在實機驗收 Windows、兩架構 Mac（含 macOS 12 相容性）及設定 udev 後的 Linux 裝置連線。

### 推送版本 Tag 自動發佈

完成驗證並提交發佈變更後，推送與清單一致的 `vX.Y.Z` Tag：

```bash
git tag v0.3.0
git push origin v0.3.0
```

CI 使用 Node.js 24、Rust stable、Tauri CLI 2.12.1 與 `tauri-apps/tauri-action@v1`（Linux 固定 Ubuntu 22.04 以控制 glibc 依賴版本）。全部質量檢查與四平台打包通過後，發佈任務透過 `GITHUB_TOKEN`（需 `contents: write` 權限）建立草稿、上傳八個產物與 `SHA256SUMS`、校驗遠端檔案大小與 SHA-256 後自動公開 Release。同 ref 串列執行且不取消正在上傳的任務；上傳失敗保留草稿供重跑替換，已公開的同名 Release 拒絕覆蓋。Windows 安裝包未憑證簽章，macOS 為 ad-hoc 簽章，Linux 安裝包不設定 udev 權限。

## 質量檢查

依改動範圍選擇入口（所有入口遇錯即停）：

| 命令 | 適用情境 |
| --- | --- |
| `npm run check` | 日常前端檢查（依序執行 `npm test`、`typecheck`、`lint`，不建置前端） |
| `npm run check:rust` | Rust 檢查（先建置 `out/`，再執行 `cargo fmt`、workspace Clippy 與測試） |
| `npm run check:all` | 交付前完整核心檢查（組合以上兩組與 `components:check`，只建置一次前端） |

`npm test` 僅掃描 `test/*.test.js`（定向執行用 `node --test test/檔名.test.js`）；Biome 自動跳過輸出目錄與 `.local-*` 目錄。核心測試涵蓋純邏輯、資料處理、協定/檔案契約、安全邊界與發佈同步，包括：

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

修改 `usbpd-parser` 或 `witrn-hid` 的 feature 門時，須補跑 CI 的非預設 feature 組合檢查：

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

## 測試與迴歸邊界

- 普通功能增刪改、UI 佈局、樣式、文案和選項變化預設不新增迴歸測試。
- 僅在涉及資料丟失/損壞、協定相容、崩潰/死鎖、安全邊界、發佈建置不變量或已確認的高影響歷史缺陷時補充測試。
- 優先擴展現有核心測試，不為每個小功能新建測試檔案、設計方案或 CI job。
- 效能 benchmark 與實機檢查按需手動執行，不加入每次改動的瀏覽器自動迴歸或額外 CI workflow。

## 語言選擇

在「設定 → 外觀與語言 → 語言」可選擇跟隨系統、简体中文、繁體中文、English、日本語；切換立即生效並儲存偏好，保留連線、記錄、資料、圖表範圍、篩選與選中報文（重設設定回到自動模式）。

Linux 按第一項非空的 `LC_ALL → LC_MESSAGES → LANG` 偵測；Windows / macOS 使用原生系統 locale，不可用時取 WebView 首選語言，最終回退英文。指令碼標籤 `Hans` / `Hant` 優先於區域判定；否則 `CN`/`SG` 與無區域 `zh` 對應簡中，`TW`/`HK`/`MO` 對應繁中，`ja` 對應日文，其餘含 `C`/`POSIX` 對應英文（統一規範化大小寫、底線與編碼後綴；手動選擇覆蓋自動偵測）。

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
```

## 詞典維護與翻譯檢查

`src/i18n.js` 提供 `t(key, params)`、locale 解析與訂閱；`src/i18n-messages.js` 四列依序為英文（基準與缺詞回退）、簡中、繁中、日文。使用語義鍵名並保持插值參數名一致；使用者文件以簡中為基準，其餘語種人工校對。

靜態 HTML 保留英文兜底文字與 `data-i18n*` 屬性（含圖示或控制項時僅標記文字 span）；動態文字與持續通知使用 `t` 或延遲函式產生。切換語言只刷新文案與圖表標籤，不得重連裝置或重建資料。後端錯誤沿用 `{code, params, detail?}`，由前端翻譯 `code` 並保留原始診斷（相容字串錯誤）；PD 標準名稱、原始回覆、單位與 CSV/PD 資料格式保持不變。

```bash
node --test test/i18n.test.js test/settings-persistence.test.js
node tools/showcase/verify-i18n.mjs
npm run showcase:capture -- --language zh-CN,zh-TW,en,ja
```

核對四語、淺深主題、900×600 / 1280×800、連線與記錄/PDM 狀態、PD 篩選、CSV/PD 往返及無障礙標籤。模擬檢查不替代 Linux `LANG`/`LC_*` 實機啟動、macOS GUI、原生對話框或真實儀表驗收。

## 無頭測試介面

`tools/showcase/headless.mjs` 為 Node 指令碼提供可複用的 Playwright 無頭封裝（依賴 `npx playwright install chromium`），不附帶測試排程器或 CI 任務：

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

- `createHeadlessHarness({ channel, distribution, timeout })`：預設 Chromium、原始碼模式、`15 s` 逾時；可切換 `msedge`/`chrome` 或 `out/`。
- `openApp({ language, theme, query, context, beforeLoad })`：建立隔離的儲存、虛擬裝置、凍結時鐘與下載上下文並等待介面就緒。
- `connect(path)`、`record()`、`pause()` 驅動真實介面控制項；`freeze()`/`resume()` 與 `advance(ms)`（0–300000 ms）推進虛擬時間並等待消費 ACK；`flush()` 等待消費邊界，`waitForCharts()` 等主圖顯示工作及兩影格。
- `diagnostics()` 回傳 `source`、`stream`、`performance`、未捕獲 `errors` 與 `consoleErrors`；可用 `app.page.evaluate()` 存取 `window.__SHOWCASE__` 故障鉤子。`await using`（Node 24）在離開作用域時自動清理資源並向上拋出錯誤。

## 開發展示工具

`tools/showcase/` 是獨立瀏覽器開發工具，提供虛擬 WITRN K2 與 POWER-Z KM003C、確定性曲線、PD 報文及協定控制結果（標題列採用與主應用一致的圖示與樣式；工具不連真機且不進入 `src/`、`out/` 或安裝包）。

```bash
npm ci
npx playwright install chromium
npm run showcase:dev
npm run showcase:capture
```

- **互動預覽**：監聽 `http://127.0.0.1:4173`（支援 `-- --port 4174` 改連接埠、`/app/?theme=dark` 或 `/app/?theme=system`），外層工具列支援一鍵填充 120 秒展示資料、凍結/繼續模擬、步進 10 秒與重設預覽。
- **截圖產生**：Chromium 1280×800 × 2× DPI 產生 2560×1600 主介面圖（保留完整標題列），以及 1920×1080 / 1920×1340 報告樣式圖（監控報告經 `cargo run --locked -p lapower --example showcase-reports` 渲染；僅抓主介面可用 `--page record,pd,trigger,detection,settings` 跳過 Rust 編譯）。可用 `--language`、`--theme`、`--page`、`--output` 篩選；詳細參數見 `npm run showcase:capture -- --help`。
- **樣例與韌體除錯**：修改 `tools/showcase/scenario.js` 調整虛擬曲線與 PDO；修改原始 PD 樣例後用 `node tools/showcase/generate-pd.mjs` 重建 `pd-fixtures.json`（臨時產物寫入 `output/`）。debug 建置中 `video_export_pick` 支援讀取 `LAPOWER_VIDEO_TARGET` 跳過原生儲存對話框以服務本機自動化（release 建置僅走原生對話框）。
- **外觀字型核查**：執行 `node tools/showcase/verify-appearance.mjs` 檢查繁體中文淺深主題與 100% / 125% / 150% DPI 下的 DOM 與 Canvas 字型，結果寫入 `output/appearance-verification/`。

## 效能測量

`bench/` 保留演算法、存儲、記憶體、縮放渲染、啟動與發貨形狀基準（細節見 [效能基準與邊界](../PERFORMANCE.md)（簡體中文））：

| 命令 | 用途 |
| --- | --- |
| `node bench/core.mjs` | 列存儲、分桶、範圍統計與能量積分基準 |
| `node bench/core.mjs --compare` | 與 `bench/baselines/` 基線進行多輪對照 |
| `node bench/core.mjs --verify-baseline` | 單次正確性與基線結構校驗（不計時，供 CI 使用） |
| `npm run bench:memory` | 100 萬 / 500 萬點追加與串流 CSV 匯入記憶體對比（預設對比 `bench/results/memory-before/`，支援 `-- --baseline <目錄>`，校驗列 SHA-256 一致且列緩衝節省 ≥ 20%，輸出 `bench/results/memory.json`） |
| `node bench/chart-zoom.mjs` | 滾輪縮放／平移影格耗時與 Canvas 2D 渲染管線基準 |
| `node bench/phase2.mjs` | 範圍統計與協作切片前後對照 |
| `node bench/phase3.mjs` | 分塊存儲、統計與能量計算前後對照 |
| `node bench/extrema.mjs` | 逐點掃描與極值索引演算法對照 |
| `node bench/startup.mjs` | 原生冷啟動分段探測（按需手動執行） |
| `node bench/packaging.mjs` | 檢查 `out/` 發貨檔案集合與資源引用 |
| `cargo bench -p lapower` | Rust 協定解碼、編碼與選擇路徑基準 |

## CI 門禁

`.github/workflows/ci.yml` 在每次 push 與 PR 執行固定檢查：

| Job | 內容 |
| --- | --- |
| `validate` | Linux 依賴、前端建置、JS 測試、typecheck、lint、Rust fmt、Clippy、workspace test、發貨形狀與基線結構 |
| `backend-other-platforms` | Windows 與 macOS workspace test |
| `crate-features` | 協定 crate 非預設 feature 組合的 Clippy 與 test |
| `package` | 僅版本 Tag push 或手動觸發；四目標平行打包，單目標失敗不取消其餘平台 |
| `package-summary` | 四目標全部成功後校驗八個安裝包並產生 `SHA256SUMS` |
| `release` | 僅版本 Tag push；上傳並校驗遠端附件後自動公開 Release |

CI 不安裝瀏覽器，不執行 UI 矩陣或長時擷取；發佈指令碼的失敗與校驗保護由 `test/release.test.js` 離線涵蓋。

## Linux 自行編譯

Debian / Ubuntu 編譯依賴與建置步驟（Linux 未接入持續硬體迴歸）：

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl file pkg-config libssl-dev libudev-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev patchelf
npm ci
npm run build
npx --no-install tauri build
```

### udev 規則（必需）

Debian / Ubuntu 可建立 `/etc/udev/rules.d/99-lapower.rules`，向活動本機桌面工作階段授予 WITRN HID 與 POWER-Z Bulk / CDC 序列埠權限：

```udev
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0716", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0063", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0061", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="5fc9", TAG+="uaccess"
```

執行 `sudo udevadm control --reload-rules` 後重新插拔儀表再啟動應用。無 systemd-logind 桌面工作階段的環境請改用發行版裝置存取群組規則。

## macOS 自行編譯

需 Xcode Command Line Tools、Rust 穩定版與 npm 鎖定的 Tauri CLI：

```bash
npm ci
npm run build
npx --no-install tauri build
```

macOS private API 的 Cargo feature 與 `tauri.macos.conf.json` 須保持一致。建置使用 `signingIdentity: "-"`（ad-hoc 簽章）與 `minimumSystemVersion: "12.0"`（CI 設定 `MACOSX_DEPLOYMENT_TARGET=12.0` 及 `TAURI_BUNDLER_DMG_IGNORE_CI=false`）。首次開啟方式見 [README 下載與安裝](../../README.zh-TW.md#-下載與安裝)；正式發佈前仍需在 Intel / Apple Silicon Mac（含 macOS 12）實機驗收 GUI 與硬體連線。

## 外部溫度服務

laPower 支援**儀表自帶溫度**與**外部 TCP 溫度服務**兩種來源（WITRN 取自 HID 報告，POWER-Z 取自 ADC 快照）。

### 選擇溫度來源

在「監控」命令列展開 `溫度服務` 右側箭頭設定：

| 欄位 | 說明 | 預設 |
| --- | --- | --- |
| `來源` | `儀表` = 儀表溫度；`外部` = TCP 溫度服務 | `外部` |
| `IP` | 伺服器位址（僅 `外部` 可用） | `127.0.0.1` |
| `連接埠` | 伺服器連接埠（僅 `外部` 可用） | `1573` |

連線/中斷透過主按鈕操作，**連線期間不可切換來源**。`儀表` 源隨儀表中斷自動復位（前端在連線狀態變化時清除即時讀數並解鎖來源選擇）；`外部` TCP 工作階段獨立於儀表連線。接入後可在讀數卡、`顯示` 第四個 Y 軸及 CSV `Temp(°C)` 欄中使用。

### 協定與範例

極簡明文 TCP 協定（laPower 作為客戶端連入，無握手或心跳，每行一個攝氏度十進位數並以 `\n` 結尾，如 `25.125\n`）：

- **連線逾時 5 秒**（IPv4 優先於 IPv6）。
- **傳送間隔不限**：250 ms 讀逾時迴圈僅繼續等待而不主動斷線；支援 TCP 分片半行續接，單行超過 256 位元組依壞行丟棄至下一換行；服務端 EOF 觸發前端中斷狀態。

儲存庫內建無第三方相依套件的 Python 範例（[`temperature-example/network_server.py`](../../temperature-example/network_server.py) 與 [`temperature-example/network_client.py`](../../temperature-example/network_client.py)）：

```bash
python temperature-example/network_server.py
```

自建服務端範例核心（跨機存取請綁定 `0.0.0.0`）：

```python
import socket

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("0.0.0.0", 1573))
server.listen(1)

conn, addr = server.accept()
while True:
    temperature = read_your_sensor()      # 傳回 float
    conn.sendall(f"{temperature}\n".encode())
```

### 故障排查

- **連線逾時**：檢查 IP、連接埠、跨機服務端是否綁定 `0.0.0.0` 及防火牆放行情況。
- **已連線但顯示 `--`**：確保僅傳送純數字加換行（LF/CRLF 均可），勿附帶單位或 JSON 包裝。
- **數值異常跳變**：檢查是否缺失換行符導致多筆資料拼接並超過 256 位元組被丟棄。
- **無法切換 `來源`**：先點擊 `溫度服務` 主按鈕中斷連線。

## 參與貢獻

1. Fork 儲存庫並建立分支。
2. 完成改動後執行對應範圍的核心質量檢查（`npm run check:all`）。
3. 保持前端模組 `// @ts-check`，純資料處理邏輯與 DOM / Tauri 解耦。
4. 新增裝置型號或韌體前，須以實機樣本確認位元組結構與量程，並遵守[測試與迴歸邊界](#測試與迴歸邊界)。
