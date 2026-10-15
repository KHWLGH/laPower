// @ts-check
/** Portable bindings use Mod for Ctrl on Windows/Linux and Command on macOS. */
export const shortcutActions = [
  { id: 'record', label: 'shortcutRecord', binding: 'P', views: ['monitor'] },
  { id: 'mark', label: 'addMarker', binding: 'M', views: ['monitor'] },
  { id: 'import', label: 'import', binding: 'Mod+O', views: ['monitor', 'pd'] },
  { id: 'export', label: 'export', binding: 'Mod+S', views: ['monitor', 'pd'] },
  { id: 'exportBoth', label: 'exportBoth', binding: 'Mod+Shift+S', views: ['monitor'] },
  { id: 'clear', label: 'clear', binding: '', views: ['monitor', 'pd'] },
];
export const defaultShortcuts = Object.fromEntries(shortcutActions.map((a) => [a.id, a.binding]));

/** @param {string} binding */
export function validBinding(binding) {
  if (!binding) return true;
  if (!/^(Mod\+)?(Alt\+)?(Shift\+)?([A-Z0-9]|F(?:[1-9]|1\d|2[0-4]))$/.test(binding)) return false;
  return !['Mod+W', 'Mod+Q', 'Mod+Shift+W', 'Mod+Shift+Q', 'Alt+F4'].includes(binding);
}

/** @param {string} id @param {string} binding @param {Record<string,string>} bindings */
export function bindingConflict(id, binding, bindings) {
  if (!binding) return null;
  const action = shortcutActions.find((a) => a.id === id);
  return (
    shortcutActions.find(
      (a) => a.id !== id && bindings[a.id] === binding && a.views.some((view) => action?.views.includes(view)),
    )?.id ?? null
  );
}

/** @param {unknown} saved @returns {Record<string,string>} */
export function normalizeShortcuts(saved) {
  const source = saved && typeof saved === 'object' ? saved : {};
  /** @type {Record<string,string>} */
  const result = {};
  for (const action of shortcutActions) {
    const candidate = source[action.id];
    const binding = typeof candidate === 'string' && validBinding(candidate) ? candidate : action.binding;
    result[action.id] = bindingConflict(action.id, binding, result) ? '' : binding;
  }
  return result;
}

/** @param {Pick<KeyboardEvent,'key'|'ctrlKey'|'metaKey'|'altKey'|'shiftKey'>} event @param {boolean} mac */
export function bindingFromEvent(event, mac) {
  if (mac ? event.ctrlKey : event.metaKey) return null;
  const key = event.key.toUpperCase();
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4]))$/.test(key)) return null;
  return `${(mac ? event.metaKey : event.ctrlKey) ? 'Mod+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${key}`;
}

/** @param {string} binding @param {boolean} mac */
export function displayBinding(binding, mac) {
  return binding.replace('Mod', mac ? '⌘' : 'Ctrl');
}
