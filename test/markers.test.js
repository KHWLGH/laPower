import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addMarker,
  MARKER_LABEL_MAX,
  markerRowFor,
  markersOf,
  nearestRow,
  nextMarkerNumber,
  onMarkersChange,
  removeMarker,
  renameMarker,
  sanitizeMarkerLabel,
  setMarkers,
  settledMarkers,
} from '../src/markers.js';
import { F64Col } from '../src/state.js';

test('labels are reduced to what one CSV cell can carry', () => {
  assert.equal(sanitizeMarkerLabel('  50%,  warm\n"lid" open; '), '50% warm lid open');
  assert.equal(sanitizeMarkerLabel('a\tb\u0000c'), 'a b c');
  assert.equal(sanitizeMarkerLabel(null), '');
  assert.equal(sanitizeMarkerLabel(' \t '), '');
  assert.equal(sanitizeMarkerLabel('x'.repeat(100)).length, MARKER_LABEL_MAX);
});

test('a leading formula character is swapped for its full-width twin', () => {
  assert.equal(sanitizeMarkerLabel('=HYPERLINK("x")'), '＝HYPERLINK( x )');
  assert.equal(sanitizeMarkerLabel('+1'), '＋1');
  assert.equal(sanitizeMarkerLabel('-5 W'), '－5 W');
  assert.equal(sanitizeMarkerLabel('@SUM'), '＠SUM');
  assert.equal(sanitizeMarkerLabel('5-6 W'), '5-6 W', 'only the first character matters');
});

test('markers stay sorted by row and a second marker on the same row joins the first', () => {
  const cols = {};
  assert.deepEqual(markersOf(cols), []);
  assert.equal(addMarker(cols, 5, 'b'), true);
  assert.equal(addMarker(cols, 2, 'a'), true);
  assert.equal(addMarker(cols, 5, 'c'), true);
  assert.equal(addMarker(cols, 7, ' , '), false, 'nothing left after cleaning');
  assert.equal(addMarker(cols, -1, 'x'), false);
  assert.deepEqual(markersOf(cols), [
    { index: 2, label: 'a' },
    { index: 5, label: 'b / c' },
  ]);
  assert.equal(nextMarkerNumber(cols), 3);
  assert.deepEqual(markersOf({}), [], 'another dataset has none');
});

test('renaming to nothing deletes, and removal leaves the other markers alone', () => {
  const cols = {};
  addMarker(cols, 1, 'one');
  addMarker(cols, 2, 'two');
  renameMarker(cols, 1, ' 1% ');
  assert.deepEqual(markersOf(cols), [
    { index: 1, label: '1%' },
    { index: 2, label: 'two' },
  ]);
  renameMarker(cols, 1, '  ');
  assert.deepEqual(markersOf(cols), [{ index: 2, label: 'two' }]);
  removeMarker(cols, 2);
  assert.deepEqual(markersOf(cols), []);
});

test('replacing the markers drops what does not fit the data', () => {
  const cols = {};
  setMarkers(
    cols,
    [
      { index: 3, label: 'late' },
      { index: 0, label: 'start' },
      { index: 1.5, label: 'fraction' },
      { index: 9, label: 'beyond' },
      { index: 3, label: 'again' },
      { index: 2, label: '' },
    ],
    5,
  );
  assert.deepEqual(markersOf(cols), [
    { index: 0, label: 'start' },
    { index: 3, label: 'late / again' },
  ]);
  setMarkers(cols, null);
  assert.deepEqual(markersOf(cols), []);
});

test('a marker waits for the next row while recording and lands on the last row otherwise', () => {
  assert.equal(markerRowFor(0, false), null);
  assert.equal(markerRowFor(0, true), 0);
  assert.equal(markerRowFor(5, true), 5);
  assert.equal(markerRowFor(5, false), 4);
  const cols = {};
  addMarker(cols, 4, 'recorded');
  addMarker(cols, 5, 'next row');
  assert.deepEqual(settledMarkers(cols, 5), [{ index: 4, label: 'recorded' }]);
  assert.equal(settledMarkers(cols, 6).length, 2);
});

test('the nearest row is found by time, ties going to the earlier row', () => {
  const xs = new F64Col();
  for (const x of [0, 1, 2, 4]) xs.push(x);
  assert.equal(nearestRow(xs, -1), 0);
  assert.equal(nearestRow(xs, 1.4), 1);
  assert.equal(nearestRow(xs, 1.6), 2);
  assert.equal(nearestRow(xs, 3), 2);
  assert.equal(nearestRow(xs, 10), 3);
  assert.equal(nearestRow(xs, Number.NaN), null);
  assert.equal(nearestRow(new F64Col(), 1), null);
});

test('every change is announced until the listener unsubscribes', () => {
  let calls = 0;
  const stop = onMarkersChange(() => calls++);
  const cols = {};
  addMarker(cols, 0, 'a');
  renameMarker(cols, 0, 'b');
  setMarkers(cols, [{ index: 1, label: 'c' }]);
  removeMarker(cols, 1);
  assert.equal(calls, 4);
  stop();
  addMarker(cols, 0, 'd');
  assert.equal(calls, 4);
});
