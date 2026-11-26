// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * @file PD 协议视图的列表行 DOM 渲染、详情树 DOM 渲染及分栏拖拽交互。
 */

import { t } from '../i18n.js';
import {
  directionClass,
  displayType,
  formatBusVI,
  formatDirectionDisplay,
  formatElapsed,
  formatPdSystemTime,
  headerFields,
  hexWordsForEntry,
  isDivider,
  msgTypeClass,
  noteUsesTwoLines,
  objectTables,
} from '../pd-model.js';
import { state } from '../state.js';

/** @typedef {import('../pd-model.js').PdMeta} PdMeta */
/** @typedef {import('../pd-model.js').PdEntry} PdEntry */
/** @typedef {import('../pd-model.js').PdDivider} PdDivider */

const PD_SIDE_MIN_WIDTH = 1400;

/** @param {number} ts */
export function formatPdWallTime(ts) {
  const d = new Date(ts);
  const pad = (/** @type {number} */ n, /** @type {number} */ w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * 按当前时间显示模式格式化 PD 行时间文本与悬停提示。
 * @param {number} t
 * @param {number} origin
 * @param {boolean} useSystemTime
 * @returns {{ text: string, title: string }}
 */
function formatPdRowTime(t, origin, useSystemTime) {
  const elapsed = formatElapsed(t, origin);
  const sysFull = formatPdSystemTime(t);
  if (useSystemTime) {
    return {
      text: formatPdWallTime(t),
      title: sysFull ? `${sysFull} (+${elapsed})` : elapsed,
    };
  }
  return {
    text: elapsed,
    title: sysFull || formatPdWallTime(t),
  };
}

/**
 * @param {string} className
 * @param {string} text
 * @param {string} [title]
 */
function cell(className, text, title) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  if (title) span.title = title;
  return span;
}

/**
 * @param {Element|undefined} el
 * @param {string} text
 * @param {string} [title]
 */
function setCellText(el, text, title) {
  if (!(el instanceof HTMLElement)) return;
  if (el.textContent !== text) el.textContent = text;
  if (title !== undefined && el.title !== title) el.title = title;
}

/** @param {string} direction */
function dirCell(direction) {
  const span = document.createElement('span');
  const tone = directionClass(direction);
  span.className = tone ? `pd-col-dir ${tone}` : 'pd-col-dir';
  span.textContent = direction ? formatDirectionDisplay(direction) : '';
  if (direction) span.title = direction;
  return span;
}

/**
 * @param {PdEntry|PdDivider} entry
 * @param {number} logIndex
 * @param {number} visibleN
 * @param {number} origin
 * @param {{ selectedIndex: number|null, noteColWidth: number, monoAdvance: number, useSystemTime?: boolean }} ctx
 * @returns {HTMLElement}
 */
function buildRow(entry, logIndex, visibleN, origin, ctx) {
  if (isDivider(entry)) {
    const div = document.createElement('div');
    div.className = 'pd-divider-row';
    div.textContent = `── ${formatPdWallTime(entry.t)} ${t('pdDisconnected')} ──`;
    return div;
  }

  const msg = /** @type {PdEntry} */ (entry);
  const row = document.createElement('div');
  row.className = 'pd-row';
  row.tabIndex = 0;
  row.dataset.index = String(logIndex);
  if (ctx.selectedIndex === logIndex) row.classList.add('selected');
  if (noteUsesTwoLines(msg.summary, ctx.noteColWidth, ctx.monoAdvance)) row.classList.add('pd-row-wrap');
  const time = formatPdRowTime(msg.t, origin, ctx.useSystemTime ?? state.settings.useSystemTime);
  const vi = formatBusVI(msg.vbus, msg.ibus);

  row.append(
    cell('pd-col-n', String(visibleN)),
    cell('pd-col-time', time.text, time.title),
    cell('pd-col-sop', msg.sop),
    cell(`pd-col-msg ${msgTypeClass(msg.type)}`, displayType(msg.type)),
    cell('pd-col-id', msg.id ?? ''),
    dirCell(msg.direction ?? ''),
    cell('pd-col-obj', msg.obj ?? ''),
    cell('pd-col-rev', msg.rev ?? ''),
    cell('pd-col-vi', vi, vi ? t('pdBusHint') : undefined),
    cell('pd-col-note', msg.summary, msg.summary),
  );
  return row;
}

/**
 * @param {HTMLElement} row
 * @param {PdEntry} msg
 * @param {number} logIndex
 * @param {number} visibleN
 * @param {number} origin
 * @param {{ selectedIndex: number|null, noteColWidth: number, monoAdvance: number, useSystemTime?: boolean }} ctx
 */
function updateMessageRow(row, msg, logIndex, visibleN, origin, ctx) {
  row.dataset.index = String(logIndex);
  row.classList.toggle('selected', ctx.selectedIndex === logIndex);
  row.classList.toggle('pd-row-wrap', noteUsesTwoLines(msg.summary, ctx.noteColWidth, ctx.monoAdvance));
  const time = formatPdRowTime(msg.t, origin, ctx.useSystemTime ?? state.settings.useSystemTime);
  const vi = formatBusVI(msg.vbus, msg.ibus);
  const kids = row.children;
  setCellText(kids[0], String(visibleN));
  setCellText(kids[1], time.text, time.title);
  setCellText(kids[2], msg.sop);
  if (kids[3]) {
    kids[3].className = `pd-col-msg ${msgTypeClass(msg.type)}`;
    setCellText(kids[3], displayType(msg.type));
  }
  setCellText(kids[4], msg.id ?? '');
  if (kids[5] instanceof HTMLElement) {
    const tone = directionClass(msg.direction ?? '');
    kids[5].className = tone ? `pd-col-dir ${tone}` : 'pd-col-dir';
    kids[5].textContent = msg.direction ? formatDirectionDisplay(msg.direction) : '';
    kids[5].title = msg.direction || '';
  }
  setCellText(kids[6], msg.obj ?? '');
  setCellText(kids[7], msg.rev ?? '');
  setCellText(kids[8], vi, vi ? t('pdBusHint') : '');
  setCellText(kids[9], msg.summary, msg.summary);
}

/**
 * 视口行就地补丁：同类行改文字，类型变了才换节点。
 * @param {HTMLElement|null} listWindow
 * @param {(PdEntry|PdDivider)[]} log
 * @param {number[]} filtered
 * @param {number} start
 * @param {number} end
 * @param {number} origin
 * @param {{ selectedIndex: number|null, noteColWidth: number, monoAdvance: number, useSystemTime?: boolean }} ctx
 */
export function patchPdWindow(listWindow, log, filtered, start, end, origin, ctx) {
  if (!listWindow) return;
  let node = listWindow.firstChild;
  for (let i = start; i < end; i++) {
    const logIndex = filtered[i];
    const entry = log[logIndex];
    if (!entry) continue;
    const wantDivider = isDivider(entry);
    const reusable =
      node instanceof HTMLElement &&
      (wantDivider ? node.classList.contains('pd-divider-row') : node.classList.contains('pd-row'));
    if (reusable && node instanceof HTMLElement) {
      if (wantDivider) {
        const text = `── ${formatPdWallTime(entry.t)} ${t('pdDisconnected')} ──`;
        if (node.textContent !== text) node.textContent = text;
      } else {
        updateMessageRow(node, /** @type {PdEntry} */ (entry), logIndex, i + 1, origin, ctx);
      }
      node = node.nextSibling;
      continue;
    }
    const next = buildRow(entry, logIndex, i + 1, origin, ctx);
    if (node instanceof HTMLElement) {
      node.replaceWith(next);
      node = next.nextSibling;
    } else {
      listWindow.appendChild(next);
    }
  }
  while (node) {
    const dead = node;
    node = node.nextSibling;
    dead.remove();
  }
}

/**
 * @param {string} sop
 * @param {{ label: string, hex: string }[]} words
 */
function buildHexStrip(sop, words) {
  const table = document.createElement('table');
  table.className = 'pd-hex-strip';
  const head = document.createElement('tr');
  const body = document.createElement('tr');
  const sopTh = document.createElement('th');
  sopTh.textContent = 'SOP*';
  const sopTd = document.createElement('td');
  sopTd.textContent = sop || '—';
  head.appendChild(sopTh);
  body.appendChild(sopTd);
  for (const word of words) {
    const th = document.createElement('th');
    th.textContent = word.label;
    const td = document.createElement('td');
    td.textContent = word.hex;
    head.appendChild(th);
    body.appendChild(td);
  }
  table.append(head, body);
  return table;
}

/**
 * @param {{ label: string, value: string, className?: string }[]} fields
 * @param {string} extraClass
 */
function buildKvTable(fields, extraClass) {
  const table = document.createElement('table');
  table.className = `pd-kv-table ${extraClass}`;
  const head = document.createElement('tr');
  const body = document.createElement('tr');
  for (const field of fields) {
    const th = document.createElement('th');
    th.textContent = field.label;
    const td = document.createElement('td');
    td.textContent = field.value;
    if (field.className) td.className = field.className;
    head.appendChild(th);
    body.appendChild(td);
  }
  table.append(head, body);
  return table;
}

/**
 * @param {PdEntry} entry
 * @param {PdMeta} meta
 */
export function buildPdDetail(entry, meta) {
  const wrap = document.createElement('div');
  wrap.className = 'pd-detail-stack';

  const vi = formatBusVI(entry.vbus, entry.ibus);
  if (vi) {
    const sample = document.createElement('div');
    sample.className = 'pd-detail-vi';
    sample.title = t('pdBusHint');
    sample.textContent = `V/I  ${vi}`;
    wrap.appendChild(sample);
  }

  const words = hexWordsForEntry(entry);
  if (words.length) wrap.appendChild(buildHexStrip(entry.sop, words));

  const header = headerFields(meta);
  if (header.length) wrap.appendChild(buildKvTable(header, 'pd-header-table'));

  for (const obj of objectTables(meta)) {
    if (obj.fields.length === 0 && !obj.chip && !obj.hex) continue;
    const block = document.createElement('div');
    block.className = 'pd-object-block';
    const title = document.createElement('div');
    title.className = 'pd-object-title';
    const name = document.createElement('span');
    name.textContent = obj.title;
    title.appendChild(name);
    if (obj.chip) {
      const chip = document.createElement('span');
      chip.className = 'pd-object-chip';
      chip.textContent = obj.chip;
      title.appendChild(chip);
    }
    if (obj.hex) {
      const hex = document.createElement('span');
      hex.className = 'pd-object-hex';
      hex.textContent = obj.hex;
      title.appendChild(hex);
    }
    block.appendChild(title);
    if (obj.fields.length) block.appendChild(buildKvTable(obj.fields, 'pd-object-table'));
    wrap.appendChild(block);
  }

  return wrap;
}

/**
 * 按偏好与窗口宽度应用 PD 分栏方向。宽屏（≥1400px）且偏好开启时左右分栏。
 * @param {{
 *   split: () => HTMLElement|null,
 *   splitter: () => HTMLElement|null,
 *   layoutBtn: () => HTMLButtonElement|null,
 *   layoutIcon: () => HTMLElement|null,
 * }} els
 * @param {() => void} onLayoutApplied
 */
export function applyPdSplitLayoutDom(els, onLayoutApplied) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const split = els.split();
  const handle = els.splitter();
  const btn = els.layoutBtn();
  const icon = els.layoutIcon();
  const preferSide = state.settings.pdSplitSide === true;
  const side = preferSide && window.innerWidth >= PD_SIDE_MIN_WIDTH;
  split?.classList.toggle('pd-split-side', side);
  if (handle) {
    handle.style.cursor = side ? 'col-resize' : 'row-resize';
    handle.setAttribute('aria-orientation', side ? 'vertical' : 'horizontal');
    handle.setAttribute('aria-label', side ? t('pdAdjustWidth') : t('pdAdjustHeight'));
  }
  if (btn) {
    btn.setAttribute('aria-pressed', String(preferSide));
    btn.title = preferSide ? t('pdSplitBack') : t('pdSplitSide');
    btn.setAttribute('aria-label', btn.title);
  }
  if (icon) {
    icon.classList.toggle('fi-split-side', !preferSide);
    icon.classList.toggle('fi-split', preferSide);
  }
  onLayoutApplied();
}

/**
 * 绑定上下/左右分栏手柄拖拽与键盘微调。
 * @param {HTMLElement|null} split
 * @param {HTMLElement|null} handle
 * @param {() => void} onDragEnd
 */
export function initPdSplitter(split, handle, onDragEnd) {
  if (!split || !handle) return;

  /** @param {number} listRatio */
  const apply = (listRatio) => {
    const clamped = Math.min(0.8, Math.max(0.22, listRatio));
    split.style.setProperty('--pd-list-basis', `${(clamped * 100).toFixed(1)}%`);
    split.style.setProperty('--pd-detail-basis', `${((1 - clamped) * 100).toFixed(1)}%`);
    handle.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
  };

  /** @type {number|null} */
  let pointer = null;
  /** @param {PointerEvent} e */
  const endDrag = (e) => {
    if (pointer === null || e.pointerId !== pointer) return;
    pointer = null;
    onDragEnd();
  };
  handle.addEventListener('pointerdown', (e) => {
    pointer = e.pointerId;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (pointer === null || !handle.hasPointerCapture(e.pointerId)) return;
    const rect = split.getBoundingClientRect();
    const side = split.classList.contains('pd-split-side');
    if (side) {
      if (rect.width <= 0) return;
      apply((e.clientX - rect.left) / rect.width);
    } else {
      if (rect.height <= 0) return;
      apply((e.clientY - rect.top) / rect.height);
    }
  });
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('lostpointercapture', endDrag);
  handle.addEventListener('keydown', (e) => {
    const side = split.classList.contains('pd-split-side');
    const shrink = side ? 'ArrowLeft' : 'ArrowUp';
    const grow = side ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== shrink && e.key !== grow) return;
    e.preventDefault();
    const current = Number.parseFloat(getComputedStyle(split).getPropertyValue('--pd-list-basis')) / 100;
    const basis = Number.isFinite(current) ? current : 0.56;
    apply(basis + (e.key === shrink ? -0.04 : 0.04));
  });
}
