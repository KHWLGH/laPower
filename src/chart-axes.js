// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * @file 主图 Y 轴量程量化、多轴等分网格对齐、刻度格式化与轴装饰绘制。
 */

import { state } from './state.js';
import { chartTheme } from './theme.js';

/**
 * 挂靠在电压 scale 上的 series 下标集合。
 * D+/D-/CC1/CC2 叠加曲线与电压共用一个 scale：量程必须聚合所有挂靠曲线，
 * 否则隐藏电压时叠加曲线会失去量程。
 */
export const VOLTAGE_SCALE_SERIES = [1, 5, 6, 7, 8];

/**
 * 轴顶横向标题占用的上边距（CSS px）。
 * 顶刻度数字相对绘图区顶边居中，大约伸出 6px；再加标题行高与缝隙。
 * 取代 uPlot 默认 ~17px 顶垫，避免标题与顶刻度挤在一起。
 */
export const Y_AXIS_LABEL_PAD = 24;

/** 量化步长的候选尾数。比常见的 1/2/5 更细，用于压低量化引入的额外余量。 */
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
// Display-only floors for unloaded meters. Keeping an empty-load noise floor prevents
// tiny ADC jitter from filling the plot vertically.
const IDLE_AXIS_CEILING = { voltage: 0.05, current: 0.01, power: 0.005, temp: 0 };

/**
 * 图表纵向余量（0-1 小数）。auto = 25%（曲线保持中高位置），custom 读设置值。
 * @returns {number}
 */
export function headroomFrac() {
  const s = state.settings;
  if (s.chartHeadroomMode === 'custom') {
    const p = Number(s.chartHeadroomPercent);
    if (Number.isFinite(p)) return Math.min(100, Math.max(0, p)) / 100;
  }
  return 0.25;
}

/**
 * 量程含余量并从 0 起算（有负值时才向负侧延伸），保证曲线位置稳定直观。
 * @param {number} min @param {number} max @param {number} h
 * @returns {[number, number]}
 */
function paddedZeroBased(min, max, h) {
  const lo = min < 0 ? min * (1 + h) : 0;
  const hi = max > 0 ? max * (1 + h) : min < 0 ? 0 : 1;
  return lo < hi ? [lo, hi] : [lo - 0.5, hi + 0.5];
}

/**
 * 全部 Y 轴共用的等分格数。
 * @param {any} u
 * @returns {number}
 */
export function yDivisions(u) {
  const plotHeight = Math.max(80, (Number(u?.height) || 300) - 70);
  return Math.min(7, Math.max(3, Math.round(plotHeight / 80)));
}

/**
 * 把量程量化为「整齐步长 × 等分数」，使刻度既是整数值又正好铺满绘图区。
 * @param {number} lo @param {number} hi @param {number} divisions
 * @returns {[number, number]}
 */
export function quantizeRange(lo, hi, divisions) {
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) return [lo, hi];
  const mag = 10 ** Math.floor(Math.log10(span / divisions));
  for (const decade of [mag, mag * 10]) {
    for (const step of NICE_STEPS) {
      const incr = step * decade;
      const start = Math.floor(lo / incr + 1e-9) * incr;
      if (start + incr * divisions >= hi - Math.abs(hi) * 1e-9) return [start, start + incr * divisions];
    }
  }
  return [lo, hi];
}

/**
 * 智能小数位刻度格式化（与旧版 Chart.js 回调一致）。
 * @param {number} value
 * @returns {string}
 */
export function smartTick(value) {
  const absVal = Math.abs(value);
  if (absVal > 0 && absVal < 0.001) return String(parseFloat(value.toFixed(6)));
  if (absVal > 0 && absVal < 0.1) return String(parseFloat(value.toFixed(5)));
  if (absVal > 0 && absVal < 1) return String(parseFloat(value.toFixed(4)));
  return String(parseFloat(value.toFixed(3)));
}

/**
 * 创建绑定到图表模块状态的 Y 轴范围、等分与绘制助手。
 * @param {{
 *   getSeriesMax: () => number[],
 *   getSeriesMin: () => number[],
 *   getChartFont: () => string,
 *   getMonoFont: () => string,
 *   scheduleChartUpdate: () => void,
 * }} hooks
 */
export function createChartAxes(hooks) {
  /**
   * 量程量化时实际采用的等分数。
   * 刻度（uniformSplits）必须复用它，而不是各自再调一次 yDivisions。
   */
  let appliedYDivisions = 0;
  let divisionSyncPending = false;

  /**
   * 聚合一组挂靠在同一 scale 上的可见 series 的全量 min/max。
   * @param {any} u @param {number[]} seriesIndexes
   * @returns {{min: number, max: number}|{empty: true}|null}
   */
  function aggregateVisible(u, seriesIndexes) {
    const seriesMax = hooks.getSeriesMax();
    const seriesMin = hooks.getSeriesMin();
    let anyVisible = false;
    let max = -Infinity;
    let min = Infinity;
    for (const si of seriesIndexes) {
      if (!u.series[si] || !u.series[si].show) continue;
      anyVisible = true;
      if (Number.isFinite(seriesMax[si]) && seriesMax[si] > max) max = seriesMax[si];
      if (Number.isFinite(seriesMin[si]) && seriesMin[si] < min) min = seriesMin[si];
    }
    if (!anyVisible) return null;
    if (!Number.isFinite(max)) return { empty: true };
    return { min, max };
  }

  /** @param {any} u */
  function syncDivisionsAfterResize(u) {
    if (divisionSyncPending || yDivisions(u) === appliedYDivisions) return;
    divisionSyncPending = true;
    hooks.scheduleChartUpdate();
  }

  /**
   * 构造 Y 轴范围函数：聚合挂靠该 scale 的所有可见 series，可配置余量，
   * 最后量化到全局等分格（与其余 Y 轴共线）。
   * @param {keyof import('./state.js').Settings['chartCurveNudge']} channel
   * @param {number[]} seriesIndexes
   * @param {boolean} [symmetric=false]
   */
  function mkYRange(channel, seriesIndexes, symmetric = false) {
    return /** @type {any} */ (
      /** @param {any} u */
      (u) => {
        const agg = aggregateVisible(u, seriesIndexes);
        const divisions = yDivisions(u);
        appliedYDivisions = divisions;
        if (agg === null) return [null, null];
        if ('empty' in agg) return quantizeRange(0, 1, divisions);
        const h = headroomFrac();
        let lo;
        let hi;
        if (symmetric) {
          const span = agg.max - agg.min;
          const padding = span > 0 ? span * h : 1;
          lo = agg.min - padding;
          hi = agg.max + padding;
        } else {
          const idleCeiling = IDLE_AXIS_CEILING[channel];
          if (agg.min >= 0 && agg.max <= idleCeiling) {
            lo = 0;
            hi = Math.max(idleCeiling, agg.max * (1 + h));
          } else {
            [lo, hi] = paddedZeroBased(agg.min, agg.max, h);
          }
        }
        const nudge = (state.settings.chartCurveNudge?.[channel] || 0) / 100;
        if (nudge !== 0) {
          const shift = nudge * (hi - lo);
          // Move curve up (+) by lowering [lo, hi], or down (−) by raising [lo, hi], without clipping samples.
          lo = Math.min(lo - shift, agg.min);
          hi = Math.max(hi - shift, agg.max);
        }
        return quantizeRange(lo, hi, divisions);
      }
    );
  }

  /**
   * 生成与其余 Y 轴共线的等分刻度（配合 quantizeRange 量化后的整齐量程使用）。
   * @param {any} u @param {string} scaleKey
   * @returns {number[]}
   */
  function uniformSplits(u, scaleKey) {
    const scale = u.scales?.[scaleKey];
    if (scale?.min == null || scale?.max == null) return [];
    const min = Number(scale.min);
    const span = Number(scale.max) - min;
    const n = appliedYDivisions || yDivisions(u);
    return Array.from({ length: n + 1 }, (_, i) => min + (span * i) / n);
  }

  /**
   * Y 轴宽度自适应：按最长刻度文字实测宽度分配，避免小数位多时被裁剪。
   * @param {any} u @param {string[]|null} values @param {number} axisIdx @param {number} cycleNum
   * @returns {number}
   */
  function axisAutoSize(u, values, axisIdx, cycleNum) {
    const axis = u.axes[axisIdx];
    if (cycleNum > 1) return axis._size;
    // uPlot caches the active font; measurement must not change its Canvas state behind that cache.
    const previousFont = u.ctx.font;
    let size = (axis.ticks?.show ? axis.ticks.size : 0) + axis.gap + 4;
    const longest = (values ?? []).reduce((acc, v) => (String(v).length > acc.length ? String(v) : acc), '');
    if (longest !== '') {
      u.ctx.font = axis.font[0];
      size += u.ctx.measureText(longest).width / (uPlot.pxRatio || devicePixelRatio || 1);
    }
    let titleSize = 0;
    if (axis.axisTitle) {
      u.ctx.font = Array.isArray(axis.labelFont) ? axis.labelFont[0] : `12px ${hooks.getChartFont()}`;
      titleSize = u.ctx.measureText(axis.axisTitle).width / (uPlot.pxRatio || devicePixelRatio || 1) + 8;
    }
    u.ctx.font = previousFont;
    return Math.ceil(Math.max(size, titleSize, 28));
  }

  /**
   * 构造一条 Y 轴配置。
   * @param {string} scaleKey
   * @param {string} label
   * @param {() => string} color
   * @param {number} side - 3=左 1=右
   * @returns {any}
   */
  function mkYAxis(scaleKey, label, color, side) {
    return {
      scale: scaleKey,
      side,
      stroke: color,
      axisTitle: label,
      labelFont: `12px ${hooks.getChartFont()}`,
      font: `12px ${hooks.getMonoFont()}`,
      gap: 6,
      size: axisAutoSize,
      splits: (/** @type {any} */ u) => uniformSplits(u, scaleKey),
      values: (/** @type {any} */ _u, /** @type {number[]} */ splits) => splits.map(smartTick),
      grid: { show: true, stroke: () => chartTheme.grid, width: 1 },
      ticks: { show: false },
    };
  }

  /**
   * 传统坐标轴形态：每条可见 Y 轴一条通道色竖脊；贴着绘图区边缘的轴再朝图内画短刻度。
   * @param {any} u
   */
  function drawYAxisChrome(u) {
    const { ctx, bbox } = u;
    if (!bbox || bbox.width <= 0 || bbox.height <= 0) return;

    const left = bbox.left;
    const right = bbox.left + bbox.width;
    const top = bbox.top;
    const bottom = bbox.top + bbox.height;
    const pxRatio = uPlot.pxRatio || devicePixelRatio || 1;
    const tickLen = 5 * pxRatio;
    const edgeEps = pxRatio * 1.5;

    ctx.save();
    ctx.lineWidth = pxRatio;
    ctx.lineCap = 'butt';
    const offset = (ctx.lineWidth % 2) / 2;
    ctx.translate(offset, offset);

    const axes = u.axes ?? [];
    for (let i = 1; i < axes.length; i++) {
      const axis = axes[i];
      if (!axis?.show || axis._show === false || axis._pos == null) continue;
      if (u.scales?.[axis.scale]?.min == null) continue;

      const x = Math.round(axis._pos * pxRatio);
      const stroke = typeof axis.stroke === 'function' ? axis.stroke(u, i) : axis.stroke;
      if (!stroke) continue;

      ctx.strokeStyle = stroke;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);

      const inward = axis.side === 3 ? 1 : axis.side === 1 ? -1 : 0;
      const atPlotEdge =
        inward === 1 ? Math.abs(x - left) <= edgeEps : inward === -1 ? Math.abs(x - right) <= edgeEps : false;
      if (atPlotEdge && Array.isArray(axis._splits)) {
        for (const v of axis._splits) {
          const y = Math.round(u.valToPos(v, axis.scale, true));
          if (y < top || y > bottom) continue;
          ctx.moveTo(x, y);
          ctx.lineTo(x + inward * tickLen, y);
        }
      }
      ctx.stroke();
    }

    ctx.strokeStyle = chartTheme.grid;
    ctx.beginPath();
    ctx.moveTo(left, bottom);
    ctx.lineTo(right, bottom);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * 在每条可见 Y 轴顶部画横向标题。
   * @param {any} u
   */
  function drawYAxisLabels(u) {
    const { ctx, bbox } = u;
    if (!bbox || bbox.width <= 0 || bbox.height <= 0) return;

    const pxRatio = uPlot.pxRatio || devicePixelRatio || 1;
    const axes = u.axes ?? [];
    const canvasW = ctx.canvas.width;
    const left = bbox.left;
    const right = bbox.left + bbox.width;
    const gap = 4 * pxRatio;
    const y = bbox.top - 8 * pxRatio;
    const edgeEps = pxRatio * 1.5;

    ctx.save();
    ctx.textBaseline = 'bottom';

    for (let i = 1; i < axes.length; i++) {
      const axis = axes[i];
      if (!axis?.show || axis._show === false || axis._pos == null) continue;
      if (u.scales?.[axis.scale]?.min == null) continue;
      const title = axis.axisTitle;
      if (!title) continue;

      const stroke = typeof axis.stroke === 'function' ? axis.stroke(u, i) : axis.stroke;
      if (!stroke) continue;

      const pos = axis._pos * pxRatio;
      const atLeftEdge = axis.side === 3 && Math.abs(pos - left) <= edgeEps;
      const atRightEdge = axis.side === 1 && Math.abs(pos - right) <= edgeEps;

      let x = pos;
      /** @type {CanvasTextAlign} */
      let align = 'center';
      if (axis.side === 3) {
        align = 'left';
        x = atLeftEdge ? pos + gap : gap;
      } else if (axis.side === 1) {
        align = 'right';
        x = atRightEdge ? pos - gap : canvasW - gap;
      }

      ctx.font = Array.isArray(axis.labelFont) ? axis.labelFont[0] : `12px ${hooks.getChartFont()}`;
      ctx.fillStyle = stroke;
      ctx.textAlign = align;
      ctx.fillText(title, x, y);
    }

    ctx.restore();
  }

  return {
    mkYRange,
    uniformSplits,
    axisAutoSize,
    mkYAxis,
    drawYAxisChrome,
    drawYAxisLabels,
    syncDivisionsAfterResize,
    consumeDivisionSyncPending() {
      if (!divisionSyncPending) return false;
      divisionSyncPending = false;
      return true;
    },
  };
}
