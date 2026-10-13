// @ts-check
/**
 * @file 数据来源：一份数据由哪台仪表采集、每个点按什么规则从仪表帧得到，以及写文件的软件版本。
 *
 * 这些写进 CSV 表头前的元信息行（`Software` / `Device` / `Points`），拿到文件的人不用猜。
 * 来源按数据集保存：以列对象（`state.chartSeries`）为键，清空、导入换新列对象时自然重置。
 * 录制开始时登记当前仪表；导入时登记文件里声明的来源（旧文件没有，就记为未知）。
 * 本模块不接触 DOM / Tauri；软件版本由启动代码注入。
 */

/**
 * 采样间隔内的全部仪表帧取平均（间隔等于仪表节拍时，一个点就是那一帧）。
 * 改动后端的选点规则时必须同步修改这个值。
 */
export const POINT_RULE = 'mean';

/** `Points` 值里允许的字符：规则名是简单的英文标识。 */
const RULE_PATTERN = /^[A-Za-z][\w-]{0,31}$/;

/**
 * @typedef {Object} Provenance
 * @property {string[]} devices 采集过这份数据的仪表，按出现顺序去重
 * @property {string|null} points 全部点用同一条已知规则时为规则名；未知或混合时为 null
 */

/** @typedef {{ devices: Set<string>, rules: Set<string> }} Entry */

/** @type {WeakMap<object, Entry>} */
const store = new WeakMap();
let software = 'laPower';

/** 未知规则的占位：导入的旧文件没有 `Points` 行。 */
const UNKNOWN = '?';

/**
 * 元信息单元格里的文字：去掉分隔符、引号、控制字符，折叠空白。
 * @param {unknown} text
 */
function cell(text) {
  return (
    String(text ?? '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符正是要去掉的内容
      .replace(/[\u0000-\u001f\u007f,;"]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
  );
}

/**
 * 启动时注入当前软件版本（`window.__TAURI__.app.getVersion()` 的结果）。
 * @param {string|null|undefined} version
 */
export function setSoftwareVersion(version) {
  const v = cell(version);
  software = v ? `laPower ${v}` : 'laPower';
}

/** 写文件的软件，例如 `laPower 0.2.3`。 */
export function softwareLabel() {
  return software;
}

/**
 * 仪表描述：型号，加上 USB VID:PID（十六进制）。没有可用信息时返回 null。
 * @param {{ model_name?: string, vid?: number, pid?: number }|null|undefined} info
 * @returns {string|null}
 */
export function describeDevice(info) {
  if (!info) return null;
  const model = cell(info.model_name) || 'Unknown device';
  const hex = (/** @type {unknown} */ value) =>
    Number.isInteger(value) && /** @type {number} */ (value) >= 0 && /** @type {number} */ (value) <= 0xffff
      ? /** @type {number} */ (value).toString(16).toUpperCase().padStart(4, '0')
      : null;
  const vid = hex(info.vid);
  const pid = hex(info.pid);
  return vid && pid ? `${model} (${vid}:${pid})` : model;
}

/** @param {object} columns @returns {Entry} */
function entryOf(columns) {
  let entry = store.get(columns);
  if (!entry) {
    entry = { devices: new Set(), rules: new Set() };
    store.set(columns, entry);
  }
  return entry;
}

/**
 * 录制开始：这份数据接下来的点由这台仪表、按 {@link POINT_RULE} 产生。
 * @param {object} columns
 * @param {Parameters<typeof describeDevice>[0]} device
 */
export function noteRecordedSource(columns, device) {
  const entry = entryOf(columns);
  const name = describeDevice(device);
  if (name) entry.devices.add(name);
  entry.rules.add(POINT_RULE);
}

/**
 * 导入：登记文件声明的来源。没有 `Points` 行的旧文件记为未知规则。
 * @param {object} columns
 * @param {{ devices?: string[], points?: string|null }|null|undefined} source
 */
export function noteImportedSource(columns, source) {
  const entry = entryOf(columns);
  for (const device of source?.devices ?? []) {
    const name = cell(device);
    if (name) entry.devices.add(name);
  }
  const points = cell(source?.points);
  entry.rules.add(RULE_PATTERN.test(points) ? points : UNKNOWN);
}

/**
 * 导出用：这份数据的仪表与选点规则。
 * @param {object} columns
 * @returns {Provenance}
 */
export function provenanceOf(columns) {
  const entry = store.get(columns);
  if (!entry) return { devices: [], points: null };
  const rules = [...entry.rules];
  return {
    devices: [...entry.devices],
    points: rules.length === 1 && rules[0] !== UNKNOWN ? rules[0] : null,
  };
}

/**
 * 解析 `Device` 元信息行的值：多台仪表用「 / 」分隔。
 * @param {string} value
 * @returns {string[]}
 */
export function parseDeviceList(value) {
  return value
    .split(' / ')
    .map((part) => cell(part))
    .filter(Boolean);
}
