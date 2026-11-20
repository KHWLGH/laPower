[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | **日本語**

<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="120" alt="laPower" />

# laPower

**WITRN / POWER-Z USB 電力計用デスクトップアプリ — リアルタイム監視 · USB-PD 分析 · データ記録**

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
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4?style=flat-square)](#-ダウンロードとインストール)

</div>

## 言語の選択

「設定 → 外観と言語 → 言語」で、システムに従う、简体中文、繁體中文、English、日本語を選択できます。変更は即座に反映・保存され、接続、記録、データ、グラフ範囲、フィルター、選択中のメッセージを保持します。設定をリセットすると自動選択に戻ります。

Linux では LC_ALL → LC_MESSAGES → LANG の順で最初の空でない値を使用し、Windows／macOS ではネイティブのシステム locale を取得します。取得できない場合は WebView の優先言語を使い、最終的に英語へフォールバックします。地域よりも文字体系を優先し、Hans は簡体字、Hant は繁体字を選びます。それ以外では CN／SG と地域なしの zh は簡体字、TW／HK／MO は繁体字、ja は日本語、それ以外（C／POSIX を含む）は英語になります。大文字小文字、アンダースコア、文字コード・修飾子の接尾辞を正規化します。手動選択は自動検出より優先されます。

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
```

## 📖 プロジェクトについて

laPower は WITRN USB 電力計と POWER-Z KM003C/KM002C に接続するデスクトップアプリです。USB HID または Vendor Bulk インターフェイスから測定フレームを読み取り、リアルタイム表示、長時間記録、USB-PD デコードをローカルで行います。これらの機能はオフラインで使用できます。手動の更新確認は GitHub、外部温度取得は設定した TCP サーバーへ接続します。

**Tauri v2** を使用し、バックエンドの **Rust** がデバイス通信、USB-PD 解析、バックグラウンドスレッドのライフサイクルを担当します。フロントエンドは **標準 JavaScript ES Modules** で、リリース時に esbuild がスクリプトとスタイルをまとめ、グラフには uPlot を使います。実行時のフロントエンド依存関係はすべてリポジトリに同梱され、CDN からリソースを取得しません。

電圧・電流・電力・温度に加え、**D+ / D− / CC1 / CC2 の信号線電圧**を記録し、計器が取得した **USB-PD メッセージをフィールドごとにデコード**します。充電器が通知した PDO、デバイスが要求した PPS 電圧、ネゴシエーションが完了した時刻をミリ秒単位で確認できます。

> **プラットフォームについて：** バージョンタグから GitHub Actions が Windows x64、Linux x64、macOS Intel／Apple Silicon をパッケージ化し、チェック通過後に Release を公開します。実際の配布物は各 Release の添付ファイルを確認してください。開発と検証は主に Windows で行っており、macOS／Linux の GUI・デバイス接続と macOS 12 の互換性は実機検証が必要です。[開発とビルド](docs/ja/DEVELOPMENT.md#リリース手順)を参照してください。

> **補足：** 本ソフトウェアの多くは Claude Code、Grok Build、Codex などの AI コーディングツールで制作しており、未知の問題が残る可能性があります。[Issues](https://github.com/KHWLGH/laPower/issues) で報告してください。

## 📸 画面プレビュー

Windows 上の **0.2.10** の画面です。独立した開発ツールで生成した仮想デバイスとデータを使用し、アプリ全体のタイトルバーを含めて表示しています。ライトテーマを先に掲載しています。アプリは既定でシステムテーマに従い、開発用プレビューはライトテーマが既定です。リリース前に毎回画像一式を更新します。再生成方法は[開発用プレビュー](docs/ja/DEVELOPMENT.md#開発用プレビュー)を参照してください。

| ライトテーマ | ダークテーマ |
| :---: | :---: |
| <img src="docs/screenshots/ja/light-record.png" alt="モニター（ライト）：測定値カード、8 チャンネルのグラフ、タイムラインナビゲーター" /><br><sub>**モニター** · 測定値カード / 8 チャンネル・4 軸 / タイムライン</sub> | <img src="docs/screenshots/ja/dark-record.png" alt="モニター（ダーク）" /><br><sub>**モニター** · ダークテーマ</sub> |
| <img src="docs/screenshots/ja/light-pd.png" alt="PD 分析（ライト）：メッセージ一覧とフィールドごとのデコードツリー" /><br><sub>**PD 分析** · メッセージ一覧 / PDO 概要 / フィールドデコード</sub> | <img src="docs/screenshots/ja/dark-pd.png" alt="PD 分析（ダーク）" /><br><sub>**PD 分析** · ダークテーマ</sub> |
| <img src="docs/screenshots/ja/light-trigger.png" alt="プロトコル制御（ライト）：PDM、PDO 一覧、検出ログ" /><br><sub>**プロトコル制御** · PDM / PDO / プロトコル検出・電圧要求</sub> | <img src="docs/screenshots/ja/dark-trigger.png" alt="プロトコル制御（ダーク）" /><br><sub>**プロトコル制御** · ダークテーマ</sub> |
| <img src="docs/screenshots/ja/light-settings.png" alt="設定（ライト）：固定目次、テーマ、カスタム背景画像と言語、グラフと記録" /><br><sub>**設定** · テーマ / 保存されるカスタム背景 / 言語 / グラフと記録</sub> | <img src="docs/screenshots/ja/dark-settings.png" alt="設定（ダーク）" /><br><sub>**設定** · ダークテーマ</sub> |
| <img src="docs/screenshots/ja/light-detection.png" alt="プロトコル検出（ライトテーマ）" /><br><sub>**プロトコル検出** · プロトコル別の状態 / 電圧 / 個別の根拠</sub> | <img src="docs/screenshots/ja/dark-detection.png" alt="プロトコル検出（ダークテーマ）" /><br><sub>**プロトコル検出** · ダークテーマ</sub> |

### レポートの表示例

メイン画面は 4 言語・両テーマで 40 枚です。以下の 32 枚は同じ 120 秒の仮想記録から実際に描画したレポートです。横長画像と動画は先頭 8 マーカー、縦長画像は全 12 マーカーを保持します。動画は再生途中のフレームを表示しています。

| ライトテーマ | ダークテーマ |
| :---: | :---: |
| <img src="docs/screenshots/ja/light-report-image.png" alt="画像レポート（16:9） (ライトテーマ)" /><br><sub>**画像レポート（16:9）** · 無損失 PNG / 全曲線 / 統計とマーカー</sub> | <img src="docs/screenshots/ja/dark-report-image.png" alt="画像レポート（16:9） (ダークテーマ)" /><br><sub>**画像レポート（16:9）** · ダークテーマ</sub> |
| <img src="docs/screenshots/ja/light-report-long.png" alt="画像レポート（縦長） (ライトテーマ)" /><br><sub>**画像レポート（縦長）** · 全 12 マーカー / 時刻と個別の測定値</sub> | <img src="docs/screenshots/ja/dark-report-long.png" alt="画像レポート（縦長） (ダークテーマ)" /><br><sub>**画像レポート（縦長）** · ダークテーマ</sub> |
| <img src="docs/screenshots/ja/light-report-video.png" alt="動画レポートのフレーム (ライトテーマ)" /><br><sub>**動画レポートのフレーム** · 動画途中のフレーム / 現在値 / 再生カーソル</sub> | <img src="docs/screenshots/ja/dark-report-video.png" alt="動画レポートのフレーム (ダークテーマ)" /><br><sub>**動画レポートのフレーム** · ダークテーマ</sub> |
| <img src="docs/screenshots/ja/light-protocol-report.png" alt="プロトコル検出レポート (ライトテーマ)" /><br><sub>**プロトコル検出レポート** · 対応状態と電圧 / PD バージョン / 全 PDO</sub> | <img src="docs/screenshots/ja/dark-protocol-report.png" alt="プロトコル検出レポート (ダークテーマ)" /><br><sub>**プロトコル検出レポート** · ダークテーマ</sub> |

## ✨ 主な機能

### リアルタイム監視

- 電圧・電流・電力・温度のカードに、最小・最大・平均値を表示します。
- **積算電力量（Wh）と積算容量（mAh）**はサンプルをソフトウェアで積分して求めます。スリープ、時刻の巻き戻り、NTP による前方ジャンプで生じる時刻変動（サンプリング間隔の 8 倍を超え、かつ 2 秒以上）は 1 サンプリング周期分だけ進め、積算値の異常増加を防ぎます。
- **信号線電圧** D+ / D− / CC1 / CC2 はグラフに重ねて表示でき、CSV にも出力します。実際の分解能はデバイスに依存し、WITRN の CC1／CC2 は 0.1 V です。
- **電流方向の記録**を有効にすると符号を保持します（順方向は正、逆方向は負、K2 は ±10 A をネイティブ対応）。サイドバーに方向矢印を表示します。
- **自動一時停止：** 電圧・電流・電力がしきい値未満の状態で指定秒数続くと記録を一時停止し、無人の充放電テストに使えます。
- **POWER-Z 高速サンプリング：** KM003C/KM002C は認証後の AdcQueue で毎秒 1000 回取得します。認証失敗時は毎秒 100 回へ自動的に戻ります。
- **一時復元と上限：** 記録を約 1 秒ごとにアプリのキャッシュ内の一時ファイルへ保存し、クラッシュ復元に使用します。正常終了時に削除します。1 回の記録の既定上限は 512 MB で、到達時に自動一時停止します。長期保存用 CSV は明示的なエクスポートで作成します。

### USB-PD 分析

- SOP／SOP′ の制御・データ・拡張メッセージと Hard Reset／Cable Reset をデコードします。
- 役割と方向のバッジ（`SRC → SNK`、`SRC|SNK → Plug`）と **PDO／RDO の概要**を表示します。例：
  `Fixed: 5.0V 9.0V 12.0V 15.0V 20.0V SPR AVS: 9-15V@3.0A PPS: 5.0-21.0V`、`Position:7 PPS:8.0V,3.45A`。
- 詳細パネルでフレームを**ワード単位で分解**します。Data Object の生の 16 進値 → ヘッダーフィールド表（Extended / Objects / Msg ID / Power Role / Spec Rev / Data Role / Msg Type）→ 各 PDO の完全なビットフィールド表の順に表示します。
- メッセージ種別で絞り込んだり、全体の半数以上になりやすいリンク層確認フレーム GoodCRC を非表示にできます。
- **記録と連動**では PD キャプチャとモニターを連動させ、記録中だけ取得し、開始・一時停止・クリアを同期します。
- 増え続けるログを仮想リストで表示し、数十万件規模でもスムーズにスクロールできます。

### 高性能グラフ

- uPlot で **8 曲線・4 本の Y 軸**（電流 A、電圧 V、電力 W、温度 °C）を描画します。4 軸の目盛りを厳密に揃え、2 段階の細かい補助グリッドを備えます。
- 密なデータは増分 min/max ピクセルバケットで描画し、**100 万点でもドラッグ可能**です。履歴表示はキャンバスの実ピクセル解像度に沿って詳細を保持し、遅いフレームでもバケットを粗くせず、拡大すると元の点に戻ります。完全なデータは列形式で保持し、ホバー時は二分探索で元のサンプルを参照します。記録中もホイールで横方向にズームできます。
- 毎秒 1000 回の取得では自動描画を約 10–20 fps にし、ドラッグ・ズームは独立して更新します。取得・保存は全サンプルを保持します。記録中と停止後の履歴表示で極値インデックスを共有し、縮小・移動時の全履歴スキャンを避けます。検証範囲と限界は[性能説明](docs/en/PERFORMANCE.md#measurement-and-hardware-limits)（英語）を参照してください。
- ツールチップに表示中のチャンネルの有効な値を最大 8 件表示し、凡例に表示中のチャンネルを並べ、`表示` パネルで表示を切り替え、下部のタイムラインで範囲選択・移動ができます。
- 「表示 → 曲線の塗りつぶし」は既定でオンで、選択を保存します。チャンネル別の不透明度を保持し（0 = 無効、1–100 = 有効）、記録・一時停止・ズームで自動変更しません。

### 記録とデータ互換性

- **画像・動画レポート**：記録全体を PNG または短い動画に書き出し、解像度・テーマ・曲線・マーカーを選択できます。画像は 16:9 と全マーカーを保持する縦長形式に対応します。
- **POWER-Z プロトコル検出とレポート**：対応状態・電圧・根拠を確認し、PD PDO とバージョンを個別に読み取ります。検出結果を 1080p〜4K PNG に書き出し、対応プロトコルをトリガーフォームに入力できます。
- **CSV エクスポート**は温度・デバイス情報・マーカーを個別に選択でき、CSV と PD JSON の同時保存にも対応します。**インポート**は列名で照合し、旧ファイルにも対応します。
- **マーカー**：`マーク` または `M` キーで現在の時点にラベル（例：バッテリー 50%）を付け、グラフ上で `M` を押すとポインター位置の点に付けます。グラフに縦線で表示し、CSV の `Marker` 列で書き出し・読み込みできます。
- **PD キャプチャのエクスポート／インポート**はバージョン付き JSON エンベロープを使い、旧形式も読み込めます。
- 毎秒 0.1–100 回を選択でき、POWER-Z は毎秒 1000 回にも対応します。バックエンドは 1–60000 ms を受け付け、実際の下限はデバイスに依存します。

### インターフェイス

- タブ式ワークスペース（モニター／PD 分析／プロトコル制御／設定）と常設のタイトルバー接続欄で、どの画面からも接続・切断できます。プロトコル制御の入口は常に表示し、対応する POWER-Z の接続後に操作できます。
- **システムに従う／ライト／ダーク**の 3 テーマで、既定はシステムに従います。デザイントークンは Fluent UI webDark／webLight に合わせています。
- **UI スケール 50–200%**。OS の拡大率で画面が窮屈な場合は縮小できます。
- macOS は標準ウィンドウボタンでフルスクリーン、タイル表示、最小化を操作できます。Windows は Windows 11 のスナップレイアウトを保持し、Windows／Linux ではボタンの外観を Windows／macOS スタイルから選択できます。

## 📱 対応デバイス

| モデル | VID | PID |
| --- | --- | --- |
| WITRN K2 | `0x0716` | `0x5060` |
| WITRN U3 | `0x0716` | `0x5063`、`0x5044` |
| WITRN C5 | `0x0716` | `0x5053`、`0x5064` |
| POWER-Z KM003C | `0x5FC9` | `0x0063` |
| POWER-Z KM002C | `0x5FC9` | `0x0061` |

WITRN はベンダー VID `0x0716` で列挙するため、**表にないモデルやファームウェアの派生版も一覧に表示**されます（「不明な WITRN デバイス (0716:XXXX)」）。測定できるかはファームウェアのレポート構造が互換であるかに依存します。POWER-Z は `0x5FC9` の Vendor Bulk インターフェイスで別途列挙します。

同じ物理デバイスに複数の HID インターフェイスがある場合、ベンダー定義 Usage Page を優先します。取得できた USB トポロジーポートは `WITRN K2 (USB 4-4)` のように名前へ付加します。

## 📦 ダウンロードとインストール

旧プロジェクト名は WITRN-RS です。laPower のアプリ識別子は `io.github.khwlgh.lapower` で、設定・キャッシュディレクトリを独立させています。旧設定は自動移行しませんが、既存 CSV と PD キャプチャは読み込めます。

**Windows 10／11（x64）** — [Releases](https://github.com/KHWLGH/laPower/releases/latest) から `.msi` または `.exe`（NSIS）をダウンロードしてインストールします。WITRN は OS 標準 USB HID、POWER-Z は OS 標準 HID／WinUSB を使い、通常は Windows が自動で関連付けるため追加ドライバーは不要です。

Windows インストーラーには現在証明書署名がなく、初回起動時に SmartScreen が表示される場合があります。

**macOS 12+** — Intel Mac は `macos-x64`、Apple Silicon（M1 以降）は `macos-arm64` の `.dmg` を選び、開いて `laPower.app` を Applications へドラッグします。ad-hoc 署名のみで Developer ID 署名・Apple 公証はありません。Gatekeeper が初回起動をブロックした場合は「システム設定 → プライバシーとセキュリティ」で開くことを許可してください。macOS 12 はビルド対象であり、旧 OS の互換性には実機検証が必要です。ビルド手順と検証範囲は [macOS でのビルド](docs/ja/DEVELOPMENT.md#macos-でのビルド)を参照してください。

**Linux（x64）** — `linux-x64` の `.deb`、`.rpm`、`.AppImage` を選びます。Debian／Ubuntu は `sudo apt install ./laPower_<version>_linux-x64.deb`、Fedora などは `sudo dnf install ./laPower_<version>_linux-x64.rpm` でインストールできます。AppImage は `chmod +x ./laPower_<version>_linux-x64.AppImage` の後に実行します。ディストリビューションによって FUSE 2 ランタイムが必要です。Ubuntu 22.04 でビルドしており、すべてのディストリビューションへの対応は保証しません。

Linux パッケージはデバイス権限を自動設定しません。接続前に [udev ルール](docs/ja/DEVELOPMENT.md#udev-ルール必須)を設定してください。未設定では検出・接続できない場合があります。Release の `SHA256SUMS` で 7 個のインストールパッケージを検証できます。

## 🚀 クイックスタート

1. **接続** — 計器を挿し、タイトルバーのデバイス一覧横の更新ボタンでスキャンし、対象を選んで `接続` をクリックします。
2. **記録** — `モニター` タブで `記録開始` をクリックします。カードとグラフが更新され、電力量・容量も積算します（一時停止中は加算しません）。
3. **PD キャプチャ** — `PD 分析` へ移動します。既定で `記録と連動` が有効で、モニターの開始・一時停止と同期します。**充電器を挿し直す瞬間のハンドシェイクが特に有用です。**
4. **エクスポート** — `モニター` の `CSV をエクスポート` 本体は保存済みの設定で書き出します。右の矢印から温度・デバイス情報・マーカーを選択し、CSV と PD の同時保存も実行できます。PD ページでは JSON を個別に保存できます。記録は `P`、マークは `M` が既定で、設定から変更できます。

全画面の説明、各設定、ファイル形式は[使用ガイド](docs/ja/USAGE.md)を参照してください。

## 📚 ドキュメント

| ドキュメント | 内容 |
| --- | --- |
| [使用ガイド](docs/ja/USAGE.md) | 各操作・全設定、CSV／PD キャプチャ形式、よくある質問 |
| [技術アーキテクチャ](docs/en/ARCHITECTURE.md)（英語） | スレッドモデル、Tauri コマンド、データフロー、HID 構造、テスト・セキュリティ境界 |
| [開発とビルド](docs/ja/DEVELOPMENT.md) | 環境、ビルドコマンド、CI、Linux／macOS ビルド、外部温度サービス、貢献方法 |
| [性能ベンチマークと限界](docs/en/PERFORMANCE.md)（英語） | グラフスケジューリング、データ完全性、性能測定、実機検証の限界 |
| [変更履歴](CHANGELOG.md)（英語／簡体字中国語） | バージョン索引、2 言語のノートと過去の中国語アーカイブ |

## 🙏 謝辞と関連プロジェクト

- USB-PD キャプチャハードウェアを提供する WITRN、POWER-Z に感謝します。
- WITRN HID 実装を提供した [JohnScotttt](https://github.com/JohnScotttt) に感謝します。
- POWER-Z Bulk、認証、AdcQueue を公開研究した [km003c-protocol-research](https://github.com/okhsunrog/km003c-protocol-research) に感謝します。
- プロトコル検出 UI の情報構成と操作設計の参考にした [c-power](https://github.com/bruno-ntmr/c-power) に感謝します。
- すべてのオープンソース貢献者に感謝します。

### プロトコルライブラリ

ワークスペース内のプロトコル crate は、Tauri に依存しない独立した Rust ライブラリ（`publish = false`）です。

- **`crates/witrn-hid`** — WITRN HID デバイスのラッパーと測定フレーム解析。
- **`crates/usbpd-parser`** — USB-PD デコードとフィールドツリー。
- **`crates/km003c`** — POWER-Z Vendor Bulk、AES 認証、AdcQueue、CDC 制御。

## 📄 ライセンス

Copyright (C) 2026 KHWLGH

この著作権表示は KHWLGH 自身の貢献のみを対象とします。他の著作者の権利は保持され、Git の著作者情報から著作権譲渡を推定しません。まとめた表示と具体的なパスの範囲は [`COPYRIGHT`](COPYRIGHT) を参照してください。

| 自作の貢献の範囲（第三者の素材を除く） | ライセンス |
| --- | --- |
| アプリ `src/`、`src-tauri/`、`scripts/`、`tools/`、`test/`、`bench/`、`temperature-example/`、`.github/`、プロジェクト文書・設定の自作部分 | [GPL-3.0-only](LICENSE) |
| `crates/` 内のすべてのライブラリ、テスト、サンプル、自作の文書・設定 | [LGPL-3.0-or-later](LICENSE.LGPL-3.0) |

自作のアプリアイコンとサイズ派生物、スクリーンショットの自作部分も上記の範囲に含まれます。生成物は入力のライセンスを保持し、第三者の素材、ライセンス文書、元データが本プロジェクトの創作物になるわけではありません。`usbpd-parser` と `witrn-hid` は、それぞれ JohnScotttt の Python パッケージ usbpdparser 1.1.6 と witrnhid 1.1.5 の移植です。両原版の表示は `Copyright (c) 2025 JohnScotttt`、LGPL-3.0-or-later です。出典と未解決の証拠不足は [`COPYRIGHT`](COPYRIGHT) に記載しています。

全文はローカルの [`LICENSE`](LICENSE)（GPLv3）と [`LICENSE.LGPL-3.0`](LICENSE.LGPL-3.0)（LGPLv3 原文全文、GPLv3 と併読）で確認できます。ライブラリの「以降のバージョン」の選択肢は適用範囲の宣言によるものです。ソフトウェアは無保証で提供され、変更・再頒布には適用ライセンスの条件が適用されます。

`設定 → このアプリについて` でプロジェクトの著作権、GPL/LGPL 全文、第三者のライセンス資料をオフラインで読めます。`サードパーティーコンポーネント` には主要項目と `すべての実行時コンポーネント` の一覧があり、各項目からライセンスを開けます。uPlot、Fluent System Icons、GitHub Octicons、Tauri とそのプラグインなどは、それぞれの著作権とライセンスを保持します。

## 🔗 関連リンク

- [問題・提案の報告](https://github.com/KHWLGH/laPower/issues)
- [WITRN 公式サイト](https://www.witrn.com/)
- [Tauri 公式ドキュメント](https://tauri.app/)
- [Rust 公式サイト](https://www.rust-lang.org/)
