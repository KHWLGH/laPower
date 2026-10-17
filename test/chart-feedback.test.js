import assert from 'node:assert/strict';
import test from 'node:test';
import { performanceDiagnostics } from '../src/performance-diagnostics.js';

let time = 1000;
let frameId = 0;
const frames = new Map();
const listeners = new Map();
const attrs = new Map();
const mainHost = { clientWidth: 600, clientHeight: 300, setAttribute: (key, value) => attrs.set(key, value) };
globalThis.performance = { now: () => time, timeOrigin: 0 };
globalThis.document = {
  hidden: false,
  documentElement: {},
  addEventListener: (event, callback) => listeners.set(event, callback),
  getElementById: (id) => (id === 'main-chart' ? mainHost : null),
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.MutationObserver = class {
  observe() {}
};
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++frameId, callback);
  return frameId;
};
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
globalThis.uPlot = class {
  static paths = { spline: () => () => null, linear: () => () => null };
  constructor(options, data) {
    Object.assign(this, { options, data, width: options.width, height: options.height, hooks: options.hooks });
  }
  setData(data) {
    this.submissions = (this.submissions ?? 0) + 1;
    this.data = data;
    queueMicrotask(() => {
      for (const hook of this.hooks.drawClear ?? []) hook(this);
      for (let s = 1; s < (this.series?.length ?? 0); s++)
        if (this.series[s].show) {
          this.options.series[s].paths?.(this, s, 0, this.data[0].length - 1);
          for (const hook of this.hooks.drawSeries ?? []) hook(this, s);
        }
      time += 0.4;
      for (const hook of this.hooks.draw ?? []) hook(this);
    });
  }
  setScale() {}
  redraw() {}
};

const { state, emptyChartColumns, setChartColumns } = await import('../src/state.js');
const chart = await import('../src/chart.js');

async function frame(delayMs) {
  time += delayMs;
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(time);
  await Promise.resolve();
}

async function paintFeedback(delayMs = 16, delayed = false) {
  await frame(delayed ? 16 : delayMs);
  if (!delayed && delayMs > 100) return;
  await frame(delayed ? delayMs : 16);
  if (delayed && delayMs > 100) return;
  await frame(16);
}

async function submit() {
  chart.updateCharts('live');
  await Promise.resolve();
}

function seed(recording = true, count = 5000, interval = 1) {
  const cols = emptyChartColumns();
  for (const [key, col] of Object.entries(cols)) {
    const values = new Float64Array(count);
    if (key === 'x') for (let i = 0; i < count; i++) values[i] = (i * interval) / 1000;
    else if (key === 'voltage') for (let i = 0; i < count; i++) values[i] = i % 2;
    else if (key === 'sampleIntervals') values.fill(interval);
    else values.fill(1);
    col.set(values);
  }
  setChartColumns(cols);
  state.settings.activeView = 'monitor';
  state.chartWindow = { mode: 'full', min: 0, max: 0, duration: 0 };
  state.isRecording = recording;
  chart.initChart();
  chart.setChartXWindow(0, ((count - 1) * interval) / 1000);
}

test('real draw hooks lower the bound density even when JS drawing is cheap, preserving every raw point', async () => {
  seed();
  await submit();
  const before = state.mainChart.data[0].length;
  await paintFeedback(40);
  await submit();
  await paintFeedback(40);
  await submit();
  assert.ok(state.mainChart.data[0].length < before);
  assert.equal(state.chartSeries.x.length, 5000);
  assert.equal(Math.max(...state.mainChart.data[1]), 1);
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.pixelsPerBucket, 4);
  assert.equal(last.fillSuppressed, false, 'a first density reduction must retain the user fill');
  assert.equal(last.displayDense, true);
  assert.equal(last.recentAppendCount, 0, 'preloaded history is not a live batch');
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  assert.equal(last.sourcePointCount, 5000);
  assert.equal(last.displayPointCount, state.mainChart.data[0].length);
  assert.ok(last.drawMs < 1);
  assert.equal(last.refreshSource, 'maintenance');
  assert.equal(last.refreshIntervalMs, 0, 'a display-budget repaint is not an acquisition refresh');
  await paintFeedback(40);
  await submit();
  await paintFeedback(40);
  await submit();
  const protectedDraw = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(protectedDraw.fillSuppressed, true);
  assert.equal(protectedDraw.fillSuppressionReason, 'persistent-slow-frame');
  assert.equal(state.mainChart.options.series[1].fill(), null);
});

test('background callbacks and paints from replaced columns never degrade the current recording', async () => {
  await frame(16);
  chart.syncChartSeries();
  await submit();
  const before = state.mainChart.data[0].length;
  document.hidden = true;
  listeners.get('visibilitychange')();
  await frame(200);
  document.hidden = false;
  listeners.get('visibilitychange')();
  await frame(16);
  await submit();
  chart.syncChartSeries();
  await frame(200);
  await submit();
  assert.equal(state.mainChart.data[0].length, before);
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 2);
  state.isRecording = false;
  chart.syncChartSeries();
});

test('paused review confirms expensive fill without reducing curve detail', async () => {
  seed(false);
  await submit();
  const before = state.mainChart.data[0].length;
  await paintFeedback(40);
  assert.equal(state.mainChart.submissions, 1, 'first slow feedback schedules, rather than submits, a probe');
  assert.ok(frames.size > 0);
  await frame(16);
  assert.equal(state.mainChart.submissions, 2, 'an unchanged static binding must actually redraw for confirmation');
  await paintFeedback(40);
  await frame(16);
  assert.equal(state.mainChart.data[0].length, before);
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.pixelsPerBucket, 1);
  assert.equal(last.fillSuppressed, true, 'review protects detail by suppressing confirmed expensive fill');
  assert.equal(last.refreshIntervalMs, 0, 'review interactions are not paced like acquisition');
  assert.equal(state.mainChart.options.series[1].fill(), null);
  await paintFeedback(40);
  await frame(16);
  await paintFeedback(40);
  await frame(16);
  const protectedDraw = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(protectedDraw.fillSuppressed, true);
  assert.equal(protectedDraw.fillSuppressionReason, 'persistent-slow-frame');
  assert.equal(state.mainChart.options.series[1].fill(), null);
  assert.equal(state.chartSeries.x.length, 5000);
  assert.equal(Math.max(...state.mainChart.data[1]), 1);
  await paintFeedback();
  assert.equal(frames.size, 0, 'healthy feedback ends static repaint work');
});

test('a healthy confirmation stops review probes without reducing detail', async () => {
  seed(false);
  await submit();
  const before = state.mainChart.data[0].length;
  await paintFeedback(40);
  await frame(16);
  await paintFeedback();
  assert.equal(state.mainChart.submissions, 2);
  assert.equal(state.mainChart.data[0].length, before);
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 1);
  assert.equal(frames.size, 0);
});

test('persistently slow static review has bounded fill probes and keeps screen-resolution detail', async () => {
  seed(false);
  await submit();
  for (let i = 0; i < 40 && frames.size > 0; i++) await frame(i % 4 === 0 ? 40 : 16);
  assert.equal(frames.size, 0, 'there is no idle redraw loop at the budget limit');
  assert.ok(state.mainChart.submissions <= 3);
  await submit();
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 1);
  await frame(120);
  assert.equal(frames.size, 0, 'even severe feedback at the limit cannot schedule another probe');
  assert.equal(state.chartSeries.x.length, 5000);
});

test('one severe review frame suppresses fill while retaining identical curve geometry', async () => {
  seed(false);
  await submit();
  const before = state.mainChart.data[0].length;
  await frame(120);
  await frame(16);
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.pixelsPerBucket, 1);
  assert.equal(last.fillSuppressed, true);
  assert.equal(last.fillSuppressionReason, 'severe-frame');
  assert.equal(state.mainChart.data[0].length, before);
  await paintFeedback();
  assert.equal(frames.size, 0);
});

test('pressured review paints exact extrema into a bounded transparent bitmap and returns to raw rendering on zoom', async () => {
  const savedCanvas = globalThis.OffscreenCanvas;
  const savedPath = globalThis.Path2D;
  let allocations = 0;
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      allocations++;
      this.width = width;
      this.height = height;
      this.context = {
        clearRect() {},
        save() {},
        restore() {},
        translate() {},
        fill() {},
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (image) => {
          this.image = image;
        },
      };
    }
    getContext() {
      return this.context;
    }
  };
  globalThis.Path2D = class {
    moveTo() {}
    lineTo() {}
    closePath() {}
  };
  try {
    seed(false);
    const u = state.mainChart;
    u.series = u.options.series.map((series, i) => ({ ...series, alpha: 1, show: i === 1 }));
    u.bbox = { left: 11, top: 7, width: 600, height: 20 };
    u.valToPos = (value, scale) => (scale === 'x' ? 11 + (value / 4.999) * 600 : 7 + (1 - value) * 10);
    let pixels = null,
      paints = 0;
    u.hooks.drawClear.unshift(() => {
      pixels = null;
    });
    u.ctx = {
      canvas: { width: 600 },
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      fill() {},
      transform() {},
      drawImage: (canvas) => {
        const image = canvas.image;
        pixels ??= { width: image.height, height: image.width, data: new Uint8ClampedArray(image.data.length) };
        for (let x = 0; x < image.height; x++)
          for (let y = 0; y < image.width; y++) {
            const i = (x * image.width + y) * 4;
            if (image.data[i + 3]) pixels.data.set(image.data.subarray(i, i + 4), (y * image.height + x) * 4);
          }
        paints++;
      },
    };
    await submit();
    await frame(120);
    await frame(16);
    assert.equal(allocations, 1);
    assert.equal(pixels.width, 600);
    assert.equal(pixels.height, 20);
    const opaque = (x, y) => pixels.data[(y * 600 + x) * 4 + 3] === 255;
    assert.ok(
      Array.from({ length: 600 }, (_, x) => x).some((x) => opaque(x, 0)),
      'upper extrema reach the clipped top',
    );
    assert.ok(
      Array.from({ length: 600 }, (_, x) => x).some((x) => opaque(x, 10)),
      'lower extrema are also painted',
    );
    for (let y = 12; y < 20; y++)
      for (let x = 0; x < 600; x++) assert.equal(opaque(x, y), false, 'uncovered grid remains transparent');
    const first = pixels.data.findIndex((value, i) => i % 4 === 3 && value === 255) - 3;
    assert.deepEqual(Array.from(pixels.data.slice(first, first + 4)), [101, 173, 229, 255]);
    await submit();
    assert.equal(allocations, 1, 'repaints reuse the canvas-sized buffer');
    assert.equal(performanceDiagnostics.snapshot().charts.main.last.stages.intervalsCachedCount, 1);
    u.series[1].width++;
    await submit();
    assert.equal(
      performanceDiagnostics.snapshot().charts.main.last.stages.intervalsCount,
      1,
      'stroke width invalidates intervals',
    );
    u.series[1].width--;
    u.scales = { x: { min: 0, max: 4.999 }, voltage: { min: 0, max: 2 } };
    u.valToPos = (value, scale) => (scale === 'x' ? 11 + (value / 4.999) * 600 : 12 + value);
    await submit();
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 600; x++) assert.equal(opaque(x, y), false, 'moving the dirty interval clears old extrema');
    assert.equal(allocations, 1, 'a range change keeps one shared raster');
    const fixture = async (xs, ys, second = null) => {
      const columns = emptyChartColumns();
      for (const [key, col] of Object.entries(columns))
        col.set(
          Float64Array.from({ length: 5000 }, (_, i) =>
            key === 'x'
              ? xs[Math.min(xs.length - 1, Math.floor(i / (5000 / xs.length)))]
              : key === 'voltage'
                ? ys[Math.min(ys.length - 1, Math.floor(i / (5000 / ys.length)))]
                : key === 'current' && second
                  ? second[Math.min(second.length - 1, Math.floor(i / (5000 / second.length)))]
                  : NaN,
          ),
        );
      state.chartSeries = columns;
      chart.syncChartSeries();
      chart.setChartXWindow(xs[0], xs.at(-1));
      await submit();
    };
    u.valToPos = (value, scale) => (scale === 'x' ? 11 + value : 7 + value);
    await fixture([10, 30, 50, 70], [5, 5, NaN, 5]);
    assert.equal(opaque(20, 5), true, 'nonuniform repeated timestamps retain connecting lines');
    assert.equal(opaque(60, 5), false, 'missing samples break the line');
    await fixture([10, 11, 12], [2, 10, 2]);
    for (let y = 3; y < 10; y++) assert.ok(opaque(10, y) || opaque(11, y), 'adjacent columns connect steep slopes');
    u.series[2].show = true;
    await fixture([10, 30, 50, 70], [5, 5, NaN, 5], [5, 5, NaN, 5]);
    assert.deepEqual(
      Array.from(pixels.data.slice((5 * 600 + 30) * 4, (5 * 600 + 30) * 4 + 4)),
      [52, 216, 137, 255],
      'channel draw order',
    );
    await fixture([10, 30], [5, 5], [10, 10]);
    assert.equal(opaque(20, 10), true);
    u.series[2].show = false;
    await submit();
    assert.equal(opaque(20, 10), false, 'hiding a channel clears its previous raster rows');
    u.bbox.width = 300;
    u.bbox.height = 12;
    await submit();
    assert.equal(pixels.width, 300);
    assert.equal(pixels.height, 12);
    assert.equal(pixels.data[(10 * 300 + 20) * 4 + 3], 0, 'shrinking the viewport retains no hidden-channel pixels');
    u.bbox.width = 600;
    u.bbox.height = 20;
    await fixture([10, 30], [-1e12, 1e12]);
    assert.equal(opaque(20, 10), true, 'off-screen slopes clip in bounded columns');
    seed(false);
    state.mainChart = u;
    chart.syncChartSeries();
    chart.setChartXWindow(0, 4.999);
    await submit();
    const densePaints = paints;
    chart.setChartXWindow(2, 2.01);
    await submit();
    assert.equal(paints, densePaints, 'sparse windows use the original curve renderer');
    assert.equal(state.mainChart.data[0].length, 13);
    assert.equal(performanceDiagnostics.snapshot().charts.main.last.fillSuppressed, false);
  } finally {
    globalThis.OffscreenCanvas = savedCanvas;
    globalThis.Path2D = savedPath;
    chart.handleMonitorHidden();
  }
});

test('navigator and Canvas fallback use ordered linear geometry independently of the carrier', async () => {
  const savedPath = globalThis.Path2D,
    savedCanvas = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = undefined;
  globalThis.Path2D = class {
    points = [];
    moveTo(x, y) {
      this.points.push(['M', x, y]);
    }
    lineTo(x, y) {
      this.points.push(['L', x, y]);
    }
    closePath() {
      this.points.push(['Z']);
    }
  };
  try {
    seed(false, 5000);
    await submit();
    const u = state.mainChart;
    u.series = u.options.series.map((s) => ({ ...s, alpha: 1, fillTo: () => 0 }));
    u.valToPos = (v) => v;
    const main = u.options.series[1].paths(u, 1, 0, u.data[0].length - 1);
    assert.ok(main.stroke instanceof Path2D);
    assert.equal(main.fill, null);
    const nav = { series: [{}, { scale: 'y' }], valToPos: (v) => v };
    const before = u.options.series[1].paths(nav, 1, 0, 10).stroke.points;
    assert.ok(before.length > 0);
    chart.setChartXWindow(2, 2.01);
    await submit();
    assert.deepEqual(u.options.series[1].paths(nav, 1, 0, 10).stroke.points, before);
  } finally {
    globalThis.Path2D = savedPath;
    globalThis.OffscreenCanvas = savedCanvas;
    chart.handleMonitorHidden();
  }
});

test('ordered fill and fallback stroke share true points and missing-value breaks', async () => {
  const savedPath = globalThis.Path2D,
    savedCanvas = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = undefined;
  globalThis.Path2D = class {
    points = [];
    moveTo(x, y) {
      this.points.push(['M', x, y]);
    }
    lineTo(x, y) {
      this.points.push(['L', x, y]);
    }
    closePath() {
      this.points.push(['Z']);
    }
  };
  try {
    seed(false, 5000);
    const cs = state.chartSeries;
    cs.x.set(Float64Array.from({ length: 5000 }, (_, i) => i / 1000));
    cs.voltage.set(Float64Array.from({ length: 5000 }, (_, i) => (i >= 2000 && i < 3000 ? NaN : 1 + i / 1000)));
    chart.syncChartSeries();
    await submit();
    const u = state.mainChart;
    u.series = u.options.series.map((s) => ({ ...s, alpha: 1, fillTo: () => 0 }));
    u.valToPos = (v) => v;
    u.bbox = { left: 0, top: 0, width: 600, height: 20 };
    const polygons = [],
      order = [];
    let points = [],
      stroke;
    u.ctx = {
      save() {},
      restore() {},
      rect() {},
      clip() {},
      closePath() {},
      beginPath() {
        points = [];
      },
      moveTo(x, y) {
        points.push([x, y]);
      },
      lineTo(x, y) {
        points.push([x, y]);
      },
      fill(path) {
        for (const [op, x, y] of path.points) {
          if (op === 'M') points = [[x, y]];
          if (op === 'L') points.push([x, y]);
          if (op === 'Z') polygons.push(points);
        }
        order.push('fill');
      },
      stroke(path) {
        stroke = path;
        order.push('stroke');
      },
    };
    const paths = u.options.series[1].paths(u, 1, 0, u.data[0].length - 1);
    assert.equal(paths.stroke.points.length, 0, 'fallback postpones stroke until after fill');
    u.hooks.drawSeries[0](u, 1);
    u.hooks.drawSeries[1](u, 1);
    assert.ok(stroke.points.filter((p) => p[0] === 'M').length >= 2, 'stroke breaks at missing interval');
    assert.equal(order.at(-1), 'stroke');
    assert.ok(order.slice(0, -1).every((p) => p === 'fill'));
    assert.equal(order.filter((op) => op === 'fill').length, 1, 'one alpha composition for the channel');
    assert.equal(polygons.length, 2, 'each finite run is a separate closed subpath');
    for (const p of polygons)
      assert.ok(p.every(([x]) => x < 2) || p.every(([x]) => x >= 3), 'fill cannot bridge missing samples');
    const area = polygons.reduce(
      (n, p) =>
        n +
        Math.abs(
          p.reduce((a, [x, y], i) => {
            const [nx, ny] = p[(i + 1) % p.length];
            return a + x * ny - nx * y;
          }, 0),
        ) /
          2,
      0,
    );
    const expected = ((1 + 2.999) * 1.999) / 2 + ((4 + 5.999) * 1.999) / 2;
    assert.ok(Math.abs(area - expected) < 1e-8, 'linear ramp area is preserved');
  } finally {
    globalThis.Path2D = savedPath;
    globalThis.OffscreenCanvas = savedCanvas;
    chart.handleMonitorHidden();
  }
});

test('changing a review window retires its queued confirmation and sparse feedback', async () => {
  seed(false);
  await submit();
  await paintFeedback(40);
  chart.setChartXWindow(1.2, 1.21);
  await frame(16);
  assert.equal(state.mainChart.data[0].length, 13);
  await frame(120);
  assert.equal(frames.size, 0);
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.pixelsPerBucket, 1);
  assert.equal(last.fillSuppressed, false);
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  chart.setChartXWindow(2, 4.999);
  await submit();
  await paintFeedback(40);
  assert.equal(
    performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket,
    1,
    'an unrelated window cannot inherit the first slow sample',
  );
  await frame(16);
  await paintFeedback();
});

test('backgrounding and replacing the source retire queued review probes', async () => {
  seed(false);
  await submit();
  await paintFeedback(40);
  document.hidden = true;
  listeners.get('visibilitychange')();
  await frame(200);
  assert.equal(state.mainChart.submissions, 1);
  document.hidden = false;
  listeners.get('visibilitychange')();
  await frame(16);
  await frame(16);
  await submit();
  await paintFeedback(40);
  seed(false);
  await submit();
  await paintFeedback();
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 1);
  assert.equal(state.mainChart.submissions, 1);
  assert.equal(frames.size, 0);
});

test('live fill protection catches a severe raster stall after a cheap first callback', async () => {
  seed(true);
  await submit();
  await paintFeedback(120, true);
  await submit();
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.fillSuppressed, true);
  assert.equal(last.fillSuppressionReason, 'severe-frame');
  assert.equal(last.pixelsPerBucket, 8);
  await paintFeedback();
});

test('static review catches delayed raster frames after a cheap first callback', async () => {
  seed(false);
  await submit();
  const before = state.mainChart.data[0].length;
  await paintFeedback(40, true);
  const first = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(first.nextFrameDelayMs, 16);
  assert.equal(first.frameDelayMs, 40);
  assert.equal(state.mainChart.submissions, 1);
  await frame(16);
  await paintFeedback(40, true);
  await frame(16);
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 1);
  assert.equal(state.mainChart.data[0].length, before);
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.fillSuppressed, true);
  await paintFeedback();
  assert.equal(frames.size, 0);
});

async function prepared() {
  for (let i = 0; attrs.get('aria-busy') === 'true'; i++) {
    assert.ok(i < 1000, 'cooperative preparation must finish');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await Promise.resolve();
}

function append(count, interval = 1) {
  const cols = state.chartSeries;
  const start = cols.x.length;
  for (let i = start; i < start + count; i++)
    for (const [key, col] of Object.entries(cols))
      col.push(
        key === 'x' ? (i * interval) / 1000 : key === 'sampleIntervals' ? interval : key === 'voltage' ? i % 2 : 1,
      );
  const end = cols.x.at(-1);
  chart.setChartXWindow(state.chartWindow.mode === 'follow' ? end - state.chartWindow.duration : 0, end);
}

test('display-dense windows below four points per pixel retain fill, even after slow frames', async () => {
  for (const recording of [true, false]) {
    for (const count of [601, 1200, 2399]) {
      seed(recording, count);
      await submit();
      await frame(120);
      await frame(16);
      await submit();
      const last = performanceDiagnostics.snapshot().charts.main.last;
      assert.equal(last.displayDense, true);
      assert.equal(last.fillSuppressed, false);
      assert.equal(last.fillSuppressionReason, null);
      assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
    }
  }
});

test('four points per pixel is eligibility, not an automatic fill cutoff', async () => {
  for (const recording of [true, false]) {
    seed(recording, 2400);
    await submit();
    await paintFeedback();
    assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
    assert.equal(performanceDiagnostics.snapshot().charts.main.last.fillSuppressed, false);
  }
});

test('complex bucket review retains measured fill protection below four points per pixel', async () => {
  seed(false, 5000);
  const u = state.mainChart;
  // This alternating window cannot use the bounded raw renderer. Crossing the
  // density threshold must not restore its expensive fill on every gesture.
  u.bbox = { width: 600, height: 300 };
  u.series = u.options.series.map((s, i) => ({ ...s, show: i === 1 }));
  // This fixture measures feedback policy. The Canvas fixtures below cover
  // rendering; this uPlot substitute has no coordinate or drawing context.
  for (const s of u.options.series) delete s.paths;
  u.hooks.drawSeries = [];
  await submit();
  await frame(120);
  await frame(16);
  chart.setRangeDragging(true);
  chart.setChartXWindow(0, 2.398);
  await submit();
  try {
    const last = performanceDiagnostics.snapshot().charts.main.last;
    assert.equal(last.sourcePointCount, 2399);
    assert.equal(last.fillSuppressed, true);
    assert.equal(state.mainChart.options.series[1].fill(), null);
  } finally {
    chart.setRangeDragging(false);
  }
});

test('ordinary and highly retraced fills choose one composition without changing channel order', async () => {
  const savedPath = globalThis.Path2D,
    savedCanvas = globalThis.OffscreenCanvas;
  const operations = [];
  globalThis.Path2D = class {
    moveTo() {}
    lineTo() {}
    closePath() {}
  };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      Object.assign(this, { width, height });
    }
    getContext() {
      return {
        createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        clearRect() {},
        putImageData() {},
        save() {},
        restore() {},
        translate() {},
        fill() {
          operations.push('scratch-fill');
        },
      };
    }
  };
  try {
    for (const retraced of [false, true, 'both']) {
      seed(false, 5000);
      state.chartSeries.voltage.set(Float64Array.from({ length: 5000 }, (_, i) => (retraced ? i % 2 : i / 4999)));
      if (retraced === 'both') state.chartSeries.current.set(Float64Array.from({ length: 5000 }, (_, i) => i % 2));
      chart.syncChartSeries();
      const u = state.mainChart;
      u.series = u.options.series.map((s, i) => ({ ...s, show: i === 1 || i === 2, alpha: 1, fillTo: () => 0 }));
      u.bbox = { left: 0, top: 0, width: 600, height: 300 };
      u.scales = { x: { min: 0, max: 5 }, voltage: { min: 0, max: 1 }, current: { min: 0, max: 2 } };
      u.valToPos = (value, scale) => (scale === 'x' ? value * 120 : (1 - value) * 300);
      u.ctx = {
        save() {},
        restore() {},
        beginPath() {},
        rect() {},
        clip() {},
        transform() {},
        fill() {
          operations.push('main-fill');
        },
        drawImage() {
          operations.push('bitmap');
        },
      };
      operations.length = 0;
      await submit();
      assert.deepEqual(
        operations,
        retraced === 'both' ? ['bitmap'] : [...(retraced ? [] : ['main-fill']), 'bitmap', 'main-fill', 'bitmap'],
      );
      assert.equal(state.mainChart.__chartProjection.quality, 'fine');
    }
  } finally {
    globalThis.Path2D = savedPath;
    globalThis.OffscreenCanvas = savedCanvas;
    chart.handleMonitorHidden();
  }
});

test('three-hour 100Hz history and healthy small live batches keep fill and exact samples', async () => {
  seed(true, 1_080_000, 10);
  await submit();
  await prepared();
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.recentAppendCount, 0);
  for (let i = 0; i < 20; i++) {
    await paintFeedback();
    append(10, 10);
    await submit();
    assert.equal(performanceDiagnostics.snapshot().charts.main.last.recentAppendCount, 10);
    assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  }
  assert.equal(state.chartSeries.x.length, 1_080_200);
  assert.equal(state.chartSeries.x.valueAt(100_003), 1000.03);
  assert.equal(state.chartSeries.voltage.valueAt(100_003), 1);
});

test('large 1000Hz batches need real pressure; continued pressure after reduction suppresses fill', async () => {
  seed(true);
  await submit();
  await frame(16);
  append(2500);
  await submit();
  let last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.recentAppendCount, 2500);
  assert.equal(last.fillSuppressed, false, 'large appends alone cannot turn fill off');
  for (let i = 0; i < 2; i++) {
    await paintFeedback(40);
    append(2500);
    await submit();
  }
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 4);
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.fillSuppressed, false);
  for (let i = 0; i < 2; i++) {
    await paintFeedback(40);
    append(2500);
    await submit();
  }
  last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.fillSuppressed, true);
  assert.equal(last.fillSuppressionReason, 'large-batch-slow-frame');
  assert.equal(last.recentAppendCount, 2500);
  assert.equal(state.chartSeries.x.length, 17500);
});

test('suppression is retired by sparse windows, user fill zero, hidden pages and source replacement', async () => {
  for (const transition of ['sparse', 'user', 'hidden', 'source']) {
    seed(false);
    await submit();
    await frame(120);
    await frame(16);
    assert.equal(state.mainChart.options.series[1].fill(), null);
    if (transition === 'sparse') chart.setChartXWindow(1, 1.01);
    else if (transition === 'user') {
      for (let i = 0; i < 4; i++) chart.setSeriesFill(i, 0);
    } else if (transition === 'hidden') {
      document.hidden = true;
      listeners.get('visibilitychange')();
      await frame(200);
      document.hidden = false;
      listeners.get('visibilitychange')();
    } else seed(false);
    await submit();
    const last = performanceDiagnostics.snapshot().charts.main.last;
    assert.equal(last.fillSuppressed, false, transition);
    assert.equal(last.fillSuppressionReason, null, transition);
    if (transition === 'user') {
      assert.equal(state.mainChart.options.series[1].fill(), null);
      chart.setSeriesFill(0, 15);
    } else assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  }
});

test('stable live paints restore fill with a real submission, without a tight recovery loop', async () => {
  seed(true);
  await submit();
  await frame(120);
  await submit();
  assert.equal(state.mainChart.options.series[1].fill(), null);
  for (let i = 0; i < 55; i++) {
    await paintFeedback();
    time += 52;
    append(10);
    await submit();
  }
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.fillSuppressed, false);
  assert.equal(last.fillSuppressionReason, null);
  assert.equal(last.recentAppendCount, 10);
});

test('dense live window changes retain protection, while sparse windows restore fill', async () => {
  seed(true);
  state.chartWindow = { mode: 'follow', min: 0, max: 4.999, duration: 4.999 };
  await submit();
  await paintFeedback(40);
  append(100);
  await submit();
  await paintFeedback(40);
  await submit();
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 4);
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  for (let i = 0; i < 2; i++) {
    await paintFeedback(40);
    append(100);
    await submit();
  }
  assert.equal(state.mainChart.options.series[1].fill(), null);
  state.chartWindow = { mode: 'follow', min: 2, max: 5.299, duration: 3.299 };
  chart.setChartXWindow(2, 5.299);
  await submit();
  assert.equal(state.mainChart.options.series[1].fill(), null);
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.fillSuppressed, true);
  chart.setChartXWindow(2, 2.1);
  await submit();
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.fillSuppressed, false);
});

test('history preparation before draw does not falsely degrade detail or suppress fill', async () => {
  seed(true);
  performanceDiagnostics.reset();
  performanceDiagnostics.start();
  for (let i = 0; i < 32; i++) await frame(8);
  time += 200; // Import/column preparation in the same task, before submitting Canvas work.
  await submit();
  await frame(8);
  await submit();
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.pixelsPerBucket, 2, 'preparation is not evidence of expensive Canvas work');
  assert.equal(last.fillSuppressed, false, 'fill must observe its own draw rather than pre-paint work');
  assert.equal(typeof state.mainChart.options.series[1].fill(), 'string');
  assert.equal(performanceDiagnostics.frameDelaySince(time - 9, true, true) <= 9, true);
});

test('moving a dense window every frame retains feedback across the same gesture', async () => {
  for (const recording of [true, false]) {
    seed(recording);
    chart.setRangeDragging(true);
    await submit();
    for (let i = 0; i < 8; i++) {
      chart.setChartXWindow(0.1 + i * 0.01, 4.8 + i * 0.01);
      chart.scheduleChartUpdate('interaction');
      await frame(i < 6 ? 40 : 16);
    }
    chart.setRangeDragging(false);
    chart.updateCharts('interaction');
    await Promise.resolve();
    const last = performanceDiagnostics.snapshot().charts.main.last;
    assert.equal(last.pixelsPerBucket, 1, 'slow gestures must retain screen-resolution detail');
    assert.equal(last.fillSuppressed, true, 'gesture pressure feedback remains effective for fill');
    assert.equal(last.refreshIntervalMs, 0);
    assert.equal(last.refreshSource, 'interaction');
    assert.equal(state.chartSeries.x.length, 5000);
    await paintFeedback();
  }
});

test('filled gestures merge the latest window until delayed raster feedback, then release immediately', async () => {
  seed(false);
  chart.setRangeDragging(true);
  await submit();
  const u = state.mainChart;
  for (const min of [0.1, 0.2]) {
    chart.setChartXWindow(min, 4.9 - min);
    chart.scheduleChartUpdate('interaction');
    await frame(16);
    assert.equal(u.submissions, 1, 'the first cheap callback cannot queue another costly filled path');
  }
  chart.setChartXWindow(0.3, 4.6);
  chart.scheduleChartUpdate('interaction');
  await frame(120);
  await frame(16);
  assert.equal(u.submissions, 2, 'confirmed pressure unblocks the latest target');
  const last = performanceDiagnostics.snapshot().charts.main.last;
  assert.equal(last.sourcePointCount, 4301);
  assert.equal(last.pixelsPerBucket, 1);
  assert.equal(last.fillSuppressed, true);
  const before = u.data.map((col) => col.slice());
  chart.setRangeDragging(false);
  chart.updateCharts('interaction');
  await Promise.resolve();
  assert.equal(u.submissions, 3, 'release bypasses the feedback wait');
  assert.deepEqual(u.data, before);
  await paintFeedback();
});

test('confirmed healthy fill keeps updating through every subsequent gesture frame', async () => {
  seed(false);
  chart.setRangeDragging(true);
  await submit();
  await paintFeedback();
  const u = state.mainChart;
  const before = u.submissions;
  for (let i = 0; i < 8; i++) {
    chart.setChartXWindow(0.1 + i * 0.01, 4.8 + i * 0.01);
    chart.scheduleChartUpdate('interaction');
    await frame(16);
    assert.equal(u.submissions, before + i + 1, 'healthy fill does not retain the initial feedback wait');
  }
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 1);
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.fillSuppressed, false);
  chart.setRangeDragging(false);
  await paintFeedback();
});

test('recording and review budgets are independent and release preserves the gesture budget', async () => {
  seed(true);
  await submit();
  await frame(120);
  await submit();
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 8);
  chart.setRangeDragging(true);
  chart.setChartXWindow(0.1, 4.9);
  chart.updateCharts('interaction');
  await Promise.resolve();
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 1);
  const during = state.mainChart.data.map((col) => col.slice());
  chart.setRangeDragging(false);
  chart.updateCharts('interaction');
  await Promise.resolve();
  assert.deepEqual(state.mainChart.data, during);
  append(100);
  await submit();
  assert.equal(performanceDiagnostics.snapshot().charts.main.last.pixelsPerBucket, 8);
  await paintFeedback();
});

for (const source of ['interaction', 'maintenance'])
  test(`${source} supersedes a pending high-rate live timer and submits at the next frame`, async () => {
    seed(true);
    await submit();
    await paintFeedback();
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    let paced = false;
    let cancelled = false;
    globalThis.setTimeout = () => {
      paced = true;
      return 9999;
    };
    globalThis.clearTimeout = () => {
      cancelled = true;
    };
    try {
      time -= 40; // The next append is due before the 50ms live refresh interval.
      append(10);
      chart.scheduleChartUpdate('live');
      assert.equal(paced, true);
      chart.setChartXWindow(0.2, 4.5);
      chart.scheduleChartUpdate(source);
      await frame(16);
      assert.equal(cancelled, true);
      const last = performanceDiagnostics.snapshot().charts.main.last;
      assert.equal(last.refreshSource, source);
      assert.equal(last.refreshIntervalMs, 0);
    } finally {
      globalThis.setTimeout = previousSetTimeout;
      globalThis.clearTimeout = previousClearTimeout;
      await paintFeedback();
    }
  });

test('render diagnostics remain bounded while reporting next-frame delay', () => {
  performanceDiagnostics.reset();
  for (let i = 0; i < 600; i++) {
    const request = performanceDiagnostics.chartRequest('main', { sourcePointCount: 100000, displayPointCount: 400 });
    const entry = performanceDiagnostics.chartPaint('main', request, time, 0.4);
    performanceDiagnostics.chartNextFrame(entry, 11);
  }
  const metrics = performanceDiagnostics.snapshot().charts.main;
  assert.equal(metrics.count, 512);
  assert.equal(metrics.nextFrameDelay.p95Ms, 11);
  assert.equal(metrics.last.displayPointCount, 400);
});

test('delayed idle candidates cannot normalize raster lag into the refresh baseline', async () => {
  performanceDiagnostics.reset();
  performanceDiagnostics.start();
  for (let i = 0; i < 24; i++) await frame(8);
  assert.equal(performanceDiagnostics.idleFrameIntervalMs(), 8);
  for (let i = 0; i < 8; i++) await frame(48);
  assert.equal(performanceDiagnostics.idleFrameIntervalMs(), 8);
  assert.equal(performanceDiagnostics.frameDelaySince(time - 50), 48);
  assert.equal(performanceDiagnostics.frameDelaySince(time + 1), 0);
});

test('ordered paint caches coordinates and fills while scale, size, source and baseline changes invalidate them', async () => {
  const savedPath = globalThis.Path2D,
    savedCanvas = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = undefined;
  globalThis.Path2D = class {
    points = [];
    moveTo(x, y) {
      this.points.push(['M', x, y]);
    }
    lineTo(x, y) {
      this.points.push(['L', x, y]);
    }
    closePath() {
      this.points.push(['Z']);
    }
  };
  try {
    seed(false, 5000);
    const cs = state.chartSeries;
    cs.x.set(Float64Array.from({ length: 5000 }, (_, i) => Math.floor(i / 2) / 1000));
    cs.voltage.set(Float64Array.from({ length: 5000 }, (_, i) => (i >= 2000 && i < 3000 ? NaN : i % 2 ? -2 : 2)));
    chart.syncChartSeries();
    chart.setChartXWindow(0, 2.499);
    await submit();
    const u = state.mainChart;
    u.series = u.options.series.map((s) => ({ ...s, alpha: 0.7, fillTo: () => baseline }));
    u.bbox = { left: 0, top: 0, width: 600, height: 20 };
    u.scales = { x: { min: 0, max: 2.5 }, voltage: { min: -2, max: 2 } };
    let projections = 0,
      baseline = 0;
    u.valToPos = (v) => {
      projections++;
      return v;
    };
    const fills = [],
      order = [];
    u.ctx = {
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      fill(path) {
        fills.push(path);
        order.push('fill');
        assert.equal(this.globalAlpha, 0.7);
      },
      stroke() {
        order.push('stroke');
      },
    };
    const paint = () => {
      u.options.series[1].paths(u, 1, 0, u.data[0].length - 1);
      for (const hook of u.hooks.drawSeries) hook(u, 1);
    };
    paint();
    const first = fills.at(-1),
      reads = projections;
    assert.equal(first.points.filter((p) => p[0] === 'M').length, 2, 'NaN creates independent areas');
    assert.ok(
      first.points.some((p) => p[2] === -2),
      'negative values retain their sign',
    );
    assert.ok(
      first.points.some(
        (p, i, a) => p[0] === 'L' && a[i - 1][0] === 'L' && p[1] === a[i - 1][1] && p[2] !== a[i - 1][2],
      ),
      'duplicate time retains vertical source order',
    );
    paint();
    assert.equal(fills.at(-1), first, 'same geometry reuses its fill');
    assert.equal(projections, reads + 1, 'only the baseline is queried on a cache hit');
    assert.deepEqual(order, ['fill', 'stroke', 'fill', 'stroke']);
    chart.setSeriesFill(0, 0);
    const strokes = order.filter((op) => op === 'stroke').length;
    const unfilled = u.options.series[1].paths(u, 1, 0, u.data[0].length - 1);
    assert.ok(unfilled.stroke.points.length > 0, 'uPlot receives the unfilled fallback stroke');
    for (const hook of u.hooks.drawSeries) hook(u, 1);
    assert.equal(
      order.filter((op) => op === 'stroke').length,
      strokes,
      'fallback does not double-stroke an unfilled channel',
    );
    chart.setSeriesFill(0, 0.12);
    for (const change of [
      () => u.scales.voltage.max++,
      () => u.bbox.width++,
      () => baseline++,
      () => {
        u.ctx.canvas = { width: u.width * 2 };
      },
    ]) {
      const prior = fills.at(-1);
      change();
      paint();
      assert.notEqual(fills.at(-1), prior);
    }
    const prior = fills.at(-1);
    cs.voltage.set(Float64Array.from({ length: 5000 }, () => 1));
    chart.syncChartSeries();
    await submit();
    paint();
    assert.notEqual(fills.at(-1), prior, 'source replacement retires the cache');
  } finally {
    globalThis.Path2D = savedPath;
    globalThis.OffscreenCanvas = savedCanvas;
    chart.handleMonitorHidden();
  }
});
