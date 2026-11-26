// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * @file uPlot 图表初始化、渲染调度、交互（tooltip / 图例 / X 轴窗口）。
 *
 * uPlot 由 vendor/uPlot.iife.min.js 以全局变量方式载入（本地文件，无网络依赖）。
 * 数据为列式（columnar）格式：state.chartSeries = { x, voltage, current, power, temp, dp, dn, cc1, cc2 }，
 * 主图用有界原始列或独立通道的有序桶几何绘制；共享数组仅承载 uPlot 坐标与光标。
 *
 * 对外 API：
 * - initChart()           初始化主图 + 导航图
 * - scheduleChartUpdate() rAF 节流刷新（流式追加数据用）
 * - updateCharts()        立即刷新
 * - syncChartSeries()     序列数组被整体替换（清空 / 导入 CSV）后重新绑定
 * 「画什么」由可见窗口和统一的显示预算决定：密集窗口折叠为 min/max 桶，
 * 全量仍在 chartSeries；拖动和松手采用同一几何规则。冷暂停复用完整录制投影，再一次升级细节。
 * 极值金字塔只作为速度选择器（见 extremaForStripes），换慢路径不改变产出值。
 * - setChartXWindow()     设置主图 X 轴可见窗口（范围滑块）
 * - setRangeDragging()    连续交互期间复用回看预算与绘制反馈（不改变曲线内容）
 * - setSeriesVisible()    显示 / 隐藏某条曲线（对应 Y 轴自动跟随显隐）
 * - setSeriesFill()       设置某条曲线的填充不透明度（0 = 关闭填充）
 * - setChartFillEnabled() 统一启用 / 关闭监控曲线填充，保留各通道透明度
 */

import { createChartAxes, headroomFrac, VOLTAGE_SCALE_SERIES, Y_AXIS_LABEL_PAD } from './chart-axes.js';
import { BUCKET_MIN, bucketCap, firstIndexAfter, firstIndexAtOrAfter, SeriesBuckets } from './chart-buckets.js';
import { BLOCK_SIZE, ExactExtremaIndex } from './chart-extrema.js';
import { ChartRenderPolicy, liveChartIntervalMs, zoomStrokeFactor } from './chart-pacing.js';
import { createChartInteractions, createCursorAndTooltip, drawMarkers, drawNavigatorMarkers } from './chart-plugins.js';
import { createBucketRasterizer, getEmptyPath } from './chart-raster.js';
import { runCooperativeSlices } from './cooperative.js';
import { displayFrames } from './frame-scheduler.js';
import { t } from './i18n.js';
import { onMarkersChange } from './markers.js';
import { performanceDiagnostics } from './performance-diagnostics.js';
import { state } from './state.js';
import { chartTheme, onThemeChange } from './theme.js';
import { formatRecordingTime, hexToRgba, recordingOriginMs } from './utils.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * 数据集顺序（与复选框 / 设置字段一一对应；uPlot series 下标 = 此下标 + 1）。
 * ⚠ 只允许追加，不允许重排：seriesMax[3]（功率）是导航图的量程来源。
 */
const FIELDS = ['voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2'];
const LABEL_KEYS = ['voltage', 'current', 'power', 'temperature', 'dp', 'dn', 'cc1', 'cc2'];
const UNITS = [' V', ' A', ' W', ' °C', ' V', ' V', ' V', ' V'];
function chartLabel(index) {
  return t(LABEL_KEYS[index]);
}
function chartAxisTitle(key, unit) {
  return `${t(key)} (${unit})`;
}
/** 各 series 挂靠的 scale：D+/D-/CC1/CC2 复用电压 scale（不新增轴）。 */
const SERIES_SCALES = ['voltage', 'current', 'power', 'temp', 'voltage', 'voltage', 'voltage', 'voltage'];

const CHART_FONT_FALLBACK =
  "'Segoe UI Variable Text', 'Segoe UI', -apple-system, BlinkMacSystemFont, system-ui, 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', sans-serif";
const MONO_FONT_FALLBACK =
  "ui-monospace, 'Cascadia Mono', Consolas, 'SF Mono', Menlo, 'Noto Sans Mono', 'DejaVu Sans Mono', 'Microsoft YaHei UI', 'PingFang SC', 'Noto Sans CJK SC', monospace";
let CHART_FONT = CHART_FONT_FALLBACK;
let MONO_FONT = MONO_FONT_FALLBACK;

/**
 * Canvas 字体不会自动解析 CSS 的 var()，因此从同一组 CSS 令牌读取字体栈，
 * 让 uPlot 的坐标轴与应用界面保持一致。
 */
function syncChartFonts() {
  if (typeof getComputedStyle !== 'function' || typeof document === 'undefined' || !document.documentElement) return;
  const styles = getComputedStyle(document.documentElement);
  const uiFont = styles.getPropertyValue('--font-ui').trim();
  const monoFont = styles.getPropertyValue('--font-mono').trim();
  if (uiFont) CHART_FONT = uiFont;
  if (monoFont) MONO_FONT = monoFont;
}

// ─── Module state ────────────────────────────────────────────────────────────

/** 主图数据（列式）：[x, voltage, current, power, temp, dp, dn, cc1, cc2]。 */
/** @typedef {number[]|Float64Array} ChartColView */
/** @type {ChartColView[]} */
let mainData = [[], [], [], [], [], [], [], [], []];
/** 导航图数据：[x, power]（短历史的有界拷贝或桶数组）。 */
/** @type {ChartColView[]} */
let navData = [[], []];

/** 范围滑块设定的主图 X 轴窗口；null 表示尚无数据（使用默认范围）。 */
/** @type {{ min: number|null, max: number|null }} */
const xWindow = { min: null, max: null };

/** 每条曲线的填充色（按 series 下标 1..8，null = 不填充；D+/D-/CC 叠加曲线不填充）。 */
/** @type {(string|null)[]} */
let fillStyles = [null, null, null, null, null, null, null, null, null];

/**
 * 每条曲线全量数据的最大值（按 series 下标 1..8）。
 * Y 轴量程基于全量数据而非可见窗口（与旧版 Chart.js 行为一致，避免拖动滑块时 Y 轴跳动）。
 */
/** @type {number[]} */
let seriesMax = [Number.NaN, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity];
/** 每条曲线全量数据的最小值（温度轴需要保留负值）。 */
/** @type {number[]} */
let seriesMin = [Number.NaN, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity];
/** 已扫描过最大值的数据长度（增量扫描游标）。 */
let scannedLen = 0;

/** 主图窗口级显示桶：超过当前显示分辨率后启用，存储仍走全量列。 */
let displayBuckets = new SeriesBuckets();
// Small existing paths stay synchronous. Large replacements/window scans yield.
const COOPERATIVE_POINTS = 32_768;
const INTERACTION_PREPARE_MS = 4;
// A warm indexed pause normally completes within one frame. Yielding halfway
// through a 10–12 ms query adds a timer turn before its first fine draw.
const PAUSE_PREPARE_MS = 16;
const recordingRenderPolicy = new ChartRenderPolicy({ initialDensity: 1, maxDensity: 4 });
// Review keeps screen-resolution detail, including throughout a gesture. Canvas
// pressure must not leave a static curve at 8–16 px/bucket.
const reviewRenderPolicy = new ChartRenderPolicy({ initialDensity: 1, maxDensity: 1 });
let renderPolicy = reviewRenderPolicy;
/** @type {'recording'|'review'} */
let displayContext = 'review';
/** @type {{generation: number, start: number, cap: number, ppb: number, cancelled: boolean}|null} */
let historyWork = null;
/** @type {{generation: number, start: number, end: number, cap: number, ppb: number, cancelled: boolean}|null} */
let projectionWork = null;
/** @type {{generation:number,revision:number,cancelled:boolean}|null} */
let indexWarmup = null;
/** @type {{target:PreparationTarget,cancelled:boolean,started:boolean,start:()=>void}|null} */
let pauseRefinement = null;
let windowIntent = 0;
let sourceRevision = 0;
/** @typedef {{generation:number,intent:number,revision:number,length:number,start:number,end:number,cap:number,ppb:number,xRange:[number,number],width:number,resolution:number,density:number,mask:number}} PreparationTarget */
/** @type {PreparationTarget|null} */
let preparationTarget = null;

function chartRevision() {
  const cs = state.chartSeries;
  let sum = cs.x.revision;
  for (let i = 0; i < FIELDS.length; i++) sum += cs[FIELDS[i]].revision;
  return sum;
}

/** @param {PreparationTarget} target */
function preparationInvalid(target) {
  return (
    !monitorVisible() ||
    target.generation !== dataGen ||
    target.intent !== windowIntent ||
    target.revision !== chartRevision() ||
    target.width !== plotCssWidth() ||
    target.resolution !== displayResolution() ||
    target.density !== renderPolicy.pixelsPerBucket ||
    target.mask !== visibleChannelMask()
  );
}

/** @param {number} length @param {number} start @param {number} end @param {number} cap @param {number} ppb */
function capturePreparationTarget(length, start, end, cap, ppb) {
  preparationTarget ??= {
    generation: dataGen,
    intent: windowIntent,
    revision: chartRevision(),
    length,
    start,
    end,
    cap,
    ppb,
    xRange: xRange(),
    width: plotCssWidth(),
    resolution: displayResolution(),
    density: renderPolicy.pixelsPerBucket,
    mask: visibleChannelMask(),
  };
  return preparationTarget;
}

function cancelPreparation() {
  if (pauseRefinement) pauseRefinement.cancelled = true;
  pauseRefinement = null;
  if (historyWork) historyWork.cancelled = true;
  if (projectionWork) projectionWork.cancelled = true;
  historyWork = null;
  projectionWork = null;
  preparationTarget = null;
  setPreparing(false);
}

function cancelIndexWarmup() {
  if (indexWarmup) indexWarmup.cancelled = true;
  indexWarmup = null;
}

/** Catch up a fixed prefix between paints; appends never invalidate that prefix. */
function scheduleIndexWarmup() {
  const length = state.chartSeries.x.length;
  if (
    indexWarmup ||
    historyWork ||
    projectionWork ||
    rangeDragging ||
    !state.isRecording ||
    !monitorVisible() ||
    length <= COOPERATIVE_POINTS ||
    extremaIndex.blocks >= Math.floor(length / BLOCK_SIZE)
  )
    return;
  const work = { generation: dataGen, revision: chartRevision(), cancelled: false };
  indexWarmup = work;
  const series = channelBufs();
  const invalid = () =>
    work.cancelled ||
    work.generation !== dataGen ||
    work.revision !== chartRevision() ||
    !state.isRecording ||
    !monitorVisible() ||
    !!historyWork ||
    !!projectionWork ||
    rangeDragging;
  void runCooperativeSlices(
    () => {
      const started = performance.now();
      const complete = extremaIndex.syncStep(series, length, 32);
      performanceDiagnostics.domCommit('chart-index-warmup', started);
      return complete;
    },
    { sliceMs: 1, isCancelled: invalid },
  )
    .then((complete) => {
      if (indexWarmup !== work) return;
      indexWarmup = null;
      if (complete) scheduleIndexWarmup();
    })
    .catch((error) => {
      if (indexWarmup === work) indexWarmup = null;
      console.error('Chart index warmup failed', error);
    });
}

/** @param {boolean} busy */
function setPreparing(busy) {
  document.getElementById('main-chart')?.setAttribute?.('aria-busy', String(busy));
}
/**
 * 金字塔冷建是 O(全量) 的一次性开销（实测 1M ≈ 26ms / 5M ≈ 118ms），只为这么密的条带付。
 * 已 warm 之后每个新块只有微秒级增量，所以下限可以放到 BLOCK_SIZE。
 */
const COLD_BUILD_PPB = 64;
const extremaIndex = new ExactExtremaIndex();
/** @typedef {'raw'|'window'} BoundKind */
/** @type {BoundKind} */
let boundKind = 'raw';
let rawStart = 0;
let rawEnd = 0;
/** @type {{generation:number,start:number,end:number,visible:number,width:number,height:number,raw:boolean}|null} */
let rawWindowCache = null;
/** 范围手柄是否正在拖动（推迟导航图重建与 Y 轴重算，不改变曲线内容）。 */
let rangeDragging = false;
/** 上次完整 apply 时的数据代数；主图绑定的正确性由 bindingCovers 判断，不记宽度。 */
let appliedMainGen = -1;
/** Last submitted X window; null invalidates reuse after replacing the source. */
/** @type {[number, number]|null} */
let appliedXRange = null;

/** 数据代数 — 序列数组被整体替换（清空 / 导入）时递增，用于跳过导航图不必要的重建。 */
let dataGen = 0;
/** 导航图最近一次 setData 时的代数与长度；仅数据变化时才重建导航图（X 窗口拖动不触碰它）。 */
let appliedNavGen = -1;
let appliedNavLen = -1;

let chartDirty = false;
const tooltipThemeGen = 0;
let chartFramePending = false;
let flushingChart = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let chartPaceTimer = null;
let lastLiveFlushAt = 0;
let liveChartPrepareMs = 0;
let liveMainDrawMs = 0;
let liveNavDrawMs = 0;
let visiblePointCount = 0;
let visiblePlotWidth = 600;
// Imported/preloaded history is not a live append batch. Count only since the last main submission.
let submittedSourceLen = 0;
let recentAppendCount = 0;
let feedbackRecording = false;
/** @type {number|null} */
let chartProbeFrame = null;
// Density feedback can request a maintenance draw.
let feedbackRepaintPending = false;
let feedbackEpoch = 0;
let paintBatchId = 0;
let pauseId = 0;
/** @type {{id:number,requestedAt:number,length:number,generation:number,intent:number}|null} */
let pauseContext = null;
/** @typedef {'live'|'interaction'|'maintenance'} ChartRefreshSource */
/** @typedef {{ batchId: number, requestedAt: number, prepareMs: number|null, source: ChartRefreshSource, reason:string, pause:typeof pauseContext }} PaintRequest */
/** @type {PaintRequest|null} */
let paintRequest = null;
/** @type {WeakMap<object, { first: PaintRequest, last: PaintRequest, count: number, firstDiagnostic: any, lastDiagnostic: any }>} */
const pendingDraws = new WeakMap();
/** @type {WeakMap<object, number>} */
const drawStarts = new WeakMap();
/** @type {WeakMap<object, Record<string, number>>} */
const drawStages = new WeakMap();
let chartListenersRegistered = false;

function monitorVisible() {
  return state.settings.activeView === 'monitor' && state.windowVisible && !document.hidden;
}

// The overview retains its existing bucket budget and only uses the power channel.
const navBuckets = new SeriesBuckets(1);
const navIndex = new ExactExtremaIndex(1);
let navSrcLen = 0;
/** @type {import('./chart-buckets.js').OrderedGeometry|null} */
let navGeometry = null;
let lastNavPaint = 0;
/** @type {ReturnType<typeof setTimeout>|null} */
let navPaceTimer = null;
const NAV_PAINT_MIN_MS = 100;
function navMaxBuckets() {
  return bucketCap((document.getElementById('navigator-chart')?.clientWidth || 600) / 2);
}
function resetNavBuckets() {
  navBuckets.reset();
  navIndex.reset();
  navSrcLen = 0;
  navGeometry = null;
}

function cancelNavigatorPaint() {
  displayFrames.cancel('chart-navigator');
  if (navPaceTimer !== null) clearTimeout(navPaceTimer);
  navPaceTimer = null;
}

/** 把新样本折进导航桶；不 flatten、不 setData。 */
function syncNavBuckets(through = state.chartSeries.x.length) {
  const cs = state.chartSeries;
  const n = Math.min(through, cs.x.length);
  const cap = navMaxBuckets();
  const ps = cs.power;
  if (n <= cap) {
    if (navSrcLen > n) resetNavBuckets();
    return;
  }
  if (navSrcLen > n) resetNavBuckets();
  if (navSrcLen < n) foldNavRange(cs.x, ps, navSrcLen, n, cap);
}

/** @param {import('./state.js').F64Col} _xs @param {import('./state.js').F64Col} ps @param {number} _start @param {number} end @param {number} _cap */
function foldNavRange(_xs, ps, _start, end, _cap) {
  navIndex.sync([ps], end);
  navSrcLen = end;
}

function bindNavData() {
  const cs = state.chartSeries,
    n = cs.x.length;
  const cap = navMaxBuckets();
  syncNavBuckets();
  if (n <= cap) {
    navData = [cs.x.copyRange(0, n), cs.power.copyRange(0, n)];
    navGeometry = null;
  } else {
    navBuckets.rebuildByX(cs.x, [cs.power], 0, n, cs.x.at(0), cs.x.at(-1), cap, navIndex);
    const flat = navBuckets.flatten();
    navGeometry = flat.channels[0];
    navData = [flat.x, flat.ys[0]];
  }
}

/** @type {any} */
let linearBuilder = null;
/** @type {import('./chart-buckets.js').OrderedGeometry[]} */
let mainGeometry = [];
/** @type {WeakMap<object, Map<number, any>>} */
let orderedPaints = new WeakMap();

const rasterizer = createBucketRasterizer({
  isMainChart: (u) => u === state.mainChart,
  isWindowBound: () => boundKind === 'window',
  isRangeDragging: () => rangeDragging,
  getPlotPixelRatio: () => plotPixelRatio(),
  getOrderedPaint: (u, seriesIdx) => orderedPaints.get(u)?.get(seriesIdx),
  recordPaintStage,
});

const chartAxes = createChartAxes({
  getSeriesMax: () => seriesMax,
  getSeriesMin: () => seriesMin,
  getChartFont: () => CHART_FONT,
  getMonoFont: () => MONO_FONT,
  scheduleChartUpdate: () => scheduleChartUpdate(),
  formatXAxisTick(value) {
    const useSystemTime = state.settings.useSystemTime;
    const originMs = useSystemTime ? recordingOriginMs(state.chartSeries, state.lastRecordingStartTime) : null;
    return formatRecordingTime(Number(value), { useSystemTime, originMs });
  },
});

const cursorTooltip = createCursorAndTooltip({
  fields: FIELDS,
  seriesScales: SERIES_SCALES,
  units: UNITS,
  chartLabel,
  isMainGenFresh: () => appliedMainGen === dataGen,
  getDataGen: () => dataGen,
  getTooltipThemeGen: () => tooltipThemeGen,
  monitorVisible,
});

const interactions = createChartInteractions({
  monitorVisible,
  isRangeDragging: () => rangeDragging,
  setRangeDragging,
  xRange,
  updateCharts,
});

/** @param {any} u @param {string} name @param {number} started @param {number} [count=1] */
function recordPaintStage(u, name, started, count = 1) {
  const stages = drawStages.get(u);
  if (!stages) return;
  stages[`${name}Ms`] = (stages[`${name}Ms`] || 0) + performance.now() - started;
  stages[`${name}Count`] = (stages[`${name}Count`] || 0) + count;
}

/** The carrier is for uPlot coordinates/cursor only; every channel draws its own candidates. */
function adaptivePaths(u, seriesIdx, idx0, idx1) {
  const main = u === state.mainChart;
  const geometry = main ? (boundKind === 'window' ? mainGeometry[seriesIdx - 1] : null) : navGeometry;
  if (!geometry) return linearBuilder ? linearBuilder(u, seriesIdx, idx0, idx1) : null;
  const started = performance.now();
  const series = u.series[seriesIdx];
  const base = series.fillTo
    ? u.valToPos(series.fillTo(u, seriesIdx, series.min, series.max, 0), series.scale, true)
    : NaN;
  let cache = orderedPaints.get(u);
  if (!cache) {
    cache = new Map();
    orderedPaints.set(u, cache);
  }
  const prior = cache.get(seriesIdx),
    sx = u.scales?.x,
    sy = u.scales?.[series.scale],
    bbox = u.bbox ?? {},
    key = [bbox.left, bbox.top, bbox.width, bbox.height, plotPixelRatio(), sx?.min, sx?.max, sy?.min, sy?.max, base];
  let paint = prior;
  if (
    !prior ||
    prior.geometry !== geometry ||
    prior.project !== u.valToPos ||
    key.some((value, i) => !Object.is(value, prior.key[i]))
  ) {
    const gx = geometry.x,
      gy = geometry.y,
      gconn = geometry.connect,
      len = gx.length;
    const size = len * 2;
    const buffer = prior?.buffer.length >= size ? prior.buffer : new Float64Array(Math.max(64, size));
    const points = buffer.subarray(0, size);
    let verticalTravel = 0;
    let useAffine =
      len > 0 &&
      sx?.distr !== 3 &&
      sy?.distr !== 3 &&
      sx?.min != null &&
      sx?.max != null &&
      sx.max > sx.min &&
      sy?.min != null &&
      sy?.max != null &&
      sy.max > sy.min;
    let x0 = 0,
      px0 = 0,
      ax = 0,
      y0 = 0,
      py0 = 0,
      ay = 0;
    if (useAffine) {
      x0 = sx.min;
      const x1 = sx.max,
        xMid = (x0 + x1) * 0.5;
      px0 = u.valToPos(x0, 'x', true);
      const px1 = u.valToPos(x1, 'x', true),
        pxMid = u.valToPos(xMid, 'x', true);
      ax = (px1 - px0) / (x1 - x0);
      y0 = sy.min;
      const y1 = sy.max,
        yMid = (y0 + y1) * 0.5;
      py0 = u.valToPos(y0, series.scale, true);
      const py1 = u.valToPos(y1, series.scale, true),
        pyMid = u.valToPos(yMid, series.scale, true);
      ay = (py1 - py0) / (y1 - y0);
      useAffine =
        Number.isFinite(ax) &&
        Number.isFinite(px0) &&
        Number.isFinite(ay) &&
        Number.isFinite(py0) &&
        Math.abs(px0 + (xMid - x0) * ax - pxMid) <= 1e-6 &&
        Math.abs(py0 + (yMid - y0) * ay - pyMid) <= 1e-6;
    }
    if (useAffine) {
      let prevY = 0;
      for (let i = 0; i < len; i++) {
        const px = px0 + (gx[i] - x0) * ax;
        const py = py0 + (gy[i] - y0) * ay;
        points[i * 2] = px;
        points[i * 2 + 1] = py;
        if (gconn[i]) verticalTravel += Math.abs(py - prevY);
        prevY = py;
      }
    } else {
      let prevY = 0;
      for (let i = 0; i < len; i++) {
        points[i * 2] = u.valToPos(gx[i], 'x', true);
        const py = u.valToPos(gy[i], series.scale, true);
        points[i * 2 + 1] = py;
        if (gconn[i]) verticalTravel += Math.abs(py - prevY);
        prevY = py;
      }
    }
    paint = {
      geometry,
      project: u.valToPos,
      key,
      buffer,
      points,
      connect: gconn,
      base,
      // Highly retraced paths can defer seconds of GPU work on WebView2. Use
      // analytic area coverage there; ordinary fills avoid the CPU mask cost.
      rasterFill: verticalTravel > bbox.width * 64,
      intervalBuffer: prior?.intervalBuffer,
      offsetBuffer: prior?.offsetBuffer,
    };
    cache.set(seriesIdx, paint);
    recordPaintStage(u, 'coordinates', started);
  } else recordPaintStage(u, 'coordinatesCached', started);
  // The bitmap path has no discarded standard stroke/fill construction.
  if (main && rasterizer.useBucketRaster(u)) return { stroke: getEmptyPath(), fill: null };
  if (paint.stroke)
    return main && series.fill(u, seriesIdx)
      ? { stroke: getEmptyPath(), fill: null }
      : { stroke: paint.stroke, fill: null };
  const { points } = paint;
  const stroke = new Path2D();
  for (let i = 0; i < geometry.x.length; i++) {
    const x = points[i * 2],
      y = points[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (geometry.connect[i]) stroke.lineTo(x, y);
    else stroke.moveTo(x, y);
  }
  paint.stroke = stroke;
  if (main && series.fill(u, seriesIdx)) {
    // Keep fallback compositing identical: area first, then the channel stroke.
    return { stroke: getEmptyPath(), fill: null };
  }
  return { stroke, fill: null };
}

// ─── Data binding ────────────────────────────────────────────────────────────

/**
 * 将图表数据重新指向当前的 chartSeries 数组，并重置最大值跟踪。
 * 仅在序列数组被整体替换（清空、导入 CSV）后需要调用；
 * 追加数据点时数组引用不变，无需重新绑定。
 */
function bindMainViews(start, end) {
  const cs = state.chartSeries;
  rawStart = Math.max(0, start - 1);
  rawEnd = Math.min(cs.x.length, end + 1);
  mainData = [cs.x, ...channelBufs()].map((column) => column.copyRange(rawStart, rawEnd));
}

export function syncChartSeries() {
  interactions.stopWheelZoom();
  interactions.stopChartPan();
  pauseContext = null;
  cancelNavigatorPaint();
  cancelIndexWarmup();
  cancelPreparation();
  cancelFrameProbe();
  selectDisplayContext(state.isRecording ? 'recording' : 'review');
  recordingRenderPolicy.reset();
  reviewRenderPolicy.reset();
  sourceRevision = chartRevision();
  rasterizer.reset();
  orderedPaints = new WeakMap();
  mainGeometry = [];
  submittedSourceLen = state.chartSeries.x.length;
  recentAppendCount = 0;
  feedbackRecording = state.isRecording;
  liveChartPrepareMs = liveMainDrawMs = liveNavDrawMs = lastLiveFlushAt = 0;
  mainData = [[], [], [], [], [], [], [], [], []];
  rawStart = 0;
  rawEnd = 0;
  rawWindowCache = null;
  extremaIndex.reset();
  displayBuckets.reset(0);
  boundKind = 'raw';
  appliedMainGen = -1;
  appliedXRange = null;
  resetNavBuckets();
  seriesMax = [Number.NaN, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity];
  seriesMin = [Number.NaN, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity];
  scannedLen = 0;
  dataGen++;
  for (const chart of [state.mainChart, state.navigatorChart]) {
    if (chart) pendingDraws.delete(chart);
  }
  if (state.chartSeries.x.length <= COOPERATIVE_POINTS) {
    bindNavData();
    trackNewPoints();
  }
}

/** @param {boolean} dragging @param {boolean} [fromChart] */
export function setRangeDragging(dragging, fromChart = false) {
  if (!fromChart) {
    interactions.stopWheelZoom();
    interactions.stopChartPan();
  }
  if (dragging && !rangeDragging) {
    cancelIndexWarmup();
    selectDisplayContext('review');
    cancelFrameProbe();
  }
  rangeDragging = !!dragging;
  state.__rangeDragging = rangeDragging;
}

/**
 * 增量扫描新追加的数据点，维护每条曲线的全量 min/max。
 * @returns {boolean} 是否有任一通道极值变化（决定 setData 要不要重算 Y 轴）
 */
function trackNewPoints(through = state.chartSeries.x.length) {
  const cs = state.chartSeries;
  const len = Math.min(through, cs.x.length);
  if (len <= scannedLen) {
    scannedLen = len;
    return false;
  }
  const cols = channelBufs();
  let changed = false;
  for (let si = 0; si < cols.length; si++) {
    const arr = cols[si];
    let max = seriesMax[si + 1];
    let min = seriesMin[si + 1];
    for (const { values } of arr.chunks(scannedLen, len)) {
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Number.isFinite(v)) {
          if (v > max) {
            max = v;
            changed = true;
          }
          if (v < min) {
            min = v;
            changed = true;
          }
        }
      }
    }
    seriesMax[si + 1] = max;
    seriesMin[si + 1] = min;
  }
  scannedLen = len;
  if (changed) rawWindowCache = null;
  return changed;
}

function sourceRange() {
  const xs = state.chartSeries.x;
  const n = xs.length;
  if (n === 0) return { start: 0, end: 0 };
  if (xWindow.min == null || xWindow.max == null) return { start: 0, end: n };
  const start = firstIndexAtOrAfter(xs, n, xWindow.min);
  let end = firstIndexAfter(xs, n, xWindow.max);
  if (end <= start) end = Math.min(n, start + 1);
  return { start, end };
}

/**
 * 绘图区 CSS 宽度，`bucketCap` 由它定条带密度。
 * `bbox.width` 是设备像素，而换算比在建图时就被烘进每张图 —— vendor 包里 dppx 监听只改静态
 * `uPlot.pxRatio`，没有 `setPxRatio`。拿静态值去除会在改系统缩放 / 换屏后得到一个既不是旧宽也不是
 * 新宽的宽度。后备宽 ÷ CSS 宽 才是渲染真正在用的比值：画布陈旧时它一起陈旧，条带密度就仍匹配正在显示的画面。
 */
function plotPixelRatio() {
  const chart = state.mainChart;
  const backing = chart?.ctx?.canvas?.width;
  const css = chart?.width;
  if (backing > 0 && css > 0) return backing / css;
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  return typeof uPlot !== 'undefined' ? uPlot.pxRatio || dpr : dpr;
}

function plotCssWidth() {
  const bboxWidth = state.mainChart?.bbox?.width;
  if (bboxWidth > 0) return bboxWidth / plotPixelRatio();
  return document.getElementById('main-chart')?.clientWidth || 600;
}

/** Review and live recording both resolve physical Canvas pixels. */
function displayResolution(width = plotCssWidth()) {
  return width * plotPixelRatio();
}

/** Sparse windows retain raw samples even after a dense recording reduced its budget. @param {number} count */
function mainBucketCap(count) {
  const width = plotCssWidth();
  const cap = displayResolution(width) / (displayDense(count, width) ? renderPolicy.pixelsPerBucket : 1);
  return bucketCap(cap);
}

/** Keep medium zooms on real sample geometry with a bounded copy/vertex budget. */
function mainRawLimit() {
  return displayContext === 'review'
    ? Math.min(16_384, Math.floor(displayResolution() * 4))
    : Math.floor(displayResolution());
}

/** Bound retraced Canvas strokes as well as vertices; fixed data keeps the same choice through a gesture. */
function useRawWindow(start, end) {
  const count = end - start;
  if (count > mainRawLimit()) return false;
  if (count <= displayResolution()) return true;
  const chart = state.mainChart;
  if (!chart?.series || !chart.bbox?.height) return true;
  const visible = chart.series.reduce((mask, series, s) => (s > 0 && series.show ? mask | (1 << (s - 1)) : mask), 0);
  const width = displayResolution();
  const height = chart.bbox.height;
  const cached = rawWindowCache;
  if (
    cached?.generation === dataGen &&
    cached.start === start &&
    cached.end === end &&
    cached.visible === visible &&
    cached.width === width &&
    cached.height === height
  )
    return cached.raw;
  // Sum vertical travel relative to the full signal range. Near-flat noise can
  // use raw geometry; repeated large swings retain the bounded bucket raster.
  let remaining = Math.max(32, (width / height) * 48);
  const series = channelBufs();
  for (let s = 0; s < series.length && remaining >= 0; s++) {
    if (!(visible & (1 << s))) continue;
    const span = Math.max(Math.abs(seriesMin[s + 1]), Math.abs(seriesMax[s + 1]), seriesMax[s + 1] - seriesMin[s + 1]);
    if (!Number.isFinite(span) || span === 0) continue;
    let previous = Number.NaN;
    for (const { values } of series[s].chunks(start, end)) {
      for (const value of values) {
        if (Number.isFinite(value) && Number.isFinite(previous)) remaining -= Math.abs(value - previous) / span;
        previous = value;
        if (remaining < 0) break;
      }
      if (remaining < 0) break;
    }
  }
  const raw = remaining >= 0;
  rawWindowCache = { generation: dataGen, start, end, visible, width, height, raw };
  return raw;
}

/** Display projection and pacing eligibility; this does not suppress fill. */
function displayDense(count = visiblePointCount, width = visiblePlotWidth) {
  return count > displayResolution(width);
}

function currentWindowDense() {
  const { start, end } = sourceRange();
  return displayDense(end - start, plotCssWidth());
}

function liveRefreshInterval() {
  const dense = currentWindowDense();
  return liveChartIntervalMs(
    liveChartPrepareMs + liveMainDrawMs + liveNavDrawMs,
    dense,
    dense ? renderPolicy.nextFrameDelayMs : 0,
    renderPolicy.idleFrameMs,
  );
}

/** @type {typeof state.chartSeries | null} */
let cachedChannelSeriesSource = null;
/** @type {import('./state.js').F64Col[]|null} */
let cachedChannelBufs = null;

function channelBufs() {
  const cs = state.chartSeries;
  if (cs !== cachedChannelSeriesSource || !cachedChannelBufs) {
    cachedChannelSeriesSource = cs;
    cachedChannelBufs = [cs.voltage, cs.current, cs.power, cs.temp, cs.dp, cs.dn, cs.cc1, cs.cc2];
  }
  return cachedChannelBufs;
}

/** @param {SeriesBuckets} buckets @param {BoundKind} kind */
function bindFlattenedBuckets(buckets, kind) {
  const flat = buckets.flatten();
  mainData = [flat.x, ...flat.ys];
  mainGeometry = flat.channels;
  boundKind = kind;
}

function visibleChannelMask() {
  const series = state.mainChart?.series;
  if (!series) return 0xff;
  let mask = 0;
  for (let s = 0; s < FIELDS.length; s++) {
    if (series[s + 1]?.show !== false) mask |= 1 << s;
  }
  return mask;
}

/** @param {number} count @param {number} cap */
function mainProjectionPpb(count, cap) {
  return Math.max(1, Math.ceil(count / Math.max(BUCKET_MIN, Math.floor(cap))));
}

/**
 * 条带折叠的**速度选择器**：只决定耗时，不决定产出值 —— 金字塔 fold 与逐样本扫描对同一区间
 * 得到同一组 min/max（`test/chart-extrema.test.js` 钉着这条等价）。
 * At a given display density, warm and cold projections retain the same extrema.
 * @param {import('./chart-buckets.js').NumericColumn[]} series @param {number} end @param {number} ppb
 * @returns {ExactExtremaIndex|null}
 */
function extremaForStripes(series, end, ppb) {
  // 条带不超过一个块时，fold 的 head/tail 暴力扫就等于整条，金字塔省不下读取。
  if (ppb <= BLOCK_SIZE) return null;
  // 窗口内已完成的块都建好了才算 warm；冷建是 O(全量) 的一次性开销，只留给足够密的窗口付。
  const warm = extremaIndex.blocks >= Math.floor(end / BLOCK_SIZE);
  // A shorter viewport is a query of the existing prefix, not a source shrink.
  // sync() deliberately resets on actual truncation; never call it for a warm query.
  if (warm) return extremaIndex;
  if (ppb < COLD_BUILD_PPB && (extremaIndex.blocks === 0 || end - extremaIndex.blocks * BLOCK_SIZE > 4096)) {
    return null;
  }
  extremaIndex.sync(series, end);
  return extremaIndex;
}

/**
 * Prepare full-history auxiliaries without falling back to a full raw scan in
 * the requesting frame. Appends do not invalidate the fixed prefix in progress.
 * @param {number} length @param {number} end @param {number} ppb
 * @param {boolean} reuseProjection @param {PaintRequest} request
 */
function prepareLargeHistory(length, end, ppb, reuseProjection, request) {
  if (historyWork) return true;
  const cap = navMaxBuckets();
  const range = preparationTarget ?? sourceRange();
  const needIndex =
    !reuseProjection && ppb >= COLD_BUILD_PPB && end - extremaIndex.blocks * BLOCK_SIZE > COOPERATIVE_POINTS;
  if (
    length - scannedLen <= COOPERATIVE_POINTS &&
    (length <= cap || length - navSrcLen <= COOPERATIVE_POINTS) &&
    !needIndex
  )
    return false;
  cancelIndexWarmup();
  const work = {
    generation: dataGen,
    start: range.start,
    cap: mainBucketCap(range.end - range.start),
    ppb,
    cancelled: false,
  };
  const target = capturePreparationTarget(length, range.start, end, work.cap, ppb);
  historyWork = work;
  const cs = state.chartSeries;
  const series = channelBufs();
  setPreparing(true);
  void runCooperativeSlices(
    () =>
      measurePreparation(request, () => {
        if (scannedLen < length) {
          trackNewPoints(Math.min(length, scannedLen + 4096));
          return false;
        }
        if (length > cap && navSrcLen < length) {
          const through = Math.min(length, navSrcLen + 4096);
          foldNavRange(cs.x, cs.power, navSrcLen, through, cap);
          return false;
        }
        return !needIndex || extremaIndex.syncStep(series, end);
      }),
    {
      isCancelled: () => {
        return work.cancelled || preparationInvalid(target);
      },
    },
  )
    .then((complete) => {
      if (historyWork !== work) return;
      historyWork = null;
      setPreparing(false);
      if (!complete) preparationTarget = null;
      if (!work.cancelled && work.generation === dataGen) updateCharts();
    })
    .catch((error) => {
      if (historyWork === work) {
        historyWork = null;
        setPreparing(false);
      }
      console.error('Chart history preparation failed', error);
    });
  return true;
}

/** Reuse a complete recording projection before a cold review index is ready.
 * @param {number} start @param {number} end @param {number} cap */
function usePausePreview(start, end, cap) {
  const ppb = mainProjectionPpb(end - start, cap);
  const mask = visibleChannelMask();
  if (pauseRefinement && (state.isRecording || preparationInvalid(pauseRefinement.target))) {
    pauseRefinement.cancelled = true;
    pauseRefinement = null;
    setPreparing(false);
  }
  if (!pauseRefinement) {
    if (
      state.isRecording ||
      rangeDragging ||
      appliedMainGen !== dataGen ||
      boundKind !== 'window' ||
      displayBuckets.srcStart !== start ||
      displayBuckets.srcEnd > end ||
      end - displayBuckets.srcEnd > 4096 ||
      (displayBuckets.mode === 'x' && displayBuckets.xCap >= Math.max(BUCKET_MIN, Math.floor(cap))) ||
      (displayBuckets.channelMask & mask) !== mask ||
      end - extremaIndex.blocks * BLOCK_SIZE <= COOPERATIVE_POINTS ||
      !appliedXRange ||
      appliedXRange[0] !== xRange()[0] ||
      (appliedXRange[1] !== xRange()[1] && end === displayBuckets.srcEnd)
    )
      return false;
    const target = {
      generation: dataGen,
      intent: windowIntent,
      revision: chartRevision(),
      length: state.chartSeries.x.length,
      start,
      end,
      cap,
      ppb,
      xRange: xRange(),
      width: plotCssWidth(),
      resolution: displayResolution(),
      density: renderPolicy.pixelsPerBucket,
      mask,
    };
    const work = { target, cancelled: false, started: false, start: () => {} };
    pauseRefinement = work;
    const cs = state.chartSeries,
      xs = cs.x.snapshot(),
      series = channelBufs().map((col) => col.snapshot());
    const buckets = new SeriesBuckets();
    let prepareMs = 0;
    /** @type {ReturnType<SeriesBuckets['beginRebuildByX']>|null} */
    let step = null;
    setPreparing(true);
    work.start = () => {
      if (work.started || work.cancelled || preparationInvalid(target)) return;
      work.started = true;
      void runCooperativeSlices(
        () => {
          const started = performance.now();
          try {
            if (extremaIndex.blocks < Math.floor(end / BLOCK_SIZE)) {
              extremaIndex.syncStep(series, end, 32);
              return false;
            }
            step ??= buckets.beginRebuildByX(
              xs,
              series,
              start,
              end,
              target.xRange[0],
              target.xRange[1],
              cap,
              extremaIndex,
              mask,
            );
            return step(Infinity, 16);
          } finally {
            prepareMs += performance.now() - started;
          }
        },
        { sliceMs: 1, isCancelled: () => work.cancelled || state.isRecording || preparationInvalid(target) },
      )
        .then((complete) => {
          if (pauseRefinement !== work) return;
          pauseRefinement = null;
          setPreparing(false);
          if (!complete || preparationInvalid(target) || state.isRecording) return;
          const latest = sourceRange();
          if (latest.start !== start || latest.end < end || latest.end - end > 4096) {
            updateCharts();
            return;
          }
          if (latest.end > end) {
            extremaIndex.sync(channelBufs(), latest.end);
            const liveRange = xRange();
            buckets.rebuildByX(
              cs.x,
              channelBufs(),
              start,
              latest.end,
              liveRange[0],
              liveRange[1],
              mainBucketCap(latest.end - start),
              extremaIndex,
              mask,
            );
          }
          displayBuckets = buckets;
          bindFlattenedBuckets(buckets, 'window');
          appliedMainGen = -1;
          const request = requestPaint('maintenance', 'refinement');
          request.prepareMs = (request.prepareMs ?? 0) + prepareMs;
          updateCharts('maintenance', { force: false, reason: 'refinement' });
        })
        .catch((error) => {
          if (pauseRefinement === work) {
            pauseRefinement = null;
            setPreparing(false);
          }
          console.error('Chart pause refinement failed', error);
        });
    };
  }
  if (end < displayBuckets.srcEnd || end - displayBuckets.srcEnd > 4096 || start !== displayBuckets.srcStart) {
    cancelPreparation();
    return false;
  }
  if (end > displayBuckets.srcEnd) {
    displayBuckets.appendThroughFixed(state.chartSeries.x, channelBufs(), end);
    bindFlattenedBuckets(displayBuckets, 'window');
    appliedMainGen = -1;
  }
  return true;
}

/** Only a cold-index stripe fallback can advance through pairwise merging. @param {number} start @param {number} end @param {number} ppb */
function canAdvanceBuckets(start, end, ppb) {
  return (
    displayBuckets.mode === 'stripe' &&
    end - extremaIndex.blocks * BLOCK_SIZE > COOPERATIVE_POINTS &&
    displayBuckets.list.length > 0 &&
    displayBuckets.canAppend(start, end) &&
    end - displayBuckets.srcEnd <= 4096 &&
    (ppb === displayBuckets.ppb || (start === 0 && end === state.chartSeries.x.length && ppb > displayBuckets.ppb))
  );
}

/** @param {number} start @param {number} end @param {number} cap @param {PaintRequest} request */
function prepareLargeProjection(start, end, cap, request) {
  const count = end - start;
  const ppb = mainProjectionPpb(count, cap);
  if (projectionWork && (!preparationTarget || preparationInvalid(preparationTarget))) {
    projectionWork.cancelled = true;
    projectionWork = null;
  }
  if (projectionWork) return true;
  const range = preparationTarget?.xRange ?? xRange();
  const mask = preparationTarget?.mask ?? visibleChannelMask();
  if (count <= COOPERATIVE_POINTS || stripesMatch(start, end, count, cap, range, mask)) return false;
  // A short append still uses the existing cheap incremental path.
  if (canAdvanceBuckets(start, end, ppb)) return false;
  const priorTarget = preparationTarget;
  const target = capturePreparationTarget(state.chartSeries.x.length, start, end, cap, ppb);
  const cs = state.chartSeries;
  const series = channelBufs().map((column) => column.snapshot());
  const index = extremaForStripes(series, end, ppb);
  const buckets = new SeriesBuckets();
  const step = buckets.beginRebuildByX(
    cs.x.snapshot(),
    series,
    start,
    end,
    target.xRange[0],
    target.xRange[1],
    cap,
    index,
    target.mask,
  );
  // Indexed folds visit O(buckets) nodes and short raw boundaries. Charging the
  // covered sample count forced even cheap warm queries through many task yields.
  const advance = () => (index ? step(Infinity, 32) : step(4096));
  {
    // A pause replaces the paced recording job. Allow a small complete warm
    // query to finish here instead of adding a task yield and another frame.
    const deadline = performance.now() + (request.reason === 'pause' ? PAUSE_PREPARE_MS : INTERACTION_PREPARE_MS);
    do {
      const complete = advance();
      if (preparationInvalid(target)) break;
      if (complete) {
        displayBuckets = buckets;
        bindFlattenedBuckets(displayBuckets, 'window');
        appliedMainGen = -1;
        if (!priorTarget) preparationTarget = null;
        return false;
      }
    } while (performance.now() < deadline);
  }
  const work = { generation: dataGen, start, end, cap, ppb, cancelled: false };
  projectionWork = work;
  setPreparing(true);
  void runCooperativeSlices(() => measurePreparation(request, advance), {
    isCancelled: () => {
      return work.cancelled || preparationInvalid(target);
    },
  })
    .then((complete) => {
      if (projectionWork !== work) return;
      projectionWork = null;
      setPreparing(false);
      if (complete && !preparationInvalid(target)) {
        // Publish only internally here. The next apply appends a bounded live tail
        // before submitting, or prepares a new snapshot if the tail grew too far.
        displayBuckets = buckets;
        bindFlattenedBuckets(displayBuckets, 'window');
        appliedMainGen = -1;
      } else preparationTarget = null;
      if (!work.cancelled && work.generation === dataGen) updateCharts();
    })
    .catch((error) => {
      if (projectionWork === work) {
        projectionWork = null;
        setPreparing(false);
      }
      console.error('Chart projection preparation failed', error);
    });
  return true;
}

/**
 * 现有桶是否正好是窗口 `(start,end)` 在该像素预算、X 范围与可见通道下应当画出的那批。
 * @param {number} start @param {number} end @param {number} _windowCount @param {number} cap
 * @param {[number, number]} [range] @param {number} [mask]
 */
function stripesMatch(start, end, _windowCount, cap, range = xRange(), mask = visibleChannelMask()) {
  const targetCap = Math.max(BUCKET_MIN, Math.floor(cap));
  return (
    displayBuckets.mode === 'x' &&
    displayBuckets.srcStart === start &&
    displayBuckets.srcEnd === end &&
    displayBuckets.xCap === targetCap &&
    displayBuckets.xMin === range[0] &&
    displayBuckets.xMax === range[1] &&
    (displayBuckets.channelMask & mask) === mask &&
    displayBuckets.list.length > 0
  );
}

/**
 * 当前绑定的顶点是否已经就是本窗口该画的那批，因而只需 setScale。
 * @param {number} start @param {number} end @param {number} windowCount @param {number} cap
 * @param {[number, number]} [range] @param {number} [mask]
 */
function bindingCovers(start, end, windowCount, cap, range = xRange(), mask = visibleChannelMask()) {
  if (useRawWindow(start, end)) {
    // Keep both neighbours: uPlot needs their segments at clipped boundaries.
    return (
      boundKind === 'raw' &&
      rawStart <= Math.max(0, start - 1) &&
      rawEnd >= Math.min(state.chartSeries.x.length, end + 1)
    );
  }
  return boundKind === 'window' && stripesMatch(start, end, windowCount, cap, range, mask);
}

function applyXScale(range = xRange()) {
  if (!state.mainChart) return;
  const [min, max] = range;
  state.mainChart.setScale('x', { min, max });
}

/**
 * 「画什么」的唯一定义：把主图绑到窗口 `[start,end)` 在 `[xMin, xMax]` 像素列下的
 * M4 极值几何；中等缩放在有界顶点预算内复制原始样本及裁剪邻点。拖动中与松手后都只经过这里。
 * @param {{ cap: number, start: number, end: number, windowCount: number, force: boolean, range: [number, number], mask: number }} args
 */
function bindDisplayData(args) {
  const { cap, start, end, windowCount, range, mask } = args;
  const cs = state.chartSeries;

  if (useRawWindow(start, end)) {
    if (boundKind === 'raw' && rawStart <= Math.max(0, start - 1) && rawEnd >= Math.min(cs.x.length, end + 1)) return;
    boundKind = 'raw';
    bindMainViews(start, end);
    return;
  }

  const ppb = mainProjectionPpb(windowCount, cap);
  const series = channelBufs();

  if (stripesMatch(start, end, windowCount, cap, range, mask)) {
    if (boundKind !== 'window') bindFlattenedBuckets(displayBuckets, 'window');
    return;
  }

  if (canAdvanceBuckets(start, end, ppb)) {
    displayBuckets.coarsenTo(ppb);
    displayBuckets.appendThroughFixed(cs.x, series, end);
    bindFlattenedBuckets(displayBuckets, 'window');
    return;
  }

  displayBuckets.rebuildByX(
    cs.x,
    series,
    start,
    end,
    range[0],
    range[1],
    cap,
    extremaForStripes(series, end, ppb),
    mask,
  );
  bindFlattenedBuckets(displayBuckets, 'window');
}

/** @param {ChartRefreshSource} [source='live'] @param {string} [reason=source] */
function requestPaint(source = 'live', reason = source) {
  if (
    pauseContext &&
    (state.isRecording || pauseContext.generation !== dataGen || pauseContext.intent !== windowIntent)
  )
    pauseContext = null;
  if (rangeDragging) source = 'interaction';
  if (paintRequest == null) {
    paintRequest = {
      batchId: ++paintBatchId,
      requestedAt: performance.now(),
      prepareMs: null,
      source,
      reason: pauseContext && reason === 'live' ? 'tail' : reason,
      pause: pauseContext,
    };
  } else if (source === 'interaction' || (source === 'maintenance' && paintRequest.source === 'live'))
    paintRequest.source = source;
  return paintRequest;
}

/** @param {any} chart @param {PaintRequest} request */
function expectChartDraw(chart, request) {
  if (!chart) return;
  chart.hooks ??= {};
  chart.hooks.draw ??= [];
  if (!chart.hooks.draw.includes(finishChartDraw)) chart.hooks.draw.push(finishChartDraw);
  const role = chart === state.navigatorChart ? 'navigator' : 'main';
  const pending = pendingDraws.get(chart);
  if (pending?.last === request) return;
  if (role === 'main') {
    recentAppendCount = Math.max(0, state.chartSeries.x.length - submittedSourceLen);
    submittedSourceLen = state.chartSeries.x.length;
  }
  const diagnostic = performanceDiagnostics.chartRequest(role, {
    requestedAt: request.requestedAt,
    submittedAt: performance.now(),
    prepareMs: request.prepareMs,
    batchId: request.batchId,
    sourcePointCount: role === 'main' ? visiblePointCount : state.chartSeries.x.length,
    displayPointCount: role === 'main' ? mainData[0].length : navData[0].length,
    pixelsPerBucket: role === 'main' ? renderPolicy.pixelsPerBucket / plotPixelRatio() : undefined,
    displayDense: role === 'main' && displayDense(),
    fillEnabled: role === 'main' && state.settings.chartFillEnabled,
    fillSuppressed: false,
    fillSuppressionReason: null,
    recentAppendCount: role === 'main' ? recentAppendCount : 0,
    refreshSource: request.source,
    reason: request.reason,
    pauseId: request.pause?.id,
    pauseRequestedAt: request.pause?.requestedAt,
    pauseLength: request.pause?.length,
    projection: chart.__chartProjection,
    refreshIntervalMs:
      role === 'main' && state.isRecording && request.source === 'live' && !rangeDragging ? liveRefreshInterval() : 0,
  });
  pendingDraws.set(chart, {
    first: pending?.first ?? request,
    last: request,
    count: (pending?.count ?? 0) + 1,
    firstDiagnostic: pending?.firstDiagnostic ?? diagnostic,
    lastDiagnostic: diagnostic,
  });
}

/**
 * uPlot 的 setData/setScale 通常在微任务中合并绘制；draw 才是实际绘制终点。
 * 这里只报告请求到 draw 的延迟（含排队 / 准备），不是 draw 执行耗时。
 * drawClear→draw 测 JS 绘制耗时；draw→下一帧另外测量，捕捉后续 Canvas 栅格化的影响。
 * @param {any} chart
 */
function finishChartDraw(chart) {
  const drawEndedAt = performance.now();
  const drawStartedAt = drawStarts.get(chart);
  const duration = drawStartedAt === undefined ? null : drawEndedAt - drawStartedAt;
  if (drawStartedAt !== undefined) {
    drawStarts.delete(chart);
    const role = chart === state.navigatorChart ? 'navigator' : 'main';
    const workMs = /** @type {number} */ (duration);
    performanceDiagnostics.domCommit(`${role}-chart-draw`, drawStartedAt, drawEndedAt);
    if (state.isRecording) {
      if (role === 'main') liveMainDrawMs = liveMainDrawMs ? liveMainDrawMs * 0.75 + workMs * 0.25 : workMs;
      else liveNavDrawMs = liveNavDrawMs ? liveNavDrawMs * 0.75 + workMs * 0.25 : workMs;
      lastLiveFlushAt = drawEndedAt;
    }
  }
  const pending = pendingDraws.get(chart);
  let entry;
  if (pending) {
    pendingDraws.delete(chart);
    const role = chart === state.navigatorChart ? 'navigator' : 'main';
    // Keep the earliest request latency, with the metadata of the submitted data.
    pending.lastDiagnostic.requestedAt = pending.firstDiagnostic.requestedAt;
    const stages = drawStages.get(chart);
    if (stages) {
      stages.coordinateBytes = [...(orderedPaints.get(chart)?.values() ?? [])].reduce(
        (sum, paint) => sum + paint.buffer.byteLength,
        0,
      );
      const rasterMem = chart === state.mainChart ? rasterizer.getMemoryBytes() : { coverageBytes: 0, rasterBytes: 0 };
      stages.coverageBytes = rasterMem.coverageBytes;
      stages.rasterBytes = rasterMem.rasterBytes;
      stages.intervalBytes = [...(orderedPaints.get(chart)?.values() ?? [])].reduce(
        (sum, paint) => sum + (paint.intervalBuffer?.byteLength ?? 0) + (paint.offsetBuffer?.byteLength ?? 0),
        0,
      );
    }
    entry = performanceDiagnostics.chartPaint(
      role,
      pending.lastDiagnostic,
      drawEndedAt,
      duration,
      drawStages.get(chart),
    );
    chart.__chartPaintTiming = {
      firstBatchId: pending.first.batchId,
      batchId: pending.last.batchId,
      coalescedRequests: pending.count,
      requestedAt: pending.first.requestedAt,
      drawEndedAt,
      requestToDrawMs: drawEndedAt - pending.first.requestedAt,
      prepareMs: pending.last.prepareMs,
    };
  }
  if (chart === state.mainChart) pauseRefinement?.start();
  if (chart !== state.mainChart || appliedMainGen !== dataGen || !monitorVisible() || chartProbeFrame !== null) return;
  const generation = dataGen;
  const epoch = feedbackEpoch;
  const density = renderPolicy.pixelsPerBucket;
  const feedbackSince = pending?.last.requestedAt ?? drawStartedAt ?? drawEndedAt;
  const live = state.isRecording && displayContext === 'recording';
  const interactive = rangeDragging;
  const dense = displayDense();
  // Canvas work may stall the second or third frame after a fast first
  // callback. Treat this bounded observation window as one paint sample, so a
  // healthy intervening frame neither hides its lag nor counts one stall twice.
  // A continuous gesture supplies another paint each frame: consume each actual
  // frame once so slow draws can adjust the budget before the gesture ends.
  // Live/static paints and the final release retain the delayed-raster probe.
  const probeFrames = dense && !interactive ? 3 : 1;
  let observedFrames = 0;
  let previousFrameAt = drawEndedAt;
  let nextFrameDelayMs = 0;
  let frameDelayMs = 0;
  let drawFrameDelayMs = 0;
  const observeFrame = () => {
    chartProbeFrame = null;
    if (epoch !== feedbackEpoch || generation !== dataGen || chart !== state.mainChart) return;
    const visible = monitorVisible();
    const at = performance.now();
    if (
      !visible ||
      live !== (state.isRecording && displayContext === 'recording') ||
      dense !== currentWindowDense() ||
      density !== renderPolicy.pixelsPerBucket
    ) {
      cancelFrameProbe();
      return;
    }
    const delayMs = Math.max(0, at - previousFrameAt);
    if (observedFrames === 0) nextFrameDelayMs = delayMs;
    frameDelayMs = Math.max(
      frameDelayMs,
      delayMs,
      performanceDiagnostics.frameDelaySince(
        observedFrames === 0 ? feedbackSince : previousFrameAt,
        observedFrames === 0,
      ),
    );
    // Preparation/import work before draw cannot establish an expensive fill.
    drawFrameDelayMs = Math.max(
      drawFrameDelayMs,
      delayMs,
      duration ?? 0,
      performanceDiagnostics.frameDelaySince(drawEndedAt, true, true),
    );
    previousFrameAt = at;
    observedFrames++;
    performanceDiagnostics.chartNextFrame(entry, nextFrameDelayMs, frameDelayMs);
    if (observedFrames < probeFrames && frameDelayMs <= 100) {
      chartProbeFrame = requestAnimationFrame(observeFrame);
      return;
    }
    const densityChanged = renderPolicy.observe({
      // Cold preparation before draw cannot establish a coarse display budget.
      delayMs: drawFrameDelayMs,
      at,
      idleFrameMs: performanceDiagnostics.idleFrameIntervalMs(),
      visible,
      dense,
      interactive,
      maxGapMs: Math.max(250, (state.settings.sampleRate || 0) * 2 + 250),
    });
    if (densityChanged) {
      feedbackRepaintPending = true;
      scheduleChartUpdate('maintenance');
    } else if (rangeDragging && chartDirty) scheduleChartUpdate('interaction');
  };
  chartProbeFrame = requestAnimationFrame(observeFrame);
}

function cancelFrameProbe() {
  if (chartProbeFrame !== null) cancelAnimationFrame(chartProbeFrame);
  chartProbeFrame = null;
  feedbackRepaintPending = false;
  feedbackEpoch++;
  renderPolicy.breakFeedback();
}

/** Display budgets from live recording never become the initial review budget. @param {'recording'|'review'} context */
function selectDisplayContext(context) {
  if (context === displayContext) return;
  cancelFrameProbe();
  displayContext = context;
  renderPolicy = context === 'recording' ? recordingRenderPolicy : reviewRenderPolicy;
}

/** 同步准备耗时仅作诊断，不据此猜测 GPU / Canvas 耗时或固定降帧。
 * @param {number} t0 @param {PaintRequest} request
 */
function finishPreparation(t0, request) {
  request.prepareMs = (request.prepareMs ?? 0) + performance.now() - t0;
  for (const chart of [state.mainChart, state.navigatorChart]) {
    const pending = chart && pendingDraws.get(chart);
    if (pending?.last === request) pending.lastDiagnostic.prepareMs = request.prepareMs;
    if (pending?.first === request) pending.firstDiagnostic.prepareMs = request.prepareMs;
  }
}

/** Account for background CPU work on its requesting paint, without timing samples individually.
 * @param {PaintRequest} request @param {()=>boolean} step */
function measurePreparation(request, step) {
  const started = performance.now();
  try {
    return step();
  } finally {
    request.prepareMs = (request.prepareMs ?? 0) + performance.now() - started;
  }
}

/**
 * 将当前数据应用到两个图表（范围由各 scale 的 range 函数自动计算）。
 * @param {{ force?: boolean }} [opts]
 */
function applyData(opts = {}) {
  if (!monitorVisible()) {
    cancelPreparation();
    chartDirty = true;
    return;
  }

  if (sourceRevision !== chartRevision()) syncChartSeries();
  if (!state.isRecording) cancelIndexWarmup();
  const request = requestPaint();
  paintRequest = null;
  const t0 = performance.now();
  chartDirty = false;
  if (feedbackRecording !== state.isRecording) {
    cancelFrameProbe();
    feedbackRecording = state.isRecording;
    selectDisplayContext(state.isRecording && !rangeDragging ? 'recording' : 'review');
  }
  if (!state.isRecording || rangeDragging || request.source === 'interaction' || state.chartWindow.mode === 'frozen')
    selectDisplayContext('review');
  else if (request.source === 'live') selectDisplayContext('recording');
  if (preparationTarget && preparationInvalid(preparationTarget)) cancelPreparation();
  const target = preparationTarget;
  const srcLen = target?.length ?? state.chartSeries.x.length;
  const { start, end } = target ?? sourceRange();
  const windowCount = end - start;
  visiblePointCount = windowCount;
  visiblePlotWidth = plotCssWidth();
  const cap = target?.cap ?? mainBucketCap(windowCount);
  const ppb = mainProjectionPpb(windowCount, cap);
  const nextXRange = target?.xRange ?? xRange();
  const mask = target?.mask ?? visibleChannelMask();
  const reuseProjection =
    useRawWindow(start, end) ||
    stripesMatch(start, end, windowCount, cap, nextXRange, mask) ||
    canAdvanceBuckets(start, end, ppb);
  const coarsePreview = usePausePreview(start, end, cap);
  if (
    !coarsePreview &&
    (prepareLargeHistory(srcLen, end, ppb, reuseProjection, request) ||
      prepareLargeProjection(start, end, cap, request))
  ) {
    chartDirty = true;
    // Keep the original request timestamp across slices so draw latency includes
    // deferred preparation instead of starting over when its result is ready.
    paintRequest = request;
    finishPreparation(t0, request);
    return;
  }
  const appended = srcLen > scannedLen;
  const yChanged = trackNewPoints(srcLen);
  const force = !!opts.force;
  const dataChanged = appended || appliedMainGen !== dataGen;
  // The overview is static during a gesture; only the main viewport moves.
  const preview = rangeDragging && !force;

  const sameXRange = appliedXRange?.[0] === nextXRange[0] && appliedXRange?.[1] === nextXRange[1];
  const covers = coarsePreview || bindingCovers(start, end, windowCount, cap, nextXRange, mask);
  const frozenAppend = appended && state.chartWindow.mode === 'frozen' && sameXRange && covers && !yChanged;
  const reuseBinding = !force && appliedMainGen === dataGen && covers && (!dataChanged || frozenAppend);
  const widthsChanged = syncChartLineWidths();

  if (reuseBinding) {
    if (!sameXRange) {
      expectChartDraw(state.mainChart, request);
      applyXScale(nextXRange);
    } else if (
      widthsChanged ||
      !!request.pause ||
      (!rangeDragging && boundKind === 'window' && rasterizer.isScaledDown())
    ) {
      // Refresh the stroke, commit a pause draw, or restore full raster resolution without rebinding data.
      expectChartDraw(state.mainChart, request);
      if (typeof state.mainChart?.redraw === 'function') state.mainChart.redraw(widthsChanged, false);
      else state.mainChart?.setData(/** @type {any} */ (mainData), false);
    }
  } else {
    if (!coarsePreview) bindDisplayData({ cap, start, end, windowCount, force, range: nextXRange, mask });
    if (state.mainChart) {
      state.mainChart.__chartProjection = {
        quality: coarsePreview ? 'coarse' : 'fine',
        start,
        end,
        ppb: boundKind === 'window' ? displayBuckets.ppb : 1,
        candidates: boundKind === 'window' ? mainGeometry.map((g) => g.x.length) : [],
      };
      expectChartDraw(state.mainChart, request);
      // Y 量程来自全量 seriesMax，与是否分桶无关；极值未破时跳过四轴量化。
      const mainStartedAt = performance.now();
      if (appended && !yChanged && xWindow.min != null && xWindow.max != null && !force) {
        state.mainChart.setData(/** @type {any} */ (mainData), false);
        applyXScale(nextXRange);
      } else {
        state.mainChart.setData(/** @type {any} */ (mainData));
        const liveRange = xRange();
        if (target && (liveRange[0] !== nextXRange[0] || liveRange[1] !== nextXRange[1])) applyXScale(nextXRange);
      }
      performanceDiagnostics.domCommit('main-chart-submit', mainStartedAt);
    }
  }
  appliedXRange = nextXRange;

  if (!preview && (dataChanged || appliedNavGen !== dataGen || appliedNavLen !== srcLen)) {
    syncNavBuckets(srcLen);
    const nav = state.navigatorChart;
    const now = performance.now();
    const live = state.isRecording && !force && request.reason !== 'release';
    const delay = live ? lastNavPaint + NAV_PAINT_MIN_MS - now : 0;
    if (nav && (appliedNavGen !== dataGen || appliedNavLen !== srcLen)) {
      const generation = dataGen;
      const submit = () => {
        if (!monitorVisible() || generation !== dataGen) return;
        const length = state.chartSeries.x.length;
        if (appliedNavGen === dataGen && appliedNavLen === length) return;
        bindNavData();
        expectChartDraw(nav, request);
        const navStartedAt = performance.now();
        nav.setData(/** @type {any} */ (navData));
        performanceDiagnostics.domCommit('navigator-chart-submit', navStartedAt);
        appliedNavGen = dataGen;
        appliedNavLen = length;
        lastNavPaint = performance.now();
      };
      if (delay > 0) {
        if (navPaceTimer === null)
          navPaceTimer = setTimeout(() => {
            navPaceTimer = null;
            if (!rangeDragging) scheduleChartUpdate();
          }, Math.ceil(delay));
      } else {
        cancelNavigatorPaint();
        if (request.pause) displayFrames.schedule('chart-navigator', submit, 20);
        else submit();
      }
    }
  }

  appliedMainGen = dataGen;
  finishPreparation(t0, request);
  if (target) {
    preparationTarget = null;
    const latest = sourceRange();
    if (latest.start !== start || latest.end !== end || state.chartSeries.x.length !== srcLen) scheduleChartUpdate();
  }
}

/** 立即刷新两个图表；隐藏时只打脏标记，不提交绘制。 */
/** @param {ChartRefreshSource} [source='maintenance'] @param {{force?:boolean,reason?:string,requestedAt?:number}} [options] */
export function updateCharts(source = 'maintenance', { force = true, reason = source, requestedAt } = {}) {
  if (reason === 'release') interactions.stopWheelZoom();
  chartDirty = true;
  cancelChartFrame();
  if (reason === 'pause') {
    cancelIndexWarmup();
    // A recording preparation can target an older prefix. Keep completed index
    // blocks, but let this request capture its own complete window.
    cancelPreparation();
    paintRequest = null;
    pauseContext = {
      id: ++pauseId,
      requestedAt: requestedAt ?? performance.now(),
      length: state.chartSeries.x.length,
      generation: dataGen,
      intent: windowIntent,
    };
  }
  requestPaint(source, reason);
  flushChart(force);
}

/**
 * 显示设置（纵向余量等）变化后刷新两图量程。
 * dataGen++ 迫使 applyData 对导航图重发 setData：它的 gen/length 快路径
 * 否则会跳过重建，把旧余量留在缩略图上。
 */
export function refreshChartScales() {
  dataGen++;
  chartDirty = true;
  cancelChartFrame();
  flushChart();
}

/** 恢复可见性时把尺寸补偿、积累的数据和已有请求合到同一帧。 */
export function handleMonitorShown() {
  cancelFrameProbe();
  resizeDirty = true;
  scheduleChartUpdate();
}

export function handleMonitorHidden() {
  interactions.stopWheelZoom();
  interactions.stopChartPan();
  pauseContext = null;
  cancelNavigatorPaint();
  cancelIndexWarmup();
  chartDirty = true;
  paintRequest = null;
  cancelPreparation();
  cancelChartFrame();
  cancelFrameProbe();
}

function cancelChartFrame() {
  displayFrames.cancel('chart');
  if (chartPaceTimer !== null) {
    clearTimeout(chartPaceTimer);
    chartPaceTimer = null;
  }
  chartFramePending = false;
  state.__chartUpdatePending = false;
}

function registerChartListeners() {
  if (chartListenersRegistered) return;
  chartListenersRegistered = true;
  onThemeChange(applyChartTheme);
  const visibilityChanged = () => {
    if (monitorVisible()) handleMonitorShown();
    else handleMonitorHidden();
  };
  document.addEventListener('visibilitychange', visibilityChanged);
  document.addEventListener('witrn:window-visibility', visibilityChanged);
}

/** @param {boolean} [force=false] */
function flushChart(force = false) {
  if (!monitorVisible()) {
    cancelPreparation();
    chartDirty = true;
    paintRequest = null;
    return;
  }
  const startedAt = performance.now();
  flushingChart = true;
  try {
    flushResizes();
    if (chartAxes.consumeDivisionSyncPending()) {
      dataGen++;
      chartDirty = true;
    }
    const feedbackRepaint = feedbackRepaintPending;
    feedbackRepaintPending = false;
    if (chartDirty || force || forceResizePaint || feedbackRepaint)
      applyData({ force: force || forceResizePaint || feedbackRepaint });
    forceResizePaint = false;
  } finally {
    const endedAt = performance.now();
    performanceDiagnostics.domCommit('chart-flush', startedAt, endedAt);
    if (state.isRecording) {
      const workMs = endedAt - startedAt;
      liveChartPrepareMs = liveChartPrepareMs ? liveChartPrepareMs * 0.75 + workMs * 0.25 : workMs;
      lastLiveFlushAt = endedAt;
    } else {
      liveChartPrepareMs = 0;
      liveMainDrawMs = 0;
      liveNavDrawMs = 0;
    }
    flushingChart = false;
    scheduleIndexWarmup();
    if (!chartDirty) paintRequest = null;
    else if (!historyWork && !projectionWork) scheduleChartUpdate();
  }
}

/** 使用 requestAnimationFrame 合帧；后台数据照收，图表只记 dirty。 */
/** @param {ChartRefreshSource} [source='live'] */
export function scheduleChartUpdate(source = 'live') {
  chartDirty = true;
  if (!monitorVisible()) {
    cancelPreparation();
    return;
  }
  if (flushingChart) return;
  requestPaint(source);
  if (chartFramePending) return;
  if (state.isRecording && paintRequest?.source === 'live' && !rangeDragging && !resizeDirty) {
    const delay = lastLiveFlushAt + liveRefreshInterval() - performance.now();
    if (delay > 1) {
      if (chartPaceTimer === null)
        chartPaceTimer = setTimeout(() => {
          chartPaceTimer = null;
          scheduleChartUpdate(source);
        }, delay);
      return;
    }
  }
  if (chartPaceTimer !== null) {
    clearTimeout(chartPaceTimer);
    chartPaceTimer = null;
  }
  chartFramePending = true;
  state.__chartUpdatePending = true;
  displayFrames.schedule(
    'chart',
    () => {
      chartFramePending = false;
      state.__chartUpdatePending = false;
      flushChart();
    },
    10,
  );
}

// ─── Range / visibility / fill ───────────────────────────────────────────────

/**
 * 设置主图 X 轴可见窗口（由范围滑块驱动）。调用后需触发一次刷新才会生效。
 * 传入 null 可清除窗口（恢复为跟随数据范围 / 默认范围）。
 * @param {number|null} min
 * @param {number|null} max
 */
export function setChartXWindow(min, max) {
  let pausedAdvance = false;
  // Natural full/follow appends retain evidence. User window changes retire it
  // in recording and review alike.
  if (xWindow.min !== min || xWindow.max !== max) {
    const latest = state.chartSeries.x.at(-1);
    const fullAdvance = state.chartWindow.mode === 'full' && xWindow.min === min;
    const followAdvance =
      state.chartWindow.mode === 'follow' &&
      min !== null &&
      max !== null &&
      xWindow.min !== null &&
      xWindow.max !== null &&
      Math.abs(max - min - (xWindow.max - xWindow.min)) < 1e-6;
    const automaticAdvance =
      (state.isRecording ||
        (pauseContext && latest !== undefined && state.chartSeries.x.length - pauseContext.length <= 4096)) &&
      max === latest &&
      (xWindow.max === null || max >= xWindow.max) &&
      (fullAdvance || followAdvance);
    if (!automaticAdvance) {
      windowIntent++;
      // A gesture may move every frame. Its paints must still finish their
      // raster observations; unrelated windows continue to retire old evidence.
      if (!rangeDragging) cancelFrameProbe();
    }
    pausedAdvance = !!automaticAdvance && !state.isRecording;
  }
  xWindow.min = min;
  xWindow.max = max;
  // A refinement can consume a pending chart job before the tail range UI runs.
  // Advancing that paused window must enqueue the matching final tail paint.
  if (pausedAdvance) scheduleChartUpdate('maintenance');
}

/**
 * 显示 / 隐藏指定曲线。对应的 Y 轴会自动跟随显隐（scale 无可见序列时返回空量程）。
 * @param {number} datasetIndex - 0=电压 1=电流 2=功率 3=温度 4=D+ 5=D- 6=CC1 7=CC2
 * @param {boolean} show
 */
export function setSeriesVisible(datasetIndex, show) {
  const chart = state.mainChart;
  const si = datasetIndex + 1;
  if (!chart || !chart.series[si] || chart.series[si].show === !!show) return;
  cancelFrameProbe();
  // Flush visibility before a first data submission can inherit its empty scale.
  chart.batch(() => chart.setSeries(si, { show: !!show }));
  renderLegend();
  if (show && boundKind === 'window' && !(displayBuckets.channelMask & (1 << datasetIndex))) {
    updateCharts('maintenance', { force: false });
  }
}

/** Toggle all monitor fills without changing channel opacity. @param {boolean} enabled */
export function setChartFillEnabled(enabled) {
  state.settings.chartFillEnabled = !!enabled;
  cancelFrameProbe();
  // Rebuild paths as well as colours: bucket rasters may have merged unfilled channels.
  state.mainChart?.redraw(true);
}

/**
 * 设置指定曲线的填充不透明度。
 * @param {number} datasetIndex - 0=电压 1=电流 2=功率 3=温度
 * @param {number} opacityPercent - 0-100，0 表示关闭填充
 */
export function setSeriesFill(datasetIndex, opacityPercent) {
  const field = FIELDS[datasetIndex];
  if (!field) return;
  cancelFrameProbe();
  fillStyles[datasetIndex + 1] =
    opacityPercent > 0 ? hexToRgba(/** @type {any} */ (chartTheme)[field], opacityPercent) : null;
  if (state.mainChart) state.mainChart.redraw();
}

/**
 * 主题令牌变化后重新应用图表配色。
 * 曲线 / 轴 / 网格的 stroke 均为读取 chartTheme 的闭包，redraw 即可拾取新值；
 * 只有填充色是预计算的 rgba 字符串，需要按当前设置重算。
 */
export function applyChartTheme() {
  const s = state.settings;
  fillStyles = [
    null,
    s.opacityVoltage > 0 ? hexToRgba(chartTheme.voltage, s.opacityVoltage) : null,
    s.opacityCurrent > 0 ? hexToRgba(chartTheme.current, s.opacityCurrent) : null,
    s.opacityPower > 0 ? hexToRgba(chartTheme.power, s.opacityPower) : null,
    s.opacityTemp > 0 ? hexToRgba(chartTheme.temp, s.opacityTemp) : null,
    null,
    null,
    null,
    null,
  ];
  state.mainChart?.redraw();
  state.navigatorChart?.redraw();
  renderLegend();
}

/** Redraw a color-only edit while reusing cached series paths. @param {number} datasetIndex */
export function applyChartChannelColor(datasetIndex) {
  const field = FIELDS[datasetIndex];
  if (!field) return;
  const opacity = [
    state.settings.opacityVoltage,
    state.settings.opacityCurrent,
    state.settings.opacityPower,
    state.settings.opacityTemp,
  ][datasetIndex];
  fillStyles[datasetIndex + 1] = opacity > 0 ? hexToRgba(/** @type {any} */ (chartTheme)[field], opacity) : null;
  state.mainChart?.redraw(false, false);
  if (datasetIndex === 2) state.navigatorChart?.redraw(false, false);
  renderLegend();
}

function syncChartLineWidths() {
  const allSeries = state.mainChart?.series;
  if (!allSeries) return false;
  const { chartAutoLineWidth, chartLineWidths } = state.settings;
  const factor = chartAutoLineWidth ? zoomStrokeFactor(visiblePointCount, visiblePlotWidth) : 1;
  let changed = false;
  for (let index = 0; index < FIELDS.length; index++) {
    const series = allSeries[index + 1];
    const base = index < 4 ? chartLineWidths[FIELDS[index]] : 1;
    const width = Math.max(0.5, base * factor);
    if (series && series.width !== width) {
      series.width = width;
      changed = true;
    }
  }
  return changed;
}

/** Apply display preferences without recalculating scales or axes. */
export function refreshChartLineWidths() {
  if (syncChartLineWidths()) state.mainChart?.redraw(true, false);
}

// ─── Scale ranges ────────────────────────────────────────────────────────────

/**
 * 主图 X 轴范围：优先使用滑块窗口，否则与数据齐平（不加人为留白）；无数据时给一个默认时间窗。
 * 数据范围直接读模块内的序列数组（uPlot 传入的 dataMin/dataMax 在退化情况下会被其内部逻辑预填充，不可靠）。
 * @returns {[number, number]}
 */
function xRange() {
  let min;
  let max;
  if (xWindow.min != null && xWindow.max != null) {
    min = xWindow.min;
    max = xWindow.max;
  } else {
    const xs = state.chartSeries.x;
    if (!xs.length) return [0, 60];
    min = Number(xs.at(0));
    max = Number(xs.at(-1));
  }
  // 单点 / 零跨度保护（uPlot 不接受 min == max）
  if (!(max - min > 0)) return [min - 0.3, min + 0.3];
  return [min, max];
}

// ─── Legend ──────────────────────────────────────────────────────────────────

/** 渲染顶部图例（仅列出当前可见的曲线，与旧版 generateLabels 过滤逻辑一致）。 */
function renderLegend() {
  const el = document.getElementById('main-chart-legend');
  const chart = state.mainChart;
  if (!el || !chart) return;

  const fragment = document.createDocumentFragment();
  for (let si = 1; si < chart.series.length; si++) {
    if (!chart.series[si].show) continue;
    const item = document.createElement('span');
    item.className = 'chart-legend-item';
    const dot = document.createElement('span');
    dot.className = 'chart-legend-dot';
    dot.style.background = /** @type {any} */ (chartTheme)[FIELDS[si - 1]];
    item.appendChild(dot);
    item.appendChild(document.createTextNode(chartLabel(si - 1)));
    fragment.appendChild(item);
  }
  el.replaceChildren(fragment);
}

/** @param {any} chart */
function applyChartAxisFonts(chart) {
  const axes = chart?.axes ?? [];
  for (let i = 0; i < axes.length; i++) {
    // uPlot normalises fonts to [scaled CSS font, scaled size, original size].
    // Preserve its DPI bookkeeping when replacing the family of an existing axis.
    if (Array.isArray(axes[i].font)) axes[i].font[0] = `${axes[i].font[1]}px ${MONO_FONT}`;
    else axes[i].font = `12px ${MONO_FONT}`;
    if (i > 0) {
      if (Array.isArray(axes[i].labelFont)) axes[i].labelFont[0] = `${axes[i].labelFont[1]}px ${CHART_FONT}`;
      else axes[i].labelFont = `12px ${CHART_FONT}`;
    }
  }
}

/** 字体偏好变更后刷新图表坐标轴字体及重绘。 */
export function refreshChartFonts() {
  syncChartFonts();
  const chart = state.mainChart;
  if (!chart) return;
  applyChartAxisFonts(chart);
  chart.redraw?.(true, true);
  state.navigatorChart?.redraw?.();
  if (typeof document !== 'undefined' && document.fonts?.load) {
    Promise.all([document.fonts.load(`12px ${CHART_FONT}`), document.fonts.load(`12px ${MONO_FONT}`)])
      .then(() => {
        state.mainChart?.redraw?.(true, true);
        state.navigatorChart?.redraw?.();
      })
      .catch(() => {});
  }
}

/** 切换系统时间 / 相对时间显示后刷新主图 X 轴刻度。 */
export function refreshChartTimeAxis() {
  state.mainChart?.redraw?.(false, true);
}

/** Refresh chart labels after a language change without replacing chart data or state. */
export function refreshChartLanguage() {
  syncChartFonts();
  const chart = state.mainChart;
  if (!chart) return;
  for (let i = 0; i < FIELDS.length; i++) {
    if (chart.series[i + 1]) chart.series[i + 1].label = chartLabel(i);
  }
  applyChartAxisFonts(chart);
  const axes = chart.axes ?? [];
  const titles = [
    chartAxisTitle('voltage', 'V'),
    chartAxisTitle('current', 'A'),
    chartAxisTitle('power', 'W'),
    chartAxisTitle('temperature', '°C'),
  ];
  for (let i = 0; i < titles.length; i++) {
    if (axes[i + 1]) axes[i + 1].axisTitle = titles[i];
  }
  renderLegend();
  chart.redraw?.(true, true);
}

// ─── Sizing ──────────────────────────────────────────────────────────────────

let resizeDirty = false;
let forceResizePaint = false;
/** @type {Map<any, { host: HTMLElement, onSize: (() => void)|null }>} */
const resizeTargets = new Map();

function flushResizes() {
  if (!resizeDirty || state.__layoutResizing) return;
  resizeDirty = false;
  // 先集中读取，再写 setSize，避免两张图交替读写布局。
  const sizes = [];
  for (const [chart, { host, onSize }] of resizeTargets) {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width > 0 && height > 0 && (chart.width !== width || chart.height !== height)) {
      sizes.push({ chart, width, height, onSize });
    }
  }
  for (const { chart, width, height, onSize } of sizes) {
    expectChartDraw(chart, requestPaint());
    chart.setSize({ width, height });
    onSize?.();
    forceResizePaint = true;
  }
}

/**
 * ResizeObserver 只标脏，尺寸与流式刷新在同一 rAF 提交。
 * @param {HTMLElement} host
 * @param {any} chart
 * @param {(() => void)|null} [onSize]
 */
function observeResize(host, chart, onSize = null) {
  if (resizeTargets.has(chart)) return;
  resizeTargets.set(chart, { host, onSize });
  chart.hooks.draw ??= [];
  chart.hooks.drawClear ??= [];
  chart.hooks.drawClear.push(() => {
    drawStarts.set(chart, performance.now());
    drawStages.set(chart, {});
  });
  if (!chart.hooks.draw.includes(finishChartDraw)) chart.hooks.draw.push(finishChartDraw);
  const ro = new ResizeObserver(() => {
    resizeDirty = true;
    chartDirty = true;
    if (!state.__layoutResizing) scheduleChartUpdate();
  });
  ro.observe(host);
  chart.hooks.destroy ??= [];
  chart.hooks.destroy.push(() => {
    ro.disconnect();
    resizeTargets.delete(chart);
    pendingDraws.delete(chart);
    drawStarts.delete(chart);
  });
}

// ─── Chart initialization ────────────────────────────────────────────────────

/** 初始化主图表。 */
export function initChart() {
  const host = document.getElementById('main-chart');
  if (!host) return;

  syncChartFonts();
  syncChartSeries();

  linearBuilder = uPlot.paths?.linear ? uPlot.paths.linear() : null;
  const hasPaths = linearBuilder != null;

  const s = state.settings;
  fillStyles = [
    null,
    s.opacityVoltage > 0 ? hexToRgba(chartTheme.voltage, s.opacityVoltage) : null,
    s.opacityCurrent > 0 ? hexToRgba(chartTheme.current, s.opacityCurrent) : null,
    s.opacityPower > 0 ? hexToRgba(chartTheme.power, s.opacityPower) : null,
    s.opacityTemp > 0 ? hexToRgba(chartTheme.temp, s.opacityTemp) : null,
    null,
    null,
    null,
    null,
  ];

  const showInitial = [
    s.showVoltage,
    s.showCurrent,
    s.showPower,
    s.showTemp,
    s.showDpDn,
    s.showDpDn,
    s.showCc,
    s.showCc,
  ];

  const opts = {
    width: host.clientWidth || 600,
    height: host.clientHeight || 300,
    ms: 1,
    pxAlign: 1,
    legend: { show: false },
    // 顶边留给横向轴标题；左右/底仍走 uPlot 按轴自动垫
    padding: /** @type {any} */ ([Y_AXIS_LABEL_PAD, null, null, null]),
    cursor: {
      y: false,
      drag: { setScale: false, x: false, y: false },
      points: { size: 8, bbox: cursorTooltip.cursorPointBox },
      dataIdx: cursorTooltip.cursorDataIdx,
    },
    scales: {
      x: { time: false, range: /** @type {any} */ (xRange) },
      voltage: { range: chartAxes.mkYRange('voltage', VOLTAGE_SCALE_SERIES) },
      current: { range: chartAxes.mkYRange('current', [2]) },
      power: { range: chartAxes.mkYRange('power', [3]) },
      temp: { range: chartAxes.mkYRange('temp', [4], true) },
    },
    series: [
      {},
      ...FIELDS.map((field, i) => ({
        label: chartLabel(i),
        scale: SERIES_SCALES[i],
        auto: false,
        stroke: () => /** @type {any} */ (chartTheme)[field],
        // D+/D-/CC 叠加曲线更细，避免与主通道曲线抢焦点
        width: i >= 4 ? 1 : (s.chartLineWidths[field] ?? 1.5),
        points: { show: false },
        ...(hasPaths ? { paths: adaptivePaths } : {}),
        // Every render path uses the same user-controlled shading switch.
        fill: () => (state.settings.chartFillEnabled ? fillStyles[i + 1] : null),
        show: showInitial[i],
      })),
    ],
    axes: [
      {
        scale: 'x',
        stroke: () => chartTheme.axisText,
        font: `12px ${MONO_FONT}`,
        size: 34,
        gap: 4,
        space: chartAxes.xAxisSpace,
        incrs: chartAxes.xAxisIncrs,
        splits: chartAxes.xAxisSplits,
        // 刻度与网格沿用 uPlot 计算，文字由 drawXAxisLabels 做夹紧防裁边与起止优先排版。
        values: (/** @type {any} */ _u, /** @type {number[]} */ splits) => splits.map(() => null),
        grid: { show: true, stroke: () => chartTheme.grid, width: 1 },
        ticks: { show: true, stroke: () => chartTheme.grid, width: 1, size: 8 },
      },
      chartAxes.mkYAxis('voltage', chartAxisTitle('voltage', 'V'), () => chartTheme.voltage, 3),
      chartAxes.mkYAxis('current', chartAxisTitle('current', 'A'), () => chartTheme.current, 3),
      chartAxes.mkYAxis('power', chartAxisTitle('power', 'W'), () => chartTheme.power, 1),
      chartAxes.mkYAxis('temp', chartAxisTitle('temperature', '°C'), () => chartTheme.tempAxis, 1),
    ],
    hooks: {
      drawAxes: [chartAxes.drawYAxisChrome, chartAxes.drawYAxisLabels, chartAxes.drawXAxisLabels],
      drawSeries: [rasterizer.drawBucketFill, rasterizer.drawBucketRaster],
      draw: [(/** @type {any} */ u) => drawMarkers(u, CHART_FONT)],
      setSize: [chartAxes.syncDivisionsAfterResize],
    },
    plugins: [cursorTooltip.tooltipPlugin()],
  };

  state.mainChart = new uPlot(opts, /** @type {any} */ (mainData), host);
  interactions.bindChartWheel(state.mainChart.over, document.getElementById('timeline-track'));
  interactions.bindChartPan(state.mainChart.over);
  observeResize(host, state.mainChart, () => {
    cancelFrameProbe();
  });
  renderLegend();
  registerChartListeners();

  initNavigatorChart();
  // 标记不改数据也不改量程，只需重绘两张图。
  onMarkersChange(() => {
    state.mainChart?.redraw();
    state.navigatorChart?.redraw();
  });

  // Canvas 不解析 CSS var()；与令牌对齐后再 load 一次，避免首帧用了回退栈。系统字体通常立刻 resolve。
  if (document.fonts?.load) {
    Promise.all([document.fonts.load(`12px ${CHART_FONT}`), document.fonts.load(`12px ${MONO_FONT}`)])
      .then(() => {
        state.mainChart?.redraw();
        state.navigatorChart?.redraw();
      })
      .catch(() => {});
  }
}

/** 初始化导航器图表（功率全量缩略图，无轴无交互）。 */
function initNavigatorChart() {
  const host = document.getElementById('navigator-chart');
  if (!host) return;

  const opts = {
    width: host.clientWidth || 600,
    height: host.clientHeight || 46,
    ms: 1,
    pxAlign: 1,
    padding: /** @type {[number, number, number, number]} */ ([2, 0, 2, 0]),
    legend: { show: false },
    cursor: { show: false },
    scales: {
      x: {
        time: false,
        // 与数据齐平，不加人为留白；直接读序列数组（uPlot 传参在退化情况下不可靠）
        range: /** @type {any} */ (
          () => {
            const xs = navData[0];
            if (!xs.length) return [0, 60];
            const min = xs[0];
            const max = xs[xs.length - 1];
            if (!(max - min > 0)) return [min - 0.3, max + 0.3];
            return [min, max];
          }
        ),
      },
      y: {
        range: /** @type {any} */ (
          () => {
            const max = seriesMax[3];
            // Fit even micro-watt spikes in the overview. Its vertical scale
            // represents the full recording, independently of the main axes.
            const ceiling = max > 0 && Number.isFinite(max) ? max * (1 + headroomFrac()) : 1;
            const rows = Math.max(12, (host.clientHeight || 46) - 4);
            const inset = (3 * ceiling) / (rows - 6);
            return [-inset, ceiling + inset];
          }
        ),
      },
    },
    series: [
      {},
      {
        scale: 'y',
        auto: false,
        stroke: () => chartTheme.power,
        width: 1.25,
        points: { show: false },
        ...(linearBuilder != null ? { paths: adaptivePaths } : {}),
      },
    ],
    axes: [{ show: false }, { show: false }],
    hooks: {
      draw: [drawNavigatorMarkers],
    },
  };

  state.navigatorChart = new uPlot(opts, /** @type {any} */ (navData), host);
  observeResize(host, state.navigatorChart, () => {
    appliedNavGen = -1;
  });
}
