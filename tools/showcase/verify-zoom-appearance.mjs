/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHeadlessHarness, frames } from './headless.mjs';

const output = resolve('output/zoom-appearance');
await mkdir(output, { recursive: true });
await using harness = await createHeadlessHarness();
await using app = await harness.openApp({
  theme: 'dark',
  language: 'zh-CN',
  context: { viewport: { width: 1480, height: 950 } },
});
const { page } = app;
await page.evaluate(async () => {
  const { state } = await import('/state.js');
  window.__zoomTestState = state;
});

await app.connect('showcase:k2');
await page.locator('#sample-rate').selectOption('10', { force: true });
await app.record();
await app.advance(180_000);
await app.pause();
await app.waitForCharts();

const chartState = () =>
  page.evaluate(async () => {
    const { state } = await import('/state.js');
    const main = state.mainChart;
    return {
      span: main.scales.x.max - main.scales.x.min,
      width: main.series[1].width,
      base: state.settings.chartLineWidths.voltage,
      overviewWidth: state.navigatorChart.series[1].width,
      points: state.chartSeries.x.length,
      sampleRate: state.settings.sampleRate,
      mode: state.chartWindow.mode,
      min: main.scales.x.min,
      max: main.scales.x.max,
      latest: state.chartSeries.x.at(-1),
      overviewLatest: state.navigatorChart.data[0].at(-1),
    };
  });
const wide = await chartState();
assert.ok(wide.points > 10_000 && wide.width < wide.base);
const plot = page.locator('#main-chart .u-over');
await plot.hover();
await page.mouse.wheel(0, -1300);
await page.waitForFunction((span) => {
  const { scales } = window.__zoomTestState.mainChart;
  return scales.x.max - scales.x.min < span * 0.5 && !window.__zoomTestState.__rangeDragging;
}, wide.span);
await app.waitForCharts();
const narrow = await chartState();
assert.ok(narrow.width > wide.width && narrow.width <= wide.base);
assert.equal(narrow.overviewWidth, wide.overviewWidth);
assert.equal(narrow.points, wide.points);
assert.equal(narrow.sampleRate, 10);

await page.locator('#btn-settings-tab').click();
const transparency = page.locator('#background-transparency');
const wallpaper = page.locator('#workspace-wallpaper');
assert.equal(await wallpaper.evaluate((image) => getComputedStyle(image).opacity), '1');
await transparency.fill('100');
assert.equal(await wallpaper.evaluate((image) => getComputedStyle(image).opacity), '0');
await transparency.fill('65');
assert.equal(await wallpaper.evaluate((image) => getComputedStyle(image).opacity), '0.35');
assert.equal(await transparency.getAttribute('aria-valuetext'), '65%');
assert.equal(await page.locator('#background-transparency-value').textContent(), '65%');
await page.screenshot({ path: resolve(output, 'settings.png'), animations: 'disabled' });

await page.locator('label[for=chart-auto-line-width]').click();
await page.locator('#tab-monitor').click();
await app.waitForCharts();
const beforeZoomOut = await chartState();
assert.equal(beforeZoomOut.width, wide.base);
assert.ok(beforeZoomOut.span < wide.span * 0.5, 'returning from settings retains the zoomed-in window');
const overview = page.locator('#timeline-track');
await overview.hover();
await page.mouse.wheel(0, 2200);
await page.waitForFunction(() => {
  const state = window.__zoomTestState;
  return state.chartWindow.mode === 'full' && !state.__rangeDragging;
});
await app.waitForCharts();
const full = await chartState();
assert.equal(full.width, wide.base, 'turning off auto width keeps the base at every zoom');
assert.equal(full.mode, 'full', 'zooming all the way out restores the full-history mode');

await app.record();
await app.advance(5000);
const waitForLiveTail = () =>
  page.waitForFunction(() => {
    const state = window.__zoomTestState;
    const tail = state.chartSeries.x.at(-1);
    return state.isRecording && state.mainChart.scales.x.max === tail && state.navigatorChart.scales.x.max === tail;
  });
await waitForLiveTail();
const fullAppend = await chartState();
assert.equal(fullAppend.mode, 'full');
assert.ok(Math.abs(fullAppend.max - fullAppend.latest) < 1e-6, 'a full view follows newly recorded samples');
assert.equal(fullAppend.overviewLatest, fullAppend.latest, 'the total preview reaches the newest sample');

const overviewBounds = await overview.boundingBox();
assert.ok(overviewBounds);
await overview.hover({ position: { x: overviewBounds.width - 2, y: overviewBounds.height / 2 } });
await page.mouse.wheel(0, -130);
await page.waitForFunction(() => {
  const state = window.__zoomTestState;
  return state.chartWindow.mode === 'follow' && !state.__rangeDragging;
});
const followBeforeAppend = await chartState();
await app.advance(5000);
await waitForLiveTail();
const followAppend = await chartState();
assert.equal(followAppend.mode, 'follow');
assert.ok(Math.abs(followAppend.max - followAppend.latest) < 1e-6, 'a tail-anchored zoom follows new samples');
assert.ok(Math.abs(followAppend.span - followBeforeAppend.span) < 0.02, 'the followed zoom preserves its duration');
assert.equal(followAppend.overviewLatest, followAppend.latest);
await app.pause();

// Idle data needs an honest main scale and a readable overview, even when its
// complete power range consists of micro-watt spikes.
const preview = await page.evaluate(async () => {
  const { syncChartSeries, updateCharts } = await import('/chart.js');
  const state = window.__zoomTestState;
  const { voltage, current, power } = state.chartSeries;
  for (let series = 5; series <= 8; series++) state.mainChart.setSeries(series, { show: false });
  voltage.set(Float64Array.from({ length: voltage.length }, (_, i) => (i % 2 === 0 ? 0.003125 : 0.0125)));
  current.set(Float64Array.from({ length: current.length }, (_, i) => (i % 251 === 0 ? 0.002 : 0)));
  power.set(Float64Array.from({ length: power.length }, (_, i) => (i % 251 === 0 ? 0.000035 : 0)));
  syncChartSeries();
  updateCharts();
  await new Promise(requestAnimationFrame);
  const nav = state.navigatorChart;
  return {
    zero: nav.valToPos(0, 'y', true),
    peak: nav.valToPos(0.000035, 'y', true),
    bottom: nav.bbox.top + nav.bbox.height,
    top: nav.bbox.top,
    latest: nav.data[0].at(-1),
    voltage: [state.mainChart.scales.voltage.min, state.mainChart.scales.voltage.max],
    current: [state.mainChart.scales.current.min, state.mainChart.scales.current.max],
    power: [state.mainChart.scales.power.min, state.mainChart.scales.power.max],
  };
});
assert.ok(preview.zero <= preview.bottom - 2.5, 'the zero baseline is inset far enough for the native stroke');
assert.ok(preview.peak > preview.top && preview.peak < preview.zero, 'the measured peak remains inside the plot');
assert.ok(
  preview.zero - preview.peak > (preview.bottom - preview.top) * 0.5,
  'micro-watt spikes are visible in the overview',
);
assert.deepEqual(preview.voltage, [0, 0.05]);
assert.deepEqual(preview.current, [0, 0.01]);
assert.deepEqual(preview.power, [0, 0.005]);
assert.equal(preview.latest, followAppend.latest);

const hover = async (selector) => {
  const item = page.locator(selector);
  await item.hover();
  await frames(page);
  await page.waitForFunction(
    (selector) =>
      !document
        .querySelector(selector)
        .getAnimations()
        .some((a) => a.playState === 'running'),
    selector,
  );
  return item.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.backgroundColor,
      glass: style.getPropertyValue('--glass-lens').trim(),
      radius: parseFloat(style.borderTopLeftRadius),
    };
  });
};
const reading = await hover('.realtime-card.voltage');
assert.ok(reading.radius >= 16);
assert.equal(reading.color, reading.glass);
await page.screenshot({ path: resolve(output, 'monitor-reading-hover.png'), animations: 'disabled' });
const command = await hover('#btn-import');
assert.equal(command.color, command.glass);
await page.screenshot({ path: resolve(output, 'monitor-toolbar-hover.png'), animations: 'disabled' });
assert.deepEqual(app.errors, []);
console.log({ wide, narrow, fullAppend, followAppend, reading, command });
