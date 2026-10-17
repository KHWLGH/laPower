// @ts-check
/**
 * @file 浮出面板（Fluent Flyout）— 命令栏"显示 / 自动暂停 / 温度服务"等设置面板的容器。
 *
 * 面板内容是 index.html 里的静态 HTML（保持 ID 契约，settings.js 等模块的
 * getElementById 回显逻辑零改动），本模块只负责显隐、定位与轻退出
 * （外部点击 / Escape / resize / 滚动关闭，与 dropdown.js 策略一致）。
 * 同一时刻只开一个 flyout。
 */

/** @type {(() => void)|null} 当前打开面板的关闭函数 */
let closeCurrent = null;

/**
 * 把 panel 变成由 anchor 触发的浮出面板。
 * @param {HTMLElement} anchor
 * @param {HTMLElement} panel
 * @returns {{ open: () => void, close: () => void, toggle: () => void, isOpen: () => boolean }}
 */
export function createFlyout(anchor, panel) {
  panel.classList.add('flyout-panel');
  panel.setAttribute('role', 'dialog');
  if (!panel.hasAttribute('aria-label') && !panel.hasAttribute('aria-labelledby')) {
    const label = anchor.getAttribute('aria-label') || anchor.textContent?.trim() || anchor.title;
    if (label) panel.setAttribute('aria-label', label);
    const key = anchor.getAttribute('data-i18n-aria-label') || anchor.getAttribute('data-i18n-title');
    if (key) panel.setAttribute('data-i18n-aria-label', key);
  }
  if (!panel.hasAttribute('tabindex')) panel.tabIndex = -1;
  anchor.setAttribute('aria-haspopup', 'dialog');
  anchor.setAttribute('aria-expanded', 'false');
  if (panel.id) anchor.setAttribute('aria-controls', panel.id);

  function position() {
    const rect = anchor.getBoundingClientRect();
    const scale = document.documentElement.hasAttribute('data-ui-scale-css')
      ? Number.parseFloat(document.documentElement.style.getPropertyValue('--ui-scale')) || 1
      : 1;
    panel.style.visibility = 'hidden';
    panel.hidden = false;
    const ph = panel.offsetHeight;
    const pw = panel.offsetWidth;
    let top = rect.bottom / scale + 4;
    if (top + ph > window.innerHeight / scale && rect.top / scale - ph - 4 >= 0) top = rect.top / scale - ph - 4;
    let left = rect.left / scale;
    if (left + pw > window.innerWidth / scale) left = Math.max(0, window.innerWidth / scale - pw - 4);
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.visibility = '';
  }

  /** @param {PointerEvent} e */
  const onOutsidePointerDown = (e) => {
    const target = /** @type {Node} */ (e.target);
    // 面板里的自定义下拉（dropdown.js）会把菜单挂到 body，点它不算"外部"
    const inDropdownMenu = target instanceof Element && target.closest('.cs-menu') !== null;
    if (!panel.contains(target) && !anchor.contains(target) && !inDropdownMenu) close();
  };
  /** @param {KeyboardEvent} e */
  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      anchor.focus();
    }
  };
  /** @param {Event} event */
  const onDismiss = (event) => {
    const target = event.target;
    if (event.type === 'scroll' && target instanceof Node && panel.contains(target)) return;
    if (target instanceof Element && target.closest('.cs-menu')) return;
    close();
  };

  function open() {
    if (!panel.hidden) return;
    closeCurrent?.();
    position();
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('scroll', onDismiss, true);
    closeCurrent = close;
    // 自定义下拉会隐藏原生 select，键盘焦点应落在实际可见的按钮上。
    const first = /** @type {HTMLElement|undefined} */ (
      Array.from(panel.querySelectorAll('input:not([disabled]), select:not([disabled]), button:not([disabled])')).find(
        (element) => element.getClientRects().length > 0,
      )
    );
    (first ?? panel).focus({ preventScroll: true });
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutsidePointerDown, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', onDismiss);
    window.removeEventListener('scroll', onDismiss, true);
    if (closeCurrent === close) closeCurrent = null;
  }

  function toggle() {
    if (panel.hidden) open();
    else close();
  }

  anchor.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });

  return { open, close, toggle, isOpen: () => !panel.hidden };
}
