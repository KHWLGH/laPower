/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeTimeAxisSplits, layoutXAxisLabels } from '../src/chart-axes.js';
import {
  classifyChartWindow,
  emptyChartWindow,
  minZoomSpan,
  moveNavigatorWindow,
  panPermilleWindow,
  panTimeWindow,
  resolveChartWindow,
  settleNavigatorWindow,
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

test('settleNavigatorWindow enters follow/full when pan or end reaches the live right edge', () => {
  const panFollow = settleNavigatorWindow({
    min: 80,
    max: 100,
    dataMin: 0,
    dataMax: 100,
    latest: 104,
    part: 'pan',
    secondsPerPixel: 0.2,
    moved: true,
  });
  assert.deepEqual(panFollow, { min: 84, max: 104 });
  const panWin = classifyChartWindow(panFollow.min, panFollow.max, 0, 104, 1e-6);
  assert.equal(panWin.mode, 'follow');
  assert.equal(panWin.duration, 20);

  const endFollow = settleNavigatorWindow({
    min: 70,
    max: 100,
    dataMin: 0,
    dataMax: 100,
    latest: 104,
    part: 'end',
    secondsPerPixel: 0.2,
    moved: true,
  });
  assert.deepEqual(endFollow, { min: 74, max: 104 });
  const endWin = classifyChartWindow(endFollow.min, endFollow.max, 0, 104, 1e-6);
  assert.equal(endWin.mode, 'follow');
  assert.equal(endWin.duration, 30);

  const endFull = settleNavigatorWindow({
    min: 0,
    max: 100,
    dataMin: 0,
    dataMax: 100,
    latest: 104,
    part: 'end',
    secondsPerPixel: 0.2,
    moved: true,
  });
  assert.deepEqual(endFull, { min: 0, max: 104 });
  assert.equal(classifyChartWindow(endFull.min, endFull.max, 0, 104, 1e-6).mode, 'full');
});

test('settleNavigatorWindow snaps within ~2px of the right edge and respects deliberate stops', () => {
  const snappedEnd = settleNavigatorWindow({
    min: 70,
    max: 99.7,
    dataMin: 0,
    dataMax: 100,
    latest: 104,
    part: 'end',
    secondsPerPixel: 0.2,
    moved: true,
  });
  assert.deepEqual(snappedEnd, { min: 74, max: 104 });
  assert.equal(classifyChartWindow(snappedEnd.min, snappedEnd.max, 0, 104, 1e-6).mode, 'follow');

  const snappedPan = settleNavigatorWindow({
    min: 79.7,
    max: 99.7,
    dataMin: 0,
    dataMax: 100,
    latest: 104,
    part: 'pan',
    secondsPerPixel: 0.2,
    moved: true,
  });
  assert.deepEqual(snappedPan, { min: 84, max: 104 });
  assert.equal(classifyChartWindow(snappedPan.min, snappedPan.max, 0, 104, 1e-6).mode, 'follow');

  const deliberateStop = settleNavigatorWindow({
    min: 70,
    max: 99,
    dataMin: 0,
    dataMax: 100,
    latest: 104,
    part: 'end',
    secondsPerPixel: 0.2,
    moved: true,
  });
  assert.deepEqual(deliberateStop, { min: 70, max: 99 });
  assert.equal(classifyChartWindow(deliberateStop.min, deliberateStop.max, 0, 104, 1e-6).mode, 'frozen');
});

test('settleNavigatorWindow preserves follow or restores full on start-handle moves without hijacking frozen end', () => {
  const startFollow = settleNavigatorWindow({
    min: 60,
    max: 100,
    dataMin: 0,
    dataMax: 100,
    latest: 103,
    part: 'start',
    secondsPerPixel: 0.2,
    moved: true,
  });
  assert.deepEqual(startFollow, { min: 63, max: 103 });
  assert.equal(classifyChartWindow(startFollow.min, startFollow.max, 0, 103, 1e-6).mode, 'follow');

  const startFull = settleNavigatorWindow({
    min: 0.2,
    max: 100,
    dataMin: 0,
    dataMax: 100,
    latest: 103,
    part: 'start',
    secondsPerPixel: 0.2,
    moved: true,
  });
  assert.deepEqual(startFull, { min: 0, max: 103 });
  assert.equal(classifyChartWindow(startFull.min, startFull.max, 0, 103, 1e-6).mode, 'full');

  const frozenStartMove = settleNavigatorWindow({
    min: 20,
    max: 99.8,
    dataMin: 0,
    dataMax: 100,
    latest: 103,
    part: 'start',
    secondsPerPixel: 0.2,
    moved: true,
  });
  assert.deepEqual(frozenStartMove, { min: 20, max: 99.8 });
  assert.equal(classifyChartWindow(frozenStartMove.min, frozenStartMove.max, 0, 103, 1e-6).mode, 'frozen');

  const unmovedClick = settleNavigatorWindow({
    min: 70,
    max: 99.8,
    dataMin: 0,
    dataMax: 100,
    latest: 103,
    part: 'end',
    secondsPerPixel: 0.2,
    moved: false,
  });
  assert.deepEqual(unmovedClick, { min: 70, max: 99.8 });
  assert.equal(classifyChartWindow(unmovedClick.min, unmovedClick.max, 0, 103, 1e-6).mode, 'frozen');
});

test('computeTimeAxisSplits keeps uniform density across pans and spans and handles tiny or narrow ranges', () => {
  const splits120 = computeTimeAxisSplits(0, 120, 120, 900);
  assert.deepEqual(splits120, [0, 15, 30, 45, 60, 75, 90, 105, 120]);

  for (const [min, max] of [
    [0, 60],
    [12.4, 72.4],
    [15.7, 75.7],
    [10, 30],
    [0, 47.3],
  ]) {
    const span = max - min;
    const splits = computeTimeAxisSplits(min, max, span, 900);
    assert.equal(splits.length, 9);
    assert.equal(splits[0], min);
    assert.equal(splits.at(-1), max);
    const step = span / 8;
    for (let i = 1; i < splits.length; i++) {
      assert.ok(Math.abs(splits[i] - splits[i - 1] - step) < 1e-9);
    }
  }

  // Sub-5s spans use foundIncr = 5 from xAxisIncrs so uPlot skips its internal Wl lookup.
  const sub5 = computeTimeAxisSplits(10, 13.7, 5, (5 / 3.7) * 900);
  assert.equal(sub5.length, 9);
  assert.equal(sub5[0], 10);
  assert.equal(sub5.at(-1), 13.7);

  assert.deepEqual(computeTimeAxisSplits(10.01, 10.06, 5, (5 / 0.05) * 900), [10.01, 10.06]);
  assert.equal(computeTimeAxisSplits(10.0, 10.3, 5, (5 / 0.3) * 900).length, 4);
  assert.deepEqual(computeTimeAxisSplits(0, 60, 60, 80), [60]);

  // Hidden Y axes reduce side margins, clamping divisions via extraLeftPx/extraRightPx.
  const uncapped = computeTimeAxisSplits(0, 60, 60, 320);
  const marginClamped = computeTimeAxisSplits(0, 60, 60, 320, { extraLeftPx: 38, extraRightPx: 38 });
  assert.equal(uncapped.length, 4);
  assert.equal(marginClamped.length, 3);
  assert.deepEqual(computeTimeAxisSplits(0, 60, 60, 160, { extraLeftPx: 38, extraRightPx: 38 }), [60]);
});

test('layoutXAxisLabels clamps edge labels inside the canvas and prioritizes end then start time', () => {
  const full = layoutXAxisLabels(
    [
      { x: 6, text: '00:00:00.0', width: 72 },
      { x: 200, text: '00:00:30.0', width: 72 },
      { x: 394, text: '00:01:00.0', width: 72 },
    ],
    400,
  );
  assert.deepEqual(full, [
    { drawX: 4, align: 'left', left: 4, right: 76, text: '00:00:00.0' },
    { drawX: 200, align: 'center', left: 164, right: 236, text: '00:00:30.0' },
    { drawX: 396, align: 'right', left: 324, right: 396, text: '00:01:00.0' },
  ]);

  const noInterior = layoutXAxisLabels(
    [
      { x: 10, text: 'start', width: 72 },
      { x: 110, text: 'mid', width: 72 },
      { x: 210, text: 'end', width: 72 },
    ],
    220,
  );
  assert.deepEqual(
    noInterior.map((item) => item.text),
    ['start', 'end'],
  );

  const endOnly = layoutXAxisLabels(
    [
      { x: 10, text: 'start', width: 72 },
      { x: 130, text: 'end', width: 72 },
    ],
    140,
  );
  assert.deepEqual(
    endOnly.map((item) => item.text),
    ['end'],
  );
});
