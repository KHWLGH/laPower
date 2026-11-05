// @ts-check
/**
 * @file 协议控制工作区（POWER-Z KM003C / KM002C）：PDM 会话、电压触发、PDO 列表与返回日志。
 *
 * 命令一次一条：发出后禁用控件，直到后端返回结果；进度行经 `km003c-trigger-progress`
 * 事件实时追加。PDM 开关状态以后端为准（结果里的 `pdm_open` 与 `km003c-pdm-state`）。
 * 事件监听在 app.js 启动时注册，视图未打开时进度与状态也不会丢。
 */

import { getLastRealtime } from '../data.js';
import { deviceStream } from '../device-stream.js';
import { errorText, t } from '../i18n.js';
import {
  buildTriggerCommand,
  clampPdm,
  cleanHex,
  commandNeedsPdm,
  describePdo,
  detectionCanSelect,
  detectionReason,
  detectionStateLabel,
  detectionSummary,
  detectionVoltages,
  deviceSupportsControl,
  LOG_LIMIT,
  pdoToRequestFields,
  prependOutcome,
  protocolFields,
  triggerTimeoutMs,
} from '../km003c-model.js';
import { debouncedSaveSettings } from '../settings.js';
import { state } from '../state.js';
import { toast } from '../ui/toast.js';

/** @typedef {import('../km003c-model.js').TriggerCommand} TriggerCommand */
/** @typedef {import('../km003c-model.js').TriggerOutcome} TriggerOutcome */
/** @typedef {import('../km003c-model.js').TriggerPdo} TriggerPdo */

let initialized = false;
let busy = false;
let pdmOpen = false;
/** @type {string|null} */
let pendingReqId = null;
/** 当前命令已收到的进度行，最新在后。 */
let progress = '';
let logText = '';
/** @type {(() => string)[]} */
const logEntries = [];
/** @param {() => string} entry */
function addLog(entry) {
  logEntries.unshift(entry);
  while (logEntries.length > 1 && logEntries.map((item) => item()).join('\n\n').length > LOG_LIMIT) logEntries.pop();
}
let requestCounter = 0;
/** @type {TriggerPdo[]} */
let pdos = [];
/** @type {import('../km003c-model.js').DetectionReport|null} */
let detection = null;
let scanning = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let watchdog = null;
/** @type {ReturnType<typeof setInterval>|null} */
let liveTimer = null;

/** @param {string} id */
const el = (id) => document.getElementById(id);

/** @param {string} id */
function input(id) {
  return /** @type {HTMLInputElement|null} */ (el(id));
}

/** @param {string} id */
function select(id) {
  return /** @type {HTMLSelectElement|null} */ (el(id));
}

function stamp() {
  return new Date().toLocaleTimeString(undefined, { hour12: false });
}

/** 当前连接支持协议控制，且流仍然在。 */
function controllable() {
  return state.isConnected && deviceSupportsControl(state.connectedDevice);
}

function viewVisible() {
  return state.settings.activeView === 'trigger' && !document.hidden;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderLog() {
  logText = logEntries
    .map((entry) => entry())
    .join('\n\n')
    .slice(0, LOG_LIMIT);
  const log = /** @type {HTMLTextAreaElement|null} */ (el('km-log'));
  if (!log) return;
  const live = busy && progress ? `${progress}\n\n${logText}`.trim() : logText;
  const text = live || (busy ? t('connecting') : t('noData'));
  if (log.value !== text) log.value = text;
  log.classList.toggle('is-live', busy);
  const title = el('km-log-title');
  if (title) title.textContent = busy ? t('triggerLogInProgress') : t('triggerLogTitle');
}

function renderPdmStatus() {
  const pill = el('km-pdm-status');
  if (!pill) return;
  pill.textContent = pdmOpen ? t('pdmOpen') : t('pdmClosed');
  pill.classList.toggle('is-open', pdmOpen);
}

/** 按连接、PDM、忙碌状态统一启停控件。 */
function renderEnabled() {
  const available = controllable();
  const ready = available && !busy;
  const withPdm = ready && pdmOpen;
  /** @param {string} id @param {boolean} enabled */
  const enable = (id, enabled) => {
    const node = /** @type {HTMLButtonElement|HTMLInputElement|HTMLSelectElement|null} */ (el(id));
    if (node) {
      node.disabled = !enabled;
      node.title = enabled
        ? node.dataset.i18nTitle
          ? t(node.dataset.i18nTitle)
          : ''
        : !available
          ? t('triggerUnsupported')
          : busy
            ? t('triggerBusy')
            : t('triggerNeedPdm');
    }
  };
  for (const id of ['btn-km-pdm-open', 'btn-km-pdm-close', 'btn-km-raw']) enable(id, ready);
  for (const id of [
    'btn-km-pdm-apply',
    'btn-km-read-pdo',
    'btn-km-scan',
    'btn-km-scan-full',
    'btn-km-reset',
    'btn-km-trigger',
    'btn-km-qc3-up',
    'btn-km-qc3-down',
    'btn-km-pd-cmd',
    'btn-km-get-src-cap',
    'btn-km-pd-data',
    'btn-km-ufcs-pdo',
    'btn-km-ufcs-cmd',
  ])
    enable(id, withPdm);
  const cancel = el('btn-km-cancel');
  if (cancel) cancel.hidden = !busy;
  const banner = el('km-banner');
  if (banner) {
    banner.hidden = available && pdmOpen;
    banner.textContent = available
      ? t('triggerNeedPdmBanner')
      : state.isConnected
        ? t('triggerUnsupportedBanner')
        : t('triggerAvailableBanner');
  }
  const list = el('km-pdo-list');
  list?.classList.toggle('is-disabled', !withPdm);
  for (const row of list?.querySelectorAll('button') ?? []) row.disabled = !withPdm;
}

function renderFields() {
  const proto = select('km-proto')?.value ?? 'pd';
  const fields = protocolFields(proto);
  /** @param {string} id @param {boolean} visible */
  const show = (id, visible) => {
    const node = el(id);
    if (node) node.hidden = !visible;
  };
  show('km-field-position', fields.position);
  show('km-field-qc-volt', fields.fixedVolt);
  show('km-field-volt', fields.voltMv);
  show('km-field-cur', fields.curMa);
  show('btn-km-qc3-up', fields.qc3Adjust);
  show('btn-km-qc3-down', fields.qc3Adjust);
  const label = el('km-position-label');
  if (label) label.textContent = fields.positionLabel;
  const volt = select('km-qc-volt');
  if (volt && fields.fixedVolt) {
    const current = volt.value;
    const wanted = fields.voltChoices.join(',');
    if (Array.from(volt.options, (o) => o.value).join(',') !== wanted) {
      volt.replaceChildren(
        ...fields.voltChoices.map((v) => {
          const option = document.createElement('option');
          option.value = v;
          option.textContent = v;
          return option;
        }),
      );
    }
    volt.value = fields.voltChoices.includes(current) ? current : '9V';
  }
}

function renderPdos() {
  const list = el('km-pdo-list');
  if (!list) return;
  if (pdos.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'trigger-empty';
    empty.textContent = t('triggerPdoEmpty');
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...pdos.map((pdo) => {
      const text = describePdo(pdo);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'trigger-pdo-row';
      row.setAttribute('role', 'listitem');
      row.title = pdo.label;
      for (const [cls, value] of [
        ['trigger-pdo-pos', text.position],
        ['trigger-pdo-kind', text.kind],
        ['trigger-pdo-volt', text.voltage],
        ['trigger-pdo-cur', text.current],
      ]) {
        const cell = document.createElement('span');
        cell.className = cls;
        cell.textContent = value;
        row.appendChild(cell);
      }
      row.addEventListener('click', () => fillFromPdo(pdo));
      return row;
    }),
  );
}

function renderDetection() {
  const summary = el('km-detection-summary');
  const box = el('km-detection-results');
  if (!summary || !box) return;
  const diagnostics = el('km-detection-diagnostics');
  if (diagnostics) diagnostics.textContent = '';
  summary.textContent = detection ? detectionSummary(detection) : scanning ? t('scanPhaseStandard') : t('scanEmpty');
  const expanded = new Set(
    [...box.querySelectorAll('details[open]')].map((node) => /** @type {HTMLElement} */ (node).dataset.protocol),
  );
  box.replaceChildren();
  if (!detection) return;
  const report = detection;
  // Keep PD's independently read voltage table together at the end of the matrix.
  const results = [...report.results.filter((r) => r.id !== 'pd'), ...report.results.filter((r) => r.id === 'pd')];
  for (const result of results) {
    const row = document.createElement('div');
    row.className = `trigger-detection-result is-${result.state}${result.id === 'pd' ? ' is-pd' : ''}`;
    row.dataset.protocol = result.id;
    row.classList.toggle('is-checking', !report.completion && report.active === result.id);
    const heading = document.createElement('div');
    heading.className = 'trigger-detection-heading';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'trigger-protocol-select';
    name.textContent = result.label;
    name.disabled = busy || !controllable() || !pdmOpen || !detectionCanSelect(result);
    name.title = t(detectionCanSelect(result) ? 'scanSelectProtocol' : 'scanDetectionOnly');
    name.addEventListener('click', () => {
      if (busy || !controllable() || !pdmOpen) return;
      const proto = select('km-proto');
      if (proto) proto.value = result.id;
      // Never carry a prior high-voltage request into a newly selected protocol.
      const volt = input('km-req-volt');
      if (volt) volt.value = '5000';
      const position = input('km-req-pos');
      if (position) position.value = '1';
      const current = input('km-req-cur');
      if (current) current.value = '3000';
      const fixed = select('km-qc-volt');
      if (fixed) fixed.value = '5V';
      renderFields();
      el('km-trigger-form')?.scrollIntoView({ block: 'nearest' });
    });
    const status = document.createElement('span');
    status.className = 'trigger-detection-state';
    status.textContent =
      !report.completion && report.active === result.id ? t('scanChecking') : detectionStateLabel(result);
    heading.append(name, status);
    const voltage = document.createElement('div');
    voltage.className = 'trigger-detection-voltages';
    voltage.setAttribute('aria-label', t('scanVoltages'));
    const values = detectionVoltages(result);
    if (values.length) {
      for (const value of values) {
        const chip = document.createElement('span');
        chip.className = 'trigger-voltage-chip';
        chip.textContent = value;
        voltage.append(chip);
      }
    } else {
      voltage.classList.add('is-empty');
      voltage.textContent = t(result.state === 'supported' ? 'scanVoltageUnknown' : 'scanVoltageUnavailable');
    }
    row.append(heading, voltage);
    const evidenceText = [detectionReason(result.reason), result.detail].filter(Boolean).join('\n');
    if (evidenceText) {
      const detail = document.createElement('details');
      detail.className = 'trigger-detection-detail';
      detail.dataset.protocol = result.id;
      detail.open = expanded.has(result.id);
      const source = document.createElement('summary');
      source.textContent = t(
        result.source === 'probe'
          ? result.id === 'pd'
            ? 'scanSourcePdo'
            : 'scanSourceProbe'
          : result.source === 'scan'
            ? 'scanSourceDevice'
            : 'scanSourceNone',
      );
      const evidence = document.createElement('div');
      evidence.textContent = evidenceText;
      detail.append(source, evidence);
      row.append(detail);
    }
    box.append(row);
  }
  if (diagnostics) {
    diagnostics.textContent = [report.pdm_version ? `PDM ${report.pdm_version}` : '', ...report.diagnostics]
      .filter(Boolean)
      .join('\n');
  }
}

function renderLive() {
  const data = getLastRealtime();
  /** @param {string} id @param {unknown} value */
  const set = (id, value) => {
    const node = el(id);
    const text = typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '--';
    if (node && node.textContent !== text) node.textContent = text;
  };
  set('km-live-voltage', data?.voltage);
  set('km-live-current', data?.current);
  set('km-live-power', data?.power);
}

function renderAll() {
  renderPdmStatus();
  renderEnabled();
  renderLog();
  renderDetection();
}

// ─── Commands ────────────────────────────────────────────────────────────────

/** @param {TriggerPdo} pdo */
function fillFromPdo(pdo) {
  if (!controllable() || busy || !pdmOpen) return;
  const fields = pdoToRequestFields(pdo, currentForm());
  const proto = select('km-proto');
  if (proto) proto.value = fields.proto;
  const pos = input('km-req-pos');
  const volt = input('km-req-volt');
  const cur = input('km-req-cur');
  if (pos) pos.value = String(fields.position);
  if (volt) volt.value = String(fields.voltMv);
  if (cur) cur.value = String(fields.curMa);
  renderFields();
}

function currentForm() {
  return {
    position: Number(input('km-req-pos')?.value),
    voltMv: Number(input('km-req-volt')?.value),
    curMa: Number(input('km-req-cur')?.value),
    volt: select('km-qc-volt')?.value ?? '',
  };
}

function currentPdm() {
  return clampPdm({
    pdType: Number(select('km-pdm-type')?.value),
    em: Number(select('km-pdm-em')?.value),
    sink: Number(select('km-pdm-sink')?.value),
  });
}

function finish() {
  busy = false;
  scanning = false;
  pendingReqId = null;
  progress = '';
  if (watchdog !== null) {
    clearTimeout(watchdog);
    watchdog = null;
  }
  renderAll();
}

/** @param {TriggerOutcome} outcome */
function applyOutcome(outcome) {
  const time = stamp();
  const finalProgress = progress;
  addLog(() =>
    prependOutcome(
      '',
      { ...outcome, message: outcome.description ? errorText(outcome.description) : outcome.message },
      finalProgress,
      time,
    ),
  );
  pdmOpen = outcome.pdm_open;
  if (outcome.detection) detection = outcome.detection;
  if (outcome.pdos.length) {
    pdos = outcome.pdos;
    renderPdos();
  }
}

/**
 * 发出一条命令并等待结果。进行中的命令会禁用全部控件；后端拒绝并发，这里只是界面兜底。
 * @param {TriggerCommand} cmd
 */
async function run(cmd) {
  if (busy || !controllable()) return;
  if (commandNeedsPdm(cmd) && !pdmOpen) {
    toast.warning(() => t('triggerNeedPdmWarning'));
    return;
  }
  const reqId = `km-${Date.now()}-${++requestCounter}`;
  const generation = deviceStream.generation;
  busy = true;
  scanning = cmd.type === 'list';
  if (scanning) {
    detection = null;
    pdos = [];
    renderPdos();
  }
  if (['pd_pdo', 'pdm_set', 'pdm_close', 'pdm_open', 'raw'].includes(cmd.type)) {
    pdos = [];
    renderPdos();
    if (cmd.type !== 'pd_pdo') detection = null;
  }
  pendingReqId = reqId;
  progress = '';
  renderAll();
  // 后端每条命令都有串口超时；这里只防后端事件丢失导致界面永远卡在进行中。
  watchdog = setTimeout(() => {
    if (pendingReqId !== reqId) return;
    const time = stamp();
    addLog(() => `[${time}] ERR\n${t('triggerTimeout')}`);
    // Request cancellation but keep the command slot occupied until the backend returns.
    // Late progress must not unlock another hardware command or overwrite a newer scan.
    void cancel();
    renderLog();
  }, triggerTimeoutMs(cmd));
  try {
    const outcome = /** @type {TriggerOutcome} */ (
      await window.__TAURI__.core.invoke('km003c_trigger', { generation, reqId, cmd })
    );
    if (pendingReqId !== reqId) return;
    applyOutcome(outcome);
    if (scanning && !outcome.detection && detection) detection.completion = outcome.ok ? 'partial' : 'failed';
  } catch (error) {
    if (pendingReqId !== reqId) return;
    const time = stamp();
    addLog(() => `[${time}] ERR\n${errorText(error)}`);
    if (scanning && detection) detection.completion = 'failed';
  }
  finish();
}

function triggerFromForm() {
  const proto = select('km-proto')?.value ?? 'pd';
  const form = currentForm();
  const built = buildTriggerCommand(proto, form);
  if ('error' in built) {
    toast.warning(() => {
      const result = buildTriggerCommand(proto, form);
      return 'error' in result ? result.error : '';
    });
    return;
  }
  void run(built.cmd);
}

async function cancel() {
  if (!busy) return;
  try {
    await window.__TAURI__.core.invoke('km003c_cancel_trigger', { generation: deviceStream.generation });
  } catch (error) {
    console.error('取消协议命令失败:', error);
  }
}

async function copyLog() {
  const log = /** @type {HTMLTextAreaElement|null} */ (el('km-log'));
  if (!log || !log.value) return;
  try {
    await navigator.clipboard.writeText(log.value);
    toast.success(() => t('triggerCopied'));
  } catch {
    log.focus();
    log.select();
    toast.info(() => t('triggerSelected'));
  }
}

// ─── Events from the backend ─────────────────────────────────────────────────

/**
 * 后端逐行转发的回复。只接受当前连接、当前命令的进度。
 * @param {unknown} payload
 */
export function handleTriggerProgress(payload) {
  const p = /** @type {{ generation?: number, req_id?: string, text?: string,
   * detection?: import('../km003c-model.js').DetectionReport }} */ (payload ?? {});
  if (p.generation !== deviceStream.generation || p.req_id !== pendingReqId) return;
  if (scanning && p.detection) {
    detection = p.detection;
    if (initialized) renderDetection();
  }
  if (p.text) progress = `${progress}\n${p.text}`.trim().slice(-16_000);
  if (initialized) renderLog();
}

/**
 * Bulk 重连后后端丢弃了 CDC：PDM 需要重新打开。
 * @param {unknown} payload
 */
export function handlePdmState(payload) {
  const p = /** @type {{ generation?: number, open?: boolean, message?: string, description?: unknown }} */ (
    payload ?? {}
  );
  if (p.generation !== deviceStream.generation) return;
  pdmOpen = p.open === true;
  if (!pdmOpen) {
    detection = null;
    pdos = [];
    if (initialized) renderPdos();
  }
  if (p.description || p.message) {
    const time = stamp();
    addLog(() => `[${time}] ${errorText(p.description ?? p.message)}`);
  }
  if (initialized) renderAll();
}

/** 连接状态变化（断开、换设备）：丢弃本地会话状态，后端会话已随流结束。 */
export function syncTriggerConnection() {
  if (!controllable()) {
    pdmOpen = false;
    if (busy) finish();
    pdos = [];
    detection = null;
    if (initialized) {
      renderPdos();
    }
  }
  if (initialized) renderAll();
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function initTriggerView() {
  if (initialized) return;
  initialized = true;

  /** @param {string} id @param {() => void} handler */
  const click = (id, handler) => el(id)?.addEventListener('click', handler);

  click('btn-km-pdm-open', () => void run({ type: 'pdm_open' }));
  click('btn-km-pdm-close', () => void run({ type: 'pdm_close' }));
  click('btn-km-pdm-apply', () => {
    const pdm = currentPdm();
    void run({ type: 'pdm_set', pd_type: pdm.pdType, em: pdm.em, sink: pdm.sink });
  });
  for (const id of ['km-pdm-type', 'km-pdm-em', 'km-pdm-sink']) {
    el(id)?.addEventListener('change', () => {
      state.settings.km003cPdm = currentPdm();
      debouncedSaveSettings();
    });
  }

  click('btn-km-read-pdo', () => void run({ type: 'pd_pdo' }));
  click('btn-km-scan', () => void run({ type: 'list', plus: false }));
  click('btn-km-scan-full', () => void run({ type: 'list', plus: true }));
  click('btn-km-reset', () => void run({ type: 'reset' }));
  click('btn-km-trigger', triggerFromForm);
  click('btn-km-qc3-up', () => void run({ type: 'qc3_adjust', steps: 1 }));
  click('btn-km-qc3-down', () => void run({ type: 'qc3_adjust', steps: -1 }));
  el('km-proto')?.addEventListener('change', renderFields);

  click('btn-km-pd-cmd', () => {
    const cmd = Number(input('km-pd-cmd')?.value);
    if (!Number.isInteger(cmd) || cmd < 0 || cmd > 255) {
      toast.warning(() => t('triggerPdCmdRange'));
      return;
    }
    void run({ type: 'pd_cmd', cmd });
  });
  click('btn-km-get-src-cap', () => void run({ type: 'pd_cmd', cmd: 7 }));
  click('btn-km-pd-data', () => {
    const hex = cleanHex(input('km-pd-data')?.value ?? '');
    if (!hex) {
      toast.warning(() => t('triggerPdDataHex'));
      return;
    }
    void run({ type: 'pd_data', hex });
  });
  click('btn-km-ufcs-pdo', () => {
    const req = Number(input('km-req-pos')?.value) || 1;
    void run({ type: 'ufcs', req, volt_mv: null, cur_ma: null });
  });
  click('btn-km-ufcs-cmd', () => {
    const cmd = Number(input('km-ufcs-cmd')?.value);
    if (!Number.isInteger(cmd) || cmd < 0) {
      toast.warning(() => t('triggerUfcsCmdNonnegative'));
      return;
    }
    void run({ type: 'ufcs_cmd', cmd });
  });
  click('btn-km-raw', () => {
    const command = (input('km-raw-cmd')?.value ?? '').trim();
    if (!command) return;
    void run({ type: 'raw', command });
  });

  click('btn-km-cancel', () => void cancel());
  click('btn-km-log-copy', () => void copyLog());
  click('btn-km-log-clear', () => {
    logText = '';
    logEntries.length = 0;
    renderLog();
  });

  renderFields();
  renderPdos();
  renderAll();
}

/** 视图显示：补齐状态并开始刷新读数条。 */
export function syncTriggerView() {
  renderAll();
  renderLive();
  if (liveTimer === null) {
    liveTimer = setInterval(() => {
      if (!viewVisible()) {
        if (liveTimer !== null) clearInterval(liveTimer);
        liveTimer = null;
        return;
      }
      renderLive();
    }, 250);
  }
}
