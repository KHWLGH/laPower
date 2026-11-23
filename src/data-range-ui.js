// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * @file 时间轴滑块同步、可见窗口索引解析与范围统计后台任务协调。
 */

import { setChartXWindow } from './chart.js';
import { firstIndexAfter, firstIndexAtOrAfter } from './chart-buckets.js';
import { classifyChartWindow, emptyChartWindow, resolveChartWindow } from './chart-window.js';
import {
  getEl,
  labelRangeSnapshot,
  monitorDisplayVisible,
  paintEmptyRangeLabels,
  setRangeStatsPending,
  setTextIfChanged,
} from './data-display.js';
import { t } from './i18n.js';
import { energyMaxStepS } from './measurement.js';
import { captureRangeStatsSnapshot, computeRangeStatsSync, rangeStatsRevision } from './range-stats.js';
import { computeRangeStatsBackground } from './range-stats-background.js';
import { state } from './state.js';
import { formatRelativeHMS } from './utils.js';

/** @typedef {import('./range-stats.js').RangeStatsSnapshot} RangeSnapshot */
/** @typedef {Pick<RangeSnapshot,'columns'|'startIndex'|'endIndex'|'len'|'revision'|'maxStepS'>} RangeMetadata */
/**
 * @typedef {{ snapshot: RangeSnapshot, windowKey: string, cancelled: boolean,
 *   controller: AbortController, promise: Promise<import('./range-stats.js').RangeStats|null> }} RangeStatsJob
 */

const SYNC_RANGE_POINTS = 4096;

/**
 * 创建时间轴范围与范围统计协调器。
 * @param {{
 *   onRangeSettledStats: () => void,
 *   onRangeStatsComputed: () => void,
 * }} hooks
 */
export function createRangeUi(hooks) {
  /** @type {import('./range-stats.js').RangeStats|null} */
  let rangeStatsCache = null;
  /** @type {RangeStatsJob|null} */
  let rangeStatsJob = null;
  let rangeCalculationMs = 0;
  let rangeStartedAt = -Infinity;
  let rangeStartedWindow = '';
  /** @type {import('./state.js').ChartSeriesColumns|null} */
  let rangeStartedColumns = null;
  let rangeStartedRevision = -1;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let rangeRefreshTimer = null;

  /**
   * 更新滑块填充条的位置和宽度。
   * @param {[number,number]} [domain] Frozen overview domain during a pointer gesture.
   */
  function updateSliderFill(domain) {
    if (!monitorDisplayVisible()) return;
    const startEl = /** @type {HTMLInputElement|null} */ (getEl('range-start'));
    const endEl = /** @type {HTMLInputElement|null} */ (getEl('range-end'));
    if (startEl && startEl.value !== String(state.settings.rangeStart))
      startEl.value = String(state.settings.rangeStart);
    if (endEl && endEl.value !== String(state.settings.rangeEnd)) endEl.value = String(state.settings.rangeEnd);

    const xs = state.chartSeries.x;
    const [min, max] = domain ?? [xs.at(0), xs.at(-1)];
    const span = max - min;
    const win = state.chartWindow;
    const start = span > 0 && win.mode !== 'full' ? Math.max(0, ((win.min - min) * 100) / span) : 0;
    const end = span > 0 && win.mode !== 'full' ? Math.min(100, ((win.max - min) * 100) / span) : 100;
    const fill = getEl('slider-fill');
    if (fill?.style) {
      if (fill.style.left !== `${start}%`) fill.style.left = `${start}%`;
      if (fill.style.width !== `${end - start}%`) fill.style.width = `${end - start}%`;
    }
    fill?.classList?.toggle('is-pannable', end - start < 100);

    const handleStart = getEl('range-handle-start');
    const handleEnd = getEl('range-handle-end');
    if (handleStart?.style) {
      if (handleStart.style.left !== `${start}%`) handleStart.style.left = `${start}%`;
      if (handleStart.getAttribute?.('aria-valuenow') !== String(start))
        handleStart.setAttribute('aria-valuenow', String(start));
    }
    if (handleEnd?.style) {
      if (handleEnd.style.left !== `${end}%`) handleEnd.style.left = `${end}%`;
      if (handleEnd.getAttribute?.('aria-valuenow') !== String(end))
        handleEnd.setAttribute('aria-valuenow', String(end));
    }
  }

  function sampleEdgeEps() {
    return Math.max(state.settings.sampleRate / 1000, 0.001);
  }

  /** @param {number} start @param {number} end */
  function writePermille(start, end) {
    const s = Math.max(0, Math.min(1000, start | 0));
    const e = Math.max(s, Math.min(1000, end | 0));
    state.settings.rangeStart = s;
    state.settings.rangeEnd = e;
  }

  /**
   * 把已判定的时间窗反推成滑块千分比（follow 右柄钉在 1000）。
   * @param {{ mode: string, min: number, max: number }} win
   * @param {number} n
   * @param {import('./state.js').F64Col} xs
   */
  function writePermilleFromWindow(win, n, xs) {
    if (win.mode === 'full' || n <= 1) {
      writePermille(0, 1000);
      return;
    }
    const startIndex = firstIndexAtOrAfter(xs, n, win.min);
    const startP = Math.max(0, Math.min(1000, Math.round((startIndex * 1000) / n)));
    if (win.mode === 'follow') {
      writePermille(startP, 1000);
      return;
    }
    const endIndex = Math.max(startIndex, firstIndexAfter(xs, n, win.max) - 1);
    const endP = Math.max(startP, Math.min(1000, Math.round(((endIndex + 1) * 1000) / n)));
    writePermille(startP, endP);
  }

  /** @param {number} totalPoints */
  function permilleIndices(totalPoints) {
    let startIndex = Math.floor((totalPoints * state.settings.rangeStart) / 1000);
    let endIndex = Math.floor((totalPoints * state.settings.rangeEnd) / 1000);
    if (endIndex >= totalPoints) endIndex = totalPoints - 1;
    if (startIndex > endIndex) startIndex = endIndex;
    if (startIndex < 0) startIndex = 0;
    return { startIndex, endIndex };
  }

  /** 滑块改了千分比之后，把当前选区收成时间窗会话态。 */
  function adoptWindowFromPermille() {
    const xs = state.chartSeries.x;
    const n = xs.length;
    if (n === 0) {
      state.chartWindow = emptyChartWindow();
      return;
    }
    const { startIndex, endIndex } = permilleIndices(n);
    const min = xs.valueAt(startIndex);
    const max = xs.valueAt(endIndex);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      state.chartWindow = emptyChartWindow();
      return;
    }
    state.chartWindow = classifyChartWindow(min, max, xs.at(0), xs.at(-1), sampleEdgeEps());
  }

  /**
   * 获取当前可见数据范围的索引。
   * @returns {{ startIndex: number, endIndex: number }}
   */
  function getVisibleDataRange() {
    const totalPoints = state.chartSeries.timestamps.length;
    if (totalPoints === 0) return { startIndex: 0, endIndex: 0 };

    const mode = state.chartWindow?.mode ?? 'full';
    if (mode === 'follow' || mode === 'frozen') {
      const xs = state.chartSeries.x;
      const min = state.chartWindow.min;
      const max = state.chartWindow.max;
      let startIndex = firstIndexAtOrAfter(xs, totalPoints, min);
      let endIndex = firstIndexAfter(xs, totalPoints, max) - 1;
      if (endIndex >= totalPoints) endIndex = totalPoints - 1;
      if (endIndex < 0) endIndex = 0;
      if (startIndex > endIndex) startIndex = endIndex;
      if (startIndex < 0) startIndex = 0;
      return { startIndex, endIndex };
    }

    return permilleIndices(totalPoints);
  }

  /** Cheap cache lookup before copying any chunk references. @returns {RangeMetadata|null} */
  function currentRangeMetadata() {
    const columns = state.chartSeries;
    if (!columns.x.length) return null;
    return {
      columns,
      ...getVisibleDataRange(),
      len: columns.x.length,
      revision: rangeStatsRevision(columns),
      maxStepS: energyMaxStepS(state.dataIntervalMs),
    };
  }

  function currentRangeSnapshot() {
    const meta = currentRangeMetadata();
    return meta ? captureRangeStatsSnapshot(meta.columns, meta.startIndex, meta.endIndex, meta.maxStepS) : null;
  }

  /** @param {RangeMetadata} snapshot */
  function matchingRangeCache(snapshot) {
    const cache = rangeStatsCache;
    if (
      cache &&
      cache.columns === snapshot.columns &&
      cache.revision === snapshot.revision &&
      cache.startIndex === snapshot.startIndex &&
      cache.endIndex === snapshot.endIndex &&
      cache.maxStepS === snapshot.maxStepS &&
      snapshot.len >= cache.len
    )
      return cache;
    return null;
  }

  /** @param {RangeMetadata} snapshot */
  function incrementalRangeOptions(snapshot) {
    const cache = rangeStatsCache;
    if (
      cache &&
      cache.columns === snapshot.columns &&
      cache.revision === snapshot.revision &&
      cache.startIndex === 0 &&
      snapshot.startIndex === 0 &&
      cache.endIndex === cache.len - 1 &&
      snapshot.endIndex === snapshot.len - 1 &&
      cache.maxStepS === snapshot.maxStepS &&
      snapshot.len > cache.len
    )
      return { seed: cache, foldStart: cache.len };
    return { foldStart: snapshot.startIndex };
  }

  /** 范围同步查询保留给显式调用；UI 使用下面的分片路径。 */
  function getRangeStats() {
    const snapshot = currentRangeSnapshot();
    if (!snapshot) return null;
    const cached = matchingRangeCache(snapshot);
    if (cached) return cached;
    rangeStatsCache = computeRangeStatsSync(snapshot, incrementalRangeOptions(snapshot));
    return rangeStatsCache;
  }

  function rangeWindowKey() {
    const window = state.chartWindow;
    if (window.mode === 'follow') return `follow:${window.duration}`;
    if (window.mode === 'frozen') return `frozen:${window.min}:${window.max}`;
    return `full:${state.settings.rangeStart}:${state.settings.rangeEnd}`;
  }

  function cancelRangeStatsJob() {
    if (rangeStatsJob) {
      rangeStatsJob.cancelled = true;
      rangeStatsJob.controller.abort();
    }
    rangeStatsJob = null;
    if (rangeRefreshTimer !== null) clearTimeout(rangeRefreshTimer);
    rangeRefreshTimer = null;
  }

  /** @param {number} delay */
  function scheduleRangeCalculation(delay) {
    if (rangeRefreshTimer !== null) return;
    rangeRefreshTimer = setTimeout(
      () => {
        rangeRefreshTimer = null;
        hooks.onRangeStatsComputed();
      },
      Math.max(0, delay),
    );
  }

  /** @param {RangeStatsJob} job */
  function rangeStatsJobInvalid(job) {
    const snapshot = job.snapshot;
    if (
      job.cancelled ||
      !monitorDisplayVisible() ||
      !state.settings.statsRange ||
      state.chartSeries !== snapshot.columns ||
      state.chartSeries.x.length < snapshot.len ||
      rangeStatsRevision(state.chartSeries) !== snapshot.revision ||
      energyMaxStepS(state.dataIntervalMs) !== snapshot.maxStepS ||
      rangeWindowKey() !== job.windowKey
    )
      return true;
    const range = getVisibleDataRange();
    if (range.startIndex === snapshot.startIndex && range.endIndex === snapshot.endIndex) return false;
    return !(
      state.chartSeries.x.length > snapshot.len &&
      (state.chartWindow.mode === 'follow' || (snapshot.startIndex === 0 && snapshot.endIndex === snapshot.len - 1)) &&
      range.startIndex >= snapshot.startIndex &&
      range.endIndex >= snapshot.endIndex
    );
  }

  /**
   * A completed snapshot remains useful when its actual bounds are explicitly labeled.
   * @param {RangeMetadata} snapshot
   */
  function completedRangeSnapshot(snapshot) {
    const cache = rangeStatsCache;
    return cache?.columns === snapshot.columns &&
      cache.revision === snapshot.revision &&
      cache.maxStepS === snapshot.maxStepS &&
      cache.len <= snapshot.len
      ? cache
      : null;
  }

  /**
   * Resolve a fixed current-window snapshot; cancellation resolves to null.
   * Large ranges run in a Worker (cooperative fallback); short append tails remain synchronous.
   * @returns {Promise<import('./range-stats.js').RangeStats|null>}
   */
  function getRangeStatsAsync() {
    const meta = currentRangeMetadata();
    if (!meta || !state.settings.statsRange || !monitorDisplayVisible()) {
      cancelRangeStatsJob();
      return Promise.resolve(null);
    }
    const cached = matchingRangeCache(meta);
    if (cached) return Promise.resolve(cached);
    if (rangeStatsJob && rangeStatsJobInvalid(rangeStatsJob)) cancelRangeStatsJob();
    if (rangeStatsJob) return rangeStatsJob.promise;
    const options = incrementalRangeOptions(meta);
    const windowKey = rangeWindowKey();
    const delay = rangeStartedAt + Math.max(250, rangeCalculationMs * 4) - performance.now();
    if (
      meta.endIndex - options.foldStart + 1 > SYNC_RANGE_POINTS &&
      delay > 0 &&
      rangeStartedWindow === windowKey &&
      rangeStartedColumns === meta.columns &&
      rangeStartedRevision === meta.revision
    ) {
      scheduleRangeCalculation(delay);
      return Promise.resolve(completedRangeSnapshot(meta));
    }
    const snapshot = captureRangeStatsSnapshot(meta.columns, meta.startIndex, meta.endIndex, meta.maxStepS);
    if (snapshot.endIndex - options.foldStart + 1 <= SYNC_RANGE_POINTS) {
      rangeStatsCache = computeRangeStatsSync(snapshot, options);
      return Promise.resolve(rangeStatsCache);
    }
    /** @type {RangeStatsJob} */
    const job = {
      snapshot,
      windowKey,
      cancelled: false,
      controller: new AbortController(),
      promise: Promise.resolve(null),
    };
    rangeStatsJob = job;
    rangeStartedAt = performance.now();
    rangeStartedWindow = windowKey;
    rangeStartedColumns = meta.columns;
    rangeStartedRevision = meta.revision;
    job.promise = computeRangeStatsBackground(snapshot, {
      ...options,
      signal: job.controller.signal,
      isCancelled: () => rangeStatsJobInvalid(job),
    }).then((result) => {
      if (rangeStatsJob !== job) return null;
      rangeStatsJob = null;
      if (!result || rangeStatsJobInvalid(job)) return null;
      rangeCalculationMs = performance.now() - rangeStartedAt;
      rangeStatsCache = result;
      hooks.onRangeStatsComputed();
      return result;
    });
    return job.promise;
  }

  /** Returns null while a large current range is being calculated. */
  function getDisplayRangeStats() {
    const snapshot = currentRangeMetadata();
    if (!snapshot) return null;
    const cached = matchingRangeCache(snapshot);
    if (cached) {
      labelRangeSnapshot(cached, false);
      return cached;
    }
    void getRangeStatsAsync();
    const result = matchingRangeCache(snapshot) ?? completedRangeSnapshot(snapshot);
    labelRangeSnapshot(
      result,
      !!result && (result.startIndex !== snapshot.startIndex || result.endIndex !== snapshot.endIndex),
    );
    return result;
  }

  function markStaleRangeStatsPending() {
    if (rangeStatsJob && rangeStatsJobInvalid(rangeStatsJob)) cancelRangeStatsJob();
    const snapshot = currentRangeMetadata();
    if (snapshot && !matchingRangeCache(snapshot) && !completedRangeSnapshot(snapshot)) setRangeStatsPending(true);
  }

  /**
   * @param {import('./state.js').ChartSeriesColumns['x']} xs
   * @param {number} n
   * @param {number} dataMin
   * @param {number} dataMax
   */
  function paintFromWindow(xs, n, dataMin, dataMax) {
    const resolved = resolveChartWindow(state.chartWindow, dataMin, dataMax);
    state.chartWindow = resolved;
    setChartXWindow(resolved.min, resolved.max);
    writePermilleFromWindow(resolved, n, xs);
  }

  /**
   * @param {import('./state.js').ChartSeriesColumns['x']} xs
   * @param {number} n
   * @param {number} dataMin
   * @param {number} dataMax
   */
  function paintFromPermille(xs, n, dataMin, dataMax) {
    const { startIndex, endIndex } = permilleIndices(n);
    const startSeconds = Number.isFinite(xs.valueAt(startIndex)) ? xs.valueAt(startIndex) : dataMin;
    const endSeconds = Number.isFinite(xs.valueAt(endIndex)) ? xs.valueAt(endIndex) : dataMax;
    setChartXWindow(startSeconds, endSeconds);
    state.chartWindow = classifyChartWindow(startSeconds, endSeconds, dataMin, dataMax, sampleEdgeEps());
    if (state.chartWindow.mode !== 'full') {
      writePermilleFromWindow(state.chartWindow, n, xs);
    }
  }

  /** @param {import('./state.js').ChartSeriesColumns['x']} xs */
  function writeRangeLabels(xs) {
    const { startIndex, endIndex } = getVisibleDataRange();
    const startSeconds = Number.isFinite(xs.valueAt(startIndex)) ? xs.valueAt(startIndex) : 0;
    const endSeconds = Number.isFinite(xs.valueAt(endIndex)) ? xs.valueAt(endIndex) : 0;

    const el1 = getEl('range-start-time');
    const el2 = getEl('range-end-time');
    setTextIfChanged(el1, formatRelativeHMS(startSeconds));
    setTextIfChanged(el2, formatRelativeHMS(endSeconds));

    const points = endIndex - startIndex + 1;
    const durationSec = Math.max(0, endSeconds - startSeconds);
    const el3 = getEl('range-duration');
    setTextIfChanged(el3, t('durationPoints', { duration: formatRelativeHMS(durationSec), points }));
    if (state.settings.statsRange) markStaleRangeStatsPending();
  }

  /**
   * 主图缩放或平移时同步时间轴，交互结束后吸附录制边缘并更新选区统计。
   * @param {number} min @param {number} max @param {boolean} settled
   * @param {[number,number]} [overviewDomain]
   */
  function applyChartXWindow(min, max, settled, overviewDomain) {
    const xs = state.chartSeries.x;
    const n = xs.length;
    if (n === 0) return;
    const dataMin = xs.at(0);
    const dataMax = xs.at(-1);
    state.chartWindow = settled
      ? classifyChartWindow(min, max, dataMin, dataMax, 1e-6)
      : { mode: 'frozen', min, max, duration: max - min };
    paintFromWindow(xs, n, dataMin, dataMax);
    if (monitorDisplayVisible()) {
      updateSliderFill(overviewDomain);
      writeRangeLabels(xs);
    }
    if (settled && state.settings.statsRange) hooks.onRangeSettledStats();
  }

  /** 根据滑块值 / 时间窗更新主图表的可见范围。 */
  function updateChartRange() {
    const xs = state.chartSeries.x;
    const n = xs.length;
    if (n === 0) {
      setChartXWindow(null, null);
      if (monitorDisplayVisible()) {
        updateSliderFill();
        paintEmptyRangeLabels();
      }
      return;
    }

    const dataMin = xs.at(0);
    const dataMax = xs.at(-1);
    const mode = state.chartWindow?.mode ?? 'full';
    if (!state.__rangeDragging && (mode === 'follow' || mode === 'frozen')) {
      paintFromWindow(xs, n, dataMin, dataMax);
    } else {
      paintFromPermille(xs, n, dataMin, dataMax);
    }
    if (monitorDisplayVisible()) {
      updateSliderFill();
      writeRangeLabels(xs);
    }
  }

  function resetRangeStatsState() {
    rangeStatsCache = null;
    rangeStartedColumns = null;
    rangeStartedRevision = -1;
    rangeStartedWindow = '';
    rangeStartedAt = -Infinity;
    rangeCalculationMs = 0;
  }

  return {
    updateSliderFill,
    writePermille,
    adoptWindowFromPermille,
    applyChartXWindow,
    updateChartRange,
    getVisibleDataRange,
    getRangeStats,
    getRangeStatsAsync,
    getDisplayRangeStats,
    cancelRangeStatsJob,
    markStaleRangeStatsPending,
    resetRangeStatsState,
    getRangeCalculationMs: () => rangeCalculationMs,
  };
}
