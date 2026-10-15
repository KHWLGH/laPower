import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const server = await startServer();
const browser = await chromium.launch({ headless: true });
const errors = [];
const output = resolve('out/recording-review');
await mkdir(output, { recursive: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
  acceptDownloads: true,
});
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(String(error)));
const recording = () => page.evaluate(async () => (await import('/state.js')).state.isRecording);
const unfocus = () => page.evaluate(() => document.activeElement?.blur());
try {
  await page.goto(`${server.url}/app/?capture=1&theme=light&language=en`);
  await page.waitForFunction(() => !document.getElementById('btn-connect').disabled);
  assert.equal(await page.locator('#temp-card').isVisible(), true);
  assert.equal(await page.locator('.commandbar #marker-actions').count(), 0);
  assert.equal(await page.locator('.chart-header #marker-actions').count(), 1);
  await page.locator('#device-select').selectOption('showcase:km003c', { force: true });
  await page.locator('#btn-connect').click();
  await unfocus();
  await page.keyboard.press('p');
  assert.equal(await recording(), true);
  await page.evaluate(() => window.__SHOWCASE__.advance(2000));
  await page.keyboard.press('p');
  assert.equal(await recording(), false);
  await page.keyboard.press('p');
  assert.equal(await recording(), true);
  // Repeating keys, composition and focused inputs do not change recording.
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', repeat: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', isComposing: true, bubbles: true }));
    document.getElementById('sample-rate').focus();
  });
  await page.keyboard.press('p');
  assert.equal(await recording(), true);
  await unfocus();
  await page.mouse.move(2, 150);
  const markerRow = await page.evaluate(async () => (await import('/state.js')).state.chartSeries.x.length);
  await page.keyboard.press('m');
  await page.locator('dialog[open]').waitFor();
  await page.locator('dialog input').fill('Original marker');
  await page.evaluate(() => window.__SHOWCASE__.advance(100));
  await page.keyboard.press('p');
  assert.equal(await recording(), true);
  await page.locator('.fluent-dialog-ok').click();
  const markers = await page.evaluate(async () =>
    (await import('/markers.js')).markersOf((await import('/state.js')).state.chartSeries),
  );
  assert.equal(markers.length, 1);
  assert.equal(markers[0].index, markerRow);
  await page.locator('#btn-export-options').click();
  await page.locator('label:has(#export-withTemp)').click();
  await page.locator('label:has(#export-withDeviceInfo)').click();
  assert.equal(await page.locator('#export-withTemp').isChecked(), true);
  assert.equal(await page.locator('#export-withDeviceInfo').isChecked(), false);
  assert.equal(await page.locator('#flyout-export').isVisible(), true);
  assert.equal(
    await page.locator('#btn-export-both').isEnabled(),
    true,
    'PD export must work without visiting its page',
  );
  await page.evaluate(async () => (await import('/views/pd.js')).clearPdEntries());
  assert.equal(await page.locator('#btn-export-both').isEnabled(), false);
  await page.evaluate(async () => {
    const pd = await import('/views/pd.js');
    pd.ingestPdBatch([{ t: Date.now(), divider: true }], false);
  });
  assert.equal(await page.locator('#btn-export-both').isEnabled(), true, 'open menu updates when PD data arrives');
  await page.screenshot({ path: resolve(output, 'export-options.png') });
  await page.keyboard.press('Escape');
  await unfocus();
  const csvDownload = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const csv = await csvDownload;
  const csvText = await readFile(await csv.path(), 'utf8');
  assert.match(csvText, /Temp\(°C\)/);
  assert.doesNotMatch(csvText, /\nDevice,/);
  assert.match(csvText, /Original marker/);
  const downloads = [];
  const collect = (download) => downloads.push(download);
  page.on('download', collect);
  const pairedPdDownload = page.waitForEvent('download', {
    predicate: (download) => download.suggestedFilename().endsWith('.pd.json'),
  });
  await page.keyboard.press('Control+Shift+s');
  await pairedPdDownload;
  await page.waitForFunction(async () => !(await import('/export-session.js')).isExportActive());
  assert.equal(downloads.length, 2);
  const pdDownload = downloads.find((d) => d.suggestedFilename().endsWith('.pd.json'));
  assert.ok(pdDownload);
  const pd = JSON.parse(await readFile(await pdDownload.path(), 'utf8'));
  assert.equal(pd.version, 2);
  assert.ok(pd.entries.length > 0);
  assert.equal(
    downloads[0].suggestedFilename().replace(/\.csv$/, ''),
    pdDownload.suggestedFilename().replace(/\.pd\.json$/, ''),
  );
  page.off('download', collect);
  // Temperature disconnection retains layout and independently selected CSV options.
  await page.locator('#btn-temp-toggle').click();
  await page.locator('#btn-temp-toggle').click();
  assert.equal(await page.locator('#temp-card').isVisible(), true);
  const preferences = await page.evaluate(async () => (await import('/state.js')).state.settings.csvExportOptions);
  assert.deepEqual(preferences, { withTemp: true, withDeviceInfo: false, withMarkers: true });
  await page.locator('#btn-settings-tab').click();
  const capture = page.locator('[data-shortcut-action="record"]');
  await capture.click();
  await page.keyboard.press('m');
  assert.match(await page.locator('#shortcut-error').innerText(), /Already assigned/);
  await page.keyboard.press('r');
  assert.equal(await capture.innerText(), 'R');
  await page.screenshot({ path: resolve(output, 'shortcuts.png') });
  await page.locator('#tab-monitor').click();
  await unfocus();
  await page.keyboard.press('p');
  assert.equal(await recording(), true);
  await page.keyboard.press('r');
  assert.equal(await recording(), false);
  assert.match(await page.locator('#btn-record-toggle').getAttribute('title'), /\(R\)/);
  // PD-page Ctrl+S exports PD, not the monitor CSV.
  await page.locator('#tab-pd').click();
  await unfocus();
  const pdOnlyDownload = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  assert.ok((await pdOnlyDownload).suggestedFilename().endsWith('.json'));
  await page.locator('#btn-settings-tab').click();
  await page.locator('#btn-reset-shortcuts').click();
  assert.equal(await capture.innerText(), 'P');
  await page.locator('#tab-monitor').click();
  for (const language of ['en', 'zh-CN', 'zh-TW', 'ja']) {
    await page.evaluate(async (language) => (await import('/i18n.js')).applyLanguage(language), language);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(async (theme) => (await import('/theme.js')).applyThemePreference(theme), theme);
      for (const scale of [75, 100, 125]) {
        await page.evaluate(async (scale) => (await import('/ui-scale.js')).applyUiScale(scale), scale);
        const layout = await page.evaluate(() => {
          const rect = (id) => document.getElementById(id).getBoundingClientRect();
          const bar = document.querySelector('#view-monitor .commandbar');
          const marker = rect('marker-actions');
          const legend = rect('main-chart-legend');
          return {
            overlap: legend.right > marker.left + 1,
            direct: ['btn-import', 'btn-export', 'btn-clear-chart'].every((id) => !document.getElementById(id).hidden),
            top: ['btn-record-toggle', 'export-actions', 'btn-import', 'btn-clear-chart', 'temperature-actions'].map(
              (id) => Math.round(rect(id).top),
            ),
            scrolling: bar.scrollWidth > bar.clientWidth,
          };
        });
        assert.equal(layout.overlap, false, `${language}/${theme}/${scale}: marker overlaps legend`);
        assert.equal(layout.direct, true);
        assert.equal(new Set(layout.top).size, 1, 'single toolbar row');
        await page.locator('#btn-export-options').click();
        const bounds = await page.locator('#flyout-export').boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1281, 'export panel fits window');
        await page.keyboard.press('Escape');
      }
    }
  }
  await page.evaluate(async () => {
    (await import('/i18n.js')).applyLanguage('zh-CN');
    (await import('/theme.js')).applyThemePreference('light');
    (await import('/ui-scale.js')).applyUiScale(100);
  });
  await page.locator('#btn-export-options').click();
  await page.screenshot({ path: resolve(output, 'recording-zh-CN.png') });
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__SHOWCASE__.diagnostics().errors), []);
  console.log(
    'Recording UI verified: shortcuts, focus guards, customization, CSV/PD downloads, 4 languages × 2 themes × 3 scales.',
  );
} finally {
  await browser.close();
  await server.close();
}
