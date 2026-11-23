// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * @file 协议控制页的 PDO 列表与协议检测结果面板 DOM 渲染。
 */

import { t } from '../i18n.js';
import {
  describePdo,
  detectionCanSelect,
  detectionReason,
  detectionStateLabel,
  detectionSummary,
  detectionVoltages,
  pdVersionLabel,
} from '../km003c-model.js';
import { historyStatusKey, setHistoryText } from './trigger-history.js';

/** @typedef {import('../km003c-model.js').TriggerPdo} TriggerPdo */
/** @typedef {import('../km003c-model.js').DetectionReport} DetectionReport */
/** @typedef {import('../km003c-model.js').ProtocolDetection} ProtocolDetection */
/** @typedef {import('../km003c-model.js').TriggerHistoryEntry} TriggerHistoryEntry */

/** @param {import('../km003c-model.js').VoltageVerification} verification */
export function verificationText(verification) {
  const key = verification.status === 'verified' ? 'triggerResetVerified' : 'triggerResetUnconfirmed';
  const measured = verification.measured_mv == null ? '—' : `${verification.measured_mv} mV`;
  return `${t(key)} · ${measured} · ${verification.detail}`;
}

/**
 * 创建 PDO 列表与检测报告面板渲染器。
 * @param {{
 *   el: (id: string) => HTMLElement|null,
 *   isBusy: () => boolean,
 *   isScanning: () => boolean,
 *   getPdos: () => TriggerPdo[],
 *   getDetection: () => DetectionReport|null,
 *   getDetectionHistoryId: () => string|null,
 *   getHistoryEntries: () => TriggerHistoryEntry[],
 *   fillFromPdo: (pdo: TriggerPdo) => void,
 *   fillDetectedProtocol: (result: ProtocolDetection) => void,
 * }} hooks
 */
export function createTriggerDetectionView(hooks) {
  /** @type {Map<string,{key:string,row:HTMLElement}>} */
  const detectionRows = new Map();

  function renderPdos() {
    const list = hooks.el('km-pdo-list');
    if (!list) return;
    const pdos = hooks.getPdos();
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
        row.addEventListener('click', () => hooks.fillFromPdo(pdo));
        return row;
      }),
    );
  }

  function renderDetection() {
    const busy = hooks.isBusy();
    const scanning = hooks.isScanning();
    const detection = hooks.getDetection();
    const exportButton = /** @type {HTMLButtonElement|null} */ (hooks.el('btn-km-export-report'));
    if (exportButton) exportButton.disabled = busy || scanning || !detection?.completion || !detection?.results.length;
    const summary = hooks.el('km-detection-summary');
    const box = hooks.el('km-detection-results');
    if (!summary || !box) return;
    const diagnostics = hooks.el('km-detection-diagnostics');
    const diagnosticsDetails = hooks.el('km-detection-diagnostics-details');
    const scanEntry = hooks.getHistoryEntries().find((entry) => entry.id === hooks.getDetectionHistoryId());
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
    if (!detection) {
      box.replaceChildren();
      detectionRows.clear();
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
      let group = /** @type {HTMLElement|null} */ (box.querySelector(`.trigger-detection-group.is-${id}`));
      if (!group) {
        group = document.createElement('section');
        group.appendChild(document.createElement('h3'));
        box.appendChild(group);
      }
      group.className = `trigger-detection-group is-${id}`;
      if (group.firstElementChild) setHistoryText(/** @type {HTMLElement} */ (group.firstElementChild), t(labelKey));
      let position = 1;
      for (const result of groupResults) {
        const before = group.children[position++] ?? null;
        const key = JSON.stringify([result, report.completion, report.active === result.id, busy, t('scanEvidence')]);
        const cached = detectionRows.get(result.id);
        if (cached?.key === key) {
          if (before !== cached.row) group.insertBefore(cached.row, before);
          continue;
        }
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
          use.addEventListener('click', () => hooks.fillDetectedProtocol(result));
          actions.appendChild(use);
        }
        if (actions.childElementCount) row.insertBefore(actions, row.querySelector('.trigger-detection-detail'));
        if (cached?.row.parentElement === group) cached.row.replaceWith(row);
        else group.insertBefore(row, before);
        detectionRows.set(result.id, { key, row });
      }
    }
    const ids = new Set(report.results.map((result) => result.id));
    for (const [id, cached] of detectionRows) {
      if (!ids.has(id)) {
        cached.row.remove();
        detectionRows.delete(id);
      }
    }
    for (const group of box.querySelectorAll('.trigger-detection-group')) {
      if (!group.querySelector('.trigger-detection-result')) group.remove();
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

  return { renderPdos, renderDetection };
}
