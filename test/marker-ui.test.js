import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

const button = new EventTarget();
let prompts = [];
let answer = () => '50%';
globalThis.window = {
  __TAURI__: { core: { invoke: async () => null } },
  prompt(message, fallback) {
    prompts.push({ message, fallback });
    return answer();
  },
};
globalThis.document = { getElementById: (id) => (id === 'btn-add-marker' ? button : null) };

const { emptyChartColumns, defaultSettings, state } = await import('../src/state.js');
const { markersOf, settledMarkers } = await import('../src/markers.js');
const { t } = await import('../src/i18n.js');
const { addMarkerFromShortcut, initMarkerUI } = await import('../src/marker-ui.js');
initMarkerUI();

function appendRow() {
  const cols = state.chartSeries;
  cols.x.push(cols.x.length);
  cols.timestamps.push(cols.x.length * 1000);
}

test.beforeEach(() => {
  prompts = [];
  answer = () => '50%';
  state.settings = { ...defaultSettings };
  state.chartSeries = emptyChartColumns();
  state.isRecording = true;
  state.mainChart = null;
  button.disabled = false;
});

test('immediate button marking works before the first sample and can be repeated without a prompt', () => {
  state.settings.immediateMarker = true;
  button.dispatchEvent(new Event('click'));
  assert.deepEqual(markersOf(state.chartSeries), [{ index: 0, label: t('markerDefaultLabel', { n: 1 }) }]);
  assert.deepEqual(settledMarkers(state.chartSeries, 0), []);
  appendRow();
  button.dispatchEvent(new Event('click'));
  assert.deepEqual(markersOf(state.chartSeries), [
    { index: 0, label: t('markerDefaultLabel', { n: 1 }) },
    { index: 1, label: t('markerDefaultLabel', { n: 2 }) },
  ]);
  assert.equal(prompts.length, 0);
});

test('immediate shortcut marking selects the cursor sample, and falls back to the last sample when paused', () => {
  state.settings.immediateMarker = true;
  for (let i = 0; i < 4; i++) appendRow();
  state.mainChart = { cursor: { left: 1.2 }, posToVal: (left) => left };
  addMarkerFromShortcut();
  state.isRecording = false;
  state.mainChart.cursor.left = -1;
  addMarkerFromShortcut();
  assert.deepEqual(
    markersOf(state.chartSeries).map((marker) => marker.index),
    [1, 3],
  );
  assert.equal(prompts.length, 0);
});

test('disabled shortcut and paused empty data cannot create an immediate marker', () => {
  state.settings.immediateMarker = true;
  button.disabled = true;
  addMarkerFromShortcut();
  button.disabled = false;
  state.isRecording = false;
  button.dispatchEvent(new Event('click'));
  assert.deepEqual(markersOf(state.chartSeries), []);
  assert.equal(prompts.length, 0);
});

test('turning immediate mode off restores label confirmation and keeps the original position', async () => {
  state.settings.immediateMarker = true;
  button.dispatchEvent(new Event('click'));
  appendRow();
  state.settings.immediateMarker = false;
  answer = () => {
    assert.equal(markersOf(state.chartSeries).length, 1, 'the label has not been confirmed yet');
    appendRow();
    appendRow();
    return '  50%, warm  ';
  };
  button.dispatchEvent(new Event('click'));
  await setImmediate();
  assert.equal(prompts.length, 1);
  assert.deepEqual(markersOf(state.chartSeries).at(-1), { index: 1, label: '50% warm' });
});

test('prompt cancellation creates no marker, and a blank label uses the default', async () => {
  answer = () => null;
  addMarkerFromShortcut();
  await setImmediate();
  assert.deepEqual(markersOf(state.chartSeries), []);
  answer = () => '  ';
  addMarkerFromShortcut();
  await setImmediate();
  assert.deepEqual(markersOf(state.chartSeries), [{ index: 0, label: prompts.at(-1).fallback }]);
});

test('confirmation after replacing the data cannot mark the old or new dataset', async () => {
  const old = state.chartSeries;
  answer = () => {
    state.chartSeries = emptyChartColumns();
    return '50%';
  };
  button.dispatchEvent(new Event('click'));
  await setImmediate();
  assert.deepEqual(markersOf(old), []);
  assert.deepEqual(markersOf(state.chartSeries), []);
});
