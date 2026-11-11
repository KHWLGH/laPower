/*! SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const output = resolve('output/about-verification');
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile('src/third-party-components.json', 'utf8'));
const readerCatalog = JSON.parse(await readFile('src/legal-notices.json', 'utf8'));
const gplDocument = readerCatalog.project.documents.find((entry) => entry.id === 'gpl-3.0');
const gplText = readerCatalog.texts[gplDocument.textId];
const readerDocuments = [
  ...readerCatalog.project.documents.filter((entry) => entry.id !== 'copyright'),
  ...readerCatalog.components.flatMap((entry) => entry.documents),
];
const server = await startServer();
const browser = await chromium.launch({ headless: true });
const errors = [];
const results = [];
const bridgeSuffix = `
const aboutTestInvoke = window.__TAURI__.core.invoke;
window.__ABOUT_TEST__ = { checks: 0, pages: [], mode: 'available', resolve: null, openError: false };
window.__TAURI__.core.invoke = (command, args, ipc) => {
  const test = window.__ABOUT_TEST__;
  if (command === 'open_project_page') {
    test.pages.push(args);
    return test.openError ? Promise.reject({ code: 'projectPageError' }) : Promise.resolve();
  }
  if (command !== 'check_for_updates') return aboutTestInvoke(command, args, ipc);
  test.checks++;
  if (test.mode === 'pending') return new Promise(resolve => { test.resolve = resolve; });
  if (test.mode.startsWith('update')) return Promise.reject({ code: test.mode });
  if (test.mode === 'invalid') return Promise.resolve({ status: 'unexpected' });
  const available = test.mode === 'available';
  return Promise.resolve({ status: test.mode === 'none' ? 'no_release' : available ? 'available' : 'current',
    current_version: '0.2.4', latest_version: available ? '99.0.0' : '0.2.4', tag: available ? 'v99.0.0' : 'v0.2.4' });
};`;

async function settle(page) {
  await page.evaluate(() => new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept))));
}

async function openAbout(page) {
  await page.locator('#btn-settings-tab').click();
  await page.waitForFunction(() => document.querySelectorAll('#about-components > li').length > 0);
  const link = page.locator('.settings-nav-link[href="#settings-about"]');
  await link.focus();
  await link.press('Enter');
  await page.waitForFunction(() => {
    const page = document.querySelector('.settings-page');
    const nav = document.querySelector('.settings-nav');
    const section = document.getElementById('settings-about');
    const scale = document.documentElement.hasAttribute('data-ui-scale-css')
      ? Number.parseFloat(document.documentElement.style.getPropertyValue('--ui-scale')) || 1
      : 1;
    const offset = getComputedStyle(nav).flexDirection === 'row' ? nav.offsetHeight + 12 : 12;
    return Math.abs((section.getBoundingClientRect().top - page.getBoundingClientRect().top) / scale - offset) < 2;
  });
  await settle(page);
}

async function assertLayout(page) {
  const metrics = await page.evaluate(() => {
    const page = document.querySelector('.settings-page');
    const summary = document.querySelector('.about-summary');
    const card = document.querySelector('.about-card');
    const main = document.querySelector('.settings-main');
    const dialog = document.getElementById('about-legal-dialog');
    const dialogRect = dialog.getBoundingClientRect();
    const body = dialog.querySelector('.about-legal-body');
    const elements = [...summary.children];
    const bounds = elements.map((element) => {
      const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
      return { x, y, width, height, right, bottom };
    });
    return {
      dialogFits:
        !dialog.open ||
        (dialogRect.left >= 0 &&
          dialogRect.top >= 0 &&
          dialogRect.right <= innerWidth + 1 &&
          dialogRect.bottom <= innerHeight + 1 &&
          body.scrollWidth <= body.clientWidth + 1),
      overflow: document.documentElement.scrollWidth > innerWidth + 1 || page.scrollWidth > page.clientWidth + 1,
      clipped: [
        ...page.querySelectorAll(
          '.about-actions .btn, .about-component, #about-update-status, .about-legal-controls, .about-legal-controls > .cs, .about-legal-controls .cs-button, .about-legal-actions .btn, .about-legal-text',
        ),
      ]
        .filter((element) => element.getClientRects().length)
        .some((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.left < main.getBoundingClientRect().left - 1 || rect.right > main.getBoundingClientRect().right + 1
          );
        }),
      summaryColumns: getComputedStyle(summary).gridTemplateColumns.split(' ').length,
      componentColumns: getComputedStyle(document.querySelector('.about-components')).gridTemplateColumns.split(' ')
        .length,
      contentWidth:
        card.clientWidth -
        Number.parseFloat(getComputedStyle(card).paddingLeft) -
        Number.parseFloat(getComputedStyle(card).paddingRight),
      bounds,
    };
  });
  assert.equal(metrics.overflow, false, 'No horizontal overflow');
  assert.equal(metrics.dialogFits, true, 'The reading dialog fits the viewport without horizontal scrolling');
  assert.equal(metrics.clipped, false, 'About content fits the settings column');
  const wide = metrics.contentWidth >= 720;
  assert.equal(metrics.summaryColumns, wide ? 3 : 2);
  assert.equal(metrics.componentColumns, wide ? 2 : 1);
  if (!wide) assert.ok(metrics.bounds[2].y >= metrics.bounds[1].bottom - 1, 'Narrow actions wrap below identity');
  return metrics;
}

async function verifyLegalReader(page, requestCount) {
  const dialog = page.locator('#about-legal-dialog');
  const open = page.locator('#btn-legal-notices');
  const close = page.locator('#btn-close-legal');
  const text = page.locator('#about-legal-text');
  const select = page.locator('#about-legal-document');
  const combobox = page.locator('#about-legal-controls > .cs > .cs-button');
  assert.equal(requestCount(), 0, 'Startup and opening About do not fetch legal texts');
  assert.equal(await dialog.isVisible(), false, 'Legal content stays hidden until requested');
  assert.equal(
    await page.locator('#settings-about .about-legal-reader, #about-legal-dialog .about-legal-summary').count(),
    0,
  );
  assert.match(await page.locator('.about-legal-summary').innerText(), /Copyright \(C\) 2026 KHWLGH/);
  assert.match(await page.locator('.about-legal-summary').innerText(), /Copyright \(c\) 2025 JohnScotttt/);
  assert.equal(await close.locator('.fi-dismiss').count(), 1);
  assert.equal(await close.innerText(), '', 'Closing uses an icon instead of a text button');
  assert.equal(await page.locator('#btn-select-legal-text').count(), 0);
  await open.press('Enter');
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.evaluate((element) => element.matches(':modal')), true);
  await page.waitForFunction(() => document.getElementById('about-legal-reader').dataset.state === 'error');
  assert.equal(requestCount(), 1);
  for (const language of ['zh-CN', 'zh-TW', 'en', 'ja']) {
    await page.evaluate(async (value) => (await import('/i18n.js')).applyLanguage(value), language);
    const expected = await page.evaluate(async () => (await import('/i18n.js')).t('legalLoadFailed'));
    assert.equal(await page.locator('#about-legal-status').innerText(), expected, language);
    assert.equal(await page.locator('#btn-retry-legal').isVisible(), true);
    assert.equal(await text.isVisible(), false, 'A failed load has no stale or partial license body');
    assert.equal(requestCount(), 1, 'Language switches do not retry loading');
  }
  await page.locator('#btn-retry-legal').press('Enter');
  await page.waitForFunction(() => document.getElementById('about-legal-reader').dataset.state === 'ready');
  assert.equal(requestCount(), 2, 'The explicit retry fetches again');
  assert.equal(await select.getAttribute('aria-hidden'), 'true', 'The real application enhances the document select');
  assert.equal(await select.getAttribute('tabindex'), '-1');
  assert.equal(await combobox.isVisible(), true);
  assert.equal(
    await combobox.evaluate((element) => element === document.activeElement),
    true,
    'Reading focuses the visible combobox after revealing the reader controls',
  );
  assert.equal(
    await combobox.getAttribute('aria-label'),
    await page.evaluate(async () => (await import('/i18n.js')).t('legalDocument')),
  );
  assert.equal(await text.textContent(), gplText);
  assert.equal(await text.locator('*').count(), 0, 'License content is plain text');
  assert.equal(await select.locator('option').count(), readerDocuments.length);
  assert.equal(await page.locator('.about-legal-text').count(), 1, 'Only one document body is rendered');
  await text.evaluate((element) => {
    element.scrollTop = 160;
  });
  const contextMenu = await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    element.dispatchEvent(event);
    return { prevented: event.defaultPrevented, userSelect: getComputedStyle(element).userSelect };
  });
  assert.deepEqual(
    contextMenu,
    { prevented: false, userSelect: 'text' },
    'License text allows native right-click copying',
  );
  assert.equal(
    await open.evaluate((element) => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    true,
    'Other application controls retain the existing context-menu behavior',
  );
  const retained = await page.evaluate(() => {
    const text = document.getElementById('about-legal-text');
    window.__LEGAL_READER_NODES__ = {
      reader: document.getElementById('about-legal-reader'),
      text: text.firstChild,
      select: document.getElementById('about-legal-document'),
    };
    return {
      value: window.__LEGAL_READER_NODES__.select.value,
      scrollTop: text.scrollTop,
      selection: getSelection().toString(),
    };
  });
  assert.equal(retained.selection, gplText, 'Keyboard selection enables system copy without a clipboard capability');
  assert.ok(retained.scrollTop > 0, 'The long license body has independent scroll state');
  for (const language of ['zh-CN', 'zh-TW', 'en', 'ja']) {
    await page.evaluate(async (value) => (await import('/i18n.js')).applyLanguage(value), language);
    const current = await page.evaluate(() => ({
      sameReader: window.__LEGAL_READER_NODES__.reader === document.getElementById('about-legal-reader'),
      sameText: window.__LEGAL_READER_NODES__.text === document.getElementById('about-legal-text').firstChild,
      sameSelect: window.__LEGAL_READER_NODES__.select === document.getElementById('about-legal-document'),
      value: document.getElementById('about-legal-document').value,
      scrollTop: document.getElementById('about-legal-text').scrollTop,
      selection: getSelection().toString(),
    }));
    assert.deepEqual(current, { sameReader: true, sameText: true, sameSelect: true, ...retained }, language);
    assert.equal(requestCount(), 2, 'Successful legal content is cached for the session');
  }
  for (const id of ['lgpl-3.0']) {
    await select.evaluate(
      (element, value) => {
        element.value = String(value);
        element.dispatchEvent(new Event('change', { bubbles: true }));
      },
      readerDocuments.findIndex((entry) => entry.id === id),
    );
    const document = readerCatalog.project.documents.find((entry) => entry.id === id);
    assert.equal(await text.textContent(), readerCatalog.texts[document.textId]);
  }
  await close.press('Enter');
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await open.evaluate((element) => element === document.activeElement), true);
  // Prefer a real combined-version main card; single-version catalogs still exercise the same lookup.
  const component = manifest.main.find((entry) => entry.version?.includes(' / ')) || manifest.main[0];
  const versions = component.version?.split(' / ') || [null];
  const entry = versions
    .map((version) =>
      readerCatalog.components.find((entry) => entry.name === component.name && entry.version === version),
    )
    .find((entry) => entry?.documents.length);
  assert.ok(entry, `The catalog contains a document for main component ${component.name}`);
  await page.locator('#about-components .about-component-read').nth(manifest.main.indexOf(component)).press('Enter');
  assert.equal(await text.textContent(), readerCatalog.texts[entry.documents[0].textId]);
  assert.equal(await select.inputValue(), String(readerDocuments.indexOf(entry.documents[0])));
  assert.ok((await select.locator('option:checked').textContent()).startsWith(`${entry.name} ${entry.version || ''}`));
  await close.press('Enter');
  assert.equal(
    await page
      .locator('#about-components .about-component-read')
      .nth(manifest.main.indexOf(component))
      .evaluate((element) => element === document.activeElement),
    true,
    'A component reading action restores focus to its own opening button',
  );
  // The full dependency list must continue to distinguish individual versions, even with identical license text.
  const dependencies = manifest.components.filter((entry) => entry.name === component.name);
  const details = page.locator('#about-all-components');
  await details.locator('summary').press('Enter');
  for (const dependency of dependencies) {
    const exact = readerCatalog.components.find(
      (entry) => entry.name === dependency.name && entry.version === dependency.version,
    );
    assert.ok(exact, `The catalog contains exact version ${dependency.name} ${dependency.version}`);
    await page
      .locator('#about-dependency-list .about-component-read')
      .nth(manifest.components.indexOf(dependency))
      .press('Enter');
    assert.equal(await select.inputValue(), String(readerDocuments.indexOf(exact.documents[0])));
    assert.equal(await text.textContent(), readerCatalog.texts[exact.documents[0].textId]);
    await close.press('Enter');
  }
  await details.locator('summary').press('Enter');
  await open.press('Enter');
  // Collapsing the long list and focusing the control may scroll the settings page.
  // Finish that layout work before opening a menu that intentionally closes on external scroll.
  await combobox.focus();
  await settle(page);
  await combobox.press('Enter');
  assert.equal(await combobox.getAttribute('aria-expanded'), 'true');
  const menu = page.locator(`[id="${await combobox.getAttribute('aria-controls')}"]`);
  assert.equal(
    await menu.locator('[role="option"]').count(),
    readerDocuments.length,
    'The enhanced dropdown observes the lazily inserted document options',
  );
  const menuBounds = await menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      fits: rect.left >= 0 && rect.right <= innerWidth + 1,
      overflow: element.scrollWidth > element.clientWidth + 1,
    };
  });
  assert.deepEqual(
    menuBounds,
    { fits: true, overflow: false },
    'The real document menu fits narrow and scaled windows',
  );
  await page.keyboard.press('Escape');
  assert.equal(await combobox.getAttribute('aria-expanded'), 'false');
  assert.equal(await dialog.isVisible(), true, 'Escape first closes the document dropdown');
  await combobox.press('Enter');
  await combobox.press('Home');
  await combobox.press('ArrowDown');
  await combobox.press('Enter');
  assert.equal(await combobox.getAttribute('aria-expanded'), 'false');
  assert.equal(await combobox.evaluate((element) => element === document.activeElement), true);
  const index = Number(await select.inputValue());
  assert.equal(index, 1, 'Home and ArrowDown select the second actual document through the enhanced control');
  assert.equal(
    await text.textContent(),
    readerCatalog.texts[readerDocuments[index].textId],
    'Keyboard document choice works',
  );
  assert.equal(requestCount(), 2, 'Project, component and select entry points share the cached catalog');
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await open.evaluate((element) => element === document.activeElement), true);
  await open.press('Enter');
  assert.equal(await select.inputValue(), String(index), 'Reopening preserves the selected document');
  assert.equal(requestCount(), 2, 'Reopening reuses the loaded catalog');
  await close.press('Enter');
  assert.equal(await page.locator('.fluent-dialog[open]').count(), 0);
}

try {
  for (const { width, height, scale = 100 } of [
    { width: 1280, height: 800 },
    { width: 900, height: 600 },
    { width: 854, height: 534 },
    { width: 1280, height: 800, scale: 150 },
  ]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1.5 });
      const page = await context.newPage();
      let legalRequests = 0;
      const externalRequests = [];
      await page.route('**/*', async (route) => {
        if (new URL(route.request().url()).origin === server.url) return route.fallback();
        externalRequests.push(route.request().url());
        return route.abort('internetdisconnected');
      });
      await page.route('**/legal-notices.json', async (route) => {
        legalRequests++;
        return legalRequests === 1
          ? route.fulfill({ status: 503, body: 'Offline load failure' })
          : route.fulfill({ json: readerCatalog });
      });
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.route('**/__showcase__/bridge.js', async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()) + bridgeSuffix });
      });
      await page.goto(`${server.url}/app/?capture=1&theme=${theme}&language=zh-CN`);
      await page.waitForFunction(() => !document.getElementById('btn-connect').disabled);
      assert.equal(await page.evaluate(() => window.__ABOUT_TEST__.checks), 0, 'No startup update request');
      if (scale !== 100)
        await page.evaluate(async (value) => (await import('/ui-scale.js')).applyUiScale(value), scale);
      await openAbout(page);
      assert.equal(await page.evaluate(() => window.__ABOUT_TEST__.checks), 0, 'Opening About does not check updates');
      assert.equal(await page.locator('#about-update').isVisible(), false);
      assert.equal(await page.locator('#btn-project-github .fi-github').count(), 1);
      assert.equal(await page.locator('#btn-download-update .fi-github').count(), 1);
      assert.equal(await page.locator('#settings-about [data-i18n="repository"]').count(), 0);
      assert.equal(await page.locator('#about-components > li').count(), manifest.main.length);
      assert.equal(await page.locator('#about-dependency-list > li').count(), manifest.components.length);

      // Scrollbar hit size, thumb appearance and content geometry do not change on container hover.
      await page.mouse.move(1, 1);
      const scrollbar = () =>
        page.locator('.settings-page').evaluate((element) => ({
          width: getComputedStyle(element, '::-webkit-scrollbar').width,
          height: getComputedStyle(element, '::-webkit-scrollbar').height,
          thumb: getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor,
          clientWidth: element.clientWidth,
          mainWidth: document.querySelector('.settings-main').getBoundingClientRect().width,
        }));
      const before = await scrollbar();
      await page.locator('.about-name').hover();
      const after = await scrollbar();
      assert.deepEqual(after, before, 'Container hover must not change scrollbar or content geometry');
      assert.equal(after.width, '8px');
      assert.equal(after.height, '8px');
      const stableWidth = await page.locator('.settings-page').evaluate((element) => {
        const before = element.clientWidth;
        const main = element.querySelector('.settings-layout');
        main.hidden = true;
        const withoutContent = element.clientWidth;
        main.hidden = false;
        return { before, withoutContent };
      });
      assert.equal(stableWidth.before, stableWidth.withoutContent, 'Overflow changes retain gutter width');
      await openAbout(page);

      await verifyLegalReader(page, () => legalRequests);
      for (const language of ['zh-CN', 'zh-TW', 'en', 'ja']) {
        await page.evaluate(async (value) => (await import('/i18n.js')).applyLanguage(value), language);
        await openAbout(page);
        const layout = await assertLayout(page);
        await page.locator('#btn-project-github').click();
        assert.equal(await page.evaluate(() => window.__ABOUT_TEST__.pages.at(-1).page), 'repository');
        const details = page.locator('#about-all-components');
        assert.equal(await details.getAttribute('open'), null);
        await details.locator('summary').focus();
        await page.keyboard.press('Enter');
        assert.equal(await details.evaluate((element) => element.open), true);
        assert.equal(
          await page
            .locator('#about-dependency-list')
            .evaluate((element) => element.scrollHeight > element.clientHeight + 1),
          false,
          'No nested dependency scrollbar',
        );
        const currentWidth = await page.locator('.settings-page').evaluate((element) => element.clientWidth);
        assert.equal(currentWidth, stableWidth.before);
        await page.evaluate(async () => (await import('/i18n.js')).applyLanguage('en'));
        assert.equal(
          await details.evaluate((element) => element.open),
          true,
          'Language change preserves expanded list',
        );
        await page.evaluate(async (value) => (await import('/i18n.js')).applyLanguage(value), language);
        await details.locator('summary').press('Enter');
        await openAbout(page);
        await page.locator('.about-name').click();
        await page.screenshot({ path: resolve(output, `${language}-${theme}-${width}-${scale}-about.png`) });
        await page.locator('#btn-legal-notices').click();
        await settle(page);
        assert.equal(
          await page.locator('#about-legal-controls .cs-label').innerText(),
          await page.locator('#about-legal-document option:checked').textContent(),
          'The displayed document name matches the retained selection',
        );
        await assertLayout(page);
        await page.screenshot({
          path: resolve(output, `${language}-${theme}-${width}-${scale}-legal-reader.png`),
          animations: 'disabled',
        });
        await page.locator('#btn-close-legal').click();
        results.push({ language, theme, width, height, scale, columns: layout.componentColumns });
      }

      // Every update state is local to About and can be retried within the same session.
      await page.evaluate(async () => (await import('/i18n.js')).applyLanguage('zh-CN'));
      for (const [mode, expected] of [
        ['available', 'updateAvailable'],
        ['current', 'updateCurrent'],
        ['older', 'updateCurrent'],
        ['none', 'updateNoRelease'],
        ['updateTimeout', 'updateTimeout'],
        ['updateNetworkError', 'updateNetworkError'],
        ['updateRateLimited', 'updateRateLimited'],
        ['updateServiceError', 'updateServiceError'],
        ['updateInvalidResponse', 'updateInvalidResponse'],
        ['updateUnknown', 'updateCheckFailed'],
        ['invalid', 'updateInvalidResponse'],
      ]) {
        await page.evaluate((mode) => {
          window.__ABOUT_TEST__.mode = mode;
        }, mode);
        await openAbout(page);
        await page.locator('#btn-check-updates').click();
        await page.waitForFunction(
          () => document.getElementById('btn-check-updates').getAttribute('aria-busy') === 'false',
        );
        const text = await page.evaluate(
          async (key) => (await import('/i18n.js')).t(key, { version: 'v99.0.0' }),
          expected,
        );
        assert.equal(await page.locator('#about-update-status').innerText(), text, mode);
        assert.equal(await page.locator('#btn-download-update').isVisible(), mode === 'available');
        if (mode === 'available') {
          await page.locator('#btn-download-update').click();
          assert.deepEqual(await page.evaluate(() => window.__ABOUT_TEST__.pages.at(-1)), {
            page: 'release',
            tag: 'v99.0.0',
          });
        }
        assert.equal(await page.locator('.fluent-dialog[open]').count(), 0);
      }
      const attempts = await page.evaluate(() => window.__ABOUT_TEST__.checks);
      await page.evaluate(() => {
        window.__ABOUT_TEST__.mode = 'pending';
      });
      await page.locator('#btn-check-updates').click();
      assert.equal(await page.locator('#btn-check-updates').isDisabled(), true);
      await page.locator('#btn-check-updates').evaluate((element) => element.click());
      assert.equal(await page.evaluate(() => window.__ABOUT_TEST__.checks), attempts + 1);
      await page.evaluate(() =>
        window.__ABOUT_TEST__.resolve({ status: 'available', latest_version: '99.0.0', tag: 'v99.0.0' }),
      );
      await settle(page);
      const status = await page.locator('#about-update-status').innerText();
      const savedTop = await page.locator('.settings-page').evaluate((element) => element.scrollTop);
      await page.locator('#tab-monitor').click();
      await page.locator('#btn-settings-tab').click();
      await settle(page);
      assert.equal(
        await page.locator('#about-update-status').innerText(),
        status,
        'Update result survives view switches',
      );
      assert.equal(await page.locator('.settings-page').evaluate((element) => element.scrollTop), savedTop);
      assert.equal(
        await page.evaluate(() => window.__ABOUT_TEST__.checks),
        attempts + 1,
        'Returning does not check again',
      );

      await page.evaluate(() => {
        window.__ABOUT_TEST__.openError = true;
      });
      await page.locator('#btn-project-github').click();
      assert.equal(await page.locator('#about-update').getAttribute('data-state'), 'error');
      assert.equal(
        await page.locator('#btn-download-update').isVisible(),
        true,
        'A browser error still allows retrying the download',
      );
      await page.evaluate(() => {
        window.__ABOUT_TEST__.openError = false;
      });
      await page.locator('#btn-download-update').click();
      assert.equal(await page.locator('#about-update').getAttribute('data-state'), 'available');

      // Reduced motion jumps immediately; the default smooth scroll can be interrupted by user input.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.locator('.settings-nav-link[href="#settings-appearance"]').focus();
      await page.keyboard.press('Enter');
      await settle(page);
      assert.equal(await page.locator('.settings-nav-link[aria-current]').getAttribute('href'), '#settings-appearance');
      assert.ok(
        await page.locator('.settings-page').evaluate((page) => {
          const nav = document.querySelector('.settings-nav');
          const scale = document.documentElement.hasAttribute('data-ui-scale-css')
            ? Number.parseFloat(document.documentElement.style.getPropertyValue('--ui-scale')) || 1
            : 1;
          const offset = getComputedStyle(nav).flexDirection === 'row' ? nav.offsetHeight + 12 : 12;
          return (
            Math.abs(
              (document.getElementById('settings-appearance').getBoundingClientRect().top -
                page.getBoundingClientRect().top) /
                scale -
                offset,
            ) < 2
          );
        }),
      );
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.locator('.settings-nav-link[href="#settings-about"]').focus();
      await page.keyboard.press('Enter');
      await settle(page);
      assert.equal(await page.locator('.settings-nav-link[aria-current]').getAttribute('href'), '#settings-about');
      await page.locator('.settings-page').dispatchEvent('wheel');
      await settle(page);
      assert.equal(await page.locator('.settings-nav-link[aria-current]').getAttribute('href'), '#settings-appearance');
      await page.locator('#tab-monitor').click();
      await page.locator('#device-select').selectOption('showcase:km003c', { force: true });
      await page.locator('#btn-connect').click();
      await page.waitForFunction(async () => (await import('/state.js')).state.isConnected);
      await page.locator('#btn-record-toggle').click();
      await page.waitForFunction(async () => (await import('/state.js')).state.isRecording);
      await page.evaluate(() => window.__SHOWCASE__.advance(2000));
      await page.locator('#tab-pd').click();
      await page.waitForSelector('.pd-row');
      const aligned = await page.evaluate(() => {
        const header = document.querySelector('.pd-table-head');
        const row = document.querySelector('.pd-row');
        return [...header.children].every(
          (column, index) =>
            Math.abs(column.getBoundingClientRect().left - row.children[index].getBoundingClientRect().left) <= 1,
        );
      });
      assert.equal(aligned, true, 'PD headers remain aligned with data columns');
      assert.deepEqual(externalRequests, [], 'About and license reading require no external requests');
      console.log(
        `PASS: About, offline licenses, updates and scrollbars, ${theme}, ${width}×${height}, ${scale}%, four languages`,
      );
      await context.close();
    }
  }
  // The shipping bundle changes import.meta.url; exercise the bundled offline manifest as well.
  const distribution = await startServer({ distribution: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (error) => errors.push(String(error)));
    const externalRequests = [];
    let legalRequests = 0;
    await page.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin === distribution.url) return route.fallback();
      externalRequests.push(route.request().url());
      return route.abort('internetdisconnected');
    });
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/legal-notices.json')) legalRequests++;
    });
    await page.goto(`${distribution.url}/app/?capture=1&theme=light&language=zh-CN&update=available`);
    await page.waitForFunction(() => !document.getElementById('btn-connect').disabled);
    await openAbout(page);
    assert.equal(await page.locator('#about-dependency-list > li').count(), manifest.components.length);
    assert.equal(legalRequests, 0, 'The shipping bundle also loads texts only after a reading action');
    const bundledCatalog = JSON.parse(await readFile('out/legal-notices.json', 'utf8'));
    await page.locator('#btn-legal-notices').press('Enter');
    await page.waitForFunction(() => document.getElementById('about-legal-reader').dataset.state === 'ready');
    for (const id of ['gpl-3.0', 'lgpl-3.0']) {
      await page.locator('#about-legal-document').evaluate(
        (element, value) => {
          element.value = String(value);
          element.dispatchEvent(new Event('change', { bubbles: true }));
        },
        readerDocuments.findIndex((entry) => entry.id === id),
      );
      await page.waitForFunction(() => document.getElementById('about-legal-reader').dataset.state === 'ready');
      const entry = bundledCatalog.project.documents.find((entry) => entry.id === id);
      assert.equal(await page.locator('#about-legal-text').textContent(), bundledCatalog.texts[entry.textId]);
    }
    assert.equal(legalRequests, 1, 'The minified bundle caches real bundled texts');
    assert.deepEqual(externalRequests, [], 'Bundled license reading works without remote requests');
    await page.locator('#btn-close-legal').press('Enter');
    await page.evaluate(() => {
      window.__PRODUCTION_PAGES__ = [];
      window.__TAURI__.event.listen('showcase:project-page', ({ payload }) =>
        window.__PRODUCTION_PAGES__.push(payload),
      );
    });
    await page.locator('#btn-check-updates').click();
    await page.waitForFunction(() => document.getElementById('about-update').dataset.state === 'available');
    assert.match(await page.locator('#about-update-status').innerText(), /99\.0\.0/);
    await page.locator('#btn-download-update').click();
    assert.deepEqual(await page.evaluate(() => window.__PRODUCTION_PAGES__.at(-1)), {
      page: 'release',
      tag: 'v99.0.0',
    });
    await page.close();
    console.log('PASS: minified distribution loads offline components and opens the matching release page');
  } finally {
    await distribution.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await browser.close();
  await server.close();
}
