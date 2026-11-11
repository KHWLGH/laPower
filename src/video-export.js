// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * @file 图片与视频报告导出：对话框、冻结快照、进度轮询与错误呈现。
 *
 * 这里只做界面与编排，投影规则在 video-projection.js（纯函数、可单测），后端的职责是
 * "绘制静态报告或按帧编码"。数据在点击生成按钮的那一刻冻结，所以生成期间继续录制不会
 * 改变已经提交的这份报告。
 */

import { runExportSession } from './export-session.js';
import {
  cancelVideoExport,
  currentVideoExport,
  pickVideoExportFile,
  startVideoExport,
  videoExportCapability,
  videoExportStatus,
} from './file-io.js';
import { errorText, onLanguageChange, t } from './i18n.js';
import { markersOf } from './markers.js';
import { provenanceOf } from './provenance.js';
import { debouncedSaveSettings } from './settings.js';
import { state } from './state.js';
import { toast } from './ui/toast.js';
import {
  normalizeVideoExportOptions,
  parseDurationInput,
  VIDEO_CODECS,
  VIDEO_FORMATS,
  VIDEO_FRAME_RATES,
  VIDEO_RESOLUTIONS,
  videoFrameCount,
} from './video-export-options.js';
import { videoPalette } from './video-palette.js';
import { buildVideoPayload, projectVideoAsync } from './video-projection.js';

/** 后端状态轮询间隔：与源项目的 500 ms 一致，够快但不制造 IPC 压力。 */
const POLL_INTERVAL_MS = 500;

/**
 * @typedef {Object} VideoStatus
 * @property {string} id
 * @property {'queued'|'encoding'|'completed'|'cancelled'|'failed'} state
 * @property {number} progress
 * @property {any} options
 * @property {string|null} path
 * @property {string|null} name
 * @property {string|null} encoder 当前实际使用的编码器，编码开始前为 null
 * @property {string|null} fallback 自动模式回退软件编码的原因，仅在仍成功产出文件时出现
 * @property {{code:string, detail:string}|null} error
 */

/** @type {HTMLDialogElement|null} */
let dialog = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let pollTimer = null;
/** 进行中或刚结束的任务；重开对话框时用它接回进度。 */
/** @type {VideoStatus|null} */
let job = null;
/** 每个组合的能力按进程缓存；一次探测就是一次真实试编码，不能每次开对话框都重来。 */
/** @type {Map<string, any>} */
const capabilities = new Map();
/** @type {Map<string, Promise<any>>} */
const capabilityProbes = new Map();
/** 保存对话框与投影期间避免重复提交。 */
let busy = false;
/** @type {{controller:AbortController, projection:Promise<any>|null}|null} */
let preparation = null;

/** Stop CPU preparation before acquisition shutdown; a late picker cannot submit this report. */
export async function cancelReportPreparation() {
  const pending = preparation;
  if (!pending) return;
  pending.controller.abort();
  await pending.projection?.catch(() => {});
}

let adopting = false;
let jobRevision = 0;
let currentQuery = 0;
/** @type {unknown} */
let submissionError = null;
/** @type {unknown} */
let pollError = null;
/** @type {Map<string, unknown>} */
const capabilityErrors = new Map();
/** @type {Set<string>} */
const notifiedJobs = new Set();

/** Local video diagnostics keep the backend's reason even for codes without a detail placeholder.
 * @param {unknown} error */
function videoErrorText(error) {
  const text = errorText(error);
  const detail = /** @type {{detail?:string}|null} */ (error)?.detail;
  return detail && !text.includes(detail) ? `${text}\n${detail}` : text;
}

/** @returns {any} */
const field = (id) => document.getElementById(id);
/** @returns {HTMLSelectElement|null} */
const selectField = (id) => /** @type {HTMLSelectElement|null} */ (document.getElementById(id));

function optionState() {
  return normalizeVideoExportOptions(activeJob() ? job?.options : state.settings.videoExport);
}

/** 组合的缓存键；与 `video_export_capability` 的缓存键一一对应。 */
function capabilityKey(options) {
  return `${options.width}x${options.height}@${options.fps}:${options.codec}:${options.acceleration}:${options.quality}`;
}

/** 已选组合的能力；尚未完成真实探测时不允许提交。 */
function combinationFor(options) {
  if (options.reportType === 'image') return { available: true };
  return capabilities.get(capabilityKey(options)) ?? null;
}

function activeJob() {
  return job && (job.state === 'queued' || job.state === 'encoding');
}

/** 把冻结的列投影成后端能直接渲染的载荷。
 * @param {import('./video-export-options.js').VideoExportOptions} options
 * @param {AbortSignal} signal
 */
export async function captureReport(options, signal) {
  options = { ...options, visibleSeries: [...options.visibleSeries] };
  const columns = state.chartSeries;
  const length = columns.x.length;
  const input = {
    columns: {
      x: columns.x.snapshot(),
      timestamps: columns.timestamps.snapshot(),
      voltage: columns.voltage.snapshot(),
      current: columns.current.snapshot(),
      currentMagnitudes: columns.currentMagnitudes.snapshot(),
      power: columns.power.snapshot(),
      temp: columns.temp.snapshot(),
      recordingSegments: columns.recordingSegments.snapshot(),
      sampleIntervals: columns.sampleIntervals.snapshot(),
    },
    length,
    markers: markersOf(columns).map((marker) => ({ ...marker })),
    intervalMs: state.dataIntervalMs ?? state.settings.sampleRate,
    frameCount: videoFrameCount(options),
    markerLimit:
      !options.showMarkers && !options.showMarkerDetails
        ? 0
        : options.reportType === 'image' && options.imageLayout === 'long'
          ? Number.POSITIVE_INFINITY
          : 8,
    hasTemperature: state.hasTempData,
  };
  const devices = provenanceOf(columns).devices;
  const context = {
    options,
    header: {
      // 记录没有名字，数据来源是它能给出的最有用的抬头。
      title: devices.length ? devices.join(' / ') : 'laPower',
      status: state.isRecording ? t('recording') : t('videoSnapshotComplete'),
      statusKind: state.isRecording ? 'recording' : 'complete',
    },
    labels: {
      eyebrow: 'laPower',
      chart: t('videoChart'),
      breakpoints: t('videoBreakpoints'),
      power: t('power'),
      voltage: t('voltage'),
      current: t('current'),
      temperature: t('temperature'),
      capacity: t('videoCapacity'),
      points: t('videoPoints'),
      noSeries: t('videoNoSeries'),
      missing: t('videoMissing'),
      unitW: 'W',
      unitV: 'V',
      unitA: 'A',
      unitC: '°C',
      unitWh: 'Wh',
      average: t('videoAverage'),
      maximum: t('videoMaximum'),
      range: t('videoRange'),
      energy: t('videoEnergy'),
    },
    palette: videoPalette(options.theme),
  };
  const projection = await projectVideoAsync(input, { signal });
  return buildVideoPayload({ ...context, projection });
}

function refreshForm() {
  const options = optionState();
  const type = selectField('report-type');
  if (type) type.value = options.reportType;
  const layout = selectField('report-image-layout');
  if (layout) layout.value = options.imageLayout;
  for (const [id, checked] of [
    ['report-markers', options.showMarkers],
    ['report-marker-details', options.showMarkerDetails],
  ]) {
    const input = /** @type {HTMLInputElement|null} */ (field(String(id)));
    if (input) input.checked = Boolean(checked);
  }
  const resolution = selectField('video-resolution');
  if (resolution) resolution.value = `${options.width}x${options.height}`;
  const fps = selectField('video-fps');
  if (fps) fps.value = String(options.fps);
  const codec = selectField('video-codec');
  if (codec) codec.value = options.codec;
  for (const name of ['acceleration', 'quality']) {
    const input = selectField(`video-${name}`);
    if (input) input.value = options[name];
  }
  const format = selectField('video-format');
  if (format) format.value = options.format;
  const duration = /** @type {HTMLInputElement|null} */ (field('video-duration'));
  if (duration) duration.value = String(options.durationS);
  const theme = selectField('video-theme');
  if (theme) theme.value = options.theme;
  ['voltage', 'current', 'power', 'temperature'].forEach((name, index) => {
    const input = /** @type {HTMLInputElement|null} */ (field(`video-series-${name}`));
    if (input) input.checked = options.visibleSeries[index] !== false;
  });
}

/** 名称只描述"实际在用的编码器"；未上报时不猜，避免把硬件编码说成软件。 */
function encoderLabel(name) {
  if (name === 'hardware') return t('videoHardwareEncoder');
  if (name === 'software') return t('videoSoftwareEncoder');
  return t('videoEncoderPending');
}

function refreshStatus() {
  const statusEl = document.getElementById('video-status');
  const hintEl = document.getElementById('video-hint');
  const fallbackEl = document.getElementById('video-fallback');
  const durationError = document.getElementById('video-duration-error');
  const errorEl = document.getElementById('video-error');
  const progress = /** @type {HTMLProgressElement|null} */ (document.getElementById('video-progress'));
  const durationInput = /** @type {HTMLInputElement|null} */ (field('video-duration'));
  // 校验读的是输入框里的值：用户刚敲进去的 61 不该等一次 change 才能挡住生成。
  const duration = parseDurationInput(durationInput ? durationInput.value : optionState().durationS);
  const options = optionState();
  const image = options.reportType === 'image';
  for (const el of document.querySelectorAll('[data-report-video]')) /** @type {HTMLElement} */ (el).hidden = image;
  for (const el of document.querySelectorAll('[data-report-image]')) /** @type {HTMLElement} */ (el).hidden = !image;
  const note = field('report-note');
  if (note) note.textContent = t(image ? 'reportImageNote' : 'videoNote');
  const markerHint = field('report-marker-hint');
  const settledMarkers = markersOf(state.chartSeries).filter(
    (marker) => marker.index < state.chartSeries.x.length,
  ).length;
  if (markerHint) {
    markerHint.hidden =
      !!activeJob() ||
      busy ||
      !(options.showMarkers || options.showMarkerDetails) ||
      settledMarkers <= 8 ||
      (image && options.imageLayout === 'long');
    markerHint.textContent = t('reportMarkerLimit', { count: settledMarkers });
  }
  const active = activeJob();
  for (const id of [
    'report-type',
    'report-image-layout',
    'report-markers',
    'report-marker-details',
    'video-resolution',
    'video-fps',
    'video-codec',
    'video-acceleration',
    'video-quality',
    'video-format',
    'video-duration',
    'video-theme',
    'video-series-voltage',
    'video-series-current',
    'video-series-power',
    'video-series-temperature',
  ]) {
    const input = /** @type {HTMLInputElement|null} */ (field(id));
    if (input) input.disabled = active || busy;
  }
  const generate = /** @type {HTMLButtonElement|null} */ (document.getElementById('video-generate'));
  const cancel = /** @type {HTMLButtonElement|null} */ (document.getElementById('video-cancel'));
  const combination = combinationFor(options);
  const unavailable = combination && !combination.available ? combination : null;
  if (generate) {
    generate.disabled = active || busy || adopting || !combination || !!unavailable || (!image && !duration.valid);
    generate.textContent = t(image ? 'reportStartImage' : 'videoStart');
  }
  if (durationInput) durationInput.setAttribute('aria-invalid', String(!image && !duration.valid));
  if (durationError) {
    durationError.hidden = image || duration.valid;
    durationError.textContent = image || duration.valid ? '' : t('videoDurationInvalid');
  }
  if (cancel) cancel.hidden = !active && !preparation;
  if (progress) {
    progress.hidden = !job;
    progress.value = job ? Math.min(1, Math.max(0, job.progress || 0)) : 0;
  }
  if (statusEl) {
    statusEl.textContent = !job
      ? ''
      : job.state === 'completed'
        ? t('videoGenerated')
        : job.state === 'cancelled'
          ? t('videoCancelled')
          : job.state === 'failed'
            ? t('videoGenerationFailed')
            : t('videoGenerating', { percent: Math.round((job.progress || 0) * 100) });
    // 编码中与完成态都要说清楚用的是什么：完成后不写就只剩"已生成"，看起来像回退了软件编码。
    if (job && job.options?.reportType !== 'image' && (active || job.state === 'completed')) {
      statusEl.textContent += ` · ${t('videoAcceleration', { encoder: encoderLabel(job.encoder) })}`;
    }
  }
  if (fallbackEl) {
    fallbackEl.hidden = !job?.fallback;
    fallbackEl.textContent = job?.fallback ? t('videoHardwareFallback', { detail: job.fallback }) : '';
  }
  if (errorEl) {
    const error = submissionError ?? pollError ?? job?.error;
    errorEl.hidden = !error;
    errorEl.textContent = error ? videoErrorText(error) : '';
  }
  if (hintEl) {
    // 只探测当前组合：还没轮到它时就显示"检测中"，而不是拿别的组合的结论凑数。
    if (image) hintEl.textContent = t('reportPngHint');
    else if (active) hintEl.textContent = encoderLabel(job?.encoder);
    else if (!combination) {
      const failure = capabilityErrors.get(capabilityKey(options));
      hintEl.textContent = failure ? videoErrorText(failure) : t('videoCheckingCapabilities');
    } else if (unavailable) {
      hintEl.textContent = t('videoCombinationUnavailable', {
        reason: unavailable.reason || t('videoGenerationFailed'),
      });
    } else {
      hintEl.textContent = `${encoderLabel(combination?.encoder)} · ${t('videoTargetBitrate', {
        mbps: Number((combination.bitrate / 1_000_000).toFixed(1)),
      })}`;
    }
  }
}

function stopPolling() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function schedulePoll() {
  stopPolling();
  if (!activeJob()) return;
  pollTimer = setTimeout(() => void pollOnce(), POLL_INTERVAL_MS);
}

/** Commit one host status and announce each terminal job once. @param {VideoStatus|null} status */
function acceptJob(status) {
  jobRevision++;
  job = status;
  pollError = null;
  if (activeJob()) {
    refreshForm();
    if (dialog?.open) void loadCapability();
  }
  refreshStatus();
  if (status && !activeJob() && !notifiedJobs.has(status.id)) {
    notifiedJobs.add(status.id);
    if (status.state === 'completed') toast.success(() => t('videoExported', { name: status.name ?? '' }));
    else if (status.state === 'failed') {
      toast.error(() =>
        t('videoExportFailed', {
          detail: status.error ? videoErrorText(status.error) : t('videoGenerationFailed'),
        }),
      );
    } else if (status.state === 'cancelled') toast.info(() => t('videoCancelled'));
  }
  schedulePoll();
}

async function pollOnce() {
  if (!activeJob() || !job) return;
  const id = job.id;
  const revision = jobRevision;
  try {
    const status = /** @type {VideoStatus} */ (await videoExportStatus(id));
    if (revision !== jobRevision) return;
    acceptJob(status);
  } catch (error) {
    if (revision !== jobRevision) return;
    if (/** @type {{code?:string}|null} */ (error)?.code === 'videoJobUnknown') {
      await adoptCurrent();
    } else {
      pollError = error;
      refreshStatus();
      schedulePoll();
    }
  }
}

/**
 * 只探测当前选中的组合。
 *
 * 探测要真的编码一帧，24 个组合一次问完既慢又更容易碰到驱动抖动；用户真正要用的只有一个，
 * 换选项时再问下一个。
 */
async function loadCapability() {
  const options = optionState();
  if (options.reportType === 'image') {
    refreshStatus();
    return;
  }
  const key = capabilityKey(options);
  if (capabilities.has(key)) {
    refreshStatus();
    return;
  }
  capabilityErrors.delete(key);
  let probe = capabilityProbes.get(key);
  if (!probe) {
    probe = videoExportCapability(options).then(
      (capability) => {
        capabilities.set(key, capability);
        capabilityProbes.delete(key);
        if (capabilityKey(optionState()) === key) refreshStatus();
        return capability;
      },
      (error) => {
        // Retry on reopening or changing options; never accept an unprobed combination.
        capabilityProbes.delete(key);
        capabilityErrors.set(key, error);
        throw error;
      },
    );
    capabilityProbes.set(key, probe);
  }
  try {
    await probe;
  } catch {
    if (capabilityKey(optionState()) === key) refreshStatus();
  }
}

async function generate() {
  if (busy || adopting || activeJob()) return;
  // readForm() 只在时长合法时写设置，所以越界输入不能从设置里读回来。
  if (
    optionState().reportType === 'video' &&
    !parseDurationInput(/** @type {HTMLInputElement|null} */ (field('video-duration'))?.value).valid
  ) {
    refreshStatus();
    return;
  }
  const options = readForm();
  if (!combinationFor(options)?.available) {
    refreshStatus();
    return;
  }
  jobRevision++;
  currentQuery++;
  stopPolling();
  job = null;
  submissionError = pollError = null;
  busy = true;
  const pending = { controller: new AbortController(), projection: /** @type {Promise<any>|null} */ (null) };
  preparation = pending;
  refreshStatus();
  try {
    const report = await runExportSession(async () => {
      toast.info(() => t('videoProcessing'));
      pending.projection = captureReport(options, pending.controller.signal);
      const payload = await pending.projection;
      if (pending.controller.signal.aborted) return null;
      const picked = await pickVideoExportFile(
        `lapower_report_${new Date().toISOString().replace(/[:.]/g, '-')}.${options.reportType === 'image' ? 'png' : options.format}`,
      );
      if (!picked || pending.controller.signal.aborted) return null;
      return startVideoExport({ ticket: picked.ticket, payload });
    });
    if (!report) return;
    acceptJob(/** @type {VideoStatus} */ (report));
  } catch (error) {
    if (pending.controller.signal.aborted) return;
    submissionError = error;
    toast.error(() => t('videoExportFailed', { detail: videoErrorText(error) }));
  } finally {
    if (preparation === pending) preparation = null;
    busy = false;
    refreshStatus();
  }
}

async function cancel() {
  if (preparation) {
    await cancelReportPreparation();
    refreshStatus();
    return;
  }
  if (!activeJob() || !job) return;
  const id = job.id;
  const revision = ++jobRevision;
  stopPolling();
  try {
    const status = /** @type {VideoStatus} */ (await cancelVideoExport(id));
    if (revision === jobRevision) acceptJob(status);
  } catch (error) {
    if (revision !== jobRevision) return;
    pollError = error;
    refreshStatus();
    toast.error(() => videoErrorText(error));
    schedulePoll();
  }
}

function openDialog() {
  if (!dialog) return;
  // Restore the active job options, or the last valid saved form when idle.
  refreshForm();
  refreshStatus();
  if (!dialog.open) dialog.showModal();
  void loadCapability();
  void adoptCurrent();
}

async function adoptCurrent() {
  if (busy) return;
  const query = ++currentQuery;
  const revision = jobRevision;
  adopting = true;
  refreshStatus();
  try {
    const current = /** @type {VideoStatus|null} */ (await currentVideoExport());
    if (query !== currentQuery || revision !== jobRevision) return;
    acceptJob(current);
  } catch (error) {
    if (query !== currentQuery || revision !== jobRevision) return;
    pollError = error;
    schedulePoll();
  } finally {
    if (query === currentQuery) {
      adopting = false;
      refreshStatus();
    }
  }
}

/**
 * 把表单收成合法选项并保存。
 *
 * 时长越界时保留上次保存的合法值，让「打开对话框 → 手输 61 → 关闭」不会把 61 写进设置；
 * 界面上的 61 由 refreshStatus() 提示。
 */
function readForm() {
  const resolution = selectField('video-resolution');
  const [width, height] = String(resolution?.value ?? '1920x1080')
    .split('x')
    .map(Number);
  const duration = parseDurationInput(/** @type {HTMLInputElement|null} */ (field('video-duration'))?.value);
  const options = normalizeVideoExportOptions({
    ...optionState(),
    reportType: selectField('report-type')?.value,
    imageLayout: selectField('report-image-layout')?.value,
    showMarkers: !!field('report-markers')?.checked,
    showMarkerDetails: !!field('report-marker-details')?.checked,
    width,
    height,
    fps: Number(selectField('video-fps')?.value),
    codec: selectField('video-codec')?.value,
    acceleration: selectField('video-acceleration')?.value,
    quality: selectField('video-quality')?.value,
    format: selectField('video-format')?.value,
    durationS: duration.valid ? duration.value : optionState().durationS,
    theme: selectField('video-theme')?.value,
    visibleSeries: ['voltage', 'current', 'power', 'temperature'].map(
      (name) => !!(/** @type {HTMLInputElement|null} */ (field(`video-series-${name}`))?.checked),
    ),
  });
  state.settings.videoExport = options;
  debouncedSaveSettings();
  return options;
}

/** 填充下拉项。选中值与文案由 HTML 与 i18n 负责，这里只生成选项。 */
function fillSelects() {
  const resolution = selectField('video-resolution');
  if (resolution && !resolution.options.length) {
    for (const item of VIDEO_RESOLUTIONS) {
      const option = document.createElement('option');
      option.value = `${item.width}x${item.height}`;
      option.textContent = `${item.width} × ${item.height}`;
      resolution.append(option);
    }
  }
  const fps = selectField('video-fps');
  if (fps && !fps.options.length) {
    for (const rate of VIDEO_FRAME_RATES) {
      const option = document.createElement('option');
      option.value = String(rate);
      option.textContent = `${rate} fps`;
      fps.append(option);
    }
  }
  const codec = selectField('video-codec');
  if (codec && !codec.options.length) {
    for (const value of VIDEO_CODECS) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value === 'h265' ? 'H.265 (HEVC)' : 'H.264';
      codec.append(option);
    }
  }
  const format = selectField('video-format');
  if (format && !format.options.length) {
    for (const value of VIDEO_FORMATS) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value.toUpperCase();
      format.append(option);
    }
  }
}

/** 启动时调用一次。 */
export function initVideoExportUI() {
  dialog = /** @type {HTMLDialogElement|null} */ (document.getElementById('video-export-dialog'));
  if (!dialog) return;
  fillSelects();
  document.getElementById('btn-export-video')?.addEventListener('click', openDialog);
  document.getElementById('video-generate')?.addEventListener('click', () => void generate());
  document.getElementById('video-cancel')?.addEventListener('click', () => void cancel());
  document.getElementById('video-close')?.addEventListener('click', () => dialog?.close());
  for (const id of [
    'report-type',
    'report-image-layout',
    'report-markers',
    'report-marker-details',
    'video-resolution',
    'video-fps',
    'video-codec',
    'video-format',
    'video-theme',
    'video-acceleration',
    'video-quality',
  ]) {
    field(id)?.addEventListener('change', () => {
      readForm();
      refreshStatus();
      // 组合变了就要问这一组：换 4K60 H.265 之后不能继续用 720p 的结论。
      if (dialog?.open) void loadCapability();
    });
  }
  field('video-duration')?.addEventListener('input', () => {
    readForm();
    refreshStatus();
  });
  for (const name of ['voltage', 'current', 'power', 'temperature']) {
    field(`video-series-${name}`)?.addEventListener('change', () => readForm());
  }
  onLanguageChange(() => {
    if (dialog?.open) refreshStatus();
  });
  refreshForm();
  refreshStatus();
}
