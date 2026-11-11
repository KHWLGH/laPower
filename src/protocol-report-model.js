// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/** Protocol report data and options; independent of DOM and Tauri. */

/** @typedef {{width:number, height:number, theme:'light'|'dark'|null}} ProtocolReportOptions */
/** @typedef {{device:string, startedAt:number, full:boolean}} DetectionMetadata */
/** @typedef {{report:import('./km003c-model.js').DetectionReport, metadata:DetectionMetadata}} ProtocolReportSnapshot */

export const PROTOCOL_REPORT_RESOLUTIONS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
];

/** @type {ProtocolReportOptions} */
export const defaultProtocolReportOptions = { width: 1920, height: 1080, theme: null };

/** @param {unknown} raw @returns {ProtocolReportOptions} */
export function normalizeProtocolReportOptions(raw) {
  const source = /** @type {Partial<ProtocolReportOptions>|null} */ (raw && typeof raw === 'object' ? raw : null);
  const resolution =
    PROTOCOL_REPORT_RESOLUTIONS.find((item) => item.width === source?.width && item.height === source?.height) ??
    PROTOCOL_REPORT_RESOLUTIONS[0];
  return {
    ...resolution,
    theme: source?.theme === 'light' || source?.theme === 'dark' ? source.theme : null,
  };
}

/** Capture only this detection's capabilities, never the mutable trigger PDO list.
 * @param {import('./km003c-model.js').DetectionReport} report
 * @param {DetectionMetadata} metadata
 * @returns {ProtocolReportSnapshot} */
export function snapshotProtocolReport(report, metadata) {
  return structuredClone({ report: { ...report, pdos: report.pdos ?? [] }, metadata });
}

/** Keep reported power separate from a Vmax × Imax calculation, and AVS endpoint
 * current separate from a constant-current capability.
 * @param {import('./km003c-model.js').TriggerPdo} pdo */
export function pdoReportParameters(pdo) {
  const currentMa =
    pdo.kind !== 'battery' && Number.isFinite(pdo.cur_ma) && Number(pdo.cur_ma) > 0 ? Number(pdo.cur_ma) : null;
  const reported = Number.isFinite(pdo.max_power_mw) && Number(pdo.max_power_mw) > 0 ? Number(pdo.max_power_mw) : null;
  const canCalculate = ['fixed', 'epr_fixed', 'pps', 'variable', 'spr_avs'].includes(pdo.kind);
  const calculated = canCalculate && currentMa && pdo.volt_max_mv > 0 ? (pdo.volt_max_mv * currentMa) / 1000 : null;
  return {
    currentMa,
    currentAtMaxVoltage: pdo.kind === 'epr_avs' || pdo.kind === 'avs',
    powerMw: reported ?? calculated,
    powerSource: reported ? 'reported' : calculated ? 'calculated' : 'none',
  };
}
