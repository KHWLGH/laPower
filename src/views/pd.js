// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * @file PD 协议分析视图 — pd-data 接收、可增长日志、虚拟列表。
 *
 * pd-data 在后端不节流（每个 0xFE 报文即时发射），因此：
 * - 监听在 app.js 启动时就注册（插拔瞬间的握手报文最有价值，不等用户打开 Tab）；
 * - 日志可增长，不丢最旧；渲染只挂视口附近的行；
 * - 视图隐藏时完全跳过 DOM 工作，重新显示时重建过滤索引并同步窗口。
 * - 布局为上表 + 下详情：点击行选中，详情按 hex 字 / Header 表 / 对象表渲染。
 */

import { runCooperativeSlices } from '../cooperative.js';
import { errorText, t } from '../i18n.js';
import {
  buildRowOffsets,
  createPdProjection,
  filterIndices,
  isDivider,
  matchesFilter,
  nextMessageIndex,
  normalizePdPayload,
  PD_ROW_HEIGHT,
  PD_SOFT_CAP,
  rowHeightOf,
  visibleRangeByOffsets,
} from '../pd-model.js';
import { debouncedSaveSettings } from '../settings.js';
import { state } from '../state.js';
import { syncPdCaptureUI } from '../ui/controlbar.js';
import { ask } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { applyPdSplitLayoutDom, buildPdDetail, initPdSplitter, patchPdWindow } from './pd-list.js';
import { createPdTransferActions } from './pd-transfer.js';

/** @typedef {import('../pd-model.js').PdMeta} PdMeta */
/** @typedef {import('../pd-model.js').PdEntry} PdEntry */
/** @typedef {import('../pd-model.js').PdDivider} PdDivider */

/** @type {(PdEntry|PdDivider)[]} */
const log = [];
/** First message timestamp is invariant across append; scrolling never scans the log. */
/** @type {number|null} */
let originTime = null;
/** 过滤后的日志下标。 */
/** @type {number[]} */
let filtered = [];

let paused = false;
let bufferedWhilePaused = 0;
let renderScheduled = false;
let renderFrame = 0;
let followTailPending = false;
let initialized = false;
let softCapWarned = false;
/** 已连续消费的 seq；跳号时暂停实时追加，由单个分页任务追赶。 */
let lastIngestedSeq = -1;
/** 与后端 `PdLog.generation` 对齐；导入 / 清空后用来丢掉过期的实时事件。 */
let acceptedGen = /** @type {number|null} */ (null);
/** 导入或清空进行中，暂不接受实时事件。 */
let ingestSuspended = false;

let dataRevision = 0;
let detailRevision = 0;
let recoveryTarget = -1;
/** @type {{revision:number, promise:Promise<void>}|null} */
let recoveryWork = null;
/** @type {PdDivider[]} */
const pendingDividers = [];
let lastDisconnectTarget = -1;

function invalidatePdWork() {
  dataRevision++;
  detailRevision++;
  recoveryWork = null;
  recoveryTarget = -1;
  pendingDividers.length = 0;
  lastDisconnectTarget = -1;
}

/** 当前选中的日志下标。 */
/** @type {number|null} */
let selectedIndex = null;

/** @type {Map<number, PdMeta>} */
const metaCache = new Map();

/** @type {HTMLElement|null} */
let listSpacer = null;
/** @type {HTMLElement|null} */
let listWindow = null;

/** 过滤行顶边前缀和，长度 = filtered.length + 1。 */
/** @type {number[]} */
let rowOffsets = [0];
let noteColWidth = 0;
let monoAdvance = 0;
let metricsDirty = true;
/** @type {{cancelled: boolean,key:string}|null} */
let projectionWork = null;
let projectionKey = '';
let projectedLength = 0;
let projectionScheduled = false;
let projectionFrame = 0;
let showing = false;
let showRevision = 0;

function currentProjectionKey() {
  return JSON.stringify([dataRevision, currentFilterText(), currentHideGoodCrc(), noteColWidth, monoAdvance]);
}

function cancelProjection() {
  if (projectionWork) projectionWork.cancelled = true;
  projectionWork = null;
  if (!viewHidden()) els.list()?.setAttribute?.('aria-busy', 'false');
}

// ─── 摘取 DOM ────────────────────────────────────────────────────────────────

const els = {
  /** @returns {HTMLElement|null} */
  list: () => document.getElementById('pd-list'),
  empty: () => document.getElementById('pd-empty'),
  counter: () => document.getElementById('pd-counter'),
  view: () => document.getElementById('view-pd'),
  pauseBtn: () => /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pd-pause')),
  clearBtn: () => /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pd-clear')),
  exportBtn: () => /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pd-export')),
  importBtn: () => /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pd-import')),
  filter: () => /** @type {HTMLInputElement|null} */ (document.getElementById('pd-filter')),
  hideGoodCrc: () => /** @type {HTMLInputElement|null} */ (document.getElementById('pd-hide-goodcrc')),
  autoscroll: () => /** @type {HTMLInputElement|null} */ (document.getElementById('pd-autoscroll')),
  followRecording: () => /** @type {HTMLInputElement|null} */ (document.getElementById('pd-follow-recording')),
  detailBody: () => document.getElementById('pd-detail-body'),
  detailEmpty: () => document.getElementById('pd-detail-empty'),
  tableHead: () => document.getElementById('pd-table-head'),
  split: () => document.getElementById('pd-split'),
  splitter: () => document.getElementById('pd-splitter'),
  layoutBtn: () => /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-pd-layout')),
  layoutIcon: () => document.getElementById('pd-layout-icon'),
};

function currentFilterText() {
  return els.filter()?.value ?? '';
}

function currentHideGoodCrc() {
  return els.hideGoodCrc()?.checked ?? true;
}

function autoscrollEnabled() {
  return els.autoscroll()?.checked ?? true;
}

function followRecordingEnabled() {
  return state.settings.pdFollowRecording;
}

function viewHidden() {
  return !state.windowVisible || document.hidden || (els.view()?.hidden ?? true);
}

/** @param {string} cmd @param {Record<string, unknown>} [args] */
function invokeCmd(cmd, args) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') return Promise.resolve(null);
  return invoke(cmd, args);
}

function pdCaptureEnabled() {
  return !followRecordingEnabled() || state.isRecording;
}

function syncBackendCaptureFlag() {
  void invokeCmd('set_pd_capture_enabled', { enabled: pdCaptureEnabled() });
}

// ─── 摄入 ────────────────────────────────────────────────────────────────────

/**
 * @param {PdEntry|PdDivider} entry
 */
function rememberSeq(entry) {
  if (!isDivider(entry) && Number.isFinite(entry.seq) && /** @type {number} */ (entry.seq) > lastIngestedSeq) {
    lastIngestedSeq = /** @type {number} */ (entry.seq);
  }
}

/**
 * @param {unknown} payload
 * @param {boolean} [live=true] 实时事件才走跟随记录门控；补洞 / 导入回放关掉。
 * @returns {boolean} 是否写入了一条日志
 */
function ingestOne(payload, live = true) {
  if (live && ingestSuspended) return false;
  if (live && followRecordingEnabled() && !state.isRecording) return false;
  const entry = normalizePdPayload(payload);
  if (!entry) return false;
  if (!isDivider(entry)) {
    const gen = Number.isFinite(entry.gen) ? /** @type {number} */ (entry.gen) : null;
    if (gen !== null) {
      if (acceptedGen === -1) return false;
      if (acceptedGen !== null && gen !== acceptedGen) return false;
      acceptedGen = gen;
    }
    const seq = entry.seq;
    if (seq !== undefined && Number.isSafeInteger(seq)) {
      if (seq <= lastIngestedSeq) return false;
      if (live) {
        recoveryTarget = Math.max(recoveryTarget, seq);
        if (recoveryWork || seq !== lastIngestedSeq + 1) {
          void fillPdGap();
          return false;
        }
      } else if (seq !== lastIngestedSeq + 1) {
        return false;
      }
    }
    while (pendingDividers.length && pendingDividers[0].t < entry.t) {
      ingestOne(pendingDividers.shift(), false);
    }
  }
  rememberSeq(entry);
  log.push(entry);
  if (log.length === 1) document.dispatchEvent?.(new Event('lapower:export-availability-changed'));
  if (originTime === null && !isDivider(entry)) originTime = entry.t;
  if (log.length === PD_SOFT_CAP && !softCapWarned) {
    softCapWarned = true;
    toast.warning(() => t('pdSoftCap', { count: PD_SOFT_CAP }));
  }
  if (paused) {
    bufferedWhilePaused++;
    return true;
  }
  if (viewHidden()) return true;
  // Append only to a complete projection of the immediately preceding prefix.
  // Input may change away and back before its coalesced task runs.
  if (
    projectionWork ||
    projectionScheduled ||
    showing ||
    projectedLength !== log.length - 1 ||
    projectionKey !== currentProjectionKey()
  )
    return true;
  if (matchesFilter(entry, currentFilterText(), currentHideGoodCrc())) {
    filtered.push(log.length - 1);
    appendRowOffset(entry);
  }
  projectedLength = log.length;
  return true;
}

/**
 * app.js 的 pd-data / 单条路径入口（测试与导入回放也走这里）。
 * @param {unknown} payload
 */
export function ingestPdData(payload) {
  if (!ingestOne(payload)) return;
  if (paused) {
    updateCounter();
    return;
  }
  if (viewHidden()) return;
  scheduleWindowSync(true);
}

/**
 * 后端按帧合并后的 `pd-data-batch`：先全部入库，再只排一次窗口同步。
 * @param {unknown} payloads
 * @param {boolean} [live=true]
 */
export function ingestPdBatch(payloads, live = true) {
  if (!Array.isArray(payloads) || payloads.length === 0) return;
  let added = 0;
  for (const payload of payloads) {
    if (ingestOne(payload, live)) added += 1;
  }
  if (!added) return;
  if (paused) {
    updateCounter();
    return;
  }
  if (viewHidden()) return;
  scheduleWindowSync(true);
}

/**
 * 切回 PD 视图时按 seq 向后端补齐可能漏掉的报文。
 */
export function fillPdGap() {
  if (ingestSuspended || acceptedGen === -1) return Promise.resolve();
  if (recoveryWork) return recoveryWork.promise;
  const revision = dataRevision;
  const work = { revision, promise: Promise.resolve() };
  recoveryWork = work;
  work.promise = (async () => {
    let throughSeq = null;
    try {
      do {
        const page = /** @type {TauriAPI.PdPage|null} */ (
          await invokeCmd('pd_log_after', {
            generation: acceptedGen,
            afterSeq: lastIngestedSeq >= 0 ? lastIngestedSeq : null,
            throughSeq,
          })
        );
        if (revision !== dataRevision || !page) return;
        if (acceptedGen !== null && page.generation !== acceptedGen) return;
        acceptedGen = page.generation;
        throughSeq = page.throughSeq;
        const before = lastIngestedSeq;
        ingestPdBatch(page.events, false);
        if (throughSeq !== null && lastIngestedSeq < throughSeq) {
          if (lastIngestedSeq === before) throw new Error('PD recovery made no progress');
        } else {
          if (lastIngestedSeq >= recoveryTarget) break;
          if (lastIngestedSeq === before) throw new Error('PD recovery target unavailable');
          throughSeq = null;
        }
      } while (revision === dataRevision);
      if (revision === dataRevision) {
        while (pendingDividers.length) ingestPdBatch([pendingDividers.shift()], false);
      }
    } catch (error) {
      if (revision === dataRevision) console.error(error);
    } finally {
      if (recoveryWork === work) recoveryWork = null;
    }
  })();
  return work.promise;
}

/** 当前 PD 日志中的条目数（用于诊断与测试）。 */
export function getPdBufferLength() {
  return log.length;
}

/** Independent of view initialization, filters and subsequent log replacement. */
export function capturePdSnapshot() {
  // Entries are immutable after ingestion; only the containing log is appended/replaced.
  return log.slice();
}

/**
 * 当前 PD 采集状态（供命令栏镜像与测试断言）。
 * - paused：手动暂停（报文仍进缓冲，仅停止渲染）—— 仅在跟随记录关闭时可达
 * - followSuspended：跟随记录启用且未在记录（报文在 ingest 处直接丢弃）
 * - capturing：既未手动暂停也未被跟随挂起
 */
export function getPdCaptureState() {
  const followSuspended = followRecordingEnabled() && !state.isRecording;
  return { paused, followSuspended, capturing: !paused && !followSuspended };
}

/**
 * 把当前状态同步到 PD 命令栏：采集按钮外观 + 计数器。
 */
function syncPdUi() {
  const follow = followRecordingEnabled();
  syncPdCaptureUI(getPdCaptureState(), {
    followEnabled: follow,
    connected: state.isConnected,
    recording: state.isRecording,
  });
  const button = els.pauseBtn();
  if (button && initialized) button.disabled = follow && !state.isConnected;
  updateCounter();
  syncBackendCaptureFlag();
}

document.addEventListener?.('witrn:monitor-changed', () => {
  syncPdUi();
  // 点开始后后端门已开、本地 ingest 刚放行：把等待期间入库的握手补进来。
  if (state.isRecording) void fillPdGap();
});

/** 设备断开时插入分隔行，区分两次会话。 */
export function markPdDisconnect() {
  if (ingestSuspended || acceptedGen === -1) return;
  if (pendingDividers.length && lastDisconnectTarget === recoveryTarget) return;
  if (log.length > 0 && isDivider(log[log.length - 1]) && lastIngestedSeq === recoveryTarget) return;
  if (!log.length && !recoveryWork) return;
  lastDisconnectTarget = recoveryTarget;
  pendingDividers.push({ t: Date.now(), divider: true });
  void fillPdGap();
}

// ─── 虚拟列表 ────────────────────────────────────────────────────────────────

function ensureListStructure() {
  const list = els.list();
  if (!list) return null;
  if (!listSpacer || !listWindow || listSpacer.parentElement !== list) {
    list.replaceChildren();
    const spacer = document.createElement('div');
    spacer.className = 'pd-list-spacer';
    const win = document.createElement('div');
    win.className = 'pd-list-window';
    spacer.appendChild(win);
    list.appendChild(spacer);
    listSpacer = spacer;
    listWindow = win;
  }
  return list;
}

/** @param {boolean} [followTail=false] */
function scheduleWindowSync(followTail = false) {
  if (viewHidden()) return;
  if (followTail) followTailPending = true;
  if (renderScheduled) return;
  renderScheduled = true;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    renderScheduled = false;
    const follow = followTailPending;
    followTailPending = false;
    syncWindow(follow);
  });
}

/**
 * @param {boolean} [followTail]
 */
function syncWindow(followTail = false) {
  if (viewHidden() || showing) return;
  const list = ensureListStructure();
  if (!list || !listSpacer || !listWindow) {
    updateCounter();
    return;
  }

  if (metricsDirty || noteColWidth === 0 || monoAdvance === 0) {
    refreshRowMetrics();
    metricsDirty = false;
  }
  if (projectionWork || projectionScheduled) return;
  if (projectionKey !== currentProjectionKey() || (!paused && projectedLength !== log.length)) {
    rebuildFilterAndWindow();
    return;
  }
  if (rowOffsets.length !== filtered.length + 1) rebuildRowOffsets();
  const total = rowOffsets[rowOffsets.length - 1] ?? 0;
  // Publish the scroll extent first: setting scrollTop against the old, shorter
  // filter would clamp it and leave follow mode in the middle of the new list.
  listSpacer.style.height = `${total}px`;

  if (followTail && autoscrollEnabled()) {
    list.scrollTop = total;
  }

  const { start, end } = visibleRangeByOffsets(rowOffsets, list.scrollTop, list.clientHeight);
  listWindow.style.transform = `translateY(${rowOffsets[start] ?? 0}px)`;

  const origin = originTime ?? 0;
  patchWindow(start, end, origin);

  updateEmptyState();
  updateCounter();
}

function rebuildFilterAndWindow() {
  if (projectionWork && projectionWork.key !== currentProjectionKey()) cancelProjection();
  if (viewHidden() || showing || projectionScheduled) return;
  projectionScheduled = true;
  projectionFrame = requestAnimationFrame(() => {
    projectionFrame = 0;
    projectionScheduled = false;
    if (!viewHidden() && !showing) rebuildProjection();
  });
}

function rebuildProjection() {
  const width = measureNoteColWidth();
  if (width > 0) noteColWidth = width;
  if (!monoAdvance) monoAdvance = measureMonoAdvance();
  const key = currentProjectionKey();
  if (projectionWork?.key === key) return;
  if (projectionKey === key && projectedLength === log.length) {
    syncWindow(autoscrollEnabled());
    return;
  }
  cancelProjection();
  if (log.length > 4096) {
    const next = createPdProjection(log, currentFilterText(), currentHideGoodCrc(), noteColWidth, monoAdvance);
    const work = { cancelled: false, key };
    projectionWork = work;
    els.list()?.setAttribute?.('aria-busy', 'true');
    void runCooperativeSlices(() => next.step(), { isCancelled: () => work.cancelled || viewHidden() })
      .then((complete) => {
        if (projectionWork !== work) return;
        projectionWork = null;
        if (!viewHidden()) els.list()?.setAttribute?.('aria-busy', 'false');
        if (!complete || key !== currentProjectionKey()) {
          rebuildFilterAndWindow();
          return;
        }
        filtered = next.indices;
        rowOffsets = next.offsets;
        projectionKey = key;
        projectedLength = log.length;
        if (selectedIndex !== null && !filtered.includes(selectedIndex)) clearSelection();
        syncWindow(autoscrollEnabled());
      })
      .catch((error) => {
        if (projectionWork === work) cancelProjection();
        console.error(error);
        toast.error(() => t('pdListUpdateFailed'));
      });
    return;
  }
  filtered = filterIndices(log, currentFilterText(), currentHideGoodCrc());
  rebuildRowOffsets();
  projectionKey = key;
  projectedLength = log.length;
  if (selectedIndex !== null) {
    const still = filtered.includes(selectedIndex);
    if (!still) clearSelection();
  }
  syncWindow(autoscrollEnabled());
}

function measureNoteColWidth() {
  const head = els.tableHead();
  if (!head || viewHidden()) return 0;
  // Empty lists hide the header. Measure its final layout before scanning the log,
  // then restore it in the same task so no provisional header is painted.
  const hidden = head.hidden;
  if (hidden) head.hidden = false;
  try {
    const width = head.querySelector('.pd-col-note')?.getBoundingClientRect().width ?? 0;
    return width > 1 ? width : 0;
  } finally {
    if (hidden) head.hidden = true;
  }
}

function measureMonoAdvance() {
  const probe = document.createElement('span');
  probe.className = 'pd-note-probe';
  probe.textContent = '0000000000';
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return width > 0 ? width : 7;
}

function refreshRowMetrics() {
  const nextWidth = measureNoteColWidth();
  const oldAdvance = monoAdvance;
  if (!monoAdvance) monoAdvance = measureMonoAdvance();
  if ((nextWidth > 0 && Math.abs(nextWidth - noteColWidth) > 0.5) || oldAdvance !== monoAdvance) {
    if (nextWidth > 0) noteColWidth = nextWidth;
    rebuildRowOffsets();
  }
}

function rebuildRowOffsets() {
  if (log.length > 4096) {
    rebuildFilterAndWindow();
    return;
  }
  rowOffsets = buildRowOffsets(log, filtered, noteColWidth, monoAdvance);
}

/**
 * 视口行就地补丁：同类行改文字，类型变了才换节点。
 * @param {number} start
 * @param {number} end
 * @param {number} origin
 */
function patchWindow(start, end, origin) {
  patchPdWindow(listWindow, log, filtered, start, end, origin, {
    selectedIndex,
    noteColWidth,
    monoAdvance,
  });
}

/** @param {PdEntry|PdDivider} entry */
function appendRowOffset(entry) {
  if (rowOffsets.length !== filtered.length) {
    rebuildRowOffsets();
    return;
  }
  rowOffsets.push(rowOffsets[rowOffsets.length - 1] + rowHeightOf(entry, noteColWidth, monoAdvance));
}

/** @param {1|-1} dir */
function moveSelection(dir) {
  const from = selectedIndex === null ? (dir > 0 ? -1 : filtered.length) : filtered.indexOf(selectedIndex);
  const next = nextMessageIndex(log, filtered, from, dir);
  if (next < 0) return;
  const pos = filtered.indexOf(next);
  const list = els.list();
  if (list && pos >= 0) {
    const rowTop = rowOffsets[pos] ?? pos * PD_ROW_HEIGHT;
    const rowBot = rowOffsets[pos + 1] ?? rowTop + PD_ROW_HEIGHT;
    if (rowTop < list.scrollTop) list.scrollTop = rowTop;
    else if (rowBot > list.scrollTop + list.clientHeight) list.scrollTop = rowBot - list.clientHeight;
  }
  syncWindow();
  const row = listWindow?.querySelector(`[data-index="${next}"]`);
  void selectPdEntry(next, row instanceof HTMLElement ? row : null);
  if (row instanceof HTMLElement) row.focus();
}

/**
 * @param {number} logIndex
 * @param {HTMLElement|null} [row]
 */
export async function selectPdEntry(logIndex, row = null) {
  const entry = log[logIndex];
  if (!entry || isDivider(entry)) return;
  if (selectedIndex === logIndex && row?.classList.contains('selected')) return;
  selectedIndex = logIndex;
  if (listWindow) {
    for (const el of listWindow.querySelectorAll('.pd-row.selected')) el.classList.remove('selected');
  }
  row?.classList.add('selected');
  await renderDetail(/** @type {PdEntry} */ (entry), logIndex);
}

/**
 * @param {PdEntry} entry
 * @param {number} logIndex
 */
async function renderDetail(entry, logIndex) {
  const revision = dataRevision;
  const request = ++detailRevision;
  const current = () =>
    revision === dataRevision && request === detailRevision && selectedIndex === logIndex && log[logIndex] === entry;
  let meta = entry.meta ?? metaCache.get(logIndex) ?? null;
  if (!meta && Number.isFinite(entry.seq)) {
    try {
      const decoded = await invokeCmd('decode_pd_at', { index: entry.seq, generation: entry.gen ?? acceptedGen });
      if (decoded && typeof decoded === 'object') meta = /** @type {PdMeta} */ (decoded);
    } catch (e) {
      if (!current()) return;
      console.error(e);
      toast.error(() => t('decodeFailed', { detail: errorText(e) }));
      return;
    }
  }
  if (!current()) return;
  if (!meta) {
    toast.warning(() => t('noDecodeResult'));
    return;
  }
  cacheMeta(logIndex, meta);
  const body = els.detailBody();
  if (!body) return;
  body.replaceChildren(buildPdDetail(entry, meta));
  body.hidden = false;
  const empty = els.detailEmpty();
  if (empty) empty.hidden = true;
}

/** @param {number} index @param {PdMeta} meta */
function cacheMeta(index, meta) {
  metaCache.delete(index);
  metaCache.set(index, meta);
  if (metaCache.size > 8) {
    const first = metaCache.keys().next().value;
    if (first !== undefined) metaCache.delete(first);
  }
}

function clearSelection() {
  detailRevision++;
  selectedIndex = null;
  if (listWindow) {
    for (const el of listWindow.querySelectorAll('.pd-row.selected')) el.classList.remove('selected');
  }
  const body = els.detailBody();
  if (body) {
    body.hidden = true;
    body.replaceChildren();
  }
  const empty = els.detailEmpty();
  if (empty) empty.hidden = false;
}

// ─── 清空 ────────────────────────────────────────────────────────────────────

/**
 * 纯清空：无确认、无联动。监控面板的「一键重置」在跟随记录开启时调用它，
 * 两侧各自只调用对方的无级联版本，因此不会互相递归。
 */
export function clearPdEntries() {
  invalidatePdWork();
  const revision = dataRevision;
  cancelProjection();
  const hadData = log.length > 0;
  log.length = 0;
  if (hadData) document.dispatchEvent?.(new Event('lapower:export-availability-changed'));
  originTime = null;
  filtered = [];
  rowOffsets = [0];
  bufferedWhilePaused = 0;
  softCapWarned = false;
  lastIngestedSeq = -1;
  acceptedGen = -1;
  metaCache.clear();
  clearSelection();
  void invokeCmd('pd_log_clear')
    .then((gen) => {
      if (revision !== dataRevision) return;
      acceptedGen = typeof gen === 'number' && Number.isFinite(gen) ? gen : null;
    })
    .catch((e) => {
      if (revision !== dataRevision) return;
      console.error(e);
      acceptedGen = null;
      toast.error(() => t('clearPdLogFailed', { detail: errorText(e) }));
    });
  rebuildFilterAndWindow();
}

/**
 * 「清空」动作：确认 → 清空 → 跟随记录开启时级联清空监控数据。
 */
export async function requestPdClear() {
  const follow = followRecordingEnabled();
  if (log.length === 0 && !follow) return;

  const confirmed = await ask(
    () =>
      (log.length > 0 ? t('clearPdPromptCount', { count: log.length }) : t('clearPdPromptEmpty')) +
      (follow ? `\n${t('clearPdLinkedPrompt')}` : ''),
    { title: () => t('clear'), kind: follow ? 'error' : 'warning' },
  );
  if (!confirmed) return;

  clearPdEntries();
  if (follow) state.__clearMonitorData?.();
}

// ─── 导入 / 导出 ─────────────────────────────────────────────────────────────

const pdTransfer = createPdTransferActions({
  getLog: () => log,
  isIngestSuspended: () => ingestSuspended,
  setIngestSuspended: (suspended) => {
    ingestSuspended = suspended;
  },
  invalidatePdWork,
  getDataRevision: () => dataRevision,
  invokeCmd,
  resetForImport: (generation) => {
    cancelProjection();
    log.length = 0;
    originTime = null;
    filtered = [];
    rowOffsets = [0];
    projectionKey = '';
    projectedLength = 0;
    bufferedWhilePaused = 0;
    softCapWarned = false;
    lastIngestedSeq = -1;
    acceptedGen = generation;
    metaCache.clear();
    clearSelection();
  },
  appendImportedEntry: (entry) => {
    log.push(entry);
    if (originTime === null && !isDivider(entry)) originTime = entry.t;
    rememberSeq(entry);
    if (!isDivider(entry) && Number.isFinite(entry.gen)) acceptedGen = /** @type {number} */ (entry.gen);
  },
  finishImport: () => {
    rebuildFilterAndWindow();
    document.dispatchEvent?.(new Event('lapower:export-availability-changed'));
  },
  syncBackendCaptureFlag,
});

const exportPdCapture = pdTransfer.exportPdCapture;
export const importPdCapture = pdTransfer.importPdCapture;

// ─── 状态显示 ────────────────────────────────────────────────────────────────

function updateEmptyState() {
  const list = els.list();
  const empty = els.empty();
  const head = els.tableHead();
  const hasRows = filtered.length > 0;
  if (list) list.hidden = !hasRows;
  if (head) head.hidden = !hasRows;
  if (empty) empty.hidden = hasRows;
}

function updateCounter() {
  if (viewHidden()) return;
  const counter = els.counter();
  if (!counter) return;
  const parts = [t('pdCounter', { count: log.length })];
  if (paused && bufferedWhilePaused > 0) parts.push(t('pdBuffered', { count: bufferedWhilePaused }));
  const capture = getPdCaptureState();
  if (!capture.paused && capture.followSuspended) parts.push(t('pdFollowWaiting'));
  counter.textContent = parts.join(' / ');
}

// ─── 视图钩子 ────────────────────────────────────────────────────────────────

/**
 * 按偏好与窗口宽度应用 PD 分栏方向。宽屏（≥1400px）且偏好开启时左右分栏。
 */
export function applyPdSplitLayout() {
  applyPdSplitLayoutDom(els, () => {
    metricsDirty = true;
  });
}

function initSplitter() {
  initPdSplitter(els.split(), els.splitter(), () => {
    metricsDirty = true;
    scheduleWindowSync(false);
  });
}

/** 首次打开 PD 视图：绑定控制条。 */
export function initPdView() {
  if (initialized) return;
  initialized = true;

  const list = els.list();
  if (list) {
    ensureListStructure();
    list.addEventListener('scroll', () => scheduleWindowSync(false), { passive: true });
    list.addEventListener('click', (e) => {
      const hit = e.target instanceof Element ? e.target.closest('.pd-row') : null;
      if (!(hit instanceof HTMLElement) || !list.contains(hit)) return;
      const idx = Number(hit.dataset.index);
      if (Number.isInteger(idx)) void selectPdEntry(idx, hit);
    });
    list.addEventListener('keydown', (e) => {
      const row = e.target instanceof HTMLElement && e.target.classList.contains('pd-row') ? e.target : null;
      if (!row) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const idx = Number(row.dataset.index);
        if (Number.isInteger(idx)) void selectPdEntry(idx, row);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      }
    });
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        metricsDirty = true;
        scheduleWindowSync(false);
      });
      observer.observe(list);
      const head = els.tableHead();
      if (head) observer.observe(head);
    }
  }

  const pauseBtn = els.pauseBtn();
  const clearBtn = els.clearBtn();
  if (pauseBtn) {
    pauseBtn.disabled = false;
    pauseBtn.addEventListener('click', () => {
      if (followRecordingEnabled()) {
        if (!state.isRecording && !state.isConnected) {
          toast.warning(() => t('pleaseConnect'));
          return;
        }
        state.__toggleRecording?.();
        return;
      }

      paused = !paused;
      if (paused) cancelProjection();
      if (!paused) {
        bufferedWhilePaused = 0;
        rebuildFilterAndWindow();
      }
      syncPdUi();
    });
  }
  if (clearBtn) {
    clearBtn.disabled = false;
    clearBtn.addEventListener('click', () => void requestPdClear());
  }

  const exportBtn = els.exportBtn();
  if (exportBtn) {
    exportBtn.disabled = false;
    exportBtn.addEventListener('click', () => void exportPdCapture());
  }
  const importBtn = els.importBtn();
  if (importBtn) {
    importBtn.disabled = false;
    importBtn.addEventListener('click', () => void importPdCapture());
  }

  els.filter()?.addEventListener('input', () => rebuildFilterAndWindow());
  els.hideGoodCrc()?.addEventListener('change', () => rebuildFilterAndWindow());
  const followRecording = els.followRecording();
  if (followRecording) {
    followRecording.checked = state.settings.pdFollowRecording;
    followRecording.addEventListener('change', () => {
      state.settings.pdFollowRecording = followRecording.checked;
      if (followRecording.checked && paused) {
        paused = false;
        bufferedWhilePaused = 0;
        rebuildFilterAndWindow();
      }
      debouncedSaveSettings();
      document.dispatchEvent?.(new CustomEvent('witrn:monitor-changed'));
    });
  }
  const layoutBtn = els.layoutBtn();
  if (layoutBtn) {
    layoutBtn.addEventListener('click', () => {
      state.settings.pdSplitSide = !state.settings.pdSplitSide;
      applyPdSplitLayout();
      debouncedSaveSettings();
    });
  }
  initSplitter();
  applyPdSplitLayout();

  els.autoscroll()?.addEventListener('change', (e) => {
    const listEl = els.list();
    if (/** @type {HTMLInputElement} */ (e.target).checked && listEl) {
      listEl.scrollTop = rowOffsets[rowOffsets.length - 1] ?? 0;
      scheduleWindowSync(false);
    }
  });

  void document.fonts?.ready?.then(() => {
    monoAdvance = 0;
    metricsDirty = true;
    scheduleWindowSync(false);
  });
  document.addEventListener('lapower:fonts-changed', () => {
    monoAdvance = 0;
    metricsDirty = true;
    scheduleWindowSync(false);
  });

  syncPdUi();
}

/** 每次切到 PD 视图：先补 seq 缺口，再重建过滤窗口。 */
export function syncPdView() {
  const revision = ++showRevision;
  showing = true;
  metricsDirty = true;
  els.list()?.setAttribute?.('aria-busy', 'false');
  refreshPdLanguage();
  void fillPdGap().finally(() => {
    if (revision !== showRevision) return;
    showing = false;
    rebuildFilterAndWindow();
  });
}

export function suspendPdView() {
  showRevision++;
  showing = false;
  cancelProjection();
  if (renderFrame) cancelAnimationFrame(renderFrame);
  if (projectionFrame) cancelAnimationFrame(projectionFrame);
  renderFrame = projectionFrame = 0;
  renderScheduled = projectionScheduled = followTailPending = false;
}

/** Refresh state-derived text without changing the capture gate, filters or selection. */
export function refreshPdLanguage() {
  syncPdCaptureUI(getPdCaptureState(), {
    followEnabled: followRecordingEnabled(),
    connected: state.isConnected,
    recording: state.isRecording,
  });
  updateCounter();
  applyPdSplitLayout();
  for (const element of document.querySelectorAll('.pd-detail-vi')) element.setAttribute('title', t('pdBusHint'));
  if (!viewHidden()) syncWindow(false);
}
