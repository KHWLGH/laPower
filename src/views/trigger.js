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
import { errorText, onLanguageChange, t } from '../i18n.js';
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
  exportTriggerHistory,
  filterTriggerHistory,
  outcomeHistoryStatus,
  pdoToRequestFields,
  pdVersionLabel,
  protocolFields,
  reconcileTriggerTranscript,
  selectedFixedPdo,
  summarizeTriggerCommand,
  triggerTimeoutMs,
  trimTriggerHistory,
  validatePdData,
} from '../km003c-model.js';
import { debouncedSaveSettings } from '../settings.js';
import { state } from '../state.js';
import { toast } from '../ui/toast.js';

/** @typedef {import('../km003c-model.js').TriggerCommand} TriggerCommand */
/** @typedef {import('../km003c-model.js').TriggerOutcome} TriggerOutcome */
/** @typedef {import('../km003c-model.js').TriggerPdo} TriggerPdo */
/** @typedef {import('../km003c-model.js').TriggerHistoryStatus} TriggerHistoryStatus */

let initialized = false;
let busy = false;
let pdmOpen = false;
/** @type {import('../km003c-model.js').TriggerContext} */
let triggerContext = {};
/** @type {string|null} */
let pendingReqId = null;
/** @type {import('../km003c-model.js').TriggerHistoryEntry[]} */
let historyEntries = [];
/** @type {Map<string, ReturnType<typeof createHistoryItem>>} */
const historyNodes = new Map();
let activeHistoryId = null;
let cancelRequested = false;
let timedOut = false;
/** @type {'detection'|'trigger'} */
let triggerMode = 'trigger';
let requestCounter = 0;
/** @type {TriggerPdo[]} */
let pdos = [];
/** @type {import('../km003c-model.js').DetectionReport|null} */
let detection = null;
/** @type {string|null} */
let detectionHistoryId = null;
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

/** 当前连接支持协议控制，且流仍然在。 */
function controllable() {
  return state.isConnected && deviceSupportsControl(state.connectedDevice);
}

function viewVisible() {
  return state.settings.activeView === 'trigger' && !document.hidden;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** @param {TriggerHistoryStatus} status */
function historyStatusKey(status) {
  return {
    running: 'triggerHistoryRunning',
    success: 'triggerHistorySuccess',
    partial: 'triggerHistoryPartial',
    failure: 'triggerHistoryFailure',
    cancelled: 'triggerHistoryCancelled',
  }[status];
}

/** @param {import('../km003c-model.js').TriggerHistoryEntry} entry */
function createHistoryItem(entry) {
  const item = document.createElement('details');
  item.dataset.historyId = entry.id;
  item.open = entry.status === 'running' || entry.id === activeHistoryId;
  const summary = document.createElement('summary');
  const time = document.createElement('span');
  time.className = 'trigger-history-meta';
  const status = document.createElement('span');
  status.className = 'trigger-history-result';
  const command = document.createElement('span');
  command.className = 'trigger-history-command';
  const duration = document.createElement('span');
  duration.className = 'trigger-history-meta';
  summary.append(time, status, command, duration);
  const body = document.createElement('div');
  body.className = 'trigger-history-body';
  const actions = document.createElement('div');
  actions.className = 'trigger-history-actions';
  const copyCommand = document.createElement('button');
  copyCommand.type = 'button';
  copyCommand.className = 'cmd-btn';
  copyCommand.addEventListener('click', () => void copyText(summarizeTriggerCommand(entry.command)));
  const fill = document.createElement('button');
  fill.type = 'button';
  fill.className = 'cmd-btn';
  fill.addEventListener('click', () => fillFromHistory(entry.command));
  actions.append(copyCommand, fill);
  const notice = document.createElement('div');
  notice.className = 'trigger-history-truncated';
  const progress = document.createElement('pre');
  progress.className = 'trigger-history-progress';
  const reply = document.createElement('pre');
  body.append(actions, notice, progress, reply);
  item.append(summary, body);
  return { item, time, status, command, duration, copyCommand, fill, notice, progress, reply };
}

/** Avoid replacing text nodes (and their selections/scroll) for unchanged fields.
 * @param {HTMLElement} node @param {string} text */
function setHistoryText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function renderHistory() {
  const list = el('km-history-list');
  const empty = el('km-history-empty');
  const commandFilter = select('km-log-command-filter');
  const statusFilter = select('km-log-status-filter');
  if (!list || !empty || !commandFilter || !statusFilter) return;
  historyEntries = trimTriggerHistory(historyEntries);
  const scrollTop = list.scrollTop;
  const ids = new Set(historyEntries.map((entry) => entry.id));
  for (const [id, nodes] of historyNodes) {
    if (!ids.has(id)) {
      nodes.item.remove();
      historyNodes.delete(id);
    }
  }

  const selectedCommand = commandFilter.value;
  const commandTypes = [...new Set(historyEntries.map((entry) => entry.command.type))].sort();
  const options = [['', t('triggerHistoryCommandFilter')], ...commandTypes.map((type) => [type, type])];
  if (
    commandFilter.options.length !== options.length ||
    options.some(
      ([value, label], i) => commandFilter.options[i]?.value !== value || commandFilter.options[i]?.text !== label,
    )
  ) {
    commandFilter.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
    commandFilter.value = commandTypes.includes(selectedCommand) ? selectedCommand : '';
  }

  const matches = filterTriggerHistory(historyEntries, {
    command: commandFilter.value,
    status: statusFilter.value,
    text: input('km-log-text-filter')?.value ?? '',
  });
  const visibleIds = new Set(matches.map((entry) => entry.id));
  for (const [id, nodes] of historyNodes) {
    if (!visibleIds.has(id)) nodes.item.remove();
  }
  matches.forEach((entry, index) => {
    let nodes = historyNodes.get(entry.id);
    if (!nodes) {
      nodes = createHistoryItem(entry);
      historyNodes.set(entry.id, nodes);
    }
    nodes.item.className = `trigger-history-item is-${entry.status}`;
    setHistoryText(nodes.time, new Date(entry.startedAt).toLocaleTimeString(undefined, { hour12: false }));
    setHistoryText(nodes.status, t(historyStatusKey(entry.status)));
    setHistoryText(nodes.command, summarizeTriggerCommand(entry.command));
    setHistoryText(nodes.duration, entry.elapsedMs === null ? '' : `${entry.elapsedMs} ms`);
    setHistoryText(nodes.copyCommand, t('triggerHistoryCopyCommand'));
    nodes.copyCommand.title = t('triggerHistoryCopyCommand');
    setHistoryText(nodes.fill, t('triggerHistoryFillForm'));
    nodes.fill.title = t('triggerHistoryFillForm');
    nodes.fill.disabled = busy || !historyCommandCanFill(entry.command);
    nodes.notice.hidden = !entry.truncated;
    setHistoryText(nodes.notice, entry.truncated ? t('triggerHistoryTruncated') : '');
    nodes.progress.hidden = !entry.progress;
    setHistoryText(nodes.progress, entry.progress ? `${t('triggerHistoryProgress')}:\n${entry.progress}` : '');
    nodes.reply.className = `trigger-history-reply${entry.status === 'failure' ? ' is-error' : ''}`;
    setHistoryText(
      nodes.reply,
      entry.reply ? `${t('triggerHistoryReply')}:\n${entry.reply}` : t('triggerHistoryNoReply'),
    );
    if (list.children[index] !== nodes.item) list.insertBefore(nodes.item, list.children[index] ?? null);
  });
  list.scrollTop = scrollTop;
  empty.hidden = matches.length > 0;
  empty.textContent = historyEntries.length ? t('triggerHistoryNoMatch') : t('triggerHistoryEmpty');
}

function renderLog() {
  const pane = el('km-log-pane');
  const activity = el('km-log-activity');
  const stateLabel = el('km-log-state');
  const copy = /** @type {HTMLButtonElement|null} */ (el('btn-km-log-copy'));
  const exportButton = /** @type {HTMLButtonElement|null} */ (el('btn-km-log-export'));
  const clear = /** @type {HTMLButtonElement|null} */ (el('btn-km-log-clear'));
  if (!pane) return;
  pane.hidden = false;
  if (activity) {
    activity.hidden = !busy;
    activity.classList.toggle('is-running', busy);
    activity.setAttribute('aria-label', busy ? t('triggerHistoryRunning') : '');
  }
  if (stateLabel) {
    stateLabel.textContent = busy
      ? t('triggerHistoryRunning')
      : t('triggerHistoryCount', { count: historyEntries.length });
    stateLabel.classList.toggle('is-running', busy);
  }
  if (copy) copy.disabled = historyEntries.length === 0;
  if (exportButton) exportButton.disabled = historyEntries.length === 0;
  if (clear) clear.disabled = historyEntries.length === 0 || busy;
  renderHistory();
}

function renderPdmStatus() {
  const pill = el('km-pdm-status');
  if (!pill) return;
  pill.textContent = pdmOpen ? t('pdmOpen') : t('pdmClosed');
  pill.classList.toggle('is-open', pdmOpen);
  const status = el('km-pdm-config-status');
  const applied = triggerContext.applied_pdm;
  const selected = currentPdm();
  if (status) {
    const matching =
      applied && applied.pd_type === selected.pdType && applied.em === selected.em && applied.sink === selected.sink;
    status.textContent = [
      pdmOpen ? t(applied ? (matching ? 'triggerConfigApplied' : 'triggerConfigPending') : 'triggerConfigUnknown') : '',
      applied && pdmOpen ? `type=${applied.pd_type}, em=${applied.em}, sink=${applied.sink}` : '',
      controllable() ? `${t('triggerFirmware')} ${triggerContext.firmware_version ?? t('unknown')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
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
  if (cancel) {
    cancel.hidden = !busy;
    /** @type {HTMLButtonElement} */ (cancel).disabled = !busy;
  }
  for (const id of ['km-pdm-type', 'km-pdm-em', 'km-pdm-sink']) {
    const node = select(id);
    if (node) node.disabled = busy;
  }
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
  const voltage = input('km-req-volt');
  const fixed = selectedFixedPdo(proto, currentForm().position, pdos);
  if (voltage) {
    voltage.readOnly = !!fixed;
    if (fixed) voltage.value = String(fixed.volt_max_mv);
    const known = pdos.some((pdo) => (pdo.protocol ?? 'pd') === 'pd' && pdo.position === currentForm().position);
    voltage.title =
      proto === 'pd'
        ? t(fixed ? 'triggerFixedVoltage' : known ? 'triggerProgrammableVoltage' : 'triggerUnknownVoltage')
        : '';
  }
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
  const diagnosticsDetails = el('km-detection-diagnostics-details');
  const scanEntry = historyEntries.find((entry) => entry.id === detectionHistoryId);
  summary.textContent = detection
    ? detectionSummary(detection)
    : scanning
      ? t('scanPhaseStandard')
      : scanEntry
        ? t(historyStatusKey(scanEntry.status))
        : '';
  summary.hidden = !summary.textContent;
  const expanded = new Set(
    [...box.querySelectorAll('.trigger-detection-detail:not([hidden])')].map(
      (node) => /** @type {HTMLElement} */ (node).dataset.protocol,
    ),
  );
  box.replaceChildren();
  if (!detection) {
    if (diagnostics) diagnostics.textContent = '';
    if (diagnosticsDetails) diagnosticsDetails.hidden = true;
    return;
  }
  const report = detection;
  /** @param {string} id */
  const groupId = (id) => (id === 'pd' ? 'pd' : ['qc', 'qc3', 'bc', 'apple'].includes(id) ? 'standard' : 'vendor');
  const groups = [
    ['pd', 'triggerGroupPd'],
    ['standard', 'triggerGroupStandard'],
    ['vendor', 'triggerGroupVendor'],
  ];
  for (const [id, labelKey] of groups) {
    const groupResults = report.results.filter((result) => groupId(result.id) === id);
    if (!groupResults.length) continue;
    const group = document.createElement('section');
    group.className = `trigger-detection-group is-${id}`;
    const groupHeading = document.createElement('h3');
    groupHeading.textContent = t(labelKey);
    group.appendChild(groupHeading);
    for (const result of groupResults) {
      const row = document.createElement('div');
      row.className = `trigger-detection-result is-${result.state}`;
      row.dataset.protocol = result.id;
      row.classList.toggle('is-pd', result.id === 'pd');
      row.classList.toggle('is-checking', !report.completion && report.active === result.id);
      const heading = document.createElement('div');
      heading.className = 'trigger-detection-heading';
      const name = document.createElement('span');
      name.className = 'trigger-protocol-name';
      name.textContent = result.label;
      const status = document.createElement('span');
      status.className = 'trigger-detection-state';
      status.textContent =
        !report.completion && report.active === result.id ? t('scanChecking') : detectionStateLabel(result);
      heading.append(name, status);
      row.appendChild(heading);
      const values = detectionVoltages(result);
      if (values.length || result.state === 'supported') {
        const voltage = document.createElement('div');
        voltage.className = 'trigger-detection-voltages';
        voltage.setAttribute('aria-label', t('scanVoltages'));
        for (const value of values) {
          const chip = document.createElement('span');
          chip.className = 'trigger-voltage-chip';
          chip.textContent = value;
          voltage.append(chip);
        }
        if (!values.length) {
          voltage.classList.add('is-empty');
          voltage.textContent = t('scanVoltageUnknown');
        }
        row.appendChild(voltage);
      }
      if (
        result.id === 'pd' &&
        (result.pd_revision || result.pd_reported_version || result.pd_version_inference || report.completion)
      ) {
        const version = document.createElement('div');
        version.className = 'trigger-detection-version';
        version.textContent = pdVersionLabel(result);
        row.appendChild(version);
      }
      const actions = document.createElement('div');
      actions.className = 'trigger-detection-actions';
      const reason = detectionReason(result.reason);
      if (reason || result.detail) {
        const detail = document.createElement('div');
        detail.className = 'trigger-detection-detail';
        detail.dataset.protocol = result.id;
        detail.id = `km-detection-evidence-${result.id}`;
        detail.hidden = !expanded.has(result.id);
        const source = t(
          result.source === 'probe'
            ? result.id === 'pd'
              ? 'scanSourcePdo'
              : 'scanSourceProbe'
            : result.source === 'scan'
              ? 'scanSourceDevice'
              : 'scanSourceNone',
        );
        detail.textContent = [source, reason, result.detail].filter(Boolean).join('\n');
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'cmd-btn trigger-evidence-toggle';
        toggle.textContent = t('scanEvidence');
        toggle.setAttribute('aria-controls', detail.id);
        toggle.setAttribute('aria-expanded', String(!detail.hidden));
        toggle.addEventListener('click', () => {
          detail.hidden = !detail.hidden;
          toggle.setAttribute('aria-expanded', String(!detail.hidden));
        });
        actions.appendChild(toggle);
        row.appendChild(detail);
      }
      if (detectionCanSelect(result)) {
        const use = document.createElement('button');
        use.type = 'button';
        use.className = 'cmd-btn trigger-use-protocol';
        use.textContent = t('triggerUseProtocol');
        use.disabled = busy;
        use.title = t('scanSelectProtocol');
        use.addEventListener('click', () => fillDetectedProtocol(result));
        actions.appendChild(use);
      }
      if (actions.childElementCount) row.insertBefore(actions, row.querySelector('.trigger-detection-detail'));
      group.appendChild(row);
    }
    box.appendChild(group);
  }
  if (diagnostics) {
    diagnostics.textContent = [
      `${t('triggerFirmware')} ${report.context?.firmware_version ?? t('unknown')}`,
      report.context?.firmware_diagnostic ?? '',
      report.pdm_version ? `PDM ${report.pdm_version}` : '',
      report.context?.applied_pdm ? JSON.stringify(report.context.applied_pdm) : t('triggerConfigUnknown'),
      report.reset_verification ? verificationText(report.reset_verification) : '',
      ...report.diagnostics,
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (diagnosticsDetails) diagnosticsDetails.hidden = !diagnostics?.textContent;
}

/** @param {'detection'|'trigger'} mode */
function setTriggerMode(mode) {
  triggerMode = mode === 'detection' ? 'detection' : 'trigger';
  const modes = [
    ['detection', 'btn-km-mode-detection', 'km-detection-panel'],
    ['trigger', 'btn-km-mode-trigger', 'km-trigger-panel'],
  ];
  for (const [id, buttonId, panelId] of modes) {
    const button = /** @type {HTMLButtonElement|null} */ (el(buttonId));
    const panel = el(panelId);
    const active = id === triggerMode;
    if (button) {
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    }
    if (panel) panel.hidden = !active;
  }
}

/** @param {string} proto @param {{ position?: number, voltMv?: number, curMa?: number, volt?: string }} values */
function setRequestForm(proto, values = {}) {
  const protocol = select('km-proto');
  if (!protocol || !Array.from(protocol.options, (option) => option.value).includes(proto)) return;
  protocol.value = proto;
  const position = input('km-req-pos');
  const voltage = input('km-req-volt');
  const current = input('km-req-cur');
  const fixedVoltage = select('km-qc-volt');
  if (position && values.position !== undefined) position.value = String(values.position);
  if (voltage && values.voltMv !== undefined) voltage.value = String(values.voltMv);
  if (current && values.curMa !== undefined) current.value = String(values.curMa);
  if (fixedVoltage && values.volt !== undefined) fixedVoltage.value = values.volt;
  renderFields();
  setTriggerMode('trigger');
}

/** The operation only prepares the request. The user must press Trigger to send it. */
function fillDetectedProtocol(result) {
  if (busy || !detectionCanSelect(result)) return;
  setRequestForm(result.id, { position: 1, voltMv: 5000, curMa: 3000, volt: '5V' });
}

/** @param {TriggerCommand} command */
function historyCommandCanFill(command) {
  return [
    'pdm_set',
    'pd_req',
    'qc',
    'qc3',
    'fcp',
    'afc',
    'sfcp',
    'scp',
    'vfcp',
    'ufcs',
    'entry',
    'pd_cmd',
    'pd_data',
    'ufcs_cmd',
    'raw',
  ].includes(command.type);
}

/** @param {TriggerCommand} command */
function fillFromHistory(command) {
  if (busy) return;
  const openAdvanced = () => {
    const advanced = document.querySelector('details.trigger-advanced');
    if (advanced instanceof HTMLDetailsElement) advanced.open = true;
  };
  switch (command.type) {
    case 'pdm_set': {
      const values = clampPdm({ pdType: command.pd_type, em: command.em, sink: command.sink });
      const pdType = select('km-pdm-type');
      const em = select('km-pdm-em');
      const sink = select('km-pdm-sink');
      if (pdType) pdType.value = String(values.pdType);
      if (em) em.value = String(values.em);
      if (sink) sink.value = String(values.sink);
      state.settings.km003cPdm = values;
      debouncedSaveSettings();
      renderPdmStatus();
      break;
    }
    case 'pd_req':
      setRequestForm('pd', {
        position: Number(command.position),
        voltMv: Number(command.volt_mv),
        curMa: Number(command.cur_ma),
      });
      break;
    case 'qc':
      setRequestForm('qc', { volt: String(command.voltage) });
      break;
    case 'qc3':
      setRequestForm('qc3', { voltMv: Number(command.volt_mv) });
      break;
    case 'fcp':
    case 'afc':
    case 'sfcp':
      setRequestForm(command.type, { volt: String(command.voltage) });
      break;
    case 'scp':
    case 'vfcp':
      setRequestForm(command.type, { voltMv: Number(command.volt_mv), curMa: Number(command.cur_ma) });
      break;
    case 'ufcs':
      setRequestForm('ufcs', {
        position: Number(command.req ?? input('km-req-pos')?.value),
        voltMv: command.volt_mv == null ? Number(input('km-req-volt')?.value) : Number(command.volt_mv),
        curMa: command.cur_ma == null ? Number(input('km-req-cur')?.value) : Number(command.cur_ma),
      });
      break;
    case 'entry':
      if (typeof command.protocol === 'string') setRequestForm(command.protocol, {});
      break;
    case 'pd_cmd': {
      const field = input('km-pd-cmd');
      if (field) field.value = String(command.cmd);
      openAdvanced();
      break;
    }
    case 'pd_data': {
      const field = input('km-pd-data');
      if (field) field.value = String(command.hex);
      openAdvanced();
      break;
    }
    case 'ufcs_cmd': {
      const field = input('km-ufcs-cmd');
      if (field) field.value = String(command.cmd);
      openAdvanced();
      break;
    }
    case 'raw': {
      const field = input('km-raw-cmd');
      if (field) field.value = String(command.command);
      openAdvanced();
      break;
    }
  }
  setTriggerMode('trigger');
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
  renderFields();
  renderEnabled();
  renderLog();
  renderDetection();
  setTriggerMode(triggerMode);
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

/** @param {string} text */
function appendHistoryProgress(text) {
  const entry = historyEntries.find((item) => item.id === activeHistoryId);
  if (!entry || !text) return;
  entry.progress = `${entry.progress}\n${text}`.trim();
  historyEntries = trimTriggerHistory(historyEntries);
}

/** @param {TriggerHistoryStatus} status @param {string} reply */
function completeHistoryEntry(status, reply) {
  const entry = historyEntries.find((item) => item.id === activeHistoryId);
  if (!entry) return;
  entry.status = status;
  entry.elapsedMs = Math.max(0, Date.now() - entry.startedAt);
  entry.reply = String(reply ?? '');
  historyEntries = trimTriggerHistory(historyEntries);
}

function finish() {
  const active = historyEntries.find((entry) => entry.id === activeHistoryId);
  if (active?.status === 'running') completeHistoryEntry('failure', t('deviceConnectionLost'));
  busy = false;
  scanning = false;
  pendingReqId = null;
  activeHistoryId = null;
  cancelRequested = false;
  timedOut = false;
  if (watchdog !== null) {
    clearTimeout(watchdog);
    watchdog = null;
  }
  renderAll();
}

/** @param {TriggerOutcome} outcome */
function applyOutcome(outcome) {
  historyEntries = historyEntries.map((entry) =>
    entry.id === activeHistoryId ? reconcileTriggerTranscript(entry, outcome) : entry,
  );
  const command = historyEntries.find((entry) => entry.id === activeHistoryId)?.command;
  const acknowledged =
    outcome.ok &&
    command &&
    ['pd_req', 'qc', 'qc3', 'qc3_adjust', 'fcp', 'afc', 'sfcp', 'scp', 'vfcp', 'ufcs'].includes(command.type);
  completeHistoryEntry(
    outcomeHistoryStatus(outcome, { cancelRequested, timedOut }),
    [
      timedOut ? t('triggerTimeout') : '',
      outcome.message || (outcome.description ? errorText(outcome.description) : ''),
      outcome.reset_verification ? verificationText(outcome.reset_verification) : '',
      acknowledged ? t('triggerAcknowledged') : '',
      outcome.context ? JSON.stringify(outcome.context) : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  pdmOpen = outcome.pdm_open;
  triggerContext = outcome.context ?? {};
  if (outcome.detection) detection = outcome.detection;
  if (outcome.pdos.length && (command?.type !== 'pd_req' || !pdos.length)) {
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
  cancelRequested = false;
  timedOut = false;
  const startedAt = Date.now();
  activeHistoryId = reqId;
  historyEntries = trimTriggerHistory([
    {
      id: reqId,
      command: JSON.parse(JSON.stringify(cmd)),
      startedAt,
      elapsedMs: null,
      status: 'running',
      progress: '',
      reply: '',
    },
    ...historyEntries,
  ]);
  if (scanning) {
    setTriggerMode('detection');
    detection = null;
    detectionHistoryId = reqId;
    pdos = [];
    renderPdos();
  }
  if (['pd_pdo', 'pdm_set', 'pdm_close', 'pdm_open', 'raw'].includes(cmd.type)) {
    pdos = [];
    renderPdos();
    if (cmd.type !== 'pd_pdo') {
      detection = null;
      detectionHistoryId = null;
    }
  }
  pendingReqId = reqId;
  renderAll();
  // 后端每条命令都有串口超时；这里只防后端事件丢失导致界面永远卡在进行中。
  watchdog = setTimeout(() => {
    if (pendingReqId !== reqId) return;
    timedOut = true;
    appendHistoryProgress(t('triggerTimeout'));
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
    if (generation !== deviceStream.generation) {
      finish();
      return;
    }
    applyOutcome(outcome);
    if (scanning && !outcome.detection && detection) detection.completion = outcome.ok ? 'partial' : 'failed';
  } catch (error) {
    if (pendingReqId !== reqId) return;
    if (generation !== deviceStream.generation) {
      finish();
      return;
    }
    completeHistoryEntry(cancelRequested && !timedOut ? 'cancelled' : 'failure', errorText(error));
    if (scanning && detection) detection.completion = 'failed';
  }
  finish();
}

function triggerFromForm() {
  const proto = select('km-proto')?.value ?? 'pd';
  const form = currentForm();
  const built = buildTriggerCommand(proto, form, pdos);
  if ('error' in built) {
    toast.warning(() => {
      const result = buildTriggerCommand(proto, form, pdos);
      return 'error' in result ? result.error : '';
    });
    return;
  }
  void run(built.cmd);
}

async function cancel() {
  if (!busy) return;
  cancelRequested = true;
  try {
    await window.__TAURI__.core.invoke('km003c_cancel_trigger', { generation: deviceStream.generation });
  } catch (error) {
    console.error('取消协议命令失败:', error);
  }
}

/** @param {string} text */
async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast.success(() => t('triggerCopied'));
  } catch {
    const fallback = document.createElement('textarea');
    fallback.value = text;
    fallback.readOnly = true;
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.appendChild(fallback);
    fallback.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    fallback.remove();
    if (copied) toast.success(() => t('triggerCopied'));
    else toast.error(() => t('triggerHistoryCopyFailed'));
  }
}

async function copyLog() {
  const content = exportTriggerHistory(historyEntries);
  if (!content) return;
  await copyText(content);
}

async function exportLog() {
  const content = exportTriggerHistory(historyEntries);
  if (!content) return;
  try {
    const path = await window.__TAURI__.dialog.save({
      title: t('triggerHistoryExport'),
      defaultPath: `lapower-command-history-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
      filters: [{ name: t('textFile'), extensions: ['txt'] }],
    });
    if (!path) return;
    await window.__TAURI__.fs.writeTextFile(path, content);
    toast.success(() => t('triggerHistoryExported'));
  } catch (error) {
    toast.error(() => t('triggerHistoryExportFailed', { detail: errorText(error) }));
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
    triggerContext = p.detection.context ?? triggerContext;
    if (initialized) renderDetection();
  }
  if (p.text) appendHistoryProgress(p.text);
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
    triggerContext = {};
    detection = null;
    detectionHistoryId = null;
    pdos = [];
    if (initialized) renderPdos();
  }
  if (p.description || p.message) {
    const startedAt = Date.now();
    historyEntries = trimTriggerHistory([
      {
        id: `pdm-${startedAt}-${++requestCounter}`,
        command: { type: 'pdm_state' },
        startedAt,
        elapsedMs: 0,
        status: p.description ? 'failure' : 'success',
        progress: '',
        reply: errorText(p.description ?? p.message),
      },
      ...historyEntries,
    ]);
  }
  if (initialized) renderAll();
}

/** 连接状态变化（断开、换设备）：丢弃本地会话状态，后端会话已随流结束。 */
export function syncTriggerConnection() {
  if (!controllable()) {
    pdmOpen = false;
    triggerContext = {};
    if (busy) finish();
    pdos = [];
    detection = null;
    detectionHistoryId = null;
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

  click('btn-km-pdm-open', () => {
    const pdm = currentPdm();
    void run({ type: 'pdm_open', config: { pd_type: pdm.pdType, em: pdm.em, sink: pdm.sink } });
  });
  click('btn-km-pdm-close', () => void run({ type: 'pdm_close' }));
  click('btn-km-pdm-apply', () => {
    const pdm = currentPdm();
    void run({ type: 'pdm_set', pd_type: pdm.pdType, em: pdm.em, sink: pdm.sink });
  });
  for (const id of ['km-pdm-type', 'km-pdm-em', 'km-pdm-sink']) {
    el(id)?.addEventListener('change', () => {
      state.settings.km003cPdm = currentPdm();
      debouncedSaveSettings();
      renderPdmStatus();
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
  el('km-req-pos')?.addEventListener('input', renderFields);

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
    if (!hex || validatePdData(hex) === 'invalid') {
      toast.warning(() => t('triggerPdDataInvalid'));
      return;
    }
    if (validatePdData(hex) === 'extended') toast.warning(() => t('triggerExtendedUnverified'));
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
  click('btn-km-mode-detection', () => setTriggerMode('detection'));
  click('btn-km-mode-trigger', () => setTriggerMode('trigger'));
  click('btn-km-log-copy', () => void copyLog());
  click('btn-km-log-export', () => void exportLog());
  click('btn-km-log-clear', () => {
    historyEntries = [];
    renderLog();
  });
  for (const id of ['km-log-command-filter', 'km-log-status-filter']) {
    el(id)?.addEventListener('change', () => renderHistory());
  }
  el('km-log-text-filter')?.addEventListener('input', () => renderHistory());

  renderFields();
  renderPdos();
  setTriggerMode('trigger');
  renderAll();
  onLanguageChange(() => {
    renderFields();
    renderPdos();
    renderAll();
  });
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

/** @param {import('../km003c-model.js').VoltageVerification} verification */
function verificationText(verification) {
  const key = verification.status === 'verified' ? 'triggerResetVerified' : 'triggerResetUnconfirmed';
  const measured = verification.measured_mv == null ? '—' : `${verification.measured_mv} mV`;
  return `${t(key)} · ${measured} · ${verification.detail}`;
}
