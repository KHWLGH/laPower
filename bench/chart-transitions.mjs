import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../tools/showcase/server.mjs';
import { environment, options, provenance, quantiles } from './common.mjs';

const config = options(process.argv.slice(2), {
  sizes: [100_000, 300_000, 1_000_000, 3_600_000],
  runs: 3,
  output: 'bench/results/chart-research',
  channel: 'msedge',
  baselineRef: '41848bf636d4f19f1bb5415bfcd280c52115cf8e',
  signal: 'normal',
  baselineDir: 'bench/results/chart-ordered-before',
  ratio: 2,
  channels: 3,
  filled: 1,
  variants: 'baseline,current,current-cold',
});
assert.ok(['normal', 'alternating'].includes(config.signal), 'signal must be normal or alternating');
if (config.sizes.some((n) => n <= 50_001)) throw new Error('Transition fixtures require more than 50001 samples');
const output = resolve(config.output);
const variants = config.variants.split(',');
const awaitSource = Object.fromEntries(
  await Promise.all(
    ['chart.js', 'chart-extrema.js', 'chart-buckets.js'].map(async (file) => [
      file,
      await readFile(resolve(config.baselineDir, 'src', file), 'utf8'),
    ]),
  ),
);
const baselineSources = Object.fromEntries(
  ['chart.js', 'chart-extrema.js', 'chart-buckets.js'].map((file) => [
    file,
    config.baselineDir
      ? awaitSource[file]
      : execFileSync('git', ['show', `${config.baselineRef}:src/${file}`], { encoding: 'utf8' }),
  ]),
);
await mkdir(output, { recursive: true });
const server = await startServer();
const browser = await chromium.launch({ channel: config.channel, headless: true }).catch(async (error) => {
  await server.close();
  throw error;
});
const result = {
  config,
  environment: environment(),
  provenance: await provenance(),
  browser: browser.version(),
  date: new Date().toISOString(),
  cases: [],
  limitations:
    'Synthetic 1 ms data; real chart.js and uPlot, headless browser, no HID or native disk I/O. Baseline loads the pre-implementation uncommitted snapshot including chart-buckets; fingerprints are saved alongside the snapshot. All fixtures first settle auxiliaries, reset the index, then repaint the unchanged live projection. Current waits for production background warmup; baseline has no warmup and waits 750 ms. Current-cold resets again immediately before pause. Warmup cost is reported separately. Chart latency is through draw and three subsequent rAFs, not physical display presentation. Repeats use fresh contexts in one process, not independent host runs.',
};
try {
  for (let run = 0; run < config.runs; run++) {
    const cases = config.sizes.flatMap((n) => variants.map((variant) => [variant, n]));
    if (run % 2) cases.reverse();
    for (const [variant, n] of cases) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: config.ratio,
      });
      const page = await context.newPage();
      if (variant === 'baseline')
        await page.route(/\/(chart|chart-extrema|chart-buckets)\.js$/, async (route) => {
          const file = new URL(route.request().url()).pathname.split('/').at(-1);
          await route.fulfill({
            contentType: 'text/javascript',
            body: baselineSources[file],
          });
        });
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(`${server.url}/app/?capture=1&theme=light&language=zh-CN`);
      await page.waitForFunction(() => !document.getElementById('btn-connect').disabled);
      await page.evaluate(() => window.__SHOWCASE__.freeze());
      await page.locator('#device-select').selectOption('showcase:km003c', { force: true });
      await page.locator('#btn-connect').click();
      await page.waitForFunction(async () => (await import('/state.js')).state.isConnected);
      await page.evaluate(
        async ({ n, variant, signal, channels, filled }) => {
          window.__SHOWCASE__.freeze();
          const { state, emptyChartColumns } = await import('/state.js');
          const chart = await import('/chart.js');
          const diagnostic = await import('/performance-diagnostics.js');
          const data = await import('/data.js');
          const { ExactExtremaIndex } = await import('/chart-extrema.js');
          const indexStep = ExactExtremaIndex.prototype.syncStep;
          window.__indexSteps = [];
          ExactExtremaIndex.prototype.syncStep = function (...args) {
            const started = performance.now();
            const complete = indexStep.apply(this, args);
            window.__indexSteps.push({ ms: performance.now() - started, budget: args[2] });
            return complete;
          };
          const resetIndex = ExactExtremaIndex.prototype.reset;
          ExactExtremaIndex.prototype.reset = function () {
            window.__researchIndex = this;
            return resetIndex.call(this);
          };
          const cs = emptyChartColumns();
          const xs = Float64Array.from({ length: n }, (_, i) => i / 1000);
          const alternating = signal === 'alternating';
          const v = Float64Array.from(xs, (_, i) =>
            alternating ? 5 + Math.sin(i * 0.73) * 2 : 5 + Math.sin(i / 900) * 0.08 + Math.sin(i * 1.71) * 0.002,
          );
          const a = Float64Array.from(xs, (_, i) =>
            alternating ? 1 + Math.sin(i * 0.93) * 0.8 : 1 + Math.sin(i / 350) * 0.25 + Math.sin(i * 2.01) * 0.003,
          );
          const p = Float64Array.from(xs, (_, i) => v[i] * a[i]);
          for (const [key, values] of Object.entries({
            x: xs,
            voltage: v,
            current: a,
            power: p,
            timestamps: Float64Array.from(xs, (x) => 1_700_000_000_000 + x * 1000),
            sampleIntervals: new Float64Array(n).fill(1),
            currentMagnitudes: a,
            temp: Float64Array.from(xs, (_, i) => (alternating ? 20 + Math.sin(i * 1.13) * 15 : NaN)),
            dp: Float64Array.from(xs, (_, i) => (alternating ? 2 + Math.sin(i * 1.03) * 1.5 : 3.3)),
            dn: Float64Array.from(xs, (_, i) => (alternating ? 2 + Math.sin(i * 0.83) * 1.5 : 0.6)),
            cc1: Float64Array.from(xs, (_, i) => (alternating ? 2 + Math.sin(i * 0.53) * 1.5 : 0)),
            cc2: Float64Array.from(xs, (_, i) => (alternating ? 2 + Math.sin(i * 0.43) * 1.5 : 0)),
            recordingSegments: new Float64Array(n).fill(1),
          }))
            cs[key].set(values);
          state.chartSeries = cs;
          state.settings.sampleRate = 1;
          state.settings.recordLimitMb = 8192;
          state.settings.recordingTempSpool = false;
          state.dataIntervalMs = 1;
          state.chartWindow = { mode: 'full', min: 0, max: xs[n - 1], duration: xs[n - 1] };
          for (let i = 0; i < 8; i++) {
            chart.setSeriesVisible(i, i < channels);
            chart.setSeriesFill(i, filled && i < 4 ? 12 : 0);
          }
          data.updateChartEmptyState();
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const frame = () => new Promise((r) => requestAnimationFrame(r));
          window.__research = {
            state,
            chart,
            diagnostic,
            data,
            draws: [],
            projections: [],
            frames: [],
            longTasks: [],
            async settle() {
              const deadline = performance.now() + 15000;
              do {
                await sleep(5);
                if (performance.now() > deadline) throw new Error('Chart preparation timed out');
              } while (document.getElementById('main-chart').getAttribute('aria-busy') === 'true');
              await frame();
              await frame();
              await frame();
            },
            async action(name, action) {
              this.frames.length = this.draws.length = this.longTasks.length = this.projections.length = 0;
              diagnostic.reset();
              const started = performance.now();
              const returned = action();
              const callMs = performance.now() - started;
              await returned;
              await this.settle();
              const ended = performance.now();
              const xs = state.mainChart.data[0];
              let duplicateX = 0;
              for (let i = 1; i < xs.length; i++) if (xs[i] === xs[i - 1]) duplicateX++;
              return {
                name,
                callMs,
                settleMs: ended - started,
                firstDrawMs: this.draws[0] - started,
                finalDetailMs: this.draws[this.projections.findIndex((p) => p.quality === 'fine')] - started,
                projections: this.projections.slice(),
                frameIntervals: this.frames.slice(),
                indexBytes: window.__researchIndex.byteLength,
                draws: this.draws.length,
                displayPoints: xs.length,
                duplicateX,
                frameMaxMs: this.frames.length ? Math.max(...this.frames) : null,
                longTasks: this.longTasks.slice(),
                diagnostics: diagnostic.snapshot().charts.main,
              };
            },
          };
          let last = performance.now();
          const sampleFrame = (now) => {
            window.__research.frames.push(now - last);
            last = now;
            requestAnimationFrame(sampleFrame);
          };
          requestAnimationFrame(sampleFrame);
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              window.__research.longTasks.push({ start: entry.startTime, duration: entry.duration });
          }).observe({ type: 'longtask', buffered: false });
          state.mainChart.hooks.draw.push(() => {
            const r = window.__research;
            r.draws.push(performance.now());
            r.projections.push({
              ...(state.mainChart.__chartProjection ?? { quality: 'fine' }),
              right: state.mainChart.data[0].at(-1),
            });
          });
          chart.syncChartSeries();
          chart.setChartXWindow(0, xs[n - 1]);
          await data.startRecording();
          if (!state.isRecording) throw new Error('Initial fixture recording did not start');
          chart.updateCharts('live');
          await window.__research.settle();
          await sleep(150);
          // Reuse the live buckets with a cold index; only production background
          // work may catch it up. Fixture/auxiliary setup is measured separately.
          window.__researchIndex.reset();
          window.__indexSteps.length = 0;
          window.__research.frames.length = 0;
          const warmStarted = performance.now();
          chart.updateCharts('live');
          if (variant === 'baseline') await sleep(750);
          else {
            const deadline = performance.now() + 15000;
            while (window.__researchIndex.blocks < Math.floor(n / 32)) {
              await sleep(5);
              if (performance.now() > deadline) throw new Error('Background index warmup timed out');
            }
          }
          window.__research.warmup = {
            wallMs: performance.now() - warmStarted,
            steps: window.__indexSteps.length,
            maxStepMs: Math.max(0, ...window.__indexSteps.map((s) => s.ms)),
            maxBudget: Math.max(0, ...window.__indexSteps.map((s) => s.budget ?? 128)),
            frameMaxMs: Math.max(0, ...window.__research.frames),
            blocks: window.__researchIndex.blocks,
          };
          if (variant === 'current-cold') window.__researchIndex.reset();
        },
        { n, variant, signal: config.signal, channels: config.channels, filled: config.filled },
      );
      const actions = [];
      actions.push(
        await page.evaluate(() => window.__research.action('pause', () => window.__research.data.stopRecording())),
      );
      for (const filled of [Boolean(config.filled)])
        actions.push(
          await page.evaluate(
            ({ filled, channels }) =>
              window.__research.action(`gesture-fill-${filled}`, async () => {
                const { chart, state } = window.__research;
                for (let s = 0; s < 8; s++) {
                  chart.setSeriesVisible(s, s < channels);
                  chart.setSeriesFill(s, filled && s < 4 ? 12 : 0);
                }
                chart.setRangeDragging(true);
                for (let frame = 0; frame < 16; frame++) {
                  const count = Math.round(12000 * (2000 / 12000) ** (frame / 15));
                  const mid = Math.floor(state.chartSeries.x.length / 2) + frame * 13;
                  const min = state.chartSeries.x.at(mid),
                    max = state.chartSeries.x.at(mid + count - 1);
                  state.chartWindow = { mode: 'frozen', min, max, duration: max - min };
                  chart.setChartXWindow(min, max);
                  chart.scheduleChartUpdate('interaction');
                  await new Promise(requestAnimationFrame);
                }
                chart.setRangeDragging(false);
                chart.updateCharts('interaction');
              }),
            { filled, channels: config.channels },
          ),
        );
      for (const count of [50_000, 8000, 4000, 2000, 1200, 1000, 800, 256]) {
        actions.push(
          await page.evaluate(
            (count) =>
              window.__research.action(`zoom-${count}`, () => {
                const { chart, state } = window.__research;
                const mid = Math.floor(state.chartSeries.x.length / 2);
                const min = state.chartSeries.x.at(mid),
                  max = state.chartSeries.x.at(mid + count - 1);
                state.chartWindow = { mode: 'frozen', min, max, duration: max - min };
                chart.setChartXWindow(min, max);
                chart.updateCharts('interaction');
              }),
            count,
          ),
        );
        if (run === 0 && n === 300_000 && [4000, 2000, 1200, 1000].includes(count))
          await page.locator('#main-chart').screenshot({ path: resolve(output, `${variant}-zoom-${count}.png`) });
      }
      actions.push(
        await page.evaluate(() =>
          window.__research.action('full', () => {
            const { chart, state } = window.__research;
            state.chartWindow = {
              mode: 'full',
              min: 0,
              max: state.chartSeries.x.at(-1),
              duration: state.chartSeries.x.at(-1),
            };
            chart.setChartXWindow(0, state.chartSeries.x.at(-1));
            chart.updateCharts('interaction');
          }),
        ),
      );
      actions.push(
        await page.evaluate(() =>
          window.__research.action('resume-context-first-refresh', async () => {
            await window.__research.data.startRecording();
            if (!window.__research.state.isRecording)
              throw new Error(
                `Recording did not start: ${JSON.stringify({ connected: window.__research.state.isConnected, points: window.__research.state.chartSeries.x.length, limit: window.__research.state.settings.recordLimitMb })}`,
              );
            window.__research.chart.updateCharts('live');
          }),
        ),
      );
      assert.deepEqual(errors, [], 'Browser page errors');
      for (const action of actions) {
        assert.ok(Number.isFinite(action.firstDrawMs) && action.firstDrawMs >= 0, `${action.name} did not draw`);
        if (variant !== 'baseline' && config.signal === 'normal' && ['zoom-4000', 'zoom-2000'].includes(action.name))
          assert.equal(action.duplicateX, 0);
        if (
          variant !== 'baseline' &&
          config.signal === 'alternating' &&
          ['zoom-4000', 'zoom-2000'].includes(action.name)
        )
          assert.equal(action.duplicateX, 0, 'carrier is unique; ordered candidates remain per-channel');
      }
      const warmup = await page.evaluate(() => window.__research.warmup);
      const item = { run, variant, n, secondsAt1KSPS: n / 1000, warmup, actions, errors };
      result.cases.push(item);
      console.log(
        JSON.stringify({
          run,
          variant,
          n,
          warmup,
          actions: actions
            .filter((a) => ['pause', 'zoom-4000', 'zoom-2000', 'resume-context-first-refresh'].includes(a.name))
            .map(({ name, callMs, firstDrawMs, frameMaxMs, displayPoints, duplicateX }) => ({
              name,
              callMs,
              firstDrawMs,
              frameMaxMs,
              displayPoints,
              duplicateX,
            })),
          errors,
        }),
      );
      await writeFile(resolve(output, 'transitions.json'), JSON.stringify(result, null, 2));
      await context.close();
    }
  }
  result.summary = config.sizes.flatMap((n) =>
    variants.map((variant) => ({
      n,
      variant,
      actions: result.cases
        .find((item) => item.n === n && item.variant === variant)
        .actions.map(({ name }) => {
          const actions = result.cases
            .filter((item) => item.n === n && item.variant === variant)
            .map((item) => item.actions.find((action) => action.name === name));
          return {
            name,
            firstDrawMs: quantiles(actions.map((action) => action.firstDrawMs)),
            finalDetailMs: quantiles(actions.map((action) => action.finalDetailMs).filter(Number.isFinite)),
            frameIntervals: quantiles(actions.flatMap((action) => action.frameIntervals)),
            callMs: quantiles(actions.map((action) => action.callMs)),
            frameMaxMs: quantiles(actions.map((action) => action.frameMaxMs)),
          };
        }),
    })),
  );
  const after = await provenance();
  result.sourceStable = after.sourceSha256 === result.provenance.sourceSha256;
  assert.ok(result.sourceStable, 'Production source changed during the benchmark');
  await writeFile(resolve(output, 'transitions.json'), JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await server.close();
}
