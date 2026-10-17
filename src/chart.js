// @ts-check
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
 */

import {
  bucketCap,
  firstIndexAfter,
  firstIndexAtOrAfter,
  nearestIndex,
  SeriesBuckets,
  stripePpb,
} from './chart-buckets.js';
import { BLOCK_SIZE, ExactExtremaIndex } from './chart-extrema.js';
import { rasterOrderedFill } from './chart-fill.js';
import { ChartFillPolicy, ChartRenderPolicy, liveChartIntervalMs } from './chart-pacing.js';
import { wheelZoomFactor } from './chart-window.js';
import { runCooperativeSlices } from './cooperative.js';
import { displayFrames } from './frame-scheduler.js';
import { getResolvedLanguage, t } from './i18n.js';
import { markersOf, onMarkersChange } from './markers.js';
import { performanceDiagnostics } from './performance-diagnostics.js';
import { state } from './state.js';
import { chartTheme, onThemeChange } from './theme.js';
import { formatRelativeHMS, hexToRgba } from './utils.js';

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
  if (typeof document === 'undefined') return;
  const styles = getComputedStyle(document.documentElement);
  const uiFont = styles.getPropertyValue('--font-ui').trim();
  const monoFont = styles.getPropertyValue('--font-mono').trim();
  if (uiFont) CHART_FONT = uiFont;
  if (monoFont) MONO_FONT = monoFont;
}

/** X 轴刻度步长候选（秒）— 时间友好的取值（覆盖 0.1 秒到月级跨度）。 */
const TIME_INCRS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800,
  259200, 432000, 604800, 1209600, 2592000, 5184000, 8640000,
];

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
const recordingRenderPolicy = new ChartRenderPolicy();
// Review keeps screen-resolution detail, including throughout a gesture. Canvas
// pressure can suppress fill, but must not leave a static curve at 8–16 px/bucket.
const reviewRenderPolicy = new ChartRenderPolicy({ initialDensity: 1, maxDensity: 1 });
const recordingFillPolicy = new ChartFillPolicy();
const reviewFillPolicy = new ChartFillPolicy();
let renderPolicy = reviewRenderPolicy;
let fillPolicy = reviewFillPolicy;
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
/** @typedef {{generation:number,intent:number,revision:number,length:number,start:number,end:number,cap:number,ppb:number,xRange:[number,number],width:number,resolution:number,density:number}} PreparationTarget */
/** @type {PreparationTarget|null} */
let preparationTarget = null;

function chartRevision() {
  const cs = state.chartSeries;
  return cs.x.revision + FIELDS.reduce((sum, key) => sum + cs[key].revision, 0);
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
    target.density !== renderPolicy.pixelsPerBucket
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
let fillPaintDirty = false;
let feedbackRecording = false;
const FILL_POINTS_PER_PIXEL = 4;
/** @type {number|null} */
let chartProbeFrame = null;
// Static feedback can force a confirmation draw; fill transitions must also redraw.
let feedbackRepaintPending = false;
let filledPaintConfirmed = false;
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
const navBuckets = new SeriesBuckets();
let navSrcLen = 0;
/** @type {import('./chart-buckets.js').OrderedGeometry|null} */
let navGeometry = null;
let lastNavPaint = 0;
const NAV_PAINT_MIN_MS = 100;
function navMaxBuckets() {
  return bucketCap((document.getElementById('navigator-chart')?.clientWidth || 600) / 2);
}
function resetNavBuckets() {
  navBuckets.reset();
  navSrcLen = 0;
  navGeometry = null;
}
/** 把新样本折进导航桶；不 flatten、不 setData。 */
function syncNavBuckets(through = state.chartSeries.x.length) {
  const cs = state.chartSeries;
  const n = Math.min(through, cs.x.length);
  const cap = navMaxBuckets();
  const xs = cs.x;
  const ps = cs.power;
  if (n <= cap) {
    if (navSrcLen > n) resetNavBuckets();
    return;
  }
  if (navSrcLen > n || navSrcLen === 0) {
    resetNavBuckets();
    foldNavRange(xs, ps, 0, n, cap);
  } else if (navSrcLen < n) {
    foldNavRange(xs, ps, navSrcLen, n, cap);
  }
}

/** @param {import('./state.js').F64Col} xs @param {import('./state.js').F64Col} ps @param {number} _start @param {number} end @param {number} cap */
function foldNavRange(xs, ps, _start, end, cap) {
  navBuckets.cap = cap;
  navBuckets.appendThrough(xs, [ps], end);
  navSrcLen = navBuckets.srcEnd;
}

function bindNavData() {
  const cs = state.chartSeries,
    n = cs.x.length;
  syncNavBuckets();
  if (n <= navMaxBuckets()) {
    navData = [cs.x.copyRange(0, n), cs.power.copyRange(0, n)];
    navGeometry = null;
  } else {
    const flat = navBuckets.flatten();
    navGeometry = flat.channels[0];
    navData = [flat.x, flat.ys[0]];
  }
}

/** @type {any} */
let linearBuilder = null;
/** @type {import('./chart-buckets.js').OrderedGeometry[]} */
let mainGeometry = [];
/** @type {{canvas:OffscreenCanvas,ctx:OffscreenCanvasRenderingContext2D,image:ImageData,pixels:Uint32Array,dirtyTop:number,dirtyBottom:number,paintTop:number,paintBottom:number,columns:number[][],columnLengths:Uint32Array,coverage:Float64Array,pending:boolean}|null} */
let bucketRaster = null;
/** @type {WeakMap<object, Map<number, any>>} */
let orderedPaints = new WeakMap();

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
    const size = geometry.x.length * 2;
    const buffer = prior?.buffer.length >= size ? prior.buffer : new Float64Array(Math.max(64, size));
    const points = buffer.subarray(0, size);
    let verticalTravel = 0;
    for (let i = 0; i < geometry.x.length; i++) {
      points[i * 2] = u.valToPos(geometry.x[i], 'x', true);
      points[i * 2 + 1] = u.valToPos(geometry.y[i], series.scale, true);
      if (geometry.connect[i]) verticalTravel += Math.abs(points[i * 2 + 1] - points[(i - 1) * 2 + 1]);
    }
    paint = {
      geometry,
      project: u.valToPos,
      key,
      buffer,
      points,
      connect: geometry.connect,
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
  if (main && useBucketRaster(u)) return { stroke: new Path2D(), fill: null };
  if (paint.stroke)
    return main && series.fill(u, seriesIdx)
      ? { stroke: new Path2D(), fill: null }
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
  if (main && series.fill(u, seriesIdx)) {
    // Keep fallback compositing identical: area first, then the channel stroke.
    paint.stroke = stroke;
    return { stroke: new Path2D(), fill: null };
  }
  paint.stroke = stroke;
  return { stroke, fill: null };
}

function drawBucketFill(u, seriesIdx) {
  if (boundKind !== 'window') return;
  const geometry = orderedPaints.get(u)?.get(seriesIdx),
    series = u.series[seriesIdx];
  const fill = series.fill(u, seriesIdx);
  if (!geometry || !fill || !Number.isFinite(geometry.base)) return;
  if (geometry.rasterFill && useBucketRaster(u) && /^rgba\(/.test(fill)) return;
  if (bucketRaster?.pending) flushBucketRaster(u);
  const started = performance.now();
  const { points, connect, base } = geometry,
    ctx = u.ctx,
    bbox = u.bbox;
  if (!geometry.fill) {
    const path = new Path2D();
    let open = false,
      lastX = 0;
    const close = () => {
      if (!open) return;
      path.lineTo(lastX, base);
      path.closePath();
      open = false;
    };
    for (let i = 0; i < connect.length; i++) {
      const x = points[i * 2],
        y = points[i * 2 + 1];
      if (!connect[i] || !Number.isFinite(x) || !Number.isFinite(y)) close();
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (!open) {
        path.moveTo(x, base);
        path.lineTo(x, y);
        open = true;
      } else path.lineTo(x, y);
      lastX = x;
    }
    close();
    geometry.fill = path;
  }
  // Keep the area on the destination canvas. Filling the CPU scratch before
  // drawImage forces its pending path to rasterize synchronously on WebView2.
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.fillStyle = fill;
  ctx.globalAlpha = series.alpha;
  ctx.fill(geometry.fill);
  ctx.restore();
  recordPaintStage(u, 'fill', started);
}

function useBucketRaster(u) {
  return (
    u === state.mainChart &&
    boundKind === 'window' &&
    typeof OffscreenCanvas !== 'undefined' &&
    u.series.slice(1).every((s) => !s.show || (s.alpha === 1 && /^#[\da-f]{6}$/i.test(s.stroke(u, 0))))
  );
}

/** Scan-convert by x column, then union covered intervals before writing any pixels. */
function drawBucketRaster(u, seriesIdx) {
  if (!useBucketRaster(u)) {
    if (u !== state.mainChart || boundKind !== 'window') return;
    // Unfilled fallback paths are stroked by uPlot itself. Only a filled path
    // defers its stroke until after our custom area composition.
    if (!u.series[seriesIdx].fill(u, seriesIdx)) return;
    const stroke = orderedPaints.get(u)?.get(seriesIdx)?.stroke;
    if (!stroke) return;
    const ctx = u.ctx,
      bbox = u.bbox,
      series = u.series[seriesIdx];
    ctx.save();
    ctx.beginPath();
    ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
    ctx.clip();
    ctx.strokeStyle = series.stroke(u, seriesIdx);
    ctx.lineWidth = series.width * plotPixelRatio();
    ctx.globalAlpha = series.alpha;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.stroke(stroke);
    ctx.restore();
    return;
  }
  const geometry = orderedPaints.get(u)?.get(seriesIdx);
  if (!geometry) return;
  const started = performance.now();
  const bbox = u.bbox,
    width = Math.ceil(bbox.width),
    height = Math.ceil(bbox.height);
  if (!bucketRaster || bucketRaster.canvas.width !== height || bucketRaster.canvas.height !== width) {
    // Transpose the scratch: each screen column becomes one contiguous row.
    const canvas = new OffscreenCanvas(height, width);
    // The shared scratch is rewritten by CPU pixels after every channel.
    const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (
      canvas.getContext('2d', { willReadFrequently: true })
    );
    const image = ctx.createImageData(height, width);
    bucketRaster = {
      canvas,
      ctx,
      image,
      pixels: new Uint32Array(image.data.buffer),
      dirtyTop: height,
      dirtyBottom: 0,
      paintTop: height,
      paintBottom: 0,
      columns: Array.from({ length: width }, () => []),
      columnLengths: new Uint32Array(width),
      coverage: new Float64Array((height + 1) * 3),
      pending: false,
    };
  }
  const { pixels, columns, columnLengths } = bucketRaster;
  if (!bucketRaster.pending) {
    if (bucketRaster.dirtyBottom > bucketRaster.dirtyTop)
      for (let x = 0; x < width; x++)
        pixels.fill(0, x * height + bucketRaster.dirtyTop, x * height + bucketRaster.dirtyBottom);
    bucketRaster.dirtyTop = height;
    bucketRaster.dirtyBottom = 0;
  }
  const series = u.series[seriesIdx],
    hex = Number.parseInt(series.stroke(u, seriesIdx).slice(1), 16);
  const color = new Uint32Array(Uint8Array.of(hex >>> 16, (hex >>> 8) & 255, hex & 255, 255).buffer)[0];
  const fill = series.fill(u, seriesIdx);
  const half = (series.width * plotPixelRatio()) / 2;
  const intervalStarted = performance.now();
  if (!geometry.raster || geometry.raster.half !== half) {
    columnLengths.fill(0);
    const { points, connect } = geometry;
    for (let i = 0; i < connect.length; i++) {
      const x1 = points[i * 2] - bbox.left,
        y1 = points[i * 2 + 1] - bbox.top;
      if (!Number.isFinite(x1) || !Number.isFinite(y1)) continue;
      const x0 = connect[i] ? points[(i - 1) * 2] - bbox.left : x1;
      const y0 = connect[i] ? points[(i - 1) * 2 + 1] - bbox.top : y1;
      const dx = x1 - x0,
        dy = y1 - y0;
      const left = Math.max(0, Math.floor(Math.min(x0, x1) - half)),
        right = Math.min(width, Math.ceil(Math.max(x0, x1) + half));
      for (let x = left; x < right; x++) {
        const ta = dx ? Math.max(0, Math.min(1, (x - half - x0) / dx)) : 0;
        const tb = dx ? Math.max(0, Math.min(1, (x + 1 + half - x0) / dx)) : 1;
        const a = y0 + dy * ta,
          b = y0 + dy * tb;
        const top = Math.max(0, Math.floor(Math.min(a, b) - half)),
          bottom = Math.min(height, Math.ceil(Math.max(a, b) + half));
        if (top < bottom) {
          const n = columnLengths[x];
          columns[x][n] = top;
          columns[x][n + 1] = bottom;
          columnLengths[x] = n + 2;
        }
      }
    }
    let entries = 0;
    for (let x = 0; x < width; x++) {
      const spans = columns[x],
        length = columnLengths[x];
      // In-place insertion sort of interval pairs; each column has a bounded candidate count.
      for (let i = 2; i < length; i += 2) {
        const a = spans[i],
          b = spans[i + 1];
        let j = i;
        while (j > 0 && spans[j - 2] > a) {
          spans[j] = spans[j - 2];
          spans[j + 1] = spans[j - 1];
          j -= 2;
        }
        spans[j] = a;
        spans[j + 1] = b;
      }
      let top = spans[0],
        bottom = spans[1];
      let count = 0;
      for (let i = 2; i <= length; i += 2) {
        if (i < length && spans[i] <= bottom) {
          bottom = Math.max(bottom, spans[i + 1]);
          continue;
        }
        if (bottom > top) {
          spans[count++] = top;
          spans[count++] = bottom;
        }
        top = spans[i];
        bottom = spans[i + 1];
      }
      columnLengths[x] = count;
      entries += count;
    }
    geometry.intervalBuffer =
      geometry.intervalBuffer?.length >= entries ? geometry.intervalBuffer : new Uint32Array(Math.max(64, entries));
    geometry.offsetBuffer =
      geometry.offsetBuffer?.length >= width + 1 ? geometry.offsetBuffer : new Uint32Array(width + 1);
    const spans = geometry.intervalBuffer.subarray(0, entries),
      offsets = geometry.offsetBuffer.subarray(0, width + 1);
    let cursor = 0;
    for (let x = 0; x < width; x++) {
      offsets[x] = cursor;
      for (let i = 0; i < columnLengths[x]; i++) spans[cursor++] = columns[x][i];
    }
    offsets[width] = cursor;
    geometry.raster = { half, spans, offsets };
    recordPaintStage(u, 'intervals', intervalStarted);
  } else recordPaintStage(u, 'intervalsCached', intervalStarted);
  const { spans, offsets } = geometry.raster;
  if (geometry.rasterFill && Number.isFinite(geometry.base) && fill && /^rgba\(/.test(fill))
    rasterBucketFill(u, geometry, fill);
  let { dirtyTop, dirtyBottom } = bucketRaster;
  for (let x = 0; x < width; x++) {
    for (let i = offsets[x]; i < offsets[x + 1]; i += 2) {
      const top = spans[i],
        bottom = spans[i + 1];
      dirtyTop = Math.min(dirtyTop, top);
      dirtyBottom = Math.max(dirtyBottom, bottom);
      pixels.fill(color, x * height + top, x * height + bottom);
    }
  }
  bucketRaster.dirtyTop = dirtyTop;
  bucketRaster.dirtyBottom = dirtyBottom;
  bucketRaster.pending = true;
  recordPaintStage(u, 'raster', started);
  if (u.series.slice(seriesIdx + 1).some((s) => s.show)) return;
  flushBucketRaster(u);
}

function flushBucketRaster(u) {
  if (!bucketRaster?.pending) return;
  bucketRaster.pending = false;
  const { dirtyTop, dirtyBottom } = bucketRaster,
    bbox = u.bbox,
    width = Math.ceil(bbox.width);
  if (dirtyBottom <= dirtyTop) return;
  const uploadStarted = performance.now();
  const scratch = bucketRaster.ctx;
  if (bucketRaster.paintBottom > bucketRaster.paintTop)
    scratch.clearRect(bucketRaster.paintTop, 0, bucketRaster.paintBottom - bucketRaster.paintTop, width);
  scratch.putImageData(bucketRaster.image, 0, 0, dirtyTop, 0, dirtyBottom - dirtyTop, width);
  bucketRaster.paintTop = dirtyTop;
  bucketRaster.paintBottom = dirtyBottom;
  const ctx = u.ctx;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.transform(0, 1, 1, 0, bbox.left, bbox.top);
  ctx.drawImage(
    bucketRaster.canvas,
    dirtyTop,
    0,
    dirtyBottom - dirtyTop,
    width,
    dirtyTop,
    0,
    dirtyBottom - dirtyTop,
    width,
  );
  ctx.restore();
  recordPaintStage(u, 'bitmap', uploadStarted);
}

/** @param {any} u @param {any} geometry @param {string} fill */
function rasterBucketFill(u, geometry, fill) {
  const started = performance.now();
  const rgba = fill.match(/[\d.]+/g)?.map(Number);
  if (!rgba || rgba.length !== 4 || !bucketRaster) return;
  const rgb = new Uint32Array(Uint8Array.of(rgba[0], rgba[1], rgba[2], 0).buffer)[0];
  const bounds = rasterOrderedFill({
    points: geometry.points,
    connect: geometry.connect,
    base: geometry.base - u.bbox.top,
    leftOffset: u.bbox.left,
    topOffset: u.bbox.top,
    width: bucketRaster.canvas.height,
    height: bucketRaster.canvas.width,
    pixels: bucketRaster.pixels,
    coverage: bucketRaster.coverage,
    rgb,
    opacity: rgba[3],
    transposed: true,
    opaque: geometry.raster,
    composite: bucketRaster.pending,
  });
  bucketRaster.dirtyTop = Math.min(bucketRaster.dirtyTop, bounds.top);
  bucketRaster.dirtyBottom = Math.max(bucketRaster.dirtyBottom, bounds.bottom);
  recordPaintStage(u, 'fill', started);
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
  mainData = [
    cs.x.copyRange(rawStart, rawEnd),
    cs.voltage.copyRange(rawStart, rawEnd),
    cs.current.copyRange(rawStart, rawEnd),
    cs.power.copyRange(rawStart, rawEnd),
    cs.temp.copyRange(rawStart, rawEnd),
    cs.dp.copyRange(rawStart, rawEnd),
    cs.dn.copyRange(rawStart, rawEnd),
    cs.cc1.copyRange(rawStart, rawEnd),
    cs.cc2.copyRange(rawStart, rawEnd),
  ];
}

export function syncChartSeries() {
  pauseContext = null;
  displayFrames.cancel('chart-navigator');
  cancelIndexWarmup();
  cancelPreparation();
  cancelFrameProbe();
  selectDisplayContext(state.isRecording ? 'recording' : 'review');
  recordingRenderPolicy.reset();
  reviewRenderPolicy.reset();
  recordingFillPolicy.reset();
  reviewFillPolicy.reset();
  sourceRevision = chartRevision();
  bucketRaster = null;
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

/** @param {boolean} dragging */
export function setRangeDragging(dragging) {
  if (dragging && !rangeDragging) {
    cancelIndexWarmup();
    selectDisplayContext('review');
    cancelFrameProbe(false);
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
  const cols = [cs.voltage, cs.current, cs.power, cs.temp, cs.dp, cs.dn, cs.cc1, cs.cc2];
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

/** Review resolves physical pixels rather than widening stripes on high-DPI screens. */
function displayResolution(width = plotCssWidth()) {
  return width * (displayContext === 'review' ? plotPixelRatio() : 1);
}

/** Sparse windows retain raw samples even after a dense recording reduced its budget. @param {number} count */
function mainBucketCap(count) {
  const width = plotCssWidth();
  return bucketCap(displayResolution(width) / (displayDense(count, width) ? renderPolicy.pixelsPerBucket : 1));
}

/** Keep medium zooms on real sample geometry with a bounded copy/vertex budget. */
function mainRawLimit() {
  return displayContext === 'review'
    ? Math.min(16_384, Math.floor(displayResolution() * 4))
    : Math.floor(plotCssWidth());
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

/** Fill needs a larger window AND measured pressure; raw history size alone never suppresses it. */
function fillDense(count = visiblePointCount, width = visiblePlotWidth) {
  if (count >= Math.max(1, width) * FILL_POINTS_PER_PIXEL) return true;
  if (count <= displayResolution(width)) return false;
  if (displayContext !== 'review' || !state.mainChart?.bbox?.height) return false;
  const { start, end } = sourceRange();
  // Complexity-protected bucket windows still retrace many vertical segments.
  // Keep measured fill protection until they can actually use the raw path.
  return !useRawWindow(start, end);
}

function hasEnabledFill() {
  return fillStyles.some((fill, i) => i > 0 && fill !== null && state.mainChart?.series?.[i]?.show !== false);
}

function fillSuppressed() {
  return fillDense() && hasEnabledFill() && fillPolicy.suppressed;
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
    state.chartSeries.sampleIntervals.at(-1) || state.settings.sampleRate,
  );
}

function channelBufs() {
  const cs = state.chartSeries;
  return [cs.voltage, cs.current, cs.power, cs.temp, cs.dp, cs.dn, cs.cc1, cs.cc2];
}

/** @param {SeriesBuckets} buckets @param {BoundKind} kind */
function bindFlattenedBuckets(buckets, kind) {
  const flat = buckets.flatten();
  mainData = [flat.x, ...flat.ys];
  mainGeometry = flat.channels;
  boundKind = kind;
}

/**
 * 条带折叠的**速度选择器**：只决定耗时，不决定产出值 —— 金字塔 fold 与逐样本扫描对同一条带
 * 得到同一组 min/max（`test/chart-extrema.test.js` 的 `compare()` 逐桶钉着这条等价）。
 * 所以拖动中 / 松手后 / 冷启动走到不同分支，画出来的曲线也必须一模一样。
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
  if (ppb < COLD_BUILD_PPB) return null;
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
  const ppb = stripePpb(end - start, cap);
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
      displayBuckets.ppb <= ppb ||
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
    };
    const work = { target, cancelled: false, started: false, start: () => {} };
    pauseRefinement = work;
    const cs = state.chartSeries,
      xs = cs.x.snapshot(),
      series = channelBufs().map((col) => col.snapshot());
    const buckets = new SeriesBuckets();
    let prepareMs = 0;
    /** @type {ReturnType<SeriesBuckets['beginRebuild']>|null} */
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
            step ??= buckets.beginRebuild(xs, series, start, end, cap, extremaIndex);
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
          buckets.coarsenTo(stripePpb(latest.end - start, mainBucketCap(latest.end - start)));
          buckets.appendThroughFixed(cs.x, channelBufs(), latest.end);
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

/** Only a full history can change density through pairwise merging. @param {number} start @param {number} end @param {number} ppb */
function canAdvanceBuckets(start, end, ppb) {
  return (
    displayBuckets.list.length > 0 &&
    displayBuckets.canAppend(start, end) &&
    end - displayBuckets.srcEnd <= 4096 &&
    (ppb === displayBuckets.ppb || (start === 0 && end === state.chartSeries.x.length && ppb > displayBuckets.ppb))
  );
}

/** @param {number} start @param {number} end @param {number} cap @param {PaintRequest} request */
function prepareLargeProjection(start, end, cap, request) {
  const count = end - start;
  const ppb = stripePpb(count, cap);
  if (projectionWork && (!preparationTarget || preparationInvalid(preparationTarget))) {
    projectionWork.cancelled = true;
    projectionWork = null;
  }
  if (projectionWork) return true;
  if (count <= COOPERATIVE_POINTS || stripesMatch(start, end, count, cap)) return false;
  // A short append still uses the existing cheap incremental path.
  if (canAdvanceBuckets(start, end, ppb)) return false;
  const priorTarget = preparationTarget;
  const target = capturePreparationTarget(state.chartSeries.x.length, start, end, cap, ppb);
  const cs = state.chartSeries;
  const series = channelBufs().map((column) => column.snapshot());
  const index = extremaForStripes(series, end, ppb);
  const buckets = new SeriesBuckets();
  const step = buckets.beginRebuild(cs.x.snapshot(), series, start, end, cap, index);
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
 * 现有条带是否正好是窗口 `(start,end)` 在该密度下应当画出的那批（不含绑定状态）。
 * 密度也是判据：复用的前提是先缩放进来、松手后重建会算出同一批条带。
 * @param {number} start @param {number} end @param {number} windowCount @param {number} cap
 */
function stripesMatch(start, end, windowCount, cap) {
  return (
    displayBuckets.ppb === stripePpb(windowCount, cap) &&
    displayBuckets.srcStart === start &&
    displayBuckets.srcEnd === end &&
    displayBuckets.list.length > 0
  );
}

/**
 * 当前绑定的顶点是否已经就是本窗口该画的那批，因而只需 setScale。
 * @param {number} start @param {number} end @param {number} windowCount @param {number} cap
 */
function bindingCovers(start, end, windowCount, cap) {
  if (useRawWindow(start, end)) {
    // Keep both neighbours: uPlot needs their segments at clipped boundaries.
    return (
      boundKind === 'raw' &&
      rawStart <= Math.max(0, start - 1) &&
      rawEnd >= Math.min(state.chartSeries.x.length, end + 1)
    );
  }
  return boundKind === 'window' && stripesMatch(start, end, windowCount, cap);
}

function applyXScale(range = xRange()) {
  if (!state.mainChart) return;
  const [min, max] = range;
  state.mainChart.setScale('x', { min, max });
}

/**
 * 「画什么」的唯一定义：把主图绑到窗口 `[start,end)` 在 `stripePpb(windowCount, cap)` 密度下的
 * min/max 条带；中等缩放在有界顶点预算内复制原始样本及裁剪邻点。拖动中与松手后都只经过这里。
 * @param {{ cap: number, start: number, end: number, windowCount: number, force: boolean }} args
 */
function bindDisplayData(args) {
  const { cap, start, end, windowCount } = args;
  const cs = state.chartSeries;

  if (useRawWindow(start, end)) {
    if (boundKind === 'raw' && rawStart <= Math.max(0, start - 1) && rawEnd >= Math.min(cs.x.length, end + 1)) return;
    boundKind = 'raw';
    bindMainViews(start, end);
    return;
  }

  const ppb = stripePpb(windowCount, cap);
  const series = channelBufs();

  if (stripesMatch(start, end, windowCount, cap)) {
    if (boundKind !== 'window') bindFlattenedBuckets(displayBuckets, 'window');
    return;
  }

  // Full-history growth and budget reductions merge the fixed prefix in O(width).
  // The existing partial tail then absorbs new samples at the new density.
  if (canAdvanceBuckets(start, end, ppb)) {
    displayBuckets.coarsenTo(ppb);
    displayBuckets.appendThroughFixed(cs.x, series, end);
    bindFlattenedBuckets(displayBuckets, 'window');
    return;
  }

  displayBuckets.rebuild(cs.x, series, start, end, cap, extremaForStripes(series, end, ppb));
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
    pixelsPerBucket:
      role === 'main' ? renderPolicy.pixelsPerBucket / (displayContext === 'review' ? plotPixelRatio() : 1) : undefined,
    displayDense: role === 'main' && displayDense(),
    fillSuppressed: role === 'main' && fillSuppressed(),
    fillSuppressionReason: role === 'main' && fillSuppressed() ? fillPolicy.reason : null,
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
      stages.coverageBytes = chart === state.mainChart ? (bucketRaster?.coverage.byteLength ?? 0) : 0;
      stages.rasterBytes = chart === state.mainChart ? (bucketRaster?.image.data.byteLength ?? 0) : 0;
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
  const eligibleFill = fillDense() && hasEnabledFill();
  const paintedFillSuppressed = fillSuppressed();
  const appendCount = pending?.lastDiagnostic.recentAppendCount ?? 0;
  // Canvas work may stall the second or third frame after a fast first
  // callback. Treat this bounded observation window as one paint sample, so a
  // healthy intervening frame neither hides its lag nor counts one stall twice.
  // A continuous gesture supplies another paint each frame: consume each actual
  // frame once so slow draws can adjust the budget before the gesture ends.
  // Live/static paints and the final release retain the delayed-raster probe.
  const probeFrames =
    dense && (!interactive || (eligibleFill && !fillPolicy.suppressed && !filledPaintConfirmed)) ? 3 : 1;
  let observedFrames = 0;
  let previousFrameAt = drawEndedAt;
  let nextFrameDelayMs = 0;
  let frameDelayMs = 0;
  let fillFrameDelayMs = 0;
  const observeFrame = () => {
    chartProbeFrame = null;
    if (epoch !== feedbackEpoch || generation !== dataGen || chart !== state.mainChart) return;
    const visible = monitorVisible();
    const at = performance.now();
    if (
      !visible ||
      live !== (state.isRecording && displayContext === 'recording') ||
      dense !== currentWindowDense() ||
      eligibleFill !== (fillDense() && hasEnabledFill()) ||
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
    fillFrameDelayMs = Math.max(
      fillFrameDelayMs,
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
      // Cold preparation and other work before draw cannot establish a coarse
      // display budget. Use the same actual-paint pressure as fill protection.
      delayMs: fillFrameDelayMs,
      at,
      idleFrameMs: performanceDiagnostics.idleFrameIntervalMs(),
      visible,
      dense,
      interactive,
    });
    // Without incoming samples, a first moderately slow review draw would never
    // receive its second observation. Force exactly one confirmation at this
    // density; a healthy result stops, a second slow result coarsens the budget.
    const fillChanged = fillPolicy.observe({
      delayMs: fillFrameDelayMs,
      at,
      idleFrameMs: renderPolicy.idleFrameMs,
      visible,
      eligible: eligibleFill,
      paintedDensity: density,
      nextDensity: renderPolicy.pixelsPerBucket,
      densityLimit: renderPolicy.maxDensity,
      largeBatch: live && appendCount >= visiblePlotWidth * FILL_POINTS_PER_PIXEL,
    });
    const slowFill = fillFrameDelayMs > Math.max(33, renderPolicy.idleFrameMs * 2);
    if (slowFill || (fillChanged && !fillPolicy.suppressed)) filledPaintConfirmed = false;
    else if (eligibleFill && !paintedFillSuppressed && observedFrames >= 3) filledPaintConfirmed = true;
    const confirmReview =
      !live &&
      dense &&
      ((renderPolicy.slowFrames === 1 && density < renderPolicy.maxDensity) || fillPolicy.needsConfirmation);
    if (densityChanged || fillChanged || confirmReview) {
      feedbackRepaintPending = true;
      scheduleChartUpdate('maintenance');
    } else if (rangeDragging && chartDirty) scheduleChartUpdate('interaction');
  };
  chartProbeFrame = requestAnimationFrame(observeFrame);
}

/** @param {boolean} [resetFill=true] */
function cancelFrameProbe(resetFill = true) {
  if (chartProbeFrame !== null) cancelAnimationFrame(chartProbeFrame);
  chartProbeFrame = null;
  feedbackRepaintPending = false;
  feedbackEpoch++;
  renderPolicy.breakFeedback();
  if (resetFill) {
    filledPaintConfirmed = false;
    if (fillPolicy.reset()) fillPaintDirty = true;
  } else fillPolicy.breakFeedback();
}

/** Display budgets from live recording never become the initial review budget. @param {'recording'|'review'} context */
function selectDisplayContext(context) {
  if (context === displayContext) return;
  const previousFill = fillPolicy;
  const previousRender = renderPolicy;
  cancelFrameProbe(false);
  displayContext = context;
  filledPaintConfirmed = false;
  renderPolicy = context === 'recording' ? recordingRenderPolicy : reviewRenderPolicy;
  fillPolicy = context === 'recording' ? recordingFillPolicy : reviewFillPolicy;
  // The source is unchanged across pause/gesture transitions. Share known fill
  // pressure, never the recording density, to avoid retrying a costly filled
  // path just as a finer review window is requested.
  if (context === 'review' && (previousFill.suppressed || previousRender.nextFrameDelayMs > 100)) {
    fillPolicy.suppressed = true;
    fillPolicy.reason = previousFill.reason ?? 'severe-frame';
    fillPolicy.lastSuppressedAt = previousFill.lastSuppressedAt || performance.now();
  }
  fillPaintDirty = true;
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
    cancelFrameProbe(false);
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
  if ((!fillDense() || !hasEnabledFill()) && fillPolicy.reset()) fillPaintDirty = true;
  const cap = target?.cap ?? mainBucketCap(windowCount);
  const ppb = stripePpb(windowCount, cap);
  const coarsePreview = usePausePreview(start, end, cap);
  if (
    !coarsePreview &&
    (prepareLargeHistory(srcLen, end, ppb, canAdvanceBuckets(start, end, ppb), request) ||
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
  const force = !!opts.force || fillPaintDirty;
  fillPaintDirty = false;
  const dataChanged = appended || appliedMainGen !== dataGen;
  // 拖动中唯一被推迟的是导航图重扫：它与主图画什么无关。
  const preview = rangeDragging && !force;

  const nextXRange = target?.xRange ?? xRange();
  const sameXRange = appliedXRange?.[0] === nextXRange[0] && appliedXRange?.[1] === nextXRange[1];
  const covers = coarsePreview || bindingCovers(start, end, windowCount, cap);
  const frozenAppend = appended && state.chartWindow.mode === 'frozen' && sameXRange && covers && !yChanged;
  const reuseBinding = !force && appliedMainGen === dataGen && covers && (!dataChanged || frozenAppend);

  if (reuseBinding) {
    if (!sameXRange) {
      expectChartDraw(state.mainChart, request);
      applyXScale(nextXRange);
    }
  } else {
    if (!coarsePreview) bindDisplayData({ cap, start, end, windowCount, force });
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

  if (dataChanged || appliedNavGen !== dataGen || appliedNavLen !== srcLen) {
    syncNavBuckets(srcLen);
    const nav = state.navigatorChart;
    const now = performance.now();
    const cap = navMaxBuckets();
    const live = state.isRecording && !force && !preview && srcLen > cap;
    const due = !live || now - lastNavPaint >= NAV_PAINT_MIN_MS || appliedNavGen !== dataGen;
    if (nav && due && (appliedNavGen !== dataGen || appliedNavLen !== srcLen)) {
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
      if (request.pause) displayFrames.schedule('chart-navigator', submit, 20);
      else {
        displayFrames.cancel('chart-navigator');
        submit();
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
  pauseContext = null;
  displayFrames.cancel('chart-navigator');
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
    if (!monitorVisible()) {
      pauseContext = null;
      displayFrames.cancel('chart-navigator');
      cancelIndexWarmup();
      chartDirty = true;
      paintRequest = null;
      cancelChartFrame();
      cancelFrameProbe();
      cancelPreparation();
      return;
    }
    handleMonitorShown();
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
    if (divisionSyncPending) {
      divisionSyncPending = false;
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
  // Do not queue several expensive filled paths before delayed raster feedback
  // from the first one arrives. Merge the latest gesture window until the bounded
  // probe completes; protected/unfilled and raw windows keep their normal cadence.
  if (
    rangeDragging &&
    currentWindowDense() &&
    chartProbeFrame !== null &&
    fillDense() &&
    hasEnabledFill() &&
    !fillPolicy.suppressed &&
    !filledPaintConfirmed
  )
    return;
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
      if (!rangeDragging) cancelFrameProbe(false);
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
  if (!chart || !chart.series[si]) return;
  cancelFrameProbe();
  chart.setSeries(si, { show: !!show });
  renderLegend();
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

/**
 * 挂靠在电压 scale 上的 series 下标集合。
 * D+/D-/CC1/CC2 叠加曲线与电压共用一个 scale：量程必须聚合所有挂靠曲线，
 * 否则隐藏电压时叠加曲线会失去量程（mkYRange 旧实现只看电压一条）。
 */
const VOLTAGE_SCALE_SERIES = [1, 5, 6, 7, 8];

/**
 * 图表纵向余量（0-1 小数）。auto = 25%（曲线保持中高位置），custom 读设置值。
 * @returns {number}
 */
function headroomFrac() {
  const s = state.settings;
  if (s.chartHeadroomMode === 'custom') {
    const p = Number(s.chartHeadroomPercent);
    if (Number.isFinite(p)) return Math.min(100, Math.max(0, p)) / 100;
  }
  return 0.25;
}

/**
 * 聚合一组挂靠在同一 scale 上的可见 series 的全量 min/max。
 * @param {any} u @param {number[]} seriesIndexes
 * @returns {{min: number, max: number}|{empty: true}|null} 全部隐藏 → null（轴自动隐藏）；可见但无有限数据 → {empty:true}
 */
function aggregateVisible(u, seriesIndexes) {
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

/**
 * 0 基线 + 顶部余量；出现负值时（有符号电流）底部按同比例外扩。
 * @param {number} min @param {number} max @param {number} h
 * @returns {[number, number]}
 */
function paddedZeroBased(min, max, h) {
  const lo = min < 0 ? min * (1 + h) : 0;
  const hi = max > 0 ? max * (1 + h) : min < 0 ? 0 : 1;
  return lo < hi ? [lo, hi] : [lo - 0.5, hi + 0.5];
}

/** 挂在纵轴上的全部 scale（网格 / 等分对齐的作用域）。 */
const Y_SCALES = ['voltage', 'current', 'power', 'temp'];

/**
 * 全部 Y 轴共用的等分格数。
 *
 * 多轴网格对齐的关键：对齐不要求各轴数值相同，只要求刻度落在相同的高度比例上。
 * 于是取一个全局等分数 N，把每条轴的量程量化成 N 个整齐步长（quantizeRange），
 * 刻度用 min + (max-min)·i/N 生成（uniformSplits）—— 第 i 条刻度在每条轴上都是
 * 同一像素行，四条轴的网格线因此严格重合。
 *
 * 用 u.height（画布总高）而非 u.bbox.height 推算：bbox 依赖轴宽、轴宽依赖刻度
 * 文字、刻度又依赖等分数，读 bbox 会形成布局循环。70 是 X 轴 + 轴顶横向标题
 * 的大致占用，余下按约 80px/格换算——只随窗口尺寸变化，不随数据抖动。
 * @param {any} u
 * @returns {number}
 */
function yDivisions(u) {
  const plotHeight = Math.max(80, (Number(u?.height) || 300) - 70);
  return Math.min(7, Math.max(3, Math.round(plotHeight / 80)));
}

/**
 * 量程量化时实际采用的等分数。
 *
 * 刻度（uniformSplits）与次网格必须复用它，而不是各自再调一次 yDivisions：
 * 量程只在 setData / setScale 时重算，而 yDivisions 随窗口高度即时变化，
 * 两者若不同步就会出现「按 7 等分量化的量程被切成 5 份」——刻度落在 5.6、11.2
 * 这种非整数上。窗口高度变化后由 syncDivisionsAfterResize 补一次量程重算。
 */
let appliedYDivisions = 0;

/** 绘图区高度变了 → 等分数可能变，与尺寸 / 数据提交共用一帧。 */
let divisionSyncPending = false;
function syncDivisionsAfterResize(/** @type {any} */ u) {
  if (divisionSyncPending || yDivisions(u) === appliedYDivisions) return;
  divisionSyncPending = true;
  scheduleChartUpdate();
}

/** 量化步长的候选尾数。比常见的 1/2/5 更细，用于压低量化引入的额外余量。 */
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];

/**
 * 把量程量化为「整齐步长 × 等分数」，使刻度既是整数值又正好铺满绘图区。
 *
 * 代价：量化只向上取整，实际纵向余量可能比设置值多出至多一个步长（细候选表把
 * 超出压在 20% 上下，粗糙的 1/2/5 阶梯会翻倍）。这是「整齐刻度 + 严格对齐」不可
 * 避免的开销。
 * @param {number} lo @param {number} hi @param {number} divisions
 * @returns {[number, number]}
 */
function quantizeRange(lo, hi, divisions) {
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) return [lo, hi];
  const mag = 10 ** Math.floor(Math.log10(span / divisions));
  // 起点下取整最多把跨度撑大一个步长，因此候选需覆盖到 span/(divisions-1)；
  // divisions ≥ 3 时该值 < 1.5×原始步长，两个数量级的候选表足够。
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
 * 构造 Y 轴范围函数：聚合挂靠该 scale 的所有可见 series，0 起点 + 可配置余量，
 * 最后量化到全局等分格（与其余 Y 轴共线）。
 * 注意：量程完全来自模块内的 seriesMax/seriesMin 增量跟踪，因此各 series 均设置
 * auto: false，跳过 uPlot 每次提交时对全量数据的 min/max 扫描（百万级点数下显著提速）。
 * @param {number[]} seriesIndexes - 挂靠在该 scale 上的 series 下标
 * @param {boolean} [symmetric=false] - 温度轴：对称余量，保留负值
 */
function mkYRange(seriesIndexes, symmetric = false) {
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
        [lo, hi] = paddedZeroBased(agg.min, agg.max, h);
      }
      return quantizeRange(lo, hi, divisions);
    }
  );
}

// ─── Axis helpers ────────────────────────────────────────────────────────────

/**
 * 智能小数位刻度格式化（与旧版 Chart.js 回调一致）。
 * @param {number} value
 * @returns {string}
 */
function smartTick(value) {
  const absVal = Math.abs(value);
  if (absVal > 0 && absVal < 0.001) return String(parseFloat(value.toFixed(6)));
  if (absVal > 0 && absVal < 0.1) return String(parseFloat(value.toFixed(5)));
  if (absVal > 0 && absVal < 1) return String(parseFloat(value.toFixed(4)));
  return String(parseFloat(value.toFixed(3)));
}

/**
 * 生成与其余 Y 轴共线的等分刻度（配合 quantizeRange 量化后的整齐量程使用）。
 * 用 min + (max-min)·i/N 而非逐格累加步长：与 drawMinorGrid 的几何算式同源，
 * 浮点结果逐位一致，刻度线与网格线不会差半个像素。
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
  // 第二轮布局迭代后直接复用已计算的尺寸，避免布局震荡
  if (cycleNum > 1) return axis._size;
  let size = (axis.ticks?.show ? axis.ticks.size : 0) + axis.gap + 4;
  const longest = (values ?? []).reduce((acc, v) => (String(v).length > acc.length ? String(v) : acc), '');
  if (longest !== '') {
    u.ctx.font = axis.font[0];
    size += u.ctx.measureText(longest).width / (uPlot.pxRatio || devicePixelRatio || 1);
  }
  let titleSize = 0;
  if (axis.axisTitle) {
    u.ctx.font = Array.isArray(axis.labelFont) ? axis.labelFont[0] : `12px ${CHART_FONT}`;
    titleSize = u.ctx.measureText(axis.axisTitle).width / (uPlot.pxRatio || devicePixelRatio || 1) + 8;
  }
  return Math.ceil(Math.max(size, titleSize, 28));
}

/**
 * 轴顶横向标题占用的上边距（CSS px）。
 * 顶刻度数字相对绘图区顶边居中，大约伸出 6px；再加标题行高与缝隙。
 * 取代 uPlot 默认 ~17px 顶垫，避免标题与顶刻度挤在一起。
 */
const Y_AXIS_LABEL_PAD = 24;

/**
 * 构造一条 Y 轴配置。
 * 颜色参数为读取 chartTheme 的闭包（uPlot 对 stroke 支持函数形式），换主题后 redraw 即生效。
 * 标题不走 uPlot 的 `label`（只能竖排贴在轴侧并额外占 labelSize），改由 drawYAxisLabels 画在轴顶。
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
    labelFont: `12px ${CHART_FONT}`,
    font: `12px ${MONO_FONT}`,
    // 数字与竖脊之间的空隙；默认朝数字伸出的 ticks 已关闭（见 drawYAxisChrome）
    gap: 6,
    size: axisAutoSize,
    // 等分刻度由 uniformSplits 决定，uPlot 基于 space / incrs 的自动选点被完全覆盖
    splits: (/** @type {any} */ u) => uniformSplits(u, scaleKey),
    values: (/** @type {any} */ _u, /** @type {number[]} */ splits) => splits.map(smartTick),
    // 四条 Y 轴画同一套主网格：量程已量化到相同的高度比例，像素级重合；
    // 令牌是不透明色，重复描边不会叠亮（见 tokens.css 的说明）
    grid: { show: true, stroke: () => chartTheme.grid, width: 1 },
    // 关掉 uPlot 朝数字伸出的横刻度：右侧会像负号。竖脊 + 朝图内的短刻度由 drawYAxisChrome 画
    ticks: { show: false },
  };
}

// ─── Minor grid ──────────────────────────────────────────────────────────────

/** 是否至少有一条 Y 轴在显示（挂靠曲线全部隐藏时该 scale 的 min 为 null）。 */
function hasVisibleYScale(/** @type {any} */ u) {
  return Y_SCALES.some((key) => u.scales?.[key]?.min != null);
}

/**
 * 在主刻度之间画次网格：每个主格均分成 5 格（4 条次线）。
 *
 * 纵向次线取自 X 轴实际刻度（时间步长非等距，只能读 _splits）；
 * 横向次线按几何等分推出——全部 Y 轴共用 yDivisions 等分，次线与任一条轴的刻度
 * 都对齐，因此不依赖某条具体的轴，隐藏电压曲线后横向次网格依然在位。
 * @param {any} u
 */
function drawMinorGrid(u) {
  const { ctx, bbox } = u;
  if (!bbox || bbox.width <= 0 || bbox.height <= 0) return;

  const left = bbox.left;
  const right = bbox.left + bbox.width;
  const top = bbox.top;
  const bottom = bbox.top + bbox.height;
  const pxRatio = uPlot.pxRatio || devicePixelRatio || 1;
  // 主刻度间距低于此值时不再插次线，避免窄图上重新糊成一片（设备像素）
  const minGapPx = 36 * pxRatio;
  const minorCells = 5;

  ctx.save();
  ctx.lineWidth = pxRatio;
  ctx.strokeStyle = chartTheme.gridMinor;
  // 与 uPlot 画网格线同款的清晰化手法：奇数线宽整体平移半像素
  const offset = (ctx.lineWidth % 2) / 2;
  ctx.translate(offset, offset);
  ctx.beginPath();

  // ── 纵向次线（X 轴主刻度之间） ──
  const xSplits = u.axes?.[0]?._splits;
  if (Array.isArray(xSplits) && xSplits.length >= 2) {
    for (let i = 0; i < xSplits.length - 1; i++) {
      const a = u.valToPos(xSplits[i], 'x', true);
      const b = u.valToPos(xSplits[i + 1], 'x', true);
      if (Math.abs(b - a) < minGapPx) continue;
      for (let k = 1; k < minorCells; k++) {
        const x = Math.round(a + ((b - a) * k) / minorCells);
        if (x >= left && x <= right) {
          ctx.moveTo(x, top);
          ctx.lineTo(x, bottom);
        }
      }
    }
  }

  // ── 横向次线（Y 轴等分格之间） ──
  const divisions = appliedYDivisions || yDivisions(u);
  if (bbox.height / divisions >= minGapPx && hasVisibleYScale(u)) {
    for (let i = 0; i < divisions; i++) {
      for (let k = 1; k < minorCells; k++) {
        const y = Math.round(top + (bbox.height * (i + k / minorCells)) / divisions);
        if (y >= top && y <= bottom) {
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
        }
      }
    }
  }

  ctx.stroke();
  ctx.restore();
}

/**
 * 传统坐标轴形态：每条可见 Y 轴一条通道色竖脊；贴着绘图区边缘的轴再朝图内画短刻度。
 * 刻度在竖脊朝图一侧（右侧是 `┤ 1` 而不是 `── 1`），不会被看成负号。
 * 外侧轴（同一侧第二条）脊在轴沟里，短刻度若朝图会戳到内侧轴标题，故只画脊。
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

    // side 3=左 → 刻度向右进图；side 1=右 → 刻度向左进图
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
 * 轴沟只有约 30px，标题宽约 50px，居中于列会和邻居叠字。
 * 贴着绘图区的轴：标题从竖脊朝图内伸出；外侧轴：贴画布外沿。
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

    ctx.font = Array.isArray(axis.labelFont) ? axis.labelFont[0] : `12px ${CHART_FONT}`;
    ctx.fillStyle = stroke;
    ctx.textAlign = align;
    ctx.fillText(title, x, y);
  }

  ctx.restore();
}

// ─── Markers ─────────────────────────────────────────────────────────────────

/** 最多叠几行标签；更多的重叠标记只画竖线，标签可在标记列表里查看。 */
const MARKER_LABEL_ROWS = 3;

/**
 * 打点：贯穿绘图区的竖线，顶部带标签。标签按行错开，靠右边缘时翻到线的左侧。
 * 录制中刚打、还没等到下一行的点不画。
 * @param {any} u
 */
function drawMarkers(u) {
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
  ctx.font = `${fontPx}px ${CHART_FONT}`;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = lineWidth;
  for (const marker of list) {
    if (marker.index >= n) break;
    const x = cols.x.valueAt(marker.index);
    if (!(x >= min && x <= max)) continue;
    // 奇数线宽落在半像素上才是一条实线
    const px = Math.round(u.valToPos(x, 'x', true)) + (lineWidth % 2 ? 0.5 : 0);
    // 线用坐标轴文字色，比标签文字浅一档：标注不该比数据更抢眼
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
function drawNavigatorMarkers(u) {
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

/** Refresh chart labels after a language change without replacing chart data or state. */
export function refreshChartLanguage() {
  syncChartFonts();
  const chart = state.mainChart;
  if (!chart) return;
  for (let i = 0; i < FIELDS.length; i++) {
    if (chart.series[i + 1]) chart.series[i + 1].label = chartLabel(i);
  }
  const axes = chart.axes ?? [];
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

// ─── Tooltip ─────────────────────────────────────────────────────────────────

/**
 * 缺测在 Float64Array 里只能是 NaN，uPlot 只把 == null 当缺口。
 * NaN 会让 valToPos 得到 NaN，光标点 transform 无效，钉在绘图区左上角。
 * 返回 null 让 uPlot 把该 series 的 hover 点移出视口。
 * @param {any} u
 * @param {number} seriesIdx
 * @param {number|null} hoveredIdx
 * @returns {number|null}
 */
/**
 * 桶显示时 uPlot 的 idx 是顶点下标，用 X 二分回全量列。
 * @param {any} u
 * @param {number|null} hoveredIdx
 * @returns {number|null}
 */
function realIndexFromCursor(u, hoveredIdx) {
  if (hoveredIdx == null || appliedMainGen !== dataGen) return null;
  const left = u.cursor.left;
  if (!Number.isFinite(left) || left < 0) return null;
  const xVal = u.posToVal(left, 'x');
  if (!Number.isFinite(xVal) || state.chartSeries.x.length === 0) return null;
  return nearestIndex(state.chartSeries.x, state.chartSeries.x.length, xVal);
}

/** Position hover markers on the same raw sample used by the tooltip.
 * @param {any} u @param {number} seriesIdx
 */
function cursorPointBox(u, seriesIdx) {
  const index = realIndexFromCursor(u, u.cursor.idx);
  const field = /** @type {keyof typeof state.chartSeries} */ (FIELDS[seriesIdx - 1]);
  const value = index == null ? Number.NaN : state.chartSeries[field].valueAt(index);
  if (index == null || !Number.isFinite(value)) return { left: -100, top: -100, width: 0, height: 0 };
  return {
    left: u.valToPos(state.chartSeries.x.valueAt(index), 'x') - 4,
    top: u.valToPos(value, SERIES_SCALES[seriesIdx - 1]) - 4,
    width: 8,
    height: 8,
  };
}

function cursorDataIdx(u, seriesIdx, hoveredIdx) {
  if (hoveredIdx == null) return null;
  const realIdx = realIndexFromCursor(u, hoveredIdx);
  if (realIdx == null) return null;
  if (seriesIdx === 0) return hoveredIdx;
  const field = FIELDS[seriesIdx - 1];
  const y = state.chartSeries[/** @type {keyof typeof state.chartSeries} */ (field)]?.valueAt(realIdx);
  return Number.isFinite(y) ? hoveredIdx : null;
}

/**
 * 悬停 tooltip 插件：index 模式（显示最近 X 处所有可见曲线的值），
 * 标题为相对时间，各行带颜色标记与单位，贴近旧版 Chart.js tooltip 样式。
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
    if (!tt || !title || !monitorVisible()) return;
    const { idx, left, top } = u.cursor;
    if (idx == null || left == null || left < 0 || top == null || top < 0) {
      hide();
      return;
    }
    // 从指针时间查原始点；不使用桶中点，否则同一桶内移动会吸附到错误样本。
    const realIdx = realIndexFromCursor(u, idx);
    const xVal = realIdx == null ? null : state.chartSeries.x.valueAt(realIdx);
    if (realIdx == null || xVal == null || !Number.isFinite(xVal)) {
      hide();
      return;
    }
    let mask = 0;
    for (let i = 0; i < FIELDS.length; i++) {
      if (u.series[i + 1]?.show) mask |= 1 << i;
    }
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
        const field = /** @type {keyof typeof state.chartSeries} */ (FIELDS[i]);
        const value = state.chartSeries[field]?.valueAt(realIdx);
        const show = !!(mask & (1 << i)) && Number.isFinite(value);
        const display = show ? '' : 'none';
        if (row.style.display !== display) row.style.display = display;
        if (show) {
          const label = `${chartLabel(i)}: ${Number(value).toFixed(3)}${UNITS[i]}`;
          if (text.nodeValue !== label) text.nodeValue = label;
          visibleRows++;
        }
        if (lastTheme !== tooltipThemeGen) swatch.style.background = /** @type {any} */ (chartTheme)[FIELDS[i]];
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
    // 只在内容 / 显隐 / 主题 / 字体 / 尺寸变化后读几何；纯移动只写 transform。
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
    if (!tt || frame != null || !monitorVisible()) return;
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
        for (let i = 0; i < FIELDS.length; i++) {
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

// ─── Sizing ──────────────────────────────────────────────────────────────────

/**
 * 绘图区滚轮横向缩放。预览走手柄快路径，松手后补一帧全质量图。
 * @param {any} u
 */
function bindChartWheel(u) {
  const over = u?.over;
  if (!over) return;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let wheelEndTimer = null;
  over.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (state.chartSeries.x.length === 0) return;
      const rect = over.getBoundingClientRect();
      const pivot = u.posToVal(event.clientX - rect.left, 'x');
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode);
      setRangeDragging(true);
      state.__applyChartXZoom?.(pivot, factor);
      if (wheelEndTimer != null) clearTimeout(wheelEndTimer);
      wheelEndTimer = setTimeout(() => {
        wheelEndTimer = null;
        setRangeDragging(false);
        updateCharts('interaction', { force: false, reason: 'release' });
      }, 80);
    },
    { passive: false },
  );
}

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
      points: { size: 8, bbox: cursorPointBox },
      dataIdx: cursorDataIdx,
    },
    scales: {
      x: { time: false, range: /** @type {any} */ (xRange) },
      voltage: { range: mkYRange(VOLTAGE_SCALE_SERIES) },
      current: { range: mkYRange([2]) },
      power: { range: mkYRange([3]) },
      temp: { range: mkYRange([4], true) },
    },
    series: [
      {},
      ...FIELDS.map((field, i) => ({
        label: chartLabel(i),
        scale: SERIES_SCALES[i],
        auto: false,
        stroke: () => /** @type {any} */ (chartTheme)[field],
        // D+/D-/CC 叠加曲线更细，避免与主通道曲线抢焦点
        width: i >= 4 ? 1 : 1.5,
        points: { show: false },
        ...(hasPaths ? { paths: adaptivePaths } : {}),
        // Keep the user's fill until measured pressure survives density reduction.
        fill: () => (fillSuppressed() ? null : fillStyles[i + 1]),
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
        // 80：HH:MM:SS.d 标签约 10 字符（等宽 12px ≈ 72px），64 会在任意宽度下互相碰撞
        space: 80,
        incrs: TIME_INCRS,
        values: (/** @type {any} */ _u, /** @type {number[]} */ splits) =>
          splits.map((v) => formatRelativeHMS(Number(v))),
        grid: { show: true, stroke: () => chartTheme.grid, width: 1 },
        ticks: { show: true, stroke: () => chartTheme.grid, width: 1, size: 8 },
      },
      mkYAxis('voltage', chartAxisTitle('voltage', 'V'), () => chartTheme.voltage, 3),
      mkYAxis('current', chartAxisTitle('current', 'A'), () => chartTheme.current, 3),
      mkYAxis('power', chartAxisTitle('power', 'W'), () => chartTheme.power, 1),
      mkYAxis('temp', chartAxisTitle('temperature', '°C'), () => chartTheme.tempAxis, 1),
    ],
    hooks: {
      drawAxes: [drawMinorGrid, drawYAxisChrome, drawYAxisLabels],
      drawSeries: [drawBucketFill, drawBucketRaster],
      draw: [drawMarkers],
      setSize: [syncDivisionsAfterResize],
    },
    plugins: [tooltipPlugin()],
  };

  state.mainChart = new uPlot(opts, /** @type {any} */ (mainData), host);
  bindChartWheel(state.mainChart);
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
        // 量程来自模块内跟踪的功率全量最大值（序列 auto: false，跳过 uPlot 的全量扫描）
        range: /** @type {any} */ (
          () => {
            const max = seriesMax[3];
            return [0, Number.isFinite(max) && max > 0 ? max * (1 + headroomFrac()) : 1];
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
        width: 1,
        points: { show: false },
        ...(linearBuilder != null ? { paths: adaptivePaths } : {}),
      },
    ],
    axes: [{ show: false }, { show: false }],
    hooks: { draw: [drawNavigatorMarkers] },
  };

  state.navigatorChart = new uPlot(opts, /** @type {any} */ (navData), host);
  observeResize(host, state.navigatorChart, () => {
    resetNavBuckets();
    appliedNavGen = -1;
  });
}
