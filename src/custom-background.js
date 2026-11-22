// @ts-check
/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Based on community contribution from PR #11; refined for laPower. See COPYRIGHT.
 */

import { errorText, t } from './i18n.js';
import { toast } from './ui/toast.js';

const invoke = window.__TAURI__?.core?.invoke;
const wallpaper = /** @type {HTMLImageElement|null} */ (document.getElementById('workspace-wallpaper'));
const wallpaperContainer = wallpaper?.closest('.app-wallpaper');

/** @param {string|null} dataUrl */
function renderBackground(dataUrl) {
  const preview = document.getElementById('background-preview');
  const clearButton = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-background-clear'));
  if (dataUrl !== null && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
    throw new Error(t('customBackgroundInvalid'));
  }
  const hasCustom = dataUrl !== null;
  document.documentElement.classList.toggle('has-custom-background', hasCustom);
  if (wallpaperContainer instanceof HTMLElement) wallpaperContainer.hidden = !hasCustom;
  if (wallpaper) {
    // Large data URLs can exceed Chromium's CSS variable limit. Use the image element directly.
    if (hasCustom) wallpaper.src = dataUrl;
    else wallpaper.removeAttribute('src');
    wallpaper.classList.toggle('is-custom', hasCustom);
  }
  preview?.classList.toggle('has-image', hasCustom);
  const thumbnail = preview?.querySelector('img');
  if (thumbnail) {
    if (hasCustom) thumbnail.src = dataUrl;
    else thumbnail.removeAttribute('src');
    thumbnail.hidden = !hasCustom;
  }
  const label = hasCustom ? 'customBackgroundPreview' : 'defaultBackground';
  preview?.setAttribute('data-i18n-aria-label', label);
  preview?.setAttribute('aria-label', t(label));
  if (clearButton) clearButton.disabled = !hasCustom;
}

/** Load the persisted custom image before the first workspace is displayed. */
export async function loadCustomBackground() {
  if (!invoke) {
    renderBackground(null);
    return;
  }
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
      const dataUrl = await invoke('choose_custom_background', {
        title: t('chooseBackgroundTitle'),
        filterName: t('imageFilter'),
      });
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
