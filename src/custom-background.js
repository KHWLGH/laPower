// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */

import { errorText, t } from './i18n.js';
import { toast } from './ui/toast.js';

const invoke = window.__TAURI__?.core?.invoke;
const root = document.documentElement;

/** @param {string|null} dataUrl */
function renderBackground(dataUrl) {
  const preview = document.getElementById('background-preview');
  const clearButton = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-background-clear'));
  if (dataUrl) {
    if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
      throw new Error('背景图片数据格式无效');
    }
    root.style.setProperty('--wallpaper', `url("${dataUrl}")`);
    root.style.setProperty('--wallpaper-size', 'cover');
    preview?.style.setProperty('background-image', `url("${dataUrl}")`);
    preview?.classList.add('has-image');
    preview?.setAttribute('aria-label', t('customBackgroundPreview'));
    if (clearButton) clearButton.disabled = false;
    return;
  }
  root.style.removeProperty('--wallpaper');
  root.style.removeProperty('--wallpaper-size');
  preview?.style.removeProperty('background-image');
  preview?.classList.remove('has-image');
  preview?.setAttribute('aria-label', t('defaultBackground'));
  if (clearButton) clearButton.disabled = true;
}

/** Load the persisted image before the first workspace is displayed. */
export async function loadCustomBackground() {
  if (!invoke) return;
  const dataUrl = await invoke('load_custom_background');
  renderBackground(dataUrl ?? null);
}

/** Wire the background controls once the localized settings UI is ready. */
export function initCustomBackgroundControls() {
  document.getElementById('btn-background-choose')?.addEventListener('click', async () => {
    if (!invoke) return;
    const button = /** @type {HTMLButtonElement} */ (document.getElementById('btn-background-choose'));
    button.disabled = true;
    try {
      const dataUrl = await invoke('choose_custom_background');
      if (!dataUrl) return;
      renderBackground(dataUrl);
      toast.success(() => t('customBackgroundSaved'));
    } catch (error) {
      toast.error(() => t('operationFailed', { detail: errorText(error) }));
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('btn-background-clear')?.addEventListener('click', async () => {
    if (!invoke) return;
    const button = /** @type {HTMLButtonElement} */ (document.getElementById('btn-background-clear'));
    button.disabled = true;
    try {
      await invoke('clear_custom_background');
      renderBackground(null);
      toast.success(() => t('customBackgroundCleared'));
    } catch (error) {
      button.disabled = false;
      toast.error(() => t('operationFailed', { detail: errorText(error) }));
    }
  });
}

export async function clearCustomBackground() {
  if (invoke) await invoke('clear_custom_background');
  renderBackground(null);
}
