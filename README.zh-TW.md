[English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文** | [日本語](README.ja.md)

<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="120" alt="laPower" />

# laPower

**維簡 (WITRN) / POWER-Z USB 電壓電流表的桌面上位機 —— 即時監控 · USB-PD 協定分析 · 資料記錄**

[![Release](https://img.shields.io/github/v/release/KHWLGH/laPower?style=flat-square&label=release&color=blue)](https://github.com/KHWLGH/laPower/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/KHWLGH/laPower/ci.yml?style=flat-square&label=CI)](https://github.com/KHWLGH/laPower/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue?style=flat-square)](LICENSE)
[![Stars](https://img.shields.io/github/stars/KHWLGH/laPower?style=flat-square)](https://github.com/KHWLGH/laPower/stargazers)
[![Downloads](https://img.shields.io/github/downloads/KHWLGH/laPower/total?style=flat-square)](https://github.com/KHWLGH/laPower/releases)
[![Last commit](https://img.shields.io/github/last-commit/KHWLGH/laPower?style=flat-square)](https://github.com/KHWLGH/laPower/commits/main)

[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-1.85%2B-CE422B?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES%20Modules-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](https://developer.mozilla.org/docs/Web/JavaScript)
[![uPlot](https://img.shields.io/badge/charts-uPlot-6E7B8B?style=flat-square)](https://github.com/leeoniya/uPlot)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4?style=flat-square)](#-下載與安裝)

</div>

## 📖 專案簡介

laPower 是一款支援維簡 (WITRN) USB 電壓電流表與 POWER-Z KM003C/KM002C 的桌面上位機。應用程式透過 USB HID 或廠商 Bulk 介面讀取測量訊框，並在本機離線完成即時顯示、長時記錄與 USB-PD 逐欄位解碼；僅手動檢查更新會連線 GitHub，外部溫度來源則透過 TCP 連線至設定的伺服器。

技術上基於 **Tauri v2**：後端採用 **Rust** 負責裝置通信、USB-PD 解析與背景執行緒生命週期管理；前端使用**原生 JavaScript ES Modules** 與 uPlot 圖表，發佈時由 esbuild 打包合併。所有執行階段前端相依套件皆已內建於儲存庫，不從外部 CDN 載入資源。

除常規的電壓、電流、功率與溫度外，laPower 還會記錄 **D+ / D− / CC1 / CC2 四條訊號線電壓**，並將擷取到的 **USB-PD 報文逐欄位展開**：可直觀檢視充電器廣播的 PDO、裝置請求的 PPS 電壓以及協商完成的毫秒時刻。

> **平台說明：** 版本 Tag 會觸發 GitHub Actions 自動打包 Windows x64、Linux x64、macOS Intel / Apple Silicon 並發佈 Release（實際產物以各版本附件為準）。開發與主要驗證基於 Windows；macOS / Linux 的 GUI、裝置連線與 macOS 12 相容性仍需實機驗收。詳見 [開發與建置](docs/zh-TW/DEVELOPMENT.md#發佈流程)。

> **提示：** 本軟體大部分藉助 Claude Code、Grok Build、Codex 等 AI 程式設計工具完成，可能仍存在未知問題，歡迎透過 [Issues](https://github.com/KHWLGH/laPower/issues) 回報。

## 📸 介面預覽

以下截圖基於 Windows 平台 **0.3.0** 版本，使用虛擬裝置與模擬資料產生（保留完整標題列，軟體預設跟隨系統主題）。重新產生整套截圖見 [開發展示工具](docs/zh-TW/DEVELOPMENT.md#開發展示工具)。

| 淺色主題 | 深色主題 |
| :---: | :---: |
| <img src="docs/screenshots/zh-TW/light-record.png" alt="監控工作區（淺色）：即時讀數卡片、8 通道圖表、時間線導航器" /><br><sub>**監控** · 即時讀數卡 / 8 通道 4 軸圖表 / 時間線導航器</sub> | <img src="docs/screenshots/zh-TW/dark-record.png" alt="監控工作區（深色）" /><br><sub>**監控** · 深色主題</sub> |
| <img src="docs/screenshots/zh-TW/light-pd.png" alt="PD 分析工作區（淺色）：報文清單與逐欄位解碼樹" /><br><sub>**PD 分析** · 報文清單 / PDO 速覽 / 逐欄位解碼</sub> | <img src="docs/screenshots/zh-TW/dark-pd.png" alt="PD 分析工作區（深色）" /><br><sub>**PD 分析** · 深色主題</sub> |
| <img src="docs/screenshots/zh-TW/light-trigger.png" alt="協定控制工作區（淺色）：PDM、PDO 清單與偵測記錄" /><br><sub>**協定控制** · PDM / PDO / 協定偵測與電壓觸發</sub> | <img src="docs/screenshots/zh-TW/dark-trigger.png" alt="協定控制工作區（深色）" /><br><sub>**協定控制** · 深色主題</sub> |
| <img src="docs/screenshots/zh-TW/light-settings.png" alt="設定頁（淺色）：固定目錄、主題、自訂背景圖片與語言、圖表與記錄" /><br><sub>**設定** · 主題 / 持久化自訂背景 / 語言 / 圖表與記錄</sub> | <img src="docs/screenshots/zh-TW/dark-settings.png" alt="設定頁（深色）" /><br><sub>**設定** · 深色主題</sub> |
| <img src="docs/screenshots/zh-TW/light-detection.png" alt="協定偵測（淺色主題）" /><br><sub>**協定偵測** · 逐協定狀態 / 電壓檔位 / 獨立依據</sub> | <img src="docs/screenshots/zh-TW/dark-detection.png" alt="協定偵測（深色主題）" /><br><sub>**協定偵測** · 深色主題</sub> |

### 報告樣式

以下展示同一 120 秒模擬記錄實際渲染的匯出報告效果；16:9 橫圖與影片保留前 8 個標記，長圖保留全部 12 個標記（影片取中間影格）。

| 淺色主題 | 深色主題 |
| :---: | :---: |
| <img src="docs/screenshots/zh-TW/light-report-image.png" alt="圖片報告（16:9） (淺色主題)" /><br><sub>**圖片報告（16:9）** · 無損 PNG / 完整曲線 / 統計與標記</sub> | <img src="docs/screenshots/zh-TW/dark-report-image.png" alt="圖片報告（16:9） (深色主題)" /><br><sub>**圖片報告（16:9）** · 深色主題</sub> |
| <img src="docs/screenshots/zh-TW/light-report-long.png" alt="圖片報告（長圖） (淺色主題)" /><br><sub>**圖片報告（長圖）** · 全部 12 個標記 / 時間與逐項讀數</sub> | <img src="docs/screenshots/zh-TW/dark-report-long.png" alt="圖片報告（長圖） (深色主題)" /><br><sub>**圖片報告（長圖）** · 深色主題</sub> |
| <img src="docs/screenshots/zh-TW/light-report-video.png" alt="影片報告畫面 (淺色主題)" /><br><sub>**影片報告畫面** · 影片中間影格 / 動態讀數 / 播放游標</sub> | <img src="docs/screenshots/zh-TW/dark-report-video.png" alt="影片報告畫面 (深色主題)" /><br><sub>**影片報告畫面** · 深色主題</sub> |
| <img src="docs/screenshots/zh-TW/light-protocol-report.png" alt="協定偵測報告 (淺色主題)" /><br><sub>**協定偵測報告** · 協定狀態與電壓 / PD 版本 / 完整 PDO</sub> | <img src="docs/screenshots/zh-TW/dark-protocol-report.png" alt="協定偵測報告 (深色主題)" /><br><sub>**協定偵測報告** · 深色主題</sub> |

## ✨ 功能特性

### 即時監控

- 電壓、電流、功率與溫度讀數卡皆附帶最小值、最大值與平均值。
- **累計能量 (Wh) 與累計容量 (mAh)** 由軟體對取樣點積分得出，並自動過濾休眠或系統時間跳變（超過 8 倍取樣間隔且至少 2 秒）造成的異常時間增量。
- **訊號線電壓** D+ / D− / CC1 / CC2 可疊加繪圖並隨 CSV 匯出（解析度取決於儀表，WITRN 的 CC1 / CC2 為 0.1 V）。
- 可選**記錄電流方向**，開啟後保留正負符號（正向為正、反向為負，K2 原生支援 ±10 A），側欄同步顯示方向箭頭。
- **自動暫停**：電壓、電流或功率持續低於閾值達設定秒數後自動暫停，適合無人值守的充放電測試。
- **POWER-Z 高速取樣**：KM003C / KM002C 支援認證後的 AdcQueue 1000 次/秒取樣；認證失敗自動回退至 100 次/秒。
- **崩潰復原與容量上限**：記錄每秒寫入應用快取暫存檔（正常退出自動清理），單次記錄預設上限 512 MB 並在達限時自動暫停；長期保存請明確匯出 CSV。

### USB-PD 協定分析

- 解碼 SOP / SOP′ 控制報文、資料報文、擴充報文及 Hard Reset / Cable Reset。
- 報文清單提供角色方向徽章（`SRC → SNK`、`SRC|SNK → Plug`）與 **PDO / RDO 速覽**，例如 `Fixed: 5.0V 9.0V 12.0V 15.0V 20.0V SPR AVS: 9-15V@3.0A PPS: 5.0-21.0V` 或 `Position:7 PPS:8.0V,3.45A`。
- 詳情面板**逐字展開訊框結構**：原始 Data Object 十六進位 → 報文頭欄位 → 各 PDO 完整位域表。
- 支援依訊息類型篩選並一鍵隱藏 GoodCRC 鏈路確認訊框（通常佔總報文半數以上）。
- **跟隨記錄**模式讓 PD 擷取與主監控連動啟停及清空；搭配虛擬清單在數十萬筆規模下仍可流暢捲動。

### 高效能圖表

- 基於 uPlot 與 Canvas 2D / `OffscreenCanvas` 增量像素桶渲染管線，支援 **8 條曲線與 4 條嚴格共線量化 Y 軸**（電流 A、電壓 V、功率 W、溫度 °C）及兩級密集子網格。
- 密集波形自動切換增量 min/max 像素桶與局部髒矩形重繪，**百萬點仍可流暢拖動**；完整資料保留於分塊列式存儲中，回看保留畫布像素級細節，放大還原原始點，懸停透過二分搜尋讀取真實樣本。
- 主圖與底部時間線導航器皆支援滾輪橫向縮放、拖動平移及錄製中的即時跟隨；1000 次/秒取樣時自動繪圖保持約 10–20 fps，縮放與互動獨立更新並複用歷史極值索引（詳見 [效能說明](docs/PERFORMANCE.md#测量与硬件边界)（簡體中文））。
- 懸停 tooltip 顯示目前啟用的有效通道，可在 `顯示` 面板獨立調整各通道顯隱、曲線陰影（預設開啟且狀態持久化）、填充不透明度（0–100%）、線條顏色、線寬與上下錯開（僅改變顯示投影）。

### 資料記錄與互通

- **圖片與影片報告**：將整段記錄匯出為 16:9 / 長圖無損 PNG 或 MP4/MOV 短影片（可選解析度、主題、曲線與標記），無需安裝 ffmpeg。
- **POWER-Z 協定偵測與報告**：檢視各協定支援狀態、電壓檔位與原始依據，獨立讀取 PD PDO 與版本，可匯出 1080p–4K PNG 報告或一鍵填入觸發表單。
- **CSV 匯出與匯入**：支援分別勾選溫度、裝置資訊與標記，支援同時匯出 CSV 與 PD JSON；匯入依表頭名稱匹配並相容舊檔。
- **打點標註**：按 `M` 或點擊 `打點` 標記目前時刻（懸停圖表時標記游標對應點），標籤隨 CSV 的 `Marker` 欄保存與還原。
- **取樣率與 PD 擷取**：支援 0.1–100 次/秒（POWER-Z 額外支援 1000 次/秒，後端依裝置限制接收 1–60000 ms）；PD 擷取採用帶版本號的 JSON 格式並相容舊版匯入。

### 介面

- 多 Tab 工作區（監控 / PD 分析 / 協定控制 / 設定），裝置連線欄常駐標題列便於隨時連線／中斷；協定控制入口常駐，連接支援的 POWER-Z 後啟用操作。
- 支援**跟隨系統 / 淺色 / 深色**主題，採用對齊 Fluent UI 的毛玻璃表面與過渡動效，並可選持久化**自訂本機背景圖片**（PNG / JPEG / WebP，不內建桌布）及透明度調整。
- 支援**简体中文、繁體中文、English、日本語**四語即時切換（不中斷連線、記錄與圖表狀態），預設自動偵測系統語言（規則見 [語言選擇](docs/zh-TW/DEVELOPMENT.md#語言選擇)）。
- 支援 **50–200% 介面縮放**；macOS 採用原生視窗按鈕，Windows 保留 Win11 貼齊版面配置支援，Windows / Linux 使用右側視窗控制按鈕。

## 📱 支援的裝置

| 型號 | VID | PID |
| --- | --- | --- |
| WITRN K2 | `0x0716` | `0x5060` |
| WITRN U3 | `0x0716` | `0x5063`、`0x5044` |
| WITRN C5 | `0x0716` | `0x5053`、`0x5064` |
| POWER-Z KM003C | `0x5FC9` | `0x0063` |
| POWER-Z KM002C | `0x5FC9` | `0x0061` |

維簡裝置依 VID `0x0716` 列舉，未列出的型號或韌體變體也會出現在清單中（標註為「未知 WITRN 裝置 (0716:XXXX)」），報告格式相容即可讀取；POWER-Z 透過 `0x5FC9` Vendor Bulk 介面列舉。同一裝置存在多個 HID 介面時優先選用廠商自訂 Usage Page，裝置名稱自動附帶 USB 拓撲連接埠（如 `WITRN K2 (USB 4-4)`）。

## 📦 下載與安裝

本專案原名 WITRN-RS；laPower 使用獨立應用識別碼 `io.github.khwlgh.lapower` 與設定／快取目錄，不自動遷移舊版設定，既有 CSV 與 PD 擷取檔案仍可直接匯入。

- **Windows 10 / 11 (x64)**：至 [Releases](https://github.com/KHWLGH/laPower/releases/latest) 下載 `.msi`、`.exe`（NSIS）安裝包或免安裝便攜版 `*_windows-x64_portable.zip`（需系統已具備 Microsoft Edge WebView2 Runtime，解壓執行 `laPower.exe`）。通常無需額外安裝驅動；未簽章安裝包首次執行可能觸發 SmartScreen 提示。
- **macOS 12+**：Intel Mac 下載 `macos-x64` `.dmg`，Apple Silicon（M1 及以後）下載 `macos-arm64` `.dmg`，將 `laPower.app` 拖入 Applications。建置採用 ad-hoc 簽章，首次遭 Gatekeeper 攔截時請至「系統設定 → 隱私與安全性」允許開啟；舊系統相容性與編譯說明見 [macOS 自行編譯](docs/zh-TW/DEVELOPMENT.md#macos-自行編譯)。
- **Linux (x64)**：下載 `linux-x64` `.deb`（`sudo apt install ./laPower_<版本>_linux-x64.deb`）、`.rpm`（`sudo dnf install ./laPower_<版本>_linux-x64.rpm`）或 `.AppImage`（`chmod +x` 後執行，可能需要 FUSE 2）。連接儀表前須先設定 [udev 規則](docs/zh-TW/DEVELOPMENT.md#udev-規則必需)。發佈頁 `SHA256SUMS` 可校驗全部八個產物。

## 🚀 快速上手

1. **連線裝置**：插入儀表後點擊標題列重新整理圖示，選擇裝置並點擊 `連線`。
2. **開始記錄**：在「監控」Tab 點擊 `開始記錄`（快速鍵 `P`），即時曲線與能量／容量積分同步開始（暫停不計入）。
3. **抓 PD 報文**：切至「PD 分析」Tab（預設開啟 `跟隨記錄` 與主監控同步）；插拔充電器即可擷取完整握手協商過程。
4. **打點與匯出**：按 `M` 或點擊 `打點` 標註關鍵節點；透過 `匯出 CSV`（右側箭頭可設定溫度、裝置資訊、標記及 CSV/PD 聯合匯出）或 `匯出報告` 產生檔案。

完整介面操作、全部設定項與檔案格式詳見 [使用指南](docs/zh-TW/USAGE.md)。

## 📚 文件

| 文件 | 內容 |
| --- | --- |
| [使用指南](docs/zh-TW/USAGE.md) | 介面逐項說明、全部設定項、CSV 與 PD 擷取檔案格式、常見問題 |
| [技術架構](docs/ARCHITECTURE.md)（簡體中文） | 執行緒模型、Tauri 命令、資料流、HID 報文佈局、測試與安全邊界 |
| [開發與建置](docs/zh-TW/DEVELOPMENT.md) | 環境要求、建置命令、CI 門禁、Linux / macOS 自行編譯、外部溫度服務、參與貢獻 |
| [效能基準與邊界](docs/PERFORMANCE.md)（簡體中文） | 圖表調度、資料完整性、效能測量與硬體邊界 |
| [更新記錄](CHANGELOG.md)（英文／簡體中文） | 版本索引、雙語發佈說明與早期中文歸檔 |

## 🙏 致謝與相關專案

- 感謝 WITRN、POWER-Z 提供的 USB-PD 擷取硬體支援。
- 感謝 [JohnScotttt](https://github.com/JohnScotttt) 的 WITRN HID 與 USB-PD 解析上游實作（`witrnhid`、`usbpdparser`）。
- 感謝 [km003c-protocol-research](https://github.com/okhsunrog/km003c-protocol-research) 對 POWER-Z Bulk、認證與 AdcQueue 協定的公開研究。
- 感謝 [c-power](https://github.com/bruno-ntmr/c-power) 專案，協定偵測介面的資訊組織與互動設計參考了該專案。
- 感謝貢獻者 [weixunkkkkk](https://github.com/weixunkkkkk)（#1）：新增 macOS Apple Silicon（ARM64）建置支援與 macOS 視窗設定。
- 感謝貢獻者 [asdmoment](https://github.com/asdmoment)（#4–#9）：實作 macOS 背景擷取保活與防休眠、原生視窗控制與選單列設定入口、WITRN HID 積壓報告排空與時間戳記回推、降取樣視窗均值聚合、記錄打點標註及 CSV 資料來源元資訊。
- 感謝貢獻者 [xiaokangzaina](https://github.com/xiaokangzaina)（#11）：實作毛玻璃介面與持久化自訂背景、主圖與時間線滾輪縮放／拖曳平移及分通道顯示微調、Canvas 2D 像素桶局部重繪最佳化、KM003C 輪詢瞬時取樣及 Windows 免安裝便攜包。

### 協定庫

工作區內的協定 crate 為獨立 Rust 函式庫（`publish = false`），不依賴 Tauri：

- **`crates/witrn-hid`** —— WITRN HID 裝置封裝與測量訊框解析。
- **`crates/usbpd-parser`** —— USB-PD 報文解碼與欄位樹。
- **`crates/km003c`** —— POWER-Z Vendor Bulk、AES 認證、AdcQueue 與 CDC 控制。

## 📄 授權條款

Copyright (C) 2026 KHWLGH

上述著作權行僅涵蓋 KHWLGH 自有的貢獻；其他作者保留各自權利，不因 Git 提交記錄推定著作權轉讓。完整範圍、產生物及上游聲明見 [`COPYRIGHT`](COPYRIGHT)。

| 自有貢獻範圍（排除第三方材料） | 授權條款 |
| --- | --- |
| 應用程式 `src/`、`src-tauri/`；`scripts/`、`tools/`、`test/`、`bench/`、`temperature-example/`、`.github/`；專案文件與設定的自有部分 | [GPL-3.0-only](LICENSE) |
| `crates/` 下所有函式庫、測試、範例及其自有文件與設定 | [LGPL-3.0-or-later](LICENSE.LGPL-3.0) |

`usbpd-parser` 與 `witrn-hid` 分別移植自 JohnScotttt 的 Python 套件 usbpdparser 1.1.6 與 witrnhid 1.1.5（均聲明 `Copyright (c) 2025 JohnScotttt`、LGPL-3.0-or-later）。本機授權全文見 [`LICENSE`](LICENSE)（GPLv3）與 [`LICENSE.LGPL-3.0`](LICENSE.LGPL-3.0)（LGPLv3），軟體不提供擔保。可在應用程式內 `設定 → 關於` 離線查閱專案著作權、GPL/LGPL 全文及全部第三方執行元件授權。

## 🔗 相關鏈接

- [提交 Issue 或建議](https://github.com/KHWLGH/laPower/issues)
- [維簡 (WITRN) 官方網站](https://www.witrn.com/)
- [Tauri 官方文件](https://tauri.app/)
- [Rust 官方網站](https://www.rust-lang.org/)
