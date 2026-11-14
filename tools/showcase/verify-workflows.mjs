/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PDOS } from './scenario.js';
import { startServer } from './server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cases = {
  'recording-100': (page) => recording(page, 10),
  'recording-1000': (page) => recording(page, 1),
  'chart-idle-resize': chartIdleResize,
  'range-worker': rangeWorker,
  'pd-projection': pdProjection,
  'protocol-control': protocolControl,
};
const options = { output: 'output/browser-tests', channel: undefined, cases: Object.keys(cases) };
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('npm run test:browser -- [--case name,name] [--channel chromium|msedge|chrome] [--output directory]');
  console.log(`Cases: ${Object.keys(cases).join(', ')}`);
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  const [flag, value] = args.slice(i, i + 2);
  if (!value || !['--case', '--channel', '--output'].includes(flag)) throw new Error(`Invalid option: ${flag}`);
  if (flag === '--output') options.output = value;
  if (flag === '--channel') {
    if (!['chromium', 'msedge', 'chrome'].includes(value)) throw new Error(`Invalid browser channel: ${value}`);
    options.channel = value === 'chromium' ? undefined : value;
  }
  if (flag === '--case') {
    options.cases = [...new Set(value.split(','))];
    for (const name of options.cases) if (!cases[name]) throw new Error(`Unknown case: ${name}`);
  }
}

async function frames(page, count = 3) {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
  }, count);
}

async function chartSettled(page) {
  await frames(page);
  await page.waitForFunction(async () => {
    const { state } = await import('/state.js');
    const main = document.getElementById('main-chart');
    const nav = document.getElementById('navigator-chart');
    return (
      main.getAttribute('aria-busy') !== 'true' &&
      state.mainChart.width === main.clientWidth &&
      state.mainChart.height === main.clientHeight &&
      state.navigatorChart.width === nav.clientWidth &&
      state.navigatorChart.height === nav.clientHeight
    );
  });
  await frames(page);
}

async function connect(page) {
  await page.locator('#device-select').selectOption('showcase:km003c', { force: true });
  await page.locator('#btn-connect').click();
  await page.waitForFunction(
    () => window.__SHOWCASE__.diagnostics().connected && !document.getElementById('btn-record-toggle').disabled,
  );
}

async function recording(page, interval) {
  await connect(page);
  await page.locator('#sample-rate').selectOption(String(interval));
  await page.waitForFunction(async (ms) => (await import('/state.js')).state.settings.sampleRate === ms, interval);
  await page.locator('#btn-record-toggle').click();
  await page.waitForFunction(() => window.__SHOWCASE__.diagnostics().segment > 0);
  await page.evaluate(() => window.__SHOWCASE__.advance(10_000));
  await page.locator('#btn-record-toggle').click();
  await page.waitForFunction(async () => !(await import('/state.js')).state.isRecording);
  await chartSettled(page);
  const result = await page.evaluate(async () => {
    const { state } = await import('/state.js');
    const { deviceStream } = await import('/device-stream.js');
    await deviceStream.settle();
    const { captureCsvSnapshot } = await import('/csv.js');
    const { formatCsvChunks, parseCsv } = await import('/csv-codec.js');
    const { captureRangeStatsSnapshot, computeRangeStatsSync } = await import('/range-stats.js');
    const text = [
      ...formatCsvChunks(captureCsvSnapshot({ withTemp: true, withDeviceInfo: true, withMarkers: true })),
    ].join('');
    const parsed = parseCsv(text, { fallbackStartTime: 0 });
    for (const [key, column] of Object.entries(parsed.columns)) {
      const original = state.chartSeries[key];
      if (column.length !== original.length) throw new Error(`CSV length mismatch: ${key}`);
      for (let i = 0; i < column.length; i++)
        if (!Object.is(column.valueAt(i), original.valueAt(i))) throw new Error(`CSV mismatch: ${key}/${i}`);
    }
    const stats = (columns) => {
      const {
        columns: _source,
        revision: _revision,
        ...values
      } = computeRangeStatsSync(captureRangeStatsSnapshot(columns, 0, columns.x.length - 1, 2));
      return values;
    };
    if (JSON.stringify(stats(parsed.columns)) !== JSON.stringify(stats(state.chartSeries)))
      throw new Error('CSV statistics or energy changed');
    const stream = deviceStream.diagnostics();
    return { rows: state.chartSeries.x.length, stream, source: window.__SHOWCASE__.diagnostics() };
  });
  assert.equal(result.rows, 10_000 / interval, 'every simulated recording sample reaches the CSV');
  assert.equal(result.stream.failed, false);
  assert.equal(result.stream.streamErrors, 0);
  assert.equal(result.stream.seq, result.source.seq, 'pause consumes the final batch');
  assert.equal(result.source.acknowledged, result.source.seq, 'producer receives the consumption ACK');
  return result;
}

async function seed(page, count = 100_000) {
  await page.evaluate(async (count) => {
    const { state, emptyChartColumns, setChartColumns } = await import('/state.js');
    const chart = await import('/chart.js');
    const columns = emptyChartColumns();
    for (const [channel, [key, column]] of Object.entries(columns).entries()) {
      column.set(
        Float64Array.from({ length: count }, (_, i) =>
          key === 'x'
            ? Math.floor(i / 2) / 1000
            : key === 'timestamps'
              ? 1_700_000_000_000 + i
              : key === 'sampleIntervals' || key === 'recordingSegments'
                ? 1
                : i % 211 === 0
                  ? NaN
                  : channel + Math.sin(i / 200 + channel) * 0.6,
        ),
      );
    }
    setChartColumns(columns);
    state.isRecording = false;
    state.chartWindow = { mode: 'full', min: 0, max: columns.x.at(-1), duration: columns.x.at(-1) };
    chart.syncChartSeries();
    chart.setChartXWindow(0, columns.x.at(-1));
    chart.updateCharts();
    (await import('/data.js')).updateChartEmptyState();
  }, count);
  await chartSettled(page);
}

async function chartIdleResize(page) {
  await seed(page);
  // Wait beyond calibration, then reset the ring so a saturated ring cannot hide a live loop.
  await frames(page, 48);
  await page.evaluate(async () => (await import('/performance-diagnostics.js')).reset());
  await frames(page, 12);
  const idle = await page.evaluate(() => window.__WITRN_PERF__());
  assert.equal(idle.frames.count, 0, 'idle telemetry must stop requesting frames');
  await page.evaluate(async () => {
    const { BLOCK_SIZE, ExactExtremaIndex } = await import('/chart-extrema.js');
    const original = ExactExtremaIndex.prototype.syncStep;
    window.__indexRows = 0;
    ExactExtremaIndex.prototype.syncStep = function (...args) {
      const before = this.blocks;
      const result = original.apply(this, args);
      window.__indexRows += Math.max(0, this.blocks - before) * BLOCK_SIZE;
      return result;
    };
    window.__restoreIndex = () => {
      ExactExtremaIndex.prototype.syncStep = original;
    };
  });
  const data = () =>
    page.evaluate(async () => {
      const { state } = await import('/state.js');
      return [state.mainChart.data, state.navigatorChart.data].map((chart) =>
        chart.map((column) => Array.from(column)),
      );
    });
  const before = await data();
  const pixels = async (label) => {
    const hashes = [];
    for (const id of ['main-chart', 'navigator-chart']) {
      const png = await page
        .locator(`#${id} canvas`)
        .first()
        .evaluate((canvas) => canvas.toDataURL('image/png'));
      const image = Buffer.from(png.split(',')[1], 'base64');
      await writeFile(resolve(output, `chart-idle-resize-${label}-${id}.png`), image);
      hashes.push(createHash('sha256').update(image).digest('hex'));
    }
    return hashes;
  };
  const beforePixels = await pixels('before');
  try {
    for (const width of [1100, 1400, 1000, 1360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await chartSettled(page);
    }
    assert.deepEqual(await data(), before, 'returning to the same size preserves both chart projections');
    assert.deepEqual(await pixels('after'), beforePixels, 'returning to the same size preserves both chart bitmaps');
    const scannedRows = await page.evaluate(() => window.__indexRows);
    assert.equal(scannedRows, 0, 'resizing reuses the completed history index');
    return {
      rows: 100_000,
      resizes: 5,
      indexedRowsDuringResize: scannedRows,
      idleFrames: idle.frames.count,
      chartPngSha256: beforePixels,
    };
  } finally {
    await page.evaluate(() => window.__restoreIndex());
  }
}

async function rangeWorker(page) {
  await seed(page);
  return page.evaluate(async () => {
    const { state } = await import('/state.js');
    const { captureRangeStatsSnapshot, computeRangeStatsSync } = await import('/range-stats.js');
    const { computeRangeStatsBackground, terminateRangeStatsWorker } = await import('/range-stats-background.js');
    terminateRangeStatsWorker();
    const Original = window.Worker;
    const audit = { workers: 0, chunks: 0, largestRows: 0, largestTransferBytes: 0 };
    let abortChunk = null;
    window.Worker = class extends Original {
      constructor(url, options) {
        super(url, options);
        audit.workers++;
      }
      postMessage(message, transfer) {
        if (message.type === 'chunk') {
          audit.chunks++;
          audit.largestRows = Math.max(audit.largestRows, message.columns.x.length);
          audit.largestTransferBytes = Math.max(
            audit.largestTransferBytes,
            transfer.reduce((sum, buffer) => sum + buffer.byteLength, 0),
          );
        }
        super.postMessage(message, transfer);
        if (message.type === 'chunk') abortChunk?.();
      }
    };
    const equal = (actual, expected) => {
      for (const key of Object.keys(expected))
        if (!Object.is(actual?.[key], expected[key])) throw new Error(`Worker mismatch: ${key}`);
    };
    try {
      for (const [start, end] of [
        [0, 99_999],
        [13, 82_001],
      ]) {
        const snapshot = captureRangeStatsSnapshot(state.chartSeries, start, end, 2);
        const result = await computeRangeStatsBackground(snapshot, {
          signal: new AbortController().signal,
          isCancelled: () => false,
        });
        equal(result, computeRangeStatsSync(snapshot));
      }
      const controller = new AbortController();
      abortChunk = () => controller.abort();
      const old = await computeRangeStatsBackground(captureRangeStatsSnapshot(state.chartSeries, 0, 99_999, 2), {
        signal: controller.signal,
        isCancelled: () => false,
      });
      if (old !== null) throw new Error('Cancelled task published a result');
      abortChunk = null;
      const latest = captureRangeStatsSnapshot(state.chartSeries, 43, 9001, 2);
      equal(
        await computeRangeStatsBackground(latest, { signal: new AbortController().signal, isCancelled: () => false }),
        computeRangeStatsSync(latest),
      );
      if (audit.workers !== 1 || audit.largestRows !== 4096 || audit.largestTransferBytes !== 8 * 4096 * 8)
        throw new Error(`Unbounded or unreused Worker: ${JSON.stringify(audit)}`);
      if (state.chartSeries.x.length !== 100_000 || state.chartSeries.x.valueAt(9999) !== 4.999)
        throw new Error('Worker detached or changed source data');
      return audit;
    } finally {
      abortChunk = null;
      terminateRangeStatsWorker();
      window.Worker = Original;
    }
  });
}

async function pdSettled(page) {
  await frames(page);
  await page.waitForFunction(() => document.getElementById('pd-list').getAttribute('aria-busy') !== 'true');
  await frames(page);
}

async function pdProjection(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  const builds = async () => {
    const { result } = await cdp.send('Profiler.takePreciseCoverage');
    return result
      .filter((script) => new URL(script.url || 'about:blank').pathname.endsWith('/pd-model.js'))
      .flatMap((script) => script.functions)
      .filter((fn) => fn.functionName === 'createPdProjection')
      .reduce((sum, fn) => sum + fn.ranges[0].count, 0);
  };
  try {
    await page.evaluate(async () => {
      (await import('/views/pd.js')).ingestPdBatch(
        Array.from({ length: 20_000 }, (_, i) => ({
          t: 1_700_000_000_000 + i,
          type: i % 7 ? 'Source_Capabilities' : 'GoodCRC',
          sop: 'SOP',
          role: 'SRC',
          summary: i % 11 ? 'Fixed: 5V 9V PPS: 3.3-21V' : 'needle unique',
        })),
        false,
      );
    });
    await page.locator('#tab-pd').click();
    await pdSettled(page);
    const initialBuilds = await builds();
    assert.equal(initialBuilds, 1, 'first show performs one full projection');
    for (let i = 0; i < 3; i++) {
      await page.locator('#btn-settings-tab').click();
      await page.locator('#tab-pd').click();
      await pdSettled(page);
    }
    assert.equal(await builds(), 0, 'same conditions reuse the PD projection');
    await page.evaluate(async () => {
      const input = document.getElementById('pd-filter');
      for (const value of ['Fixed', 'unmatched', 'needle']) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      (await import('/views/pd.js')).ingestPdBatch(
        [
          {
            t: 1_800_000_000_000,
            type: 'Source_Capabilities',
            sop: 'SOP',
            role: 'SRC',
            summary: 'needle tail sentinel',
          },
        ],
        false,
      );
    });
    await pdSettled(page);
    assert.equal(await page.locator('.pd-row').filter({ hasText: 'tail sentinel' }).count(), 1);
    assert.equal(await page.locator('.pd-row').filter({ hasNotText: 'needle' }).count(), 0);
    assert.equal(await builds(), 1, 'a burst projects only its final filter, including concurrent appends');
    await page.locator('#btn-settings-tab').click();
    await frames(page);
    await page.evaluate(async () => {
      window.__hiddenPdCommits = 0;
      window.__pdObserver = new MutationObserver((records) => (window.__hiddenPdCommits += records.length));
      for (const id of ['pd-list', 'pd-counter'])
        window.__pdObserver.observe(document.getElementById(id), { attributes: true, childList: true, subtree: true });
      (await import('/views/pd.js')).ingestPdBatch(
        [
          {
            t: 1_800_000_000_001,
            type: 'Source_Capabilities',
            sop: 'SOP',
            role: 'SRC',
            summary: 'needle hidden sentinel',
          },
        ],
        false,
      );
    });
    await frames(page, 8);
    assert.equal(await page.evaluate(() => window.__hiddenPdCommits), 0, 'hidden PD view does not commit DOM');
    await page.evaluate(() => window.__pdObserver.disconnect());
    await page.locator('#tab-pd').click();
    await pdSettled(page);
    assert.equal(await page.locator('.pd-row').filter({ hasText: 'hidden sentinel' }).count(), 1);
    return { rows: 20_002, initialBuilds, reusedShows: 3, finalFilterBuilds: 1, hiddenCommits: 0 };
  } finally {
    await cdp.send('Profiler.stopPreciseCoverage');
    await cdp.detach();
  }
}

async function protocolControl(page) {
  await connect(page);
  await page.locator('#tab-trigger').click();
  const command = async (id) => {
    await page.locator(`#${id}`).click();
    await page.waitForFunction(() => !document.getElementById('btn-km-pdm-open').disabled);
    await frames(page);
  };
  await command('btn-km-pdm-open');
  await page.locator('#btn-km-mode-detection').click();
  await command('btn-km-scan');
  const detections = await page.locator('.trigger-detection-result').count();
  assert.ok(detections > 0, 'completed detection progress remains visible');
  const evidence = page.locator('.trigger-evidence-toggle').first();
  await evidence.click();
  assert.equal(await evidence.getAttribute('aria-expanded'), 'true');
  await page.locator('#btn-km-mode-trigger').click();
  await command('btn-km-read-pdo');
  await page.locator('.trigger-pdo-row').filter({ hasText: '#5' }).click();
  await command('btn-km-trigger');
  const pdos = await page.locator('.trigger-pdo-row').count();
  assert.equal(pdos, PDOS.length, 'all fixture PDOs survive progress rendering');
  assert.equal(
    await page.locator('#km-history-list .trigger-history-item').first().getAttribute('open'),
    '',
    'completing a command preserves its expanded progress history',
  );
  return { simulated: true, detections, pdos };
}

const output = resolve(ROOT, options.output, new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const { version } = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
const report = {
  schema: 1,
  environment: {
    version,
    node: process.version,
    platform: process.platform,
    channel: options.channel ?? 'chromium',
    headless: true,
    simulated: true,
  },
  cases: [],
};
let server;
let browser;
try {
  server = await startServer();
  browser = await chromium.launch({ headless: true, channel: options.channel });
  report.environment.browser = browser.version();
  for (const name of options.cases) {
    const started = performance.now();
    const result = { name, status: 'failed', errors: [] };
    report.cases.push(result);
    let context;
    let page;
    let timeout;
    try {
      context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
      context.setDefaultTimeout(15_000);
      await context.tracing.start({ screenshots: true, snapshots: true });
      page = await context.newPage();
      page.on('pageerror', (error) => result.errors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') result.errors.push(message.text());
      });
      result.metrics = await Promise.race([
        (async () => {
          await page.goto(`${server.url}/app/?capture=1&theme=light&language=en`);
          await page.waitForFunction(() => !document.getElementById('btn-connect').disabled);
          await page.evaluate(async () => {
            window.__SHOWCASE__.freeze();
            await document.fonts.ready;
          });
          const metrics = await cases[name](page);
          assert.deepEqual(await page.evaluate(() => window.__SHOWCASE__.diagnostics().errors), []);
          assert.deepEqual(result.errors, [], 'browser errors');
          return metrics;
        })(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Case exceeded 90 seconds: ${name}`)), 90_000);
        }),
      ]);
      result.status = 'passed';
    } catch (error) {
      result.errors.push(String(error.stack ?? error));
      await page?.screenshot({ path: resolve(output, `${name}.png`), timeout: 5000 }).catch(() => {});
      if (context) await context.tracing.stop({ path: resolve(output, `${name}.zip`) }).catch(() => {});
      console.error(`FAIL ${name}: ${error.message}`);
    } finally {
      clearTimeout(timeout);
      await context?.close();
      result.durationMs = performance.now() - started;
    }
    if (result.status === 'passed') console.log(`PASS ${name} (${Math.round(result.durationMs)} ms)`);
  }
} catch (error) {
  report.error = String(error.stack ?? error);
  console.error(error);
} finally {
  await browser?.close();
  await server?.close();
  report.passed =
    !report.error && report.cases.length === options.cases.length && report.cases.every((c) => c.status === 'passed');
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const xml = (text) =>
    String(text).replace(
      /[<>&"']/g,
      (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char],
    );
  const entries = report.cases.map(
    (c) =>
      `<testcase name="${xml(c.name)}" time="${c.durationMs / 1000}">${c.status === 'passed' ? '' : `<failure>${xml(c.errors.join('\n'))}</failure>`}</testcase>`,
  );
  if (report.error) entries.push(`<testcase name="setup"><error>${xml(report.error)}</error></testcase>`);
  await writeFile(
    resolve(output, 'junit.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="browser-acceptance" tests="${entries.length}" failures="${report.cases.filter((c) => c.status !== 'passed').length}" errors="${report.error ? 1 : 0}">${entries.join('\n')}</testsuite>\n`,
  );
  console.log(`Reports: ${output}`);
  if (!report.passed) process.exitCode = 1;
}
