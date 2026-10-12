[English](../en/DEVELOPMENT.md) | [简体中文](../DEVELOPMENT.md) | **繁體中文** | [日本語](../ja/DEVELOPMENT.md)

← 返回 [README](../../README.zh-TW.md)

# 開發與建置

- [環境要求](#環境要求)
- [建置與運行](#建置與運行)
- [發佈流程](#發佈流程)
- [質量檢查](#質量檢查)
- [測試與迴歸邊界](#測試與迴歸邊界)
- [開發展示工具](#開發展示工具)
- [效能測量](#效能測量)
- [CI 門禁](#ci-門禁)
- [Linux 自行編譯](#linux-自行編譯)
- [macOS 自行編譯](#macos-自行編譯)
- [外部溫度服務](#外部溫度服務)
- [參與貢獻](#參與貢獻)

## 語言選擇

在「設定 → 外觀 → 語言」可選擇跟隨系統、简体中文、繁體中文、English、日本語。切換立即生效並儲存偏好，保留連線、記錄、資料、圖表範圍、篩選和選中報文；重設設定回到自動模式。

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
npm run build
npx --no-install tauri dev
npx --no-install tauri build
```

本機未指定 target 時，發佈產物位於 `target/release/bundle/`；CI 顯式指定 target，產物位於 `target/<target>/release/bundle/`。Tauri CLI 會自動運行 `beforeBuildCommand` 產生壓縮前端，打包前無需再手動執行 `npm run build:dist`。直接運行 Cargo 檢查時仍須先產生 `out/`。

## 發佈流程

開發期間只維護 `changelog/unreleased/zh-CN.md`。發佈前由開發助手合併重複項目、整理面向使用者的簡體中文說明，再產生 `en.md` 並人工校對。更新記錄僅提供英文與簡體中文，不要求逐句或逐項對應，也不使用翻譯 API。

```bash
npm run release:prepare -- 0.2.4 --date 2026-10-12 --dry-run
npm run release:prepare -- 0.2.4 --date 2026-10-12
npm run release:notes
```

將範例版本及日期換成實際值。準備命令確認兩份語言檔案存在且正文非空，拒絕覆蓋既有版本目錄，接著歸檔至 `changelog/<version>/`、同步產品版本、更新根目錄入口並產生 `dist/release-notes.md`；全部完成後才清空草稿。`--dry-run` 只顯示計畫與預覽，不寫入檔案。失敗時保留草稿；檢查錯誤及 `git diff`，修正後再試，如已產生部分版本檔案，先人工整理。

Release 預設展開英文，簡體中文放在摺疊區，兩種語言均附安裝說明。預覽與正式發佈共用渲染邏輯。優先使用 `GITHUB_REPOSITORY`，本機未設定時從 `origin` 解析。命令不會提交、建立或推送 Tag，也不會公開 Release；校對預覽並完成品質檢查後，再提交及推送新 Tag。

### 文件維護範圍

README、使用指南、開發與建置維護英文、簡體中文、繁體中文及日文；架構、效能、協定庫 README 及更新記錄僅維護英文與簡體中文。外部溫度服務統一在本指南維護。主要文件優先連結同語言版本；次要文件在繁體頁面優先連結簡體中文，日文頁面優先連結英文並標示語言。不新增翻譯雜湊、逐項同步檢查或文件專用 CI。

### 單獨設定版本

只需同步版本而不歸檔發佈說明時，仍可使用：

```bash
npm run version:set -- 0.2.3
```

將 `0.2.3` 換成目標版本即可。命令接受不含前導零的 `X.Y.Z`，先校驗所有檔案，再同步以下位置；重複設定同一版本不會重複寫入，也不會創建 Git 提交或 tag、更新依賴或修改更新記錄：

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

```bash
npm ci
npm run build
npm test
npm run typecheck
npm run lint
cargo fmt --check --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`npm test` 使用 Node 內置測試運行器，覆蓋純邏輯、資料處理、協定/檔案契約、安全邊界和版本同步。測試檔案按核心領域組織，當前保留的主要檔案包括：

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

## 開發展示工具

長時間錄製的記憶體比較使用 `npm run bench:memory`，預設以 `bench/results/memory-before/` 中修改前的 `state.js`、`csv-codec.js`、`csv-import-core.js` 與 `measurement.js` 快照比較目前原始碼，也可用 `-- --baseline <目錄>` 指定快照。涵蓋 100 萬／500 萬點持續追加、持有匯出快照時追加、串流 CSV 匯入及反覆清空；逐欄 SHA-256 必須一致，欄緩衝至少節省 20%。結果寫入 `bench/results/memory.json`，分開記錄獨立欄緩衝、Node RSS 抽樣峰值及 OS 峰值，不代表整個 Tauri／WebView2 程序樹。

`tools/showcase/` 是獨立的瀏覽器開發工具，提供虛擬 WITRN K2 與 POWER-Z KM003C、確定性的測量曲線、PD 報文和協定控制結果。資料仍經過軟體現有攝入與渲染邏輯；完整標題列使用 decorum 同款控制項結構與軟體自身的圖示、樣式，視窗行為虛擬化。工具不連線真實儀表，不進入 `src/`、`out/` 或安裝包，也不加入瀏覽器 CI。

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

截圖命令使用 Chromium、Windows 風格、1280×800 CSS 視口、2 倍像素密度及 100% 介面縮放，產生 2560×1600 PNG。預設使用 POWER-Z、儀表溫度源與相同的 120 秒模擬資料，先凍結虛擬時間，再等待實際圖表、報文詳情、字體與控制項渲染完成。輸出為 `docs/screenshots/<language>/{dark,light}-{record,pd,trigger,settings}.png`，每種語言各 8 張展示圖（共 32 張）。

關於頁版本讀取 package.json，截圖命令會驗證版本、語言與頁面溢位。截圖只寫入對應語言子目錄，不再產生根目錄中的重複副本。

可以只截取指定頁面、主題或更改輸出目錄：

```bash
npm run showcase:capture -- --theme light --page pd,trigger --output output/showcase
npm run showcase:capture -- --help
```

`--language` 支援 zh-CN、zh-TW、en、ja（逗號分隔，預設全部）；`--theme` 支援 `light,dark`，預設按淺色、深色順序產生；`--page` 支援 `record,pd,trigger,settings`。輸出目錄相對於儲存庫根目錄，也可使用絕對路徑。修改 `tools/showcase/scenario.js` 可以調整虛擬裝置資訊、隨機種子、充電曲線、握手時刻及 PDO / 協定偵測結果。`bridge.js` 實現 Tauri 命令、事件、錄製段、ACK、記憶體設定與檔案句柄；未實現的調用會明確報錯。CSV / PD 匯出通過瀏覽器下載，CSV 匯入通過瀏覽器檔案選擇器；PD 匯入僅支援包含已固化樣例原始報文的檔案，任意真機報文解碼仍應使用原生軟體。

`pd-fixtures.json` 儲存由現有 `witrn-hid` Rust 解析器產生的原始報文與解碼樹，普通預覽和截圖無需 Rust 編譯。更改 PD 原始樣例後，可在安裝 Rust 的環境中運行 `node tools/showcase/generate-pd.mjs` 重新產生；臨時產生器寫入忽略的 `output/`，編譯產物寫入 `target/`。

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

`perf-shape` CI job 只硬性檢查發貨形狀和基線結構；算法和 Rust benchmark 只報告結果，不把單次耗時當作跨主機門禁。

## CI 門禁

`.github/workflows/ci.yml` 在每次 push 和 PR 運行固定的核心檢查：

| Job | 內容 |
| --- | --- |
| `validate` | Linux 依賴、前端建置、JS 測試、typecheck、lint、Rust fmt、Clippy、workspace test |
| `backend-other-platforms` | Windows workspace test；macOS workspace test |
| `crate-features` | 協定 crate 的非預設 feature 組合 Clippy 與 test |
| `perf-shape` | `bench/packaging.mjs`、`core.mjs --verify-baseline`，以及報告型 benchmark |
| `package` | 僅版本 Tag push / 手動觸發；依賴以上四項檢查，四目標並行打包，單個平台失敗不會取消其他目標 |
| `package-summary` | 四目標全部成功後驗證七個安裝包並產生 `SHA256SUMS` |
| `release` | 僅版本 Tag push；上傳並核對附件後自動公開 Release |

普通分支 push 和 PR 只運行原有檢查，不打包或發佈。CI 不運行瀏覽器驗收、硬體長跑或功能表面迴歸。開發展示工具僅用於按需預覽和產生文件圖片，不承擔瀏覽器驗收或 CI 門禁；新增功能不應順手增加專用 workflow、job 或迴歸 harness。發佈指令碼的失敗、重跑、附件完整性和公開版本保護由 `test/release.test.js` 離線驗證。

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

在「監控」Tab 的命令欄點選 `溫度服務` 旁的齒輪，開啟設定浮出面板：

| 欄位 | 說明 | 預設 |
| --- | --- | --- |
| `來源` | `儀表` = 儀表溫度；`外部` = TCP 溫度服務 | `外部` |
| `IP` | 溫度伺服器地址（僅 `外部` 時可用） | `127.0.0.1` |
| `連接埠` | 溫度伺服器連接埠（僅 `外部` 時可用） | `1573` |

連線與中斷連線走命令欄上的 `溫度服務` 開關按鈕，不在浮出面板裡。**連線期間來源不可切換** —— 先中斷連線再改。

選 `儀表` 時不需要任何外部程式，直接使用儀表報文裡的溫度欄位。注意該欄位只在部分型號上驗證過；數值不可信時解析器會當作「無溫度」處理，介面顯示 `--`。

`儀表` 溫度源的生命週期跟著儀表走：中斷連線或拔出儀表時一併解除，讀數回 `--`、`溫度服務` 按鈕復位、`來源` 重新可選 —— 後端只為 TCP 源發 `temp-disconnected`，儀表源沒有可關閉的工作階段，所以這一步在前端連線狀態變化裡做。已記錄的溫度曲線與 `有溫度資料` 標記不受影響，只有即時讀數會被清掉。`外部` 的 TCP 工作階段與 HID 流相互獨立，拔出儀表不會中斷 TCP 連線。

溫度接入後即可在讀數卡上看到當前值與 `平均` / `最低` / `最高`，在圖表裡作為第四條 Y 軸曲線，並可通過 `匯出 CSV` → `含溫度` 寫進 CSV 的 `Temp(°C)` 列。

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
