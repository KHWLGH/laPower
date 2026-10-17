/** Manual KM003C acceptance. Reuses real history, then samples and spools through the native pipeline. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { computeCsvImport } from '../src/csv-import-core.js';
import { options, provenance, quantiles, sha256 } from './common.mjs';

const config = options(process.argv.slice(2), {
  exe: 'target/debug/lapower.exe',
  variant: 'current',
  baselineDir: 'bench/results/chart-followup-before',
  history: 'bench/results/chart-ordered-hardware/final-recording.csv',
  recoveryDir: 'C:/Users/12046/AppData/Local/io.github.khwlgh.lapower/recording-recovery',
  output: 'bench/results/chart-followup-hardware',
  runs: 20,
  dpi: 1.5,
  port: 19510,
  focus: false,
  fillChannels: 4,
});
const output = resolve(config.output);
await mkdir(output, { recursive: true });
const before = await provenance();
const result = {
  config,
  provenance: before,
  cases: [],
  limitations:
    'Real retained KM003C history followed by live 1KSPS USB bulk acquisition and recovery-file writes. Current wiring is not a controlled alternating load. Seven channels were finite in the history; temperature was missing. Draw callbacks and rAF are not physical presentation timestamps.',
};
const child = spawn(resolve(config.exe), [], {
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${config.port} --force-device-scale-factor=${config.dpi}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(createWriteStream(resolve(output, 'native-stdout.log')));
child.stderr.pipe(createWriteStream(resolve(output, 'native-stderr.log')));
const recoveryId = `chart-followup-${process.pid}-${Date.now()}.partial.csv`;
const recoveryPath = resolve(config.recoveryDir, recoveryId);
let browser, page;
const save = () => writeFile(resolve(output, 'hardware.json'), JSON.stringify(result, null, 2));
try {
  for (let i = 0; i < 150; i++) {
    try {
      await fetch(`http://127.0.0.1:${config.port}/json/version`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.port}`);
  page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => document.querySelector('#main-chart canvas'));
  await page.evaluate(() => {
    window.__acceptanceErrors = [];
    window.addEventListener('error', (e) => window.__acceptanceErrors.push(String(e.error ?? e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__acceptanceErrors.push(String(e.reason)));
  });
  result.initial = await page.evaluate(async () => {
    const { state } = await import('./state.js');
    if (state.isConnected || state.chartSeries.x.length) throw Error('independent empty test instance required');
    window.__acceptanceOriginal = {
      settings: structuredClone(state.settings),
      autoPause: structuredClone(state.autoPauseSettings),
    };
    return {
      runtime: navigator.userAgent,
      dpi: devicePixelRatio,
      devices: await window.__TAURI__.core.invoke('enumerate_devices'),
    };
  });
  assert.equal(result.initial.dpi, config.dpi);
  assert.ok(
    result.initial.devices.some((d) => d.family === 'km003c'),
    'KM003C unavailable',
  );
  result.embedded = await page.evaluate(async (variant) => {
    const hashes = {};
    for (const file of [
      'chart.js',
      'chart-buckets.js',
      'chart-extrema.js',
      ...(variant === 'current' ? ['chart-fill.js'] : []),
      'data.js',
      'performance-diagnostics.js',
      'app.js',
    ])
      hashes[file] = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', await (await fetch('./' + file)).arrayBuffer())),
        (v) => v.toString(16).padStart(2, '0'),
      ).join('');
    return hashes;
  }, config.variant);
  for (const [file, hash] of Object.entries(result.embedded))
    assert.equal(
      hash,
      sha256(await readFile(resolve(config.variant === 'baseline' ? config.baselineDir : '.', 'src', file))),
    );
  result.binarySha256 = sha256(await readFile(resolve(config.exe)));
  await copyFile(resolve(config.history), recoveryPath, constants.COPYFILE_EXCL);
  result.history = await page.evaluate(async (id) => {
    const { state } = await import('./state.js');
    state.settings.recordLimitMb = 512;
    state.settings.recordCurrentDirection = false;
    const errors = [];
    const ok = await (await import('./csv.js')).importSpoolRecovery(id, (e) =>
      errors.push(typeof e === 'function' ? e() : e),
    );
    if (!ok) throw Error('history import failed: ' + errors.join('; '));
    return { count: state.chartSeries.x.length, stats: state.stats, energy: state.energy };
  }, recoveryId);
  result.started = await page.evaluate(async () => {
    const { state } = await import('./state.js'),
      chart = await import('./chart.js'),
      data = await import('./data.js');
    const { deviceStream } = await import('./device-stream.js'),
      { ExactExtremaIndex } = await import('./chart-extrema.js');
    const device = await import('./device.js');
    const hw = {
      state,
      chart,
      data,
      deviceStream,
      draws: [],
      frames: [],
      index: null,
      originalSync: ExactExtremaIndex.prototype.syncStep,
    };
    window.__acceptance = hw;
    ExactExtremaIndex.prototype.syncStep = function (...args) {
      hw.index = this;
      return hw.originalSync.apply(this, args);
    };
    state.settings.recordingTempSpool = state.settings.autoSaveRecording = true;
    state.settings.activeView = 'monitor';
    state.settings.statsRange = false;
    state.settings.tempSource = 'device';
    state.autoPauseSettings.enabled = false;
    await device.initializeDeviceStream();
    const devices = await window.__TAURI__.core.invoke('enumerate_devices');
    state.selectedDevicePath = devices.find((d) => d.family === 'km003c').path;
    await device.connectDevice();
    if (!state.isConnected) throw Error('KM003C connection failed');
    await (await import('./settings.js')).applySampleRate(1);
    let last = performance.now();
    const tick = (now) => {
      hw.frames.push(now - last);
      last = now;
      if (hw.frames.length > 8192) hw.frames.splice(0, 4096);
      hw.raf = requestAnimationFrame(tick);
    };
    hw.raf = requestAnimationFrame(tick);
    hw.hook = () =>
      hw.draws.push({
        at: performance.now(),
        ...state.mainChart.__chartProjection,
        timing: structuredClone(window.__WITRN_PERF__().charts.main.last),
      });
    state.mainChart.hooks.draw.push(hw.hook);
    await data.startRecording();
    await (await import('./recording-spool.js')).spoolRecordingPaused();
    return { count: state.chartSeries.x.length, device: state.connectedDevice, stream: deviceStream.diagnostics() };
  });
  await save();
  for (const channels of config.focus ? [8] : [3, 8])
    for (const filled of config.focus ? [true] : [false, true])
      for (const cold of [false, true]) {
        const runs = channels === 8 && filled ? config.runs : 3;
        for (let run = 0; run < runs; run++) {
          const item = await page.evaluate(
            async ({ channels, filled, cold, run, fillChannels }) => {
              const hw = window.__acceptance,
                { state, data, chart } = hw;
              const wait = (ms) => new Promise((r) => setTimeout(r, ms)),
                frame = () => new Promise(requestAnimationFrame);
              const settle = async () => {
                const start = performance.now();
                do {
                  await wait(2);
                  if (performance.now() - start > 20000) throw Error('chart preparation timeout');
                } while (document.getElementById('main-chart').getAttribute('aria-busy') === 'true');
                await frame();
                await frame();
                await frame();
              };
              const failures = [],
                check = (ok, message) => {
                  if (!ok) failures.push(message);
                };
              chart.setRangeDragging(false);
              for (let s = 0; s < 8; s++) {
                chart.setSeriesVisible(s, channels === 8 || s < 3);
                chart.setSeriesFill(s, filled && s < fillChannels ? 12 : 0);
              }
              check(
                !filled || state.mainChart.series[1].fill(state.mainChart, 1)?.endsWith(', 0.12)'),
                'fill must use 12 percent',
              );
              state.chartWindow.mode = 'full';
              state.settings.rangeStart = 0;
              state.settings.rangeEnd = 1000;
              data.updateChartRange();
              if (!state.isRecording) await data.startRecording();
              chart.syncChartSeries();
              chart.updateCharts('live');
              await settle();
              await wait(180);
              chart.updateCharts('live');
              await frame();
              check(!!hw.index, 'index missing');
              if (cold) {
                chart.setRangeDragging(true);
                chart.setRangeDragging(false);
                hw.index.reset();
              }
              hw.draws = [];
              hw.frames = [];
              const beforeCount = state.chartSeries.x.length,
                started = performance.now();
              await data.stopRecording();
              const fenceMs = performance.now() - started,
                fencedCount = state.chartSeries.x.length;
              await settle();
              await wait(65);
              const draws = hw.draws.map((d) => ({ ...d, afterMs: d.at - started }));
              const complete = draws.find((d) => d.start === 0 && d.end >= beforeCount),
                fine = draws.find((d) => d.quality === 'fine' && d.end >= beforeCount);
              check(!!complete, 'no complete first frame');
              check(!!fine, 'no fine frame');
              check(
                cold ? draws[0]?.quality === 'coarse' : draws[0]?.quality === 'fine',
                'incorrect pause first quality',
              );
              check(
                draws.filter((d, i, a) => d.quality === 'fine' && a[i - 1]?.quality !== 'fine').length === 1,
                'more than one fine transition',
              );
              check(state.chartSeries.x.length === fencedCount, 'samples arrived after fence');
              check(state.mainChart.__chartProjection.end === fencedCount, 'fenced tail not drawn');
              const pauseFrames = hw.frames.slice(),
                gestures = [],
                zooms = [];
              // Measure this window's actual draw. A diagnostic read after one
              // gesture rAF can still refer to an older, coalesced request.
              const zoomFrom = Math.floor(fencedCount * 0.45),
                zoomMin = state.chartSeries.x.valueAt(zoomFrom),
                zoomMax = state.chartSeries.x.valueAt(zoomFrom + 3999),
                beforeZoom = hw.draws.length;
              state.chartWindow = { mode: 'frozen', min: zoomMin, max: zoomMax, duration: zoomMax - zoomMin };
              chart.setChartXWindow(zoomMin, zoomMax);
              const zoomStarted = performance.now();
              chart.updateCharts('interaction', { force: false, reason: 'zoom' });
              while (hw.draws.length === beforeZoom) {
                await frame();
                if (performance.now() - zoomStarted > 20000) throw Error('zoom draw timeout');
              }
              zooms.push(hw.draws[beforeZoom].at - zoomStarted);
              await settle();
              chart.setRangeDragging(true);
              for (let j = 0; j < 18; j++) {
                const from = Math.floor(fencedCount * 0.45) + j * 7,
                  count = Math.round(12000 * (1000 / 12000) ** (j / 17));
                const min = state.chartSeries.x.valueAt(from),
                  max = state.chartSeries.x.valueAt(from + count - 1);
                state.chartWindow = { mode: 'frozen', min, max, duration: max - min };
                chart.setChartXWindow(min, max);
                const t = performance.now();
                chart.scheduleChartUpdate('interaction');
                await frame();
                gestures.push(performance.now() - t);
              }
              chart.updateCharts('interaction', { force: false, reason: 'release' });
              await settle();
              const digest = async () => {
                const cols = state.mainChart.data,
                  x = cols[0],
                  { min, max } = state.chartWindow;
                let a = 0;
                while (a < x.length && x[a] < min) a++;
                let b = a;
                while (b < x.length && x[b] <= max) b++;
                a = Math.max(0, a - 1);
                b = Math.min(x.length, b + 1);
                return Array.from(
                  new Uint8Array(
                    await crypto.subtle.digest(
                      'SHA-256',
                      new TextEncoder().encode(
                        JSON.stringify(cols.map((c) => Array.from(c.subarray ? c.subarray(a, b) : c.slice(a, b)))),
                      ),
                    ),
                  ),
                  (v) => v.toString(16).padStart(2, '0'),
                ).join('');
              };
              const geometry = await digest();
              chart.setRangeDragging(false);
              chart.updateCharts('interaction');
              await settle();
              check(geometry === (await digest()), 'release changed visible geometry');
              const stream = hw.deviceStream.diagnostics();
              check(!stream.failed && !stream.streamErrors && !stream.capacityErrors, 'stream failure');
              return {
                channels,
                filled,
                fillPercent: filled ? 12 : 0,
                fillChannels,
                cold,
                run,
                failures,
                beforeCount,
                fencedCount,
                retainedTail: fencedCount - beforeCount,
                fenceMs,
                firstCompleteMs: complete?.afterMs,
                firstFineMs: fine?.afterMs,
                draws,
                pauseFrames,
                gestures,
                zooms,
                indexBytes: hw.index.byteLength,
                stream,
              };
            },
            { channels, filled, cold, run, fillChannels: config.fillChannels },
          );
          result.cases.push(item);
          await save();
          assert.deepEqual(item.failures, [], JSON.stringify({ channels, filled, cold, run }));
        }
        console.log(JSON.stringify({ variant: config.variant, channels, filled, cold, cases: result.cases.length }));
      }
  result.final = await page.evaluate(async () => {
    const hw = window.__acceptance,
      { state, data } = hw;
    await data.stopRecording();
    const spool = await import('./recording-spool.js');
    await spool.spoolRecordingPaused();
    const hashes = {};
    for (const [key, col] of Object.entries(state.chartSeries)) {
      hashes[key] = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', col.copyRange().buffer)), (v) =>
        v.toString(16).padStart(2, '0'),
      ).join('');
      await new Promise((r) => setTimeout(r, 0));
    }
    return {
      count: state.chartSeries.x.length,
      spool: spool.spoolPath(),
      hashes,
      stats: state.stats,
      energy: state.energy,
      errors: window.__acceptanceErrors,
      stream: hw.deviceStream.diagnostics(),
    };
  });
  await copyFile(result.final.spool, resolve(output, 'recording.csv'));
  const bytes = await readFile(resolve(output, 'recording.csv'));
  const parsed = computeCsvImport(bytes.toString('utf8'), { fallbackStartTime: 0 });
  assert.equal(parsed.columns.x.length, result.final.count);
  for (const [key, col] of Object.entries(parsed.columns))
    assert.equal(sha256(new Uint8Array(col.copyRange().buffer)), result.final.hashes[key], key);
  for (const key of ['voltage', 'current', 'power', 'temp'])
    assert.deepEqual(
      JSON.parse(JSON.stringify(parsed.stats[key])),
      JSON.parse(JSON.stringify(result.final.stats[key])),
      key,
    );
  assert.equal(parsed.energy.wh, result.final.energy.wh);
  assert.equal(parsed.energy.mah, result.final.energy.mah);
  result.final.csv = {
    bytes: bytes.length,
    sha256: sha256(bytes),
    allColumnsExact: true,
    statsExact: true,
    energyExact: true,
  };
  assert.deepEqual(result.final.errors, []);
  result.summary = {
    warm: quantiles(result.cases.filter((c) => !c.cold).map((c) => c.firstCompleteMs)),
    cold: quantiles(result.cases.filter((c) => c.cold).map((c) => c.firstCompleteMs)),
    fine: quantiles(result.cases.filter((c) => c.cold).map((c) => c.firstFineMs)),
    gesture: quantiles(result.cases.flatMap((c) => c.gestures)),
    fence: quantiles(result.cases.map((c) => c.fenceMs)),
  };
  result.workspaceSourceStable = before.sourceSha256 === (await provenance()).sourceSha256;
  result.sourceStable =
    config.variant === 'baseline'
      ? result.binarySha256 === sha256(await readFile(resolve(config.exe)))
      : result.workspaceSourceStable;
  assert.ok(result.sourceStable);
  await save();
  console.log(JSON.stringify(result.summary));
} catch (error) {
  result.error = String(error.stack ?? error);
  await save();
  throw error;
} finally {
  if (page)
    result.cleanup = await page
      .evaluate(async () => {
        const { state } = await import('./state.js');
        await (await import('./data.js')).stopRecording().catch(() => {});
        await (await import('./recording-spool.js')).finalizeSpool();
        if (state.isConnected) await (await import('./device.js')).disconnectDevice();
        const hw = window.__acceptance;
        if (hw) {
          cancelAnimationFrame(hw.raf);
          (await import('./chart-extrema.js')).ExactExtremaIndex.prototype.syncStep = hw.originalSync;
          state.mainChart.hooks.draw.splice(state.mainChart.hooks.draw.indexOf(hw.hook), 1);
        }
        if (window.__acceptanceOriginal) {
          Object.assign(state.settings, window.__acceptanceOriginal.settings);
          Object.assign(state.autoPauseSettings, window.__acceptanceOriginal.autoPause);
          await (await import('./settings.js')).saveSettings();
        }
        return {
          connected: state.isConnected,
          recording: state.isRecording,
          recoveries: await window.__TAURI__.core.invoke('spool_recovery_list'),
        };
      })
      .catch((e) => ({ error: String(e) }));
  await save();
  await browser?.close();
  child.kill();
  await unlink(recoveryPath).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
}
