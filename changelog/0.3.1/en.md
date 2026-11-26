# 0.3.1 - 2026-11-26

## Added

- Added the `Display system time` toggle (Settings → Charts & recording) to render Monitor chart X-axis labels, timeline bounds, hover tooltips, markers, and PD message timestamps using wall-clock time (display-only; exported CSV and PD files always record both system time and relative/timestamp time).
- Added a local `systemTime` (`YYYY-MM-DD HH:MM:SS.mmm`) field to exported PD capture JSON entries while preserving backward compatibility with legacy capture files.
- Added custom font selectors (Settings → Appearance & language) adapted to the active UI language (CJK + Latin/numeric pairs for Simplified/Traditional Chinese, Japanese + Latin/numeric with native Japanese default font stack fallback, and `Interface font` + `Monospace & numeric font` for English), featuring local font/face enumeration, Unicode-range isolated styling, default system font name indicators, frosted-glass live preview, and `Reset fonts`.

## Changed

- Refactored exported and temporary recovery CSV time columns to `SystemTime` (`YYYY-MM-DD HH:MM:SS.mmm`) and `SoftwareTime(s)` (exact relative seconds), removing duplicate time columns and `="..."` wrappers while remaining compatible with legacy CSV imports.
- Refined Monitor chart X-axis time tick density and edge clamping: divisions stay uniform for the active plot width while preserving full start and end timestamps (prioritizing the end time on narrow plots), preventing density jumps, edge gaps, clipping, or label overlap while panning, dragging, or zooming.

## Fixed

- Fixed dragging the bottom timeline navigator (right handle or range bar) all the way to the right edge during active recording staying frozen on the pre-drag range instead of entering live follow/full tracking.

## Performance and maintenance

- Reworked `SeriesBuckets` to use exact X-axis pixel-column M4 (first, min, max, last) projection, eliminating aliasing, peak drift, and time skew caused by equal sample-index slicing on long recordings and non-uniform sampling intervals.
- Added compact Float32 extrema envelopes to coarse `ExactExtremaIndex` levels and visible-channel masking to skip hidden curves, reducing million-point zoom/pan extrema recomputation to roughly 3 ms.
- Tightened live and gesture pixel budgets (dynamic 1–4 device-pixel density, removal of the coarse 160-bucket gesture cap, pixel-center raster alignment, and sparse coverage clearing) to preserve high-frequency waveform detail alongside smooth million-point responsiveness.
