// @ts-check
/**
 * @file 记录打点：用户在某个时刻留下的文字标记（例如充电测试里的「50%」）。
 *
 * 标记挂在一行数据上（行号），而不是挂在时间上：数据只追加不改写，行号稳定，CSV 导出时
 * 标签直接写进那一行的 `Marker` 列，导入后行号与时间一并还原。录制中打的点挂到下一行
 * （点击时还没到达的那个样本），所以临时恢复文件写到那一行时标签已经在了。
 *
 * 标记属于一份数据：按列对象（`state.chartSeries`）分组保存。清空、导入会换新的列对象，
 * 旧标记随旧数据一起失效，不需要额外的清理路径。本模块不接触 DOM / Tauri。
 */

/**
 * @typedef {Object} Marker
 * @property {number} index 所在数据行；录制中刚打的点可能指向还没到达的下一行
 * @property {string} label
 */

/** 标签最长字符数（按 UTF-16 码元截断）。 */
export const MARKER_LABEL_MAX = 40;

/** 电子表格会把这些字符开头的单元格当公式执行，换成外观相同的全角字符。 */
const FORMULA_LEADS = /** @type {Record<string, string>} */ ({ '=': '＝', '+': '＋', '-': '－', '@': '＠' });

/**
 * 把任意输入收成能安全写进一个 CSV 单元格的标签：
 * 去掉分隔符（逗号、分号）、引号与控制字符，折叠空白，公式前缀改为全角，截断到上限。
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizeMarkerLabel(text) {
  const plain = String(text ?? '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符正是要去掉的内容
    .replace(/[\u0000-\u001f\u007f,;"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.replace(/^[=+\-@]/, (lead) => FORMULA_LEADS[lead] ?? lead).slice(0, MARKER_LABEL_MAX);
}

/** @type {WeakMap<object, Marker[]>} */
const store = new WeakMap();
/** @type {readonly Marker[]} */
const NONE = Object.freeze([]);
/** @type {Set<() => void>} */
const listeners = new Set();

function notify() {
  for (const listener of listeners) listener();
}

/**
 * 标记增删改后回调（重绘图表、刷新列表）。
 * @param {() => void} listener
 * @returns {() => void} 取消订阅
 */
export function onMarkersChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 这份数据的全部标记，按行号升序。返回的数组不可修改。
 * @param {object} columns
 * @returns {readonly Marker[]}
 */
export function markersOf(columns) {
  return store.get(columns) ?? NONE;
}

/**
 * 只取已经有数据行的标记（导出、绘制用）：录制中刚打、还没等到下一行的点不算。
 * @param {object} columns
 * @param {number} length 当前行数
 * @returns {Marker[]}
 */
export function settledMarkers(columns, length) {
  return markersOf(columns).filter((marker) => marker.index < length);
}

/**
 * 整体替换一份数据的标记（导入用）。非法项丢弃，同一行的多个标签用「 / 」合并。
 * @param {object} columns
 * @param {Iterable<{index: unknown, label: unknown}>|null|undefined} markers
 * @param {number} [length=Infinity] 行数上限，越界的项丢弃
 */
export function setMarkers(columns, markers, length = Number.POSITIVE_INFINITY) {
  /** @type {Marker[]} */
  const list = [];
  for (const item of markers ?? []) {
    const index = Number(item?.index);
    const label = sanitizeMarkerLabel(item?.label);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || !label) continue;
    insert(list, index, label);
  }
  if (list.length) store.set(columns, list);
  else store.delete(columns);
  notify();
}

/** @param {Marker[]} list @param {number} index @param {string} label */
function insert(list, index, label) {
  let at = list.length;
  while (at > 0 && list[at - 1].index > index) at--;
  if (at > 0 && list[at - 1].index === index) {
    const merged = sanitizeMarkerLabel(`${list[at - 1].label} / ${label}`);
    list[at - 1] = { index, label: merged };
  } else {
    list.splice(at, 0, { index, label });
  }
}

/**
 * 新标记应挂的行：录制中挂到下一行（点击时还没到达的样本），否则挂到最后一行。
 * 没有数据又不在录制时返回 null。
 * @param {number} length 当前行数
 * @param {boolean} recording
 * @returns {number|null}
 */
export function markerRowFor(length, recording) {
  if (recording) return length;
  return length > 0 ? length - 1 : null;
}

/**
 * 在指定行添加标记；该行已有标记时合并标签。
 * @param {object} columns
 * @param {number} index
 * @param {unknown} label
 * @returns {boolean} 是否添加（标签清洗后为空时不添加）
 */
export function addMarker(columns, index, label) {
  const text = sanitizeMarkerLabel(label);
  if (!text || !Number.isSafeInteger(index) || index < 0) return false;
  const list = [...markersOf(columns)];
  insert(list, index, text);
  store.set(columns, list);
  notify();
  return true;
}

/**
 * 改名；新标签清洗后为空等同删除。
 * @param {object} columns
 * @param {number} index
 * @param {unknown} label
 */
export function renameMarker(columns, index, label) {
  const text = sanitizeMarkerLabel(label);
  if (!text) {
    removeMarker(columns, index);
    return;
  }
  const list = markersOf(columns).map((marker) => (marker.index === index ? { index, label: text } : marker));
  store.set(columns, list);
  notify();
}

/**
 * @param {object} columns
 * @param {number} index
 */
export function removeMarker(columns, index) {
  const list = markersOf(columns).filter((marker) => marker.index !== index);
  if (list.length) store.set(columns, list);
  else store.delete(columns);
  notify();
}

/**
 * 下一个自动标签的序号：已有标记数 + 1。
 * @param {object} columns
 */
export function nextMarkerNumber(columns) {
  return markersOf(columns).length + 1;
}

/**
 * 与 x 最近的数据行（x 升序）。光标停在图上时按 M，标记落在光标下的原始样本上，
 * 与图表当前用的分桶投影无关。没有数据或 x 非有限时返回 null。
 * @param {{ length: number, valueAt: (index: number) => number }} xs
 * @param {number} x
 * @returns {number|null}
 */
export function nearestRow(xs, x) {
  const n = xs.length;
  if (n === 0 || !Number.isFinite(x)) return null;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs.valueAt(mid) < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  if (lo === n) return n - 1;
  return x - xs.valueAt(lo - 1) <= xs.valueAt(lo) - x ? lo - 1 : lo;
}
