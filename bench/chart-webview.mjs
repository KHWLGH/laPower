import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { options, provenance, sha256 } from './common.mjs';

const config = options(process.argv.slice(2), {
  exe: 'target/debug/lapower.exe',
  output: 'bench/results/chart-ordered-webview',
  ratios: '1,1.25,1.5,2',
  sizes: [1_000_000, 3_600_000],
  runs: 3,
  variant: 'current',
  baselineDir: 'bench/results/chart-ordered-before',
  baselineFormat: 'legacy',
  fillChannels: 4,
});
const output = resolve(config.output),
  before = await provenance();
await mkdir(output, { recursive: true });
const results = {
  config,
  provenance: before,
  cases: [],
  errors: [],
  fillPercent: 12,
  limitations:
    'Real WebView2 runtime and native debug app, synthetic source columns only. No KM003C HID sampling, native pause fence or recovery-file I/O; physical presentation is not measured. DPI is forced per child process and verified from devicePixelRatio.',
};
for (const [ordinal, ratio] of config.ratios.split(',').map(Number).entries()) {
  const port = 19427 + ordinal;
  const child = spawn(resolve(config.exe), [], {
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --force-device-scale-factor=${ratio}`,
    },
    stdio: 'ignore',
  });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`);
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(ready, 'native CDP endpoint');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts()[0].pages()[0];
    page.on('pageerror', (error) => results.errors.push(String(error)));
    await page.waitForFunction(() => location.href !== 'about:blank');

    await page.waitForFunction(() => document.querySelector('#main-chart canvas'));
    results.runtime = await page.evaluate(() => navigator.userAgent);
    const dpi = await page.evaluate(() => devicePixelRatio);
    assert.equal(dpi, ratio);
    const embedded = await page.evaluate(async (variant) => {
      const hashes = {};
      for (const file of [
        'chart.js',
        'chart-buckets.js',
        'chart-extrema.js',
        ...(variant === 'current' ? ['chart-fill.js'] : []),
      ]) {
        const bytes = await (await fetch('./' + file)).arrayBuffer();
        hashes[file] = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
          v.toString(16).padStart(2, '0'),
        ).join('');
      }
      return hashes;
    }, config.variant);
    for (const [file, hash] of Object.entries(embedded))
      assert.equal(
        hash,
        sha256(await readFile(resolve(config.variant === 'baseline' ? config.baselineDir : '.', 'src', file))),
      );
    results.embedded = embedded;
    for (const n of config.sizes)
      for (const signal of ['normal', 'alternating']) {
        const cases = await page.evaluate(
          async ({ n, signal, runs, variant, baselineFormat, fillChannels }) => {
            const { state, emptyChartColumns } = await import('./state.js'),
              chart = await import('./chart.js'),
              { ExactExtremaIndex } = await import('./chart-extrema.js');
            let index = null;
            const original = ExactExtremaIndex.prototype.syncStep;
            ExactExtremaIndex.prototype.syncStep = function (...args) {
              index = this;
              return original.apply(this, args);
            };
            const cs = emptyChartColumns(),
              alt = signal === 'alternating';
            for (const [key, col] of Object.entries(cs))
              col.set(
                Float64Array.from({ length: n }, (_, i) =>
                  key === 'x'
                    ? i / 1000
                    : key === 'temp'
                      ? alt
                        ? 20 + Math.sin(i * 1.13) * 15
                        : NaN
                      : key === 'timestamps'
                        ? 1_700_000_000_000 + i
                        : key === 'sampleIntervals' || key === 'recordingSegments'
                          ? 1
                          : alt
                            ? 5 + Math.sin(i * 0.73) * 2
                            : 5 + Math.sin(i / 900) * 0.08,
                ),
              );
            state.chartSeries = cs;
            state.settings.activeView = 'monitor';
            state.windowVisible = true;
            state.settings.recordingTempSpool = false;
            state.isRecording = true;
            state.chartWindow = { mode: 'full', min: 0, max: cs.x.at(-1), duration: cs.x.at(-1) };
            for (let s = 0; s < 8; s++) {
              chart.setSeriesVisible(s, true);
              chart.setSeriesFill(s, s < fillChannels ? 12 : 0);
            }
            chart.syncChartSeries();
            chart.setChartXWindow(0, cs.x.at(-1));
            chart.updateCharts('live');
            const frame = () => new Promise(requestAnimationFrame),
              settle = async () => {
                let i = 0;
                do {
                  await new Promise((r) => setTimeout(r, 2));
                  if (i++ > 7500) throw Error('prepare timeout');
                } while (document.getElementById('main-chart').getAttribute('aria-busy') === 'true');
                for (let j = 0; j < 3; j++) await frame();
              };
            await settle();
            let draws = [];
            const hook = () =>
              draws.push({
                at: performance.now(),
                ...(state.mainChart.__chartProjection ?? { quality: 'fine' }),
                timing: structuredClone(window.__WITRN_PERF__().charts.main.last),
              });
            state.mainChart.hooks.draw.push(hook);
            const cases = [];
            try {
              for (let run = 0; run < runs; run++) {
                chart.setRangeDragging(false);
                state.isRecording = true;
                state.chartWindow.mode = 'full';
                chart.setChartXWindow(0, cs.x.at(-1));
                chart.updateCharts('live');
                await settle();
                chart.setRangeDragging(true);
                chart.setRangeDragging(false);
                index.reset();
                state.isRecording = false;
                draws = [];
                const started = performance.now();
                chart.updateCharts('maintenance', { force: false, reason: 'pause' });
                await settle();
                if (variant === 'current') assertNative(draws[0]?.quality === 'coarse', 'coarse first frame');
                assertNative(
                  draws.filter((d, i, a) => d.quality === 'fine' && a[i - 1]?.quality !== 'fine').length === 1,
                  'one fine upgrade',
                );
                const indexBytes = index.byteLength;
                assertNative(
                  indexBytes ===
                    (n === 1_000_000
                      ? variant === 'baseline' && baselineFormat === 'legacy'
                        ? 8323072
                        : 6242304
                      : variant === 'baseline' && baselineFormat === 'legacy'
                        ? 29097984
                        : 21823488),
                  'embedded index version',
                );
                const coarse = draws[0].at - started,
                  fine = draws.find((d) => d.quality === 'fine').at - started;
                const coldDraws = draws;
                state.isRecording = true;
                chart.updateCharts('live');
                await settle();
                state.isRecording = false;
                draws = [];
                const warmStarted = performance.now();
                chart.updateCharts('maintenance', { force: false, reason: 'pause' });
                await settle();
                assertNative(draws[0]?.quality === 'fine', 'warm first frame must be fine');
                const warmMs = draws[0].at - warmStarted,
                  warmDraws = draws;
                draws = coldDraws;
                const frameIntervals = [];
                let last = performance.now();
                chart.setRangeDragging(true);
                for (let j = 0; j < 12; j++) {
                  const mid = Math.floor(n / 2) + j * 13,
                    count = Math.round(12000 * (2000 / 12000) ** (j / 11)),
                    min = cs.x.at(mid),
                    max = cs.x.at(mid + count - 1);
                  state.chartWindow = { mode: 'frozen', min, max, duration: max - min };
                  chart.setChartXWindow(min, max);
                  chart.scheduleChartUpdate('interaction');
                  await frame();
                  const now = performance.now();
                  frameIntervals.push(now - last);
                  last = now;
                }
                chart.setRangeDragging(false);
                chart.updateCharts('interaction', { force: false, reason: 'release' });
                await settle();
                const stable = Array.from(state.mainChart.data[0]);
                chart.updateCharts();
                await settle();
                assertNative(
                  JSON.stringify(stable) === JSON.stringify(Array.from(state.mainChart.data[0])),
                  'stable release',
                );
                state.windowVisible = false;
                chart.handleMonitorHidden();
                await new Promise((r) => setTimeout(r, 10));
                state.windowVisible = true;
                chart.handleMonitorShown();
                chart.updateCharts();
                await settle();
                chart.syncChartSeries();
                chart.updateCharts();
                await settle();
                cases.push({
                  run,
                  coarseMs: coarse,
                  fineMs: fine,
                  warmMs,
                  warmDraws,
                  frameIntervals,
                  indexBytes,
                  draws,
                });
              }
            } finally {
              ExactExtremaIndex.prototype.syncStep = original;
              state.mainChart.hooks.draw.splice(state.mainChart.hooks.draw.indexOf(hook), 1);
              chart.handleMonitorHidden();
            }
            return cases;
            function assertNative(value, message) {
              if (!value) throw Error(message);
            }
          },
          {
            n,
            signal,
            runs: config.runs,
            variant: config.variant,
            baselineFormat: config.baselineFormat,
            fillChannels: config.fillChannels,
          },
        );
        results.cases.push({ ratio, dpi, n, signal, runs: cases });
        await writeFile(resolve(output, 'webview.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ ratio, n, signal, runs: cases.length }));
      }
  } finally {
    if (browser) await browser.close();
    child.kill();
  }
}
results.sourceStable = before.sourceSha256 === (await provenance()).sourceSha256;
assert.ok(results.sourceStable);
assert.deepEqual(results.errors, []);
await writeFile(resolve(output, 'webview.json'), JSON.stringify(results, null, 2));
