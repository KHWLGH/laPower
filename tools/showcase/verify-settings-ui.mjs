import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const server = await startServer();
const browser = await chromium.launch({ headless: true });
const output = resolve('output/settings-verification');
await mkdir(output, { recursive: true });
const errors = [];
const results = [];
const sections = ['appearance', 'recording', 'shortcuts', 'recovery', 'about'];

async function settle(page) {
  await page.evaluate(() => new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept))));
}

async function checkLayout(page) {
  const layout = await page.evaluate(() => {
    const page = document.querySelector('.settings-page');
    const nav = document.querySelector('.settings-nav');
    const main = document.querySelector('.settings-main');
    const root = document.documentElement;
    const bounds = (element) => {
      const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
      return { x, y, width, height, right, bottom };
    };
    const buttons = [...document.querySelectorAll('.titlebar-connect > button')].map(bounds);
    return {
      overflow: root.scrollWidth > innerWidth + 1 || page.scrollWidth > page.clientWidth + 1,
      horizontal: getComputedStyle(nav).flexDirection === 'row',
      nav: bounds(nav),
      main: bounds(main),
      buttons,
      clippedControls: [...page.querySelectorAll('.settings-row-control')].some((control) => {
        const rect = control.getBoundingClientRect();
        return rect.x < main.getBoundingClientRect().x - 1 || rect.right > main.getBoundingClientRect().right + 1;
      }),
    };
  });
  assert.equal(layout.overflow, false, 'Settings must not overflow horizontally');
  assert.equal(layout.clippedControls, false, 'Settings controls must fit inside the content column');
  for (let i = 1; i < layout.buttons.length; i++) {
    assert.ok(layout.buttons[i].x >= layout.buttons[i - 1].right, 'Title bar buttons must not overlap');
  }
  return layout;
}

try {
  for (const { width, height, scale = 100 } of [
    { width: 1280, height: 800 },
    { width: 900, height: 600 },
    // Effective logical viewport of a 1280×800 window at 150% WebView zoom.
    { width: 854, height: 534 },
    { width: 1280, height: 800, scale: 150 },
  ]) {
    const viewport = { width, height };
    const label = scale === 100 ? String(width) : `${width}-${scale}pct`;
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1.5, locale: 'zh-CN' });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.route('**/__showcase__/bridge.js', async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          body:
            (await response.text()) +
            `
const settingsTestInvoke = window.__TAURI__.core.invoke;
window.__TAURI__.core.invoke = (command, args) => {
  if (command === 'enumerate_devices') {
    if (window.__SETTINGS_TEST_ENUMERATION__ === 'empty') return Promise.resolve([]);
    if (window.__SETTINGS_TEST_ENUMERATION__ === 'error') return Promise.reject(new Error('Enumeration unavailable'));
  }
  return settingsTestInvoke(command, args);
};`,
        });
      });
      await page.goto(`${server.url}/app/?capture=1&theme=${theme}&language=zh-CN`);
      await page.waitForFunction(() => !document.getElementById('btn-connect').disabled);
      if (scale !== 100) {
        await page.evaluate(async (value) => (await import('/ui-scale.js')).applyUiScale(value), scale);
        await settle(page);
      }

      // The information flyout works before the settings view has ever been opened.
      const info = page.locator('#btn-device-info');
      assert.equal((await info.innerText()).trim(), '');
      assert.equal(await info.locator('.fi-info').count(), 1);
      assert.equal(await info.locator('.fi-chevron-down').count(), 0);
      const order = await page
        .locator('.titlebar-connect > button')
        .evaluateAll((nodes) => nodes.map((node) => node.id));
      assert.deepEqual(order, ['btn-refresh-devices', 'btn-device-info', 'btn-connect']);
      await info.click();
      assert.equal(await info.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('#device-info-details').isVisible(), true);
      const initialSerial = await page.locator('#device-sn').innerText();
      await page.keyboard.press('Escape');
      assert.equal(await info.getAttribute('aria-expanded'), 'false');
      assert.equal(await info.evaluate((node) => node === document.activeElement), true);
      await page.locator('#device-select').selectOption('showcase:km003c', { force: true });
      await info.click();
      assert.notEqual(await page.locator('#device-sn').innerText(), initialSerial);
      assert.equal(await page.locator('#device-vid').innerText(), '0x5FC9');
      await page.keyboard.press('Escape');
      await page.locator('#btn-connect').click();
      await info.click();
      assert.equal(await page.locator('#device-sn').innerText(), 'KM003C-DEMO-001');
      await page.locator('#device-select').selectOption('showcase:k2', { force: true });
      assert.equal(
        await page.locator('#device-sn').innerText(),
        'KM003C-DEMO-001',
        'Connected device takes precedence',
      );
      await page.mouse.click(5, 70);
      assert.equal(await info.getAttribute('aria-expanded'), 'false');
      await page.locator('#btn-temp-toggle').click();
      assert.equal(await page.locator('#btn-temp-toggle').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#flyout-temp').isVisible(), false);
      await page.locator('#btn-temp-toggle').click();
      await page.locator('#btn-connect').click();
      assert.equal(await page.locator('#device-sn').textContent(), initialSerial, 'Disconnect follows the selection');

      // The arrow opens configuration without changing the main action state.
      for (const [group, main, arrow, panel] of [
        ['auto-pause-actions', 'btn-auto-pause-command', 'btn-flyout-autopause', 'flyout-autopause'],
        ['temperature-actions', 'btn-temp-toggle', 'btn-flyout-temp', 'flyout-temp'],
      ]) {
        assert.match(await page.locator(`#${group}`).getAttribute('class'), /split-button/);
        assert.equal(await page.locator(`#${arrow} .fi-chevron-down`).count(), 1);
        const before = await page.locator(`#${main}`).getAttribute('aria-pressed');
        await page.locator(`#${arrow}`).click();
        assert.equal(await page.locator(`#${panel}`).isVisible(), true);
        assert.equal(
          await page.locator(`#${panel}`).evaluate((node) => node.contains(document.activeElement)),
          true,
          'Opening configuration moves keyboard focus into the flyout',
        );
        assert.equal(await page.locator(`#${main}`).getAttribute('aria-pressed'), before);
        await page.keyboard.press('Escape');
      }
      await page.locator('#btn-auto-pause-command').click();
      assert.equal(await page.locator('#btn-auto-pause-command').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#flyout-autopause').isVisible(), false);
      await page.locator('#btn-auto-pause-command').click();

      await page.locator('#btn-settings-tab').click();
      await settle(page);
      assert.equal(await page.locator('#view-settings #device-vid').count(), 0);
      for (const language of ['zh-CN', 'zh-TW', 'en', 'ja']) {
        await page.evaluate(async (value) => (await import('/i18n.js')).applyLanguage(value), language);
        await settle(page);
        const translations = await page.evaluate(async () => {
          const { t } = await import('/i18n.js');
          return { deviceInfo: t('deviceInfo'), autoPauseSettings: t('autoPauseSettings') };
        });
        assert.equal(await info.getAttribute('title'), translations.deviceInfo);
        assert.equal(await info.getAttribute('aria-label'), translations.deviceInfo);
        assert.equal(
          await page.locator('#flyout-autopause').getAttribute('aria-label'),
          translations.autoPauseSettings,
        );
        const layout = await checkLayout(page);
        assert.equal(layout.horizontal, viewport.width < 980);
        for (const section of sections) {
          const link = page.locator(`.settings-nav-link[href="#settings-${section}"]`);
          // Keyboard activation also exercises navigation when a link is offscreen horizontally.
          await link.focus();
          await link.press('Enter');
          await page.waitForFunction(() => !document.querySelector('.settings-page').getAnimations().length);
          await page.waitForFunction((id) => {
            const heading = document.querySelector(`#settings-${id} h2`);
            const page = document.querySelector('.settings-page');
            const nav = document.querySelector('.settings-nav');
            const scale = document.documentElement.hasAttribute('data-ui-scale-css')
              ? Number.parseFloat(document.documentElement.style.getPropertyValue('--ui-scale')) || 1
              : 1;
            const offset = getComputedStyle(nav).flexDirection === 'row' ? nav.offsetHeight + 12 : 12;
            const distance = (heading.getBoundingClientRect().top - page.getBoundingClientRect().top) / scale;
            return Math.abs(distance - offset) <= 2 || page.scrollTop >= page.scrollHeight - page.clientHeight - 2;
          }, section);
          await settle(page);
          const target = await page.locator(`#settings-${section}`).boundingBox();
          const nav = await page.locator('.settings-nav').boundingBox();
          const settings = await page.locator('.settings-page').boundingBox();
          assert.ok(target.y < settings.y + settings.height && target.y + target.height > settings.y);
          if (layout.horizontal) assert.ok(target.y >= nav.y + nav.height - 1, `${section} is behind the directory`);
          assert.equal(await link.getAttribute('aria-current'), 'location', `${language}/${viewport.width}/${section}`);
          assert.equal(await page.locator('.settings-nav-link[aria-current]').count(), 1);
        }
        const savedTop = await page.locator('.settings-page').evaluate((node) => node.scrollTop);
        await page.locator('#tab-monitor').click();
        await page.locator('#btn-settings-tab').click();
        await settle(page);
        assert.equal(await page.locator('.settings-page').evaluate((node) => node.scrollTop), savedTop);
        // Manual scrolling updates the current section, including the short final About section.
        await page.locator('.settings-page').evaluate((node) => node.scrollTo(0, 0));
        await settle(page);
        assert.equal(
          await page.locator('.settings-nav-link[aria-current]').getAttribute('href'),
          '#settings-appearance',
        );
        await page.locator('.settings-page').evaluate((node) => node.scrollTo(0, node.scrollHeight));
        await settle(page);
        assert.equal(await page.locator('.settings-nav-link[aria-current]').getAttribute('href'), '#settings-about');
        await page.screenshot({ path: resolve(output, `${language}-${theme}-${label}-about.png`) });
        await page.locator('.settings-page').evaluate((node) => node.scrollTo(0, 0));
        await settle(page);
        await page.screenshot({ path: resolve(output, `${language}-${theme}-${label}-settings.png`) });
        results.push({ viewport, scale, theme, language });
      }

      // Empty enumeration and errors must not leave information from the previous device.
      await page.locator('#tab-monitor').click();
      await page.evaluate(async () => {
        window.__SETTINGS_TEST_ENUMERATION__ = 'empty';
        await (await import('/device.js')).refreshDeviceList();
        window.__SETTINGS_TEST_ENUMERATION__ = '';
      });
      await info.click();
      assert.equal(await page.locator('#device-info-empty').isVisible(), true);
      assert.equal(await page.locator('#device-info-details').isVisible(), false);
      assert.equal(await page.locator('#device-sn').textContent(), '--');
      await page.keyboard.press('Escape');
      await page.locator('#btn-refresh-devices').click();
      await page.evaluate(async () => {
        window.__SETTINGS_TEST_ENUMERATION__ = 'error';
        await (await import('/device.js')).refreshDeviceList();
        window.__SETTINGS_TEST_ENUMERATION__ = '';
      });
      await info.click();
      assert.equal(await page.locator('#device-info-empty').isVisible(), true);
      await page.keyboard.press('Escape');
      await page.locator('#btn-refresh-devices').click();
      await page.evaluate(async () => {
        const { state } = await import('/state.js');
        const selected = state.deviceList.find((entry) => entry.path === state.selectedDevicePath);
        selected.serial_number = 'SERIAL-'.repeat(80);
        (await import('/device.js')).onDeviceSelect();
      });
      await info.click();
      const flyout = await page.locator('#flyout-device-info').evaluate((node) => ({
        overflow: node.scrollWidth > node.clientWidth,
        right: node.getBoundingClientRect().right,
      }));
      assert.equal(flyout.overflow, false);
      assert.ok(flyout.right <= viewport.width);
      await page.locator('#flyout-device-info').evaluate((node) => node.scrollTo(0, node.scrollHeight));
      await settle(page);
      assert.equal(await info.getAttribute('aria-expanded'), 'true', 'Scrolling long details keeps the flyout open');
      await page.screenshot({ path: resolve(output, `${theme}-${label}-device-info.png`) });
      await context.close();
      console.log(
        `PASS: settings navigation and toolbar, ${theme}, ${width}×${height}, ${scale}% UI scale, four languages`,
      );
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await browser.close();
  await server.close();
}
