import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCsvExportOptions } from '../src/export-options.js';
import {
  bindingConflict,
  bindingFromEvent,
  defaultShortcuts,
  displayBinding,
  normalizeShortcuts,
  validBinding,
} from '../src/shortcuts-core.js';

test('legacy settings receive defaults, while custom bindings and unbinding persist', () => {
  assert.deepEqual(normalizeShortcuts(null), defaultShortcuts);
  assert.equal(defaultShortcuts.record, 'P');
  const custom = normalizeShortcuts({ record: 'R', mark: '', clear: 'Mod+Shift+X' });
  assert.equal(custom.record, 'R');
  assert.equal(custom.mark, '');
  assert.equal(custom.clear, 'Mod+Shift+X');
  assert.deepEqual(normalizeShortcuts(JSON.parse(JSON.stringify(custom))), custom);
  assert.deepEqual(normalizeCsvExportOptions({ withTemp: true }), {
    withTemp: true,
    withDeviceInfo: true,
    withMarkers: true,
  });
  assert.deepEqual(normalizeCsvExportOptions({ withTemp: 'yes', withMarkers: false }), {
    withTemp: false,
    withDeviceInfo: true,
    withMarkers: false,
  });
});

test('overlapping commands cannot share keys; application close/quit are reserved', () => {
  assert.equal(bindingConflict('record', 'M', defaultShortcuts), 'mark');
  assert.equal(bindingConflict('clear', '', defaultShortcuts), null);
  for (const key of ['Mod+W', 'Mod+Q', 'Mod+Shift+W', 'Mod+Shift+Q', 'Alt+F4', 'Control', 'Shift', 'Enter', ' '])
    assert.equal(validBinding(key), false, key);
  const loaded = normalizeShortcuts({ record: 'M', mark: 'M', clear: 'Mod+Q' });
  assert.equal(loaded.record, 'M');
  assert.equal(loaded.mark, '');
  assert.equal(loaded.clear, '');
});

test('keyboard events match exact portable modifiers on Windows and macOS', () => {
  const event = { key: 's', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true };
  assert.equal(bindingFromEvent(event, false), 'Mod+Shift+S');
  assert.equal(bindingFromEvent(event, true), null);
  assert.equal(bindingFromEvent({ ...event, ctrlKey: false, metaKey: true }, true), 'Mod+Shift+S');
  assert.equal(bindingFromEvent({ ...event, key: 'Control' }, false), null);
  assert.equal(displayBinding('Mod+Shift+S', true), '⌘+Shift+S');
  assert.equal(displayBinding('Mod+S', false), 'Ctrl+S');
});
