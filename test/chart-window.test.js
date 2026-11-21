/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyChartWindow,
  emptyChartWindow,
  minZoomSpan,
  moveNavigatorWindow,
  panPermilleWindow,
  panTimeWindow,
  resolveChartWindow,
  settleWheelZoomWindow,
  wheelZoomFactor,
  wheelZoomPivot,
  zoomTimeWindow,
} from '../src/chart-window.js';

test('minZoomSpan is at least 0.1s and two sample intervals', () => {
  assert.equal(minZoomSpan(250), 0.5);
  assert.equal(minZoomSpan(10), 0.1);
  assert.equal(minZoomSpan(100), 0.2);
});

test('wheelZoomFactor zooms out on positive deltaY and in on negative', () => {
  assert.equal(wheelZoomFactor(0), 1);
  assert.ok(wheelZoomFactor(100) > 1);
  assert.ok(wheelZoomFactor(-100) < 1);
  assert.ok(Math.abs(wheelZoomFactor(100) * wheelZoomFactor(-100) - 1) < 1e-12);
});

test('navigator edge edits clamp to the data range and pan preserves the span', () => {
  const window = { min: 20, max: 40 };
  assert.deepEqual(moveNavigatorWindow(window, 'start', -30, 0, 100, 5), { min: 0, max: 40 });
  assert.deepEqual(moveNavigatorWindow(window, 'end', 80, 0, 100, 5), { min: 20, max: 100 });
  assert.deepEqual(moveNavigatorWindow(window, 'pan', 70, 0, 100, 5), { min: 80, max: 100 });
});

test('zoomTimeWindow keeps the pivot fraction and clamps to data', () => {
  const zoomed = zoomTimeWindow({
    min: 0,
    max: 10,
    pivot: 8,
    factor: 0.5,
    dataMin: 0,
    dataMax: 10,
    minSpan: 0.1,
  });
  assert.ok(Math.abs(zoomed.max - zoomed.min - 5) < 1e-9);
  assert.ok(Math.abs((8 - zoomed.min) / 5 - 0.8) < 1e-9);
});

test('zoomTimeWindow does not shrink below minSpan or grow past the data', () => {
  const tight = zoomTimeWindow({
    min: 4,
    max: 4.2,
    pivot: 4.1,
    factor: 0.01,
    dataMin: 0,
    dataMax: 10,
    minSpan: 0.5,
  });
  assert.ok(Math.abs(tight.max - tight.min - 0.5) < 1e-9);

  const wide = zoomTimeWindow({
    min: 4,
    max: 6,
    pivot: 5,
    factor: 100,
    dataMin: 0,
    dataMax: 10,
    minSpan: 0.1,
  });
  assert.equal(wide.min, 0);
  assert.equal(wide.max, 10);
});

test('overview wheel zoom keeps both edges anchored to the pointer', () => {
  const pivot = wheelZoomPivot({
    ratio: 0.7,
    min: 0,
    max: 100,
    dataMin: 0,
    dataMax: 100,
    overview: true,
  });
  assert.equal(pivot, 70);

  const zoomed = zoomTimeWindow({
    min: 0,
    max: 100,
    pivot,
    factor: 0.5,
    dataMin: 0,
    dataMax: 100,
    minSpan: 0.1,
  });
  assert.equal(zoomed.min, 35);
  assert.equal(zoomed.max, 85);
});

test('settling a full overview zoom preserves full-history tracking as data arrives', () => {
  const zoomed = zoomTimeWindow({ min: 20, max: 60, pivot: 45, factor: 3, dataMin: 0, dataMax: 100, minSpan: 0.1 });
  const settled = settleWheelZoomWindow({
    ...zoomed,
    dataMin: 0,
    dataMax: 100,
    latest: 100.25,
  });
  assert.deepEqual(settled, { min: 0, max: 100.25 });
  const window = classifyChartWindow(settled.min, settled.max, 0, 100.25, 1e-6);
  assert.equal(window.mode, 'full');
  assert.deepEqual(resolveChartWindow(window, 0, 101), {
    mode: 'full',
    min: 0,
    max: 101,
    duration: 101,
  });
});

test('settling a pointer-centered historical zoom does not snap it to the live tail', () => {
  const settled = settleWheelZoomWindow({
    min: 45,
    max: 55,
    dataMin: 0,
    dataMax: 100,
    latest: 100.25,
  });
  assert.deepEqual(settled, { min: 45, max: 55 });
  assert.equal(classifyChartWindow(settled.min, settled.max, 0, 100.25, 1e-6).mode, 'frozen');
});

test('settling a tail-anchored zoom carries its span forward', () => {
  const settled = settleWheelZoomWindow({
    min: 80,
    max: 100,
    dataMin: 0,
    dataMax: 100,
    latest: 100.25,
  });
  assert.deepEqual(settled, { min: 80.25, max: 100.25 });
});

test('settling a wheel window within an edge tolerance restores full/follow tracking', () => {
  const full = settleWheelZoomWindow({ min: 0.005, max: 99.995, dataMin: 0, dataMax: 100, latest: 101 });
  assert.deepEqual(full, { min: 0, max: 101 });

  const follow = settleWheelZoomWindow({ min: 80, max: 99.995, dataMin: 0, dataMax: 100, latest: 101 });
  assert.deepEqual(follow, { min: 81.005, max: 101 });
});

test('classifyChartWindow pins the right edge as follow and the interior as frozen', () => {
  const full = classifyChartWindow(0, 10, 0, 10, 0.01);
  assert.equal(full.mode, 'full');

  const follow = classifyChartWindow(7, 10, 0, 10, 0.01);
  assert.equal(follow.mode, 'follow');
  assert.equal(follow.duration, 3);
  assert.equal(follow.max, 10);

  const frozen = classifyChartWindow(2, 5, 0, 10, 0.01);
  assert.equal(frozen.mode, 'frozen');
  assert.equal(frozen.min, 2);
  assert.equal(frozen.max, 5);
});

test('resolveChartWindow follow keeps duration as lastX grows', () => {
  const win = { mode: 'follow', duration: 4, min: 6, max: 10 };
  const next = resolveChartWindow(win, 0, 20);
  assert.equal(next.mode, 'follow');
  assert.equal(next.duration, 4);
  assert.equal(next.min, 16);
  assert.equal(next.max, 20);
});

test('resolveChartWindow frozen keeps min/max as lastX grows', () => {
  const win = { mode: 'frozen', duration: 3, min: 2, max: 5 };
  const next = resolveChartWindow(win, 0, 20);
  assert.equal(next.mode, 'frozen');
  assert.equal(next.min, 2);
  assert.equal(next.max, 5);
});

test('resolveChartWindow full tracks the whole series', () => {
  const next = resolveChartWindow(emptyChartWindow(), 0, 15);
  assert.equal(next.mode, 'full');
  assert.equal(next.min, 0);
  assert.equal(next.max, 15);
});

test('panPermilleWindow keeps span and clamps to 0–1000', () => {
  assert.deepEqual(panPermilleWindow(200, 500, 100), { start: 300, end: 600 });
  assert.deepEqual(panPermilleWindow(200, 500, -500), { start: 0, end: 300 });
  assert.deepEqual(panPermilleWindow(800, 950, 200), { start: 850, end: 1000 });
  assert.deepEqual(panPermilleWindow(0, 1000, 50), { start: 0, end: 1000 });
});

test('main-plot pan preserves a short window inside a long recording and at both edges', () => {
  const first = 0.25;
  const last = 80_000;
  assert.deepEqual(panTimeWindow(500, 501.25, 0.125, first, last), { min: 500.125, max: 501.375 });
  assert.deepEqual(panTimeWindow(500, 501.25, -10_000, first, last), { min: 0.25, max: 1.5 });
  assert.deepEqual(panTimeWindow(500, 501.25, 1e6, first, last), { min: 79_998.75, max: last });
  assert.deepEqual(panTimeWindow(first, last, 30, first, last), { min: first, max: last });
});
