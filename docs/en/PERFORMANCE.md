**English** | [简体中文](../PERFORMANCE.md)

← Back to [README](../../README.md)

# Performance benchmarks and limits

This document records repeatable algorithm, storage, startup, and shipping-shape benchmarks for evaluating optimizations without turning browser frame rates or hardware endurance runs into per-commit CI regressions.

- [Measurement scope](#measurement-scope)
- [Frontend distribution](#frontend-distribution)
- [Storage and data integrity](#storage-and-data-integrity)
- [Report preparation and bounded recovery](#report-preparation-and-bounded-recovery)
- [Dense chart display budget](#dense-chart-display-budget)
- [Demand-driven scheduling and cache reuse](#demand-driven-scheduling-and-cache-reuse)
- [Measurement and hardware limits](#measurement-and-hardware-limits)
- [Startup measurement limitations](#startup-measurement-limitations)
- [CI and manual verification](#ci-and-manual-verification)

## Measurement scope

| Benchmark | Command | Focus |
| --- | --- | --- |
| Core algorithms | `node bench/core.mjs` | Columns, bucketing, range statistics, and energy integration |
| Algorithm phase comparison | `node bench/phase2.mjs` | Before/after range statistics and cooperative slices |
| Storage phase comparison | `node bench/phase3.mjs` | Before/after chunked storage, statistics, and integration |
| Long-recording memory | `npm run bench:memory` | Constant-block sharing, streaming CSV import, append snapshots, and buffer release |
| Extrema comparison | `node bench/extrema.mjs` | Per-sample scanning versus extrema indexes |
| Startup | `node bench/startup.mjs` | Native cold-start phases and resource shape |
| Interactive chart zoom | `node bench/chart-zoom.mjs` | Wheel-zoom/pan frame timing and Canvas 2D rendering pipeline |
| Shipped shape | `node bench/packaging.mjs` | `out/` files, blocking resources, and orphan assets |
| Rust benchmarks | `cargo bench -p lapower` | Protocol decoding, encoding, and selection |

`bench/core.mjs --compare` runs multi-round comparisons against `bench/baselines/`; `--verify-baseline` runs a single correctness and baseline-schema check without warmup or timing (suitable for CI). Shared-runner durations vary with load and caches and are informational rather than release gates.

## Frontend distribution

`npm run build` mirrors `src/` into `out/` and merges stylesheets while preserving native ES Modules. `npm run build:dist` bundles the entry and four Workers (two CSV Workers, PD-export Worker, and range-stats Worker), keeping Worker filenames and removing bundled modules. `node scripts/build-dist.mjs --bundle-js` writes unminified bundles for startup comparisons; typecheck and Node tests run directly against `src/`. `bench/packaging.mjs` verifies during `validate` that:

- Mirrored files in `out/` are tracked, while bundles and the copied About icon come from the build script;
- `.d.ts` files and dotfiles do not enter the shipped set;
- `index.html` contains no inline scripts and all asset references resolve with no tracked orphans.

## Storage and data integrity

### Constant-block sharing and import allocation

Isolated Windows/Node runs comparing previous vs. current source (1 ms fixed cadence, no temperature, 5 segments, varying signal channels, retaining an export snapshot before appending 4097 points; column buffers count unique `ArrayBuffer`s while RSS is sampled peak per chunk):

| Scenario | Raw points | Column-buffer saving | Before / after peak RSS (MiB) |
| --- | ---: | ---: | ---: |
| Continuous append | 1,000,000 | 24.5% | 150.0 / 127.0 |
| Streaming CSV import | 1,000,000 | 24.5% | 255.3 / 230.8 |
| Continuous append | 5,000,000 | 24.9% | 523.8 / 409.0 |
| Streaming CSV import | 5,000,000 | 24.9% | 747.4 / 595.2 |

Per-column SHA-256 hashes matched identically, and clearing + GC returned buffers to baseline across three replacements (full Tauri/WebView2/GPU process trees were not measured).

Chunked columns use **4096-point** chunks: full constant chunks reuse the latest matching constant chunk in that column (`Object.is` preserves signed zero and missing values), append tails own private buffers, historical edits copy per chunk, and Worker transfers deduplicate shared buffers. Per-point `SampleInterval(ms)` drives mixed-rate gap detection; 12 raw columns + auxiliary indexes average ~112 bytes/point (~128 bytes/row in CSV).

Recovery headers synchronize immediately, Rust flushes every second and wakes the frontend, large backfills freeze one snapshot per round, and only clean synchronized endings delete recovery files (also scanning legacy `stem.partial-2.csv`). Large range statistics serialize on one reusable Worker (≤ 4096 rows/copy, interval `max(250 ms, last time × 4)`); PD export batches ≤ 128 messages into ≤ 1 MiB chunks in a Worker while preserving v2/v1 compatibility.

## Report preparation and bounded recovery

Image and video reports share `video-projection.js`'s incremental kernel, stepping up to 4096 samples/marker ops with an ~1.5 ms cooperative yield budget; columns, markers, provenance, and recording state freeze before the first yield with cancellation and shutdown cleanup.

Measured on 2026-11-10 in Windows / Node 24.18.0 (1 ms interval, no temperature, 1 segment, 256 buckets, 1 ms timer simulating pending events across 3 runs):

| Samples | Previous synchronous block | Longest async compute slice | Async elapsed time, including yields | Event callbacks per run |
| --- | ---: | ---: | ---: | ---: |
| 1,000,000 | 83.6–113.8 ms | 2.03–2.44 ms | 1.08–1.74 s | 78–119 |
| 5,000,000 | 488.5–510.0 ms | 2.46–4.53 ms | 6.00–6.03 s | 410–423 |

Without `scheduler.postTask` in Node, the scheduler falls back to `setTimeout(0)` (max callback gap 16.4–18.4 ms), demonstrating ongoing event responsiveness rather than raw speedup; WebView/hardware timings still require native checks.

PD recovery advances a contiguous cursor (≤ 512 messages/page with fixed `throughSeq`) and caches ≤ 8 fetched detail trees; TCP temperature reads 1024-byte chunks into a 256-byte line buffer and discards unterminated oversized lines.

## Dense chart display budget

The main chart projects exact M4 geometry per **X-axis time / device-pixel column** (without power-of-two sample-count rounding), keeping first, last, and earliest min/max source indices in sample order per visible channel (connecting only when all omitted points are finite; cursors always binary-search original samples; hidden channels are masked out).

- **Extrema index and cooperative slices**: `ExactExtremaIndex` uses 256-node pages (24 KiB/page) plus `Float32Array` value envelopes at `level >= 2` to skip random `Float64` source reads on non-winning subtrees while falling back to exact `Float64` on `Float32` ties (25,559,040 B at 3.6M samples; appends never copy old pages). Completed prefixes are reused on shrinking/panning without full scans; recording warms prefixes in 1 ms / ≤ 1024-sample steps, while cold pause reuses coarser degraded recording projections and catches up ≤ 4096 tail points before an atomic upgrade. Indexed projections query ≤ 32 columns/step (raw scans ≤ 4096 points/step), attempting completion in ~4 ms before yielding in ~1.5 ms slices; cancelled windows preserve valid history indexes.
- **Dual-mode pixel budget and raw restoration**: automatic recording and review both start at **1 device pixel/column** (recording adapts only under sustained slow frames across levels 1/2/4 device pixels after two frames > `max(33 ms, idle × 2)` or one > 100 ms, recovering at most once every 5 s after 2 stable seconds with a sample-rate-aware feedback gap limit). Playback and continuous gestures hold **1 device pixel/column** without widening for slow frames or channel count, restoring raw points + clipping neighbors at ≤ 4× device-pixel width (capped at 16,384 points and within vertical-travel budget); the navigator projects by time across 2 CSS pixels/column.
- **Canvas 2D / `OffscreenCanvas` rasterization and shading**: dense main-chart views with opaque strokes and `OffscreenCanvas` scan-convert ordered extrema columns at pixel centers into a transposed `Uint32Array` bitmap (`1,440,000`-pixel gesture cap), clearing prior dirty bounds only, uploading 2D dirty rectangles via `putImageData` / `drawImage`, reusing geometry/RGBA buffers, and using a 3-point affine projection check; analytic column area coverage (`chart-fill.js`) sparsely resets touched row events and composites fills in the same upload pass. Non-`OffscreenCanvas` or translucent paths fall back to Canvas 2D. Shading is governed exclusively by persisted `chartFillEnabled` and per-channel 0–100% opacities without automatic slow-frame suppression.
- **Pacing and telemetry**: draws distinguish `live`, `interaction`, and `maintenance` (1 ms live updates pace between 50–100 ms; interaction cancels pending live timers). `window.__WITRN_PERF__().charts.main.last` exposes `sourcePointCount`, `displayPointCount`, `pixelsPerBucket`, `displayDense`, `fillEnabled`, `recentAppendCount`, `refreshSource`, `refreshIntervalMs`, `drawMs`, `nextFrameDelayMs`, `frameDelayMs`, plus compatibility fields `fillSuppressed: false` and `fillSuppressionReason: null` (512-entry cap).

## Demand-driven scheduling and cache reuse

- **Telemetry and status throttling**: normal operation samples briefly at startup, visibility restore, and post-draw with no idle rAF loop; call `window.__WITRN_PERF_START__()` / `STOP__()` / `RESET__()` for continuous diagnostics. Global status outside Monitor refreshes at most once every 250 ms.
- **Navigator and Worker reuse**: the navigator retains an independent single-channel power extrema index (2,727,936 B at 3.6M samples) surviving resizes; range stats reuse one Worker with ≤ 4096-row (≤ 256 KiB) scratch chunks; recovery checkpoints deduplicate by durable row count and header revision while the IPC emitter blocks when idle.

## Measurement and hardware limits

- Browser scripts share the [headless API](DEVELOPMENT.md#headless-testing-api), while `npm test` covers invariants like `recording-spool`; simulation never replaces same-host comparisons, theme/DPI matrices, or hardware endurance runs.
- Fix build, host, window size, DPI, channel count, rate, distribution, and public percentage fill settings (e.g., `12` for 12%) when benchmarking, separating recording, warm/cold pause, and interaction while logging first frame, refined frame, `draw`, next-rAF delay, and max stall (local observation targets: frame interval p95 ≤ 33 ms, interaction p95 ≤ 50 ms; extreme 8-channel alternating loads can exceed these).
- Hardware acceptance requires unlocked desktop and visibly foregrounded windows recording at 100 and 1000 samples/s for ≥ 5 minutes each while checking rate, sample count, sequence gaps, tail completeness, and interaction latency.

## Startup measurement limitations

`bench/startup.mjs` timings are comparable only within the same batch, build, and host conditions alongside environment probes. Frontend marks track `uiReady`, `listenersReady`, `devicesScanned`, `recoveriesScanned`, and `appReady` (failed recovery scanning does not block `appReady`).

## CI and manual verification

CI `validate` runs deterministic `bench/packaging.mjs` and `bench/core.mjs --verify-baseline`; run algorithm, memory, zoom, and Rust benchmarks locally as needed:

```bash
npm run build
node bench/packaging.mjs
node bench/core.mjs --verify-baseline --output bench/results/verify.json
node bench/core.mjs --compare
npm run bench:memory
node bench/chart-zoom.mjs
node bench/phase2.mjs
node bench/phase3.mjs
node bench/extrema.mjs
node bench/startup.mjs
cargo bench -p lapower
```

Physical meter checks are run manually by maintainers outside CI; see [Testing and regression boundaries](DEVELOPMENT.md#testing-and-regression-boundaries) for test rules.
