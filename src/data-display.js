// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * @file 监控视图 DOM 元素缓存、实时仪表条/卡片、统计卡片与状态栏显示更新。
 */

import { t } from './i18n.js';
import { niceCeiling } from './measurement.js';
import { describeLimit, pointsForLimit, remainingInfo } from './recording-limit.js';
import { state } from './state.js';
import { setTempReadingAvailable } from './temperature.js';
import { formatRecordingTime, formatRelativeHMS, formatSampleRateLabel, recordingOriginMs } from './utils.js';

/** @type {Record<string, number>} */
const meterPeak = {
  voltage: 0,
  current: 0,
  power: 0,
  temp: 0,
};

/** @type {Document|null} */
let domCacheDoc = null;
/** @type {Map<string, HTMLElement>} */
const domCache = new Map();
/** @type {Parameters<typeof updateRealtimeDisplay>[0]|null} */
let lastRealtime = null;
/** @type {boolean|null} */
let rangeStatsDisplayPending = null;

/** 监控视图隐藏期间只积累数据，恢复时从最新状态一次性补齐显示。 */
export function monitorDisplayVisible() {
  return state.settings.activeView === 'monitor' && state.windowVisible && !document.hidden;
}

/**
 * 监控热路径 DOM 节点惰性缓存：document 切换或节点卸载时自动失效，兼容 Node 测试桩。
 * @param {string} id
 * @returns {HTMLElement|null}
 */
export function getEl(id) {
  if (typeof document === 'undefined') return null;
  if (domCacheDoc !== document) {
    domCache.clear();
    domCacheDoc = document;
  }
  const cached = domCache.get(id);
  if (cached && cached.isConnected !== false) return cached;
  const found = document.getElementById(id);
  if (found) domCache.set(id, found);
  else domCache.delete(id);
  return found;
}

/** @param {Element|null} el @param {string} value */
export function setTextIfChanged(el, value) {
  if (el && el.textContent !== value) el.textContent = value;
}

/** @param {HTMLElement|null} el @param {string} value */
export function setTransformIfChanged(el, value) {
  if (el?.style && el.style.transform !== value) el.style.transform = value;
}

/** @param {keyof typeof meterPeak} channel @param {number} value */
function trackMeterPeak(channel, value) {
  const abs = Math.abs(value);
  if (Number.isFinite(abs) && abs > meterPeak[channel]) meterPeak[channel] = abs;
}

/**
 * @param {string} id
 * @param {keyof typeof meterPeak} channel
 * @param {number} value
 * @param {'x'|'y'} axis
 */
export function setMeter(id, channel, value, axis) {
  const el = getEl(id);
  if (!el?.style) return;
  const abs = Math.abs(value);
  if (!Number.isFinite(abs)) {
    setTransformIfChanged(el, axis === 'x' ? 'scaleX(0)' : 'scaleY(0)');
    return;
  }
  trackMeterPeak(channel, value);
  const ceil = niceCeiling(meterPeak[channel]);
  const pct = ceil > 0 ? Math.min(1, abs / ceil) : 0;
  setTransformIfChanged(el, axis === 'x' ? `scaleX(${pct})` : `scaleY(${pct})`);
}

export function resetMeters() {
  for (const key of Object.keys(meterPeak)) meterPeak[key] = 0;
  for (const id of ['lv-voltage', 'lv-current', 'lv-power', 'lv-temp']) {
    const el = document.getElementById(id);
    setTransformIfChanged(el, 'scaleX(0)');
  }
}

export function updateChartEmptyState() {
  if (!monitorDisplayVisible()) return;
  document.querySelector?.('.chart-container')?.classList.toggle('has-data', state.chartSeries.x.length > 0);
}

export function updateDurationDisplay() {
  const el = document.getElementById('record-duration');
  if (!el) return;
  const lastX = state.chartSeries.x.length > 0 ? state.chartSeries.x.at(-1) : Number.NaN;
  let seconds = Number.isFinite(lastX) ? lastX : 0;
  if (state.isRecording && state.recordingStartTime !== null) {
    seconds = state.recordingBaseSeconds + Math.max(0, (Date.now() - state.recordingStartTime) / 1000);
  }
  setTextIfChanged(el, state.chartSeries.x.length === 0 && !state.isRecording ? '--' : formatRelativeHMS(seconds));
}

export function recordLimitPoints() {
  return pointsForLimit(state.settings.recordLimitMb);
}

/** 底栏剩余提示：按当前采样率估算还能记录多久。 */
export function updateRemainingDisplay() {
  const el = getEl('record-remaining');
  if (!el) return;
  const info = remainingInfo(state.chartSeries.x.length, recordLimitPoints(), state.settings.sampleRate);
  setTextIfChanged(el, info.text);
  const item = getEl('status-remaining');
  if (item) {
    item.classList?.toggle?.('is-warning', info.warn);
    if (item.title !== info.title) item.title = info.title;
  }
}

/** 设置页上限说明与底栏同步刷新（上限或采样率变了）。 */
export function refreshRecordLimitUI() {
  setTextIfChanged(
    document.getElementById('record-limit-hint'),
    describeLimit(state.settings.recordLimitMb, state.settings.sampleRate),
  );
  updateRemainingDisplay();
}

export function updateSampleRateStatus() {
  const el = document.getElementById('status-sample-rate');
  const intervalMs = state.settings.sampleRate;
  const perSecond = Number((1000 / intervalMs).toFixed(2));
  const value =
    intervalMs > 1000
      ? t('secondsPerSample', { value: perSecond, seconds: Number((intervalMs / 1000).toFixed(2)) })
      : t('samplesPerSecond', { value: perSecond });
  setTextIfChanged(el, value || formatSampleRateLabel(intervalMs));
  refreshRecordLimitUI();
}

/**
 * 更新实时数据显示面板。
 * @param {{ voltage: number, current: number, power: number, temp: number, dp?: number, dn?: number, cc1?: number, cc2?: number }} data
 */
export function updateRealtimeDisplay(data) {
  lastRealtime = data;
  if (!monitorDisplayVisible()) return;
  const vEl = getEl('rt-voltage');
  const cEl = getEl('rt-current');
  const pEl = getEl('rt-power');
  setTextIfChanged(vEl, data.voltage.toFixed(4));
  // 电流数值恒显示幅值，方向由箭头表达（需求：不用正负号）
  setTextIfChanged(cEl, Math.abs(data.current).toFixed(4));
  setTextIfChanged(pEl, data.power.toFixed(4));

  setMeter('lv-voltage', 'voltage', data.voltage, 'x');
  setMeter('lv-current', 'current', data.current, 'x');
  setMeter('lv-power', 'power', data.power, 'x');

  const dirEl = getEl('rt-current-dir');
  if (dirEl) {
    const showDir = state.settings.signedCurrent && Number.isFinite(data.current) && data.current !== 0;
    if (dirEl.hidden !== !showDir) dirEl.hidden = !showDir;
    if (showDir) {
      dirEl.classList?.toggle('fi-arrow-right', data.current > 0);
      dirEl.classList?.toggle('fi-arrow-left', data.current < 0);
      const title = data.current > 0 ? t('forwardCurrent') : t('reverseCurrent');
      if (dirEl.title !== title) dirEl.title = title;
    }
  }

  setTempReadingAvailable(Number.isFinite(data.temp));
  if (state.isTempConnected && Number.isFinite(data.temp)) {
    const tEl = getEl('rt-temp');
    setTextIfChanged(tEl, data.temp.toFixed(1));
    setMeter('lv-temp', 'temp', data.temp, 'x');
  } else if (state.isTempConnected) {
    const tEl = getEl('rt-temp');
    setTextIfChanged(tEl, '--');
    setMeter('lv-temp', 'temp', Number.NaN, 'x');
  }

  /** @param {string} id @param {number|undefined} val */
  const setSignal = (id, val) => {
    const el = getEl(id);
    setTextIfChanged(el, Number.isFinite(val) ? /** @type {number} */ (val).toFixed(2) : '--');
  };
  setSignal('rt-dp', data.dp);
  setSignal('rt-dn', data.dn);
  setSignal('rt-cc1', data.cc1);
  setSignal('rt-cc2', data.cc2);
}

/**
 * 记录最新实时读数并更新峰值刻度（数据摄入热路径调用，不触碰 DOM）。
 * @param {Parameters<typeof updateRealtimeDisplay>[0]} data
 */
export function recordRealtimeSample(data) {
  lastRealtime = data;
  trackMeterPeak('voltage', data.voltage);
  trackMeterPeak('current', data.current);
  trackMeterPeak('power', data.power);
  trackMeterPeak('temp', data.temp);
}

/**
 * 最近一个点的显示值（电流按「记录电流方向」处理、功率取幅值），没有数据时为 null。
 * 协议控制页的读数条用它，不另开订阅。
 */
export function getLastRealtime() {
  return lastRealtime;
}

/** 把实时卡片清成占位，避免清空 / 导入后仍显示上一轮活点。 */
export function paintRealtimeEmptyCards() {
  /** @param {string} id */
  const dash = (id) => {
    const el = document.getElementById(id);
    setTextIfChanged(el, '--');
  };
  dash('rt-voltage');
  dash('rt-current');
  dash('rt-power');
  dash('rt-temp');
  dash('rt-dp');
  dash('rt-dn');
  dash('rt-cc1');
  dash('rt-cc2');
  const dirEl = document.getElementById('rt-current-dir');
  if (dirEl && !dirEl.hidden) dirEl.hidden = true;
  resetMeters();
}

/** 把实时卡片清成占位，避免清空 / 导入后仍显示上一轮活点。 */
export function resetRealtimeCards() {
  lastRealtime = null;
  if (monitorDisplayVisible()) paintRealtimeEmptyCards();
  else for (const key of Object.keys(meterPeak)) meterPeak[key] = 0;
}

export function paintEmptyRangeLabels() {
  const el1 = getEl('range-start-time');
  const el2 = getEl('range-end-time');
  const el3 = getEl('range-duration');
  setTextIfChanged(el1, '--');
  setTextIfChanged(el2, '--');
  setTextIfChanged(el3, t('noDataRange'));
}

/** @param {import('./range-stats.js').RangeStats|null} result @param {boolean} updating */
export function labelRangeSnapshot(result, updating) {
  const label = document.getElementById('stats-snapshot-label');
  if (!label) return;
  label.hidden = !state.settings.statsRange;
  const xs = result?.columns.x;
  const useSystemTime = state.settings.useSystemTime;
  const originMs = useSystemTime ? recordingOriginMs(result?.columns, state.lastRecordingStartTime) : null;
  setTextIfChanged(
    label,
    result && xs
      ? t('rangeSnapshot', {
          start: formatRecordingTime(xs.valueAt(result.startIndex), { useSystemTime, originMs }),
          end: formatRecordingTime(xs.valueAt(result.endIndex), { useSystemTime, originMs }),
          updating: updating ? t('updating') : '',
        })
      : t('calculatingRange'),
  );
}

/** @param {boolean} pending */
export function setRangeStatsPending(pending) {
  if (rangeStatsDisplayPending === pending) return;
  rangeStatsDisplayPending = pending;
  for (const id of [
    'min-voltage',
    'max-voltage',
    'avg-voltage',
    'min-current',
    'max-current',
    'avg-current',
    'min-power',
    'max-power',
    'avg-power',
    'min-temp',
    'max-temp',
    'avg-temp',
    'rt-energy',
    'rt-capacity',
  ]) {
    const el = getEl(id);
    const busy = pending ? 'true' : 'false';
    if (el?.getAttribute?.('aria-busy') !== busy) el?.setAttribute?.('aria-busy', busy);
    if (pending) {
      setTextIfChanged(el, '--');
      if (el && el.title !== '') el.title = '';
    }
  }
}

/**
 * 将汇总后的最值、均值和缺测提示写入统计卡片 DOM。
 * @param {typeof state.stats} displayStats
 * @param {number|null} displayPowerAvg
 * @param {number|null} displayTempAvg
 * @param {{ voltage: number, current: number, power: number, temp: number }} skipped
 */
export function paintStatsCards(displayStats, displayPowerAvg, displayTempAvg, skipped) {
  /** @param {string} id @param {number} val @param {number} [decimals=3] */
  const setText = (id, val, decimals = 3) => {
    const el = getEl(id);
    setTextIfChanged(el, Number.isFinite(val) ? val.toFixed(decimals) : '--');
  };

  setText('min-voltage', displayStats.voltage.min);
  setText('max-voltage', displayStats.voltage.max);
  setText('min-current', displayStats.current.min);
  setText('max-current', displayStats.current.max);
  setText('min-power', displayStats.power.min);
  setText('max-power', displayStats.power.max);

  /** @param {number|null} val @returns {val is number} */
  const isAvg = (val) => val !== null && Number.isFinite(val);

  const avgVoltage = displayStats.voltage.count > 0 ? displayStats.voltage.sum / displayStats.voltage.count : null;
  const avgCurrent = displayStats.current.count > 0 ? displayStats.current.sum / displayStats.current.count : null;
  const avgVoltageEl = getEl('avg-voltage');
  const avgCurrentEl = getEl('avg-current');
  setTextIfChanged(avgVoltageEl, isAvg(avgVoltage) ? avgVoltage.toFixed(3) : '--');
  setTextIfChanged(avgCurrentEl, isAvg(avgCurrent) ? Math.abs(avgCurrent).toFixed(3) : '--');

  const avgPowerEl = getEl('avg-power');
  setTextIfChanged(avgPowerEl, isAvg(displayPowerAvg) ? displayPowerAvg.toFixed(3) : '--');

  const tempStats = displayStats.temp || state.stats.temp;
  setText('min-temp', tempStats.min, 1);
  setText('max-temp', tempStats.max, 1);

  const avgTempEl = getEl('avg-temp');
  setTextIfChanged(avgTempEl, isAvg(displayTempAvg) ? displayTempAvg.toFixed(1) : '--');

  /** 「(N点)」标签仍是原始行数，这里说明均值实际只折入了有限值。 */
  const setSkipTip = (/** @type {string} */ id, /** @type {number} */ count) => {
    const el = getEl(id);
    const title = count > 0 ? t('missingSamples', { count }) : '';
    if (el && el.title !== title) el.title = title;
  };
  setSkipTip('avg-voltage', skipped.voltage);
  setSkipTip('avg-current', skipped.current);
  setSkipTip('avg-power', skipped.power);
  setSkipTip('avg-temp', skipped.temp);
}

/** @param {number} wh @param {number} mah */
export function paintEnergyCards(wh, mah) {
  const whEl = document.getElementById('rt-energy');
  const mahEl = document.getElementById('rt-capacity');
  setTextIfChanged(whEl, wh.toFixed(4));
  setTextIfChanged(mahEl, mah.toFixed(2));
}
