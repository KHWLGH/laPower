// @ts-check
import { t } from './i18n.js';
import { debouncedSaveSettings } from './settings.js';
import { getActiveView } from './shell.js';
import { setShortcutTip, shortcutButtons } from './shortcut-hints.js';
import {
  bindingConflict,
  bindingFromEvent,
  defaultShortcuts,
  displayBinding,
  shortcutActions,
  validBinding,
} from './shortcuts-core.js';
import { state } from './state.js';

/** @type {Record<string, () => void>} */
let handlers = {};
let capturing = '';
const isMac = () => document.documentElement.dataset.os === 'macos';

/** @param {EventTarget|null} target */
export function editableTarget(target) {
  return (
    target instanceof Element &&
    !!target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="separator"]',
    )
  );
}

export function refreshShortcutUI() {
  for (const id of Object.keys(shortcutButtons)) {
    const element = document.getElementById(id);
    if (!element) continue;
    const key = element.getAttribute('data-i18n-title');
    const base = key ? t(key) : element.dataset.shortcutBaseTitle || element.title;
    setShortcutTip(element, base);
  }
  const container = document.getElementById('shortcut-bindings');
  if (!container) return;
  container.replaceChildren();
  for (const action of shortcutActions) {
    const row = document.createElement('div');
    row.className = 'settings-row shortcut-row';
    const text = document.createElement('div');
    text.className = 'settings-row-text';
    const name = document.createElement('div');
    name.className = 'settings-row-title';
    name.textContent = t(action.label);
    const scope = document.createElement('div');
    scope.className = 'settings-row-desc';
    scope.textContent = action.views.map((view) => t(view === 'monitor' ? 'monitor' : 'pdAnalysis')).join(' / ');
    text.append(name, scope);
    const controls = document.createElement('div');
    controls.className = 'settings-row-control';
    const capture = document.createElement('button');
    capture.type = 'button';
    capture.className = 'btn shortcut-capture';
    capture.dataset.shortcutAction = action.id;
    capture.textContent =
      capturing === action.id
        ? t('shortcutPress')
        : displayBinding(state.settings.shortcuts[action.id], isMac()) || t('shortcutUnbound');
    capture.setAttribute('aria-label', `${t(action.label)}: ${capture.textContent}`);
    capture.addEventListener('click', () => {
      capturing = action.id;
      capture.textContent = t('shortcutPress');
    });
    capture.addEventListener('blur', () => {
      if (capturing !== action.id) return;
      capturing = '';
      capture.textContent = displayBinding(state.settings.shortcuts[action.id], isMac()) || t('shortcutUnbound');
    });
    for (const [label, binding] of [
      ['shortcutUnbind', ''],
      ['shortcutRestore', defaultShortcuts[action.id]],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cmd-btn';
      button.textContent = t(label);
      button.addEventListener('click', () => changeBinding(action.id, binding));
      controls.append(button);
    }
    controls.prepend(capture);
    row.append(text, controls);
    container.append(row);
  }
}

/** @param {string} id @param {string} binding */
function changeBinding(id, binding) {
  const conflict = bindingConflict(id, binding, state.settings.shortcuts);
  const error = document.getElementById('shortcut-error');
  if (!validBinding(binding) || conflict) {
    if (error)
      error.textContent = conflict
        ? t('shortcutConflict', { action: t(shortcutActions.find((a) => a.id === conflict)?.label || '') })
        : t('shortcutInvalid');
    return;
  }
  if (error) error.textContent = '';
  capturing = '';
  state.settings.shortcuts = { ...state.settings.shortcuts, [id]: binding };
  debouncedSaveSettings();
  refreshShortcutUI();
  /** @type {HTMLElement|null} */ (document.querySelector(`[data-shortcut-action="${id}"]`))?.focus();
}

/** @param {Record<string, () => void>} actions */
export function initShortcuts(actions) {
  handlers = actions;
  document.addEventListener('keydown', (event) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.getModifierState('AltGraph')
    )
      return;
    if (capturing) {
      event.preventDefault();
      if (event.key === 'Escape') {
        capturing = '';
        refreshShortcutUI();
        return;
      }
      const binding = bindingFromEvent(event, isMac());
      if (binding) changeBinding(capturing, binding);
      return;
    }
    if (
      editableTarget(event.target) ||
      document.querySelector('dialog[open], .cs-menu:not([hidden]), .flyout-panel:not([hidden])')
    )
      return;
    const binding = bindingFromEvent(event, isMac());
    const action = shortcutActions.find(
      (a) => a.views.includes(getActiveView()) && binding && state.settings.shortcuts[a.id] === binding,
    );
    if (!action) return;
    event.preventDefault();
    handlers[action.id]?.();
  });
  document.getElementById('btn-reset-shortcuts')?.addEventListener('click', () => {
    capturing = '';
    state.settings.shortcuts = { ...defaultShortcuts };
    const error = document.getElementById('shortcut-error');
    if (error) error.textContent = '';
    debouncedSaveSettings();
    refreshShortcutUI();
  });
  document.addEventListener('witrn:language-changed', refreshShortcutUI);
  document.addEventListener('lapower:preferences-changed', refreshShortcutUI);
  refreshShortcutUI();
}
