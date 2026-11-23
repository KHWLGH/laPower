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
    canvasBg: token(theme === 'light' ? '--fill-subtle-hover' : '--surface-base'),
    card: token('--surface-content'),
    surfaceLayer: token('--fill-subtle-hover'),
    ink: token('--text-primary'),
    muted: token('--text-secondary'),
    subtle: token('--text-tertiary'),
    border: token('--stroke-divider'),
    cardBorder: token('--stroke-card'),
    accent: token('--accent-text'),
    accentFill: token('--accent-fill'),
    success: token('--status-success'),
    successBg: token('--status-success-bg'),
    caution: token('--status-caution'),
    cautionBg: token('--status-caution-bg'),
    neutralBg: token('--status-info-bg'),
    ui: current.getPropertyValue('--font-ui').trim(),
    mono: current.getPropertyValue('--font-mono').trim(),
    radius: Number.parseFloat(token('--radius-surface')),
  };
}

/** @param {string} color @param {number} opacity */
function hexAlpha(color, opacity) {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return color;
  const int = Number.parseInt(match[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
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

  /** @param {number} size @param {number|boolean} [weight] @param {boolean} [mono] */
  function fontSpec(size, weight = 400, mono = false) {
    const numeric = typeof weight === 'boolean' ? (weight ? 600 : 400) : weight;
    return `${numeric} ${size}px ${mono ? palette.mono : palette.ui}`;
  }

  /** @param {string} value @param {number} x @param {number} y @param {number} width
   * @param {number} size @param {{ lines?: number, color?: string, weight?: number, mono?: boolean,
   * min?: number, align?: 'left'|'center'|'right' }} [opts] */
  function drawText(value, x, y, width, size, opts = {}) {
    const { lines = 1, color = palette.ink, weight = 400, mono = false, min = size, align = 'left' } = opts;
    let rows = [];
    for (; size >= min; size--) {
      ctx.font = fontSpec(size, weight, mono);
      rows = wrap(value, width);
      if (rows.length <= lines) break;
    }
    if (size < min) throw overflow();
    ctx.fillStyle = color;
    ctx.textAlign = align;
    const anchorX = align === 'right' ? x + width : align === 'center' ? x + width / 2 : x;
    rows.forEach((line, i) => {
      ctx.fillText(line, anchorX, y + i * size * 1.35);
    });
    ctx.textAlign = 'left';
    return rows.length * size * 1.35;
  }

  /** @param {number} x @param {number} y @param {number} w @param {number} h
   * @param {number} [radius] */
  function roundedPath(x, y, w, h, radius = palette.radius) {
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
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
  }

  /** @param {number} x @param {number} y @param {number} w @param {number} h
   * @param {{ fill?: string, stroke?: string|null, radius?: number }} [opts] */
  function card(x, y, w, h, opts = {}) {
    const { fill = palette.card, stroke = palette.cardBorder, radius = 12 } = opts;
    roundedPath(x, y, w, h, radius);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /** @param {number} x @param {number} y @param {number} width @param {string} [color] */
  function divider(x, y, width, color = palette.border) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** @param {string} value @param {number} x @param {number} y @param {number} width
   * @param {'supported'|'unsupported'|'not_checked'|'failed'|string} state
   * @param {{ size?: number, minSize?: number, align?: 'left'|'center'|'right', minWidth?: number,
   * withDot?: boolean }} [opts] */
  function badge(value, x, y, width, state, opts = {}) {
    const { size: requestedSize = 14, minSize = 12, align = 'left', minWidth = 0, withDot = false } = opts;
    const good = state === 'supported';
    const warning = state === 'unsupported' || state === 'failed';
    const fg = good ? palette.success : warning ? palette.caution : palette.muted;
    const bg = good ? palette.successBg : warning ? palette.cautionBg : palette.neutralBg;
    const borderColor = hexAlpha(fg, 0.34);
    const dotSpace = withDot ? 14 : 0;
    const padX = 12;
    let size = requestedSize;
    for (; size > minSize; size--) {
      ctx.font = fontSpec(size, 600);
      if (ctx.measureText(value).width + padX * 2 + dotSpace <= width) break;
    }
    ctx.font = fontSpec(size, 600);
    const labelWidth = Math.ceil(ctx.measureText(value).width);
    const pillWidth = Math.min(width, Math.max(minWidth, labelWidth + padX * 2 + dotSpace));
    const pillHeight = size + 12;
    let pillX = x;
    if (align === 'right') pillX = x + width - pillWidth;
    else if (align === 'center') pillX = x + (width - pillWidth) / 2;

    card(pillX, y, pillWidth, pillHeight, { fill: bg, stroke: borderColor, radius: pillHeight / 2 });
    const innerWidth = labelWidth + dotSpace;
    const contentLeft = pillWidth > innerWidth + padX * 2 ? pillX + (pillWidth - innerWidth) / 2 : pillX + padX;
    if (withDot) {
      ctx.beginPath();
      ctx.arc(contentLeft + 3, y + pillHeight / 2, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = fg;
      ctx.fill();
    }
    drawText(value, contentLeft + dotSpace, y + 6, Math.max(pillWidth - padX * 2 - dotSpace, labelWidth), size, {
      color: fg,
      weight: 600,
      min: minSize,
    });
    return { x: pillX, y, width: pillWidth, height: pillHeight };
  }

  /** @param {string[]} labels @param {number} maxWidth @param {number} fontSize @param {number} maxLines */
  function layoutChips(labels, maxWidth, fontSize, maxLines) {
    if (!labels.length) return { fitted: true, rows: [], rowHeight: 0, totalHeight: 0, fontSize };
    ctx.font = fontSpec(fontSize, 500, true);
    const padX = 10;
    const gapX = 6;
    const gapY = 6;
    const chipHeight = fontSize + 10;
    /** @type {Array<Array<{ label: string, width: number }>>} */
    const lines = [[]];
    let cursorX = 0;
    for (const label of labels) {
      const chipWidth = Math.ceil(ctx.measureText(label).width) + padX * 2;
      if (chipWidth > maxWidth) return { fitted: false, rows: [], rowHeight: chipHeight, totalHeight: 0, fontSize };
      const current = lines[lines.length - 1];
      if (current.length && cursorX + gapX + chipWidth > maxWidth) {
        if (lines.length >= maxLines) {
          return { fitted: false, rows: [], rowHeight: chipHeight, totalHeight: 0, fontSize };
        }
        lines.push([{ label, width: chipWidth }]);
        cursorX = chipWidth;
      } else {
        if (current.length) cursorX += gapX;
        current.push({ label, width: chipWidth });
        cursorX += chipWidth;
      }
    }
    const totalHeight = lines.length * chipHeight + (lines.length - 1) * gapY;
    return { fitted: true, rows: lines, rowHeight: chipHeight, totalHeight, fontSize };
  }

  /** @param {ReturnType<typeof layoutChips>} layout @param {number} x @param {number} y */
  function drawChips(layout, x, y) {
    const gapX = 6;
    const gapY = 6;
    const fill = hexAlpha(palette.accentFill, 0.11);
    const stroke = hexAlpha(palette.accentFill, 0.34);
    let cy = y;
    for (const row of layout.rows) {
      let cx = x;
      for (const chip of row) {
        card(cx, cy, chip.width, layout.rowHeight, { fill, stroke, radius: 6 });
        drawText(chip.label, cx + 10, cy + 5, chip.width - 20, layout.fontSize, {
          color: palette.accent,
          weight: 500,
          mono: true,
        });
        cx += chip.width + gapX;
      }
      cy += layout.rowHeight + gapY;
    }
  }

  // Page canvas & header card
  ctx.fillStyle = palette.canvasBg;
  ctx.fillRect(0, 0, 1920, 1080);

  const margin = 48;
  const contentWidth = 1824;
  const headerY = 32;
  const headerH = 104;
  const headerRight = margin + contentWidth - 24;
  card(margin, headerY, contentWidth, headerH);
  ctx.drawImage(icon, margin + 24, headerY + (headerH - 48) / 2, 48, 48);

  const brandX = margin + 90;
  ctx.font = fontSpec(28, 700);
  const brandW = Math.ceil(ctx.measureText('laPower').width);
  drawText('laPower', brandX, headerY + 20, brandW + 4, 28, { weight: 700 });
  const sepX = brandX + brandW + 16;
  ctx.beginPath();
  ctx.moveTo(sepX, headerY + 24);
  ctx.lineTo(sepX, headerY + 46);
  ctx.strokeStyle = palette.cardBorder;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const titleX = sepX + 16;
  drawText(t('protocolReportTitle'), titleX, headerY + 20, 1410 - titleX, 28, {
    weight: 700,
    min: 20,
  });

  const timestamp = new Date(metadata.startedAt).toLocaleString(getResolvedLanguage(), { hour12: false });
  drawText(`${metadata.device}  ·  ${timestamp}`, brandX, headerY + 60, 1260, 16, {
    color: palette.muted,
    min: 14,
  });

  const completeState = report.completion === 'complete' ? 'supported' : 'failed';
  badge(detectionSummary(report), headerRight - 408, headerY + 18, 408, completeState, {
    size: 16,
    align: 'right',
    withDot: true,
  });
  drawText(
    `${t(metadata.full ? 'fullScan' : 'scan')}  ·  ${number(report.elapsed_ms / 1000)} s`,
    headerRight - 408,
    headerY + 60,
    408,
    16,
    { color: palette.subtle, min: 14, align: 'right' },
  );

  // Two-column balanced main grid (y = 156 .. 984)
  const mainTop = 156;
  const mainBottom = 984;
  const mainHeight = mainBottom - mainTop;
  const colGap = 24;
  const left = margin;
  const leftWidth = 876;
  const right = left + leftWidth + colGap;
  const rightWidth = contentWidth - leftWidth - colGap;

  // Left card: Protocol detection matrix
  const standard = ['qc', 'qc3', 'bc', 'apple'];
  const groups = [
    { label: 'triggerGroupStandard', results: report.results.filter((r) => standard.includes(r.id)) },
    { label: 'triggerGroupVendor', results: report.results.filter((r) => r.id !== 'pd' && !standard.includes(r.id)) },
  ].filter((group) => group.results.length);
  const results = groups.flatMap((group) => group.results);
  const supportedTableCount = results.filter((r) => r.state === 'supported').length;

  const colProtoX = left + 36;
  const colProtoW = 196;
  const colStatusX = left + 244;
  const colStatusW = 132;
  const colVoltX = left + 392;
  const colVoltW = left + leftWidth - 28 - colVoltX;

  const listTop = mainTop + 106;
  const listBottom = mainBottom - 16;
  const groupTopFirst = 6;
  const groupGap = 18;
  const groupHeaderH = 30;
  const groupOverhead = groups.length
    ? groupTopFirst + Math.max(0, groups.length - 1) * groupGap + groups.length * groupHeaderH
    : 0;
  const availableRowSpace = listBottom - listTop - groupOverhead;

  /**
   * @type {Array<{
   *   result: import('./km003c-model.js').ProtocolDetection,
   *   chips: string[],
   *   value: string,
   *   hasVoltages: boolean,
   *   chipLayout: ReturnType<typeof layoutChips>|null,
   *   textSize: number,
   *   lines: number,
   *   height: number
   * }>}
   */
  const rows = results.map((result) => {
    const voltages = detectionVoltages(result);
    return {
      result,
      chips: voltages,
      value: voltages.length ? voltages.join(' · ') : result.state === 'supported' ? t('scanVoltageUnknown') : '—',
      hasVoltages: !!voltages.length,
      chipLayout: null,
      textSize: 15,
      lines: 1,
      height: 44,
    };
  });

  if (rows.length) {
    let fitted = false;
    for (let fontSize = 14; fontSize >= 12 && !fitted; fontSize--) {
      for (const row of rows) {
        if (row.hasVoltages) {
          const layout = layoutChips(row.chips, colVoltW, fontSize, 2);
          if (layout.fitted) {
            row.chipLayout = layout;
            row.lines = layout.rows.length;
            row.height = Math.max(42, layout.totalHeight + 18);
          } else {
            row.chipLayout = null;
            ctx.font = fontSpec(fontSize + 1, 500, true);
            const wrapped = wrap(row.value, colVoltW);
            row.textSize = fontSize + 1;
            row.lines = wrapped.length;
            row.height = Math.max(40, Math.ceil(wrapped.length * (fontSize + 1) * 1.35 + 16));
          }
        } else {
          row.chipLayout = null;
          ctx.font = fontSpec(fontSize + 1, 400, false);
          const wrapped = wrap(row.value, colVoltW);
          row.textSize = fontSize + 1;
          row.lines = wrapped.length;
          row.height = Math.max(40, Math.ceil(wrapped.length * (fontSize + 1) * 1.35 + 16));
        }
      }
      if (rows.reduce((sum, row) => sum + row.height, 0) <= availableRowSpace) fitted = true;
    }
    if (!fitted) {
      let fallbackSize = 14;
      for (; fallbackSize >= 12; fallbackSize--) {
        for (const row of rows) {
          row.chipLayout = null;
          ctx.font = fontSpec(fallbackSize, 400, row.hasVoltages);
          row.lines = wrap(row.value, colVoltW).length;
          row.textSize = fallbackSize;
          row.height = Math.max(30, Math.ceil(row.lines * fallbackSize * 1.35 + 12));
        }
        if (rows.reduce((sum, row) => sum + row.height, 0) <= availableRowSpace) break;
      }
      if (fallbackSize < 12) throw overflow();
    } else {
      const leftover = availableRowSpace - rows.reduce((sum, row) => sum + row.height, 0);
      const bonus = Math.floor(leftover / rows.length);
      for (const row of rows) {
        row.height += Math.min(bonus, Math.max(0, 58 - row.height));
      }
    }
  }

  card(left, mainTop, leftWidth, mainHeight);
  drawText(t('scanTitle'), left + 24, mainTop + 18, 520, 22, { weight: 700, min: 18 });
  badge(
    `${supportedTableCount} / ${results.length} ${t('scanSupported')}`,
    left + leftWidth - 284,
    mainTop + 18,
    260,
    supportedTableCount > 0 ? 'supported' : 'not_checked',
    {
      size: 13,
      align: 'right',
      withDot: supportedTableCount > 0,
    },
  );

  card(left + 20, mainTop + 62, leftWidth - 40, 34, {
    fill: palette.surfaceLayer,
    stroke: null,
    radius: 8,
  });
  drawText(t('protocol'), colProtoX, mainTop + 70, colProtoW, 14, { color: palette.subtle, weight: 600, min: 12 });
  drawText(t('protocolReportStatus'), colStatusX, mainTop + 70, colStatusW, 14, {
    color: palette.subtle,
    weight: 600,
    min: 12,
    align: 'center',
  });
  drawText(t('scanVoltages'), colVoltX, mainTop + 70, colVoltW, 14, { color: palette.subtle, weight: 600, min: 12 });

  let cursorY = listTop;
  groups.forEach((group, groupIndex) => {
    cursorY += groupIndex === 0 ? groupTopFirst : groupGap;
    card(left + 28, cursorY + 8, 3, 14, { fill: palette.accentFill, stroke: null, radius: 1.5 });
    const groupTitle = t(group.label);
    ctx.font = fontSpec(14, 700);
    const groupTitleW = Math.ceil(ctx.measureText(groupTitle).width);
    drawText(groupTitle, left + 40, cursorY + 6, Math.min(340, leftWidth - 80), 14, {
      color: palette.muted,
      weight: 700,
      min: 12,
    });
    const ruleStart = left + 40 + groupTitleW + 14;
    if (ruleStart < left + leftWidth - 36) {
      divider(ruleStart, cursorY + 15, left + leftWidth - 28 - ruleStart);
    }
    cursorY += groupHeaderH;

    group.results.forEach((result, rowIndex) => {
      const row = rows.find((item) => item.result === result);
      if (!row) throw overflow();
      drawText(result.label, colProtoX, cursorY + (row.height - 20) / 2, colProtoW, 16, {
        color: result.state === 'supported' ? palette.ink : palette.muted,
        weight: 600,
        min: 13,
      });
      badge(detectionStateLabel(result), colStatusX, cursorY + (row.height - 26) / 2, colStatusW, result.state, {
        size: 13,
        align: 'center',
        minWidth: 92,
        withDot: result.state === 'supported',
      });
      if (row.chipLayout) {
        drawChips(row.chipLayout, colVoltX, cursorY + (row.height - row.chipLayout.totalHeight) / 2);
      } else {
        const textBlockH = row.lines * row.textSize * 1.35;
        drawText(row.value, colVoltX, cursorY + (row.height - textBlockH) / 2 + 1, colVoltW, row.textSize, {
          lines: row.lines,
          color: row.hasVoltages ? palette.accent : palette.subtle,
          mono: row.hasVoltages,
          min: 12,
        });
      }
      if (rowIndex < group.results.length - 1) {
        divider(colProtoX, cursorY + row.height, left + leftWidth - 28 - colProtoX);
      }
      cursorY += row.height;
    });
  });

  // Right column: USB PD hero card + Adaptive PDO table + Bottom-anchored Conditions card
  const rightCardGap = 16;
  const pd = report.results.find((result) => result.id === 'pd');
  const pdChips = pd ? detectionVoltages(pd) : [];
  let pdChipLayout = layoutChips(pdChips, rightWidth - 48, 14, 2);
  if (!pdChipLayout.fitted && pdChips.length) {
    pdChipLayout = layoutChips(pdChips, rightWidth - 48, 12, 2);
  }
  const pdCardHeight = pdChipLayout.fitted && pdChips.length ? 86 + pdChipLayout.totalHeight + 18 : 108;

  card(right, mainTop, rightWidth, pdCardHeight);
  drawText('USB Power Delivery', right + 24, mainTop + 18, rightWidth - 260, 22, { weight: 700, min: 18 });
  if (pd) {
    badge(detectionStateLabel(pd), right + rightWidth - 224, mainTop + 16, 200, pd.state, {
      size: 15,
      align: 'right',
      withDot: pd.state === 'supported',
    });
    drawText(pdVersionLabel(pd), right + 24, mainTop + 52, rightWidth - 48, 16, {
      lines: 1,
      color: palette.muted,
      min: 13,
    });
    if (pdChipLayout.fitted && pdChips.length) {
      drawChips(pdChipLayout, right + 24, mainTop + 86);
    } else if (pdChips.length) {
      drawText(pdChips.join(' · '), right + 24, mainTop + 86, rightWidth - 48, 14, {
        lines: 2,
        color: palette.accent,
        mono: true,
        min: 12,
      });
    }
  } else {
    drawText(t('protocolReportNoPdos'), right + 24, mainTop + 52, rightWidth - 48, 16, {
      color: palette.muted,
      min: 13,
    });
  }

  const pdos = report.pdos ?? [];
  const tableTop = mainTop + pdCardHeight + rightCardGap;
  let infoHeight = 122;
  let tableHeight = mainBottom - infoHeight - rightCardGap - tableTop;
  let tableRowHeight = pdos.length ? Math.min(62, Math.floor((tableHeight - 108) / pdos.length)) : 120;
  if (pdos.length && tableRowHeight < 24) {
    infoHeight = 96;
    tableHeight = mainBottom - infoHeight - rightCardGap - tableTop;
    tableRowHeight = Math.min(62, Math.floor((tableHeight - 108) / pdos.length));
  }
  if (pdos.length && tableRowHeight < 24) throw overflow();

  // Middle card: Complete PD capabilities table
  card(right, tableTop, rightWidth, tableHeight);
  drawText(t('protocolReportPdoTitle'), right + 24, tableTop + 18, 420, 22, { weight: 700, min: 18 });
  drawText(t('protocolReportPdoScope'), right + 444, tableTop + 23, rightWidth - 468, 13, {
    color: palette.subtle,
    min: 11,
    align: 'right',
  });

  const bandX = right + 20;
  const bandW = rightWidth - 40;
  card(bandX, tableTop + 56, bandW, 34, { fill: palette.surfaceLayer, stroke: null, radius: 8 });
  /** @type {Array<{ label: string, x: number, w: number, align: 'left'|'center'|'right' }>} */
  const pdoCols = [
    { label: '#', x: right + 28, w: 44, align: 'center' },
    { label: t('protocolReportPdoType'), x: right + 84, w: 158, align: 'left' },
    { label: t('voltage'), x: right + 252, w: 236, align: 'right' },
    { label: t('current'), x: right + 500, w: 176, align: 'right' },
    { label: t('power'), x: right + 688, w: 204, align: 'right' },
  ];
  for (const col of pdoCols) {
    drawText(col.label, col.x, tableTop + 64, col.w, 14, {
      color: palette.subtle,
      weight: 600,
      min: 12,
      align: col.align,
    });
  }

  const bodyTop = tableTop + 94;
  if (!pdos.length) {
    drawText(t('protocolReportNoPdos'), right + 24, bodyTop + 28, rightWidth - 48, 17, {
      lines: 2,
      color: palette.muted,
      align: 'center',
      min: 14,
    });
  } else {
    const pdoPillHeight = Math.min(26, Math.max(20, tableRowHeight - 8));
    const pdoFontSize = tableRowHeight >= 34 ? 16 : 14;
    pdos.forEach((pdo, i) => {
      const values = pdoReportParameters(pdo);
      const validVoltage =
        Number.isFinite(pdo.volt_min_mv) &&
        Number.isFinite(pdo.volt_max_mv) &&
        pdo.volt_min_mv > 0 &&
        pdo.volt_max_mv >= pdo.volt_min_mv;
      const voltageRange = pdo.volt_min_mv === pdo.volt_max_mv ? '' : `–${number(pdo.volt_max_mv / 1000)}`;
      const voltage = validVoltage ? `${number(pdo.volt_min_mv / 1000)}${voltageRange} V` : '—';
      const current = values.currentMa
        ? `${number(values.currentMa / 1000)} A${values.currentAtMaxVoltage ? '†' : ''}`
        : '—';
      const powerSuffix = values.powerSource === 'calculated' ? '*' : pdo.kind === 'epr_avs' ? ' PDP' : '';
      const power = values.powerMw ? `${number(values.powerMw / 1000)} W${powerSuffix}` : '—';
      const rowY = bodyTop + i * tableRowHeight;
      const textY = rowY + (tableRowHeight - pdoFontSize * 1.15) / 2;

      drawText(String(pdo.position), pdoCols[0].x, textY, pdoCols[0].w, pdoFontSize - 1, {
        color: palette.subtle,
        weight: 600,
        mono: true,
        align: 'center',
        min: 12,
      });

      const kindText = pdo.kind.replaceAll('_', ' ').toUpperCase();
      const kindFontSize = tableRowHeight >= 34 ? 12 : 11;
      ctx.font = fontSpec(kindFontSize, 600, true);
      const kindPillW = Math.min(pdoCols[1].w, Math.ceil(ctx.measureText(kindText).width) + 20);
      const kindY = rowY + (tableRowHeight - pdoPillHeight) / 2;
      const isPps = pdo.kind === 'pps';
      const isAvs = pdo.kind === 'spr_avs' || pdo.kind === 'epr_avs' || pdo.kind === 'avs';
      const kindFill = isPps ? palette.successBg : isAvs ? hexAlpha(palette.accentFill, 0.13) : palette.surfaceLayer;
      const kindStroke = isPps
        ? hexAlpha(palette.success, 0.34)
        : isAvs
          ? hexAlpha(palette.accentFill, 0.34)
          : palette.cardBorder;
      const kindFg = isPps ? palette.success : isAvs ? palette.accent : palette.muted;
      card(pdoCols[1].x, kindY, kindPillW, pdoPillHeight, {
        fill: kindFill,
        stroke: kindStroke,
        radius: 6,
      });
      drawText(
        kindText,
        pdoCols[1].x + 10,
        kindY + (pdoPillHeight - kindFontSize * 1.1) / 2,
        kindPillW - 20,
        kindFontSize,
        {
          color: kindFg,
          weight: 600,
          mono: true,
          min: 10,
        },
      );

      drawText(voltage, pdoCols[2].x, textY, pdoCols[2].w, pdoFontSize, {
        color: palette.ink,
        mono: true,
        align: 'right',
        min: 12,
      });
      drawText(current, pdoCols[3].x, textY, pdoCols[3].w, pdoFontSize, {
        color: palette.muted,
        mono: true,
        align: 'right',
        min: 12,
      });
      drawText(power, pdoCols[4].x, textY, pdoCols[4].w, pdoFontSize, {
        color: palette.ink,
        weight: 600,
        mono: true,
        align: 'right',
        min: 12,
      });

      if (i < pdos.length - 1) divider(right + 28, rowY + tableRowHeight - 1, rightWidth - 56);
    });
  }

  // Bottom-anchored Conditions card (bottom = mainBottom, aligned with left column)
  const infoY = mainBottom - infoHeight;
  card(right, infoY, rightWidth, infoHeight);
  const compactInfo = infoHeight < 110;
  drawText(t('protocolReportConditions'), right + 24, infoY + (compactInfo ? 11 : 14), rightWidth - 48, 17, {
    weight: 700,
    min: 15,
  });

  const applied = report.context?.applied_pdm;
  const firmwareValue = report.context?.firmware_version ?? '—';
  const pdmVersionValue = report.pdm_version ?? '—';
  const configValue = applied
    ? `PDM: type=${applied.pd_type}, em=${applied.em}, sink=${applied.sink}`
    : t('triggerConfigUnknown');

  const tileY = infoY + (compactInfo ? 38 : 44);
  const tileH = infoY + infoHeight - (compactInfo ? 10 : 14) - tileY;
  const tileGap = 12;
  const innerInfoW = rightWidth - 48;
  const tileWidths = [204, 180, innerInfoW - 204 - 180 - tileGap * 2];
  const tiles = [
    { label: t('triggerFirmware'), value: firmwareValue, mono: true },
    { label: 'PDM', value: pdmVersionValue, mono: true },
    { label: t('protocolControl'), value: configValue, mono: !!applied },
  ];
  let tileX = right + 24;
  tiles.forEach((tile, i) => {
    const w = tileWidths[i];
    card(tileX, tileY, w, tileH, { fill: palette.surfaceLayer, stroke: null, radius: 8 });
    drawText(tile.label, tileX + 14, tileY + (compactInfo ? 6 : 10), w - 28, 12, {
      color: palette.subtle,
      weight: 600,
      min: 11,
    });
    drawText(tile.value, tileX + 14, tileY + (compactInfo ? 23 : 30), w - 28, compactInfo ? 14 : 15, {
      color: tile.value === '—' ? palette.subtle : palette.ink,
      weight: 600,
      mono: tile.mono,
      min: 12,
    });
    tileX += w + tileGap;
  });

  // Footer strip
  const warnings = [];
  if (report.completion !== 'complete') warnings.push(t('protocolReportIncomplete'));
  if (report.reset_verification && report.reset_verification.status !== 'verified') {
    warnings.push(t('triggerResetUnconfirmed'));
  }
  if (warnings.length) {
    badge(warnings.join('  ·  '), margin, 996, contentWidth, 'failed', {
      size: 13,
      minSize: 11,
      withDot: true,
    });
    drawText(t('protocolReportPowerNote'), margin, 1030, contentWidth, 13, {
      lines: 2,
      color: palette.subtle,
      min: 11,
    });
  } else {
    drawText(t('protocolReportPowerNote'), margin, 1004, contentWidth, 14, {
      lines: 2,
      color: palette.subtle,
      min: 12,
    });
  }

  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t('protocolReportRenderFailed')))), 'image/png'),
  );
}
