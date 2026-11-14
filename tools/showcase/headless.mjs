/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

/** Wait for fonts and two rendering opportunities, not arbitrary application work.
 * @param {import('playwright').Page} page
 */
export async function frames(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept)));
  });
}

/** Shared, headless-only simulated app host. No tests run on import or creation.
 * @param {{channel?: 'chromium'|'msedge'|'chrome', distribution?: boolean, timeout?: number}} [options]
 */
export async function createHeadlessHarness({ channel = 'chromium', distribution = false, timeout = 15_000 } = {}) {
  if (!['chromium', 'msedge', 'chrome'].includes(channel)) throw new Error(`Invalid browser channel: ${channel}`);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('timeout must be positive');
  const server = await startServer({ distribution });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: channel === 'chromium' ? undefined : channel });
  } catch (error) {
    await server.close();
    throw error;
  }
  let closing;
  const close = () =>
    (closing ??= (async () => {
      try {
        await browser.close();
      } finally {
        await server.close();
      }
    })());

  /** Each app has isolated storage, virtual device state, clock and downloads.
   * @param {{theme?: 'light'|'dark'|'system', language?: string, query?: Record<string,string>, context?: import('playwright').BrowserContextOptions, beforeLoad?: (page: import('playwright').Page) => Promise<void>}} [options]
   */
  async function openApp({ theme = 'light', language = 'en', query = {}, context: settings = {}, beforeLoad } = {}) {
    if (closing) throw new Error('Headless harness is closed');
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: language === 'auto' ? 'en-US' : language,
      colorScheme: theme === 'system' ? 'light' : theme,
      ...settings,
    });
    context.setDefaultTimeout(timeout);
    context.setDefaultNavigationTimeout(timeout);
    try {
      const page = await context.newPage();
      const errors = [];
      const consoleErrors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      let appClosing;
      const closeApp = () => (appClosing ??= context.close());
      const call = (method, ...args) =>
        page.evaluate(({ method, args }) => window.__SHOWCASE__[method](...args), { method, args });
      const app = {
        page,
        context,
        errors,
        consoleErrors,
        close: closeApp,
        [Symbol.asyncDispose]: closeApp,
        /** Reload defaults to a frozen clock; query options also support bridge fault fixtures. */
        async goto(overrides = {}) {
          const params = new URLSearchParams({ capture: '1', theme, language, ...query, ...overrides });
          await page.goto(`${server.url}/app/?${params}`);
          await page.waitForFunction(
            () =>
              window.__SHOWCASE__ &&
              window.__WITRN_STREAM__ &&
              document.querySelector('#btn-connect')?.disabled === false &&
              document.querySelector('#main-chart canvas'),
          );
        },
        /** Operate actual UI controls; never invoke a backend connect/ACK directly. */
        async connect(path = 'showcase:km003c') {
          if ((await call('diagnostics')).connected) throw new Error('Virtual device is already connected');
          await page.locator('#device-select').selectOption(path, { force: true });
          await page.locator('#btn-connect').click();
          await page.waitForFunction(
            () => window.__SHOWCASE__.diagnostics().connected && !document.getElementById('btn-record-toggle').disabled,
          );
        },
        async record() {
          if ((await page.locator('#btn-record-toggle').getAttribute('aria-pressed')) !== 'true') {
            await page.locator('#btn-record-toggle').click();
          }
          await page.waitForFunction(() => window.__SHOWCASE__.diagnostics().segment > 0);
        },
        async pause() {
          if ((await page.locator('#btn-record-toggle').getAttribute('aria-pressed')) === 'true') {
            await page.locator('#btn-record-toggle').click();
          }
          await page.waitForFunction(() => window.__SHOWCASE__.diagnostics().segment === 0);
          await app.flush();
        },
        async freeze() {
          await call('freeze');
          await page.waitForFunction(() => !window.__SHOWCASE__.diagnostics().advancing);
          await app.flush();
        },
        resume: () => call('resume'),
        /** Advance 0..300000 virtual milliseconds; wait for consumption and real ACK. */
        async advance(ms) {
          if (!(await call('diagnostics')).frozen) throw new Error('Freeze the virtual clock before advancing');
          await call('advance', ms);
          await app.flush();
        },
        /** Consumption boundary only: does not promise chart rendering or disk durability. */
        async flush() {
          await page.waitForFunction(() => {
            const source = window.__SHOWCASE__.diagnostics();
            const stream = window.__WITRN_STREAM__();
            if (stream.failed) throw new Error(stream.lastError || 'Device stream failed');
            return (
              source.generation === stream.generation && source.seq === stream.seq && source.acknowledged === source.seq
            );
          });
        },
        async waitForCharts() {
          await page.waitForFunction(() => document.getElementById('main-chart')?.getAttribute('aria-busy') !== 'true');
          await frames(page);
        },
        async diagnostics() {
          const snapshot = await page.evaluate(() => ({
            source: window.__SHOWCASE__.diagnostics(),
            stream: window.__WITRN_STREAM__(),
            performance: window.__WITRN_PERF__?.() ?? null,
          }));
          return { ...snapshot, errors: [...errors], consoleErrors: [...consoleErrors] };
        },
      };
      await beforeLoad?.(page);
      await app.goto();
      return app;
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  return { url: server.url, browser, openApp, close, [Symbol.asyncDispose]: close };
}
