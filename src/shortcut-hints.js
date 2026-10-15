// @ts-check
import { displayBinding } from './shortcuts-core.js';
import { state } from './state.js';

export const shortcutButtons = {
  'btn-record-toggle': 'record',
  'btn-add-marker': 'mark',
  'btn-import': 'import',
  'btn-export': 'export',
  'btn-export-both': 'exportBoth',
  'btn-clear-chart': 'clear',
  'btn-pd-import': 'import',
  'btn-pd-export': 'export',
  'btn-pd-clear': 'clear',
};
/** @param {HTMLElement} element @param {string} text */
export function setShortcutTip(element, text) {
  const id = shortcutButtons[element.id];
  if (element.dataset) element.dataset.shortcutBaseTitle = text;
  const binding = id ? state.settings.shortcuts[id] : '';
  element.title = binding
    ? `${text} (${displayBinding(binding, document.documentElement?.dataset?.os === 'macos')})`
    : text;
  element.setAttribute('aria-label', element.title);
  if (id && binding)
    element.setAttribute(
      'aria-keyshortcuts',
      displayBinding(binding, document.documentElement?.dataset?.os === 'macos')
        .replace('⌘', 'Meta')
        .replace('Ctrl', 'Control'),
    );
  else element.removeAttribute?.('aria-keyshortcuts');
}
