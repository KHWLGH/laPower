**English** | [简体中文](../PERFORMANCE.md)

# Performance benchmarks and limits

This document records repeatable algorithm, storage, startup and shipped-shape benchmarks. It supports performance work; browser frame rates and hardware long runs are not automatic regressions for every change.

## Measurement scope

| Benchmark | Command | Focus |
| --- | --- | --- |
| Core algorithms | `node bench/core.mjs` | Columns, bucketing, range statistics, energy integration |
| Algorithm phase comparison | `node bench/phase2.mjs` | Before/after range statistics and cooperative slices |
| Storage phase comparison | `node bench/phase3.mjs` | Chunked storage, statistics and integration |
| Long-recording memory | `npm run bench:memory` | Constant-block sharing, streaming CSV, append snapshots and buffer release |
| Algorithm comparison | `node bench/extrema.mjs` | Per-sample scanning versus extrema indexes |
| Startup | `node bench/startup.mjs` | Native startup phases and resource shape |
| Shipped shape | `node bench/packaging.mjs` | `out/` files, blocking resources and orphan assets |
| Rust | `cargo bench -p lapower` | Protocol decoding, encoding and selection |

`bench/core.mjs --compare` performs multiple comparisons using fingerprints/metrics from `bench/baselines/`. `--verify-baseline` runs data correctness once, checking fingerprints, metric sets, repetitions and round settings without warmup, timing or time thresholds, making it suitable for CI. Shared-runner timings vary with frequency, load and caches; individual durations are reports, not release gates.

## Frontend distribution

`npm run build` mirrors `src/` into `out/` and merges blocking stylesheets, retaining native JavaScript modules in development. `npm run build:dist` separately bundles the application entry, both CSV Workers, the PD-export Worker and range-statistics Worker, retaining Worker filenames and removing bundled source modules. `node scripts/build-dist.mjs --bundle-js` produces unminified bundles for startup comparisons. Type checking and Node tests still use source modules. `bench/packaging.mjs` checks that:

- Source-mirrored files in `out/` are tracked; bundled scripts/styles and the About icon copied from `src-tauri/icons/` are generated.
- Declaration files and dotfiles do not enter the shipped set.
- `index.html` has no inline scripts and resource references resolve.
- There are no new tracked orphan assets.

These deterministic shipping invariants run in `validate`, reusing its frontend build without a separate performance CI job.

## Storage and data integrity

### Constant-block sharing and import allocation

Separate Windows/Node processes compared pre-change and current source. Fixed-interval 1 ms data had no temperature, five recording segments and changing values in the other signal channels. Continuous appends retained an export snapshot, then appended another 4097 points. Column buffers below count unique `ArrayBuffer`s; RSS is a sampled process peak after each chunk. The two metrics are not interchangeable.

| Scenario | Raw points | Column-buffer saving | Before / after peak RSS (MiB) |
| --- | ---: | ---: | ---: |
| Continuous append | 1,000,000 | 24.5% | 150.0 / 127.0 |
| Streaming CSV import | 1,000,000 | 24.5% | 255.3 / 230.8 |
| Continuous append | 5,000,000 | 24.9% | 523.8 / 409.0 |
| Streaming CSV import | 5,000,000 | 24.9% | 747.4 / 595.2 |

All column SHA-256 values matched before/after. Clearing and GC returned data buffers to their initial level; buffers remained stable after three replacements. The complete Tauri/WebView2/GPU process tree was not measured. Savings depend on constant-channel counts; recording limits retain the original conservative estimate.

Full constant blocks share storage within a column, using only its latest constant block as a reuse candidate. Appendable tails own their buffers. Historical writes and import backfill copy affected chunks; Worker transfers deduplicate shared buffers. Fixed snapshots, CSV values, statistics, integration and chart extrema stay identical.

4096-point chunked columns avoid copying whole columns during contiguous-array expansion. Performance work should record range statistics, integration, append boundaries and capacity changes, checking unchanged results with existing `chart-*`, `range-stats`, `recording` and `recording-spool` tests.

Actual sample intervals are stored per point. CSV optionally appends `SampleInterval(ms)`; mixed-rate integration uses point intervals for gap decisions. Older files retain summary intervals, timestamp estimation and the absolute two-second safeguard. Twelve raw columns plus auxiliary indexes are estimated at about 112 bytes/point; CSV at about 128 bytes/row.

Recovery headers synchronize immediately. Rust flushes buffers each second and wakes the frontend to drain/update the header. Large backfills take one fixed snapshot per round and also check the sync deadline while writing. Failure preserves recovery files; only successfully synchronized normal completion deletes them. Scanning supports legacy collision names such as `stem.partial-2.csv`.

Dense follow projections can complete fixed snapshots during natural appends, commit their X ranges and then process the latest window. Hiding the monitoring page cancels preparation. Large-range statistics use a Worker that folds in original order, transferring copies of at most 4096 rows. Each window has at most one active task; computation starts at intervals of `max(250 ms, last complete computation time × 4)`. Updates display the completed range/boundaries; unavailable Workers fall back to cooperative slices. PD export formats batches of at most 128 messages in a Worker and progresses after write acknowledgments, with chunks at most 1 MiB, retaining v2 files and v1 metadata compatibility.

CSV, acquisition, recording and protocol optimization should reuse existing core tests/benchmarks. Add targeted tests or benchmarks only for corruption, protocol incompatibility, crashes/deadlocks or confirmed high-impact regressions.

## Report preparation and bounded recovery

Image and video reports share an incremental projection kernel. Each step processes at most 4096 samples or marker operations and yields using an approximately 1.5 ms cooperative budget. Statistics, energy, even a single huge bucket, frame-cursor traversal and marker sorting are sliced; the synchronous entry uses the same kernel. Columns, markers, provenance and recording state are frozen before the first yield, with cancellation and shutdown cleanup. Budget checks occur between steps, not as a hard task-duration limit.

On 2026-11-10, the previous source and the asynchronous entry were compared in one Windows / Node 24.18.0 process: 1 ms intervals, no temperature, one recording segment, voltage/current/power `1 + (i % 100) / 100`, one frame and the default 256 buckets. Three measured runs followed warmup; all output fields matched exactly. A 1 ms timer simulated pending events while compute slices and callback gaps were recorded.

| Samples | Previous synchronous block | Longest async compute slice | Async elapsed time, including yields | Event callbacks per run |
| --- | ---: | ---: | ---: | ---: |
| 1,000,000 | 83.6–113.8 ms | 2.03–2.44 ms | 1.08–1.74 s | 78–119 |
| 5,000,000 | 488.5–510.0 ms | 2.46–4.53 ms | 6.00–6.03 s | 410–423 |

This Node environment lacks `scheduler.postTask`, so the shared scheduler uses its `setTimeout(0)` fallback. Windows timer waits dominate elapsed time; the maximum event callback gap was 16.4–18.4 ms. These results demonstrate ongoing event processing, not faster total computation or measured WebView/acquisition ACK latency. Native GUI, hardware endurance and macOS/Linux runs remain separate validation work.

PD recovery advances a contiguous cursor, clones at most 512 messages per background page and freezes each pass horizon. Live events only raise the catch-up target without retaining another pending message queue. Fetched detail trees occupy at most eight frontend cache entries, excluding embedded legacy imported trees. TCP temperature uses fixed 1024-byte reads and a 256-byte line buffer, discarding oversized lines through their newline. Continuous unterminated input cannot accumulate memory or indefinitely defer stop checks.

## Dense chart display budget

Each bucket/channel retains first, last and earliest min/max source indices, sorted and deduplicated in sample order. Candidates use actual timestamps, including unchanged repeated times. Connections require every source sample in the omitted interval to be finite. Stroke, fill and the existing-budget power overview use the same ordered geometry. Fully zoomed windows also use linear connections.

Each 256-node extrema page stores eight channels of min/max source indices and finite counts (24 KiB/page); values come from raw columns. At 3.6M samples, buffers occupy 21,823,488 bytes. Appends never copy history. Recording warms fixed prefixes with a 1 ms cooperative budget and at most 1024 samples per step, yielding to interaction and retaining completed prefixes. Cold pause reuses a complete recording projection from the same source/window and synchronously appends at most 4096 tail samples. One atomic detail upgrade follows background completion. Window, source, recording-state and visibility changes cancel obsolete upgrades. Time is checked between steps, not a strict task-duration cap.

Raw columns remain complete. Automatic recording starts with one min/max bucket per two CSS pixels, with internal levels of 1/2/4/8/16 pixels. Playback always budgets one Canvas device pixel per bucket, never widening to coarse buckets after slow frames. Budgets are at least 64 buckets, and samples/bucket use powers of two; actual strips may approach two budget units. Merging/rebuilding at equal density preserves every value, including NaN, signed zero and partial tails. Playback restores original points plus clipping neighbors when counts fit four times the drawing area's Canvas pixel width, capped at 16384 points and subject to a fixed vertical-travel budget; automatic recording uses CSS width for its raw-point threshold. Cursors always query original samples. DPI comes from current Canvas backing/CSS widths, not potentially changed system scaling.

The navigator also uses a fixed bucket per two CSS pixels, avoiding excessive vertices after main-chart density reduction. Its budget drops from about four vertices/CSS pixel to about one. Single-point power peaks and newest times in partial tails remain intact, covered by chart-binding tests.

The Display → Curve shading switch controls all main-channel fills, defaults on and persists the user choice. Each channel retains its independent 0–100% opacity; zero always disables that fill. Re-enabling the switch restores those opacities. Recording, playback, dragging, zooming and slow frames never automatically change shading. Display bucketing, recording density adaptation and refresh pacing remain independent of acquisition and storage.

Shading no longer uses slow-frame confirmation, suppression cooldowns or healthy recovery timers. It does not request confirmation redraws or hold interaction updates for fill feedback. Continuous input coalesces the latest window per rAF and release submits the final position immediately; static playback creates no recovery redraw loop.

The plot and overview use WebGL 2 when hardware acceleration is available. Line segments follow sample positions, with bounded ordered extrema per channel in dense windows. The renderer antialiases strokes at device resolution during zoom and pan and uses the existing channel colors, widths, shading opacities, and paint order. Missing readings break the line. The plot draws one shared major grid, and the cursor reads original samples. If WebGL 2 is unavailable or its context is lost, Canvas 2D draws the waveform, using the bounded pixel-column renderer for dense views.

The extrema index reuses completed source prefixes. Shrinking the right edge or panning earlier only queries it; a shorter window is not source truncation. New samples build only the tail; clearing/replacing/mutating source data invalidates it. Indexed projections count work in at most 32-bucket queries per step, raw scans in at most 4096 points. A roughly 4 ms initial budget allows immediate submission; remaining work yields cooperatively. Cold history builds use at most 4096 points/step and about 1.5 ms/slice. Only complete projections publish; canceling stale windows retains valid history indexes.

`drawClear`→`draw` measures JavaScript draw time, not completed Canvas rasterization. Diagnostics also retain draw→next-rAF delay and actual request-to-frame intervals; display policies use draw/post-draw pressure only. The idle baseline is the 20th percentile of the last 32 candidate intervals, excluding chart-draw frames. During recording, two frames above `max(33 ms, idle interval × 2)` lower density one level; one above 100 ms lowers two. Two stable seconds allow a recovery attempt, at most once every five seconds. Playback does not reduce density. Dense live views and static playback observe at most three following rAFs; continuous interaction consumes feedback each frame. Feedback controls density and pacing only, never the shading switch.

Requests distinguish `live`, `interaction` and `maintenance`. The live main chart coalesces redraws via rAF while rendering fits the current frame budget. Under load, it adjusts its redraw interval using preparation cost, drawing cost and subsequent frame delays. The recording overview has its own refresh interval. Interaction interrupts pending live redraw timers. Wheel zoom updates the actual X window and selection on each frame and jumps directly to the target with reduced motion enabled. Acquisition, saving, statistics and integration use the original measurements.

`window.__WITRN_PERF__().charts.main.last` contains `sourcePointCount`, `displayPointCount`, `pixelsPerBucket`, `displayDense`, `fillEnabled`, `fillSuppressed`, `fillSuppressionReason`, `recentAppendCount`, `refreshSource`, `refreshIntervalMs`, `drawMs`, `nextFrameDelayMs` and `frameDelayMs`. `nextFrameDelayMs` is the first subsequent rAF delay; `frameDelayMs` also includes the actual interval since the request. History remains bounded to 512 entries. `refreshIntervalMs` is the automatic interval for that request, or zero for interaction/maintenance. `fillEnabled` reports the user shading switch; the compatibility fields `fillSuppressed` and `fillSuppressionReason` remain false and null. `recentAppendCount` counts since the last main-chart commit; imports/preloaded history are not live batches. These metrics adjust display only, not sampling, CSV, statistics or integration.

## Demand-driven scheduling and cache reuse

Normal frame telemetry samples bounded windows at startup, visibility restoration and after actual drawing; it keeps no idle rAF loop. Drawing pressure feedback and existing diagnostic fields remain available. Call `window.__WITRN_PERF_START__()` for continuous frame, input, DOM, long-task and memory recording, and `window.__WITRN_PERF_STOP__()` to restore demand-driven sampling. `window.__WITRN_PERF_RESET__()` enables full recording and clears samples for existing benchmarks. Global counts and status outside Monitor refresh at most once per 250 ms; returning to Monitor synchronizes immediately.

The navigator incrementally retains a separate single-channel power extrema index. Resizing rebuilds only the projection at the existing bucket budget, retaining indexed history. Both charts reuse carrier and candidate buffers. At 3.6 million points, the power index owns 2,727,936 B, one eighth of the eight-channel index. This additional bounded index memory avoids repeated history scans.

Range statistics serialize jobs on one reusable Worker. Each job fixes its column snapshot, revision, bounds and unique ID. Eight scratch columns of at most 4096 rows transfer to the Worker and back for reuse; original column buffers never transfer. Cancelled replies cannot publish results, and failures retain cooperative fallback. Scratch capacity is bounded at 256 KiB; the last chunk transfers full capacity and returning buffers adds message overhead. Reuse does not eliminate transfers or all allocations. Ordered arithmetic and integration remain unchanged.

PD filtering, layout and visibility restoration coalesce into the latest valid projection. The hidden header is measured at its final width before the initial scan. Identical data/conditions reuse the result and live appends join its tail. Hidden/minimized views cancel display work and recover gaps before restoring the latest state. Log entries are immutable after ingestion, so exports freeze an array of references; clearing, importing and appending cannot change that snapshot. Protocol control retains every progress line and commits changed history/detection rows per frame.

Recovery checkpoints track durable row counts and header content, avoiding repeated patch/sync of the same version. One-second checkpoints, paused tails, final synchronization and failure recovery remain intact. The backend IPC emitter blocks on an empty queue and starts its existing batching deadline only after a real message arrives.

## Measurement and hardware limits

Browser scripts share the [headless API](DEVELOPMENT.md#headless-testing-api) for isolated sessions, virtual time, consumption/ACK waits and diagnostics, without adding fixed acceptance cases or browser CI. Select existing UI tools or benchmarks by affected area; core `recording-spool` tests retain durable-version deduplication coverage. Headless simulation does not replace same-host before/after comparisons, full theme/DPI matrices or hardware endurance.

Comparisons should fix the build, host, window, DPI, channel count, sample rate, timestamp distribution and fill settings, separating recording, warm pause, cold pause and continuous interaction. Public fill settings are percentages: pass `12` for 12%, enabling fill only for voltage, current, power and temperature. Early timings that passed `0.12` and filled extra channels do not establish normal UI performance at 12% fill.

A JS `draw` callback, the next rAF and physical display presentation are different measures. Record the first complete window, final detailed projection, preparation CPU, drawing and subsequent frame delays, and longest interval without a curve update separately. The pause Promise waits only for the native tail fence, not chart presentation or disk synchronization. Same-host observation targets are frame-interval p95 ≤33 ms and interaction-response p95 ≤50 ms; extreme eight-channel alternating signals can still exceed them. Meeting p95 targets does not mean every frame meets them.

Historical KM003C comparisons restored 1,434,583 measured points before continuing acquisition; they did not acquire that many points again without interruption. Only seven channels had valid data, temperature was missing, and the signal was low-level. Uninterrupted physical acquisition of 3.6 million points, valid temperature, controlled alternating loads and power-loss recovery still require hardware checks. Device sequence gaps and the non-increasing-time safeguard have occurred; display optimizations do not eliminate these acquisition-side anomalies.

Synthetic browser matrices and short WebView2 runs do not replace sustained physical recording on the current version. Keep the desktop unlocked and the window visibly foregrounded, record at 100/1000 samples/s for at least five minutes each, and track achieved rate, raw counts, sequence anomalies, tail completeness and interaction latency. Neither `document.hidden` nor focus alone proves window visibility. Historical measurements do not guarantee current-build or cross-machine performance. Absolute timings are for same-host comparisons, not shared CI gates.

## Startup measurement limitations

Absolute milliseconds from `bench/startup.mjs` are comparable only within the same batch/build and similar host state. Preserve environment and host probes with results; a single reading is not a cross-platform guarantee. Startup benchmarking is manual/on-demand, not browser regression.

Frontend marks separately record `uiReady` (settings/platform applied and page initialized), `listenersReady` (acquisition/protocol listeners registered), `devicesScanned` and `recoveriesScanned`. `appReady` still requires page, close listener, device listener and device scan completion; moving marks earlier is not startup acceleration. Listener failure keeps Connect disabled. Failed recovery scanning does not block `appReady`.

## CI and manual verification

CI retains `bench/packaging.mjs` and `bench/core.mjs --verify-baseline` in `validate`; algorithm and Rust timing benchmarks run locally on demand. Developers may run:

```bash
npm run build
node bench/packaging.mjs
node bench/core.mjs --verify-baseline --output bench/results/verify.json
node bench/core.mjs --compare
node bench/phase2.mjs
node bench/phase3.mjs
node bench/extrema.mjs
node bench/startup.mjs
cargo bench -p lapower
```

Maintainers can run hardware checks on target devices as needed, outside fixed hosted CI regression. See [Testing and regression boundaries](DEVELOPMENT.md#testing-and-regression-boundaries) for when to add tests.
