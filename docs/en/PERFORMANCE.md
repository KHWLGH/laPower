**English** | [简体中文](../PERFORMANCE.md)

# Performance benchmarks and limits

This document records repeatable algorithm, storage, startup and shipped-shape benchmarks. It supports performance work; browser frame rates and hardware long runs are not automatic regressions for every change.

The latest chart caches, pause scheduling and paired KM003C measurements are recorded in [the pause and interaction acceptance report](../CHART-PAUSE-PERFORMANCE.md) (Chinese), including corrected benchmark opacity and hardware limitations.

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

These deterministic shipping invariants belong in `perf-shape` CI.

## Storage and data integrity

### 2026-10-10: Constant-block sharing and import allocation

Separate Windows/Node processes compared pre-change and current source. Fixed-interval 1 ms data had no temperature, five recording segments and changing values in the other signal channels. Continuous appends retained an export snapshot, then appended another 4097 points. Column buffers below count unique `ArrayBuffer`s; RSS is a sampled process peak after each chunk. The two metrics are not interchangeable.

| Scenario | Raw points | Column-buffer saving | Before / after peak RSS (MiB) |
| --- | ---: | ---: | ---: |
| Continuous append | 1,000,000 | 24.5% | 150.0 / 127.0 |
| Streaming CSV import | 1,000,000 | 24.5% | 255.3 / 230.8 |
| Continuous append | 5,000,000 | 24.9% | 523.8 / 409.0 |
| Streaming CSV import | 5,000,000 | 24.9% | 747.4 / 595.2 |

All column SHA-256 values matched before/after. Clearing and GC returned data buffers to their initial level; buffers remained stable after three replacements. The complete Tauri/WebView2/GPU process tree was not measured. Savings depend on constant-channel counts; recording limits retain the original conservative estimate.

At this historical checkpoint, 352 frontend tests, type checking, lint, release build and four-language browser checks passed. Windows font checks covered light/dark themes and 100%/125%/150% DPI. In 12/13/14px comparisons of identical Traditional Chinese text, Microsoft JhengHei regular strokes were too thin, so both Chinese variants prioritize Microsoft YaHei UI, keeping JhengHei as missing-glyph fallback. Browser checks confirmed YaHei UI for Chinese in body text, headings, dropdowns and monospace areas; Latin letters/digits retain platform UI/monospace fonts. Canvas fonts follow the selected language. Screenshots inspect glyphs/layout, not subjective WebView2 clarity on every display.

Core performance used pre-change source to generate a temporary baseline on the same machine, then passed three comparisons with the existing 15% threshold. Two 100,000-point integration metrics exceeded the committed timing baseline on this host; pre-change median times also exceeded it. The committed baseline was retained; temporary results were not written back to `bench/baselines/`.

Full constant blocks share storage within a column, using only its latest constant block as a reuse candidate. Appendable tails own their buffers. Historical writes and import backfill copy affected chunks; Worker transfers deduplicate shared buffers. Fixed snapshots, CSV values, statistics, integration and chart extrema stay identical.

4096-point chunked columns avoid copying whole columns during contiguous-array expansion. Performance work should record range statistics, integration, append boundaries and capacity changes, checking unchanged results with existing `chart-*`, `range-stats`, `recording` and `recording-spool` tests.

Actual sample intervals are stored per point. CSV optionally appends `SampleInterval(ms)`; mixed-rate integration uses point intervals for gap decisions. Older files retain summary intervals, timestamp estimation and the absolute two-second safeguard. Twelve raw columns plus auxiliary indexes are estimated at about 112 bytes/point; CSV at about 128 bytes/row.

Recovery headers synchronize immediately. Rust flushes buffers each second and wakes the frontend to drain/update the header. Large backfills take one fixed snapshot per round and also check the sync deadline while writing. Failure preserves recovery files; only successfully synchronized normal completion deletes them. Scanning supports legacy collision names such as `stem.partial-2.csv`.

Dense follow projections can complete fixed snapshots during natural appends, commit their X ranges and then process the latest window. Hiding the monitoring page cancels preparation. Large-range statistics use a Worker that folds in original order, transferring copies of at most 4096 rows. Each window has at most one active task; computation starts at intervals of `max(250 ms, last complete computation time × 4)`. Updates display the completed range/boundaries; unavailable Workers fall back to cooperative slices. PD export formats batches of at most 128 messages in a Worker and progresses after write acknowledgments, with chunks at most 1 MiB, retaining v2 files and v1 metadata compatibility.

CSV, acquisition, recording and protocol optimization should reuse existing core tests/benchmarks. Add targeted tests or benchmarks only for corruption, protocol incompatibility, crashes/deadlocks or confirmed high-impact regressions.

## Dense chart display budget

The October 16, 2026 [chart investigation (Chinese)](../CHART-PERFORMANCE-RESEARCH.md) covers the implementation and measurements. Each bucket/channel retains first, last and earliest min/max source indices, sorted and deduplicated in sample order. Candidates use actual timestamps, including unchanged repeated times. Connections require every source sample in the omitted interval to be finite. Stroke, fill and the existing-budget power overview use the same ordered geometry. Fully zoomed windows also use linear connections.

Each 256-node extrema page stores eight channels of min/max source indices and finite counts (24 KiB/page); values come from raw columns. At 3.6M samples, buffers occupy 21,823,488 bytes. Appends never copy history. Recording warms fixed prefixes with a 1 ms cooperative budget and at most 1024 samples per step, yielding to interaction and retaining completed prefixes. Cold pause reuses a complete recording projection from the same source/window and synchronously appends at most 4096 tail samples. One atomic detail upgrade follows background completion. Window, source, recording-state and visibility changes cancel obsolete upgrades. Time is checked between steps, not a strict task-duration cap.

Raw columns remain complete. Automatic recording starts with one min/max bucket per two CSS pixels, with internal levels of 1/2/4/8/16 pixels. Playback always budgets one Canvas device pixel per bucket, never widening to coarse buckets after slow frames. Budgets are at least 64 buckets, and samples/bucket use powers of two; actual strips may approach two budget units. Merging/rebuilding at equal density preserves every value, including NaN, signed zero and partial tails. Playback restores original points plus clipping neighbors when counts fit four times the drawing area's Canvas pixel width, capped at 16384 points and subject to a fixed vertical-travel budget; automatic recording uses CSS width for its raw-point threshold. Cursors always query original samples. DPI comes from current Canvas backing/CSS widths, not potentially changed system scaling.

The navigator also uses a fixed bucket per two CSS pixels, avoiding excessive vertices after main-chart density reduction. Its budget drops from about four vertices/CSS pixel to about one. Single-point power peaks and newest times in partial tails remain intact, covered by chart-binding tests.

Bucketing and fill protection are independent; area fill is kept by default. Fill becomes eligible for suppression at four points/CSS pixel (about 2400 points at 600 CSS px), but eligibility alone does not disable it. Ordinary slow recording frames first confirm pressure and reduce density. Only after drawing at that lower density and observing another two consecutive slow frames is fill disabled. Playback retains device-pixel resolution but can disable fill after two consecutive slow frames. A single severe draw delay above 100 ms can disable it immediately. More than four times the drawing width in new points per refresh marks large-batch pressure; healthy batches do not disable fill. Neither requested rate nor total duration imposes hard switches. Density/fill feedback measures actual drawing and post-draw delays, excluding imports, column initialization and cooperative cold preparation.

Fill restoration requires two healthy seconds and at least five seconds since suppression to avoid flicker. Hiding the page, replacing the source, moving below fill-candidate density or changing fill/channel visibility clears protection. Independent dense-window changes clear old timing evidence but retain confirmed fill protection. Switching the same source from recording to playback can retain fill pressure, not recording density. Continuous dragging and natural appends in full-history/follow windows retain valid evidence. A user opacity of zero always disables that channel's fill. Static playback does not redraw endlessly to accumulate recovery time. Drag and release projections use the same resolution rules.

Dense curves scan-convert ordered segments by device-pixel columns and union overlapping intervals before writing a Canvas-sized RGBA bitmap. This skips standard paths that would subsequently be discarded. Candidate buffers are independent and bounded per channel; uPlot arrays carry coordinates/cursor only. Fill follows the same ordered segments as independent regions with the existing baseline, channel order and pressure protection. Without fill, channels share one upload; with fill, each channel paints area then stroke. Missing intervals never create connecting segments. Without OffscreenCanvas or with unsupported colors/alpha, the same geometry builds Canvas paths. Bounded raw-point copies and vertical-travel protection remain; cursors query original samples.

The extrema index reuses completed source prefixes. Shrinking the right edge or panning earlier only queries it; a shorter window is not source truncation. New samples build only the tail; clearing/replacing/mutating source data invalidates it. Indexed projections count work in at most 32-bucket queries per step, raw scans in at most 4096 points. A roughly 4 ms initial budget allows immediate submission; remaining work yields cooperatively. Cold history builds use at most 4096 points/step and about 1.5 ms/slice. Only complete projections publish; canceling stale windows retains valid history indexes.

`drawClear`→`draw` measures JavaScript draw time, not completed Canvas rasterization. Diagnostics also retain draw→next-rAF delay and actual request-to-frame intervals; display policies use draw/post-draw pressure only. The idle baseline is the 20th percentile of the last 32 candidate intervals, excluding chart-draw frames. During recording, two frames above `max(33 ms, idle interval × 2)` lower density one level; one above 100 ms lowers two. Two stable seconds allow a recovery attempt, at most once every five seconds. Playback does not reduce density. Dense live views, static playback and interactions with unconfirmed fill observe at most three following rAFs. Unknown-fill interactions coalesce windows until observation completes, avoiding queued expensive paths. Confirmed healthy/disabled fill consumes feedback each frame and immediately submits the final release projection. An initial ordinary slow frame can schedule one confirmation redraw; healthy feedback ends the task instead of creating an endless recovery loop.

Requests distinguish `live`, `interaction` and `maintenance`. At an actual 1 ms interval, automatic drawing adjusts between 50–100 ms. Healthy 100 Hz drawing has no fixed interval merely because the window is dense. Interaction interrupts pending live-rate timers and coalesces the latest window via rAF; display changes and feedback redraws also bypass acquisition-rate limiting. The actual interval comes from tail `sampleIntervals`, falling back to settings. None of this affects acquisition, saving, statistics or integration.

`window.__WITRN_PERF__().charts.main.last` contains `sourcePointCount`, `displayPointCount`, `pixelsPerBucket`, `displayDense`, `fillSuppressed`, `fillSuppressionReason`, `recentAppendCount`, `refreshSource`, `refreshIntervalMs`, `drawMs`, `nextFrameDelayMs` and `frameDelayMs`. `nextFrameDelayMs` is the first subsequent rAF delay; `frameDelayMs` also includes the actual interval since the request. History remains bounded to 512 entries. `refreshIntervalMs` is the automatic interval for that request, or zero for interaction/maintenance. Suppression reasons are `severe-frame`, `persistent-slow-frame` or `large-batch-slow-frame`, otherwise null. `recentAppendCount` counts since the last main-chart commit; imports/preloaded history are not live batches. These metrics adjust display only, not sampling, CSV, statistics or integration.

On 2026-10-02, local headless Edge 154 measured actual `chart.js`/uPlot in 24 cases: 10,000/100,000/1,000,000 points; 3/8 channels; steady, isolated-spike and rapidly alternating signals; also 600/2400 CSS widths and DPI 1/1.5/2. The final matrix warmed up for 2.5 seconds and measured for two seconds per case. All appended raw points/spikes survived, with no page exceptions; maximum frame-interval p95 was 32.6 ms. A separate 100,000-point, three-channel alternating-signal comparison measured about 549 ms for fixed one-pixel buckets with 15% fill versus about 16 ms adaptively. The fixed policy simulates old display settings, not the entire old codebase. Early reports are untracked `bench/results/adaptive-chart-browser.json`; the final matrix is `bench/results/final-browser-matrix.json`.

These short, synthetic, same-host measurements do not replace sustained WebView2 device recording. Hardware acceptance should record at 100/1000 samples/s for at least five minutes each, tracking achieved rate, sequence errors, raw counts, density transitions and input latency. Local targets are frame-interval p95 ≤33 ms and interaction p95 ≤50 ms; absolute timings are not shared CI gates.

Early hardware runs had input p95 over 200 ms and presentation frames near 400 ms. Native screenshots later confirmed the desktop was locked; `document.hidden === false` and `document.hasFocus() === true` did not prove foreground visibility. The first unlocked rerun was also interrupted by locking. These runs are not foreground acceptance; historical reports are `bench/results/adaptive-chart-webview2.json` and `bench/results/deliverable-interrupted.json`. Disabling DirectComposition, accelerated Canvas or GPU did not improve this environment issue and was not adopted in release configuration.

With the desktop kept awake, another issue caused high-speed queue time to regress. One real-device batch of 63 contained 44 exact field-by-field replays of previous samples, then 19 new ones. The old clock treated sequence regression as restart and regressed published time. The fix verifies replay prefixes against a bounded history of 256 raw samples, skipping only confirmed duplicates and retaining all new points. Entire batches pass sequence/time checks before publication; unverifiable regressions or non-increasing times stop acquisition explicitly and preserve existing records. Six Rust regressions cover wraparound, full replay, equal readings with new sequences, conflicts in all raw fields, malformed tails and genuine holes. Sampling, CSV, statistics and integration precision contracts are unchanged.

Final acceptance ran the minified Release directly: KM003C, WebView2 154, DPI 2, 1280×800 CSS window, RTX 5060 Laptop GPU and default GPU settings. A temporary helper requested system/display wakefulness without persistent setting changes. Native screenshots confirmed an unlocked, visible desktop at startup and during runs. CDP moved the pointer every 150 ms; each group ran eight wheel-zoom/navigation-drag/full-history cycles. Input latency ran from trusted event timestamps to the next rAF, summarized by bounded histograms. After pause, preview-tail samples arrived and their IPC sequences were acknowledged before checking complete recording tails.

| Final hardware Release | Duration | Final raw points | Actual rate | Frame interval p95 | Interaction p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 Hz | 305.103 s | 30,519 | 99.99993 Hz | 7.3 ms | 7.2 ms |
| 1000 Hz | 305.146 s | 305,240 | 999.99939 Hz | 15.3 ms | 14.3 ms |

Both met local targets. Non-increasing X, wall-clock regressions, column misalignment, IPC-sequence and capacity errors were zero during recording and paused tails. High-speed authentication level was 1, without fallback. Density moved between 2/4-pixel levels; fill returned after pause. Maximum raw adjacent intervals were 16.920/1.008 ms. Maximum frame intervals were 21/45 ms; a p95 target does not mean every frame is below 33 ms. Binary SHA-256: `c8311524735c9d6a4974efbdc5c436f2f047bb3c3d4584992f5665078e8fa2c9`. Reports: `bench/results/final-100hz.json` and `bench/results/final-1000hz.json`.

A 1,000,000-point/eight-channel alternating stress test of the same Release retained 1,008,500 raw points. Main/navigator submissions had 124/986 vertices; frame p95/max were 13.3/17.6 ms. Both retained the exact power spike of 45. Zooming submitted 202 raw points matching original columns, with fill restored. Acceptance restored user settings, removed only test records and consumed/ACKed the final batch before exit. Scripts/results remain in ignored `bench/results/`, not packages. Absolute times apply only to this host/environment.

## 2026-10-03: Hardware acceptance for nine fixes

Acceptance used an unloaded KM003C (USB VID `5FC9`/PID `0063`, USB 4-2), voltage about 0.003 V. Environment: Windows, WebView2/Edge `154.0.4258.48`, DPI 2, 1280×800 CSS pixels, Intel Arc 140T and NVIDIA RTX 5060 Laptop, default GPU configuration. The desktop remained unlocked; temporary wake requests were released afterward without persistent setting changes.

The first minified Release containing nine fixes (SHA-256 `387012c7144414c4bdca18abb2d23367bc287867d210c2633ab5b8671019e782`) recorded at 100/1000 Hz for approximately five minutes each, with actual pointer movement, wheel zooming, navigator dragging and full-history restoration. After pause, preview samples arrived and the tail IPC receipt was consumed.

| Rate | Duration | Raw points after pause | Actual rate | Frame interval p95 | Interaction p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 Hz | 305.078 s | 30,517 | 99.999945 Hz | 7.8 ms | 9.0 ms |
| 1000 Hz | 305.021 s | 305,119 | 999.999921 Hz | 15.7 ms | 15.9 ms |

Both met local p95 targets; time regressions, wall-clock regressions, column misalignment, IPC and capacity errors were zero. Per-point intervals were 10/1 ms. The 1000 Hz maximum frame interval was 48.1 ms; passing p95 does not imply every frame is below 33 ms. Reports: `bench/results/nine-fixes-100hz.json` and `bench/results/nine-fixes-1000hz.json`.

Acceptance found that minimized Windows WebView2 could still report `document.hidden === false`, allowing chart/statistics computation. The fix adds native `isVisible()`/`isMinimized()` queries, coalesces them and rejects stale results; both chart and statistics check native visibility. New Release SHA-256: `3134f431dffe5481c912d35666d64be8c8cfd0aad2d228c9f432f8c7710c20c7`. Targeted reruns below did not repeat both five-minute recordings:

- Imported 305,119 real historical points through the release CSV Worker, following a 200,000-point window for about 20 seconds: 40 distinct chart commits and 35 distinct statistics endpoints. Completed statistics matched synchronous results field-by-field using `Object.is`.
- While minimized with large history, raw counts rose from 327,221 to 330,241 and recovery bytes from 37,760,280 to 38,119,209, while chart commit times/statistics endpoints stayed fixed. Both resumed when visible. `document.hidden` was still false while native visibility was false. Switching to PD also stopped drawing without stopping acquisition; returning to Monitor resumed it.
- The real WebView range Worker covered 4096-row boundaries, segments, mixed intervals, missing/infinite values and signed zero, exactly matching the synchronous path with `Object.is`. Cancellation returned null; cooperative fallback after Worker initialization failure was also exact.
- A five-second sampling recording lasted about 5 minutes 42 seconds; its recovery file, smaller than the write buffer, independently yielded 70 points. Native file checks covered small-file checkpoints, old/new collision-name scan/read/delete, mutually exclusive close options and successful deletion. Sixteen native syncs had 10 ms end-to-end p95, a local small-sample report only. Real disk flush/sync faults were not injected during hardware acceptance; Rust tests cover failure preservation.
- Mixed 5000/10/1 ms recording contained 1771 points and two pause segments, nominal interval taken from the first valid 5000 ms interval. Preview changes did not alter history. All CSV columns round-tripped exactly; Wh/mAh matched using `Object.is`. After release CSV Worker import through native recovery, another 176 points were recorded with exact integration.
- Synthetic PD logs of 100,000/500,000 messages were exported through the real Release WebView, native save dialog and disk: about 2.55/12.30 seconds, 784/3909 chunks, at most 128 messages/batch, largest chunks 19,573/19,828 bytes. Snapshots survived source clearing/appending. v2 parsing, Unicode/emoji and reentry protection passed. Injected Worker errors/cancellation released Workers/handles and deleted partial files. These were not 500,000 physical-device PD captures; frame-ring snapshots are not strict complete export-responsiveness measurements.

After additional fixes, development/minified frontend builds, Release Rust build, 284 JS tests, type checking, lint, Rust fmt, Clippy and workspace tests passed (299 passed, two existing ignored). Summary: `bench/results/nine-fixes-native-acceptance.json`. Targeted files: `nine-fixes-final-dense-follow.json`, `nine-fixes-visibility-fixed.json`, `nine-fixes-worker-exact.json`, `nine-fixes-native-file-io.json`, `nine-fixes-csv-native.json`, `nine-fixes-pd-native.json`. Temporary tools/raw results remain in ignored `bench/results/`; deleted browser acceptance tools are not restored and no CI is added. Absolute times apply only to this same-host run, not noisy absolute CI thresholds.

## 2026-10-04: High-rate window interaction acceptance

Uniform 1 ms timestamps reproduced old right-edge shrinking stalls, so duplicate timestamps were not necessary. With 1,000,000 points and 45 consecutive shrinks, the old version produced zero curve updates, 44 index rebuilds, and final draw delay about 425 ms stopped/438 ms recording. Causes included truncating extrema indexes for shorter windows and slicing indexed queries by raw-point coverage, so continuous input repeatedly canceled uncommitted projections. The fix reuses completed index prefixes, schedules by bucket work and separates automatic append, interaction and maintenance refresh. Canceling an old window retains completed indexes. Regressions also cover changing windows during cold construction, 32768-point boundaries, raw neighbors, missing values, extrema, cursors and drag/release consistency.

Local headless Edge 154 tested actual chart.js/uPlot in 27 cases: 100,000/1,000,000/5,000,000 points; steady/spike/alternating signals; uniform/duplicate/tail-dense timestamps; 100/1000 Hz; 3/8 channels; DPI 1/1.5/2. Each tested recording/stopped left/right shrinking, bidirectional panning and rapid reversals, with 45 consecutive inputs per action. Real WebView2 154 at DPI 2 and 1280×800 CSS pixels also ran 18 comparisons and six append-while-dragging cases. This round used unminified development frontend/Debug native host, no physical device, and an unlocked desktop; only in-memory data/settings changed and user settings were restored afterward.

| Same-host measurement | Maximum actual window draw-response p95 | Maximum frame-interval p95 | Longest period without curve update |
| --- | ---: | ---: | ---: |
| Edge, 27-case matrix | 46.7 ms | 48.4 ms | 171.9 ms |
| WebView2, 18-case matrix | 37.1 ms | 36.4 ms | 87.7 ms |
| WebView2, six append/drag cases | 38.7 ms | 36.5 ms | 91.5 ms |

All window interactions rebuilt indexes zero times. During 45 inputs, Edge updated curves 42–44 times, WebView2 43–44. Column alignment, sampled data, sparse point comparisons and drag/release projections passed without page exceptions. WebView2 also tested actual pointer, keyboard and wheel events for both handles, panning, reversed wheel and final windows: at 5,000,000 points maximum draw-response p95 was 18.5 ms, with all final windows correct. One second of synthetic 1000 Hz appends typically produced 14–18 main-chart draws; healthy 100 Hz windows could sustain about 100, without capping by total history.

Draw-response p95 met the 50 ms goal, but not all pressure-matrix frame-interval p95 values met 33 ms. This fix does not mean all frames met targets. Per-frame records showed some density-transition preparation taking about 0.3–1.8 ms, JS drawing about 0.1–0.6 ms, followed by slow Canvas rasterization. Feedback tightened budgets or disabled fill, restoring performance. Longest no-update periods are reported separately so input latency/p95 do not hide initial spikes. Timestamp clustering remains a measured display-pressure factor, without deduplicating or altering raw time. Earlier five-minute physical-device acceptance applies to historical versions, not sustained recording after this change.

Nine additional fixed-eight-channel, DPI-2, 1000 Hz alternating cases continuously appended during dragging across three point counts and timestamp distributions. Maximum preparation times for uniform/duplicate/locally dense timestamps were 1.5/1.5/2.1 ms, JS draws 1.7/2.0/1.7 ms; maximum window draw-response p95 was 36.2 ms. Clustering affects raster pressure but does not imply a monotonic “more clustering is slower” rule. All three retained every raw sample, extrema and sparse-window readings.

At this checkpoint, 296 JS tests, type checking, lint, development/minified frontend builds, Debug native build and shipped-shape checks completed. Reports/scripts remain in ignored `bench/results/`: `chart-interaction-before-browser.json`, `chart-interaction-browser.json`, `chart-interaction-webview2.json`, `chart-interaction-live-webview2.json`, `chart-interaction-timestamps-browser.json`. Absolute times support same-host comparison only, not shared CI gates.

## 2026-10-04: Playback detail fix

After the previous interaction fix, `15d5bbf` still allowed slow playback frames to widen bucket budgets to 8–16 CSS pixels, visibly coarsening the same data in long histories. The fix budgets one actual Canvas device pixel and restores raw points according to physical width; automatic recording adapts independently. Fill protection, separate strip fill and pixel-column bitmaps retain detail without altering raw samples.

The same-host comparison used Edge `154.0.4258.53`, a 1200-CSS-pixel chart and the same 100,000-point synthetic signal after injecting severe draw delays. Budgets are target units; power-of-two sample counts can make strips approach two device pixels.

| Version | DPI | Main-chart vertices | CSS pixels/bucket budget | Zoomed points identical to original slice/short recording |
| --- | ---: | ---: | ---: | --- |
| `15d5bbf` | 1 | 98 | 16 | Yes |
| `15d5bbf` | 2 | 98 | 16 | No |
| This fix | 1 | 1564 | 1 | Yes |
| This fix | 2 | 3126 | 0.5 | Yes |

Regressions cover DPI 1/1.5/2, changed system DPI with stale Canvas dimensions, density retention after slow frames, raw neighbors, drag/release projections, bitmap extrema/colors, transparent backgrounds, channel order, missing-value breaks, uneven-timestamp links and clipping. Fill checks compare boundaries, baseline and area before/after splitting. Browser screenshots confirmed coarse jagged shapes became readable waveforms, with complete raw points on zoom. WebView2 comparisons at 100,000/1,000,000/5,000,000 points also matched corresponding short recordings point-for-point.

Continuous interaction used DPI 2, eight channels, 1000 Hz synthetic data with ongoing appends, testing recording/stopped modes, both-side shrinking, bidirectional panning and rapid reversal, 45 inputs/action. Browser used actual source; WebView2 used development frontend/Debug host, a 1280×800 CSS window and default GPU settings. Tables take each case's maximum action p95 and longest no-update period.

| Environment / points / signal | Actual window draw-response p95 | Frame interval p95 | Longest no-update period |
| --- | ---: | ---: | ---: |
| Edge / 100,000 / steady | 22.5 ms | 18.3 ms | 38.5 ms |
| Edge / 1,000,000 / alternating | 45.9 ms | 36.4 ms | 60.5 ms |
| Edge / 5,000,000 / alternating | 52.7 ms | 36.5 ms | 75.6 ms |
| WebView2 / 100,000 / steady | 26.4 ms | 18.3 ms | 53.4 ms |
| WebView2 / 100,000 / alternating | 45.5 ms | 36.5 ms | 62.4 ms |
| WebView2 / 1,000,000 / steady | 29.3 ms | 18.3 ms | 35.5 ms |
| WebView2 / 1,000,000 / alternating | 50.5 ms | 42.4 ms | 56.6 ms |
| WebView2 / 5,000,000 / steady | 33.3 ms | 18.3 ms | 39.5 ms |
| WebView2 / 5,000,000 / alternating | 49.0 ms | 42.4 ms | 97.4 ms |

The same-host 100,000-point steady Edge comparison fell from 36.9 to 22.5 ms while retaining finer projections. Old large alternating cases used coarse buckets to reduce drawing cost; lower timings do not establish an advantage at equal detail. All actions rebuilt indexes zero times, with identical final projections. Edge updated 22–44 times during 45 inputs, WebView2 28–44. Initially unknown fill needs bounded feedback; once healthy or suppressed, refresh proceeds every frame. Real WebView2 pointer/keyboard/wheel tests produced correct final windows, maximum draw-response p95 48.9 ms.

At this checkpoint, 301 JS tests, type checking, lint, development/minified frontend builds, Debug native build and shipped-shape checks passed. A separate native startup smoke test checked minified chart initialization. Reports, screenshots and helpers remain in ignored `bench/results/`: `chart-detail-browser.json`, `chart-detail-browser-dense.json`, `chart-detail-webview2.json`. These are short synthetic acceptance runs; five-minute physical recording was not repeated. Extreme eight-channel alternating signals still had some p95 values above 33 ms frame intervals or 50 ms draw response. Absolute metrics are same-host comparisons, not shared CI hard gates.

### Follow-up: Restoring the CSV-import navigator curve

The `f5a20e1` main-chart pixel-column optimization incorrectly affected the navigator's shared path builder. Dense main playback cleared navigator strokes, but the navigator had no bitmap drawing hook; its path construction could also clear the corresponding main-chart fill cache. The fix restricts both optimizations to the main chart. The navigator chooses uPlot paths from its own full-history count and fixed bucket budget; main zooming no longer changes navigator paths.

Edge 154/DPI 2 used the actual CSV-import Worker with temporary synthetic file handles. Power-colored pixels were checked on the navigator Canvas to verify real drawing, not just DOM/data bindings.

| Synthetic CSV points | Navigator curve pixels after `f5a20e1` import | Pixels after fix |
| --- | ---: | ---: |
| 128 | 3830 | 3830 |
| 5000 | 0 | 3698 |
| 100,000 | 0 | 4420 |

All imports were complete, retaining a single 45 W spike and tail time. After the fix, the curve survived main zoom to 63 raw points, forced navigator redraw and Canvas resize. Actual WebView2/DPI 2/development frontend/Debug host passed the same three imports/draw checks without exceptions. Synthetic handles bypassed native file selection/disk reads; the actual parser Worker and Canvas still ran in WebView2. Regressions cover navigator strokes, independent projections and navigator redraw not clearing main fill. The full JS suite then had 302 tests. Temporary reports: ignored `bench/results/chart-import-navigator-browser.json` and `chart-import-navigator-webview2.json`.

## Startup measurement limitations

Absolute milliseconds from `bench/startup.mjs` are comparable only within the same batch/build and similar host state. Preserve environment and host probes with results; a single reading is not a cross-platform guarantee. Startup benchmarking is manual/on-demand, not browser regression.

Frontend marks separately record `uiReady` (settings/platform applied and page initialized), `listenersReady` (acquisition/protocol listeners registered), `devicesScanned` and `recoveriesScanned`. `appReady` still requires page, close listener, device listener and device scan completion; moving marks earlier is not startup acceleration. Listener failure keeps Connect disabled. Failed recovery scanning does not block `appReady`.

## CI and manual verification

CI retains `bench/packaging.mjs`, `bench/core.mjs --verify-baseline` and report-only algorithm/Rust benchmarks. Developers may run:

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
