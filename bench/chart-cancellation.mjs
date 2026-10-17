/** Native WebView2 cancellation check; holds background tasks after a complete coarse draw. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { options, provenance, sha256 } from './common.mjs';

const config = options(process.argv.slice(2), {
  exe: 'target/debug/lapower.exe',
  output: 'bench/results/chart-followup-cancellation',
  sizes: [1_000_000, 3_600_000],
  port: 19528,
});
const output = resolve(config.output),
  before = await provenance();
await mkdir(output, { recursive: true });
const result = {
  config,
  cases: [],
  provenance: before,
  limitations: 'Actual WebView2; synthetic source, held scheduler tasks, no physical meter or presentation timestamps.',
};
const child = spawn(resolve(config.exe), [], {
  windowsHide: true,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${config.port}` },
  stdio: 'ignore',
});
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${config.port}/json/version`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.port}`);
  const page = browser.contexts()[0].pages()[0];
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.waitForFunction(() => document.querySelector('#main-chart canvas'));
  const embedded = await page.evaluate(async () => {
    const hashes = {};
    for (const file of ['chart.js', 'chart-fill.js', 'chart-buckets.js', 'chart-extrema.js']) {
      const bytes = await (await fetch('./' + file)).arrayBuffer();
      hashes[file] = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
        v.toString(16).padStart(2, '0'),
      ).join('');
    }
    return hashes;
  });
  for (const [file, hash] of Object.entries(embedded)) assert.equal(hash, sha256(await readFile(resolve('src', file))));
  result.embedded = embedded;
  for (const n of config.sizes) {
    const cases = await page.evaluate(async (n) => {
      const { state, emptyChartColumns } = await import('./state.js'),
        chart = await import('./chart.js'),
        { ExactExtremaIndex } = await import('./chart-extrema.js');
      const originalSync = ExactExtremaIndex.prototype.syncStep,
        originalPostTask = scheduler.postTask;
      let index,
        held = [],
        draws = [];
      ExactExtremaIndex.prototype.syncStep = function (...args) {
        index = this;
        return originalSync.apply(this, args);
      };
      const hook = () => draws.push(structuredClone(state.mainChart.__chartProjection));
      state.mainChart.hooks.draw.push(hook);
      const frame = () => new Promise(requestAnimationFrame),
        wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const settle = async () => {
        const start = performance.now();
        do {
          await wait(2);
          if (performance.now() - start > 15000) throw Error('settle timeout');
        } while (document.getElementById('main-chart').getAttribute('aria-busy') === 'true');
        for (let i = 0; i < 3; i++) await frame();
      };
      const release = () => {
        scheduler.postTask = originalPostTask;
        for (const resolve of held.splice(0)) resolve();
      };
      const cs = emptyChartColumns();
      for (const [key, col] of Object.entries(cs))
        col.set(
          Float64Array.from({ length: n }, (_, i) =>
            key === 'x' ? i / 1000 : key === 'sampleIntervals' ? 1 : 2 + Math.sin(i / 300),
          ),
        );
      state.chartSeries = cs;
      state.settings.activeView = 'monitor';
      state.settings.recordingTempSpool = false;
      chart.syncChartSeries();
      const results = [];
      try {
        for (const action of ['window', 'resume', 'hidden', 'source']) {
          state.windowVisible = true;
          state.isRecording = true;
          state.chartWindow = { mode: 'full', min: 0, max: cs.x.at(-1), duration: cs.x.at(-1) };
          chart.setChartXWindow(0, cs.x.at(-1));
          chart.updateCharts('live');
          await settle();
          chart.setRangeDragging(true);
          chart.setRangeDragging(false);
          index.reset();
          originalSync.call(
            index,
            ['voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2'].map((k) => cs[k]),
            n,
            128,
          );
          const initialBlocks = index.blocks;
          scheduler.postTask = () => new Promise((resolve) => held.push(resolve));
          state.isRecording = false;
          draws = [];
          chart.updateCharts('maintenance', { force: false, reason: 'pause' });
          const start = performance.now();
          while (!draws.length) {
            await wait(2);
            if (performance.now() - start > 15000) throw Error('coarse timeout');
          }
          const coarse = draws[0],
            heldAtAction = held.length;
          if (coarse.quality !== 'coarse' || !heldAtAction) throw Error('cold work was not held after coarse draw');
          draws = [];
          let replacement;
          if (action === 'window') {
            state.chartWindow = { mode: 'frozen', min: 1, max: 1.01, duration: 0.01 };
            chart.setChartXWindow(1, 1.01);
            chart.updateCharts('interaction');
          } else if (action === 'resume') {
            state.isRecording = true;
            chart.updateCharts('live', { force: false });
          } else if (action === 'hidden') {
            state.windowVisible = false;
            chart.handleMonitorHidden();
          } else {
            replacement = emptyChartColumns();
            for (const [key, col] of Object.entries(replacement)) col.set(cs[key].copyRange(0, 2));
            state.chartSeries = replacement;
            chart.syncChartSeries();
            chart.setChartXWindow(null, null);
            chart.updateCharts();
          }
          release();
          await wait(100);
          await frame();
          if (action === 'hidden' && (index.blocks !== initialBlocks || draws.length))
            throw Error('hidden work published');
          if (action === 'window' && (index.blocks !== initialBlocks || state.mainChart.scales.x.max !== 1.01))
            throw Error('old window published');
          if (
            action === 'source' &&
            (index.blocks !== 0 || state.chartSeries !== replacement || state.mainChart.data[0].length !== 2)
          )
            throw Error('old source published');
          if (action === 'resume' && draws.some((d) => d.ppb < coarse.ppb))
            throw Error('obsolete review detail published during recording');
          results.push({ action, initialBlocks, blocksAfter: index.blocks, heldAtAction, coarse, draws });
          chart.handleMonitorHidden();
          state.isRecording = false;
          state.chartSeries = cs;
          chart.syncChartSeries();
        }
      } finally {
        release();
        chart.handleMonitorHidden();
        ExactExtremaIndex.prototype.syncStep = originalSync;
        state.mainChart.hooks.draw.splice(state.mainChart.hooks.draw.indexOf(hook), 1);
      }
      return results;
    }, n);
    result.cases.push({ n, cases });
    console.log(JSON.stringify({ n, actions: cases.map((c) => c.action) }));
  }
  result.sourceStable = before.sourceSha256 === (await provenance()).sourceSha256;
  result.errors = errors;
  assert.ok(result.sourceStable);
  assert.deepEqual(errors, []);
} finally {
  await writeFile(resolve(output, 'cancellation.json'), JSON.stringify(result, null, 2));
  await browser?.close();
  child.kill();
}
