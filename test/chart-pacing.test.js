/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChartRenderPolicy, liveChartIntervalMs, zoomStrokeFactor } from '../src/chart-pacing.js';

function feedback(policy, delayMs, at, overrides = {}) {
  return policy.observe({ delayMs, at, visible: true, dense: true, idleFrameMs: 16, ...overrides });
}

test('zoom stroke factor tapers dense views without exceeding either limit', () => {
  assert.equal(zoomStrokeFactor(0, 1000), 1);
  assert.equal(zoomStrokeFactor(1000, 1000), 1);
  const medium = zoomStrokeFactor(4000, 1000);
  const dense = zoomStrokeFactor(12000, 1000);
  assert.ok(medium < 1 && dense < medium && dense > 0.5);
  assert.equal(zoomStrokeFactor(1_000_000, 1000), 0.5);
  assert.equal(zoomStrokeFactor(4000, 2000), zoomStrokeFactor(2000, 1000));
});

test('density responds to consecutive slow frames and a single severe frame, within bounded levels', () => {
  const policy = new ChartRenderPolicy();
  assert.equal(policy.pixelsPerBucket, 2);
  assert.equal(feedback(policy, 40, 100), false);
  assert.equal(feedback(policy, 40, 200), true);
  assert.equal(policy.pixelsPerBucket, 4);
  assert.equal(feedback(policy, 120, 350), true);
  assert.equal(policy.pixelsPerBucket, 16);
  assert.equal(feedback(policy, 120, 500), false);
  assert.equal(policy.pixelsPerBucket, 16);
  policy.reset();
  assert.equal(policy.pixelsPerBucket, 2);
});

test('a healthy frame interrupts slow feedback and the idle interval determines the threshold', () => {
  const policy = new ChartRenderPolicy();
  feedback(policy, 40, 100);
  feedback(policy, 16, 150);
  assert.equal(feedback(policy, 40, 200), false);
  assert.equal(feedback(policy, 40, 250, { idleFrameMs: 25 }), false);
  assert.equal(policy.pixelsPerBucket, 2);
});

test('continuous interaction lowers the budget after measured pressure without sacrificing healthy detail', () => {
  const policy = new ChartRenderPolicy();
  assert.equal(feedback(policy, 16, 100, { interactive: true }), false);
  assert.equal(policy.pixelsPerBucket, 2);
  assert.equal(feedback(policy, 40, 150, { interactive: true }), true);
  assert.equal(policy.pixelsPerBucket, 4);
  assert.equal(feedback(policy, 40, 200, { interactive: true }), true);
  assert.equal(policy.pixelsPerBucket, 8);
});

test('recovery requires two continuous healthy seconds and five seconds between changes', () => {
  const policy = new ChartRenderPolicy();
  feedback(policy, 110, 100);
  assert.equal(policy.pixelsPerBucket, 8);
  for (let at = 200; at < 5100; at += 100) assert.equal(feedback(policy, 16, at), false);
  assert.equal(feedback(policy, 16, 5100), true);
  assert.equal(policy.pixelsPerBucket, 4);
  for (let at = 5200; at < 10100; at += 100) assert.equal(feedback(policy, 16, at), false);
  assert.equal(feedback(policy, 16, 10100), true);
  assert.equal(policy.pixelsPerBucket, 2);
  for (let at = 10200; at <= 20100; at += 100) feedback(policy, 16, at);
  assert.equal(policy.pixelsPerBucket, 1);
});

test('hidden, sparse, invalid and interrupted feedback never establish recovery', () => {
  const policy = new ChartRenderPolicy();
  feedback(policy, 110, 100);
  feedback(policy, 16, 200);
  assert.equal(feedback(policy, 110, 300, { visible: false }), false);
  assert.equal(feedback(policy, 16, 6000), false);
  assert.equal(feedback(policy, 16, 6100, { dense: false }), false);
  assert.equal(feedback(policy, NaN, 6200), false);
  assert.equal(feedback(policy, 16, 10000), false);
  assert.equal(policy.pixelsPerBucket, 8);
  assert.equal(feedback(policy, 40, 10100), false);
  feedback(policy, 40, 10200, { visible: false });
  assert.equal(feedback(policy, 40, 10300), false);
});

test('live charts follow the display cadence while work fits and back off under raster pressure', () => {
  assert.equal(liveChartIntervalMs(0.4, true, 16, 16), 0);
  assert.equal(liveChartIntervalMs(0.4, true, 85, 16), 100);
  assert.equal(liveChartIntervalMs(12, true, 16, 16), 24);
  assert.equal(liveChartIntervalMs(0.4), 0);
  assert.equal(liveChartIntervalMs(NaN, true), 0);
  assert.equal(liveChartIntervalMs(0.4, true, 8, 8), 0);
  assert.equal(liveChartIntervalMs(5, false, 8, 8), 20);
  assert.equal(liveChartIntervalMs(0.4, true, 16, NaN), 0);
});
