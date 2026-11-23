// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * @file 数据入库、统计计算、UI 显示更新、录制控制、图表/统计重置。
 */

import { scheduleChartUpdate as requestChartUpdate, setChartXWindow, syncChartSeries, updateCharts } from './chart.js';
import { emptyChartWindow } from './chart-window.js';
import {
  getLastRealtime,
  monitorDisplayVisible,
  paintEnergyCards,
  paintRealtimeEmptyCards,
  paintStatsCards,
  recordLimitPoints,
  recordRealtimeSample,
  refreshRecordLimitUI,
  resetRealtimeCards,
  setRangeStatsPending,
  setTextIfChanged,
  updateChartEmptyState,
  updateDurationDisplay,
  updateRealtimeDisplay,
  updateRemainingDisplay,
  updateSampleRateStatus,
} from './data-display.js';
import { createRangeUi } from './data-range-ui.js';
import { deviceStream } from './device-stream.js';
import { displayFrames } from './frame-scheduler.js';
import { t } from './i18n.js';
import { markersOf } from './markers.js';
import { currentMagnitude, energyMaxStepS, nextRecordingX, streamSampleTime } from './measurement.js';
import { performanceDiagnostics } from './performance-diagnostics.js';
import { noteRecordedSource } from './provenance.js';
import { formatPoints, WARN_FRACTION } from './recording-limit.js';
import {
  configureSpool,
  finalizeSpool,
  spoolRecordingPaused,
  spoolRecordingStarted,
  spoolRowsAppended,
} from './recording-spool.js';
import { emptyChartColumns, setChartColumns, state } from './state.js';
import { updateTempUIVisibility } from './temperature.js';
import { syncMarkerControls, syncRecordUI } from './ui/controlbar.js';
import { toast } from './ui/toast.js';

export {
  getLastRealtime,
  refreshRecordLimitUI,
  resetRealtimeCards,
  updateChartEmptyState,
  updateDurationDisplay,
  updateRealtimeDisplay,
  updateRemainingDisplay,
  updateSampleRateStatus,
};

deviceStream.configure({
  getColumns: () => state.chartSeries,
  getPdEnabled: () => !state.settings.pdFollowRecording,
  onSample: (sample, segment) => addDataPoint(sample, segment),
  onBatchStart: () => beginIngestBatch(),
  onBatchEnd: () => endIngestBatch(),
  onBatch: () => spoolRowsAppended(),
});

configureSpool({
  onFailure: () => {
    void stopRecording().catch(() => {});
  },
});

const rangeUi = createRangeUi({
  onRangeSettledStats: () => scheduleStatsUpdate(),
  onRangeStatsComputed: () => {
    updateStatsDisplay();
    updateEnergyDisplay();
  },
});

state.__applyChartXWindow = rangeUi.applyChartXWindow;

export const updateSliderFill = rangeUi.updateSliderFill;
export const adoptWindowFromPermille = rangeUi.adoptWindowFromPermille;
export const updateChartRange = rangeUi.updateChartRange;
export const getVisibleDataRange = rangeUi.getVisibleDataRange;
export const getRangeStats = rangeUi.getRangeStats;
export const getRangeStatsAsync = rangeUi.getRangeStatsAsync;

const RECORD_COLUMNS = /** @type {(keyof import('./state.js').ChartSeriesColumns)[]} */ ([
  'x',
  'timestamps',
  'voltage',
  'current',
  'currentMagnitudes',
  'power',
  'temp',
  'dp',
  'dn',
  'cc1',
  'cc2',
  'recordingSegments',
  'sampleIntervals',
]);

/** @param {string} cmd @param {Record<string, unknown>} [args] */
function invokeCmd(cmd, args) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') return Promise.resolve(null);
  return invoke(cmd, args);
}

/** @type {ReturnType<typeof setInterval>|null} */
let durationTimer = null;

// ─── Single-recording limit ──────────────────────────────────────────────────

/** 已为哪份数据提示过「接近上限」/「已达上限」：每份数据各提示一次。 */
/** @type {object|null} */
let limitWarnedFor = null;
/** @type {object|null} */
let limitReachedFor = null;

/**
 * 还能再记录一个点吗。到 90% 提示一次；到上限时自动暂停一次并说明原因。
 * @param {import('./state.js').ChartSeriesColumns} cols
 */
function admitRecordedPoint(cols) {
  const limit = recordLimitPoints();
  const used = cols.x.length;
  if (used < limit) {
    if (used >= limit * WARN_FRACTION && limitWarnedFor !== cols) {
      limitWarnedFor = cols;
      toast.warning(() => t('limitWarning', { used: formatPoints(used), limit: formatPoints(limit) }));
    }
    return true;
  }
  if (limitReachedFor !== cols) {
    limitReachedFor = cols;
    void stopRecording().catch(() => {});
    toast.warning(() => t('limitReached', { limit: formatPoints(limit) }), {
      duration: 0,
    });
  }
  return false;
}

function startDurationTicker() {
  if (durationTimer !== null) return;
  updateDurationDisplay();
  durationTimer = setInterval(updateDurationDisplay, 250);
}

function stopDurationTicker() {
  if (durationTimer !== null) {
    clearInterval(durationTimer);
    durationTimer = null;
  }
  updateDurationDisplay();
}

/** 按当前状态刷新命令栏的记录按钮（开始 / 继续 / 暂停）。 */
export function refreshRecordButton() {
  const hasData = state.chartSeries.timestamps.length > 0;
  syncRecordUI({
    connected: state.isConnected,
    recording: state.isRecording,
    hasData,
    followPd: state.settings.pdFollowRecording,
  });
  syncMarkerControls({ canMark: state.isRecording || hasData, count: markersOf(state.chartSeries).length });
}

// ─── Data ingestion ──────────────────────────────────────────────────────────

/**
 * 接收一条设备数据，更新存储、统计、图表。
 * @param {import('./state.js').DeviceData | import('./device-stream.js').StreamSample} data
 * @param {import('./device-stream.js').RecordingSegment|null} [segment] Native null means preview only.
 */
export function addDataPoint(data, segment) {
  const native = 'received_us' in data;
  const time = native ? streamSampleTime(data, segment?.baseSeconds ?? 0) : null;
  const nowMs = time?.wallMs ?? Date.now();
  const record = native ? !!segment : state.isRecording;

  // Directional means describe net current; capacity and energy count both directions.
  // Older streams and one-frame windows need no separate magnitude metadata.
  const currentAbs = currentMagnitude(data.current, data.current_abs);
  const currentValue = state.settings.signedCurrent ? data.current : currentAbs;
  const powerAbs = currentMagnitude(data.power, data.power_abs);
  const hidTemp = Number.isFinite(data.temperature) ? /** @type {number} */ (data.temperature) : Number.NaN;
  let tempValue = Number.NaN;
  if (state.isTempConnected) {
    tempValue = state.settings.tempSource === 'device' ? hidTemp : (state.currentTemp ?? Number.NaN);
  }

  const realtime = { ...data, current: currentValue, power: powerAbs, temp: tempValue };
  recordRealtimeSample(realtime);

  // Live preview coalesces too; native segment gating is independent of arrival-time UI state.
  if (!record) {
    scheduleRangeUi();
    return;
  }

  /** @param {number|undefined} v */
  const lineVoltage = (v) =>
    Number.isFinite(v) && /** @type {number} */ (v) >= 0 && /** @type {number} */ (v) <= 60
      ? /** @type {number} */ (v)
      : Number.NaN;
  const dpValue = lineVoltage(data.dp);
  const dnValue = lineVoltage(data.dn);
  const cc1Value = Number.isFinite(data.cc1) ? /** @type {number} */ (data.cc1) : Number.NaN;
  const cc2Value = Number.isFinite(data.cc2) ? /** @type {number} */ (data.cc2) : Number.NaN;

  const cols = state.chartSeries;
  if (!admitRecordedPoint(cols)) {
    scheduleRangeUi();
    return;
  }
  const activeElapsed = state.recordingStartTime === null ? 0 : (nowMs - state.recordingStartTime) / 1000;
  const prevX = cols.x.length > 0 ? cols.x.at(-1) : Number.NaN;
  const relSeconds = time
    ? time.seconds
    : nextRecordingX(prevX, state.recordingBaseSeconds + Math.max(0, activeElapsed), state.settings.sampleRate);
  const beginsSegment = segment ? segment.first : state.energy.lastX === null;
  const sampleInterval =
    native && Number.isFinite(data.rate_ms) && data.rate_ms > 0 ? data.rate_ms : state.settings.sampleRate;
  if (cols.x.length === 0) state.dataIntervalMs = sampleInterval;
  const previousSegment = cols.recordingSegments.at(-1);
  for (const key of RECORD_COLUMNS) cols[key].reserveNext();
  cols.recordingSegments.push(
    beginsSegment ? (Number.isFinite(previousSegment) ? previousSegment + 1 : 1) : previousSegment,
  );
  if (segment) segment.first = false;

  cols.timestamps.push(nowMs);
  cols.sampleIntervals.push(sampleInterval);
  cols.voltage.push(data.voltage);
  cols.current.push(currentValue);
  cols.currentMagnitudes.push(currentAbs > Math.abs(currentValue) ? currentAbs : Number.NaN);
  cols.power.push(powerAbs);
  cols.temp.push(tempValue);
  cols.dp.push(dpValue);
  cols.dn.push(dnValue);
  cols.cc1.push(cc1Value);
  cols.cc2.push(cc2Value);
  cols.x.push(relSeconds);

  updateStats('voltage', data.voltage);
  updateStats('current', currentValue);
  updateStats('power', powerAbs);
  const firstTemp = !state.hasTempData && Number.isFinite(tempValue);
  if (state.isTempConnected && Number.isFinite(tempValue)) {
    state.hasTempData = true;
    updateStats('temp', tempValue);
  }
  if (cols.x.length <= 2 || firstTemp) document.dispatchEvent?.(new Event('lapower:export-availability-changed'));

  // 能量累计用相对秒（与范围统计同口径）；暂停空档不在 x 里。
  // 与 integrateEnergy 一致：跳过非有限值，避免单个缺失样本把整条累计污染成 NaN。
  const lastX = segment ? segment.lastX : state.energy.lastX;
  if (lastX !== null) {
    const stepS = relSeconds - lastX;
    const dt = stepS / 3600;
    if (
      dt >= 0 &&
      stepS <= energyMaxStepS(sampleInterval) &&
      Number.isFinite(dt) &&
      Number.isFinite(currentAbs) &&
      Number.isFinite(powerAbs)
    ) {
      state.energy.wh += powerAbs * dt;
      state.energy.mah += currentAbs * 1000 * dt;
    }
  }
  if (segment) segment.lastX = relSeconds;
  state.energy.lastX = state.isRecording ? relSeconds : null;

  scheduleStatsUpdate();

  scheduleRangeUi();
  // Auto Pause 逻辑（电流/功率阈值恒按幅值比较，与方向设置无关）
  if (state.isRecording && state.autoPauseSettings.enabled && state.autoPauseSettings.basis !== 'none') {
    let value;
    if (state.autoPauseSettings.basis === 'voltage') {
      value = data.voltage;
    } else if (state.autoPauseSettings.basis === 'current') {
      value = currentAbs;
    } else {
      value = powerAbs;
    }

    const triggerMs = native ? data.received_us / 1000 : nowMs;
    if (value <= state.autoPauseSettings.condition) {
      if (state.autoPauseSettings.duration <= 0) {
        void stopRecording({ discard: true }).catch(() => {});
        state.autoPauseSettings.triggerStartTime = null;
      } else if (state.autoPauseSettings.triggerStartTime === null) {
        state.autoPauseSettings.triggerStartTime = triggerMs;
      } else {
        const elapsed = (triggerMs - state.autoPauseSettings.triggerStartTime) / 1000;
        if (elapsed >= state.autoPauseSettings.duration) {
          void stopRecording({ discard: true }).catch(() => {});
          state.autoPauseSettings.triggerStartTime = null;
        }
      }
    } else {
      state.autoPauseSettings.triggerStartTime = null;
    }
  }

  scheduleChartUpdate();
}

// ─── Statistics ──────────────────────────────────────────────────────────────

/**
 * 更新指定字段的统计值。
 * @param {'voltage'|'current'|'power'|'temp'} field
 * @param {number} value
 */
export function updateStats(field, value) {
  const stat = state.stats[field];
  if (!stat || !Number.isFinite(value)) return;

  if (value < stat.min) stat.min = value;
  if (value > stat.max) stat.max = value;
  stat.sum += value;
  stat.count += 1;
}

export function suspendMonitorDisplay() {
  rangeUi.cancelRangeStatsJob();
  if (__statsUpdateTimer !== null) clearTimeout(__statsUpdateTimer);
  __statsUpdateTimer = null;
}

/** 更新统计显示面板（支持范围模式）。 */
export function updateStatsDisplay() {
  if (!monitorDisplayVisible()) {
    rangeUi.cancelRangeStatsJob();
    return;
  }
  let displayStats = state.stats;
  let powerAvg = state.stats.power.count > 0 ? state.stats.power.sum / state.stats.power.count : null;
  let tempAvg = state.stats.temp.count > 0 ? state.stats.temp.sum / state.stats.temp.count : null;
  let displayPowerAvg = powerAvg;
  let displayTempAvg = tempAvg;
  /** 范围模式下被跳过的非有限样本数，用于在均值上留一条 tooltip 说明。 */
  const skipped = { voltage: 0, current: 0, power: 0, temp: 0 };

  if (state.settings.statsRange && state.chartSeries.x.length > 0) {
    const range = rangeUi.getDisplayRangeStats();
    setRangeStatsPending(!range);
    if (!range) return;
    const span = range.endIndex - range.startIndex + 1;
    skipped.voltage = span - range.countV;
    skipped.current = span - range.countC;
    skipped.power = span - range.countP;
    skipped.temp = span - range.countT;
    displayStats = {
      voltage: { min: range.minV, max: range.maxV, sum: range.sumV, count: range.countV },
      current: { min: range.minC, max: range.maxC, sum: range.sumC, count: range.countC },
      power: { min: range.minP, max: range.maxP, sum: range.sumP, count: range.countP },
      temp: { min: range.minT, max: range.maxT, sum: range.sumT, count: range.countT },
    };
    powerAvg = range.countP > 0 ? range.sumP / range.countP : null;
    tempAvg = range.countT > 0 ? range.sumT / range.countT : null;
    displayPowerAvg = powerAvg;
    displayTempAvg = tempAvg;
  } else {
    rangeUi.cancelRangeStatsJob();
    setRangeStatsPending(false);
    const label = document.getElementById('stats-snapshot-label');
    if (label) label.hidden = true;
  }

  paintStatsCards(displayStats, displayPowerAvg, displayTempAvg, skipped);
}

/** 更新能量显示（支持范围模式）。 */
export function updateEnergyDisplay() {
  if (!monitorDisplayVisible()) {
    rangeUi.cancelRangeStatsJob();
    return;
  }
  let { wh, mah } = state.energy;

  // 范围模式下累计量也只统计选中区间，与最值/均值口径一致。
  if (state.settings.statsRange && state.chartSeries.x.length > 0) {
    const range = rangeUi.getDisplayRangeStats();
    setRangeStatsPending(!range);
    if (!range) return;
    wh = range.wh;
    mah = range.mah;
  } else {
    rangeUi.cancelRangeStatsJob();
    setRangeStatsPending(false);
  }

  paintEnergyCards(wh, mah);
}

// ─── Throttled stats refresh ─────────────────────────────────────────────────

/** @type {ReturnType<typeof setTimeout>|null} */
let __statsUpdateTimer = null;
/** @type {boolean} */
let __rangeUiPending = false;
let __rangeUiGeneration = 0;
/** @type {ReturnType<typeof setTimeout>|null} */
let statusUiTimer = null;
let lastStatusUiAt = -Infinity;

/**
 * Device batches are consumed point by point, but display work is submitted once per batch.
 * The flags keep the hot path free of rAF/timer registration while preserving every state
 * update and making a partial batch visible if ingestion reports an error.
 */
let ingestBatchDepth = 0;
let ingestBatchRangeDirty = false;
let ingestBatchStatsDirty = false;
let ingestBatchChartDirty = false;
let ingestBatchStartedAt = 0;

function beginIngestBatch() {
  if (ingestBatchDepth++ === 0) {
    ingestBatchStartedAt = performance.now();
    ingestBatchRangeDirty = false;
    ingestBatchStatsDirty = false;
    ingestBatchChartDirty = false;
  }
}

function endIngestBatch() {
  if (ingestBatchDepth <= 0) return;
  if (--ingestBatchDepth > 0) return;
  const rangeDirty = ingestBatchRangeDirty;
  const statsDirty = ingestBatchStatsDirty;
  const chartDirty = ingestBatchChartDirty;
  ingestBatchRangeDirty = false;
  ingestBatchStatsDirty = false;
  ingestBatchChartDirty = false;
  if (rangeDirty) scheduleRangeUi();
  if (statsDirty) scheduleStatsUpdate();
  if (chartDirty) scheduleChartUpdate();
  performanceDiagnostics.domCommit('ingest-batch-submit', ingestBatchStartedAt);
}

function scheduleChartUpdate() {
  if (ingestBatchDepth > 0) {
    ingestBatchChartDirty = true;
    return;
  }
  requestChartUpdate();
}

/**
 * 范围标签与点数：跟 rAF 走，不跟每个采样点走。
 */
export function scheduleRangeUi() {
  if (ingestBatchDepth > 0) {
    ingestBatchRangeDirty = true;
    return;
  }
  if (__rangeUiPending) return;
  if (!monitorDisplayVisible() && performance.now() - lastStatusUiAt < 250) {
    if (statusUiTimer === null)
      statusUiTimer = setTimeout(
        () => {
          statusUiTimer = null;
          scheduleRangeUi();
        },
        Math.max(0, 250 - (performance.now() - lastStatusUiAt)),
      );
    return;
  }
  if (statusUiTimer !== null) clearTimeout(statusUiTimer);
  statusUiTimer = null;
  __rangeUiPending = true;
  const generation = __rangeUiGeneration;
  displayFrames.schedule('monitor-ui', () => {
    const startedAt = performance.now();
    if (generation !== __rangeUiGeneration) return;
    __rangeUiPending = false;
    if (monitorDisplayVisible()) {
      const latest = getLastRealtime();
      if (latest) updateRealtimeDisplay(latest);
      if (!state.__rangeDragging) updateChartRange();
      updateChartEmptyState();
    }
    updateDurationDisplay();
    const el = document.getElementById('data-count');
    setTextIfChanged(el, String(state.chartSeries.x.length));
    updateRemainingDisplay();
    lastStatusUiAt = performance.now();
    performanceDiagnostics.domCommit('monitor-ui', startedAt);
  });
}

/** 页面或窗口重新可见时先同步窗口，再交给图表同一帧补绘。 */
export function refreshMonitorDisplay() {
  if (!monitorDisplayVisible()) return;
  // 待执行的旧帧和统计定时器已有这一份完整结果，避免恢复时重复提交。
  __rangeUiGeneration++;
  __rangeUiPending = false;
  displayFrames.cancel('monitor-ui');
  if (statusUiTimer !== null) clearTimeout(statusUiTimer);
  statusUiTimer = null;
  if (__statsUpdateTimer !== null) {
    clearTimeout(__statsUpdateTimer);
    __statsUpdateTimer = null;
  }
  if (!state.__rangeDragging) updateChartRange();
  else updateSliderFill();
  const latest = getLastRealtime();
  if (latest) updateRealtimeDisplay(latest);
  else paintRealtimeEmptyCards();
  updateChartEmptyState();
  updateStatsDisplay();
  updateEnergyDisplay();
  updateDurationDisplay();
  setTextIfChanged(document.getElementById('data-count'), String(state.chartSeries.x.length));
}

/**
 * 节流版 updateStatsDisplay（含能量显示）。
 * 范围统计需要 O(可见点数) 的遍历，流式采样不需要每个点都同步重扫。
 * 250ms 的上限刷新间隔保持 UI 可读性，同时避免长录制时主线程被统计占满。
 */
export function scheduleStatsUpdate() {
  if (ingestBatchDepth > 0) {
    ingestBatchStatsDirty = true;
    return;
  }
  if (!monitorDisplayVisible()) {
    rangeUi.cancelRangeStatsJob();
    return;
  }
  if (!state.settings.statsRange) rangeUi.cancelRangeStatsJob();
  else if (state.__rangeDragging) return;
  if (__statsUpdateTimer !== null) return;
  if (state.settings.statsRange) rangeUi.markStaleRangeStatsPending();
  __statsUpdateTimer = setTimeout(
    () => {
      const startedAt = performance.now();
      __statsUpdateTimer = null;
      if (state.settings.statsRange && state.__rangeDragging) return;
      updateStatsDisplay();
      updateEnergyDisplay();
      performanceDiagnostics.domCommit('stats-ui', startedAt);
    },
    state.settings.statsRange ? Math.max(250, rangeUi.getRangeCalculationMs() * 4) : 250,
  );
}

// ─── Reset functions ─────────────────────────────────────────────────────────

/** 重置统计数据。 */
export function resetStats() {
  state.stats = {
    voltage: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    current: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    power: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    temp: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  };
  updateStatsDisplay();
}

/** 重置能量累计。 */
export function resetEnergy() {
  state.energy = { wh: 0, mah: 0, lastX: null };
  updateEnergyDisplay();
}

/** 清空图表数据和相关状态。 @param {{ replaceStream?: boolean }} [options] */
export function clearChart({ replaceStream = true } = {}) {
  // 先收尾这份记录的临时文件：它引用的是即将换掉的列，写完再关。
  void finalizeSpool();
  rangeUi.cancelRangeStatsJob();
  setRangeStatsPending(false);
  void stopRecording({ discard: true }).catch(() => {});
  setChartColumns(emptyChartColumns());
  if (replaceStream) deviceStream.replace({ pdEnabled: !state.settings.pdFollowRecording });
  rangeUi.resetRangeStatsState();
  state.dataIntervalMs = null;
  state.lastRecordingStartTime = null;
  state.recordingBaseSeconds = 0;
  state.chartWindow = emptyChartWindow();
  rangeUi.writePermille(0, 1000);
  updateSliderFill();
  resetRealtimeCards();
  updateChartEmptyState();
  updateDurationDisplay();

  state.hasTempData = false;
  updateTempUIVisibility();

  setChartXWindow(null, null);
  syncChartSeries();
  updateCharts();

  // 数据清空后按钮从「继续记录」退回「开始记录」
  refreshRecordButton();

  const el = document.getElementById('data-count');
  if (el) el.textContent = '0';
  updateRemainingDisplay();
  document.dispatchEvent?.(new Event('lapower:export-availability-changed'));
}

// ─── Recording control ───────────────────────────────────────────────────────

/** 防止连点在 await PD 门期间重入。 */
let recordingStartLock = false;
let recordingEpoch = 0;

/** 开始录制。原生段由读线程开启；取消令牌防止异步开始在清空/导入后复活。 */
export async function startRecording() {
  if (!state.isConnected) {
    console.warn('Attempted to start recording while not connected');
    return;
  }
  if (state.isRecording || recordingStartLock) return;
  if (state.chartSeries.x.length >= recordLimitPoints()) {
    toast.warning(() => t('limitContinue'));
    return;
  }

  recordingStartLock = true;
  const epoch = ++recordingEpoch;
  const columns = state.chartSeries;
  try {
    if (deviceStream.enabled) {
      await deviceStream.settle();
    } else {
      await invokeCmd('set_pd_capture_enabled', { enabled: true });
    }
    if (epoch !== recordingEpoch || columns !== state.chartSeries || !state.isConnected || state.isRecording) return;

    state.isRecording = true;
    const now = Date.now();
    state.recordingStartTime = now;
    if (state.chartSeries.timestamps.length === 0) {
      state.lastRecordingStartTime = now;
      state.recordingBaseSeconds = 0;
    } else {
      const lastX = state.chartSeries.x.at(-1);
      state.recordingBaseSeconds =
        (Number.isFinite(lastX) ? lastX : 0) + Math.max(state.settings.sampleRate / 1000, 0.001);
      if (state.lastRecordingStartTime === null) state.lastRecordingStartTime = state.chartSeries.timestamps.at(0);
    }
    // 暂停期间不属于下一段能量积分区间。
    state.energy.lastX = null;
    state.autoPauseSettings.triggerStartTime = null;

    // 来源先于临时恢复文件的表头登记：表头里要写明这份数据由哪台仪表采集。
    noteRecordedSource(state.chartSeries, state.connectedDevice);
    spoolRecordingStarted();
    startDurationTicker();
    updateChartEmptyState();

    refreshRecordButton();
    const btnClear = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-clear-chart'));
    if (btnClear) btnClear.disabled = true;

    // 通知 PD 视图等订阅方（可选调用：node 测试的 document stub 没有 dispatchEvent）
    document.dispatchEvent?.(new CustomEvent('witrn:monitor-changed'));
    if (deviceStream.enabled) await deviceStream.begin(state.recordingBaseSeconds);
  } catch (error) {
    console.error('Recording start failed:', error);
    if (epoch === recordingEpoch) void stopRecording({ discard: true }).catch(() => {});
  } finally {
    if (epoch === recordingEpoch) recordingStartLock = false;
  }
}

/** UI state changes synchronously; the returned promise fences the retained tail.
 * @param {{discard?:boolean}} [options]
 */
export function stopRecording({ discard = false } = {}) {
  const requestedAt = performance.now();
  recordingEpoch++;
  recordingStartLock = false;
  const paused = deviceStream.enabled
    ? deviceStream.pause({ discard, pdEnabled: !state.settings.pdFollowRecording })
    : Promise.resolve();
  if (!state.isRecording) return paused;

  state.isRecording = false;
  state.recordingStartTime = null;
  state.energy.lastX = null;
  state.autoPauseSettings.triggerStartTime = null;
  // 排空原生尾点后再同步恢复文件；显示刷新不等待栅栏或磁盘。
  void paused.then(spoolRecordingPaused, spoolRecordingPaused);

  stopDurationTicker();

  refreshRecordButton();
  const btnClear = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-clear-chart'));
  if (btnClear) btnClear.disabled = false;

  state.__setRangeControlsEnabled?.(true);
  // The range UI may still be waiting for rAF while the latest batch is already
  // retained. Capture the pause window from those samples before preparing it.
  if (!state.__rangeDragging) updateChartRange();
  // 暂停时补上最后一帧，密集回看继续遵循当前显示预算。
  updateCharts('maintenance', { force: false, reason: 'pause', requestedAt });

  // 跟随记录关闭时采集门保持开；开启时与本地 isRecording 一起关掉。
  if (!deviceStream.enabled) {
    void invokeCmd('set_pd_capture_enabled', { enabled: !state.settings.pdFollowRecording }).catch(console.error);
  }
  updateStatsDisplay();
  updateEnergyDisplay();

  // 单一咽喉点：手动停止 / 自动暂停 / 拔设备 / CSV 导入引发的停止都会走到这里
  document.dispatchEvent?.(new CustomEvent('witrn:monitor-changed'));
  return paused;
}

/** 清空图表并重置统计和能量。 @param {{ replaceStream?: boolean }} [options] */
export function clearAndResetStats(options) {
  clearChart(options);
  resetStats();
  resetEnergy();
}
