// @ts-check
/**
 * @file 设置视图 — 单页目录导航 / 关于信息 / 临时恢复文件。
 * 首次打开时由 shell 的 init 钩子调用。
 */

import { onLanguageChange, t } from '../i18n.js';
import { processRecovery, recoveryActionDisabled, scanRecoveries, subscribeRecoveries } from '../recording-recovery.js';
import { initAboutView } from './about-view.js';

/** @typedef {{id:string, name:string, size:number, modified_ms:number}} RecoveryEntry */

/** 返回设置页时恢复本次会话的滚动位置。 */
let restoreNavigation = () => {};

export function showSettingsView() {
  restoreNavigation();
}

function initSettingsNavigation() {
  const page = document.querySelector('.settings-page');
  const nav = document.querySelector('.settings-nav');
  const main = document.querySelector('.settings-main');
  if (!(page instanceof HTMLElement) || !(nav instanceof HTMLElement) || !(main instanceof HTMLElement)) return;
  const links = Array.from(nav.querySelectorAll('a'));
  const sections = Array.from(main.querySelectorAll('.settings-section'));
  let savedScrollTop = page.scrollTop;
  let frame = 0;
  /** @type {{section: Element, scrollTop: number, moving: boolean}|null} */
  let navigationSelection = null;
  let scrollEndTimer = 0;

  // CSS zoom 回退下，DOMRect 是屏幕像素，scrollTop 和 offsetHeight 仍是布局像素。
  const layoutScale = () =>
    document.documentElement.hasAttribute('data-ui-scale-css')
      ? Number.parseFloat(document.documentElement.style.getPropertyValue('--ui-scale')) || 1
      : 1;
  const anchorOffset = () => {
    return getComputedStyle(nav).flexDirection === 'row' ? nav.offsetHeight + 12 : 12;
  };

  const update = () => {
    frame = 0;
    if (!page.clientHeight) return;
    const offset = anchorOffset();
    page.style.setProperty('--settings-anchor-offset', `${offset}px`);
    let current = sections[0];
    const top = page.getBoundingClientRect().top + offset * layoutScale() + 1;
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= top) current = section;
    }
    // 末段通常不足一屏高；滚到底部时仍须选中“关于”。
    if (page.scrollTop > 0 && page.scrollHeight - page.clientHeight - page.scrollTop <= 2) {
      current = sections[sections.length - 1];
    }
    // 页面末尾可能无法将目标置顶；保留点击的目录项，直到用户继续滚动。
    if (navigationSelection) {
      if (navigationSelection.moving || Math.abs(page.scrollTop - navigationSelection.scrollTop) < 1)
        current = navigationSelection.section;
      else navigationSelection = null;
    }
    for (const link of links) {
      if (link.hash === `#${current?.id}`) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  };

  function scheduleUpdate() {
    if (!frame) frame = requestAnimationFrame(update);
  }

  for (const link of links) {
    link.addEventListener('click', (event) => {
      const section = document.getElementById(link.hash.slice(1));
      if (!section) return;
      event.preventDefault();
      const top =
        page.scrollTop +
        (section.getBoundingClientRect().top - page.getBoundingClientRect().top) / layoutScale() -
        anchorOffset();
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      navigationSelection = { section, scrollTop: page.scrollTop, moving: smooth };
      page.scrollTo({ top, behavior: smooth ? 'smooth' : 'instant' });
      section.querySelector('h2')?.focus({ preventScroll: true });
      savedScrollTop = page.scrollTop;
      navigationSelection.scrollTop = savedScrollTop;
      clearTimeout(scrollEndTimer);
      scrollEndTimer = window.setTimeout(finishNavigation, 140);
      scheduleUpdate();
    });
  }
  const finishNavigation = () => {
    if (navigationSelection) {
      navigationSelection.moving = false;
      navigationSelection.scrollTop = page.scrollTop;
    }
    scheduleUpdate();
  };
  // scrollend is not available in every desktop WebView; the debounce also covers those hosts.
  page.addEventListener('scrollend', finishNavigation);
  const interruptNavigation = () => {
    if (navigationSelection?.moving) page.scrollTo({ top: page.scrollTop, behavior: 'instant' });
    navigationSelection = null;
    clearTimeout(scrollEndTimer);
    scheduleUpdate();
  };
  page.addEventListener('wheel', interruptNavigation, { passive: true });
  page.addEventListener('touchstart', interruptNavigation, { passive: true });
  page.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('.settings-nav')) interruptNavigation();
  });
  page.addEventListener('keydown', (event) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interruptNavigation();
  });
  page.addEventListener(
    'scroll',
    () => {
      if (!page.clientHeight) return;
      savedScrollTop = page.scrollTop;
      clearTimeout(scrollEndTimer);
      scrollEndTimer = window.setTimeout(finishNavigation, 140);
      scheduleUpdate();
    },
    { passive: true },
  );
  const observer = new ResizeObserver(scheduleUpdate);
  observer.observe(page);
  observer.observe(nav);
  observer.observe(main);
  onLanguageChange(scheduleUpdate);
  restoreNavigation = () => {
    const top = savedScrollTop;
    navigationSelection = null;
    clearTimeout(scrollEndTimer);
    page.scrollTo({ top, behavior: 'instant' });
    scheduleUpdate();
  };
  scheduleUpdate();
}

/** @param {RecoveryEntry[]} entries */
export function showSpoolRecoveries(entries) {
  const el = document.getElementById('spool-recovery-status');
  if (!el) return;
  if (!entries.length) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.replaceChildren(document.createTextNode(t('recoveryFound', { count: entries.length })));
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'recovery-entry';
    const label = document.createElement('span');
    label.textContent = `${entry.name}（${(entry.size / 1048576).toFixed(1)} MB）`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.textContent = t('delete');
    const recover = document.createElement('button');
    recover.type = 'button';
    recover.className = 'btn';
    recover.textContent = t('recover');
    recover.disabled = recoveryActionDisabled(entry.id, 'recover');
    remove.disabled = recoveryActionDisabled(entry.id, 'delete');
    recover.addEventListener('click', () => void processRecovery(entry.id, 'recover'));
    remove.addEventListener('click', () => void processRecovery(entry.id, 'delete'));
    row.append(label, recover, remove);
    el.append(row);
  }
}

/** 初始化目录并填充“关于”版本号等运行时信息。 */
export function initSettingsView() {
  initSettingsNavigation();
  initAboutView();
  // 点分段项时不要把焦点留在隐藏 radio 上，否则浅色主题会画出黑框。
  // 键盘 Tab 仍可聚焦；mousedown preventDefault 只取消“点击即聚焦”。
  for (const seg of document.querySelectorAll('.seg')) {
    seg.addEventListener('mousedown', (event) => {
      if (event.target instanceof Element && event.target.closest('.seg-item')) {
        event.preventDefault();
      }
    });
  }

  subscribeRecoveries(showSpoolRecoveries);
  scanRecoveries().catch((/** @type {unknown} */ error) => console.error('读取临时恢复文件失败:', error));

  const versionEl = document.getElementById('about-version');
  if (!versionEl) return;
  const appApi = /** @type {any} */ (window.__TAURI__).app;
  if (appApi?.getVersion) {
    appApi
      .getVersion()
      .then((/** @type {string} */ v) => {
        versionEl.textContent = `v${v}`;
      })
      .catch(() => {
        versionEl.textContent = '--';
      });
  }
}
