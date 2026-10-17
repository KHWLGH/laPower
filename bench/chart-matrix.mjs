import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../tools/showcase/server.mjs';
import { environment, options, provenance, quantiles } from './common.mjs';

const config = options(process.argv.slice(2), {
  sizes: [1_000_000, 3_600_000],
  runs: 3,
  output: 'bench/results/chart-ordered-matrix',
  baselineDir: 'bench/results/chart-ordered-before',
  ratios: '1,1.25,1.5,2',
  signals: 'normal,alternating',
  variants: 'baseline,current',
  channel: 'msedge',
  resume: false,
  fillChannels: 4,
});
const before = await provenance(),
  output = resolve(config.output);
const snapshot = Object.fromEntries(
  await Promise.all(
    ['chart.js', 'chart-buckets.js', 'chart-extrema.js'].map(async (file) => [
      file,
      await readFile(resolve(config.baselineDir, 'src', file), 'utf8'),
    ]),
  ),
);
await mkdir(output, { recursive: true });
const server = await startServer(),
  browser = await chromium.launch({ channel: config.channel, headless: true });
const result = config.resume
  ? JSON.parse(await readFile(resolve(output, 'matrix.json'), 'utf8'))
  : {
      config,
      environment: environment(),
      browser: browser.version(),
      provenance: before,
      cases: [],
      fillPercent: 12,
      limitations:
        'Synthetic 1KSPS, production chart/uPlot, headless Edge; no physical presentation, HID or native disk I/O. Baseline is the saved uncommitted snapshot. Cases alternate order in the same browser process. First complete draw, final fine draw, frame intervals and index bytes are separate. Each channels/fill/DPI/signal/size group has at least three rounds.',
    };
try {
  for (const ratio of config.ratios.split(',').map(Number))
    for (const n of config.sizes)
      for (const signal of config.signals.split(','))
        for (const variant of config.variants.split(',')) {
          const done = result.cases.filter(
            (c) => c.ratio === ratio && c.n === n && c.signal === signal && c.variant === variant,
          );
          if (done.length === config.runs * 4) continue;
          const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            deviceScaleFactor: ratio,
          });
          const page = await context.newPage(),
            errors = [];
          page.on('pageerror', (e) => errors.push(String(e)));
          if (variant === 'baseline')
            await page.route(/\/(chart|chart-buckets|chart-extrema)\.js$/, (route) =>
              route.fulfill({
                contentType: 'text/javascript',
                body: snapshot[new URL(route.request().url()).pathname.split('/').at(-1)],
              }),
            );
          await page.goto(`${server.url}/app/?capture=1&theme=light&language=zh-CN`);
          await page.waitForFunction(() => !document.getElementById('btn-connect').disabled);
          await page.evaluate(() => window.__SHOWCASE__.freeze());
          await page.locator('#device-select').selectOption('showcase:km003c', { force: true });
          await page.locator('#btn-connect').click();
          await page.waitForFunction(async () => (await import('/state.js')).state.isConnected);
          await page.evaluate(
            async ({ n, signal, variant }) => {
              window.__SHOWCASE__.freeze();
              const { state, emptyChartColumns } = await import('/state.js'),
                chart = await import('/chart.js'),
                data = await import('/data.js');
              const { ExactExtremaIndex } = await import('/chart-extrema.js');
              const original = ExactExtremaIndex.prototype.syncStep;
              let index = null;
              ExactExtremaIndex.prototype.syncStep = function (...args) {
                index = this;
                return original.apply(this, args);
              };
              const cs = emptyChartColumns(),
                xs = Float64Array.from({ length: n }, (_, i) => i / 1000),
                alternating = signal === 'alternating';
              const v = Float64Array.from(xs, (_, i) =>
                alternating ? 5 + Math.sin(i * 0.73) * 2 : 5 + Math.sin(i / 900) * 0.08 + Math.sin(i * 1.71) * 0.002,
              );
              const a = Float64Array.from(xs, (_, i) =>
                alternating ? 1 + Math.sin(i * 0.93) * 0.8 : 1 + Math.sin(i / 350) * 0.25 + Math.sin(i * 2.01) * 0.003,
              );
              for (const [key, col] of Object.entries(cs))
                col.set(
                  key === 'x'
                    ? xs
                    : key === 'voltage'
                      ? v
                      : key === 'current' || key === 'currentMagnitudes'
                        ? a
                        : Float64Array.from(xs, (_, i) =>
                            key === 'power'
                              ? v[i] * a[i]
                              : key === 'timestamps'
                                ? 1_700_000_000_000 + xs[i] * 1000
                                : key === 'sampleIntervals' || key === 'recordingSegments'
                                  ? 1
                                  : key === 'temp'
                                    ? alternating
                                      ? 20 + Math.sin(i * 1.13) * 15
                                      : NaN
                                    : alternating
                                      ? 2 +
                                        Math.sin(
                                          i * (key === 'dp' ? 1.03 : key === 'dn' ? 0.83 : key === 'cc1' ? 0.53 : 0.43),
                                        ) *
                                          1.5
                                      : key === 'dp'
                                        ? 3.3
                                        : key === 'dn'
                                          ? 0.6
                                          : 0,
                          ),
                );
              state.chartSeries = cs;
              state.settings.sampleRate = 1;
              state.settings.recordLimitMb = 8192;
              state.settings.recordingTempSpool = false;
              state.dataIntervalMs = 1;
              state.isRecording = true;
              state.chartWindow = { mode: 'full', min: 0, max: xs.at(-1), duration: xs.at(-1) };
              data.updateChartEmptyState();
              chart.syncChartSeries();
              chart.setChartXWindow(0, xs.at(-1));
              chart.updateCharts('live');
              const frame = () => new Promise(requestAnimationFrame),
                sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              const settle = async () => {
                const deadline = performance.now() + 15000;
                do {
                  await sleep(2);
                  if (performance.now() > deadline) throw Error('preparation timeout');
                } while (document.getElementById('main-chart').getAttribute('aria-busy') === 'true');
                for (let i = 0; i < 3; i++) await frame();
              };
              await settle();
              const r = {
                state,
                chart,
                data,
                cs,
                frame,
                settle,
                draws: [],
                frames: [],
                longTasks: [],
                index: () => index,
                variant,
              };
              window.__matrix = r;
              let last = performance.now();
              const tick = (now) => {
                r.frames.push(now - last);
                last = now;
                requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
              state.mainChart.hooks.draw.push(() =>
                r.draws.push({
                  at: performance.now(),
                  ...(state.mainChart.__chartProjection ?? { quality: 'fine' }),
                  right: state.mainChart.data[0].at(-1),
                  timing: structuredClone(window.__WITRN_PERF__().charts.main.last),
                }),
              );
              new PerformanceObserver((list) => {
                for (const e of list.getEntries()) r.longTasks.push({ at: e.startTime, ms: e.duration });
              }).observe({ type: 'longtask', buffered: false });
              r.measure = async (name, fn) => {
                r.draws = [];
                r.frames = [];
                r.longTasks = [];
                const started = performance.now();
                const value = fn();
                const callMs = performance.now() - started;
                await value;
                await settle();
                const fine = r.draws.find((d) => d.quality === 'fine'),
                  first = r.draws[0];
                return {
                  name,
                  callMs,
                  firstCompleteMs: first?.at - started,
                  finalFineMs: fine?.at - started,
                  draws: r.draws.map(({ at, ...d }) => ({ ...d, ms: at - started })),
                  frames: r.frames.slice(),
                  longTasks: r.longTasks.slice(),
                  indexBytes: index.byteLength,
                };
              };
              r.record = async () => {
                chart.setRangeDragging(false);
                state.isRecording = true;
                state.chartWindow = { mode: 'full', min: 0, max: cs.x.at(-1), duration: cs.x.at(-1) };
                chart.setChartXWindow(0, cs.x.at(-1));
                chart.updateCharts('live');
                await settle();
              };
            },
            { n, signal, variant },
          );
          for (let run = 0; run < config.runs; run++) {
            const combinations = [
              [3, false],
              [3, true],
              [8, false],
              [8, true],
            ];
            if (run % 2) combinations.reverse();
            for (const [channels, filled] of combinations) {
              if (
                result.cases.some(
                  (c) =>
                    c.ratio === ratio &&
                    c.n === n &&
                    c.signal === signal &&
                    c.variant === variant &&
                    c.run === run &&
                    c.channels === channels &&
                    c.filled === filled,
                )
              )
                continue;
              const measurements = await page.evaluate(
                async ({ channels, filled, fillChannels }) => {
                  const r = window.__matrix,
                    { state, chart, cs } = r;
                  for (let s = 0; s < 8; s++) {
                    chart.setSeriesVisible(s, s < channels);
                    chart.setSeriesFill(s, filled && s < fillChannels ? 12 : 0);
                  }
                  await r.record();
                  r.index().sync(
                    ['voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2'].map((k) => cs[k]),
                    cs.x.length,
                  );
                  await r.settle();
                  const warm = await r.measure('warm-pause', () => {
                    state.isRecording = false;
                    chart.updateCharts('maintenance', { force: false, reason: 'pause' });
                  });
                  const zoom = await r.measure('zoom-4000', () => {
                    const min = cs.x.at(Math.floor(cs.x.length / 2)),
                      max = min + 3.999;
                    state.chartWindow = { mode: 'frozen', min, max, duration: max - min };
                    chart.setChartXWindow(min, max);
                    chart.updateCharts('interaction');
                  });
                  const gesture = await r.measure('gesture', async () => {
                    chart.setRangeDragging(true);
                    for (let i = 0; i < 12; i++) {
                      const count = Math.round(12000 * (2000 / 12000) ** (i / 11)),
                        mid = Math.floor(cs.x.length / 2) + i * 13,
                        min = cs.x.at(mid),
                        max = cs.x.at(mid + count - 1);
                      state.chartWindow = { mode: 'frozen', min, max, duration: max - min };
                      chart.setChartXWindow(min, max);
                      chart.scheduleChartUpdate('interaction');
                      await r.frame();
                    }
                    chart.setRangeDragging(false);
                    chart.updateCharts('interaction', { force: false, reason: 'release' });
                  });
                  await r.record();
                  chart.setRangeDragging(true);
                  chart.setRangeDragging(false);
                  r.index().reset();
                  const cold = await r.measure('cold-pause', () => {
                    state.isRecording = false;
                    chart.updateCharts('maintenance', { force: false, reason: 'pause' });
                  });
                  return { warm, zoom, gesture, cold };
                },
                { channels, filled, fillChannels: config.fillChannels },
              );
              assert.deepEqual(errors, [], 'browser page errors');
              for (const key of ['warm', 'zoom', 'gesture', 'cold'])
                assert.ok(Number.isFinite(measurements[key].firstCompleteMs), `${variant} ${key} no complete draw`);
              if (variant === 'current') {
                assert.equal(measurements.warm.draws[0].quality, 'fine', 'warm first frame must be fine');
                assert.ok(
                  measurements.cold.draws[0].quality === 'coarse',
                  'cold first frame reuses complete projection',
                );
                assert.equal(
                  measurements.cold.draws.filter((d, i, a) => d.quality === 'fine' && a[i - 1]?.quality !== 'fine')
                    .length,
                  1,
                  'one fine upgrade',
                );
              }
              const item = { variant, ratio, n, signal, run, channels, filled, ...measurements };
              result.cases.push(item);
              await writeFile(resolve(output, 'matrix.json'), JSON.stringify(result, null, 2));
            }
          }
          console.log(JSON.stringify({ variant, ratio, n, signal, cases: result.cases.length }));
          await context.close();
        }
  result.sourceStable = before.sourceSha256 === (await provenance()).sourceSha256;
  assert.ok(result.sourceStable);
  result.summary = ['baseline', 'current'].map((variant) => {
    const cases = result.cases.filter((c) => c.variant === variant);
    return {
      variant,
      cases: cases.length,
      warm: quantiles(cases.map((c) => c.warm.firstCompleteMs)),
      cold: quantiles(cases.map((c) => c.cold.firstCompleteMs)),
      fine: quantiles(cases.map((c) => c.cold.finalFineMs)),
      normalWarm: quantiles(cases.filter((c) => c.signal === 'normal').map((c) => c.warm.firstCompleteMs)),
      normalZoom: quantiles(cases.filter((c) => c.signal === 'normal').map((c) => c.zoom.firstCompleteMs)),
      gesture: quantiles(cases.flatMap((c) => c.gesture.frames)),
      alternatingGesture: quantiles(cases.filter((c) => c.signal === 'alternating').flatMap((c) => c.gesture.frames)),
      indexBytes: Math.max(...cases.map((c) => c.cold.indexBytes)),
    };
  });
  await writeFile(resolve(output, 'matrix.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.summary));
} finally {
  await browser.close();
  await server.close();
}
