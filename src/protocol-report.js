// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/** Fixed 16:9 protocol report. Draw data, never a screenshot of the live workspace. */
import { getResolvedLanguage, t } from './i18n.js';
import { detectionStateLabel, detectionSummary, detectionVoltages, pdVersionLabel } from './km003c-model.js';
import { normalizeProtocolReportOptions, pdoReportParameters } from './protocol-report-model.js';

/** Resolve the selected theme straight from the bundled design tokens. Reading CSSOM
 * avoids changing the application's theme or maintaining a second set of color values.
 * @param {'light'|'dark'} theme */
function reportStyle(theme) {
  const base = new Map();
  const light = new Map();
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (!(rule instanceof CSSStyleRule)) continue;
      const selector = rule.selectorText.replace(/["']/g, '');
      const target = selector === ':root' ? base : selector === ':root[data-theme=light]' ? light : null;
      if (target) {
        for (const name of rule.style) {
          if (name.startsWith('--')) target.set(name, rule.style.getPropertyValue(name).trim());
        }
      }
    }
  }
  const tokens = theme === 'light' ? new Map([...base, ...light]) : base;
  /** @param {string} name @param {number} [depth] @returns {string} */
  function token(name, depth = 0) {
    if (depth > 12 || !tokens.has(name)) throw new Error(t('protocolReportRenderFailed'));
    return tokens.get(name).replace(/var\((--[\w-]+)\)/g, (_, key) => token(key, depth + 1));
  }
  const current = getComputedStyle(document.documentElement);
  return {
    background: token('--surface-content'),
    card: token('--surface-card'),
    ink: token('--text-primary'),
    muted: token('--text-secondary'),
    border: token('--stroke-divider'),
    accent: token('--accent-text'),
    success: token('--status-success'),
    successBg: token('--status-success-bg'),
    caution: token('--status-caution'),
    cautionBg: token('--status-caution-bg'),
    neutralBg: token('--status-info-bg'),
    ui: current.getPropertyValue('--font-ui').trim(),
    radius: Number.parseFloat(token('--radius-surface')),
  };
}

/** @returns {Promise<HTMLImageElement>} */
function loadIcon() {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(t('protocolReportRenderFailed')));
    image.src = new URL('./assets/app-icon.png', import.meta.url).href;
  });
}

/** @param {number} value */
const number = (value) => Number(value.toFixed(2)).toString();

/** @param {import('./protocol-report-model.js').ProtocolReportSnapshot} snapshot
 * @param {import('./protocol-report-model.js').ProtocolReportOptions} requested
 * @returns {Promise<Blob>} */
export async function renderProtocolReport(snapshot, requested) {
  const options = normalizeProtocolReportOptions(requested);
  await document.fonts.ready;
  const icon = await loadIcon();
  const palette = reportStyle(options.theme ?? 'light');
  const canvas = document.createElement('canvas');
  canvas.width = options.width;
  canvas.height = options.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(t('protocolReportRenderFailed'));
  const ctx = context;
  ctx.scale(options.width / 1920, options.height / 1080);
  ctx.textBaseline = 'top';
  const { report, metadata } = snapshot;
  const overflow = () => new Error(t('protocolReportOverflow'));

  /** @param {string} value @param {number} width */
  function wrap(value, width) {
    const lines = [];
    for (const paragraph of value.split('\n')) {
      let line = '';
      for (const char of paragraph) {
        if (line && ctx.measureText(line + char).width > width) {
          const space = line.lastIndexOf(' ');
          if (space > 0) {
            lines.push(line.slice(0, space));
            line = line.slice(space + 1) + char;
          } else {
            lines.push(line);
            line = char;
          }
        } else line += char;
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }

  /** @param {string} value @param {number} x @param {number} y @param {number} width
   * @param {number} size @param {number} [lines] @param {string} [color]
   * @param {boolean} [strong] @param {number} [min] */
  function text(value, x, y, width, size, lines = 1, color = palette.ink, strong = false, min = size) {
    let rows = [];
    for (; size >= min; size--) {
      ctx.font = `${strong ? 600 : 400} ${size}px ${palette.ui}`;
      rows = wrap(value, width);
      if (rows.length <= lines) break;
    }
    if (size < min) throw overflow();
    ctx.fillStyle = color;
    rows.forEach((line, i) => {
      ctx.fillText(line, x, y + i * size * 1.35);
    });
    return rows.length * size * 1.35;
  }

  /** @param {number} x @param {number} y @param {number} w @param {number} h @param {string} [fill] */
  function card(x, y, w, h, fill = palette.card) {
    const r = palette.radius;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  /** @param {number} x @param {number} y @param {number} width */
  function divider(x, y, width) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  /** @param {string} value @param {number} x @param {number} y @param {number} width
   * @param {'supported'|'unsupported'|'not_checked'|'failed'|string} state @param {number} [size]
   * @param {boolean} [alignRight] */
  function badge(value, x, y, width, state, size = 16, alignRight = false) {
    const good = state === 'supported';
    const warning = state === 'unsupported' || state === 'failed';
    for (; size > 13; size--) {
      ctx.font = `400 ${size}px ${palette.ui}`;
      if (ctx.measureText(value).width <= width - 20) break;
    }
    ctx.font = `400 ${size}px ${palette.ui}`;
    const contentWidth = Math.min(width, Math.ceil(ctx.measureText(value).width) + 20);
    if (alignRight) x += width - contentWidth;
    card(x, y, contentWidth, size + 12, good ? palette.successBg : warning ? palette.cautionBg : palette.neutralBg);
    text(
      value,
      x + 9,
      y + 6,
      contentWidth - 18,
      size,
      1,
      good ? palette.success : warning ? palette.caution : palette.muted,
      false,
      13,
    );
  }

  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, 1920, 1080);
  ctx.drawImage(icon, 48, 42, 48, 48);
  text('laPower', 110, 47, 175, 34, 1, palette.ink, true);
  text(t('protocolReportTitle'), 300, 47, 1120, 34, 1, palette.ink, true, 26);
  badge(detectionSummary(report), 1480, 44, 392, report.completion === 'complete' ? 'supported' : 'failed', 22, true);
  const timestamp = new Date(metadata.startedAt).toLocaleString(getResolvedLanguage(), { hour12: false });
  text(`${metadata.device}  ·  ${timestamp}`, 48, 116, 1190, 22, 1, palette.muted, false, 18);
  text(
    `${t(metadata.full ? 'fullScan' : 'scan')}  ·  ${number(report.elapsed_ms / 1000)} s`,
    1270,
    116,
    602,
    22,
    1,
    palette.muted,
    false,
    18,
  );
  divider(48, 158, 1824);

  const left = 48,
    leftWidth = 850,
    right = 922,
    rightWidth = 950,
    top = 182,
    height = 704;
  const standard = ['qc', 'qc3', 'bc', 'apple'];
  const groups = [
    { label: 'triggerGroupStandard', results: report.results.filter((r) => standard.includes(r.id)) },
    { label: 'triggerGroupVendor', results: report.results.filter((r) => r.id !== 'pd' && !standard.includes(r.id)) },
  ].filter((group) => group.results.length);
  const available = height - 117 - groups.length * 30;
  const results = groups.flatMap((group) => group.results);
  const rows = results.map((result) => {
    const voltages = detectionVoltages(result);
    return {
      result,
      value: voltages.length ? voltages.join(' · ') : result.state === 'supported' ? t('scanVoltageUnknown') : '—',
      hasVoltages: !!voltages.length,
      lines: 1,
      height: 32,
    };
  });
  let voltageSize = 18;
  for (; voltageSize >= 14; voltageSize--) {
    for (const row of rows) {
      ctx.font = `400 ${voltageSize}px ${palette.ui}`;
      row.lines = wrap(row.value, leftWidth - 417).length;
      row.height = Math.max(32, Math.ceil((row.lines - 1) * voltageSize * 1.35 + voltageSize + 14));
    }
    if (rows.reduce((sum, row) => sum + row.height, 0) <= available) break;
  }
  if (voltageSize < 14) throw overflow();
  const extra = Math.floor((available - rows.reduce((sum, row) => sum + row.height, 0)) / Math.max(rows.length, 1));
  for (const row of rows) row.height += Math.min(extra, Math.max(0, 38 - row.height));
  card(left, top, leftWidth, height);
  text(t('scanTitle'), left + 22, top + 20, leftWidth - 44, 25, 1, palette.ink, true);
  const protocolX = left + 22,
    statusX = left + 235,
    voltageX = left + 395;
  text(t('protocol'), protocolX, top + 66, 195, 17, 1, palette.muted, true);
  text(t('protocolReportStatus'), statusX, top + 66, 140, 17, 1, palette.muted, true);
  text(t('scanVoltages'), voltageX, top + 66, leftWidth - 417, 17, 1, palette.muted, true);
  divider(left + 22, top + 96, leftWidth - 44);
  let y = top + 105;
  for (const group of groups) {
    text(t(group.label), protocolX, y + 2, leftWidth - 44, 16, 1, palette.muted, true);
    y += 30;
    for (const result of group.results) {
      const row = rows.find((row) => row.result === result);
      if (!row) throw overflow();
      text(result.label, protocolX, y + (row.height - 19) / 2, 195, 19, 1, palette.ink, true, 16);
      badge(detectionStateLabel(result), statusX, y + (row.height - 27) / 2, 142, result.state, 15);
      text(
        row.value,
        voltageX,
        y + (row.height - ((row.lines - 1) * voltageSize * 1.35 + voltageSize)) / 2,
        leftWidth - 417,
        voltageSize,
        row.lines,
        row.hasVoltages ? palette.accent : palette.muted,
      );
      divider(left + 22, y + row.height - 1, leftWidth - 44);
      y += row.height;
    }
  }

  const pd = report.results.find((result) => result.id === 'pd');
  card(right, top, rightWidth, 112);
  text('USB Power Delivery', right + 22, top + 18, rightWidth - 250, 25, 1, palette.ink, true);
  if (pd) {
    badge(detectionStateLabel(pd), right + rightWidth - 200, top + 16, 178, pd.state, 18, true);
    text(pdVersionLabel(pd), right + 22, top + 59, rightWidth - 44, 20, 2, palette.muted, false, 17);
  } else text(t('protocolReportNoPdos'), right + 22, top + 59, rightWidth - 44, 20, 1, palette.muted);

  const pdos = report.pdos ?? [];
  const tableTop = top + 128;
  const tableRowHeight = Math.min(42, Math.floor((height - 224) / Math.max(pdos.length, 1)));
  if (tableRowHeight < 24) throw overflow();
  const tableHeight = 96 + Math.max(pdos.length * tableRowHeight, 66);
  card(right, tableTop, rightWidth, tableHeight);
  text(t('protocolReportPdoTitle'), right + 22, tableTop + 18, 610, 23, 1, palette.ink, true);
  const columns = [48, 174, 254, 184, 246];
  const labels = ['#', t('protocolReportPdoType'), t('voltage'), t('current'), t('power')];
  let columnX = right + 22;
  labels.forEach((label, i) => {
    text(label, columnX, tableTop + 61, columns[i] - 14, 17, 1, palette.muted, true, 14);
    columnX += columns[i];
  });
  divider(right + 22, tableTop + 89, rightWidth - 44);
  if (!pdos.length) text(t('protocolReportNoPdos'), right + 22, tableTop + 111, rightWidth - 44, 20, 2, palette.muted);
  pdos.forEach((pdo, i) => {
    const values = pdoReportParameters(pdo);
    const validVoltage =
      Number.isFinite(pdo.volt_min_mv) &&
      Number.isFinite(pdo.volt_max_mv) &&
      pdo.volt_min_mv > 0 &&
      pdo.volt_max_mv >= pdo.volt_min_mv;
    const voltage = validVoltage
      ? `${number(pdo.volt_min_mv / 1000)}${pdo.volt_min_mv === pdo.volt_max_mv ? '' : `–${number(pdo.volt_max_mv / 1000)}`} V`
      : '—';
    const current = values.currentMa
      ? `${number(values.currentMa / 1000)} A${values.currentAtMaxVoltage ? '†' : ''}`
      : '—';
    const power = values.powerMw
      ? `${number(values.powerMw / 1000)} W${values.powerSource === 'calculated' ? '*' : pdo.kind === 'epr_avs' ? ' PDP' : ''}`
      : '—';
    const cells = [String(pdo.position), pdo.kind.replaceAll('_', ' ').toUpperCase(), voltage, current, power];
    const rowY = tableTop + 94 + i * tableRowHeight;
    columnX = right + 22;
    cells.forEach((cell, j) => {
      text(
        cell,
        columnX,
        rowY + (tableRowHeight - 23) / 2,
        columns[j] - 14,
        19,
        1,
        j === 0 ? palette.muted : palette.ink,
        false,
        15,
      );
      columnX += columns[j];
    });
    if (i < pdos.length - 1) divider(right + 22, rowY + tableRowHeight - 1, rightWidth - 44);
  });

  const applied = report.context?.applied_pdm;
  const configuration = applied
    ? `PDM: type=${applied.pd_type}, em=${applied.em}, sink=${applied.sink}`
    : t('triggerConfigUnknown');
  const firmware = `${t('triggerFirmware')} ${report.context?.firmware_version ?? '—'}  ·  PDM ${report.pdm_version ?? '—'}`;
  const infoY = tableTop + tableHeight + 16;
  const infoHeight = top + height - infoY;
  if (infoHeight >= 118) {
    card(right, infoY, rightWidth, infoHeight);
    text(t('protocolReportConditions'), right + 22, infoY + 18, rightWidth - 44, 21, 1, palette.ink, true);
    text(firmware, right + 22, infoY + 55, rightWidth - 44, 19, 1, palette.muted);
    text(configuration, right + 22, infoY + 86, rightWidth - 44, 19, 1, palette.muted, false, 16);
  }
  text(
    infoHeight >= 118 ? t('protocolReportPdoScope') : `${configuration}  ·  ${firmware}`,
    48,
    913,
    1824,
    19,
    1,
    palette.muted,
    false,
    16,
  );
  const warnings = [];
  if (report.completion !== 'complete') warnings.push(t('protocolReportIncomplete'));
  if (report.reset_verification && report.reset_verification.status !== 'verified')
    warnings.push(t('triggerResetUnconfirmed'));
  if (warnings.length) text(warnings.join(' · '), 48, 947, 1824, 19, 1, palette.caution, false, 16);
  text(t('protocolReportPowerNote'), 48, warnings.length ? 982 : 958, 1824, 17, 2, palette.muted, false, 15);

  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t('protocolReportRenderFailed')))), 'image/png'),
  );
}
