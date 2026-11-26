**English** | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md)

<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="120" alt="laPower" />

# laPower

**Desktop companion for WITRN / POWER-Z USB power meters — live monitoring · USB-PD analysis · data recording**

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
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4?style=flat-square)](#-download-and-installation)

</div>

## 📖 About the project

laPower is a desktop companion for WITRN USB power meters and POWER-Z KM003C/KM002C. It reads measurement frames via USB HID or a vendor Bulk interface and handles live monitoring, long-duration recording, and USB-PD decoding locally and offline. Only manual update checks contact GitHub, and external temperature sources connect to a configured server over TCP.

Built on **Tauri v2**, it uses **Rust** for device communication, USB-PD parsing, and background thread lifecycles. The frontend is **plain JavaScript ES Modules** with uPlot charts, bundled by esbuild for release. All runtime frontend dependencies are vendored in the repository with no external CDN requests.

Besides voltage, current, power, and temperature, laPower records **D+ / D− / CC1 / CC2 signal voltages** and **decodes captured USB-PD messages field by field**, showing advertised charger PDOs, requested PPS voltages, and exact negotiation timestamps.

> **Platforms:** Version tags trigger GitHub Actions builds for Windows x64, Linux x64, macOS Intel, and Apple Silicon, publishing a Release after checks pass (refer to each release's actual assets). Development and primary verification take place on Windows; macOS/Linux GUI, device connections, and macOS 12 compatibility require hardware verification. See [Development and build](docs/en/DEVELOPMENT.md#release-process).

> **Note:** Much of this software was created with AI coding tools such as Claude Code, Grok Build, and Codex, and unknown issues may remain. Please report problems via [Issues](https://github.com/KHWLGH/laPower/issues).

## 📸 Interface preview

Screenshots below show version **0.3.1** on Windows using simulated devices and data (retaining the full title bar; the app follows the system theme by default). See [Development showcase](docs/en/DEVELOPMENT.md#development-showcase) to regenerate the full set.

| Light theme | Dark theme |
| :---: | :---: |
| <img src="docs/screenshots/en/light-record.png" alt="Monitor in light mode: live reading cards, eight-channel chart and timeline navigator" /><br><sub>**Monitor** · Live cards / 8 channels and 4 axes / timeline navigator</sub> | <img src="docs/screenshots/en/dark-record.png" alt="Monitor in dark mode" /><br><sub>**Monitor** · Dark theme</sub> |
| <img src="docs/screenshots/en/light-pd.png" alt="PD analysis in light mode: message list and decoded field tree" /><br><sub>**PD analysis** · Message list / PDO summaries / field decoding</sub> | <img src="docs/screenshots/en/dark-pd.png" alt="PD analysis in dark mode" /><br><sub>**PD analysis** · Dark theme</sub> |
| <img src="docs/screenshots/en/light-trigger.png" alt="Protocol control in light mode: PDM, PDO list and detection log" /><br><sub>**Protocol control** · PDM / PDO / protocol detection and voltage requests</sub> | <img src="docs/screenshots/en/dark-trigger.png" alt="Protocol control in dark mode" /><br><sub>**Protocol control** · Dark theme</sub> |
| <img src="docs/screenshots/en/light-settings.png" alt="Settings in light mode: sticky navigation, theme, custom background and language, charts and recording" /><br><sub>**Settings** · Theme / persistent custom background / language / charts and recording</sub> | <img src="docs/screenshots/en/dark-settings.png" alt="Settings in dark mode" /><br><sub>**Settings** · Dark theme</sub> |
| <img src="docs/screenshots/en/light-detection.png" alt="Protocol detection (Light theme)" /><br><sub>**Protocol detection** · Per-protocol status / voltages / individual evidence</sub> | <img src="docs/screenshots/en/dark-detection.png" alt="Protocol detection (Dark theme)" /><br><sub>**Protocol detection** · Dark theme</sub> |

### Report styles

Rendered report samples from the same 120-second simulated recording. Landscape images and videos include the first 8 markers; long images retain all 12 (video sample shows a mid-playback frame).

| Light theme | Dark theme |
| :---: | :---: |
| <img src="docs/screenshots/en/light-report-image.png" alt="Image report (16:9) (Light theme)" /><br><sub>**Image report (16:9)** · Lossless PNG / full curves / statistics and markers</sub> | <img src="docs/screenshots/en/dark-report-image.png" alt="Image report (16:9) (Dark theme)" /><br><sub>**Image report (16:9)** · Dark theme</sub> |
| <img src="docs/screenshots/en/light-report-long.png" alt="Image report (long) (Light theme)" /><br><sub>**Image report (long)** · All 12 markers / times and individual readings</sub> | <img src="docs/screenshots/en/dark-report-long.png" alt="Image report (long) (Dark theme)" /><br><sub>**Image report (long)** · Dark theme</sub> |
| <img src="docs/screenshots/en/light-report-video.png" alt="Video report frame (Light theme)" /><br><sub>**Video report frame** · Mid-video frame / live values / playback cursor</sub> | <img src="docs/screenshots/en/dark-report-video.png" alt="Video report frame (Dark theme)" /><br><sub>**Video report frame** · Dark theme</sub> |
| <img src="docs/screenshots/en/light-protocol-report.png" alt="Protocol detection report (Light theme)" /><br><sub>**Protocol detection report** · Protocol states and voltages / PD version / full PDOs</sub> | <img src="docs/screenshots/en/dark-protocol-report.png" alt="Protocol detection report (Dark theme)" /><br><sub>**Protocol detection report** · Dark theme</sub> |

## ✨ Features

### Live monitoring

- Voltage, current, power, and temperature cards, each with minimum, maximum, and average statistics.
- **Integrated energy (Wh) and capacity (mAh)** computed in software from samples while filtering out host clock jumps caused by sleep or NTP adjustments (over 8× sample interval and at least 2 s).
- **Signal voltages** D+ / D− / CC1 / CC2 can be overlaid on the chart and exported in CSV (resolution depends on the meter; WITRN CC1/CC2 resolution is 0.1 V).
- Optional **signed current recording** preserves current direction (positive forward, negative reverse; native ±10 A on K2) with a sidebar direction arrow.
- **Auto pause** stops recording when voltage, current, or power stays at or below a threshold for a set duration, suited for unattended charge/discharge tests.
- **POWER-Z high-rate sampling**: authenticated AdcQueue sampling at 1000 samples/s on KM003C/KM002C, falling back to 100 samples/s if authentication fails.
- **Crash recovery and limits**: temporary recovery files flush roughly once per second to app cache (removed on clean exit), with a default 512 MB per-recording limit that auto-pauses when reached; export explicitly for long-term CSV storage.

### USB-PD analysis

- Decodes SOP/SOP′ control, data, and extended messages, plus Hard Reset and Cable Reset.
- Message list with role-direction badges (`SRC → SNK`, `SRC|SNK → Plug`) and **PDO/RDO summaries**, such as `Fixed: 5.0V 9.0V 12.0V 15.0V 20.0V SPR AVS: 9-15V@3.0A PPS: 5.0-21.0V` or `Position:7 PPS:8.0V,3.45A`.
- Detail panel unpacks each frame **word by word**: raw Data Object hex → header fields → full bit-field tables per PDO.
- Filter by message type and toggle off GoodCRC link-layer acknowledgements.
- **Follow recording** synchronizes PD capture start/pause/clear with Monitor; a virtualized list keeps hundreds of thousands of entries scrollable.

### High-performance charts

- uPlot with a Canvas 2D / `OffscreenCanvas` incremental pixel-bucket pipeline renders **8 curves and 4 strictly aligned quantized Y axes** (current A, voltage V, power W, temperature °C) with two-level minor grids.
- Dense windows switch to incremental min/max pixel buckets and dirty-rectangle updates, keeping **million-point histories draggable**; complete data remains in chunked column storage, playback preserves pixel-level detail, zooming restores original points, and hover binary-searches raw samples.
- Wheel horizontal zoom, drag-to-pan, and live-follow work on both the main plot and timeline overview; at 1000 samples/s automatic drawing runs at ~10–20 fps while interaction refreshes independently and reuses historical extrema indexes (see [Performance notes](docs/en/PERFORMANCE.md#measurement-and-hardware-limits)).
- Hover tooltips display active finite channels, and the `Display` panel adjusts per-channel visibility, curve shading (enabled and persisted by default), fill opacity (0–100%), color, line thickness, and vertical offset (`Y offset`) without altering stored samples.

### Recording and interoperability

- **Image and video reports**: export the full recording as lossless 16:9 or long PNG images or short MP4/MOV videos with customizable resolution, theme, curves, and markers (no ffmpeg required).
- **POWER-Z protocol detection and reports**: inspect per-protocol support states, voltages, and evidence, read PD PDOs and revisions independently, export 1080p–4K PNGs, or populate the trigger form.
- **CSV export and import**: independently toggle temperature, device provenance, and markers, or export CSV and PD JSON jointly; import matches column headers and accepts legacy files.
- **Markers**: press `M` or click `Mark` to label the current sample (or the sample under the pointer when hovering the chart); markers render as vertical lines and round-trip via the CSV `Marker` column.
- **Sample rate and PD capture**: select 0.1–100 samples/s (plus 1000 samples/s on POWER-Z; backend accepts 1–60000 ms within device limits); PD capture uses versioned JSON and reads legacy v1 files.

### Interface

- Tabbed workspaces (Monitor / PD analysis / Protocol control / Settings) with title-bar device connection available everywhere; Protocol control stays visible and activates on supported POWER-Z connections.
- **Follow system / Light / Dark** themes with Fluent UI-aligned frosted-glass surfaces, smooth transitions, optional persistent **custom background image** (local PNG/JPEG/WebP, no bundled default wallpaper), and adjustable backdrop opacity and blur.
- Live **English, 简体中文, 繁體中文, 日本語** UI switching without dropping connections, recordings, or chart state, with automatic system locale detection (see [Language selection](docs/en/DEVELOPMENT.md#language-selection)).
- **UI scale 50–200%**; macOS uses native window controls, Windows keeps Win11 Snap Layouts support, and Windows/Linux place window controls on the right.

## 📱 Supported devices

| Model | VID | PID |
| --- | --- | --- |
| WITRN K2 | `0x0716` | `0x5060` |
| WITRN U3 | `0x0716` | `0x5063`, `0x5044` |
| WITRN C5 | `0x0716` | `0x5053`, `0x5064` |
| POWER-Z KM003C | `0x5FC9` | `0x0063` |
| POWER-Z KM002C | `0x5FC9` | `0x0061` |

WITRN enumeration uses VID `0x0716`, so unlisted models or firmware variants also appear as “Unknown WITRN device (0716:XXXX)” and work if their report layout is compatible. POWER-Z enumerates via the `0x5FC9` Vendor Bulk interface. When multiple HID interfaces exist, the backend prefers the vendor-defined Usage Page and appends the USB topology port when available (e.g. `WITRN K2 (USB 4-4)`).

## 📦 Download and installation

Formerly named WITRN-RS, laPower uses the identifier `io.github.khwlgh.lapower` with separate settings and cache directories (old settings are not migrated automatically; existing CSV and PD files remain importable).

- **Windows 10/11 (x64)**: download the `.msi`, `.exe` (NSIS), or portable `*_windows-x64_portable.zip` (extract and run `laPower.exe`; requires Microsoft Edge WebView2 Runtime) from [Releases](https://github.com/KHWLGH/laPower/releases/latest). System HID/WinUSB drivers typically bind automatically; unsigned installers may trigger SmartScreen on first run.
- **macOS 12+**: download `macos-x64` `.dmg` for Intel or `macos-arm64` `.dmg` for Apple Silicon and drag `laPower.app` to Applications. Builds use ad-hoc signing; if Gatekeeper blocks first launch, allow it in System Settings → Privacy & Security. See [Building on macOS](docs/en/DEVELOPMENT.md#building-on-macos) for build details and acceptance limits.
- **Linux (x64)**: download `linux-x64` `.deb` (`sudo apt install ./laPower_<version>_linux-x64.deb`), `.rpm` (`sudo dnf install ./laPower_<version>_linux-x64.rpm`), or `.AppImage` (`chmod +x` and run; may require FUSE 2). Configure [udev rules](docs/en/DEVELOPMENT.md#udev-rules-required) before connecting a meter. Verify all eight packages with `SHA256SUMS`.

## 🚀 Quick start

1. **Connect**: plug in the meter, refresh the title-bar device list, select the device, and click `Connect`.
2. **Record**: in `Monitor`, click `Start recording` (shortcut `P`); charts and energy/capacity integration start immediately (excluding pauses).
3. **Capture PD**: open `PD analysis` (`Follow recording` is on by default); replugging the charger captures the complete negotiation handshake.
4. **Mark and export**: press `M` or click `Mark` to add labels; save via `Export CSV` (arrow opens temperature, provenance, marker options, and joint CSV/PD export) or `Export report`.

See the [User guide](docs/en/USAGE.md) for every control, setting, and file format.

## 📚 Documentation

| Document | Contents |
| --- | --- |
| [User guide](docs/en/USAGE.md) | Every interface control, all settings, CSV/PD capture formats, and troubleshooting |
| [Architecture](docs/en/ARCHITECTURE.md) | Thread model, Tauri commands, data flow, HID layouts, tests, and security boundaries |
| [Development and build](docs/en/DEVELOPMENT.md) | Requirements, build commands, CI gates, Linux/macOS builds, external temperature service, and contributing |
| [Performance benchmarks and limits](docs/en/PERFORMANCE.md) | Chart scheduling, data integrity, benchmarks, and hardware limits |
| [Changelog](CHANGELOG.md) | Version index, bilingual release notes, and earlier Chinese archives |

## 🙏 Credits and related projects

- Thanks to WITRN and POWER-Z for USB-PD capture hardware support.
- Thanks to [JohnScotttt](https://github.com/JohnScotttt) for the upstream WITRN HID and USB-PD parser implementations (`witrnhid` and `usbpdparser`).
- Thanks to [km003c-protocol-research](https://github.com/okhsunrog/km003c-protocol-research) for public research on POWER-Z Bulk, authentication, and AdcQueue.
- Thanks to [c-power](https://github.com/bruno-ntmr/c-power), which inspired the organization and interaction of the protocol detection UI.
- Thanks to contributor [weixunkkkkk](https://github.com/weixunkkkkk) (#1): added macOS Apple Silicon (ARM64) build support and macOS window configuration.
- Thanks to contributor [asdmoment](https://github.com/asdmoment) (#4–#9): implemented macOS background acquisition keep-alive and sleep prevention, native window controls and menu-bar Settings entry, WITRN HID queued report draining and timestamp back-projection, sampling-window mean aggregation, recording markers, and CSV data provenance metadata.
- Thanks to contributor [xiaokangzaina](https://github.com/xiaokangzaina) (#11): implemented frosted-glass UI surfaces and persistent custom backgrounds, main-chart and timeline wheel zoom/drag pan with per-channel display controls, Canvas 2D pixel-bucket dirty-rectangle redraw optimizations, KM003C instantaneous polled sampling, and the Windows portable build.

### Protocol libraries

The workspace protocol crates are standalone Rust libraries (`publish = false`) without a Tauri dependency:

- **`crates/witrn-hid`** — WITRN HID device wrapper and measurement frame parsing.
- **`crates/usbpd-parser`** — USB-PD decoding and field trees.
- **`crates/km003c`** — POWER-Z Vendor Bulk, AES authentication, AdcQueue, and CDC control.

## 📄 License

Copyright (C) 2026 KHWLGH

This copyright notice covers only KHWLGH's own contributions. Other authors retain their rights; Git authorship does not imply copyright assignment. See [`COPYRIGHT`](COPYRIGHT) for complete notices, generated-material scope, and upstream provenance.

| Project-owned contributions (excluding third-party materials) | License |
| --- | --- |
| Application `src/`, `src-tauri/`; `scripts/`, `tools/`, `test/`, `bench/`, `temperature-example/`, `.github/`; project-owned documentation and configuration | [GPL-3.0-only](LICENSE) |
| All libraries, tests, examples, and project-owned documentation and configuration under `crates/` | [LGPL-3.0-or-later](LICENSE.LGPL-3.0) |

`usbpd-parser` and `witrn-hid` port JohnScotttt's Python packages usbpdparser 1.1.6 and witrnhid 1.1.5 (`Copyright (c) 2025 JohnScotttt`, LGPL-3.0-or-later). Local full texts are in [`LICENSE`](LICENSE) (GPLv3) and [`LICENSE.LGPL-3.0`](LICENSE.LGPL-3.0) (LGPLv3); the software comes without warranty. Open `Settings → About` to read project copyright, full GPL/LGPL texts, and all third-party runtime component licenses offline.

## 🔗 Related links

- [Report an issue or suggestion](https://github.com/KHWLGH/laPower/issues)
- [WITRN website](https://www.witrn.com/)
- [Tauri documentation](https://tauri.app/)
- [Rust website](https://www.rust-lang.org/)
