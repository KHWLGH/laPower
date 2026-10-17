// @ts-check
/**
 * @file 打点的界面：命令栏「打点」按钮、快捷键 M、标记列表浮出面板。数据规则见 markers.js。
 *
 * 行号在按下的那一刻确定，之后才弹出输入框：对话框开着的时候记录仍在继续，
 * 标记不能漂到用户打完字的那一刻。
 */

import { refreshRecordButton } from './data.js';
import { t } from './i18n.js';
import {
  addMarker,
  MARKER_LABEL_MAX,
  markerRowFor,
  markersOf,
  nearestRow,
  nextMarkerNumber,
  onMarkersChange,
  removeMarker,
  renameMarker,
} from './markers.js';
import { state } from './state.js';
import { promptText } from './ui/dialog.js';
import { createFlyout } from './ui/flyout.js';
import { formatRelativeHMS } from './utils.js';

/** @type {HTMLElement|null} */
let panel = null;
/** @type {ReturnType<typeof createFlyout>|null} */
let flyout = null;
let prompting = false;

/** 光标停在主图上时它下方的原始数据行，否则 null。 */
function rowUnderCursor() {
  const chart = state.mainChart;
  const left = chart?.cursor?.left;
  if (!chart || !Number.isFinite(left) || left < 0) return null;
  return nearestRow(state.chartSeries.x, chart.posToVal(left, 'x'));
}

/**
 * 在给定行添加标记：立即模式直接使用默认标签，否则先弹出输入框。
 * @param {number|null} row 由调用方在按下的那一刻确定
 */
async function addMarkerAt(row) {
  if (prompting || row === null) return;
  const cols = state.chartSeries;
  const fallback = t('markerDefaultLabel', { n: nextMarkerNumber(cols) });
  if (state.settings.immediateMarker) {
    addMarker(cols, row, fallback);
    return;
  }
  prompting = true;
  try {
    const label = await promptText(() => t('markerPrompt'), {
      title: () => t('addMarkerTitle'),
      okLabel: () => t('markerAdd'),
      defaultValue: fallback,
      maxLength: MARKER_LABEL_MAX,
    });
    // 取消，或对话框开着时数据被清空 / 替换：这一行已经不属于当前数据。
    if (label === null || cols !== state.chartSeries) return;
    addMarker(cols, row, label.trim() ? label : fallback);
  } finally {
    prompting = false;
  }
}

/** 命令栏按钮：录制中挂下一行，否则挂最后一行。 */
function addMarkerFromButton() {
  void addMarkerAt(markerRowFor(state.chartSeries.x.length, state.isRecording));
}

/** Central dispatcher captures the row before prompting. */
export function addMarkerFromShortcut() {
  const button = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-add-marker'));
  if (!button || button.disabled) return;
  void addMarkerAt(rowUnderCursor() ?? markerRowFor(state.chartSeries.x.length, state.isRecording));
}

/**
 * @param {object} cols
 * @param {import('./markers.js').Marker} marker
 */
async function renameFromList(cols, marker) {
  if (prompting) return;
  prompting = true;
  try {
    const label = await promptText(() => t('renameMarkerPrompt'), {
      title: () => t('renameMarker'),
      defaultValue: marker.label,
      maxLength: MARKER_LABEL_MAX,
    });
    if (label !== null && cols === state.chartSeries) renameMarker(cols, marker.index, label);
  } finally {
    prompting = false;
  }
}

/** 重建列表（只在面板打开时；条目通常只有几个到几十个）。 */
function renderList() {
  const list = panel?.querySelector('.marker-list');
  if (!panel || panel.hidden || !list) return;
  const cols = state.chartSeries;
  const n = cols.x.length;
  const rows = markersOf(cols).map((marker) => {
    const item = document.createElement('li');
    item.className = 'marker-row';
    const time = document.createElement('span');
    time.className = 'marker-time';
    time.textContent = marker.index < n ? formatRelativeHMS(cols.x.valueAt(marker.index)) : t('markerPending');
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'marker-label';
    label.textContent = marker.label;
    label.title = t('renameMarker');
    label.addEventListener('click', () => void renameFromList(cols, marker));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'cmd-btn cmd-btn-icon marker-delete';
    remove.title = t('deleteMarker');
    remove.setAttribute('aria-label', t('deleteMarker'));
    remove.innerHTML = '<i class="fi fi-dismiss" aria-hidden="true"></i>';
    remove.addEventListener('click', () => removeMarker(cols, marker.index));
    item.append(time, label, remove);
    return item;
  });
  list.replaceChildren(...rows);
}

/** 标记变化：按钮可用状态由 refreshRecordButton 统一同步，列表随之重建。 */
function onChange() {
  refreshRecordButton();
  if (markersOf(state.chartSeries).length === 0) flyout?.close();
  renderList();
}

/** 启动时调用一次。 */
export function initMarkerUI() {
  document.getElementById('btn-add-marker')?.addEventListener('click', addMarkerFromButton);
  const anchor = document.getElementById('btn-flyout-markers');
  panel = document.getElementById('flyout-markers');
  if (anchor && panel) {
    flyout = createFlyout(anchor, panel);
    // createFlyout 的点击处理先打开面板，这里随后填内容。
    anchor.addEventListener('click', renderList);
  }
  onMarkersChange(onChange);
}
