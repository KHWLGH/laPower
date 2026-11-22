[English](../en/DEVELOPMENT.md) | [简体中文](../DEVELOPMENT.md) | [繁體中文](../zh-TW/DEVELOPMENT.md) | **日本語**

← [README](../../README.ja.md) に戻る

# 開発とビルド

- [必要な環境](#必要な環境)
- [ビルドと実行](#ビルドと実行)
- [リリース手順](#リリース手順)
- [品質チェック](#品質チェック)
- [テストと回帰確認の範囲](#テストと回帰確認の範囲)
- [言語の選択](#言語の選択)
- [辞書の保守と翻訳チェック](#辞書の保守と翻訳チェック)
- [ヘッドレステスト API](#ヘッドレステスト-api)
- [開発用プレビュー](#開発用プレビュー)
- [性能測定](#性能測定)
- [CI チェック](#ci-チェック)
- [Linux でのビルド](#linux-でのビルド)
- [macOS でのビルド](#macos-でのビルド)
- [外部温度サービス](#外部温度サービス)
- [貢献方法](#貢献方法)

## 必要な環境

| 項目 | 要件 | 補足 |
| --- | --- | --- |
| Rust | 1.85+ | ワークスペースの `rust-version` |
| Tauri CLI | 2.12.1 | npm で固定した `@tauri-apps/cli`（`npx --no-install tauri` で実行） |
| Windows | 10 / 11 | 主な開発・検証環境 |
| macOS | 12+ | 最低デプロイ対象。CI は macOS 26、旧 OS 互換性は実機確認が必要 |
| Node.js | 24 | CI、lint／typecheck／test、フロントエンド生成 |

npm を使用して `package-lock.json` を管理します（CI は `npm ci`）。フロントエンドは標準 ES Modules で、`frontendDist` は生成された `out/` を参照します。Node は Rust コンパイルには参加しませんが、`cargo build`、`cargo test`、`cargo check`、`cargo clippy` より先に `npm run build` が必要です。`src/` 変更後は `out/` を再生成してから Rust バイナリを再リンクしてください。

## ビルドと実行

```bash
git clone https://github.com/KHWLGH/laPower.git
cd laPower
npm ci
npm run dev
```

| コマンド | 用途 |
| --- | --- |
| `npm run dev` | 開発用フロントエンドを自動生成してネイティブアプリを起動 |
| `npm run dev:web` | 模擬デバイスのブラウザープレビューを起動（`-- --port 4174` でポート変更可） |
| `npm run build` | Cargo 埋め込み用の開発用フロントエンド `out/` を生成 |
| `npm run build:app` | 圧縮済みフロントエンドを自動生成しローカルインストーラーをビルド |

`beforeDevCommand` と `beforeBuildCommand` がそれぞれフロントエンドを生成するため、事前の手動 `npm run build` / `npm run build:dist` は不要です（Cargo を直接実行する場合は先に `out/` が必要）。開発ビルドにホットリロードはなく、`src/` 変更後は `dev` を再起動するか再リンクします。配布物はローカルでは `target/release/bundle/`、CI では `target/<target>/release/bundle/` に出力されます。

### Windows のビルドスクリプトがウイルス対策ソフトにブロックされる場合

Cargo が `libc` の `build-script-build` を実行する前に `os error 5` / `os error 32` が発生しウイルス対策ソフトが同パスを遮断する場合、対象はビルド時プログラムでありアプリの実行時バイナリではありません。ローカルの Windows/MSVC + Kaspersky 環境で `libc 0.2.189` が最適化レベル 2 で遮断され、レベル 0 で通ることを確認しています。

ルートの `Cargo.toml` では `[profile.dev.package.libc] opt-level = 0` を設定しています（dev／test に適用され、release や他依存関係は変更せず；`profile.dev.build-override` では既存の `package."*"` を上書き不可）。設定更新後は `target/` 全削除なしでビルドを再実行できます。引き続き遮断される場合は検知名・パス・ハッシュを保存してください。

### クリーンアップの段階

各段階は前の段階を含んで削除完了まで待機し、既定では Rust キャッシュ・依存関係・インストーラーを保持します：

| コマンド | 削除範囲 |
| --- | --- |
| `npm run clean` | `out/`、`output/`、`bench/results/`、ルートと `src/` の `.playwright-cli/`、`src-tauri/gen/schemas/` |
| `npm run clean:incremental` | さらに `target/` と `src-tauri/target/` の `debug/release` 増分キャッシュ（クロスコンパイル含む） |
| `npm run clean:build` | さらに `target/`、`src-tauri/target/` 全体と `dist/` |
| `npm run clean:all` | さらに `node_modules/`（再開前に `npm ci` が必要） |

削除せずに確認：

```bash
npm run clean:build -- --dry-run
```

クリーナーは実行前に全対象と Git 追跡状態を確認し、シンボリックリンク／junction があれば中止します。最大 4 ディレクトリを並列削除し、使用中エラーを回数制限で再試行します。関連プロセスを先に終了してください；追跡済み画像、`bench/baselines/`、ソース、ロックファイル、リポジトリ外キャッシュ（独自 `CARGO_TARGET_DIR` 含む）は保持します。

### 実行時コンポーネント一覧

「このアプリについて」は同梱の `src/third-party-components.json` と、必要時に読み込む `src/legal-notices.json` を参照します。Cargo 実行時依存関係・同梱資産・ライセンス入力を変更したら `npm run components:generate` を実行し、生成物と必要資料をコミットして `npm run components:check` で照合してください（生成ファイルの手動編集は禁止）。

スクリプトはオフライン・`--locked` の Cargo metadata/tree で 4 デスクトップ対象の normal 依存を保守的に統合します（workspace・開発/ビルド専用・手続きマクロを除外；キャッシュ不足時は事前に `cargo fetch --locked` が必要）。ライセンス本文は [`COPYRIGHT`](../../COPYRIGHT)、[`LICENSE`](../../LICENSE)、[`LICENSE.LGPL-3.0`](../../LICENSE.LGPL-3.0)、ローカル Cargo キャッシュ、`licenses/materials.json` の補足資料（バージョン・revision・上流パス・SHA-256 を記録；審査済み固定版例外のみ欠落を許容）から収集します。通常のフロントエンドビルドは生成済みファイルの検証・コピーのみで Cargo や通信を行いません。

リリース Tag のソースアーカイブにはローカルキャッシュや SDK が含まれないため、アーカイブからビルドする際は `cargo fetch --locked` と `npm ci` で依存ソースを取得してください。自作貢献の著作権表示は `Copyright (C) 2026 KHWLGH` に固定され、Git 著作者情報から譲渡を推定しません（範囲詳細は [`COPYRIGHT`](../../COPYRIGHT) を参照）。

## リリース手順

開発中は `changelog/unreleased/zh-CN.md` のみを編集します。リリース前に重複を統合し利用者向け簡体字中国語を整理したうえで `en.md` を作成・手動校正します（文単位の厳密一致は不要、翻訳 API 不使用）。

```bash
npm run release:prepare -- 0.3.0 --date 2026-11-22 --dry-run
npm run release:prepare -- 0.3.0 --date 2026-11-22
npm run release:notes
npm run showcase:capture
```

例のバージョンと日付を置換してください。`release:prepare` は両言語草稿が非空で既存バージョンディレクトリがないことを確認し、`changelog/<version>/` へ保存、バージョン同期、ルート `CHANGELOG.md` 更新、`dist/release-notes.md` 生成を行い、完了時のみ草稿を空にします（`--dry-run` は書き込みなし；失敗時は草稿を保持）。Release は英語を展開し簡体字中国語を折りたたんで両言語のインストール手順を含めます。コマンドはコミット・タグ作成・公開を行いません。

### リリース前の文書用スクリーンショット更新

リリースごとに次の順で実施します：**バージョン同期と履歴保存 → スクリーンショット撮影・確認 → 品質チェック → コミット → バージョンタグ push → GitHub Actions ビルド・公開**（ローカル事前ビルド不要；履歴保存済みなら `npm run showcase:capture` のみ再実行）。

初回は `npx playwright install chromium`（Linux で不足時は `--with-deps`）を実行します。既定で **72 枚**（メイン画面 40 枚 + レポート 32 枚）を `docs/screenshots/<language>/` に生成します：

- **必須の基本 32 枚**：4 言語 × ライト／ダーク × モニター・PD 分析・プロトコル制御・設定（完全タイトルバー・120 秒共通仮想データ・最新マニフェスト版）。
- **追加 40 枚**：プロトコル検出画面 8 枚 + レポート出力例 32 枚（16:9 PNG・縦長 PNG・動画フレーム・プロトコル検出レポート）。

全画像で文字切れ・テーマ・グラフ・プロトコル状態・設定目次・バージョン一致を目視確認し、4 言語 README の記述・参照を更新して一括コミットしてください。

### 文書の保守範囲

README・使用ガイド・開発ガイドは 4 言語（英・簡・繁・日）、アーキテクチャ・性能・crate README・変更履歴は英／簡体字の 2 言語で保守します（0.2.2 以前は簡体字のみ）。主要文書は同言語へリンクし、副次文書は繁体字から簡体字、日本語から英語へリンクして言語を明記します。翻訳ハッシュや文書専用 CI は設けません。

### 変更履歴へのリンク

各バージョンの本文は `changelog/<version>/` に置き、ルート `CHANGELOG.md` はアンカーを維持した索引とします。ノート内の相対リンクはファイル位置基準（例：`../../docs/en/USAGE.md`）で記述し、GitHub Release では該当タグへ固定されます。

### バージョンだけを設定する

変更履歴をアーカイブせずバージョンのみ同期する場合：

```bash
npm run version:set -- 0.3.0
```

先頭ゼロなしの `X.Y.Z` を検証し、`package.json`、`package-lock.json`、`Cargo.toml`（`[workspace.package] version`）、`Cargo.lock`、`src-tauri/tauri.conf.json` を同期します（Rust メンバーは `version.workspace = true` で継承；同バージョン再設定では変更・コミット・タグ作成を行いません）。`test/version-sync.test.js` が整合性を検証します。

### 手動ビルドと初回検証

GitHub **Actions → CI → Run workflow** からブランチ／タグを選択すると品質チェック後に 4 対象をビルドできます（タグ指定でも Release 公開は行いません）：

| 対象 | Runner | Rust target | パッケージ |
| --- | --- | --- | --- |
| Windows x64 | `windows-2022` | `x86_64-pc-windows-msvc` | MSI、NSIS EXE（`_setup`）、ポータブル ZIP |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | DEB、RPM、AppImage |
| macOS Intel | `macos-26-intel` | `x86_64-apple-darwin` | DMG |
| macOS Apple Silicon | `macos-26` | `aarch64-apple-darwin` | DMG |

4 対象すべて成功すると `release-packages`（8 パッケージと `SHA256SUMS`、`sha256sum -c SHA256SUMS` で検証）を生成します。Windows ポータブル版（`laPower_<version>_windows-x64_portable.zip`）は WebView2 Runtime 環境下で `laPower.exe` を直接実行でき、標準ユーザーデータ領域を使用します。macOS は検証用に `.app` を残すため `--bundles app,dmg` を指定します（公開物は DMG のみ）。自動リリース運用前に Windows、両 Mac（macOS 12 含む）、udev 設定済み Linux で実機検証してください。

### バージョンタグによる自動公開

検証とリリース変更のコミット完了後、マニフェストと一致する `vX.Y.Z` タグを push します：

```bash
git tag v0.3.0
git push origin v0.3.0
```

CI は Node.js 24、Rust stable、Tauri CLI 2.12.1、`tauri-apps/tauri-action@v1` を使用します（Linux は glibc 互換のため Ubuntu 22.04 固定）。全チェックとビルド成功後、`release` job が `GITHUB_TOKEN`（`contents: write` 必須）でドラフトを作成し、8 配布物と `SHA256SUMS` をアップロード・数／サイズ／SHA-256 検証して自動公開します。同一 ref は直列実行され、失敗時はドラフトを残して再実行で置換可能です（公開済み同名 Release は上書き拒否）。Windows 署名なし、macOS は ad-hoc 署名、Linux は udev 自動設定なしです。

## 品質チェック

変更範囲に応じた入口を実行します（最初の失敗で停止）：

| コマンド | 使用場面 |
| --- | --- |
| `npm run check` | 日常のフロントエンドチェック（`npm test`、`typecheck`、`lint` を実行、`out/` 未生成） |
| `npm run check:rust` | Rust チェック（先に `out/` を生成し `cargo fmt`、workspace Clippy、テストを実行） |
| `npm run check:all` | 納品前フルチェック（上記 2 群と `components:check`、フロント生成は 1 回） |

`npm test` は `test/*.test.js` のみ実行し（個別実行：`node --test test/name.test.js`）、Biome は出力先・依存関係・`.local-*` を除外します。純粋ロジック・データ処理・プロトコル／ファイル契約・セキュリティ・バージョン同期をカバーします：

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

`usbpd-parser` や `witrn-hid` の feature 境界変更時は CI の非既定組み合わせも実行してください：

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

## テストと回帰確認の範囲

- 通常の機能追加・削除・名称変更や UI レイアウト・スタイル・文言・選択肢の変更には原則回帰テストを追加しません。
- データ損失／破損、プロトコル互換、クラッシュ／デッドロック、セキュリティ、リリース不変条件、確認済み重大不具合に限りテストを追加します。
- 既存コアテストの拡張を優先し、小機能ごとにテストファイル・設計書・CI job を新設しません。
- 性能ベンチマークと実機確認は手動で実施し、毎回のブラウザー自動回帰や専用 CI workflow は追加しません。

## 言語の選択

「設定 → 外観と言語 → 言語」でシステムに従う・简体中文・繁體中文・English・日本語を選択でき、接続・記録・データ・表示範囲・フィルター・選択メッセージを保持したまま即時反映・保存されます（設定リセットで自動モードへ復帰）。

Linux は `LC_ALL → LC_MESSAGES → LANG` の順で最初の非空値を使用し、Windows／macOS は OS 標準ロケール（不可時は WebView 優先言語、最終フォールバックは英語）を用います。地域より文字体系 `Hans`/`Hant` を優先し、それ以外は `CN`/`SG`・無地域 `zh` → 簡体字、`TW`/`HK`/`MO` → 繁体字、`ja` → 日本語、その他（`C`/`POSIX` 含む）→ 英語になります（大文字小文字・`_`・符号化・修飾子を正規化；手動選択を優先）。

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
```

## 辞書の保守と翻訳チェック

`src/i18n.js` が `t(key, params)`・ロケール判定・変更購読を提供し、`src/i18n-messages.js` は英語（基準兼フォールバック）・簡体字・繁体字・日本語の 4 列を持ちます。意味のあるキー名と共通の補間パラメーターを使い、利用者向け文書は簡体字を基準に人が校正します。

静的 HTML は英語フォールバックと `data-i18n*` 属性を使い（アイコン・入力欄を含む要素は文字 span のみ指定）、動的表示や継続通知には `t` または遅延文字列関数を使います。言語切替で再接続やデータ再構築を行いません。バックエンドエラーは `{code, params, detail?}` で返しフロントエンドが `code` を翻訳して生診断を保持します（文字列エラーも互換）。PD 名称・生応答・単位・CSV／PD 形式は変更しません。

```bash
node --test test/i18n.test.js test/settings-persistence.test.js
node tools/showcase/verify-i18n.mjs
npm run showcase:capture -- --language zh-CN,zh-TW,en,ja
```

4 言語・両テーマ・900×600／1280×800・接続／記録／PDM 状態・PD 絞り込み・CSV／PD 往復・アクセシビリティラベルを確認します。模擬動作は Linux `LANG`/`LC_*` 実機、macOS GUI、ネイティブダイアログ、実機計器の代替になりません。

## ヘッドレステスト API

`tools/showcase/headless.mjs` は Node スクリプト向けの Playwright ヘッドレスラッパーを提供し（初回は `npx playwright install chromium`）、独立ランナーや CI job は追加しません：

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

- `createHeadlessHarness({ channel, distribution, timeout })`：既定は Chromium・ソース・15 秒タイムアウト（`msedge`／`chrome` や `out/` 指定可）。
- `openApp({ language, theme, query, context, beforeLoad })`：分離したストレージ・仮想デバイス・凍結時計・ダウンロード環境を用意して待機します。
- `connect(path)`・`record()`・`pause()` は実 UI を操作し、`freeze()`/`resume()`・`advance(ms)`（0–300000 ms）は仮想時刻と実 ACK を進め、`flush()` は消費境界、`waitForCharts()` は主グラフ処理と 2 フレームを待ちます。
- `diagnostics()` は `source`・`stream`・`performance`・`errors`・`consoleErrors` を返し、`app.page.evaluate()` で `window.__SHOWCASE__` 障害フックを呼べます。`await using`（Node 24）で終了時に自動解放しエラーをそのまま伝播します。

## 開発用プレビュー

`tools/showcase/` は仮想 WITRN K2／POWER-Z KM003C、決定的な曲線、PD メッセージ、プロトコル制御結果を提供する独立ブラウザー開発ツールです（実機通信なし・`src/`/`out/`/インストーラーへ非同梱）。

```bash
npm ci
npx playwright install chromium
npm run showcase:dev
npm run showcase:capture
```

- **対話プレビュー**：`http://127.0.0.1:4173` で起動し（`-- --port 4174` や `/app/?theme=dark`・`/app/?theme=system` 指定可）、120 秒データ投入・凍結・再開・10 秒進行・リセットを行えます。
- **スクリーンショット生成**：Chromium 1280×800 × 2× DPI で 2560×1600 の UI 画像（完全タイトルバー）と 1920×1080／1920×1340 レポート画像を出力します（モニターレポートは `cargo run --locked -p lapower --example showcase-reports` 経由、メイン画面のみなら `--page record,pd,trigger,detection,settings` で Rust 不要）。詳細は `npm run showcase:capture -- --help`。
- **サンプルとデバッグ自動化**：`tools/showcase/scenario.js` で波形や PDO を調整し、生 PD 変更時は Rust 環境で `node tools/showcase/generate-pd.mjs` を実行して `pd-fixtures.json` を再生成します。debug ビルドの `video_export_pick` はローカル自動化用に `LAPOWER_VIDEO_TARGET` による保存先指定に対応します（release ビルドはネイティブダイアログのみ）。
- **フォント検証**：`node tools/showcase/verify-appearance.mjs` で繁体字中国語ライト／ダークと 100% / 125% / 150% DPI の DOM・Canvas フォントを `output/appearance-verification/` に検証します。

## 性能測定

`bench/` はアルゴリズム・ストレージ・メモリ・ズーム描画・起動・配布構成のベンチマークを保持します（詳細は [Performance benchmarks and limits](../en/PERFORMANCE.md)（英語））：

| コマンド | 用途 |
| --- | --- |
| `node bench/core.mjs` | 列ストレージ・バケット・範囲統計・電力量積分 |
| `node bench/core.mjs --compare` | `bench/baselines/` ベースラインとの複数回比較 |
| `node bench/core.mjs --verify-baseline` | 正確性とスキーマの単回検証（時間計測なし・CI 向け） |
| `npm run bench:memory` | 100 万／500 万点追記とストリーミング CSV インポートのメモリ比較（既定基準 `bench/results/memory-before/`、`-- --baseline <dir>` 指定可、列 SHA-256 一致と列バッファー 20% 以上削減を検証し `bench/results/memory.json` へ出力） |
| `node bench/chart-zoom.mjs` | ホイールズーム／移動フレーム時間と Canvas 2D パイプライン計測 |
| `node bench/phase2.mjs` | 範囲統計・協調スライスの変更前後比較 |
| `node bench/phase3.mjs` | 分割ストレージ・統計・積分の変更前後比較 |
| `node bench/extrema.mjs` | 全件スキャンと極値インデックスの比較 |
| `node bench/startup.mjs` | ネイティブコールドスタート各段階の計測（必要時手動） |
| `node bench/packaging.mjs` | `out/` 配布ファイル集合と参照整合性の検証 |
| `cargo bench -p lapower` | Rust プロトコルデコード・エンコード・選択パス計測 |

## CI チェック

`.github/workflows/ci.yml` は push と PR ごとに固定チェックを実行します：

| Job | 内容 |
| --- | --- |
| `validate` | Linux 依存、フロント構築、JS テスト、typecheck、lint、Rust fmt、Clippy、workspace test、配布構成、基準構造 |
| `backend-other-platforms` | Windows／macOS の workspace test |
| `crate-features` | プロトコル crate の非既定 feature 組み合わせ Clippy・test |
| `package` | バージョンタグ push／手動のみ。4 対象を並列パッケージ化（他対象を中断しない） |
| `package-summary` | 全 4 対象成功後に 8 パッケージ検証と `SHA256SUMS` 生成 |
| `release` | バージョンタグ push のみ。添付検証後に自動公開 |

CI にブラウザーは導入せず UI 行列や長時間収集は実行しません。公開スクリプトの失敗・保護動作は `test/release.test.js` がオフライン検証します。

## Linux でのビルド

Debian／Ubuntu の依存パッケージと手順（Linux 実機は継続的 CI 検証対象外）：

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl file pkg-config libssl-dev libudev-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev patchelf
npm ci
npm run build
npx --no-install tauri build
```

### udev ルール（必須）

Debian／Ubuntu で `/etc/udev/rules.d/99-lapower.rules` を作成し、アクティブなローカルセッションへ WITRN HID と POWER-Z Bulk／CDC シリアルアクセス権を付与します：

```udev
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0716", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0063", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0061", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="5fc9", TAG+="uaccess"
```

`sudo udevadm control --reload-rules` を実行して計器を挿し直してください。非 systemd-logind 環境ではディストリビューションのデバイスグループ規則を使用してください。

## macOS でのビルド

Xcode Command Line Tools、Rust stable、npm で固定した Tauri CLI が必要です：

```bash
npm ci
npm run build
npx --no-install tauri build
```

macOS private API の Cargo feature と `tauri.macos.conf.json` を一致させてください。ビルドは `signingIdentity: "-"`（ad-hoc 署名）と `minimumSystemVersion: "12.0"` を用います（CI は `MACOSX_DEPLOYMENT_TARGET=12.0` と `TAURI_BUNDLER_DMG_IGNORE_CI=false` を設定）。初回起動手順は [README ダウンロードとインストール](../../README.ja.md#-ダウンロードとインストール)を参照し、出荷前に Intel／Apple Silicon Mac（macOS 12 含む）で GUI と実機接続を検証してください。

## 外部温度サービス

laPower は**計器内蔵センサー**または **TCP 接続の外部温度センサー**に対応します（WITRN は HID、POWER-Z は ADC スナップショットを使用）。

### 取得元の選択

`モニター` コマンドバーの `温度サービス` 右側矢印から設定します：

| 項目 | 説明 | 既定 |
| --- | --- | --- |
| `取得元` | `デバイス` = 計器センサー、`外部` = TCP サーバー | `外部` |
| `IP` | サーバーアドレス（`外部` のみ） | `127.0.0.1` |
| `ポート` | サーバーポート（`外部` のみ） | `1573` |

接続／切断は本体ボタンから行い、**接続中は取得元を変更できません**。`デバイス` は計器切断時にフロントエンドで自動リセットされ、`外部` TCP は独立して維持されます。取得値はカード、4 番目の Y 軸、CSV `Temp(°C)` 列に反映されます。

### プロトコルと例

最小限のプレーンテキスト TCP プロトコル（laPower がクライアント接続、ハンドシェイク／ハートビートなし、1 行に摂氏十進数 1 個＋ `\n`、例：`25.125\n`）：

- **接続タイムアウト 5 秒**（IPv4 優先）。
- **送信間隔自由**：250 ms 読み取りタイムアウトで切断せず待機を継続し、TCP 分割による部分行を保持、256 バイト超の行は次の改行まで破棄、サーバー EOF で切断通知します。

依存ライブラリ不要の Python 例を [`temperature-example/network_server.py`](../../temperature-example/network_server.py) と [`temperature-example/network_client.py`](../../temperature-example/network_client.py) に同梱しています：

```bash
python temperature-example/network_server.py
```

独自サーバー最小例（別ホストからは `0.0.0.0` にバインド）：

```python
import socket

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("0.0.0.0", 1573))
server.listen(1)

conn, addr = server.accept()
while True:
    temperature = read_your_sensor()      # float を返す
    conn.sendall(f"{temperature}\n".encode())
```

### トラブルシューティング

- **接続タイムアウト**：IP・ポート・別ホスト時の `0.0.0.0` バインド・ファイアウォールを確認。
- **接続済みだが `--`**：単位や JSON を使わず数値＋改行（LF／CRLF）のみ送信。
- **値の異常ジャンプ**：改行漏れで 256 バイトを超過・破棄されていないか確認。
- **`取得元` を変更できない**：先に本体 `温度サービス` ボタンで切断。

## 貢献方法

1. リポジトリを Fork してブランチを作成します。
2. 変更後に主要な品質チェック（`npm run check:all`）を実行します。
3. フロントエンドの `// @ts-check` を維持し、純粋なデータ処理を DOM／Tauri から分離します。
4. 新機種・ファームウェア追加前に実機サンプルでバイト配置と範囲を確認し、[テストと回帰確認の範囲](#テストと回帰確認の範囲)に従ってください。
