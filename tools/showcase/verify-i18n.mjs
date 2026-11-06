import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { dictionaries, resolveLocale, systemLanguageName } from '../../src/i18n.js';
import { startServer } from './server.mjs';

const languages = ['en', 'zh-CN', 'zh-TW', 'ja'];
const server = await startServer();
const browser = await chromium.launch({ headless: true });
const output = resolve('output/i18n-verification');
await mkdir(output, { recursive: true });
const failures = [];

async function assertTriggerLayout(page, label) {
  const metrics = await page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      };
    };
    return {
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      },
      body: box('#km-trigger-body'),
      controls: box('#km-trigger-body .trigger-controls'),
      log: box('#km-log-pane'),
      controlOverflow: Array.from(document.querySelectorAll('#km-trigger-body .trigger-controls *'))
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({
          id: element.id,
          className: String(element.className),
          tag: element.tagName,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          minWidth: getComputedStyle(element).minWidth,
          text: element.textContent.trim().slice(0, 60),
        })),
      historyOverflowY: getComputedStyle(document.querySelector('#km-history-list')).overflowY,
    };
  });
  assert.ok(metrics.document.scrollWidth <= metrics.document.clientWidth + 1, `${label}: document overflow`);
  for (const [name, element] of Object.entries({ body: metrics.body, controls: metrics.controls, log: metrics.log })) {
    assert.ok(
      element.scrollWidth <= element.clientWidth + 1,
      `${label}: ${name} horizontal overflow (${element.scrollWidth}/${element.clientWidth}) ${
        name === 'controls' ? JSON.stringify(metrics.controlOverflow) : ''
      }`,
    );
  }
  assert.ok(metrics.log.width > 0 && metrics.log.height > 0, `${label}: history is always visible`);
  assert.ok(Math.abs(metrics.log.y - metrics.body.y) <= 1, `${label}: history shares workspace top`);
  assert.ok(Math.abs(metrics.log.height - metrics.body.height) <= 1, `${label}: history fills workspace height`);
  assert.ok(metrics.log.x >= metrics.controls.x + metrics.controls.width - 1, `${label}: history stays docked right`);
  assert.equal(metrics.historyOverflowY, 'auto', `${label}: history has independent vertical scrolling`);
}

try {
  const dialogsPage = await browser.newPage({ locale: 'en-US' });
  dialogsPage.on('pageerror', (error) => failures.push(String(error)));
  await dialogsPage.goto(`${server.url}/app/?capture=1&language=en`);
  await dialogsPage.waitForFunction(() => !!document.getElementById('tab-monitor'));
  await dialogsPage.evaluate(async () => {
    const { toast } = await import('/ui/toast.js');
    const { t, errorText } = await import('/i18n.js');
    const { ask } = await import('/ui/dialog.js');
    window.__I18N_TOAST__ = toast.error(() => errorText({ code: 'backendFailure', detail: 'raw diagnostic' }), {
      duration: 0,
      action: { label: () => t('recover'), onClick: () => false },
    });
    window.__I18N_DIALOG__ = ask(() => t('resetPrompt'), { title: () => t('confirmReset'), kind: 'warning' });
  });
  await dialogsPage.locator('dialog[open]').waitFor();
  for (const language of languages) {
    await dialogsPage.evaluate(async (language) => (await import('/i18n.js')).applyLanguage(language), language);
    const dictionary = dictionaries[language];
    assert.equal(await dialogsPage.locator('#fluent-dialog-title').textContent(), dictionary.confirmReset);
    assert.equal(await dialogsPage.locator('.fluent-dialog-body').textContent(), dictionary.resetPrompt);
    assert.equal(await dialogsPage.locator('.fluent-dialog-ok').textContent(), dictionary.ok);
    assert.equal(await dialogsPage.locator('.fluent-dialog-cancel').textContent(), dictionary.cancel);
    assert.equal(
      await dialogsPage.locator('.toast-text').textContent(),
      dictionary.backendFailure.replace('{detail}', 'raw diagnostic'),
    );
    assert.equal(await dialogsPage.locator('.toast-action').textContent(), dictionary.recover);
    assert.equal(await dialogsPage.locator('.toast-close').getAttribute('aria-label'), dictionary.closeNotification);
    assert.equal(await dialogsPage.locator('#tab-monitor').getAttribute('aria-label'), dictionary.monitor);
    assert.equal(await dialogsPage.locator('dialog[open]').getAttribute('aria-labelledby'), 'fluent-dialog-title');
    const deviceName = await dialogsPage.evaluate(async () => {
      const { deviceDisplayName } = await import('/device.js');
      return deviceDisplayName({
        model_name: 'Unknown WITRN device (0716:50FF)',
        display_name: 'legacy name',
        usb_port: '4-4',
        model_description: { code: 'unknownWitrnDevice', params: { vid: '0716', pid: '50FF' } },
        interface_description: { code: 'deviceInterface', params: { index: '2', usage: 'FF00' } },
      });
    });
    assert.equal(
      deviceName,
      `${dictionary.unknownWitrnDevice.replace('{vid}', '0716').replace('{pid}', '50FF')} (USB 4-4) [${dictionary.deviceInterface.replace('{index}', '2').replace('{usage}', 'FF00')}]`,
    );
  }
  await dialogsPage.locator('.fluent-dialog-cancel').click();
  assert.equal(await dialogsPage.evaluate(() => window.__I18N_DIALOG__), false);
  await dialogsPage.close();
  console.log('PASS: open dialog, persistent notification, actions and accessible labels switch in place');
  for (const locale of ['zh-Hans-TW', 'zh-Hant-CN', 'ja-JP', 'fr-FR', 'C']) {
    const page = await browser.newPage({ locale: 'en-US' });
    page.on('pageerror', (error) => failures.push(String(error)));
    await page.goto(`${server.url}/app/?capture=1&language=auto&systemLocale=${locale}`);
    await page.waitForFunction(() => !!document.getElementById('tab-monitor'));
    assert.equal(await page.locator('html').getAttribute('lang'), resolveLocale(locale));
    for (const language of languages) {
      await page.evaluate(async (language) => (await import('/i18n.js')).applyLanguage(language), language);
      assert.equal(
        await page.locator('#language-select option[value=auto]').textContent(),
        `${dictionaries[language].followSystem} (${systemLanguageName(locale)})`,
      );
    }
    await page.close();
  }
  for (const theme of ['light', 'dark'])
    for (const [width, height] of [
      [900, 600],
      [1280, 800],
    ]) {
      const context = await browser.newContext({ viewport: { width, height }, locale: 'en-US', colorScheme: theme });
      const page = await context.newPage();
      page.on('pageerror', (error) => failures.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') failures.push(message.text());
      });
      await page.goto(`${server.url}/app/?capture=1&theme=${theme}&language=en`);
      await page.waitForFunction(() => !document.getElementById('btn-connect').disabled);
      await page.locator('#tab-trigger').click();
      assert.equal(await page.locator('#btn-km-mode-trigger').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#km-pdm-status').textContent(), dictionaries.en.pdmClosed);
      assert.equal(await page.locator('#btn-km-scan').isDisabled(), true);
      await assertTriggerLayout(page, `${theme}/${width}/disconnected-trigger`);
      await page.locator('#btn-km-mode-detection').click();
      assert.equal(await page.locator('#btn-km-mode-detection').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#btn-km-scan-full').isDisabled(), true);
      await assertTriggerLayout(page, `${theme}/${width}/disconnected-detection`);
      await page.locator('#btn-km-mode-trigger').click();
      await page.locator('#tab-monitor').click();
      await page.locator('#device-select').selectOption('showcase:km003c', { force: true });
      await page.locator('#btn-connect').click();
      await page.waitForFunction(() => window.__SHOWCASE__.diagnostics().connected);
      await page.locator('#btn-record-toggle').click();
      await page.waitForFunction(() => window.__SHOWCASE__.diagnostics().segment > 0);
      await page.evaluate(() => window.__SHOWCASE__.advance(120_000));
      await page.locator('#tab-pd').click();
      await page.locator('#pd-filter').fill('Source');
      await page.locator('.pd-row').first().click();
      await page.locator('.pd-row.selected').waitFor();
      await page.locator('#pd-detail-body:visible').waitFor();
      await page.locator('#tab-trigger').click();
      assert.equal(await page.locator('#btn-km-mode-trigger').getAttribute('aria-selected'), 'true');
      await page.locator('#btn-km-pdm-open').click();
      await page.waitForFunction(() => !document.getElementById('btn-km-pdm-open').disabled);
      assert.equal(await page.locator('#km-pdm-status').textContent(), dictionaries.en.pdmOpen);
      const pdmSettings = await page
        .locator('#km-pdm-type, #km-pdm-em, #km-pdm-sink')
        .evaluateAll((nodes) => nodes.map((node) => node.value));
      await page.locator('#btn-km-read-pdo').click();
      await page.waitForFunction(() => document.querySelectorAll('.trigger-pdo-row').length > 0);
      await page.evaluate(() => {
        window.__SHOWCASE__.setTriggerDelay(300);
        window.__SHOWCASE__.setNextDetectionCompletion('partial');
      });
      await page.locator('#btn-km-mode-detection').click();
      await page.locator('#btn-km-scan').click();
      await page.locator('#btn-km-cancel:not([hidden])').waitFor();
      assert.match(await page.locator('#km-detection-summary').textContent(), /Scanning/);
      await page.locator('#btn-km-cancel').click();
      assert.equal(await page.locator('#btn-km-cancel').isHidden(), false, 'cancel waits for backend terminal state');
      assert.equal(
        await page.locator('#btn-km-read-pdo').isDisabled(),
        true,
        'commands stay locked until terminal state',
      );
      await page.waitForFunction(() => document.getElementById('btn-km-cancel').hidden);
      assert.equal(await page.locator('#km-history-list .trigger-history-item.is-cancelled').count(), 1);

      await page.evaluate(() => window.__SHOWCASE__.setTriggerDelay(100));
      await page.locator('#btn-km-scan').click();
      await page.locator('#btn-km-cancel:not([hidden])').waitFor();
      assert.deepEqual(
        await page
          .locator('#km-pdm-type, #km-pdm-em, #km-pdm-sink')
          .evaluateAll((nodes) => nodes.map((node) => node.value)),
        pdmSettings,
      );
      await page.waitForFunction(() => document.getElementById('btn-km-cancel').hidden);
      await page.evaluate(() => window.__SHOWCASE__.resetTriggerDelay());
      await page.waitForFunction(
        () => document.getElementById('km-detection-summary').textContent === 'Detection incomplete',
      );
      assert.ok(await page.locator('.trigger-detection-group.is-pd [data-protocol="pd"]').count());
      await page.evaluate(() => window.__SHOWCASE__.setTriggerDelay(300));
      await page.locator('#btn-km-scan-full').click();
      await page.locator('#btn-km-cancel:not([hidden])').waitFor();
      assert.equal(await page.locator('#km-log-activity').isHidden(), false);
      assert.equal(await page.locator('#km-log-state').textContent(), dictionaries.en.triggerHistoryRunning);
      await page.evaluate(() => window.__SHOWCASE__.resetTriggerDelay());
      await page.waitForFunction(() => document.getElementById('btn-km-cancel').hidden);
      await page.waitForFunction(
        () => document.getElementById('km-detection-summary').textContent === 'Detection complete',
      );
      assert.deepEqual(
        await page
          .locator('#km-pdm-type, #km-pdm-em, #km-pdm-sink')
          .evaluateAll((nodes) => nodes.map((node) => node.value)),
        pdmSettings,
      );
      const inferredVersion = dictionaries.en.scanPdVersionInferred
        .replace('{revision}', '3.2')
        .replace('{feature}', dictionaries.en.scanPdFeatureSprAvs);
      await page.locator('#btn-km-mode-detection').click();
      const pdResult = page.locator('.trigger-detection-result[data-protocol="pd"]');
      assert.equal(await pdResult.locator('.trigger-detection-version').textContent(), inferredVersion);
      await assertTriggerLayout(page, `${theme}/${width}/completed-detection`);
      assert.ok(
        (await pdResult.locator('.trigger-voltage-chip').count()) > 0,
        'PD voltage steps render as framed chips',
      );
      assert.equal(await pdResult.evaluate((element) => getComputedStyle(element).gridColumn), '1 / -1');

      await page.evaluate(() => {
        window.__SHOWCASE__.setPdVersionCapabilities(false);
        window.__SHOWCASE__.setTriggerDelay(100);
      });
      await page.locator('#btn-km-scan').click();
      await page.locator('#btn-km-cancel:not([hidden])').waitFor();
      await page.waitForFunction(() => document.getElementById('btn-km-cancel').hidden);
      await page.evaluate(() => window.__SHOWCASE__.resetTriggerDelay());
      assert.equal(
        await pdResult.locator('.trigger-detection-version').textContent(),
        dictionaries.en.scanPdVersionUnknown,
      );
      assert.equal(
        await pdResult.locator('.trigger-detection-state').textContent(),
        dictionaries.en.scanSupported,
        'unconfirmed revision does not change confirmed PD support',
      );
      await page.evaluate(() => {
        window.__SHOWCASE__.setPdVersionCapabilities(true);
        window.__SHOWCASE__.setTriggerDelay(100);
      });
      await page.locator('#btn-km-scan').click();
      await page.locator('#btn-km-cancel:not([hidden])').waitFor();
      await page.waitForFunction(() => document.getElementById('btn-km-cancel').hidden);
      await page.evaluate(() => window.__SHOWCASE__.resetTriggerDelay());
      const callsBeforeFill = await page.evaluate(() => window.__SHOWCASE__.diagnostics().triggerCalls);
      await page
        .locator('.trigger-detection-group.is-pd [data-protocol="pd"] .trigger-detection-action button')
        .click();
      assert.equal(await page.locator('#btn-km-mode-trigger').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#km-proto').inputValue(), 'pd');
      assert.equal(await page.locator('#km-req-pos').inputValue(), '1');
      assert.equal(await page.evaluate(() => window.__SHOWCASE__.diagnostics().triggerCalls), callsBeforeFill);

      await page.locator('#km-req-pos').fill('3');
      await page.locator('#km-req-volt').fill('9000');
      await page.locator('#km-req-cur').fill('3000');
      await page.locator('#btn-km-trigger').click();
      await page.waitForFunction(() => document.getElementById('btn-km-cancel').hidden);
      await page.locator('#km-history-list .trigger-history-item').first().waitFor();
      for (const [viewportWidth, viewportHeight] of [
        [900, 600],
        [1280, 800],
      ]) {
        await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        await assertTriggerLayout(page, `${theme}/${viewportWidth}/trigger-history`);
        await page.screenshot({ path: resolve(output, `${theme}-${viewportWidth}-trigger-history.png`) });
      }
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await page.locator('#km-log-command-filter').selectOption('pd_req');
      await page.locator('#km-log-status-filter').selectOption('success');
      await page.locator('#km-log-text-filter').fill('12.00V');
      assert.equal(await page.locator('#km-history-list .trigger-history-item').count(), 1);
      const contextCalls = await page.evaluate(() => window.__SHOWCASE__.diagnostics().triggerCalls);
      await page.locator('#km-log-text-filter').fill('');
      const pdRequest = page.locator('#km-history-list .trigger-history-item').first();
      await pdRequest.locator('summary').click();
      await page.locator('#km-req-pos').fill('1');
      await page.locator('#km-req-volt').fill('5000');
      await pdRequest.getByRole('button', { name: 'Fill form' }).click();
      assert.equal(await page.locator('#km-req-pos').inputValue(), '3');
      assert.equal(await page.locator('#km-req-volt').inputValue(), '9000');
      assert.equal(await page.evaluate(() => window.__SHOWCASE__.diagnostics().triggerCalls), contextCalls);
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.locator('#btn-km-log-copy').click();
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /pd_req position=3/);
      await page.locator('#btn-km-log-export').click();
      assert.match(await page.evaluate(() => window.__SHOWCASE__.diagnostics().lastTextExport), /PDO #3: 12\.00V/);

      await page.locator('#km-log-command-filter').selectOption('');
      await page.locator('#km-log-status-filter').selectOption('');
      await page.locator('details.trigger-advanced > summary').click();
      await page.evaluate(() => window.__SHOWCASE__.failNextTrigger());
      await page.locator('#btn-km-pd-cmd').click();
      await page.waitForFunction(() => document.getElementById('btn-km-cancel').hidden);
      await page.locator('#km-log-command-filter').selectOption('pd_cmd');
      await page.locator('#km-log-status-filter').selectOption('failure');
      assert.equal(await page.locator('#km-history-list .trigger-history-item.is-failure').count(), 1);

      await page.locator('#km-log-command-filter').selectOption('');
      await page.locator('#km-log-status-filter').selectOption('');
      await page.evaluate(() => window.__SHOWCASE__.setTriggerDelay(250));
      await page.locator('#btn-km-reset').click();
      await page.locator('#btn-km-cancel:not([hidden])').waitFor();
      assert.equal(await page.locator('#km-log-activity').isHidden(), false);
      assert.equal(await page.locator('#km-log-state').textContent(), dictionaries.en.triggerHistoryRunning);
      assert.equal(await page.locator('#km-history-list .trigger-history-item.is-running').count(), 1);
      await page.locator('#btn-km-cancel').click();
      await page.waitForFunction(() => document.getElementById('btn-km-cancel').hidden);
      await page.evaluate(() => window.__SHOWCASE__.resetTriggerDelay());
      await page.locator('#km-log-command-filter').selectOption('reset');
      await page.locator('#km-log-status-filter').selectOption('cancelled');
      assert.equal(await page.locator('#km-history-list .trigger-history-item.is-cancelled').count(), 1);
      await page.locator('#btn-km-mode-trigger').click();
      await page.locator('#btn-settings-tab').click();
      assert.equal(await page.locator('#window-style-auto').count(), 0);
      assert.equal(await page.locator('#window-style-windows').isChecked(), true);
      await page.evaluate(async () => {
        const { state } = await import('/state.js');
        state.settings.rangeStart = 200;
        state.settings.rangeEnd = 800;
        window.__I18N_SNAPSHOT__ = {
          columns: state.chartSeries,
          chart: state.mainChart,
          length: state.chartSeries.x.length,
          energy: state.energy.wh,
          selected: document.querySelector('.pd-row.selected')?.dataset.index,
          generation: window.__WITRN_STREAM__().generation,
          pdCaptureButton: document.getElementById('btn-pd-pause'),
          pdCaptureIcon: document.querySelector('#btn-pd-pause i'),
          pdCaptureLabel: document.querySelector('#btn-pd-pause span'),
          pdDetail: document.getElementById('pd-detail-body').textContent,
        };
      });
      for (const language of languages) {
        await page.locator('#language-select').selectOption(language, { force: true });
        await page.waitForFunction((lang) => document.documentElement.lang === lang, language);
        await page.waitForFunction(
          (expected) => document.querySelector('#tab-monitor span').textContent === expected,
          dictionaries[language].monitor,
        );
        const stable = await page.evaluate(async () => {
          const { state } = await import('/state.js');
          const before = window.__I18N_SNAPSHOT__;
          return {
            connected: state.isConnected,
            recording: state.isRecording,
            columns: state.chartSeries === before.columns,
            chart: state.mainChart === before.chart,
            length: state.chartSeries.x.length === before.length,
            energy: state.energy.wh === before.energy,
            range: state.settings.rangeStart === 200 && state.settings.rangeEnd === 800,
            generation: window.__WITRN_STREAM__().generation === before.generation,
            filter: document.getElementById('pd-filter').value === 'Source',
            selected: document.querySelector('.pd-row.selected')?.dataset.index === before.selected,
            actualSelection: before.selected !== undefined,
            pdCaptureButton: document.getElementById('btn-pd-pause') === before.pdCaptureButton,
            pdCaptureIcon: document.querySelector('#btn-pd-pause i') === before.pdCaptureIcon,
            pdCaptureLabel: document.querySelector('#btn-pd-pause span') === before.pdCaptureLabel,
            pdDetail: document.getElementById('pd-detail-body').textContent === before.pdDetail,
          };
        });
        for (const [key, value] of Object.entries(stable))
          assert.equal(value, true, `${theme}/${width}/${language}: ${key}`);
        assert.equal(await page.locator('#btn-connect-label').textContent(), dictionaries[language].disconnect);
        assert.equal(await page.locator('#pd-filter').getAttribute('placeholder'), dictionaries[language].pdFilter);
        assert.equal(await page.locator('#btn-pd-pause span').textContent(), dictionaries[language].pauseRecording);
        assert.equal(
          await page.locator('#btn-pd-pause').getAttribute('aria-label'),
          dictionaries[language].pdFollowPause,
        );
        assert.equal(await page.locator('#pd-table-head .pd-col-time').textContent(), dictionaries[language].pdElapsed);
        const currentSelect = await page
          .locator('#language-select')
          .evaluate((select) => select.parentElement.querySelector('.cs-label').textContent);
        assert.equal(
          currentSelect,
          { en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語' }[language],
        );
        for (const view of ['settings', 'monitor', 'pd', 'trigger']) {
          await page.locator(view === 'settings' ? '#btn-settings-tab' : `#tab-${view}`).click();
          await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
          if (view === 'monitor') {
            await page.evaluate(async () => {
              const { state } = await import('/state.js');
              state.mainChart.setCursor({ left: 100, top: 100 });
            });
            await page.waitForFunction(
              (label) => document.querySelector('.chart-tooltip-row')?.textContent.startsWith(label),
              dictionaries[language].voltage,
            );
          }
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
          assert.equal(overflow, false, `${language}/${view}/${width}: viewport overflow`);
          if (view === 'trigger') {
            assert.equal(await page.locator('#btn-km-mode-trigger').getAttribute('aria-selected'), 'true');
            assert.equal(await page.locator('#km-log-pane').isHidden(), false);
            assert.equal(await page.locator('#km-log-title').textContent(), dictionaries[language].triggerHistoryTitle);
            await assertTriggerLayout(page, `${language}/${theme}/${width}/trigger`);
            await page.locator('#btn-km-mode-detection').click();
            await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
            await assertTriggerLayout(page, `${language}/${theme}/${width}/detection`);
            assert.equal(
              await page
                .locator('.trigger-detection-result[data-protocol="pd"] .trigger-detection-version')
                .textContent(),
              dictionaries[language].scanPdVersionInferred
                .replace('{revision}', '3.2')
                .replace('{feature}', dictionaries[language].scanPdFeatureSprAvs),
            );
            await page.screenshot({ path: resolve(output, `${language}-${theme}-${width}-trigger-detection.png`) });
            await page.locator('#btn-km-mode-trigger').click();
          }
          await page.screenshot({ path: resolve(output, `${language}-${theme}-${width}-${view}.png`) });
        }
        assert.equal(await page.locator('#km-pdm-status').textContent(), dictionaries[language].pdmOpen);
        await page.locator('#btn-settings-tab').click();
      }
      console.log(
        `PASS: ${theme} ${width}x${height}, four languages, active connection/recording/PDM and preserved data/selection`,
      );
      assert.deepEqual(await page.evaluate(() => window.__SHOWCASE__.diagnostics().errors), []);
      await context.close();
    }
  assert.deepEqual(failures, []);
  console.log('PASS: native locale mapping and English fallback');
} finally {
  await browser.close();
  await server.close();
}
