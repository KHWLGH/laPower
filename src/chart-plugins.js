// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * @file 主图与导航图插件：事件标记绘制、悬停光标与 Tooltip、滚轮缩放及指针拖拽平移。
 */

import { nearestIndex } from './chart-buckets.js';
import {
  minZoomSpan,
  panTimeWindow,
  settleWheelZoomWindow,
  wheelZoomFactor,
  wheelZoomPivot,
  zoomTimeWindow,
} from './chart-window.js';
import { displayFrames } from './frame-scheduler.js';
import { getResolvedLanguage } from './i18n.js';
import { markersOf } from './markers.js';
import { state } from './state.js';
import { chartTheme } from './theme.js';
import { formatRelativeHMS } from './utils.js';

/** 最多叠几行标签；更多的重叠标记只画竖线，标签可在标记列表里查看。 */
const MARKER_LABEL_ROWS = 3;
const WHEEL_SETTLE_MS = 100;
const WHEEL_EDGE_PX = 4;

/**
 * 打点：贯穿绘图区的竖线，顶部带标签。标签按行错开，靠右边缘时翻到线的左侧。
 * @param {any} u
 * @param {string} chartFont
 */
export function drawMarkers(u, chartFont) {
  const cols = state.chartSeries;
  const list = markersOf(cols);
  const { ctx, bbox } = u;
  if (!list.length || !bbox || bbox.width <= 0 || bbox.height <= 0) return;
  const min = u.scales.x?.min;
  const max = u.scales.x?.max;
  if (!(max >= min)) return;
  const pxRatio = uPlot.pxRatio || devicePixelRatio || 1;
  const left = bbox.left;
  const right = bbox.left + bbox.width;
  const top = bbox.top;
  const bottom = bbox.top + bbox.height;
  const fontPx = Math.round(11 * pxRatio);
  const padX = Math.round(4 * pxRatio);
  const boxH = fontPx + Math.round(6 * pxRatio);
  const gap = Math.round(3 * pxRatio);
  /** 每一行标签已占用到的右边缘。 */
  const rowEnds = new Array(MARKER_LABEL_ROWS).fill(Number.NEGATIVE_INFINITY);
  const lineWidth = Math.max(1, Math.round(pxRatio));
  const n = cols.x.length;

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, bbox.width, bbox.height);
  ctx.clip();
  ctx.font = `${fontPx}px ${chartFont}`;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = lineWidth;
  for (const marker of list) {
    if (marker.index >= n) break;
    const x = cols.x.valueAt(marker.index);
    if (!(x >= min && x <= max)) continue;
    const px = Math.round(u.valToPos(x, 'x', true)) + (lineWidth % 2 ? 0.5 : 0);
    ctx.strokeStyle = chartTheme.axisText;
    ctx.beginPath();
    ctx.moveTo(px, top);
    ctx.lineTo(px, bottom);
    ctx.stroke();

    const width = Math.ceil(ctx.measureText(marker.label).width) + padX * 2;
    let x0 = px + gap;
    if (x0 + width > right) x0 = px - gap - width;
    const row = rowEnds.findIndex((end) => x0 > end);
    if (row === -1) continue;
    rowEnds[row] = x0 + width + gap;
    const y0 = top + gap + row * (boxH + gap);
    ctx.fillStyle = chartTheme.markerBg;
    ctx.fillRect(x0, y0, width, boxH);
    ctx.fillStyle = chartTheme.marker;
    ctx.textAlign = 'left';
    ctx.fillText(marker.label, x0 + padX, y0 + boxH / 2);
  }
  ctx.restore();
}

/**
 * 导航缩略图上的标记：只画细竖线，告诉用户哪里有点可以跳过去看。
 * @param {any} u
 */
export function drawNavigatorMarkers(u) {
  const cols = state.chartSeries;
  const list = markersOf(cols);
  const { ctx, bbox } = u;
  if (!list.length || !bbox || bbox.width <= 0 || bbox.height <= 0) return;
  const pxRatio = uPlot.pxRatio || devicePixelRatio || 1;
  const lineWidth = Math.max(1, Math.round(pxRatio));
  const n = cols.x.length;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.strokeStyle = chartTheme.axisText;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  for (const marker of list) {
    if (marker.index >= n) break;
    const px = Math.round(u.valToPos(cols.x.valueAt(marker.index), 'x', true)) + (lineWidth % 2 ? 0.5 : 0);
    ctx.moveTo(px, bbox.top);
    ctx.lineTo(px, bbox.top + bbox.height);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * 创建悬停光标映射与 Tooltip 插件。
 * @param {{
 *   fields: string[],
 *   seriesScales: string[],
 *   units: string[],
 *   chartLabel: (index: number) => string,
 *   isMainGenFresh: () => boolean,
 *   getDataGen: () => number,
 *   getTooltipThemeGen: () => number,
 *   monitorVisible: () => boolean,
 * }} hooks
 */
export function createCursorAndTooltip(hooks) {
  /**
   * 桶显示时 uPlot 的 idx 是顶点下标，用 X 二分回全量列。
   * @param {any} u
   * @param {number|null} hoveredIdx
   * @returns {number|null}
   */
  function realIndexFromCursor(u, hoveredIdx) {
    if (hoveredIdx == null || !hooks.isMainGenFresh()) return null;
    const left = u.cursor.left;
    if (!Number.isFinite(left) || left < 0) return null;
    const xVal = u.posToVal(left, 'x');
    if (!Number.isFinite(xVal) || state.chartSeries.x.length === 0) return null;
    return nearestIndex(state.chartSeries.x, state.chartSeries.x.length, xVal);
  }

  /**
   * Position hover markers on the same raw sample used by the tooltip.
   * @param {any} u @param {number} seriesIdx
   */
  function cursorPointBox(u, seriesIdx) {
    const index = realIndexFromCursor(u, u.cursor.idx);
    const field = /** @type {keyof typeof state.chartSeries} */ (hooks.fields[seriesIdx - 1]);
    const value = index == null ? Number.NaN : state.chartSeries[field]?.valueAt(index);
    if (index == null || !Number.isFinite(value)) return { left: -100, top: -100, width: 0, height: 0 };
    return {
      left: u.valToPos(state.chartSeries.x.valueAt(index), 'x') - 4,
      top: u.valToPos(value, hooks.seriesScales[seriesIdx - 1]) - 4,
      width: 8,
      height: 8,
    };
  }

  /**
   * 缺测在 Float64Array 里只能是 NaN，uPlot 只把 == null 当缺口。
   * 返回 null 让 uPlot 把该 series 的 hover 点移出视口。
   * @param {any} u @param {number} seriesIdx @param {number|null} hoveredIdx
   * @returns {number|null}
   */
  function cursorDataIdx(u, seriesIdx, hoveredIdx) {
    if (hoveredIdx == null) return null;
    const realIdx = realIndexFromCursor(u, hoveredIdx);
    if (realIdx == null) return null;
    if (seriesIdx === 0) return hoveredIdx;
    const field = /** @type {keyof typeof state.chartSeries} */ (hooks.fields[seriesIdx - 1]);
    const y = state.chartSeries[field]?.valueAt(realIdx);
    return Number.isFinite(y) ? hoveredIdx : null;
  }

  /**
   * 悬停 tooltip 插件：index 模式（显示最近 X 处所有可见曲线的值）。
   * @returns {any}
   */
  function tooltipPlugin() {
    /** @type {HTMLDivElement|null} */
    let tt = null;
    /** @type {HTMLDivElement|null} */
    let title = null;
    /** @type {{ row: HTMLDivElement, swatch: HTMLSpanElement, text: Text }[]} */
    const rows = [];
    /** @type {number|null} */
    let frame = null;
    /** @type {ResizeObserver|null} */
    let observer = null;
    let lastIndex = -1;
    let lastGen = -1;
    let lastMask = -1;
    let lastTheme = -1;
    let lastLanguage = '';
    let visibleRows = 0;
    let shown = false;
    let sizeDirty = true;
    let overDirty = true;
    let width = 0;
    let height = 0;
    let overWidth = 0;
    let overHeight = 0;
    /** @type {(() => void)|null} */
    let invalidate = null;

    function hide() {
      if (shown && tt) tt.style.display = 'none';
      shown = false;
    }

    /** @param {any} u */
    function commit(u) {
      if (!tt || !title || !hooks.monitorVisible()) return;
      const { idx, left, top } = u.cursor;
      if (
        u.over?.classList.contains('is-panning') ||
        idx == null ||
        left == null ||
        left < 0 ||
        top == null ||
        top < 0
      ) {
        hide();
        return;
      }
      const realIdx = realIndexFromCursor(u, idx);
      const xVal = realIdx == null ? null : state.chartSeries.x.valueAt(realIdx);
      if (realIdx == null || xVal == null || !Number.isFinite(xVal)) {
        hide();
        return;
      }
      let mask = 0;
      for (let i = 0; i < hooks.fields.length; i++) {
        if (u.series[i + 1]?.show) mask |= 1 << i;
      }
      const dataGen = hooks.getDataGen();
      const tooltipThemeGen = hooks.getTooltipThemeGen();
      const language = getResolvedLanguage();
      if (
        realIdx !== lastIndex ||
        dataGen !== lastGen ||
        mask !== lastMask ||
        tooltipThemeGen !== lastTheme ||
        language !== lastLanguage
      ) {
        const heading = formatRelativeHMS(Number(xVal));
        if (title.textContent !== heading) title.textContent = heading;
        visibleRows = 0;
        for (let i = 0; i < rows.length; i++) {
          const { row, swatch, text } = rows[i];
          const field = /** @type {keyof typeof state.chartSeries} */ (hooks.fields[i]);
          const value = state.chartSeries[field]?.valueAt(realIdx);
          const show = !!(mask & (1 << i)) && Number.isFinite(value);
          const display = show ? '' : 'none';
          if (row.style.display !== display) row.style.display = display;
          if (show) {
            const label = `${hooks.chartLabel(i)}: ${Number(value).toFixed(3)}${hooks.units[i]}`;
            if (text.nodeValue !== label) text.nodeValue = label;
            visibleRows++;
          }
          if (lastTheme !== tooltipThemeGen) swatch.style.background = /** @type {any} */ (chartTheme)[hooks.fields[i]];
        }
        lastIndex = realIdx;
        lastGen = dataGen;
        lastMask = mask;
        lastTheme = tooltipThemeGen;
        lastLanguage = language;
        sizeDirty = true;
      }
      if (visibleRows === 0) {
        hide();
        return;
      }
      if (!shown) {
        tt.style.display = 'block';
        shown = true;
        sizeDirty = true;
        overDirty = true;
      }
      if (overDirty) {
        overWidth = u.over.clientWidth;
        overHeight = u.over.clientHeight;
        overDirty = false;
      }
      if (sizeDirty) {
        width = tt.offsetWidth;
        height = tt.offsetHeight;
        sizeDirty = false;
      }
      let x = left + 12;
      if (x + width > overWidth) x = left - width - 12;
      let y = top + 12;
      if (y + height > overHeight) y = top - height - 12;
      const transform = `translate(${Math.max(0, Math.round(x))}px, ${Math.max(0, Math.round(y))}px)`;
      if (tt.style.transform !== transform) tt.style.transform = transform;
    }

    /** @param {any} u */
    function schedule(u) {
      if (!tt || frame != null || !hooks.monitorVisible()) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        commit(u);
      });
    }

    return {
      hooks: {
        init: (/** @type {any} */ u) => {
          tt = document.createElement('div');
          tt.className = 'chart-tooltip';
          tt.style.display = 'none';
          title = document.createElement('div');
          title.className = 'chart-tooltip-title';
          tt.appendChild(title);
          for (let i = 0; i < hooks.fields.length; i++) {
            const row = document.createElement('div');
            row.className = 'chart-tooltip-row';
            const swatch = document.createElement('span');
            swatch.className = 'chart-tooltip-swatch';
            const text = document.createTextNode('');
            row.appendChild(swatch);
            row.appendChild(text);
            tt.appendChild(row);
            rows.push({ row, swatch, text });
          }
          u.over.appendChild(tt);
          invalidate = () => {
            sizeDirty = true;
            overDirty = true;
            schedule(u);
          };
          observer = new ResizeObserver(invalidate);
          observer.observe(u.over);
          observer.observe(tt);
          document.fonts?.addEventListener('loadingdone', invalidate);
        },
        setCursor: schedule,
        setData: schedule,
        setSeries: schedule,
        draw: schedule,
        setSize: () => invalidate?.(),
        destroy: () => {
          if (frame != null) cancelAnimationFrame(frame);
          frame = null;
          observer?.disconnect();
          if (invalidate) document.fonts?.removeEventListener('loadingdone', invalidate);
          tt?.remove();
          tt = null;
          title = null;
          rows.length = 0;
        },
      },
    };
  }

  return { cursorPointBox, cursorDataIdx, tooltipPlugin };
}

/**
 * 创建滚轮缩放与指针拖拽平移交互控制器。
 * @param {{
 *   monitorVisible: () => boolean,
 *   isRangeDragging: () => boolean,
 *   setRangeDragging: (dragging: boolean, fromChart?: boolean) => void,
 *   xRange: () => [number, number],
 *   updateCharts: (source?: 'live'|'interaction'|'maintenance', opts?: { force?: boolean, reason?: string }) => void,
 * }} hooks
 */
export function createChartInteractions(hooks) {
  /** @type {(() => void)|undefined} */
  let stopWheelZoom;
  /** @type {(() => void)|undefined} */
  let stopChartPan;

  /**
   * Coalesce wheel input from the plot and overview into the same time window.
   * @param {HTMLElement|undefined} plot @param {HTMLElement|null} overview
   */
  function bindChartWheel(plot, overview) {
    /** @type {{min:number,max:number,dataMin:number,dataMax:number,left:number,width:number,surface:HTMLElement}|null} */
    let zoom = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let settle = null;
    stopWheelZoom = () => {
      if (!zoom) return;
      zoom = null;
      if (settle !== null) clearTimeout(settle);
      settle = null;
      displayFrames.cancel('chart-wheel');
      hooks.setRangeDragging(false, true);
    };

    /** @param {boolean} finished */
    function drawZoomFrame(finished) {
      if (!zoom || !hooks.monitorVisible()) {
        stopWheelZoom?.();
        return;
      }
      let { min, max } = zoom;
      const { dataMin, dataMax } = zoom;
      if (finished) {
        const latest = state.chartSeries.x.at(-1);
        ({ min, max } = settleWheelZoomWindow({ min, max, dataMin, dataMax, latest }));
        stopWheelZoom?.();
      }
      state.__applyChartXWindow?.(min, max, finished, finished ? undefined : [dataMin, dataMax]);
      hooks.updateCharts('interaction', { force: false, reason: finished ? 'release' : 'interaction' });
    }

    /** @param {WheelEvent} event */
    function onWheel(event) {
      const xs = state.chartSeries.x;
      if (xs.length < 2 || (hooks.isRangeDragging() && !zoom)) return;
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode);
      if (factor === 1) return;
      const surface = /** @type {HTMLElement} */ (event.currentTarget);
      const { left, width } = zoom?.surface === surface ? zoom : surface.getBoundingClientRect();
      if (!width) return;
      event.preventDefault();

      const dataMin = zoom?.dataMin ?? xs.at(0);
      const dataMax = zoom?.dataMax ?? xs.at(-1);
      if (!(dataMax > dataMin)) return;
      let [min, max] = zoom ? [zoom.min, zoom.max] : hooks.xRange();
      if (!zoom && state.chartWindow.mode !== 'frozen') {
        const duration = max - min;
        max = dataMax;
        min = state.chartWindow.mode === 'full' ? dataMin : Math.max(dataMin, max - duration);
      }
      const offset = event.clientX - left;
      const edge = Math.min(WHEEL_EDGE_PX, width / 4);
      const pivot = wheelZoomPivot({
        ratio: offset <= edge ? 0 : offset >= width - edge ? 1 : offset / width,
        min,
        max,
        dataMin,
        dataMax,
        overview: surface === overview,
      });
      const next = zoomTimeWindow({
        min,
        max,
        pivot,
        factor,
        dataMin,
        dataMax,
        minSpan: minZoomSpan(state.settings.sampleRate),
      });
      const full = next.min === dataMin && next.max === dataMax;
      if (next.min === min && next.max === max && !(full && !zoom && state.chartWindow.mode !== 'full')) return;
      zoom = { ...next, dataMin, dataMax, left, width, surface };
      hooks.setRangeDragging(true, true);
      if (full) {
        drawZoomFrame(true);
        return;
      }
      if (settle !== null) clearTimeout(settle);
      settle = setTimeout(() => drawZoomFrame(true), WHEEL_SETTLE_MS);
      displayFrames.schedule('chart-wheel', () => drawZoomFrame(false), 1);
    }

    plot?.addEventListener('wheel', onWheel, { passive: false });
    overview?.addEventListener('wheel', onWheel, { passive: false });
  }

  /** @param {HTMLElement|undefined} over */
  function bindChartPan(over) {
    if (!over) return;
    /** @type {{pointer: number, origin: number, x: number, min: number, max: number, width: number, active: boolean}|null} */
    let pan = null;
    over.classList.add('is-pannable');

    stopChartPan = () => {
      if (!pan) return;
      const { pointer, active } = pan;
      pan = null;
      displayFrames.cancel('chart-pan');
      over.classList.remove('is-panning');
      if (over.hasPointerCapture(pointer)) over.releasePointerCapture(pointer);
      if (active) hooks.setRangeDragging(false, true);
    };

    /** @param {boolean} settled */
    function drawPan(settled) {
      if (!pan?.active) return;
      const { origin, x, min, max, width } = pan;
      const xs = state.chartSeries.x;
      const next = panTimeWindow(min, max, ((origin - x) / width) * (max - min), xs.at(0), xs.at(-1));
      if (settled) stopChartPan?.();
      const [previousMin, previousMax] = hooks.xRange();
      if (!settled && next.min === previousMin && next.max === previousMax) return;
      state.__applyChartXWindow?.(next.min, next.max, settled);
      hooks.updateCharts('interaction', { force: false, reason: settled ? 'release' : 'interaction' });
    }

    over.addEventListener('pointerdown', (event) => {
      const xs = state.chartSeries.x;
      if (!event.isPrimary || event.button !== 0 || pan || xs.length < 2) return;
      const [min, max] = hooks.xRange();
      if (max - min >= xs.at(-1) - xs.at(0)) return;
      const { width } = over.getBoundingClientRect();
      if (!width) return;
      stopWheelZoom?.();
      if (hooks.isRangeDragging()) return;
      pan = { pointer: event.pointerId, origin: event.clientX, x: event.clientX, min, max, width, active: false };
      over.setPointerCapture(event.pointerId);
    });
    over.addEventListener('pointermove', (event) => {
      if (!pan || pan.pointer !== event.pointerId) return;
      pan.x = event.clientX;
      if (!pan.active) {
        if (Math.abs(pan.x - pan.origin) < 3) return;
        stopWheelZoom?.();
        pan.active = true;
        over.classList.add('is-panning');
        hooks.setRangeDragging(true, true);
      }
      displayFrames.schedule('chart-pan', () => drawPan(false), 1);
    });
    /** @param {PointerEvent} event */
    function finish(event) {
      if (!pan || pan.pointer !== event.pointerId) return;
      if (pan.active) {
        if (event.type === 'pointerup') pan.x = event.clientX;
        drawPan(true);
      } else {
        stopChartPan?.();
      }
    }
    over.addEventListener('pointerup', finish);
    over.addEventListener('pointercancel', finish);
    over.addEventListener('lostpointercapture', finish);
  }

  return {
    bindChartWheel,
    bindChartPan,
    stopWheelZoom() {
      stopWheelZoom?.();
    },
    stopChartPan() {
      stopChartPan?.();
    },
  };
}
