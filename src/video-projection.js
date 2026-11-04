// @ts-check
/**
 * @file 报告视频的投影：把内存里的列式记录压成一份自包含的渲染载荷（纯模块，无 DOM / Tauri）。
 *
 * 为什么在前端做：laPower 的采样只存在于前端列里，没有可按时间查询的记录存储；导出期间
 * 数据还可能继续增长。所以点击导出的那一刻先冻结长度，一次算出三样东西 —— 汇总统计、
 * 曲线桶、逐帧读数 —— 之后后端只按帧下标画，不再回头读任何数据。
 *
 * 口径与界面保持一致：
 * - 功率列存的已是幅值（addDataPoint 里取 abs），所以曲线、卡片、峰值都用同一份值。
 * - 电流列保留记录时的符号；曲线照原样画，卡片打印幅值，与实时读数栏（数值取幅值、
 *   方向由箭头表达）和主图（有符号）的分工一致。
 * - 缺测用 null，绝不用 0 顶替；判定阈值复用能量积分的空档规则 energyMaxStepS，
 *   否则会出现「积分跳过空档、视频却把空档画成直线」的口径分裂。
 */

import { calculateEnergy, currentMagnitude, energyMaxStepS } from './measurement.js';
import { VIDEO_MAX_MARKERS, VIDEO_OVERVIEW_BINS } from './video-export-options.js';

/**
 * 曲线桶的一个点：`[tMs, voltage, current, power, temperature]`。时间单位是毫秒，与后端
 * `VideoOverview::points`（`[tMs, ...]`）一致；渲染器直接把它当作毫秒换算成横向位置，
 * 用秒会让整条历史曲线挤在左端。
 * @typedef {[number, number|null, number|null, number|null, number|null]} VideoOverviewPoint
 */

/**
 * @typedef {Object} VideoProjection
 * @property {number} frameCount
 * @property {number} elapsedS
 * @property {number} points
 * @property {number} bucketMs
 * @property {VideoOverviewPoint[]} overview
 * @property {{t:number[], voltage:(number|null)[], current:(number|null)[],
 *             power:(number|null)[], temperature:(number|null)[]}} frames
 * @property {{elapsedS:number, points:number, averagePowerW:number|null, minVoltageV:number|null,
 *             averageVoltageV:number|null,
 *             maxVoltageV:number|null, peakCurrentA:number|null, maxTempC:number|null,
 *             energyWh:number, capacityMah:number, hasTemperature:boolean}} summary
 * @property {{tS:number, label:string, voltage:number|null, current:number|null,
 *             power:number|null, temperature:number|null}[]} markers
 */

/**
 * 读取任意「列样」对象（F64Col / F64Snapshot / 普通数组）。
 * @param {any} column
 * @param {number} index
 * @returns {number}
 */
function read(column, index) {
  if (!column) return Number.NaN;
  const value = typeof column.valueAt === 'function' ? column.valueAt(index) : column[index];
  return Number.isFinite(value) ? /** @type {number} */ (value) : Number.NaN;
}

/**
 * 空值收成 null：JSON 里不需要区分 NaN 与缺测。
 * @param {number} value
 * @returns {number|null}
 */
function nullable(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * 把一份记录投影成视频载荷。
 * @param {Object} input
 * @param {Record<string, any>} input.columns 已快照的列（F64Snapshot 或同形对象）
 * @param {number} input.length 冻结的行数
 * @param {readonly import('./markers.js').Marker[]} [input.markers]
 * @param {number|null} [input.intervalMs] 标称采样间隔，决定空档阈值
 * @param {number} input.frameCount 总帧数（durationS × fps）
 * @param {number} [input.binCount]
 * @param {boolean} [input.hasTemperature] 记录里是否出现过温度；缺省按数据推断
 * @param {number} [input.markerLimit]
 * @returns {VideoProjection}
 */
export function projectVideo(input) {
  const { columns, length, frameCount, markers = [], intervalMs = null, binCount = VIDEO_OVERVIEW_BINS } = input;
  if (!Number.isSafeInteger(length) || length < 2) throw new RangeError('videoNoData');
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) throw new RangeError('videoPayloadInvalid');
  const lastX = read(columns.x, length - 1);
  if (!Number.isFinite(lastX) || lastX <= 0) throw new RangeError('videoNoData');
  // 与能量积分同源的空档阈值（秒）：共享一个判定，视频才不会把空档画成连续曲线。
  const maxAgeS = energyMaxStepS(intervalMs);

  let minVoltageV = Number.POSITIVE_INFINITY;
  let maxVoltageV = Number.NEGATIVE_INFINITY;
  let peakCurrentA = Number.NEGATIVE_INFINITY;
  let maxTempC = Number.NEGATIVE_INFINITY;
  let hasTemperature = false;
  // 时间加权平均功率：和能量积分一样跳过空档，否则一次休眠会把平均值拉低一整天。
  let area = 0;
  let weighted = 0;
  let voltageArea = 0;
  let voltageWeighted = 0;
  let previousX = Number.NaN;
  for (let index = 0; index < length; index++) {
    const voltage = read(columns.voltage, index);
    if (voltage < minVoltageV) minVoltageV = voltage;
    if (voltage > maxVoltageV) maxVoltageV = voltage;
    const current = currentMagnitude(read(columns.current, index), read(columns.currentMagnitudes, index));
    if (current > peakCurrentA) peakCurrentA = current;
    const temperature = read(columns.temp, index);
    if (temperature > maxTempC) maxTempC = temperature;
    if (Number.isFinite(temperature)) hasTemperature = true;
    const x = read(columns.x, index);
    const dt = x - previousX;
    const power = read(columns.power, index - 1);
    if (index > 0 && dt > 0 && dt <= maxAgeS && Number.isFinite(power)) {
      area += power * dt;
      weighted += dt;
    }
    const previousVoltage = read(columns.voltage, index - 1);
    if (index > 0 && dt > 0 && dt <= maxAgeS && Number.isFinite(previousVoltage)) {
      voltageArea += previousVoltage * dt;
      voltageWeighted += dt;
    }
    previousX = x;
  }
  const { wh, mah } = calculateEnergy(
    columns.timestamps,
    columns.current,
    columns.power,
    columns.recordingSegments,
    intervalMs,
    columns.sampleIntervals,
    columns.currentMagnitudes,
  );

  return {
    frameCount,
    elapsedS: lastX,
    points: length,
    bucketMs: Math.max(1, Math.ceil((lastX * 1000) / Math.max(1, binCount))),
    overview: buildOverview(columns, length, lastX, binCount),
    frames: sampleFrames(columns, length, frameCount, maxAgeS),
    summary: {
      elapsedS: lastX,
      points: length,
      averagePowerW: weighted > 0 ? area / weighted : null,
      averageVoltageV: voltageWeighted > 0 ? voltageArea / voltageWeighted : null,
      minVoltageV: nullable(minVoltageV),
      maxVoltageV: nullable(maxVoltageV),
      peakCurrentA: nullable(peakCurrentA),
      maxTempC: nullable(maxTempC),
      energyWh: wh,
      capacityMah: mah,
      hasTemperature: input.hasTemperature ?? hasTemperature,
    },
    markers: projectMarkers(columns, length, markers, input.markerLimit ?? VIDEO_MAX_MARKERS),
  };
}

/**
 * 曲线投影。样本不超过桶数四倍时直接输出原始点，避免把短记录也压成桶；否则每个时间桶
 * 保留 first / 各通道 min、max / last 并按时间回排 —— 尖峰不会被抹平，这是「图表降采样
 * 只改变显示投影」这条既有权衡在视频里的复用。
 * @param {Record<string, any>} columns
 * @param {number} length
 * @param {number} lastX
 * @param {number} binCount
 * @returns {VideoOverviewPoint[]}
 */
function buildOverview(columns, length, lastX, binCount) {
  /** @param {number} index @returns {VideoOverviewPoint} */
  const point = (index) => [
    // x 是相对秒，载荷里的时间轴是毫秒（后端 VideoOverview 的 tMs）。
    Math.round(read(columns.x, index) * 1000),
    nullable(read(columns.voltage, index)),
    nullable(read(columns.current, index)),
    nullable(read(columns.power, index)),
    nullable(read(columns.temp, index)),
  ];
  if (length <= binCount * 4) {
    /** @type {VideoOverviewPoint[]} */
    const raw = [];
    for (let index = 0; index < length; index++) raw.push(point(index));
    return raw;
  }
  /** @type {VideoOverviewPoint[]} */
  const points = [];
  let index = 0;
  for (let bucket = 0; bucket < binCount && index < length; bucket++) {
    const to = (lastX * (bucket + 1)) / binCount;
    const last = bucket === binCount - 1;
    const start = index;
    while (index < length && (read(columns.x, index) < to || (last && index === length - 1))) index++;
    const stop = Math.max(index - 1, start);
    /** @type {Set<number>} */
    const keep = new Set([start, stop]);
    for (const channel of ['voltage', 'current', 'power', 'temp']) {
      let min = -1;
      let max = -1;
      let minValue = Number.POSITIVE_INFINITY;
      let maxValue = Number.NEGATIVE_INFINITY;
      for (let at = start; at <= stop; at++) {
        const value = read(columns[channel], at);
        if (!Number.isFinite(value)) continue;
        if (value < minValue) {
          minValue = value;
          min = at;
        }
        if (value > maxValue) {
          maxValue = value;
          max = at;
        }
      }
      if (min >= 0) keep.add(min);
      if (max >= 0) keep.add(max);
    }
    for (const at of [...keep].sort((a, b) => a - b)) points.push(point(at));
  }
  return points;
}

/**
 * 逐帧读数：帧 i 的时刻 = lastX × i / (frameCount - 1)（单帧取 0），取「不晚于该时刻的最近
 * 样本」，样本年龄超过空档阈值记为 null。帧时刻单调，游标只前进一次，因此是 O(长度 + 帧数)。
 * @param {Record<string, any>} columns
 * @param {number} length
 * @param {number} frameCount
 * @param {number} maxAgeS
 */
function sampleFrames(columns, length, frameCount, maxAgeS) {
  const lastX = read(columns.x, length - 1);
  /** @type {{t:number[], voltage:(number|null)[], current:(number|null)[], power:(number|null)[], temperature:(number|null)[]}} */
  const frames = { t: [], voltage: [], current: [], power: [], temperature: [] };
  let cursor = -1;
  for (let frame = 0; frame < frameCount; frame++) {
    const t = frameCount > 1 ? (lastX * frame) / (frameCount - 1) : 0;
    while (cursor + 1 < length && read(columns.x, cursor + 1) <= t) cursor++;
    const fresh = cursor >= 0 && t - read(columns.x, cursor) <= maxAgeS;
    frames.t.push(t);
    frames.voltage.push(fresh ? nullable(read(columns.voltage, cursor)) : null);
    frames.current.push(fresh ? nullable(read(columns.current, cursor)) : null);
    frames.power.push(fresh ? nullable(read(columns.power, cursor)) : null);
    frames.temperature.push(fresh ? nullable(read(columns.temp, cursor)) : null);
  }
  return frames;
}

/**
 * 断点：只取已经落到数据行上的标记（录制中刚打的下一行不算），各取一次读数。
 * 超过上限时按时间顺序保留最早的若干个 —— 剪掉末尾比剪掉开头更容易被发现。
 * @param {Record<string, any>} columns
 * @param {number} length
 * @param {readonly import('./markers.js').Marker[]} markers
 * @param {number} limit
 */
function projectMarkers(columns, length, markers, limit) {
  /** @type {{tS:number, label:string, voltage:number|null, current:number|null,
   *           power:number|null, temperature:number|null}[]} */
  const out = [];
  if (limit <= 0) return out;
  for (const marker of markers) {
    const index = Number(marker?.index);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length) continue;
    const label = String(marker?.label ?? '').trim();
    if (!label) continue;
    out.push({
      tS: read(columns.x, index),
      label,
      voltage: nullable(read(columns.voltage, index)),
      current: nullable(read(columns.current, index)),
      power: nullable(read(columns.power, index)),
      temperature: nullable(read(columns.temp, index)),
    });
  }
  // 标记按行号保存、行号与时间同序；仍然排一次，防止导入数据里出现乱序 x。
  out.sort((a, b) => a.tS - b.tS);
  return out.slice(0, limit);
}
/**
 * 把投影结果与界面文案组装成 `video_export_start` 的载荷。
 *
 * 纯函数：字段名就是与后端 `VideoPayload` 的契约（后端拒绝未知字段），因此它放在可单测的
 * 模块里，而不是埋进对话框代码。
 * @param {Object} input
 * @param {import('./video-export-options.js').VideoExportOptions} input.options
 * @param {VideoProjection} input.projection
 * @param {{title:string, status:string, statusKind:string}} input.header
 * @param {Object} input.labels 见后端 `VideoLabels`
 * @param {import('./video-palette.js').VideoPalette} input.palette
 */
export function buildVideoPayload({ options, projection, header, labels, palette }) {
  return {
    options: {
      reportType: options.reportType,
      imageLayout: options.imageLayout,
      showMarkers: options.showMarkers,
      showMarkerDetails: options.showMarkerDetails,
      width: options.width,
      height: options.height,
      fps: options.fps,
      codec: options.codec,
      acceleration: options.acceleration,
      quality: options.quality,
      format: options.format,
      durationS: options.durationS,
      theme: options.theme,
      visibleSeries: options.visibleSeries,
    },
    header,
    labels,
    palette,
    summary: {
      elapsedS: projection.summary.elapsedS,
      points: projection.summary.points,
      averagePowerW: projection.summary.averagePowerW,
      averageVoltageV: projection.summary.averageVoltageV,
      minVoltageV: projection.summary.minVoltageV,
      maxVoltageV: projection.summary.maxVoltageV,
      peakCurrentA: projection.summary.peakCurrentA,
      maxTempC: projection.summary.maxTempC,
      energyWh: projection.summary.energyWh,
      capacityMah: projection.summary.capacityMah,
      hasTemperature: projection.summary.hasTemperature,
    },
    overview: { bucketMs: projection.bucketMs, points: projection.overview },
    frames: projection.frames,
    markers: projection.markers,
  };
}
