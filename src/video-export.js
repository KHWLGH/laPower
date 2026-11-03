// @ts-check
/**
 * @file 报告视频导出：对话框、冻结快照、进度轮询与错误呈现。
 *
 * 这里只做界面与编排，投影规则在 video-projection.js（纯函数、可单测），后端的职责是
 * "按帧下标画图并编码"。数据在点击「生成视频」的那一刻冻结，所以编码期间继续录制不会
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
import { buildVideoPayload, projectVideo } from './video-projection.js';

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
 * @property {string|null} fallback 零拷贝 GPU 路径被放弃的原因，仅在仍成功产出文件时出现
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

/** @returns {any} */
const field = (id) => document.getElementById(id);
/** @returns {HTMLSelectElement|null} */
const selectField = (id) => /** @type {HTMLSelectElement|null} */ (document.getElementById(id));

function optionState() {
  return normalizeVideoExportOptions(state.settings.videoExport);
}

/** 组合的缓存键；与 `video_export_capability` 的缓存键一一对应。 */
function capabilityKey(options) {
  return `${options.width}x${options.height}@${options.fps}:${options.codec}`;
}

/** 已选的编码组合是否被宿主支持；还没探测过时返回 null，此刻不阻拦生成。 */
function combinationFor(options) {
  return capabilities.get(capabilityKey(options)) ?? null;
}

function activeJob() {
  return job && (job.state === 'queued' || job.state === 'encoding');
}

/** 把冻结的列投影成后端能直接渲染的载荷。 */
function captureReport(options) {
  const columns = state.chartSeries;
  const length = columns.x.length;
  const projection = projectVideo({
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
    markers: markersOf(columns),
    intervalMs: state.dataIntervalMs ?? state.settings.sampleRate,
    frameCount: videoFrameCount(options),
    hasTemperature: state.hasTempData,
  });
  const devices = provenanceOf(columns).devices;
  return buildVideoPayload({
    options,
    projection,
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
    },
    palette: videoPalette(options.theme),
  });
}

function refreshForm() {
  const options = optionState();
  const resolution = selectField('video-resolution');
  if (resolution) resolution.value = `${options.width}x${options.height}`;
  const fps = selectField('video-fps');
  if (fps) fps.value = String(options.fps);
  const codec = selectField('video-codec');
  if (codec) codec.value = options.codec;
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
  const active = activeJob();
  for (const id of [
    'video-resolution',
    'video-fps',
    'video-codec',
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
  if (generate) generate.disabled = active || busy || !!unavailable || !duration.valid;
  if (durationInput) durationInput.setAttribute('aria-invalid', String(!duration.valid));
  if (durationError) {
    durationError.hidden = duration.valid;
    durationError.textContent = duration.valid ? '' : t('videoDurationInvalid');
  }
  if (cancel) cancel.hidden = !active;
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
    if (job && (active || job.state === 'completed')) {
      statusEl.textContent += ` · ${t('videoAcceleration', { encoder: encoderLabel(job.encoder) })}`;
    }
  }
  if (fallbackEl) {
    fallbackEl.hidden = !job?.fallback;
    fallbackEl.textContent = job?.fallback ? t('videoHardwareFallback', { detail: job.fallback }) : '';
  }
  if (errorEl) {
    errorEl.hidden = !job?.error;
    errorEl.textContent = job?.error ? errorText({ code: job.error.code, detail: job.error.detail }) : '';
  }
  if (hintEl) {
    // 只探测当前组合：还没轮到它时就显示"检测中"，而不是拿别的组合的结论凑数。
    if (!combination) hintEl.textContent = t('videoCheckingCapabilities');
    else if (unavailable) {
      hintEl.textContent = t('videoCombinationUnavailable', {
        reason: unavailable.reason || t('videoGenerationFailed'),
      });
    } else {
      hintEl.textContent = encoderLabel(combination?.encoder);
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

async function pollOnce() {
  if (!job) return;
  try {
    const status = /** @type {VideoStatus} */ (await videoExportStatus(job.id));
    const previous = job.state;
    job = status;
    refreshStatus();
    if (status.state === 'completed' && previous !== 'completed') {
      toast.success(() => t('videoExported', { name: status.name ?? '' }));
    } else if (status.state === 'failed' && previous !== 'failed') {
      toast.error(() =>
        t('videoExportFailed', {
          detail: status.error
            ? errorText({ code: status.error.code, detail: status.error.detail })
            : t('videoGenerationFailed'),
        }),
      );
    } else if (status.state === 'cancelled' && previous !== 'cancelled') {
      toast.info(() => t('videoCancelled'));
    }
    if (status.state === 'queued' || status.state === 'encoding') schedulePoll();
    else stopPolling();
  } catch (error) {
    // 任务被后来的导出替换：停止轮询，不把旧 id 当成故障。
    stopPolling();
    job = null;
    refreshStatus();
    void error;
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
  const key = capabilityKey(options);
  if (capabilities.has(key)) {
    refreshStatus();
    return;
  }
  let probe = capabilityProbes.get(key);
  if (!probe) {
    probe = videoExportCapability(options).then(
      (capability) => {
        capabilities.set(key, capability);
        capabilityProbes.delete(key);
        refreshStatus();
        return capability;
      },
      (error) => {
        // 探测失败下次重试；表单在这期间照常可用。
        capabilityProbes.delete(key);
        throw error;
      },
    );
    capabilityProbes.set(key, probe);
  }
  try {
    await probe;
  } catch (error) {
    toast.error(() => errorText(error));
  }
}

async function generate() {
  if (busy || activeJob()) return;
  // readForm() 只在时长合法时写设置，所以越界输入不能从设置里读回来。
  if (!parseDurationInput(/** @type {HTMLInputElement|null} */ (field('video-duration'))?.value).valid) {
    refreshStatus();
    return;
  }
  const options = readForm();
  busy = true;
  refreshStatus();
  try {
    const report = await runExportSession(async () => {
      toast.info(() => t('videoProcessing'));
      const payload = captureReport(options);
      const picked = await pickVideoExportFile(
        `lapower_video_${new Date().toISOString().replace(/[:.]/g, '-')}.${options.format}`,
      );
      if (!picked) return null;
      return startVideoExport({ ticket: picked.ticket, payload });
    });
    if (!report) return;
    job = /** @type {VideoStatus} */ (report);
    refreshStatus();
    schedulePoll();
  } catch (error) {
    toast.error(() =>
      t('videoExportFailed', {
        detail: errorText(error),
      }),
    );
  } finally {
    busy = false;
    refreshStatus();
  }
}

async function cancel() {
  if (!job) return;
  try {
    const previous = job.state;
    job = /** @type {VideoStatus} */ (await cancelVideoExport(job.id));
    refreshStatus();
    // 取消是用户主动点的，不是轮询发现的转移；不给提示就只剩一句静态文字。
    if (previous !== 'cancelled' && job.state === 'cancelled') toast.info(() => t('videoCancelled'));
  } catch (error) {
    toast.error(() => errorText(error));
  }
}

function openDialog() {
  if (!dialog) return;
  // 设置里保存的时长一定是合法的；界面上越界的手输值由 refreshStatus() 提示并挡住生成，
  // 不在打开对话框时悄悄改回默认值。
  refreshForm();
  refreshStatus();
  if (!dialog.open) dialog.showModal();
  void loadCapability();
  void adoptCurrent();
}

async function adoptCurrent() {
  try {
    const current = /** @type {VideoStatus|null} */ (await currentVideoExport());
    if (!current) return;
    job = current;
    refreshStatus();
    if (activeJob()) schedulePoll();
  } catch {
    /* 接回失败不影响新导出 */
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
    width,
    height,
    fps: Number(selectField('video-fps')?.value),
    codec: selectField('video-codec')?.value,
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
  dialog.addEventListener('close', () => stopPolling());
  for (const id of ['video-resolution', 'video-fps', 'video-codec', 'video-format', 'video-theme']) {
    field(id)?.addEventListener('change', () => {
      readForm();
      refreshStatus();
      // 组合变了就要问这一组：换 4K60 H.265 之后不能继续用 720p 的结论。
      if (dialog?.open) void loadCapability();
    });
  }
  field('video-duration')?.addEventListener('change', () => {
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
