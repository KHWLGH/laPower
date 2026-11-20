/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHeadlessHarness } from '../tools/showcase/headless.mjs';
import { options, provenance } from './common.mjs';

const config = options(process.argv.slice(2), {
  output: 'bench/results/chart-zoom/current.json',
  channel: 'msedge',
  sizes: [200_000, 3_600_000],
  ratios: '1,1.5',
  runs: 2,
  append: false,
});
const source = await provenance();
await using harness = await createHeadlessHarness({ channel: config.channel, timeout: 30_000 });
const results = [];
const percentile = (items, p) => [...items].sort((a, b) => a - b)[Math.max(0, Math.ceil(items.length * p) - 1)] ?? 0;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

for (const ratio of config.ratios.split(',').map(Number)) {
  for (const n of config.sizes) {
    await using app = await harness.openApp({
      theme: 'dark',
      context: { viewport: { width: 1520, height: 920 }, deviceScaleFactor: ratio },
    });
    const { page } = app;
    await page.evaluate(
      async ({ n, append }) => {
        const { state, emptyChartColumns, setChartColumns } = await import('/state.js');
        const chart = await import('/chart.js');
        const data = await import('/data.js');
        const cols = emptyChartColumns();
        const fields = ['voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2'];
        for (const [i, key] of fields.entries()) {
          cols[key].set(
            Float64Array.from({ length: n }, (_, j) => {
              const wave = 0.55 * Math.sin(j * (0.71 + i * 0.05)) + 0.35 * Math.sin(j / (980 + 30 * i));
              return i === 1 ? -3 + wave : i < 4 ? 8 + i + wave : 1.5 + i * 0.55 + wave;
            }),
          );
        }
        cols.x.set(Float64Array.from({ length: n }, (_, i) => i / 1000));
        if (append) {
          for (const key of ['sampleIntervals', 'recordingSegments']) cols[key].set(new Float64Array(n).fill(1));
          cols.timestamps.set(Float64Array.from({ length: n }, (_, i) => Date.now() - n + i));
        }
        setChartColumns(cols);
        for (let i = 0; i < fields.length; i++) {
          chart.setSeriesVisible(i, true);
          if (i < 4) chart.setSeriesFill(i, 18);
        }
        chart.setChartFillEnabled(true);
        state.__setRangeControlsEnabled(true);
        data.updateChartEmptyState();
        chart.syncChartSeries();
        data.updateChartRange();
        chart.updateCharts('maintenance');
        const meter = { state, chart, data, frames: [], draws: [], collecting: false, lastFrame: null, timer: null };
        window.__zoomBench = meter;
        state.mainChart.hooks.draw.push(() => {
          if (meter.collecting) {
            meter.draws.push({
              at: performance.now(),
              x: state.mainChart.scales.x.min,
              width: state.mainChart.scales.x.max - state.mainChart.scales.x.min,
              timing: window.__WITRN_PERF__().charts.main.last,
            });
          }
        });
        function measure(at) {
          if (meter.collecting && meter.lastFrame !== null) meter.frames.push(at - meter.lastFrame);
          meter.lastFrame = at;
          requestAnimationFrame(measure);
        }
        requestAnimationFrame(measure);
      },
      { n, append: config.append },
    );
    await app.waitForCharts();
    assert.equal(
      await page.evaluate(() => window.__zoomBench.state.mainChart.series.slice(1).filter((s) => s.show).length),
      8,
    );
    const cdp = await app.context.newCDPSession(page);
    for (const scenario of ['wheel', 'navigator', 'recording-wheel']) {
      for (let run = 0; run < config.runs; run++) {
        await page.evaluate(
          ({ scenario, n }) => {
            const { state, chart, data } = window.__zoomBench;
            state.isRecording = scenario === 'recording-wheel';
            state.settings.rangeStart = scenario === 'navigator' ? 0 : 250;
            state.settings.rangeEnd = scenario === 'navigator' ? 1000 : 250 + Math.ceil((20_000 / n) * 1000);
            state.chartWindow = { mode: 'full', min: 0, max: 0, duration: 0 };
            data.updateChartRange();
            chart.updateCharts('maintenance');
          },
          { scenario, n },
        );
        await app.waitForCharts();
        const plot = await page.locator('#main-chart .u-over').boundingBox();
        const slider = await page.locator('.dual-slider-container').boundingBox();
        const end = await page.locator('#range-handle-end').boundingBox();
        const middle = end.y + end.height / 2;
        if (scenario === 'navigator') {
          await page.mouse.move(end.x + end.width / 2 - 4, middle);
          await page.mouse.down();
          assert.equal(await page.evaluate(() => window.__zoomBench.state.__rangeDragging), true, 'handle hit');
        }
        const initialPoints = await page.evaluate((append) => {
          const meter = window.__zoomBench;
          meter.frames = [];
          meter.draws = [];
          meter.collecting = true;
          meter.lastFrame = null;
          const { state, data } = meter;
          if (append && state.isRecording) {
            state.settings.sampleRate = 1;
            state.recordingStartTime = Date.now();
            state.recordingBaseSeconds = state.chartSeries.x.at(-1) + 0.001;
            state.isTempConnected = true;
            state.settings.tempSource = 'device';
            meter.timer = setInterval(() => {
              for (let i = 0; i < 20; i++) {
                const v = Math.sin(state.chartSeries.x.length * 0.73);
                data.addDataPoint({
                  voltage: 8 + v,
                  current: -3 + v,
                  power: 10 + v,
                  temperature: 11 + v,
                  dp: 2 + v,
                  dn: 2.5 + v,
                  cc1: 3 + v,
                  cc2: 3.5 + v,
                });
              }
            }, 20);
          }
          return state.chartSeries.x.length;
        }, config.append);
        const started = performance.now();
        const steps = 40;
        for (let i = 0; i < steps; i++) {
          if (scenario === 'navigator') {
            const ratio = 0.08 + 0.88 * (1 - i / (steps - 1));
            await page.mouse.move(slider.x + slider.width * ratio, middle);
          } else {
            await cdp.send('Input.dispatchMouseEvent', {
              type: 'mouseWheel',
              x: plot.x + plot.width * 0.47,
              y: plot.y + plot.height * 0.5,
              deltaY: i < steps / 2 ? -90 : 90,
              deltaX: 0,
            });
          }
          await sleep(Math.max(0, started + (i + 1) * 22 - performance.now()));
        }
        if (scenario === 'navigator') await page.mouse.up();
        await sleep(180);
        const { frames, draws, points, dragging, endPermille } = await page.evaluate(() => {
          const meter = window.__zoomBench;
          meter.collecting = false;
          clearInterval(meter.timer);
          return {
            frames: meter.frames,
            draws: meter.draws,
            points: meter.state.chartSeries.x.length,
            dragging: meter.state.__rangeDragging,
            endPermille: meter.state.settings.rangeEnd,
          };
        });
        await app.waitForCharts();
        assert.ok(!dragging, `${scenario}: gesture did not settle`);
        if (scenario === 'navigator') assert.ok(Math.abs(endPermille - 80) <= 2, 'release keeps the final range');
        if (config.append && scenario === 'recording-wheel') assert.ok(points - initialPoints > 500);
        assert.ok(draws.length > 4, `${scenario}: insufficient draws (${draws.length})`);
        const moving = draws.filter((d, i) => !i || d.x !== draws[i - 1].x || d.width !== draws[i - 1].width);
        const gaps = moving.slice(1).map((d, i) => d.at - moving[i].at);
        const result = {
          n,
          ratio,
          scenario,
          run,
          appended: points - initialPoints,
          frameP95: percentile(frames, 0.95),
          frameMax: Math.max(...frames),
          drawGapP95: percentile(gaps, 0.95),
          drawGapMax: Math.max(0, ...gaps),
          visitedWindows: moving.length,
          durationMs: performance.now() - started,
          prepP95: percentile(
            draws.map((d) => d.timing?.prepareMs ?? 0),
            0.95,
          ),
          drawP95: percentile(
            draws.map((d) => d.timing?.drawMs ?? 0),
            0.95,
          ),
          inputP95: percentile(
            draws.map((d) => d.timing?.requestToDrawMs ?? 0),
            0.95,
          ),
          uploadP95: percentile(
            draws.map((d) => d.timing?.stages?.bitmapCount ?? 0),
            0.95,
          ),
        };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
    assert.deepEqual((await app.diagnostics()).errors, []);
  }
}

const output = resolve(config.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ config, source, browser: harness.browser.version(), results }, null, 2));
