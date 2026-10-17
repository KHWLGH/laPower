import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../tools/showcase/server.mjs';

import { options, provenance } from './common.mjs';

const config = options(process.argv.slice(2), {
  output: 'bench/results/chart-raster',
  baselineRef: '41848bf636d4f19f1bb5415bfcd280c52115cf8e',
  channel: 'msedge',
  baselineDir: 'bench/results/chart-ordered-before',
});
const sourceBefore = await provenance();
const snapshot = Object.fromEntries(
  await Promise.all(
    ['chart.js', 'chart-extrema.js', 'chart-buckets.js'].map(async (file) => [
      file,
      await readFile(resolve(config.baselineDir, 'src', file), 'utf8'),
    ]),
  ),
);
const baseline = Object.fromEntries(
  ['chart.js', 'chart-extrema.js', 'chart-buckets.js'].map((file) => [
    file,
    config.baselineDir
      ? snapshot[file]
      : execFileSync('git', ['show', `${config.baselineRef}:src/${file}`], { encoding: 'utf8' }),
  ]),
);
const output = resolve(config.output);
await mkdir(output, { recursive: true });
const server = await startServer();
const browser = await chromium.launch({ channel: config.channel, headless: true });
const results = [];
try {
  for (const variant of ['before', 'current']) {
    for (const ratio of [1, 1.25, 1.5, 2]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: ratio });
      const page = await context.newPage();
      if (variant === 'before')
        await page.route(/\/(chart|chart-extrema|chart-buckets)\.js$/, async (route) => {
          const file = new URL(route.request().url()).pathname.split('/').at(-1);
          await route.fulfill({ contentType: 'text/javascript', body: baseline[file] });
        });
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(`${server.url}/app/?capture=1&theme=light&language=zh-CN`);
      await page.waitForFunction(() => !document.getElementById('btn-connect').disabled);
      await page.evaluate(async () => {
        window.__SHOWCASE__.freeze();
        const { state, emptyChartColumns } = await import('/state.js');
        const chart = await import('/chart.js');
        const { updateChartEmptyState } = await import('/data.js');
        const cols = emptyChartColumns();
        const n = 100_000;
        for (const [key, col] of Object.entries(cols))
          col.set(
            Float64Array.from({ length: n }, (_, i) =>
              key === 'x' ? i / 1000 : key === 'voltage' ? 5 + Math.sin(i / 20) * 2 : key === 'temp' ? NaN : 1,
            ),
          );
        state.chartSeries = cols;
        state.isRecording = false;
        for (let i = 1; i < 8; i++) chart.setSeriesVisible(i, false);
        chart.setSeriesFill(0, 0);
        chart.syncChartSeries();
        updateChartEmptyState();
        window.__raster = { state, chart, draws: [] };
        state.mainChart.hooks.draw.push(() => window.__raster.draws.push(performance.now()));
      });
      for (const count of [12000, 8000, 4000, 2000, 1200, 1000]) {
        const timing = await page.evaluate(async (count) => {
          const { state, chart } = window.__raster;
          const min = state.chartSeries.x.at(50000),
            max = state.chartSeries.x.at(50000 + count - 1);
          state.chartWindow = { mode: 'frozen', min, max, duration: max - min };
          chart.setChartXWindow(min, max);
          window.__raster.draws.length = 0;
          const started = performance.now();
          chart.updateCharts('interaction');
          const deadline = performance.now() + 15000;
          do {
            await new Promise((r) => setTimeout(r, 5));
            if (performance.now() > deadline) throw new Error('timeout');
          } while (document.getElementById('main-chart').getAttribute('aria-busy') === 'true');
          for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
          return { firstDrawMs: window.__raster.draws[0] - started, draws: window.__raster.draws.length };
        }, count);
        const stats = await page.evaluate(() => {
          const u = window.__raster.state.mainChart,
            b = u.bbox;
          const w = Math.floor(b.width),
            h = Math.floor(b.height);
          const pixels = u.ctx.getImageData(Math.round(b.left), Math.round(b.top), w, h).data;
          const hex = Number.parseInt(u.series[1].stroke(u, 1).slice(1), 16);
          const target = [hex >>> 16, (hex >>> 8) & 255, hex & 255];
          const mask = new Uint8Array(w * h);
          let colored = 0;
          for (let y = 3; y < h - 3; y++)
            for (let x = 3; x < w - 3; x++) {
              const i = y * w + x,
                k = i * 4;
              if (target.every((v, c) => Math.abs(pixels[k + c] - v) < 18)) {
                mask[i] = 1;
                colored++;
              }
            }
          const components = [];
          const queue = new Int32Array(w * h);
          for (let i = 0; i < mask.length; i++)
            if (mask[i]) {
              let head = 0,
                tail = 1;
              queue[0] = i;
              mask[i] = 0;
              while (head < tail) {
                const j = queue[head++],
                  x = j % w,
                  y = Math.floor(j / w);
                for (let dy = -1; dy <= 1; dy++)
                  for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx,
                      ny = y + dy,
                      k = ny * w + nx;
                    if (nx >= 0 && nx < w && ny >= 0 && ny < h && mask[k]) {
                      mask[k] = 0;
                      queue[tail++] = k;
                    }
                  }
              }
              components.push(tail);
            }
          components.sort((a, b) => b - a);
          return {
            width: w,
            height: h,
            points: u.data[0].length,
            colored,
            components: components.length,
            smallComponents: components.filter((n) => n <= 20).length,
            largest: components[0],
          };
        });
        results.push({ variant, ratio, count, ...timing, ...stats });
        console.log(JSON.stringify(results.at(-1)));
        if ([4000, 2000].includes(count))
          await page.locator('#main-chart').screenshot({ path: resolve(output, `${variant}-${ratio}-${count}.png`) });
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  await writeFile(
    resolve(output, 'results.json'),
    JSON.stringify(
      {
        config,
        provenance: sourceBefore,
        sourceStable: sourceBefore.sourceSha256 === (await provenance()).sourceSha256,
        browser: browser.version(),
        limitations:
          'Synthetic steep sine, one channel, no fill. Connected components select near-stroke RGB pixels and omit a 3px boundary; antialiasing can leave tiny components. This is a rendering diagnostic, not a semantic point count or hardware test.',
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await server.close();
}
