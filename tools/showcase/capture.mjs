/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHeadlessHarness, frames } from './headless.mjs';
import { DURATION_MS, PDOS } from './scenario.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { version } = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
const config = {
  themes: ['light', 'dark'],
  pages: [
    'record',
    'pd',
    'trigger',
    'detection',
    'settings',
    'report-image',
    'report-long',
    'report-video',
    'protocol-report',
  ],
  output: 'docs/screenshots',
  languages: ['zh-CN', 'zh-TW', 'en', 'ja'],
};
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'npm run showcase:capture -- [--language zh-CN,zh-TW,en,ja] [--theme light,dark] [--page record,pd,trigger,detection,settings,report-image,report-long,report-video,protocol-report] [--output directory]',
  );
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  const [flag, value] = args.slice(i, i + 2);
  if (!value || !['--theme', '--page', '--output', '--language'].includes(flag))
    throw new Error(`Invalid capture option: ${flag}`);
  if (flag === '--output') config.output = value;
  else {
    const key = flag === '--theme' ? 'themes' : flag === '--language' ? 'languages' : 'pages';
    const choices = value.split(',');
    if (choices.some((choice) => !config[key].includes(choice))) throw new Error(`Invalid ${flag}: ${value}`);
    config[key] = [...new Set(choices)];
  }
}

await using harness = await createHeadlessHarness();
const faults = [];
const output = resolve(ROOT, config.output);
const payloadDirectory = resolve(ROOT, 'output/showcase-reports');
const reportJobs = [];
async function settled(page) {
  await frames(page);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(1, 799);
  await page.waitForFunction(() => window.__SHOWCASE__.diagnostics().seq === window.__WITRN_STREAM__().seq);
  await page.waitForFunction(() => !document.querySelector('#toast-region .toast'));
  assert.deepEqual(await page.evaluate(() => window.__SHOWCASE__.diagnostics().errors), []);
  const stream = await page.evaluate(() => window.__WITRN_STREAM__());
  assert.equal(stream.failed, false);
  assert.equal(stream.streamErrors, 0);
  assert.equal(faults.length, 0, faults.join('\n'));
  for (const id of ['minimize', 'maximize', 'close']) {
    assert.equal(await page.locator(`#decorum-tb-${id} .fi`).count(), 1, `Missing ${id} control icon`);
  }
  const staleLabels = await page.locator('.cs').evaluateAll((wrappers) =>
    wrappers.flatMap((wrapper) => {
      const select = wrapper.querySelector('select');
      const label = wrapper.querySelector('.cs-label');
      return select?.checkVisibility() ||
        !label?.checkVisibility() ||
        label.textContent === select?.selectedOptions[0]?.textContent
        ? []
        : [select?.id];
    }),
  );
  assert.deepEqual(staleLabels, [], 'Dropdown labels must match their selected options');
}
async function selectOption(page, id, value) {
  const index = await page
    .locator(`#${id}`)
    .evaluate((select, value) => Array.from(select.options).findIndex((option) => option.value === value), value);
  assert.ok(index >= 0, `Missing ${id} option: ${value}`);
  const button = page.locator(`#${id} + .cs-button`);
  await button.click();
  const menu = await button.getAttribute('aria-controls');
  await page.locator(`#${menu} .cs-option[data-index="${index}"]`).click();
  assert.equal(await page.locator(`#${id}`).inputValue(), value);
}
async function command(page, id) {
  await page.locator(`#${id}`).click();
  await page.waitForFunction(() => !document.getElementById('btn-km-pdm-open').disabled);
}
async function run(command, args) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? accept() : reject(new Error(`${command} exited with ${code}`))));
  });
}
try {
  await mkdir(output, { recursive: true });
  await mkdir(payloadDirectory, { recursive: true });
  for (const language of config.languages) {
    await mkdir(resolve(output, language), { recursive: true });
    for (const theme of config.themes) {
      await using app = await harness.openApp({
        language,
        theme,
        context: {
          deviceScaleFactor: 2,
          timezoneId: 'Asia/Hong_Kong',
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        },
      });
      const { page } = app;
      await app.connect();
      await page.locator('#btn-temp-toggle').click();
      await app.record();
      await app.advance(DURATION_MS);
      let pdmOpen = false;
      let detected = false;
      // Visit actual controls so all views render through the same paths used by the desktop app.
      for (const view of config.pages) {
        const path = resolve(output, language, `${theme}-${view}.png`);
        if (view === 'settings') {
          await page.locator('#btn-settings-tab').click();
          await page.waitForFunction(() => document.getElementById('about-version').textContent !== '--');
          assert.equal(await page.locator('#about-version').textContent(), `v${version}`);
        } else {
          // Re-entering monitor runs its normal visibility refresh, including throttled statistics.
          if (view === 'record') await page.locator('#tab-pd').click();
          const tab = view === 'record' || view.startsWith('report-') ? 'monitor' : view === 'pd' ? 'pd' : 'trigger';
          await page.locator(`#tab-${tab}`).click();
        }
        if (view.startsWith('report-')) {
          const payload = await page.evaluate(
            async ({ view, theme }) => {
              const { state } = await import('/state.js');
              const { setMarkers } = await import('/markers.js');
              const { t } = await import('/i18n.js');
              const { captureReport } = await import('/video-export.js');
              const { defaultVideoExportOptions } = await import('/video-export-options.js');
              const columns = state.chartSeries;
              const length = columns.x.length;
              // Imported marker fixtures show the eight-marker landscape limit and all-marker long layout.
              setMarkers(
                columns,
                Array.from({ length: 12 }, (_, index) => ({
                  index: Math.min(length - 1, Math.round(((index + 1) * (length - 1)) / 12)),
                  label: `${t('reportMarkers')} ${index + 1}`,
                })),
                length,
              );
              return captureReport(
                {
                  ...defaultVideoExportOptions,
                  theme,
                  reportType: view === 'report-video' ? 'video' : 'image',
                  imageLayout: view === 'report-long' ? 'long' : 'widescreen',
                },
                new AbortController().signal,
              );
            },
            { view, theme },
          );
          const payloadPath = resolve(payloadDirectory, `${language}-${theme}-${view}.json`);
          await writeFile(payloadPath, JSON.stringify(payload));
          reportJobs.push({ payload: payloadPath, output: path, frame: view === 'report-video' ? 119 : 0 });
        }
        if (view === 'record') {
          await page.waitForFunction(() => document.querySelector('.chart-container.has-data canvas') !== null);
          await page.waitForFunction(async () => {
            const { state } = await import('/state.js');
            const average = state.stats.voltage.sum / state.stats.voltage.count;
            const lastX = state.chartSeries.x.at(-1);
            return (
              document.getElementById('avg-voltage').textContent === average.toFixed(3) &&
              document.getElementById('rt-energy').textContent === state.energy.wh.toFixed(4) &&
              state.mainChart.data[0].at(-1) === lastX &&
              state.navigatorChart.data[0].at(-1) === lastX
            );
          });
          assert.notEqual(await page.locator('#rt-temp').textContent(), '--');
          assert.match(await page.locator('#record-duration').textContent(), /02:00/);
        }
        if (view === 'pd') {
          await page.locator('#pd-list').evaluate((list) => {
            list.scrollTop = 0;
          });
          await page.locator('.pd-row[data-index="2"]').click();
          await page.waitForFunction(
            () => !document.getElementById('pd-detail-body').hidden && document.querySelector('#pd-detail-body table'),
          );
        }
        if (['trigger', 'detection', 'protocol-report'].includes(view)) {
          if (!pdmOpen) {
            await command(page, 'btn-km-pdm-open');
            pdmOpen = true;
          }
          if (!detected) {
            await page.locator('#btn-km-mode-detection').click();
            await command(page, 'btn-km-scan');
            detected = true;
          }
          await page.locator(`#btn-km-mode-${view === 'trigger' ? 'trigger' : 'detection'}`).click();
          if (view === 'trigger') {
            await command(page, 'btn-km-read-pdo');
            await page.locator('.trigger-pdo-row').filter({ hasText: '#5' }).click();
            await command(page, 'btn-km-trigger');
            assert.equal(await page.locator('.trigger-pdo-row').count(), PDOS.length);
          }
          if (view === 'protocol-report') {
            await page.locator('#btn-km-export-report').click();
            await selectOption(page, 'protocol-report-theme', theme);
            const downloadReady = page.waitForEvent('download');
            await page.locator('#protocol-report-generate').click();
            const download = await downloadReady;
            await download.saveAs(path);
            await page.locator('#protocol-report-dialog').waitFor({ state: 'hidden' });
          }
        }
        faults.push(...app.errors.splice(0), ...app.consoleErrors.splice(0));
        await settled(page);
        assert.equal(await page.locator('html').getAttribute('lang'), language);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
          false,
          `${language}/${theme}/${view}: viewport overflow`,
        );
        if (!view.startsWith('report-') && view !== 'protocol-report') {
          await page.screenshot({ path, animations: 'disabled' });
        }
        console.log(`${theme}/${view}: ${path}${view.startsWith('report-') ? ' (render queued)' : ''}`);
      }
    }
  }
  if (reportJobs.length) {
    const jobsPath = resolve(payloadDirectory, 'jobs.json');
    await writeFile(jobsPath, JSON.stringify(reportJobs, null, 2));
    await run(process.execPath, ['scripts/build-dist.mjs']);
    await run('cargo', ['run', '--locked', '-p', 'lapower', '--example', 'showcase-reports', '--', jobsPath]);
  }
} catch (error) {
  if (faults.length) console.error(faults.join('\n'));
  throw error;
}
