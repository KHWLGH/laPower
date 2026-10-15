[English](../en/DEVELOPMENT.md) | [简体中文](../DEVELOPMENT.md) | [繁體中文](../zh-TW/DEVELOPMENT.md) | **日本語**

← [README](../../README.ja.md) に戻る

# 開発とビルド

- [必要な環境](#必要な環境)
- [ビルドと実行](#ビルドと実行)
- [リリース手順](#リリース手順)
- [品質チェック](#品質チェック)
- [テストと回帰確認の範囲](#テストと回帰確認の範囲)
- [開発用プレビュー](#開発用プレビュー)
- [性能測定](#性能測定)
- [CI チェック](#ci-チェック)
- [Linux でのビルド](#linux-でのビルド)
- [macOS でのビルド](#macos-でのビルド)
- [外部温度サービス](#外部温度サービス)
- [貢献方法](#貢献方法)

## 言語の選択

「設定 → 外観 → 言語」で、システムに従う、简体中文、繁體中文、English、日本語を選択できます。変更は即座に反映・保存され、接続、記録、データ、グラフ範囲、フィルター、選択中のメッセージを保持します。設定をリセットすると自動選択に戻ります。

Linux では LC_ALL → LC_MESSAGES → LANG の順で最初の空でない値を使用し、Windows／macOS ではネイティブのシステム locale を取得します。取得できない場合は WebView の優先言語を使い、最終的に英語へフォールバックします。地域よりも文字体系を優先し、Hans は簡体字、Hant は繁体字を選びます。それ以外では CN／SG と地域なしの zh は簡体字、TW／HK／MO は繁体字、ja は日本語、それ以外（C／POSIX を含む）は英語になります。大文字小文字、アンダースコア、文字コード・修飾子の接尾辞を正規化します。手動選択は自動検出より優先されます。

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
```

## 辞書の保守と翻訳チェック

`src/i18n.js` は `t(key, params)`、locale 解析、言語変更の購読を提供します。4 辞書をオフラインで同梱し、英語を基準と欠落時のフォールバックに使います。`src/i18n-messages.js` の 4 列は英語、簡体字、繁体字、日本語の順です。意味に基づくキーと共通の補間パラメーター名を使い、件数のあるメッセージには必要に応じて単数形を追加します。利用者向け文書は簡体字版を内容の基準にし、翻訳は人が校正します。

静的 HTML は英語のフォールバックと `data-i18n`／`data-i18n-title`／`data-i18n-placeholder`／`data-i18n-aria-label`／`data-i18n-alt` を使います。アイコンや入力欄を含む要素は文字の span だけを指定します。動的表示は `t`、継続表示する通知・ログは遅延文字列関数を使います。切り替えではラベル・メニュー・選択欄・グラフだけを更新し、再接続やデータの再構築をしません。

アプリのバックエンドエラーは `{code, params, detail?}` を使い、非同期イベントは既存フィールドに `description` を追加します。フロントエンドで code を翻訳し、生の診断情報を保持します。プラグインの文字列エラーにも対応します。ファイルダイアログのタイトル・フィルターは翻訳し、ネイティブボタンは OS に従います。PD 標準名、デコードフィールド、生の応答、単位、CSV／PD のデータ形式は互換性を保持します。

```bash
node --test test/i18n.test.js test/settings-persistence.test.js
node tools/showcase/verify-i18n.mjs
npm run showcase:capture -- --language zh-CN,zh-TW,en,ja
```

4 言語、両テーマ、900×600／1280×800、接続・記録／PDM 状態、PD 選択・フィルター、CSV／PD 往復、エラー、ファイル選択、アクセシビリティラベルを確認します。Linux AppImage の LANG／LC_* 別起動は Linux 実機で行います。ブラウザーの模擬動作はネイティブ・ハードウェア検証の代わりにはなりません。

模擬デバイスとブラウザーのチェックは、Linux AppImage、macOS GUI、ネイティブファイルダイアログ、実機計器の検証を代替しません。対応する環境でシステム言語、言語設定の保存、記録／PDM、ダイアログ、CSV／PD の往復を必要に応じて確認します。過去の検証結果は現在のビルドの保証ではありません。

## 必要な環境

| 項目 | 要件 | 補足 |
| --- | --- | --- |
| Rust | 1.85+ | ワークスペースの `rust-version` |
| Tauri CLI | 2.12.1 | npm で固定した `@tauri-apps/cli` を `npx --no-install tauri` で実行 |
| Windows | 10 / 11 | 現在の開発・検証環境 |
| macOS | 12+ | 最低デプロイ対象。CI は macOS 26、旧 OS 互換性は実機確認が必要 |
| Node.js | 24 | CI、lint／typecheck／test、フロントエンド生成 |

npm を使用し `package-lock.json` を管理し、CI は `npm ci` を使います。フロントエンドは標準 ES Modules で、`frontendDist` は生成した `out/` を参照します。Node は Rust コンパイルには参加しませんが、`cargo build`、`cargo test`、`cargo check`、`cargo clippy` より先に `npm run build` が必要です。`src/` 変更後は `out/` を再生成してから Rust バイナリを再リンクします。

## ビルドと実行

```bash
git clone https://github.com/KHWLGH/laPower.git
cd laPower
npm ci
npm run build
npx --no-install tauri dev
npx --no-install tauri build
```

ローカルで target を指定しなければ配布物は `target/release/bundle/`、CI は明示指定して `target/<target>/release/bundle/` に生成します。Tauri CLI が `beforeBuildCommand` で圧縮済みフロントエンドを生成するため、パッケージ化前の手動 `npm run build:dist` は不要です。Cargo を直接実行する場合は先に `out/` が必要です。

## リリース手順

開発中は `changelog/unreleased/zh-CN.md` だけを編集します。リリース前に開発アシスタントで重複をまとめ、利用者向けの簡体字中国語の説明を整理し、`en.md` を生成して両言語を手動で校正します。変更履歴は英語と簡体字中国語のみです。文や項目の厳密な一対一対応は要求せず、翻訳 API は使いません。

```bash
npm run release:prepare -- 0.2.4 --date 2026-10-13 --dry-run
npm run release:prepare -- 0.2.4 --date 2026-10-13
npm run release:notes
```

例のバージョンと日付を実際の値に置き換えます。準備コマンドは両言語のファイルと空でない本文を確認し、既存のバージョンディレクトリは上書きしません。`changelog/<version>/` へ保存し、製品バージョンとルートの索引を更新して `dist/release-notes.md` を生成します。完了後にだけ草稿を空にします。`--dry-run` は計画とプレビューを表示し、ファイルを書きません。失敗時は草稿を保持します。エラーと `git diff` を確認して修正し、部分的に生成されたファイルがあれば手動で整理してから再試行します。

Release は英語を展開し、簡体字中国語を折りたたみます。両言語にインストール案内を含め、プレビューと公開で同じ描画処理を使います。`GITHUB_REPOSITORY` を優先し、ローカルで未設定なら `origin` から取得します。コミット、タグ作成・push、Release 公開は行いません。プレビューと品質チェックを確認後、コミットして新しいタグを push します。

### 文書の保守範囲

README、使用ガイド、開発とビルドは英語・簡体字中国語・繁体字中国語・日本語で保守します。アーキテクチャ、性能、プロトコル crate の README、変更履歴は英語と簡体字中国語のみです。外部温度サービスは本ガイドに統合します。主要文書は同言語へリンクし、副次文書は繁体字ページから簡体字、日本語ページから英語へリンクして言語を明記します。翻訳ハッシュ、項目対応チェック、文書専用 CI は追加しません。

### 変更履歴へのリンク

各バージョンの本文は `changelog/<version>/` に保存し、ルートの `CHANGELOG.md` はバージョン索引として元の見出しアンカーを維持します。全履歴は索引へ、特定バージョンは対応する言語ファイルへ直接リンクします。0.2.2 以前は `zh-CN.md` のみで、英語の仮ページは作りません。相対リンクは文書のディレクトリを基準にし、中国語なら `../../docs/USAGE.md`、英語なら `../../docs/en/USAGE.md` を使います。GitHub Release では該当バージョンのタグへ固定します。

### バージョンだけを設定する

リリースノートを保存せずバージョンだけを同期する場合、既存コマンドを使えます：

```bash
npm run version:set -- 0.2.4
```

`0.2.4` を対象バージョンに置き換えます。先頭ゼロのない `X.Y.Z` を受け付け、全ファイル検証後に次の箇所を同期します。同じバージョンを再設定しても再書き込みせず、コミット・タグ作成、依存関係更新、変更履歴編集はしません。

| ファイル | フィールド |
| --- | --- |
| `package.json` | `version` |
| `package-lock.json` | 最上位とルートパッケージの `version` |
| `Cargo.toml` | `[workspace.package] version` |
| `Cargo.lock` | 全ワークスペースメンバーの `version` |
| `src-tauri/tauri.conf.json` | `version` |

Rust メンバーは `version.workspace = true` で継承します。「このアプリについて」は Tauri、開発用プレビューは `package.json` から取得します。実行ファイルとインストーラーへ反映するには再ビルドします。

`test/version-sync.test.js` はマニフェスト・ロックの整合、セマンティックバージョン、workspace 継承、共通更新コマンド、macOS private API 設定を検証します。

### 手動ビルドと初回検証

workflow を既定ブランチへ反映した後、GitHub の **Actions → CI → Run workflow** でブランチ・タグを選びます。既存品質チェックの後に 4 対象をパッケージ化します。バージョンタグを選んでも Release は作成・公開しません。

| 対象 | Runner | Rust target | パッケージ |
| --- | --- | --- | --- |
| Windows x64 | `windows-2022` | `x86_64-pc-windows-msvc` | MSI、NSIS EXE |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | DEB、RPM、AppImage |
| macOS Intel | `macos-26-intel` | `x86_64-apple-darwin` | DMG |
| macOS Apple Silicon | `macos-26` | `aarch64-apple-darwin` | DMG |

成功した対象ごとに `packages-*` アーティファクトを 14 日間保持します。全対象成功後の `release-packages` は 7 個のインストーラーと `SHA256SUMS` を含み、展開先で `sha256sum -c SHA256SUMS` を実行して確認できます。名前にはバージョン・OS・アーキテクチャ、NSIS EXE には `_setup` も含まれます。

タグ自動公開を初めて使う前に手動ビルドし、Windows インストール、両 Mac の起動、Linux インストールと udev 設定後の接続を確認します。macOS 12 は別途実機検証が必要です。CI は Mac のアーキテクチャ、ad-hoc 署名、最低 OS メタデータ、DMG 完全性を調べますが、GUI・計器接続は実行しません。

macOS は明示的に `--bundles app,dmg` を使います。DMG のみでは Tauri が一時 `.app` を削除するため、APP も指定して後続検証用に残します。配布アーティファクトは DMG のみで、APP は追加公開しません。

### バージョンタグによる自動公開

初回検証後、バージョン・変更履歴を更新し、品質チェックとコミットを済ませ、マニフェストに一致するタグを push します。

```bash
git tag v0.2.4
git push origin v0.2.4
```

タグは `vX.Y.Z` とし、マニフェストと一致しなければパッケージ化前に失敗します。CI は Node.js 24、Rust stable、Tauri CLI 2.12.1、`tauri-apps/tauri-action@v1` を使います。npm は `npm ci`、Cargo は `--locked`、Rust キャッシュは対象別でルート `target/` を参照します。Linux は新しい glibc への依存を抑えるため Ubuntu 22.04 に固定します。

全チェックと 4 対象のビルド成功後、7 個のパッケージを集めてチェックサムを生成します。公開 job は実行リポジトリの `GITHUB_TOKEN` で一時ドラフトを作成し、7 個とチェックサムをアップロードし、リモートの数・サイズ・SHA-256 を照合して自動公開します。手動 Publish や追加 PAT は不要です。この job だけ `contents: write` を持ち、組織ポリシーで許可が必要です。

`scripts/release.mjs` はルートの長い履歴ではなく、現在のバージョンディレクトリから英語と簡体字中国語の Markdown を読みます。タグのパッケージ化前と公開前で同じ読み込み処理を使い、両ファイルと空でない本文だけを確認します。相対リンクはそのバージョンのタグへ固定し、GitHub の自動コミット／PR 要約は使いません。`npm run release:notes` は元の文書を変更せずローカルプレビューを再生成します。

同じ ref の実行は直列化し、アップロード中の公開を中止しません。失敗時はドラフトを保持し、Actions の失敗 job 再実行で再利用・同名添付の置換を行います。別の添付があるドラフトは人が確認してから再実行します。同名 Release が公開済みなら自動上書きを拒否します。公開バイナリの変更には新しいバージョン・タグを使います。

Windows に証明書署名はなく、macOS は Developer ID・公証なしの ad-hoc 署名、Linux は udev を自動設定しません。自動更新、Windows／Linux ARM64、Mac Universal はこの手順の対象外です。

## 品質チェック

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

`npm test` は Node 標準ランナーを使い、純粋ロジック、データ処理、プロトコル・ファイル契約、セキュリティ、バージョン同期を確認します。主要テストは分野ごとに整理しています。

```text
chart-buckets  chart-columns  chart-extrema  chart-window
csv-codec     csv-import     device-stream  ingest
measurement   pd-capture-file  pd-model      range-stats
recording     recording-spool  security-csp  settings-persistence
version-sync  bench-gate
```

Rust workspace テスト、フォーマット、Clippy、プロトコル crate の feature 組み合わせを継続します。`usbpd-parser`／`witrn-hid` の feature 境界を変更したら、CI と同じ組み合わせを追加実行します。

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

- 通常の機能追加・削除・名称変更、UI レイアウト・スタイル・文言・選択肢変更では、原則として回帰テストを追加しません。
- データ損失・破損、プロトコル互換、クラッシュ・デッドロック、セキュリティ、リリースビルドの不変条件、確認済みの重大な過去の不具合に限って追加します。
- 既存の主要テストを優先し、小機能ごとにテストファイル・設計資料・CI job を作りません。
- ベンチマークと実機確認は必要時に手動で行い、毎回のブラウザー自動回帰にはしません。
- CI の主要チェック集合を固定し、機能ごとの専用回帰 workflow を増やしません。

## 開発用プレビュー

長時間記録のメモリー比較は `npm run bench:memory` を使います。既定では `bench/results/memory-before/` 内の変更前 `state.js`、`csv-codec.js`、`csv-import-core.js`、`measurement.js` と現在のソースを比較し、`-- --baseline <ディレクトリ>` でも指定できます。100 万／500 万点の連続追加、エクスポートスナップショット保持中の追加、ストリーミング CSV インポート、繰り返しクリアを検証します。列ごとの SHA-256 が一致し、列バッファーを少なくとも 20% 削減する必要があります。`bench/results/memory.json` は固有の列バッファー、Node RSS のサンプルピーク、OS のピークを区別し、Tauri／WebView2 全体のプロセスツリーの測定ではありません。

`tools/showcase/` は独立したブラウザー開発ツールです。仮想 WITRN K2／POWER-Z KM003C、決定的な測定曲線、PD メッセージ、制御結果を提供し、アプリの既存取り込み・描画処理を通します。タイトルバーは decorum と同じ構造の操作部とアプリ自身のアイコン・スタイルを使い、ウィンドウ動作を模擬します。実機には接続せず、`src/`、`out/`、インストーラーに含めず、ブラウザー CI に追加しません。

初回準備：

```bash
npm ci
npx playwright install chromium
```

対話プレビューと全画像の生成：

```bash
npm run showcase:dev
npm run showcase:capture
```

既定の URL は `http://127.0.0.1:4173`、テーマはライトです。独立アプリ表示では `/app/?theme=dark`／`/app/?theme=system` を指定できます。タイトルバーで仮想デバイスの選択・接続・切断、記録ボタンで開始・一時停止を操作できます。外側の開発ツールには 120 秒のデータ投入、凍結、シミュレーション再開、10 秒進める、リセットがあります。データ投入は選択計器とデバイス温度を接続して記録を始めます。プロトコル制御は POWER-Z 接続後に PDM を開きます。ポートは `npm run showcase:dev -- --port 4174` で変更でき、ローカルのみ待ち受けます。

キャプチャは Chromium、Windows スタイル、1280×800 CSS ビューポート、2 倍ピクセル密度、100% UI 倍率を使い、2560×1600 PNG を作成します。既定で POWER-Z、デバイス温度、共通の 120 秒データを使い、仮想時間を止めてからグラフ・詳細・フォント・操作部の描画完了を待ちます。`docs/screenshots/<language>/{dark,light}-{record,pd,trigger,settings}.png` に言語ごと 8 枚、合計 32 枚を出力します。

「このアプリについて」のバージョンは package.json から取得し、撮影時にバージョン、言語、画面のはみ出しを検証します。画像は言語別のサブディレクトリにのみ保存し、スクリーンショットのルートには重複コピーを作成しません。

ページ・テーマ・出力先を限定する場合：

```bash
npm run showcase:capture -- --theme light --page pd,trigger --output output/showcase
npm run showcase:capture -- --help
```

`--language` は zh-CN、zh-TW、en、ja（カンマ区切り、既定は全部）、`--theme` は `light,dark`（既定でこの順）、`--page` は `record,pd,trigger,settings` に対応します。出力先はリポジトリルートからの相対パス、または絶対パスです。`tools/showcase/scenario.js` でデバイス情報、乱数シード、充電曲線、ハンドシェイク時刻、PDO・検出結果を変更できます。`bridge.js` は Tauri コマンド・イベント、記録区間、ACK、メモリー設定、ファイルハンドルを実装し、未実装呼び出しは明示的に失敗します。CSV／PD はブラウザーダウンロードで保存し、CSV はファイル選択で読み込みます。PD は固定サンプルの生メッセージを含むファイルのみ読み込め、任意の実機デコードにはネイティブアプリを使います。

`pd-fixtures.json` は既存 `witrn-hid` Rust パーサーで生成した生データとデコードツリーです。通常のプレビュー・撮影では Rust ビルドは不要です。生サンプルを変えたら Rust 環境で `node tools/showcase/generate-pd.mjs` を実行します。一時ジェネレーターは無視対象の `output/`、コンパイル結果は `target/` に置きます。

ブラウザーはメモリー設定・ファイルを使い、実アプリのデータ領域を読み書きしません。新識別子 `io.github.khwlgh.lapower` は起動測定ツールにも反映されています。旧 WITRN-RS 設定は自動移行しません。

## 性能測定

`bench/` はアルゴリズム、ストレージ、起動、極値、配布構成のチェックを保持します。ブラウザー harness・長時間実行・実機検証はここから削除しています。

| コマンド | 用途 |
| --- | --- |
| `node bench/core.mjs` | 列形式ストレージ、バケット、統計、電力量積分 |
| `node bench/core.mjs --compare` | ベースライン比較。複数回の結果とホスト状態を考慮 |
| `node bench/core.mjs --verify-baseline` | 正しさと基準構造の単回確認。ウォームアップ・計時なし |
| `node bench/phase2.mjs` | 範囲統計と協調分割の変更前後比較 |
| `node bench/phase3.mjs` | 分割ストレージ、統計、電力量計算の変更前後比較 |
| `node bench/extrema.mjs` | スキャンと極値インデックスの比較 |
| `node bench/startup.mjs` | ネイティブコールドスタートの各段階。必要時に手動 |
| `node bench/packaging.mjs` | `out/` の配布ファイルと埋め込み集合 |
| `cargo bench -p lapower` | Rust のデコード、エンコード、選択処理 |

`perf-shape` CI は配布構成と基準構造だけを必須判定にします。アルゴリズム・Rust ベンチマークは結果を報告し、単回の時間をホスト間の合否条件にはしません。

## CI チェック

`.github/workflows/ci.yml` は push／PR ごとに固定の主要チェックを実行します。

| Job | 内容 |
| --- | --- |
| `validate` | Linux 依存関係、フロントエンドビルド、JS テスト、typecheck、lint、Rust fmt、Clippy、workspace test |
| `backend-other-platforms` | Windows workspace test、macOS workspace test |
| `crate-features` | 非既定 feature 組み合わせの Clippy・test |
| `perf-shape` | `bench/packaging.mjs`、`core.mjs --verify-baseline`、報告型 benchmark |
| `package` | バージョンタグ push／手動のみ。先の 4 チェックに依存し、4 対象を並列化、1 対象の失敗で他を中止しません |
| `package-summary` | 全対象成功後、7 パッケージを検証し `SHA256SUMS` を生成 |
| `release` | バージョンタグ push のみ。添付をアップロード・照合して自動公開 |

通常ブランチ push／PR はチェックのみで、パッケージ化・公開はしません。CI はブラウザー検証、実機長時間テスト、機能表面の回帰を実行しません。開発プレビューは必要時の確認と文書画像生成用であり、ブラウザー検証・CI の合否判定は担いません。新機能に専用 workflow、job、harness を付け足さないでください。公開スクリプトの失敗・再実行・添付完全性・公開済み保護は `test/release.test.js` がオフライン検証します。

## Linux でのビルド

Linux のビルド・実行は継続的な実機検証に接続していません。Debian／Ubuntu の依存関係：

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl file pkg-config libssl-dev libudev-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev patchelf
npm ci
npm run build
npx --no-install tauri build
```

WITRN HID にはディストリビューションに応じた `/dev/hidraw*` の udev ルールが必要です。

### udev ルール（必須）

Debian／Ubuntu では `/etc/udev/rules.d/99-lapower.rules` を作成し、現在のデスクトップユーザーに WITRN HID と POWER-Z のアクセスを許可できます。

```udev
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0716", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0063", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0061", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="5fc9", TAG+="uaccess"
```

`sudo udevadm control --reload-rules` を実行し、計器を挿し直して起動します。`uaccess` は systemd-logind のアクティブなローカルセッションに依存します。他ディストリビューションやデスクトップなし環境では、その環境のデバイスアクセス用グループルールを使用してください。POWER-Z 制御は CDC シリアルポートへのアクセスも必要です。

## macOS でのビルド

Xcode Command Line Tools、Rust stable、npm で固定した Tauri CLI が必要です。

```bash
npm ci
npm run build
npx --no-install tauri build
```

macOS private API の Cargo feature と Tauri 設定を一致させます。プラットフォーム設定は `signingIdentity: "-"`、`minimumSystemVersion: "12.0"`、CI は `MACOSX_DEPLOYMENT_TARGET=12.0` で旧 OS 対象を保持し、`CI=true`、`TAURI_BUNDLER_DMG_IGNORE_CI=false` で Finder 装飾を省略します。Developer ID・Apple 公証はありません。初回起動は [README のインストール](../../README.ja.md#-ダウンロードとインストール)を参照してください。

通常 macOS CI は workspace test、タグ・手動ビルドは DMG 生成・検証も行います。GUI・実機テストは実行しません。

CI のネイティブビルド検証は GUI やハードウェアの検証完了を意味しません。出荷前に Intel／Apple Silicon Mac で起動、ウィンドウと設定、ファイルダイアログ、記録、実機接続を確認し、macOS 12 は別途検証します。旧 WITRN-RS の一度限りのビルド報告は Git 履歴に残し、現在の laPower 手順として使いません。

## 外部温度サービス

温度は**計器内蔵センサー**と **TCP 接続の外部センサー**から取得できます。WITRN は HID レポート、POWER-Z は ADC スナップショットを使います。外部熱電対、赤外線モジュールなどの値を電圧・電流とともに記録・描画・エクスポートできます。

### 取得元の選択

`モニター` のコマンドバーで `温度サービス` 横の歯車をクリックし、設定フライアウトを開きます。

| 項目 | 説明 | 既定 |
| --- | --- | --- |
| `取得元` | `デバイス` = 計器温度、`外部` = TCP サービス | `外部` |
| `IP` | サーバーアドレス（外部のみ） | `127.0.0.1` |
| `ポート` | サーバーポート（外部のみ） | `1573` |

接続・切断はフライアウトではなく、コマンドバーの `温度サービス` ボタンで操作します。**接続中は取得元を変更できません**。先に切断してください。

`デバイス` は外部プログラムなしで計器の温度フィールドを使います。一部モデルのみで検証しており、信頼できない値は欠損として扱い、`--` と表示します。

`デバイス` の取得元は計器と同じライフサイクルです。切断・抜去で解除し、値を `--` に戻し、`温度サービス` をリセットして `取得元` を変更可能にします。バックエンドの `temp-disconnected` は TCP のみで、デバイス温度には閉じるセッションがないため、計器の接続状態変更をフロントエンドで処理します。記録済み温度曲線と温度データ有りのフラグは維持し、現在値だけを消去します。`外部` の TCP は HID と独立し、計器を抜いても切断しません。

接続後はカードに現在値と `平均`／`最低`／`最高`、グラフに第 4 の Y 軸として表示します。`CSV をエクスポート` → `温度あり` で `Temp(°C)` に保存できます。

### プロトコル

意図的に最小限の形式にしており、どの言語でも数行でサーバーを作れます。

- **転送：** TCP。サーバーが待ち受け、laPower がクライアントとして接続します。
- **形式：** 1 行に純粋な十進数を 1 個、末尾は `\n`。単位は摂氏です。
- **ハンドシェイク、ハートビート、フレームヘッダーはありません。**

```
25.125\n
25.250\n
24.875\n
```

#### 詳細な動作

- **接続タイムアウトは 5 秒。** アドレスを完全に解決し、IPv4、IPv6 の順で試します。
- **送信間隔は自由。** 250 ms の読み取りタイムアウトを繰り返し、タイムアウトで切断せず待機を続けます。**10 秒を超える間隔も可能**で、アイドル中も接続を維持します。
- **部分行を保持。** タイムアウトで途中のデータが返っても、完全な行の処理後にバッファを消去するため、TCP 分割による不正値を防ぎます。
- **256 バイトを超える行は破棄**し、改行のないストリームによるバッファ増大を防ぎます。
- **サーバーが切断（EOF）**するとアプリへ通知し、接続状態を更新します。

### サーバー例

第三者ライブラリ不要の Python 例を 2 つ同梱しています。

| ファイル | 用途 |
| --- | --- |
| [`temperature-example/network_server.py`](../../temperature-example/network_server.py) | 0–100 の乱数温度を 1 秒ごとに送信 |
| [`temperature-example/network_client.py`](../../temperature-example/network_client.py) | サーバーを単独で確認するクライアント |

サーバーの起動（コンソール出力は簡体字中国語）：

```bash
python temperature-example/network_server.py
```

```
温度服务器启动，监听 127.0.0.1:1573
等待客户端连接...
```

アプリで `取得元` を `外部` にし、既定の `127.0.0.1:1573` のまま `温度サービス` で接続します。

#### 独自サーバーの実装

例を実センサー読み取りへ置き換えます。中心となる処理は次だけです。

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

別マシンのサーバーは `0.0.0.0` にバインドし、アプリに実際の IP を入力してください。

### トラブルシューティング

**接続タイムアウト** — IP・ポートを確認します。別マシンでは `127.0.0.1` ではなく `0.0.0.0` にバインドし、ファイアウォールで許可します。

**接続済みだが温度が `--`** — 数値と改行だけを送ります。単位（`25.1°C`）、JSON、改行なしの区切りは無効です。LF、CRLF は両方使用できます。

**値が飛ぶ・明らかに異常** — 改行なしで複数の値を同じ行に詰めていないか確認します。256 バイト超の行は全体を破棄します。

**`取得元` を変更できない** — 接続中はロックします。温度サービスを先に切断してください。

## 貢献方法

1. Fork してブランチを作成します。
2. 変更後に上記の主要品質チェックを実行します。
3. フロントエンドの `// @ts-check` を保ち、純粋ロジックは直接テストできるモジュールへ分離します。
4. モデル・ファームウェア追加前に、実機サンプルで HID バイト構造と測定範囲を確認します。

テスト追加は「テストと回帰確認の範囲」に従い、通常の UI・機能表面変更のために独立テスト・設計資料・CI job を追加しません。
