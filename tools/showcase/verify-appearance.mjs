import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const server = await startServer();
const browser = await chromium.launch({ headless: true });
const output = resolve('output/appearance-verification');
await mkdir(output, { recursive: true });
const results = [];
const failures = [];
async function renderedFonts(client, selector) {
  const { root } = await client.send('DOM.getDocument');
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  assert.ok(nodeId, `Missing font sample: ${selector}`);
  return (await client.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
}
function assertChineseFont(fonts) {
  assert.ok(fonts.some((font) => font.familyName === 'Microsoft YaHei UI' && font.glyphCount > 0));
  assert.ok(fonts.every((font) => !/JhengHei|MingLiU|SimSun/.test(font.postScriptName)));
}
try {
  for (const theme of ['light', 'dark'])
    for (const scale of [1, 1.25, 1.5]) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: scale,
        locale: 'en-US',
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => failures.push(String(error)));
      await page.goto(`${server.url}/app/?capture=1&theme=${theme}&language=zh-TW&systemLocale=zh-CN`);
      await page.waitForFunction(() => !document.getElementById('btn-connect').disabled);
      await page.locator('#btn-settings-tab').click();
      // Verify the initial language as well as switching back from another language.
      const startupFont = await page
        .locator('#window-style-hint')
        .evaluate((node) => getComputedStyle(node).fontFamily);
      if (process.platform === 'win32') assert.ok(startupFont.indexOf('YaHei') < startupFont.indexOf('JhengHei'));
      await page.locator('#language-select').selectOption('en', { force: true });
      await page.locator('#language-select').selectOption('zh-TW', { force: true });
      await page.waitForFunction(() => document.documentElement.lang === 'zh-TW');
      await page.evaluate(() => document.fonts.ready);
      const fonts = await page.evaluate(async () => {
        const { state } = await import('/state.js');
        return {
          os: document.documentElement.dataset.os,
          ui: getComputedStyle(document.documentElement).getPropertyValue('--font-ui'),
          mono: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
          button: getComputedStyle(document.querySelector('#language-select + .cs-button')).fontFamily,
          axes: state.mainChart.axes.map((axis) => ({ font: axis.font, labelFont: axis.labelFont })),
          systemLabel: document.querySelector('#language-select option[value=auto]').textContent,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
        };
      });
      assert.equal(fonts.systemLabel, '跟隨系統 (简体中文)');
      assert.equal(fonts.overflow, false);
      let client;
      if (fonts.os === 'windows') {
        for (const family of [fonts.ui, fonts.mono, fonts.button]) {
          assert.match(family, /Microsoft YaHei UI/);
          assert.ok(family.indexOf('YaHei') < family.indexOf('JhengHei'));
        }
        for (const [index, axis] of fonts.axes.entries()) {
          assert.ok(axis.font[0].indexOf('YaHei') < axis.font[0].indexOf('JhengHei'));
          if (index > 0) assert.ok(axis.labelFont[0].indexOf('YaHei') < axis.labelFont[0].indexOf('JhengHei'));
          assert.equal(axis.font[1], Math.round(12 * scale));
        }
        client = await context.newCDPSession(page);
        await client.send('DOM.enable');
        await client.send('CSS.enable');
        fonts.renderedFonts = {};
        for (const selector of [
          '#window-style-label span',
          '#window-style-hint span',
          '[data-i18n="languageHint"]',
          '#language-select + .cs-button',
          '#status-sample-rate',
        ]) {
          const actual = await renderedFonts(client, selector);
          assertChineseFont(actual);
          fonts.renderedFonts[selector] = actual;
        }
        const regular = fonts.renderedFonts['#window-style-hint span'];
        assert.ok(regular.every((font) => !/Bold|Light/.test(font.postScriptName)));
        const mono = fonts.renderedFonts['#status-sample-rate'];
        assert.ok(mono.some((font) => /Cascadia|Consolas/.test(font.familyName) && font.glyphCount > 0));
      }
      await page.screenshot({ path: resolve(output, `zh-TW-${theme}-${scale * 100}-settings.png`) });
      const languageButton = page.locator('#language-select + .cs-button');
      await languageButton.click();
      const menuId = await languageButton.getAttribute('aria-controls');
      assert.equal(await page.locator(`#${menuId} [role=option]`).first().textContent(), '跟隨系統 (简体中文)');
      if (client) {
        fonts.menuFonts = await renderedFonts(client, `#${menuId} [role=option]`);
        assertChineseFont(fonts.menuFonts);
      }
      await page.screenshot({ path: resolve(output, `zh-TW-${theme}-${scale * 100}-language-menu.png`) });
      await page.keyboard.press('Escape');
      await page.locator('#tab-monitor').click();
      await page.screenshot({ path: resolve(output, `zh-TW-${theme}-${scale * 100}-monitor.png`) });
      await page.evaluate(async () => {
        const { applyLanguage } = await import('/i18n.js');
        await applyLanguage('zh-CN');
      });
      const simplified = await page.evaluate(async () => {
        const { state } = await import('/state.js');
        return state.mainChart.axes[0].font[0];
      });
      if (fonts.os === 'windows') {
        assert.match(simplified, /Microsoft YaHei UI/);
        assert.doesNotMatch(simplified, /Microsoft JhengHei/);
        await page.locator('#btn-settings-tab').click();
        assertChineseFont(await renderedFonts(client, '#window-style-hint span'));
        await client.detach();
      }
      await page.screenshot({ path: resolve(output, `zh-CN-${theme}-${scale * 100}-settings.png`) });
      results.push({ theme, scale, ...fonts });
      console.log(`PASS: ${theme}, ${scale * 100}% DPI, Traditional Chinese DOM and Canvas fonts`);
      await context.close();
    }
  assert.deepEqual(failures, []);
  await writeFile(resolve(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await browser.close();
  await server.close();
}
