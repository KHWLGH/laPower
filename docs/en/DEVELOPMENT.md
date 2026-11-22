**English** | [简体中文](../DEVELOPMENT.md) | [繁體中文](../zh-TW/DEVELOPMENT.md) | [日本語](../ja/DEVELOPMENT.md)

← Back to [README](../../README.md)

# Development and build

- [Requirements](#requirements)
- [Build and run](#build-and-run)
- [Release process](#release-process)
- [Quality checks](#quality-checks)
- [Testing and regression boundaries](#testing-and-regression-boundaries)
- [Language selection](#language-selection)
- [Dictionary maintenance and translation checks](#dictionary-maintenance-and-translation-checks)
- [Headless testing API](#headless-testing-api)
- [Development showcase](#development-showcase)
- [Performance measurements](#performance-measurements)
- [CI gates](#ci-gates)
- [Building on Linux](#building-on-linux)
- [Building on macOS](#building-on-macos)
- [External temperature service](#external-temperature-service)
- [Contributing](#contributing)

## Requirements

| Component | Requirement | Notes |
| --- | --- | --- |
| Rust | 1.85+ | Workspace `rust-version` |
| Tauri CLI | 2.12.1 | npm-locked `@tauri-apps/cli`, invoked via `npx --no-install tauri` |
| Windows | 10 / 11 | Primary development and verification platform |
| macOS | 12+ | Minimum deployment target; CI runs on macOS 26 (older systems require hardware verification) |
| Node.js | 24 | CI, lint/typecheck/test, and frontend output |

The project uses npm with a committed `package-lock.json` (`npm ci` in CI). The frontend is plain ES Modules, and `frontendDist` points to generated `out/`. Although Node does not compile Rust, `npm run build` must run before `cargo build`, `cargo test`, `cargo check`, and `cargo clippy`; rebuild `out/` after changing `src/` before relinking the Rust binary.

## Build and run

```bash
git clone https://github.com/KHWLGH/laPower.git
cd laPower
npm ci
npm run dev
```

| Command | Purpose |
| --- | --- |
| `npm run dev` | Generate the development frontend automatically and launch the native app |
| `npm run dev:web` | Launch the simulated-device browser preview (pass `-- --port 4174` to override port) |
| `npm run build` | Generate `out/` for Cargo embedding without bundling |
| `npm run build:app` | Generate the minified release frontend and build local installers |

`beforeDevCommand` and `beforeBuildCommand` run the appropriate frontend build automatically, so manual `npm run build` / `npm run build:dist` is unnecessary beforehand; direct Cargo commands still require `out/`. Development mode embeds assets without frontend hot reload—restart `dev` or relink after editing `src/`. Local release bundles go to `target/release/bundle/`, while CI places them under `target/<target>/release/bundle/`.

### Antivirus blocking Windows build scripts

If Cargo fails before running libc's `build-script-build` with `os error 5` / `os error 32` and your antivirus flags that path, the affected executable runs only at compile time, not in the shipped application. On Windows/MSVC with Kaspersky, `libc 0.2.189`'s build script triggered a block at `opt-level = 2` and succeeded at `0`.

The root `Cargo.toml` sets `[profile.dev.package.libc] opt-level = 0` (covering both dev and test while leaving release and other dependencies unchanged; `profile.dev.build-override` cannot override `package."*"`). Rerun the build command directly without wiping `target/`. If still blocked, capture the detection name, path, and file hash for investigation.

### Cleanup levels

Each level includes the previous one and waits for completion while preserving Rust caches, dependencies, and installers by default:

| Command | Removes |
| --- | --- |
| `npm run clean` | `out/`, `output/`, `bench/results/`, `.playwright-cli/` (root and `src/`), and `src-tauri/gen/schemas/` |
| `npm run clean:incremental` | Plus `debug/release` incremental caches in `target/` and `src-tauri/target/` (including cross-targets) |
| `npm run clean:build` | Plus all of `target/`, `src-tauri/target/`, and `dist/` |
| `npm run clean:all` | Plus `node_modules/` (run `npm ci` before resuming work) |

Preview targets without deleting:

```bash
npm run clean:build -- --dry-run
```

The cleaner validates every path and Git tracking status before deleting, refusing symlinks or junctions on targets or ancestors. It runs up to 4 directories in parallel, retries transient busy-file locks, and exits nonzero on remaining failures. Close running dev/build/preview processes first; tracked screenshots, `bench/baselines/`, sources, lockfiles, and external caches (including custom `CARGO_TARGET_DIR`) are left untouched.

### Runtime component list

About uses the bundled `src/third-party-components.json` catalog and loads full texts on demand from `src/legal-notices.json`. After changing Cargo runtime dependencies, bundled assets, or license inputs, run `npm run components:generate`, commit both generated files and any needed materials, then verify with `npm run components:check` (never edit generated catalogs by hand).

The generator runs offline `--locked` Cargo metadata/tree queries across all four desktop targets and merges normal dependencies conservatively (excluding workspace, dev/build-only, and proc-macro crates; run `cargo fetch --locked` beforehand if the local Cargo cache is empty). Full texts come from [`COPYRIGHT`](../../COPYRIGHT), [`LICENSE`](../../LICENSE), [`LICENSE.LGPL-3.0`](../../LICENSE.LGPL-3.0), the local Cargo cache, and stored supplements in `licenses/materials.json` (pinned by version, revision, upstream path, and SHA-256; only explicitly reviewed versioned exceptions bypass missing upstream texts). Normal frontend builds validate and copy generated files without Cargo or network access.

Release tag source archives exclude local dependency caches and SDKs; obtain locked sources via `cargo fetch --locked` and `npm ci` when building from an archive. Project copyright lines remain fixed to `Copyright (C) 2026 KHWLGH` for own contributions without inferring assignment from Git authorship; see [`COPYRIGHT`](../../COPYRIGHT) for exact scope.

## Release process

During development, update `changelog/unreleased/zh-CN.md` only. Before releasing, consolidate user-facing Simplified Chinese notes and prepare/proofread `en.md` (item-by-item parity is not required; never use translation APIs).

```bash
npm run release:prepare -- 0.3.0 --date 2026-11-22 --dry-run
npm run release:prepare -- 0.3.0 --date 2026-11-22
npm run release:notes
npm run showcase:capture
```

Replace the version and date with target values. `release:prepare` validates non-empty bilingual drafts and refuses existing version directories, then archives to `changelog/<version>/`, syncs versions, updates `CHANGELOG.md`, writes `dist/release-notes.md`, and clears the drafts only upon success (`--dry-run` previews without writing; failures leave drafts intact). Release notes expand English and collapse Simplified Chinese with platform install notes; commands never commit, tag, or publish automatically.

### Refresh documentation screenshots before release

Follow this order before every release: **sync versions & archive notes → capture & inspect screenshots → run quality checks → commit changes → push version tag → let GitHub Actions build and publish** (no local installer prebuilds needed; rerun `npm run showcase:capture` directly if the version is already archived).

Run `npx playwright install chromium` once (`--with-deps` on Linux if browser libraries are missing). Capture generates **72 PNGs** by default (40 main UI + 32 report samples) under `docs/screenshots/<language>/`:

- **32 required base screenshots**: 4 languages × light/dark × Monitor, PD analysis, Protocol control, and Settings (full title bar, unified 120 s simulated data, current manifest version).
- **40 additional samples**: 8 Protocol detection screenshots + 32 rendered report samples (16:9 PNG, long PNG, video frame, and protocol report).

Inspect every image for clipping, layout, language, theme, charts, protocol state, and version alignment, then update all four READMEs before committing the full set.

### Documentation maintenance

README, User guide, and Development and build are maintained in English, Simplified Chinese, Traditional Chinese, and Japanese. Architecture, Performance, protocol-crate READMEs, and changelogs are bilingual English/Simplified Chinese (v0.2.2 and earlier keep Simplified Chinese only). Main docs link to their own language where available; Traditional Chinese links secondary docs to Simplified Chinese, and Japanese links them to English with a language note. Do not add translation hashes or doc-only CI jobs.

### Changelog links

Release notes live in `changelog/<version>/`; `CHANGELOG.md` is an index preserving original heading anchors. Resolve relative links from the note file (e.g., `../../docs/en/USAGE.md`); GitHub Release rendering pins them to the release tag.

### Setting the version separately

To synchronize product versions without archiving notes:

```bash
npm run version:set -- 0.3.0
```

Validates `X.Y.Z` without leading zeros and atomically updates `package.json`, `package-lock.json`, `Cargo.toml` (`[workspace.package] version`), `Cargo.lock`, and `src-tauri/tauri.conf.json` (Rust member crates inherit via `version.workspace = true`; repeating the current version is a no-op without creating commits or tags). `test/version-sync.test.js` verifies consistency.

### Manual builds and initial acceptance

Trigger **Actions → CI → Run workflow** on any branch or tag to run checks and package all four targets without creating or publishing a Release:

| Platform | Runner | Rust target | Installers |
| --- | --- | --- | --- |
| Windows x64 | `windows-2022` | `x86_64-pc-windows-msvc` | MSI, NSIS EXE (`_setup`), Portable ZIP |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | DEB, RPM, AppImage |
| macOS Intel | `macos-26-intel` | `x86_64-apple-darwin` | DMG |
| macOS Apple Silicon | `macos-26` | `aarch64-apple-darwin` | DMG |

When all four targets pass, `release-packages` collects all eight packages and `SHA256SUMS` (`sha256sum -c SHA256SUMS`). The Windows portable archive (`laPower_<version>_windows-x64_portable.zip`) runs `laPower.exe` directly when WebView2 Runtime is installed and uses standard user data directories. macOS uses `--bundles app,dmg` so `.app` stays available for signature/metadata validation (only DMG is published). Verify Windows, both Mac architectures (including macOS 12), and Linux with udev rules on real hardware before enabling tag releases.

### Automatic release on a version tag

After verification and committing release updates, push a tag matching the manifests (`vX.Y.Z`):

```bash
git tag v0.3.0
git push origin v0.3.0
```

CI uses Node.js 24, Rust stable, Tauri CLI 2.12.1, and `tauri-apps/tauri-action@v1` (staying on Ubuntu 22.04 for broader glibc compatibility). Once checks and all four builds succeed, the `release` job uses `GITHUB_TOKEN` (`contents: write`) to create a draft Release, upload the eight packages and `SHA256SUMS`, verify counts/sizes/SHA-256 checksums, and publish automatically. Runs on the same ref serialize without cancelling active uploads; failed uploads retain the draft for rerun replacement, while already-public Releases are never overwritten. Windows installers are unsigned, macOS uses ad-hoc signing, and Linux packages do not configure udev permissions.

## Quality checks

Pick the check matching your scope (all stop on first failure):

| Command | When to use |
| --- | --- |
| `npm run check` | Daily frontend checks (`npm test`, `typecheck`, `lint` without building `out/`) |
| `npm run check:rust` | Rust checks (builds `out/` once, then runs `cargo fmt`, workspace Clippy, and tests) |
| `npm run check:all` | Full pre-delivery verification (both groups plus `components:check` with one frontend build) |

`npm test` discovers `test/*.test.js` only (run individual files with `node --test test/name.test.js`); Biome skips output, dependencies, and `.local-*` directories. Core tests cover pure logic, data pipelines, protocol/file contracts, security boundaries, and release invariants:

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

When touching feature gates in `usbpd-parser` or `witrn-hid`, also run the CI non-default feature matrix:

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

## Testing and regression boundaries

- Ordinary feature additions/removals/renames and UI layout, style, wording, or option changes do not require new regression tests.
- Add tests only for data loss/corruption, protocol compatibility, crashes/deadlocks, security boundaries, release-build invariants, or confirmed high-impact regressions.
- Extend existing core test files rather than creating new test files, design docs, or CI jobs per small feature.
- Run performance benchmarks and real-device acceptance manually as needed rather than as automated browser CI regressions.

## Language selection

In **Settings → Appearance & language → Language**, select Follow system, 简体中文, 繁體中文, English, or 日本語. Changes apply immediately and persist while preserving connections, recordings, chart windows, filters, and selected messages (resetting settings restores automatic selection).

Linux reads the first non-empty variable in `LC_ALL → LC_MESSAGES → LANG`; Windows/macOS query the native system locale, falling back to WebView preferred language and then English. Script tags `Hans` / `Hant` take precedence over region codes; otherwise `CN`/`SG` and bare `zh` map to Simplified Chinese, `TW`/`HK`/`MO` to Traditional Chinese, `ja` to Japanese, and everything else (including `C`/`POSIX`) to English (normalizing case, underscores, encodings, and modifiers; manual choice overrides auto-detection).

```bash
LANG=en_US.UTF-8 ./laPower.AppImage
LC_ALL=ja_JP.UTF-8 ./laPower.AppImage
env -u LC_ALL LC_MESSAGES=zh_TW.UTF-8 LANG=en_US.UTF-8 ./laPower.AppImage
```

## Dictionary maintenance and translation checks

`src/i18n.js` supplies `t(key, params)`, locale resolution, and change subscriptions; `src/i18n-messages.js` stores columns in English (reference and missing-key fallback), Simplified Chinese, Traditional Chinese, and Japanese order. Use semantic keys and matching interpolation placeholders; user documentation uses Simplified Chinese as content reference with manual translation review.

Static HTML keeps English fallback text and `data-i18n*` attributes (marking only inner text spans when icons or controls are present); dynamic text and persistent notifications use `t` or deferred callbacks. Language switches update labels and charts without reconnecting or rebuilding data. Backend errors return `{code, params, detail?}`, translated on the frontend while retaining raw diagnostics (and accepting plugin strings); PD names, raw replies, units, and CSV/PD formats stay unchanged.

```bash
node --test test/i18n.test.js test/settings-persistence.test.js
node tools/showcase/verify-i18n.mjs
npm run showcase:capture -- --language zh-CN,zh-TW,en,ja
```

Check all four languages, light/dark themes, 900×600 and 1280×800 layouts, connection/recording/PDM states, PD filtering, CSV/PD round trips, and accessibility labels. Browser simulation never replaces Linux `LANG`/`LC_*`, macOS GUI, native file dialog, or physical hardware verification.

## Headless testing API

`tools/showcase/headless.mjs` provides a reusable Playwright headless wrapper for Node scripts (`npx playwright install chromium`), adding no test runners or CI jobs:

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

- `createHeadlessHarness({ channel, distribution, timeout })`: defaults to Chromium, source files, and a `15 s` timeout; accepts `msedge`/`chrome` or built `out/`.
- `openApp({ language, theme, query, context, beforeLoad })`: creates isolated storage, virtual devices, frozen clock, and download context, waiting for controls and charts to settle.
- `connect(path)`, `record()`, and `pause()` drive actual UI buttons; `freeze()`/`resume()` and `advance(ms)` (0–300000 ms) advance virtual time with real consumption ACKs; `flush()` awaits consumption and `waitForCharts()` awaits main-chart work plus two frames.
- `diagnostics()` returns `source`, `stream`, `performance`, uncaught `errors`, and `consoleErrors`; `app.page.evaluate()` can invoke `window.__SHOWCASE__` fault hooks. `await using` (Node 24) automatically cleans up on scope exit and propagates errors directly.

## Development showcase

`tools/showcase/` is a standalone browser development tool providing simulated WITRN K2 and POWER-Z KM003C devices, deterministic curves, PD traffic, and protocol-control outcomes (reusing app icons/styles and full title-bar layout; never touches hardware or enters `src/`, `out/`, or shipped installers).

```bash
npm ci
npx playwright install chromium
npm run showcase:dev
npm run showcase:capture
```

- **Interactive preview**: listens on `http://127.0.0.1:4173` (override port with `-- --port 4174`; standalone app views support `/app/?theme=dark` or `/app/?theme=system`), with outer toolbar controls to populate 120 s showcase data, freeze/resume simulation, step 10 s, and reset.
- **Screenshot capture**: Chromium at 1280×800 CSS × 2× DPI outputs 2560×1600 UI screenshots (full title bar) plus 1920×1080 / 1920×1340 report renders (monitoring reports run `cargo run --locked -p lapower --example showcase-reports`; pass `--page record,pd,trigger,detection,settings` to skip Rust). Filter via `--language`, `--theme`, `--page`, `--output` (`npm run showcase:capture -- --help`).
- **Fixtures and debug automation**: edit `tools/showcase/scenario.js` to adjust simulated curves or PDOs; run `node tools/showcase/generate-pd.mjs` in a Rust environment to rebuild `pd-fixtures.json` after changing raw PD frames. Debug builds allow `video_export_pick` to read `LAPOWER_VIDEO_TARGET` for local automation without opening the OS save dialog (release builds require native dialogs).
- **Appearance and font verification**: run `node tools/showcase/verify-appearance.mjs` to verify Traditional Chinese light/dark themes and 100%/125%/150% DPI DOM/Canvas fonts under `output/appearance-verification/`.

## Performance measurements

`bench/` holds algorithm, storage, memory, zoom rendering, startup, and packaging benchmarks (see [Performance benchmarks and limits](PERFORMANCE.md)):

| Command | Purpose |
| --- | --- |
| `node bench/core.mjs` | Column storage, bucketing, range statistics, and energy integration |
| `node bench/core.mjs --compare` | Multi-round comparison against `bench/baselines/` |
| `node bench/core.mjs --verify-baseline` | Single-pass correctness and baseline schema check (non-timed, CI-safe) |
| `npm run bench:memory` | 1M / 5M-point append and streaming CSV import memory comparison (defaults to `bench/results/memory-before/`, supports `-- --baseline <dir>`, requires matching column SHA-256 and ≥ 20% column-buffer reduction; writes `bench/results/memory.json`) |
| `node bench/chart-zoom.mjs` | Wheel-zoom/pan frame timing and Canvas 2D pipeline benchmark |
| `node bench/phase2.mjs` | Before/after range statistics and cooperative slicing comparison |
| `node bench/phase3.mjs` | Before/after chunked storage, statistics, and energy comparison |
| `node bench/extrema.mjs` | Per-sample scan versus extrema-index comparison |
| `node bench/startup.mjs` | Native cold-start phase probing (manual as needed) |
| `node bench/packaging.mjs` | Verify `out/` shipping file set and resource references |
| `cargo bench -p lapower` | Rust protocol decoding, encoding, and selection benchmarks |

## CI gates

`.github/workflows/ci.yml` runs fixed core gates on every push and PR:

| Job | Contents |
| --- | --- |
| `validate` | Linux deps, frontend build, JS tests, typecheck, lint, Rust fmt, Clippy, workspace tests, packaging shape, and baseline schema |
| `backend-other-platforms` | Windows and macOS workspace tests |
| `crate-features` | Clippy and tests for non-default protocol crate feature combinations |
| `package` | Version-tag pushes and manual runs only; builds four targets in parallel without cancelling siblings on failure |
| `package-summary` | Verifies all eight packages and generates `SHA256SUMS` once all four targets succeed |
| `release` | Version-tag pushes only; uploads, verifies remote assets, and publishes the Release automatically |

CI installs no browser and runs no UI matrix or long captures; `test/release.test.js` covers release script error handling and verification offline.

## Building on Linux

Debian/Ubuntu build dependencies and commands (Linux is not continuously verified on hardware):

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl file pkg-config libssl-dev libudev-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev patchelf
npm ci
npm run build
npx --no-install tauri build
```

### udev rules (required)

On Debian/Ubuntu, create `/etc/udev/rules.d/99-lapower.rules` to grant active local desktop sessions access to WITRN HID and POWER-Z Bulk/CDC interfaces:

```udev
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0716", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0063", TAG+="uaccess"
SUBSYSTEM=="usb", ATTR{idVendor}=="5fc9", ATTR{idProduct}=="0061", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="5fc9", TAG+="uaccess"
```

Run `sudo udevadm control --reload-rules`, replug the meter, then launch the app. Non-`systemd-logind` or headless setups should use their distribution's device-access group rules.

## Building on macOS

Requires Xcode Command Line Tools, stable Rust, and the npm-locked Tauri CLI:

```bash
npm ci
npm run build
npx --no-install tauri build
```

Keep the macOS private API Cargo feature aligned with `tauri.macos.conf.json`. Builds use `signingIdentity: "-"` (ad-hoc) and `minimumSystemVersion: "12.0"` (CI exports `MACOSX_DEPLOYMENT_TARGET=12.0` and `TAURI_BUNDLER_DMG_IGNORE_CI=false`). See [README installation](../../README.md#-download-and-installation) for Gatekeeper instructions; GUI and meter connections still require real-machine verification on Intel and Apple Silicon Macs (including macOS 12).

## External temperature service

laPower supports **the meter's internal sensor** or **an external TCP temperature server** (WITRN reads HID reports; POWER-Z reads ADC snapshots).

### Selecting a source

Open the arrow beside `Temperature service` in the `Monitor` command bar:

| Field | Description | Default |
| --- | --- | --- |
| `Source` | `Device` = meter sensor; `External` = TCP server | `External` |
| `IP` | Server address (external only) | `127.0.0.1` |
| `Port` | Server port (external only) | `1573` |

Connect/disconnect via the main `Temperature service` button; **source selection locks while connected**. `Device` resets automatically when the meter disconnects (cleared by the frontend on meter disconnect), whereas `External` TCP remains independent. Connected temperatures populate the reading card, fourth Y axis, and CSV `Temp(°C)` column.

### Protocol and examples

Minimal plain-text TCP protocol (laPower connects as client; no handshake or heartbeat; one Celsius decimal value per `\n`-terminated line, e.g., `25.125\n`):

- **5-second connect timeout** (tries IPv4 before IPv6).
- **Flexible interval**: 250 ms read-timeout loop waits indefinitely between values; preserves partial lines across TCP packets, discards lines over 256 bytes through the next newline, and disconnects on server EOF.

Two dependency-free Python examples ship in [`temperature-example/network_server.py`](../../temperature-example/network_server.py) and [`temperature-example/network_client.py`](../../temperature-example/network_client.py):

```bash
python temperature-example/network_server.py
```

Minimal custom server (bind `0.0.0.0` for remote hosts):

```python
import socket

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("0.0.0.0", 1573))
server.listen(1)

conn, addr = server.accept()
while True:
    temperature = read_your_sensor()      # returns a float
    conn.sendall(f"{temperature}\n".encode())
```

### Troubleshooting

- **Connection timeout**: check IP, port, `0.0.0.0` binding on remote hosts, and firewall rules.
- **Connected but shows `--`**: send bare decimal numbers plus LF/CRLF only (no units or JSON wrappers).
- **Erratic jumps**: verify every value ends with a newline so lines stay under 256 bytes.
- **Locked `Source` radio**: disconnect via the `Temperature service` main button first.

## Contributing

1. Fork the repository and create a branch.
2. Run core quality checks (`npm run check:all`) after making changes.
3. Keep frontend `// @ts-check` enabled and decouple pure data logic from DOM/Tauri.
4. Verify HID/Bulk byte layouts and ranges against hardware samples before adding devices or firmware, and follow [Testing and regression boundaries](#testing-and-regression-boundaries).
