[English](../en/DEVELOPMENT.md) | [简体中文](../DEVELOPMENT.md) | **繁體中文** | [日本語](../ja/DEVELOPMENT.md)

← 返回 [README](../../README.zh-TW.md)

# 開發與建置

- [環境要求](#環境要求)
- [建置與運行](#建置與運行)
- [發佈流程](#發佈流程)
- [質量檢查](#質量檢查)
- [測試與迴歸邊界](#測試與迴歸邊界)
- [無頭測試介面](#無頭測試介面)
- [開發展示工具](#開發展示工具)
- [效能測量](#效能測量)
- [CI 門禁](#ci-門禁)
- [Linux 自行編譯](#linux-自行編譯)
- [macOS 自行編譯](#macos-自行編譯)
- [外部溫度服務](#外部溫度服務)
- [參與貢獻](#參與貢獻)

## 語言選擇

在「設定 → 外觀與語言 → 語言」可選擇跟隨系統、简体中文、繁體中文、English、日本語。切換立即生效並儲存偏好，保留連線、記錄、資料、圖表範圍、篩選和選中報文；重設設定回到自動模式。

Linux 按第一項非空的 LC_ALL → LC_MESSAGES → LANG 偵測；Windows／macOS 使用原生系統 locale。原生不可用時採用 WebView 首選語言，最終回退英文。Hans 優先選擇簡中、Hant 優先選擇繁中；否則 CN／SG 和無區域 zh 為簡中，TW／HK／MO 為繁中，ja 為日文，其餘含 C／POSIX 為英文。統一處理大小寫、下劃線、編碼與修飾後綴；手動選擇覆蓋自動偵測。

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
```

## 詞典維護與翻譯檢查

src/i18n.js 提供 t(key, params)、locale 解析和語言變更訂閱，四份詞典離線打包，英文作為基準與缺詞回退。src/i18n-messages.js 的四列依次為英文、簡中、繁中、日文。使用語義鍵名，保持插值參數名稱一致；含數量的訊息按需補充單數版本。使用者文件以簡中版本為內容基準，其他語言的內容由人工校對。

靜態 HTML 使用英文兜底和 data-i18n／data-i18n-title／data-i18n-placeholder／data-i18n-aria-label／data-i18n-alt；含圖示或輸入控制項的元素只標記文字 span。動態內容通過 t 產生，持續通知和記錄用延遲文字函數。切換只更新標籤、選單、下拉和圖表，不能重新連線或重建資料。

應用後端錯誤使用 {code, params, detail?}，異步事件保留原有欄位並添加 description；前端翻譯 code，保留原始診斷，仍相容插件字串錯誤。檔案對話框標題與篩選器由前端翻譯，原生按鈕跟隨 OS。PD 標準名、解碼欄位、原始回覆、單位和 CSV／PD 資料格式保持相容。

```bash
node --test test/i18n.test.js test/settings-persistence.test.js
node tools/showcase/verify-i18n.mjs
npm run showcase:capture -- --language zh-CN,zh-TW,en,ja
```

檢查四語、淺深主題、900×600／1280×800、連線和記錄／PDM 狀態、PD 選擇和篩選、CSV／PD 往返、錯誤、檔案入口及無障礙標籤。Linux AppImage 的 LANG／LC_* 實機啟動驗收需在 Linux 完成，瀏覽器模擬不替代原生或硬體驗收。

模擬裝置與瀏覽器檢查不能取代 Linux AppImage、macOS GUI、原生檔案對話框或真實儀表驗收。按需在對應機器檢查系統語言、手動語言持久化、錄製／PDM、檔案對話框與 CSV／PD 往返；歷史驗收結果不保證目前建置。


## 環境要求

| 組件 | 要求 | 說明 |
| --- | --- | --- |
| Rust | 1.85+ | 工作區 `rust-version` |
| Tauri CLI | 2.12.1 | npm 鎖定的 `@tauri-apps/cli`，通過 `npx --no-install tauri` 調用 |
| Windows | 10 / 11 | 當前開發與驗證平台 |
| macOS | 12+ | 最低部署目標；CI 使用 macOS 26，舊系統相容性需實機驗證 |
| Node.js | 24 | CI、lint / typecheck / test / 前端產物 |

專案使用 npm，提交 `package-lock.json`，CI 使用 `npm ci`。前端是原生 ES Modules，`frontendDist` 指向建置產生的 `out/`；Node 不參與 Rust 編譯，但 `npm run build` 必須先於 `cargo build`、`cargo test`、`cargo check` 和 `cargo clippy`。改動 `src/` 後先重建 `out/`，再重新鏈接 Rust 二進制。

## 建置與運行

```bash
git clone https://github.com/KHWLGH/laPower.git
cd laPower
npm ci
npm run dev
```

日常使用以下快捷入口；原有命令繼續可用，npm 使用專案內鎖定的 Tauri CLI：

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 啟動原生應用程式，自動建置開發前端 |
| `npm run dev:web` | 啟動模擬裝置瀏覽器預覽；可追加 `-- --port 4174` |
| `npm run build` | 單獨產生供 Cargo 內嵌的開發前端 |
| `npm run build:app` | 建置本機安裝包，自動產生發佈前端 |

`dev` 的 `beforeDevCommand` 已負責建置前端，啟動前無需重複執行 `npm run build`。它沿用內嵌資源方式，不提供前端熱更新；修改前端後重新啟動 `dev`，或先建置前端再重新連結 Rust 二進位檔。

本機未指定 target 時，發佈產物位於 `target/release/bundle/`；CI 顯式指定 target，產物位於 `target/<target>/release/bundle/`。Tauri CLI 會自動運行 `beforeBuildCommand` 產生壓縮前端，打包前無需再手動執行 `npm run build:dist`。直接運行 Cargo 檢查時仍須先產生 `out/`。

### Windows 建置指令碼遭防毒軟體攔截

若 Cargo 在執行 `libc` 的 `build-script-build` 前回報「拒絕存取（os error 5）」或檔案占用（os error 32），且防毒軟體回報攔截了相同路徑，受影響的是編譯時程式，不屬於應用程式執行階段。已在本機 Windows/MSVC 與 Kaspersky 環境重現 `libc 0.2.189` 的二級最佳化建置指令碼遭攔截，而零最佳化版本可正常執行。

根目錄 `Cargo.toml` 為 `libc` 單獨設定 `[profile.dev.package.libc] opt-level = 0`，其他相依套件仍使用二級最佳化，release 設定不變。此設定也適用於 test 繼承的 dev profile，同時影響 `libc` 的開發用程式庫。只加入 `profile.dev.build-override` 無法覆蓋既有的 `package."*"` 設定。更新設定後直接重新執行原建置命令即可，Cargo 會重建相關產物，無須清空整個 `target/`。

這是針對已驗證編譯組合的相容性調整，無法保證其他版本或檔案不會被誤報。若仍遭攔截，保留防毒軟體的偵測名稱、路徑與檔案雜湊，以便查核並向廠商回報；僅憑 `os error 5` 本身無法確定是誤報。

### 分級清理

各級累計包含前一級，等待刪除完成後返回；預設保留 Rust 編譯快取、相依套件和安裝包：

| 命令 | 刪除範圍 |
| --- | --- |
| `npm run clean` | `out/`、`output/`、`bench/results/`、根目錄和 `src/` 下的 `.playwright-cli/`、`src-tauri/gen/schemas/` |
| `npm run clean:incremental` | 再清理 `target/` 與 `src-tauri/target/` 中 `debug/release` 的增量快取，包含交叉編譯目標 |
| `npm run clean:build` | 再清理完整 `target/`、`src-tauri/target/` 與 `dist/` |
| `npm run clean:all` | 再清理 `node_modules/`；下次開發先執行 `npm ci` |

所有級別都支援只預覽路徑：

```bash
npm run clean:build -- --dry-run
```

清理器需要 Node.js 與 Git，從腳本位置確定儲存庫根目錄，執行前統一檢查所有目標與 Git 追蹤狀態；目標或祖先目錄是符號連結／junction 時拒絕清理。最多平行處理四個目錄，輸出每項結果與總耗時；檔案占用錯誤有限重試，最終失敗傳回非零退出碼。先關閉相關開發、建置與預覽程序；命令不會主動終止它們。

`output/` 的檢查截圖、`bench/results/` 的原始結果與本機對照快照也會刪除。已追蹤的文件截圖、`bench/baselines/`、原始碼、鎖定檔、儲存庫外快取與應用程式復原資料不會清理；自訂 `CARGO_TARGET_DIR` 不在上述路徑時需自行管理。清理後啟動 `dev` 會重建前端；直接執行 Cargo 仍須先執行 `npm run build`。

### 執行元件清單

關於頁使用隨附的 `src/third-party-components.json` 元件清單，授權閱讀器按需載入 `src/legal-notices.json` 全文目錄。修改 Cargo 執行相依套件、內建資源或授權輸入後，執行 `npm run components:generate` 並提交兩份產生結果與必要材料，再用 `npm run components:check` 核對；不要手改產生的目錄。腳本以鎖定、離線的 Cargo metadata/tree 保守合併 Windows x64、Linux x64、macOS Intel 和 Apple Silicon 的 normal 相依套件，排除工作區套件、純開發／建置與程序巨集套件；這不是精確的發佈編譯單元圖。內建資源版本來自其聲明，不明時標為隨應用程式內建。

授權材料來自根目錄 [`COPYRIGHT`](../../COPYRIGHT)、[`LICENSE`](../../LICENSE)、[`LICENSE.LGPL-3.0`](../../LICENSE.LGPL-3.0)、本機 Cargo 快取中的實際檔案及 `licenses/materials.json` 登記的預存補件。補件記錄固定版本、來源、revision、上游路徑與 SHA-256，正文僅統一 CRLF 為 LF；預設情況下，缺件、內容變動或目錄校驗失敗會中止產生／核對。僅接受經明確審核、綁定固定版本且附理由與證據的上游缺件或授權分支選擇例外；例外會隨目錄離線呈現並由產生／檢查報告，不代表恢復了缺失的上游正文。首次準備相依快取或補件可能需要另行連網，產生／核對本身不臨時下載。一般前端建置只校驗並複製已產生材料，不依賴 Cargo 或網路；CI 的 `validate` 繼續核對清單。

自有貢獻的應用程式、腳本、工具、測試、基準、溫度範例、工作流程與專案文件／設定採用 GPL-3.0-only，`crates/` 下函式庫、測試、範例及自有文件／設定採用 LGPL-3.0-or-later；具體資源與產生物範圍見 [`COPYRIGHT`](../../COPYRIGHT)。保留上游與其他作者的聲明，不從 Git 作者記錄推定轉讓，不把第三方材料標成 KHWLGH 原創。專案著作權行固定為 `Copyright (C) 2026 KHWLGH`，僅用於其自有貢獻；GNU 授權全文保持原文。

發佈對應 Tag 的 ZIP／tar.gz 是本儲存庫原始碼封存，不含本機相依快取或系統 SDK。從封存建置時，以 `cargo fetch --locked` 取得鎖定的 Cargo 相依原始碼，以 `npm ci` 取得鎖定的 npm 建置工具；`Cargo.lock` 與 `package-lock.json` 確定相應版本及可用的完整性校驗資訊。相依來源可配合 [`src/third-party-components.json`](../../src/third-party-components.json) 元件清單定位。目前工具鏈、平台 SDK／系統相依與建置命令見本指南的環境要求及各平台段落；單獨的 Tag 封存不代表已內含全部相依原始碼。

## 發佈流程

開發期間只維護 `changelog/unreleased/zh-CN.md`。發佈前由開發助手合併重複項目、整理面向使用者的簡體中文說明，再產生 `en.md` 並人工校對。更新記錄僅提供英文與簡體中文，不要求逐句或逐項對應，也不使用翻譯 API。

```bash
npm run release:prepare -- 0.2.6 --date 2026-11-14 --dry-run
npm run release:prepare -- 0.2.6 --date 2026-11-14
npm run release:notes
npm run showcase:capture
```

將範例版本及日期換成實際值。準備命令確認兩份語言檔案存在且正文非空，拒絕覆蓋既有版本目錄，接著歸檔至 `changelog/<version>/`、同步產品版本、更新根目錄入口並產生 `dist/release-notes.md`；全部完成後才清空草稿。`--dry-run` 只顯示計畫與預覽，不寫入檔案。失敗時保留草稿；檢查錯誤及 `git diff`，修正後再試，如已產生部分版本檔案，先人工整理。

Release 預設展開英文，簡體中文放在摺疊區，兩種語言均附安裝說明。預覽與正式發佈共用渲染邏輯。優先使用 `GITHUB_REPOSITORY`，本機未設定時從 `origin` 解析。命令不會提交、建立或推送 Tag，也不會公開 Release；校對預覽並完成品質檢查後，再提交及推送新 Tag。

### 發佈前更新文件截圖

每次發佈準備都必須更新文件截圖，順序為：同步產品版本與歸檔更新記錄 → 產生並檢查截圖 → 執行品質檢查 → 提交全部發佈變更 → 推送版本 Tag → 由 GitHub Actions 建置、驗證並發佈安裝包。正式發佈無需在本機預先建置安裝包。`release:prepare` 只處理版本與文案，截圖使用上方的獨立命令；版本已歸檔時，直接重新執行 `npm run showcase:capture`，無需再次歸檔。

首次使用先執行 `npx playwright install chromium`；Linux 缺少瀏覽器系統依賴時，使用 `npx playwright install --with-deps chromium`。截圖必須完整涵蓋簡體中文、繁體中文、英文、日文 × 淺色、深色 × 監控、PD 分析、協定控制、設定，共 32 張，寫入 `docs/screenshots/<language>/` 並保留完整標題列。使用目前版本、統一的 120 秒模擬資料與既定視口尺寸，不以部分截圖代替整套發佈圖片。

另產生協定偵測主介面的 8 張截圖，以及 16:9 圖片報告、長圖、影片畫面和協定偵測報告的 32 張樣式圖；預設共 72 張（40 張主介面 + 32 張報告樣式），基礎 32 張仍須全部更新。

產生後逐張查看語言、主題、文字截斷、圖表、所選報文、協定狀態與設定目錄，確認沒有空白、遮擋或溢出，版本也與目前清單一致。同步四語 README 的截圖版本、說明及圖片引用，並將完整 72 張圖片與文件一起提交。截圖失敗或檢查未通過時，修正後重新產生，發佈前準備尚未完成。參數與資料說明見[開發展示工具](#開發展示工具)。

### 文件維護範圍

README、使用指南、開發與建置維護英文、簡體中文、繁體中文及日文；架構、效能、協定庫 README 及更新記錄僅維護英文與簡體中文。外部溫度服務統一在本指南維護。主要文件優先連結同語言版本；次要文件在繁體頁面優先連結簡體中文，日文頁面優先連結英文並標示語言。不新增翻譯雜湊、逐項同步檢查或文件專用 CI。

### 更新記錄連結

所有版本正文存放於 `changelog/<version>/`，根目錄 `CHANGELOG.md` 只作為版本索引，保留原版本標題錨點。完整歷史連結至索引，指定版本直接連結對應語言檔案；0.2.2 及以前只有 `zh-CN.md`，不建立英文佔位頁。正文中的相對連結以檔案所在目錄為基準，例如簡體中文使用 `../../docs/USAGE.md`、英文使用 `../../docs/en/USAGE.md`；GitHub Release 渲染時統一固定至該版本 Tag。

### 單獨設定版本

只需同步版本而不歸檔發佈說明時，仍可使用：

```bash
npm run version:set -- 0.2.4
```

將 `0.2.4` 換成目標版本即可。命令接受不含前導零的 `X.Y.Z`，先校驗所有檔案，再同步以下位置；重複設定同一版本不會重複寫入，也不會創建 Git 提交或 tag、更新依賴或修改更新記錄：

| 檔案 | 欄位 |
| --- | --- |
| `package.json` | `version` |
| `package-lock.json` | 頂層與根包 `version` |
| `Cargo.toml` | `[workspace.package] version` |
| `Cargo.lock` | 所有工作區成員包的 `version` |
| `src-tauri/tauri.conf.json` | `version` |

Rust 成員 crate 繼續通過 `version.workspace = true` 繼承版本；關於頁從 Tauri 讀取版本，開發展示工具從 `package.json` 讀取版本。更新後重新建置，才能讓可執行檔案和安裝包使用新版本。

`test/version-sync.test.js` 會檢查清單與鎖檔案一致、語義版本格式、workspace 繼承關係、統一更新命令和 macOS private API 設定。

### 手動建置與首次驗收

將 workflow 提交到預設分支後，在 GitHub 的 **Actions → CI → Run workflow** 選擇要驗證的分支或 Tag。手動觸發會先運行現有質量檢查，再打包四個目標；不會創建或公開 Release，即使選擇的是版本 Tag。

| 目標 | Runner | Rust target | 安裝包 |
| --- | --- | --- | --- |
| Windows x64 | `windows-2022` | `x86_64-pc-windows-msvc` | MSI、NSIS EXE |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | DEB、RPM、AppImage |
| macOS Intel | `macos-26-intel` | `x86_64-apple-darwin` | DMG |
| macOS Apple Silicon | `macos-26` | `aarch64-apple-darwin` | DMG |

每個成功目標提供獨立的 `packages-*` 附件，保留 14 天。四目標全部成功後提供 `release-packages`，包含七個安裝包與 `SHA256SUMS`；在解壓目錄中可用 `sha256sum -c SHA256SUMS` 校驗。安裝包名包含版本與平台架構，NSIS EXE 另帶 `_setup`。

首次啟用 Tag 自動發佈前，先手動建置，檢查 Windows 安裝、兩種 Mac 啟動、Linux 安裝及設定 udev 後的裝置連線。macOS 12 相容性需要單獨實機驗證。CI 驗證 Mac 的架構、ad-hoc 簽章、最低系統版本元資料和 DMG 完整性，不運行 GUI 或連線儀表。

macOS 建置顯式使用 `--bundles app,dmg`：Tauri 在僅建置 DMG 時會清理臨時 `.app`，同時指定 APP 才能保留應用供後續校驗。附件收集仍只包含 DMG，不額外發布 APP。

### 推送版本 Tag 自動發佈

完成上述首次驗收後，更新版本、整理更新記錄、運行質量檢查並提交，再推送與清單一致的 Tag，例如：

```bash
git tag v0.2.4
git push origin v0.2.4
```

Tag 必須為 `vX.Y.Z`，且與清單版本一致；不一致會在打包前失敗。CI 使用 Node.js 24、Rust stable、固定的 Tauri CLI 2.12.1 和 `tauri-apps/tauri-action@v1`。npm 通過 `npm ci` 安裝，Cargo 使用 `--locked`；Rust 快取按目標區分並指向工作區根目錄 `target/`。Linux 固定 Ubuntu 22.04，以減少對較新 glibc 的依賴。

只有全部質量檢查與四目標打包成功，才會彙總七個安裝包並產生校驗和。發佈任務使用運行儲存庫的 `GITHUB_TOKEN` 創建臨時草稿，上傳七個包與校驗檔案，再核對遠端附件數量、大小和 SHA-256，最後自動公開正式 Release。無需人工點選 Publish，也不需要另設 PAT；只有發佈任務獲得 `contents: write`，儲存庫的組織策略需允許這項權限。

`scripts/release.mjs` 從目前版本目錄讀取英文與簡體中文 Markdown，不再解析根目錄歷史長文。Tag 打包前及發佈前共用文案讀取邏輯，只確認兩份檔案存在且正文非空；相對連結固定指向該版本 Tag，不使用 GitHub 自動產生的提交／PR 摘要。`npm run release:notes` 可重新產生本機預覽，不修改來源文件。

同一 ref 的運行串行處理，不取消正在上傳的發佈。上傳或驗證失敗時 Release 保持草稿；在 Actions 重跑失敗任務即可共用該草稿並替換本次發佈的同名附件。草稿若包含其他附件，須人工檢查後再重跑；同名 Release 已公開時，任務拒絕自動覆蓋。若需修改已發佈的二進制，應更新版本並推送新 Tag。

Windows 當前不做憑證簽章；macOS 使用 ad-hoc 簽章，沒有 Developer ID 簽章和公證；Linux 安裝包不會自動設定 udev 權限。本流程不啟用自動更新，不建置 Windows/Linux ARM64 或 Mac Universal 包。

## 質量檢查

按改動範圍選擇一個入口：

| 命令 | 適用情境 |
| --- | --- |
| `npm run check` | 日常前端檢查 |
| `npm run check:rust` | Rust 檢查，自動先產生 `out/` |
| `npm run check:all` | 交付前完整核心檢查，包含前兩組與元件清單核對 |

`check` 依序執行 `npm test`、`typecheck`、`lint`，不建置前端或執行 Cargo；`check:rust` 先建置一次前端，再執行格式檢查、工作區 Clippy 與測試。`check:all` 依序組合兩組檢查與 `components:check`，只建置一次前端，所有入口遇錯即停。單項命令仍可獨立執行；元件清單核對需要 Cargo，缺少相依快取時可能連網。原有 CI 檢查集合維持不變。

`npm test` 使用 Node 內建測試執行器，只尋找 `test/*.test.js`，避免執行輸出目錄中的歷史原始碼副本。新核心測試沿用該位置與命名，定向檢查使用 `node --test test/檔名.test.js`。Biome 跳過輸出、相依與 `.local-*` 本機工具目錄，不必臨時移走檔案。核心測試涵蓋純邏輯、資料處理、協定／檔案契約、安全邊界和版本同步，主要檔案包括：

```text
chart-buckets  chart-columns  chart-extrema  chart-window
csv-codec     csv-import     device-stream  ingest
measurement   pd-capture-file  pd-model      range-stats
recording     recording-spool  security-csp  settings-persistence
version-sync  bench-gate
```

Rust workspace 測試、格式檢查、Clippy 和協定 crate 的 feature 組合檢查繼續保留。涉及 `usbpd-parser` 或 `witrn-hid` 的 feature 門時，按 CI 的組合補跑：

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

- 普通功能增加、刪除、重命名，UI 佈局、樣式、文案和選項清單變化，預設不新增迴歸測試。
- 只有涉及資料丟失或損壞、協定相容、崩潰或死鎖、安全邊界、發佈建置不變量，或已經確認的高影響歷史缺陷時才增加測試。
- 優先補充現有核心測試，不為每個小功能新建測試檔案、設計方案或 CI job。
- 效能 benchmark 和真機檢查按需手動運行，不作為每次改動的瀏覽器自動迴歸。
- CI 保持固定的核心檢查集合，不因單個功能增加專用迴歸流程。

## 無頭測試介面

`tools/showcase/headless.mjs` 為其他 Node 指令碼提供可匯入的無頭介面，重用既有 Playwright、模擬伺服器與裝置橋接。首次執行 `npx playwright install chromium`。不附加測試場景、執行器或 CI 工作；截圖、既有 UI 檢查與瀏覽器基準共用此介面。儲存庫根目錄指令碼範例：

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

- `createHeadlessHarness({ channel, distribution, timeout })`：預設 Chromium、原始碼與 15 秒操作逾時；可指定 `msedge`／`chrome` 或已建置的 `out/`。回傳 `url`、`browser`、`openApp`、`close`。
- `openApp({ language, theme, query, context, beforeLoad })`：隔離儲存、虛擬裝置、時鐘與下載，等待連接控制及圖表就緒。`context` 接受 Playwright 選項；`query` 重用橋接參數；非同步 `beforeLoad(page)` 在導覽前安裝路由、事件與初始化指令碼。
- `connect(path)`、`record()`、`pause()` 透過實際介面操作；`freeze()`／`resume()` 控制虛擬時鐘。預設凍結；`advance(ms)` 推進 0–300000 毫秒並等待消費及實際 ACK，自動時鐘需先凍結。
- `flush()` 只等待消費邊界；`waitForCharts()` 等待主圖顯示工作與兩幀；匯出的 `frames(page)` 只等待字型及兩幀。不保證磁碟持久化、螢幕呈現或所有非同步工作完成。
- `diagnostics()` 回傳 `source`、`stream`、`performance`、未捕獲異常 `errors` 與 `consoleErrors`，不自動啟用完整效能取樣。斷言、截圖、trace 及錯誤處理由呼叫端負責；既有協定故障鉤子可透過 `app.page.evaluate()` 呼叫 `window.__SHOWCASE__`。
- `app.close()` 關閉目前上下文；`harness.close()` 關閉全部上下文、瀏覽器與伺服器，皆可重複呼叫。Node 24 的 `await using` 在正常或異常離開作用域時清理；初始化失敗亦清理已建立資源。錯誤直接拋給呼叫端，不吞掉或當作跳過。

固定無頭啟動，不啟用桌面視窗；模擬裝置不連接真實儀表或讀取原生設定。既有 `verify-*.mjs` 依影響領域手動選擇；圖表專項保留 `bench/chart-transitions.mjs` 與 `bench/chart-raster.mjs`，移除依賴舊內部索引行為且覆蓋重複的歷史矩陣指令碼。核心 `test/` 保留資料、協定與建置不變量；不再維護額外的全流程驗收套件或瀏覽器 CI。平台、原生檔案系統與硬體擷取仍須個別驗證。

## 開發展示工具

長時間錄製的記憶體比較使用 `npm run bench:memory`，預設以 `bench/results/memory-before/` 中修改前的 `state.js`、`csv-codec.js`、`csv-import-core.js` 與 `measurement.js` 快照比較目前原始碼，也可用 `-- --baseline <目錄>` 指定快照。涵蓋 100 萬／500 萬點持續追加、持有匯出快照時追加、串流 CSV 匯入及反覆清空；逐欄 SHA-256 必須一致，欄緩衝至少節省 20%。結果寫入 `bench/results/memory.json`，分開記錄獨立欄緩衝、Node RSS 抽樣峰值及 OS 峰值，不代表整個 Tauri／WebView2 程序樹。

`tools/showcase/` 是獨立的瀏覽器開發工具，提供虛擬 WITRN K2 與 POWER-Z KM003C、確定性的測量曲線、PD 報文和協定控制結果。資料仍經過軟體現有攝入與渲染邏輯；完整標題列使用 decorum 同款控制項結構與軟體自身的圖示、樣式，視窗行為虛擬化。工具不連線真實儀表，不進入 `src/`、`out/` 或安裝包，按需瀏覽器驗收沿用其伺服器。

首次準備：

```bash
npm ci
npx playwright install chromium
```

交互預覽與產生全部展示圖：

```bash
npm run showcase:dev
npm run showcase:capture
```

預覽預設監聽 `http://127.0.0.1:4173`，預設顯示淺色主題；獨立軟體視圖可用 `/app/?theme=dark` 或 `/app/?theme=system` 指定深色或跟隨系統。軟體標題列可選擇虛擬裝置、連線與中斷連線，記錄按鈕可開始和暫停。開發工具外層提供「填充 120 秒展示資料」「凍結」「繼續模擬」「推進 10 秒」「重設預覽」；填充按鈕自動連線當前選擇的裝置與儀表溫度源並開始記錄。協定控制需要選擇 POWER-Z 並連線，然後開啟 PDM。連接埠可用 `npm run showcase:dev -- --port 4174` 指定，服務只監聽本機。

報告影片匯出的原生驗收不會開啟系統儲存對話框：debug 建置在 `video_export_pick` 讀取 `LAPOWER_VIDEO_TARGET`，有值就直接為它簽發 ticket。該分支只在 `debug_assertions` 下編譯，release 建置中的路徑仍只能來自原生對話框；它只服務本機自動化，不進設定、文件介面或 CI。

主介面截圖使用 Chromium、Windows 風格、1280×800 CSS 視口、2 倍像素密度及 100% 介面縮放，產生 2560×1600 PNG。預設使用 POWER-Z、儀表溫度源與相同的 120 秒模擬資料，先凍結虛擬時間，再等待實際圖表、報文詳情、字體與控制項渲染完成。輸出為 `docs/screenshots/<language>/{dark,light}-{record,pd,trigger,detection,settings,report-image,report-long,report-video,protocol-report}.png`，每種語言各 18 張展示圖（共 72 張，其中 32 張為基礎工作區）。

主介面保留完整標題列；報告展示實際輸出，不擷取匯出設定對話框。監控報告由應用程式的 captureReport 投影與共用 scene／tiny-skia 渲染器產生：1920×1080 橫圖及影片影格、1920×1340 長圖，範例含 12 個標記；協定報告透過實際 PNG 匯出產生。產生監控報告前自動建置前端，再執行 cargo run --locked -p lapower --example showcase-reports；需要 Rust 與對應平台建置環境。只產生主介面可用 --page record,pd,trigger,detection,settings，無需 Rust 編譯。

關於頁版本讀取 package.json，截圖命令會驗證版本、語言與頁面溢位。截圖只寫入對應語言子目錄，不再產生根目錄中的重複副本。

可以只截取指定頁面、主題或更改輸出目錄：

```bash
npm run showcase:capture -- --theme light --page pd,trigger --output output/showcase
npm run showcase:capture -- --help
```

`--language` 支援 zh-CN、zh-TW、en、ja（逗號分隔，預設全部）；`--theme` 支援 `light,dark`，預設按淺色、深色順序產生；`--page` 支援 `record,pd,trigger,detection,settings,report-image,report-long,report-video,protocol-report`。輸出目錄相對於儲存庫根目錄，也可使用絕對路徑。修改 `tools/showcase/scenario.js` 可以調整虛擬裝置資訊、隨機種子、充電曲線、握手時刻及 PDO / 協定偵測結果。`bridge.js` 實現 Tauri 命令、事件、錄製段、ACK、記憶體設定與檔案句柄；未實現的調用會明確報錯。CSV / PD 匯出通過瀏覽器下載，CSV 匯入通過瀏覽器檔案選擇器；PD 匯入僅支援包含已固化樣例原始報文的檔案，任意真機報文解碼仍應使用原生軟體。

`pd-fixtures.json` 儲存由現有 `witrn-hid` Rust 解析器產生的原始報文與解碼樹，普通瀏覽器預覽和主介面截圖無需 Rust 編譯，報告樣式產生需要 Rust。更改 PD 原始樣例後，可在安裝 Rust 的環境中運行 `node tools/showcase/generate-pd.mjs` 重新產生；臨時產生器寫入忽略的 `output/`，編譯產物寫入 `target/`。

瀏覽器上下文使用記憶體設定與檔案，不讀寫真實應用的資料目錄。軟體使用新的標識 `io.github.khwlgh.lapower`，啟動測量工具也已同步該標識；舊 WITRN-RS 設定不會自動遷移。

## 效能測量

`bench/` 保留算法、存儲、啟動、極值和發貨形狀檢查；瀏覽器 harness、瀏覽器長跑和硬體驗收已移除。

| 命令 | 用途 |
| --- | --- |
| `node bench/core.mjs` | 列存儲、分桶、統計和能量積分基準 |
| `node bench/core.mjs --compare` | 與算法基線比較，結果需結合多輪和主機狀態判斷 |
| `node bench/core.mjs --verify-baseline` | 單次正確性檢查及基線結構校驗，不預熱、不計時 |
| `node bench/phase2.mjs` | 範圍統計和協作切片的前後版本對照 |
| `node bench/phase3.mjs` | 分塊存儲、統計和能量計算的前後版本對照 |
| `node bench/extrema.mjs` | 掃描與極值索引的算法對照 |
| `node bench/startup.mjs` | 原生二進制冷啟動分段，按需手動運行 |
| `node bench/packaging.mjs` | 檢查 `out/` 的發貨檔案和內嵌集合 |
| `cargo bench -p lapower` | Rust 協定解碼、編碼和選擇路徑基準 |

發貨形狀與基準結構檢查合併至 `validate`，重用前端建置；算法與 Rust 耗時基準按需在本機執行，不在每次 CI 重複建置與計時。

## CI 門禁

`.github/workflows/ci.yml` 在每次 push 和 PR 運行固定的核心檢查：

| Job | 內容 |
| --- | --- |
| `validate` | Linux 依賴、前端建置、JS 測試、typecheck、lint、Rust fmt、Clippy、workspace test、發貨形狀與基準結構 |
| `backend-other-platforms` | Windows workspace test；macOS workspace test |
| `crate-features` | 協定 crate 的非預設 feature 組合 Clippy 與 test |
| `package` | 僅版本 Tag push / 手動觸發；依賴以上三項檢查，四目標並行打包，單個平台失敗不會取消其他目標 |
| `package-summary` | 四目標全部成功後驗證七個安裝包並產生 `SHA256SUMS` |
| `release` | 僅版本 Tag push；上傳並核對附件後自動公開 Release |

普通分支 push／PR 只執行核心檢查，不打包或發佈；CI 不安裝瀏覽器、不執行 UI 矩陣、長時間擷取或耗時 benchmark。按需透過無頭介面呼叫既有工具；原有 **CI** 手動入口仍會打包。發佈指令碼的失敗、重跑、附件完整性與公開版本保護由 `test/release.test.js` 離線驗證。

## Linux 自行編譯

Linux 建置與運行未持續接入真實裝置驗證。Debian / Ubuntu 依賴：

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl file pkg-config libssl-dev libudev-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev patchelf
npm ci
npm run build
npx --no-install tauri build
```

需要訪問 WITRN HID 時，按發行版設定 `/dev/hidraw*` 的 udev 規則。

### udev 規則（必需）

Debian / Ubuntu 上可創建 `/etc/udev/rules.d/99-lapower.rules`，僅授予當前桌面使用者訪問 WITRN HID 和 POWER-Z USB 介面的權限：

```udev
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0716", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0063", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0061", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="5fc9", TAG+="uaccess"
```

隨後執行 `sudo udevadm control --reload-rules`，重新插拔裝置，再啟動軟體。`uaccess` 依賴 systemd-logind 的活動本地工作階段；其他發行版或無桌面工作階段環境應使用發行版的裝置訪問組規則。POWER-Z 協定控制還需要訪問其 CDC 序列埠。

## macOS 自行編譯

需要 Xcode Command Line Tools、Rust 穩定版和 npm 鎖定的 Tauri CLI：

```bash
npm ci
npm run build
npx --no-install tauri build
```

macOS private API 的 Cargo feature 與 Tauri 設定必須保持一致。平台設定使用 `signingIdentity: "-"` 和 `minimumSystemVersion: "12.0"`；CI 同時設定 `MACOSX_DEPLOYMENT_TARGET=12.0`，保留舊系統部署目標，並通過 `CI=true`、`TAURI_BUNDLER_DMG_IGNORE_CI=false` 跳過 Finder 美化。當前沒有 Developer ID 簽章或 Apple 公證；首次開啟方式見 [README 下載與安裝](../../README.zh-TW.md#-下載與安裝)。

普通 macOS CI 做 workspace test；版本 Tag / 手動建置還會產生並驗證 DMG，不運行 GUI 或真機檢查。

CI 的原生建置檢查不代表已完成 GUI 或硬體驗收。首次發佈仍須在 Intel／Apple Silicon Mac 檢查啟動、視窗與設定、檔案對話框、錄製及真實儀表連線；macOS 12 相容性另行驗證。舊版 WITRN-RS 的一次性建置報告保留於 Git 歷史，不作為目前 laPower 操作步驟。

## 外部溫度服務

laPower 的溫度可以有兩個來源：**儀表自帶的溫度**，或**通過 TCP 連線的外部溫度感測器**。WITRN 從 HID 報告讀取溫度，POWER-Z 從 ADC 快照補齊。外部來源適合把外置熱電偶、紅外測溫模組或其它測溫裝置的資料接進來，與電壓電流一起記錄、繪圖並匯出。

### 選擇溫度來源

在「監控」Tab 的命令欄點選 `溫度服務` 右側的向下箭頭，開啟設定浮出面板：

| 欄位 | 說明 | 預設 |
| --- | --- | --- |
| `來源` | `儀表` = 儀表溫度；`外部` = TCP 溫度服務 | `外部` |
| `IP` | 溫度伺服器地址（僅 `外部` 時可用） | `127.0.0.1` |
| `連接埠` | 溫度伺服器連接埠（僅 `外部` 時可用） | `1573` |

連線與中斷連線走命令欄上的 `溫度服務` 開關按鈕，不在浮出面板裡。**連線期間來源不可切換** —— 先中斷連線再改。

選 `儀表` 時不需要任何外部程式，直接使用儀表報文裡的溫度欄位。注意該欄位只在部分型號上驗證過；數值不可信時解析器會當作「無溫度」處理，介面顯示 `--`。

`儀表` 溫度源的生命週期跟著儀表走：中斷連線或拔出儀表時一併解除，讀數回 `--`、`溫度服務` 按鈕復位、`來源` 重新可選 —— 後端只為 TCP 源發 `temp-disconnected`，儀表源沒有可關閉的工作階段，所以這一步在前端連線狀態變化裡做。已記錄的溫度曲線與 `有溫度資料` 標記不受影響，只有即時讀數會被清掉。`外部` 的 TCP 工作階段與 HID 流相互獨立，拔出儀表不會中斷 TCP 連線。

溫度接入後即可在讀數卡上看到當前值與 `平均` / `最低` / `最高`，在圖表裡作為第四條 Y 軸曲線，並可通過 `匯出 CSV` 右側箭頭 → `包含溫度` 寫進 CSV 的 `Temp(°C)` 列。

### 協定

刻意做得極簡，任何語言幾行就能實現服務端。

- **傳輸**：TCP，服務端監聽，laPower 作為客戶端連入。
- **格式**：每行一個純十進位數值，以 `\n` 結束。單位為攝氏度。
- **無握手、無心跳、無訊框頭。**

```
25.125\n
25.250\n
24.875\n
```

#### 行為細節

- **連線超時 5 秒。** 地址會做完整解析，IPv4 優先於 IPv6 依次嘗試。
- **發送間隔不限。** 讀取側使用 250 ms 的讀超時循環，超時只是繼續等待而不中斷連線，因此**發送間隔超過 10 秒也沒問題**，連線會在空閒期間保持。
- **半行會被正確續接。** 讀超時可能帶著半行資料返回，實現上只在整行處理完成後才清空緩衝區，所以資料被 TCP 分片切開不會產生壞值。
- **單行超過 256 位元組視為壞資料**並丟棄該行，防止沒有換行符的資料流把緩衝區撐爆。
- **服務端關閉連線**（讀到 EOF）時，應用會收到中斷連線通知並更新介面狀態。

### 示例伺服器

儲存庫裡帶了一對 Python 示例，不需要任何第三方庫：

| 檔案 | 用途 |
| --- | --- |
| [`temperature-example/network_server.py`](../../temperature-example/network_server.py) | 溫度伺服器示例，每秒發送一個 0–100 之間的隨機值 |
| [`temperature-example/network_client.py`](../../temperature-example/network_client.py) | 客戶端示例，用於單獨驗證伺服器 |

啟動伺服器（主控台輸出為簡體中文）：

```bash
python temperature-example/network_server.py
```

```
温度服务器启动，监听 127.0.0.1:1573
等待客户端连接...
```

然後在應用裡把 `來源` 設為 `外部`、地址保持預設的 `127.0.0.1:1573`，點選命令欄的 `溫度服務` 連線即可。

#### 自己實現服務端

參照示例改成讀取真實感測器即可，核心只有這幾行：

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

如果伺服器不在本機，記得把綁定地址改為 `0.0.0.0`，並在應用裡填寫伺服器的實際 IP。

### 故障排查

**連線超時** —— 檢查 IP 與連接埠；伺服器若在另一臺機器上，確認它綁定的是 `0.0.0.0` 而不是 `127.0.0.1`，以及防火牆是否放行該連接埠。

**連上了但溫度一直是 `--`** —— 確認伺服器發送的是純數字加換行。帶單位（`25.1°C`）、帶 JSON 包裝、或不用換行分隔數值都會被判為無效行。LF 和 CRLF 換行均可使用。

**數值跳變或出現明顯錯誤的值** —— 檢查是否有多個數值擠在一行裡沒有換行符。單行超過 256 位元組會被整行丟棄。

**切不動 `來源` 選項** —— 溫度服務處於連線狀態時來源被鎖定，先點 `溫度服務` 中斷連線。

## 參與貢獻

1. Fork 儲存庫並創建分支。
2. 完成改動後運行上面的核心質量檢查。
3. 保持前端模組的 `// @ts-check`，純邏輯優先抽成可直接測試的模組。
4. 新增裝置型號或韌體前，用實機樣本確認 HID 位元組結構與量程。

測試新增遵循“測試與迴歸邊界”規則；不要為普通 UI 或功能表面變化新增獨立測試、設計文件或 CI job。
