import assert from 'node:assert/strict';
import test from 'node:test';
import { SeriesBuckets } from '../src/chart-buckets.js';
import { ExactExtremaIndex } from '../src/chart-extrema.js';
import { runCooperativeSlices } from '../src/cooperative.js';

test('partially published extrema prefixes and partial stripes exactly match raw folding', () => {
  const n = 18017;
  const xs = Float64Array.from({ length: n }, (_, i) => Math.floor(i / 2));
  const ys = Array.from({ length: 8 }, (_, s) =>
    Float64Array.from(xs, (_, i) => (i % 41 === 0 ? NaN : s === 7 ? (i % 2 ? -0 : 0) : (i % 101) - 50)),
  );
  const index = new ExactExtremaIndex();
  for (let step = 0; step < 8; step++) {
    index.syncStep(ys, n, 7);
    const ref = new SeriesBuckets();
    ref.rebuild(xs, ys, 17, n - 13, 127);
    const actual = new SeriesBuckets();
    const advance = actual.beginRebuild(xs, ys, 17, n - 13, 127, index);
    while (!advance(19)) {}
    assert.deepStrictEqual(actual.list, ref.list);
    assert.deepStrictEqual(actual.flatten(), ref.flatten());
  }
});

test('cooperative work gives control back before its first step and stops on cancellation', async () => {
  let steps = 0,
    yields = 0;
  const done = await runCooperativeSlices(
    () => {
      steps++;
      return steps === 10;
    },
    {
      now: () => steps * 2,
      yieldTask: async () => {
        yields++;
      },
      isCancelled: () => yields === 3,
    },
  );
  assert.equal(done, false);
  assert.equal(steps, 2);
});

test('warm projection steps budget bucket queries rather than the raw samples they cover', () => {
  const count = 100003;
  const xs = Float64Array.from({ length: count }, (_, i) => Math.floor(i / 20) / 1000);
  const ys = Array.from({ length: 8 }, (_, s) => Float64Array.from(xs, (_, i) => (i % 113 ? i % 2 : s * 100)));
  const index = new ExactExtremaIndex();
  index.sync(ys, count);
  const reference = new SeriesBuckets();
  reference.rebuild(xs, ys, 13, count - 7, 127);
  const actual = new SeriesBuckets();
  const step = actual.beginRebuild(xs, ys, 13, count - 7, 127, index);
  let steps = 1;
  while (!step(Infinity, 8)) steps++;
  assert.equal(steps, Math.ceil(reference.list.length / 8));
  assert.deepEqual(actual.flatten(), reference.flatten());
});

test('large chart preparations publish a complete projection and discard replaced history', async () => {
  const attrs = new Map();
  const host = { clientWidth: 1200, setAttribute: (key, value) => attrs.set(key, value) };
  globalThis.document = { hidden: false, getElementById: () => host, querySelector: () => null, addEventListener() {} };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const { state, emptyChartColumns, setChartColumns } = await import('../src/state.js');
  const chart = await import('../src/chart.js');
  const columns = emptyChartColumns(300007);
  for (let i = 0; i < 300007; i++) {
    for (const [key, col] of Object.entries(columns))
      col.push(key === 'x' ? i : key === 'recordingSegments' ? 1 : i % 101);
  }
  state.settings.activeView = 'monitor';
  state.mainChart = {
    width: 1200,
    setData(data) {
      this.data = data;
    },
    setScale() {},
  };
  state.navigatorChart = null;
  setChartColumns(columns);
  chart.syncChartSeries();
  chart.setChartXWindow(0, columns.x.length - 1);
  chart.updateCharts();
  assert.equal(attrs.get('aria-busy'), 'true');
  assert.equal(state.mainChart.data, undefined, 'no partial raw fallback is published');
  while (attrs.get('aria-busy') === 'true') await new Promise((resolve) => setTimeout(resolve, 2));
  const expected = new SeriesBuckets();
  expected.rebuild(
    columns.x.view(),
    ['voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2'].map((key) => columns[key].view()),
    0,
    columns.x.length,
    1200,
  );
  const flat = expected.flatten();
  assert.deepStrictEqual(state.mainChart.data, [flat.x, ...flat.ys]);
  const originalBeginRebuild = SeriesBuckets.prototype.beginRebuild;
  let obsoleteSteps = 0;
  SeriesBuckets.prototype.beginRebuild = function (xs, series, start, end, ...args) {
    const step = originalBeginRebuild.call(this, xs, series, start, end, ...args);
    if (end !== 200001) return step;
    return (maxSamples) => {
      obsoleteSteps++;
      const complete = step(maxSamples);
      chart.setChartXWindow(0, 180000);
      return complete;
    };
  };
  try {
    chart.setChartXWindow(0, 200000);
    chart.updateCharts();
    while (attrs.get('aria-busy') === 'true') await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(obsoleteSteps, 1, 'shrinking the right edge cancels work even at the same density');
    const replacement = new SeriesBuckets();
    originalBeginRebuild.call(replacement, columns.x, [columns.voltage], 0, 180001, 1200)(Infinity);
    assert.deepStrictEqual(state.mainChart.data[0], replacement.flatten().x);
  } finally {
    SeriesBuckets.prototype.beginRebuild = originalBeginRebuild;
  }
  chart.setChartXWindow(0, columns.x.length - 1);
  const originalSyncStep = ExactExtremaIndex.prototype.syncStep;
  let indexSteps = 0;
  ExactExtremaIndex.prototype.syncStep = function (...args) {
    indexSteps++;
    return originalSyncStep.apply(this, args);
  };
  try {
    chart.syncChartSeries();
    chart.updateCharts();
    chart.setChartXWindow(columns.x.length - 8, columns.x.length - 1);
    chart.updateCharts();
    while (attrs.get('aria-busy') === 'true') await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(indexSteps, 0, 'a sparse replacement window cancels the obsolete cold index');
    assert.ok(state.mainChart.data[0].length <= 10, 'the replacement window publishes raw samples');
  } finally {
    ExactExtremaIndex.prototype.syncStep = originalSyncStep;
  }
  chart.setChartXWindow(0, columns.x.length - 1);
  chart.syncChartSeries();
  chart.updateCharts();
  setChartColumns(emptyChartColumns(1));
  chart.syncChartSeries();
  chart.updateCharts();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.mainChart.data[0].length, 0);
  assert.equal(attrs.get('aria-busy'), 'false');
});

test('changing the window during cold indexing retains the completed prefix for the latest query', async () => {
  let busy = false;
  const host = {
    clientWidth: 1200,
    setAttribute(_key, value) {
      busy = value === 'true';
    },
  };
  globalThis.document = { hidden: false, getElementById: () => host, querySelector: () => null, addEventListener() {} };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const { state, emptyChartColumns, setChartColumns } = await import('../src/state.js');
  const chart = await import('../src/chart.js');
  const columns = emptyChartColumns();
  for (const [key, col] of Object.entries(columns))
    col.set(Float64Array.from({ length: 100000 }, (_, i) => (key === 'x' ? i : i % 97)));
  state.settings.activeView = 'monitor';
  state.windowVisible = true;
  state.isRecording = false;
  state.mainChart = {
    width: 1200,
    setData(data) {
      this.data = data;
    },
    setScale() {},
  };
  state.navigatorChart = null;
  setChartColumns(columns);
  chart.syncChartSeries();
  const originalStep = ExactExtremaIndex.prototype.syncStep;
  const originalReset = ExactExtremaIndex.prototype.reset;
  let index = null;
  let resets = 0;
  let retired = false;
  ExactExtremaIndex.prototype.reset = function () {
    resets++;
    return originalReset.call(this);
  };
  ExactExtremaIndex.prototype.syncStep = function (...args) {
    index = this;
    const done = originalStep.apply(this, args);
    if (!retired && this.blocks >= 128) {
      retired = true;
      chart.setChartXWindow(0, 7999);
    }
    return done;
  };
  try {
    chart.setChartXWindow(0, 99999);
    chart.updateCharts();
    while (busy) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(retired, true);
    assert.equal(index.blocks, 128, 'cancellation keeps already completed leaves');
    assert.equal(resets, 0);
    const expected = new SeriesBuckets();
    expected.rebuild(
      columns.x,
      [columns.voltage, columns.current, columns.power, columns.temp, columns.dp, columns.dn, columns.cc1, columns.cc2],
      0,
      8000,
      1200,
    );
    const flat = expected.flatten();
    assert.deepEqual(state.mainChart.data, [flat.x, ...flat.ys], 'only the latest complete projection is published');
    chart.setChartXWindow(0, 99999);
    chart.updateCharts();
    while (busy) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(index.blocks, Math.floor(100000 / 32));
    assert.equal(resets, 0, 'returning to the wider window extends the retained prefix');
  } finally {
    ExactExtremaIndex.prototype.syncStep = originalStep;
    ExactExtremaIndex.prototype.reset = originalReset;
    chart.handleMonitorHidden();
  }
});

test('a dense follow window submits complete matching snapshots while samples advance between every slice', async () => {
  let busy = false;
  const host = {
    clientWidth: 1200,
    setAttribute(_key, value) {
      busy = value === 'true';
    },
  };
  globalThis.document = { hidden: false, getElementById: () => host, querySelector: () => null, addEventListener() {} };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const { state, emptyChartColumns, setChartColumns } = await import('../src/state.js');
  const chart = await import('../src/chart.js');
  const columns = emptyChartColumns();
  const append = (count) => {
    const start = columns.x.length;
    for (let i = start; i < start + count; i++)
      for (const [key, col] of Object.entries(columns))
        col.push(key === 'x' ? i : key === 'recordingSegments' ? 1 : key === 'sampleIntervals' ? 1000 : i % 101);
  };
  append(300000);
  let submissions = 0;
  let submitted = null;
  let scale = null;
  state.settings.activeView = 'monitor';
  state.mainChart = {
    width: 1200,
    setData(data) {
      submissions++;
      submitted = data;
    },
    setScale(_key, value) {
      scale = value;
    },
  };
  state.navigatorChart = null;
  state.isRecording = false;
  state.chartWindow = { mode: 'full', duration: 0, min: 0, max: 299999 };
  setChartColumns(columns);
  chart.syncChartSeries();
  chart.setChartXWindow(0, 299999);
  chart.updateCharts();
  while (busy) await new Promise((resolve) => setTimeout(resolve, 1));
  submissions = 0;
  state.isRecording = true;
  state.chartWindow = { mode: 'follow', duration: 199999, min: 100000, max: 299999 };
  chart.setChartXWindow(100000, 299999);
  const previousScheduler = globalThis.scheduler;
  const previousPerformance = globalThis.performance;
  const previousRebuild = SeriesBuckets.prototype.beginRebuild;
  let simulatedWorkMs = 0;
  globalThis.performance = { now: () => previousPerformance.now() + simulatedWorkMs };
  SeriesBuckets.prototype.beginRebuild = function (...args) {
    const step = previousRebuild.apply(this, args);
    return (...budget) => {
      const done = step(...budget);
      simulatedWorkMs += 5; // Deterministically exercise the bounded warm continuation.
      return done;
    };
  };
  let advances = 0;
  globalThis.scheduler = {
    postTask: async (callback) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (advances < 200) {
        append(500);
        advances++;
        const max = columns.x.at(-1);
        state.chartWindow = { mode: 'follow', duration: 199999, min: max - 199999, max };
        chart.setChartXWindow(max - 199999, max);
      }
      return callback();
    },
  };
  try {
    chart.updateCharts();
    for (let turn = 0; turn < 1000 && !submissions; turn++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(submissions > 0, 'continuous arrival must not starve the main chart');
    assert.ok(advances > 0 && advances < 200, 'a snapshot finishes while the window is still advancing');
    assert.deepEqual(scale, { min: 100000, max: 299999 }, 'submitted buckets retain their captured X range');
    const expected = new SeriesBuckets();
    expected.rebuild(
      columns.x,
      [columns.voltage, columns.current, columns.power, columns.temp, columns.dp, columns.dn, columns.cc1, columns.cc2],
      100000,
      300000,
      600,
    );
    const flat = expected.flatten();
    assert.deepEqual(submitted, [flat.x, ...flat.ys]);
  } finally {
    globalThis.scheduler = previousScheduler;
    globalThis.performance = previousPerformance;
    SeriesBuckets.prototype.beginRebuild = previousRebuild;
    state.isRecording = false;
    chart.handleMonitorHidden();
  }
});

test('recording warms fixed prefixes between paints and cancels background indexing before source replacement', async () => {
  let busy = false;
  const host = { clientWidth: 1200, setAttribute: (_key, value) => (busy = value === 'true') };
  globalThis.document = { hidden: false, getElementById: () => host, querySelector: () => null, addEventListener() {} };
  const { state, emptyChartColumns, setChartColumns } = await import('../src/state.js');
  const chart = await import('../src/chart.js');
  const columns = emptyChartColumns();
  const append = (count) => {
    const start = columns.x.length;
    for (let i = start; i < start + count; i++)
      for (const [key, col] of Object.entries(columns)) col.push(key === 'x' ? i : i % 97);
  };
  append(40000);
  state.settings.activeView = 'monitor';
  state.windowVisible = true;
  state.isRecording = false;
  state.chartWindow = { mode: 'frozen', duration: 999, min: 0, max: 999 };
  state.mainChart = { width: 1200, setData() {}, setScale() {} };
  state.navigatorChart = null;
  setChartColumns(columns);
  chart.syncChartSeries();
  chart.setChartXWindow(0, 999);
  chart.updateCharts();
  while (busy) await new Promise((resolve) => setTimeout(resolve, 1));
  const scheduler = globalThis.scheduler;
  const originalStep = ExactExtremaIndex.prototype.syncStep;
  const tasks = [];
  let index;
  let steps = 0;
  let replace = false;
  globalThis.scheduler = { postTask: (callback) => new Promise((resolve) => tasks.push(() => resolve(callback()))) };
  ExactExtremaIndex.prototype.syncStep = function (...args) {
    index = this;
    steps++;
    assert.equal(args[2], 32, 'background steps have a fixed sample budget');
    const complete = originalStep.apply(this, args);
    if (replace) {
      setChartColumns(emptyChartColumns());
      chart.syncChartSeries();
    } else if (steps === 1) append(64);
    return complete;
  };
  const drain = async () => {
    for (let turn = 0; tasks.length && turn < 1000; turn++) {
      tasks.shift()();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(tasks.length, 0);
  };
  try {
    state.isRecording = true;
    chart.updateCharts('live');
    assert.equal(steps, 0, 'recording paint never starts the background scan synchronously');
    await drain();
    assert.equal(index.blocks, Math.floor(columns.x.length / 32), 'a new job catches appends after its fixed prefix');
    state.isRecording = false;
    chart.syncChartSeries();
    chart.updateCharts();
    while (busy) await drain();
    state.isRecording = true;
    const previousSteps = steps;
    chart.updateCharts('live');
    chart.setRangeDragging(true);
    await drain();
    assert.equal(steps, previousSteps, 'gestures cancel pending warmup');
    chart.setRangeDragging(false);
    replace = true;
    chart.updateCharts('live');
    await drain();
    assert.equal(index.blocks, 0, 'cancelled work cannot repopulate the replacement index');
  } finally {
    chart.setRangeDragging(false);
    state.isRecording = false;
    chart.handleMonitorHidden();
    globalThis.scheduler = scheduler;
    ExactExtremaIndex.prototype.syncStep = originalStep;
  }
});

test('a minimized native window cancels preparation even when document.hidden remains false', async () => {
  let busy = false;
  const host = {
    clientWidth: 600,
    setAttribute(_key, value) {
      busy = value === 'true';
    },
  };
  globalThis.document = { hidden: false, getElementById: () => host, querySelector: () => null, addEventListener() {} };
  const { state, emptyChartColumns, setChartColumns } = await import('../src/state.js');
  const chart = await import('../src/chart.js');
  const columns = emptyChartColumns();
  for (const [key, col] of Object.entries(columns))
    col.set(Float64Array.from({ length: 1000000 }, (_, i) => (key === 'x' ? i : 1)));
  state.settings.activeView = 'monitor';
  state.chartWindow = { mode: 'full', duration: 0, min: 0, max: 999999 };
  setChartColumns(columns);
  chart.syncChartSeries();
  chart.setChartXWindow(0, 999999);
  const previousScheduler = globalThis.scheduler;
  let yields = 0;
  let steps = 0;
  const original = ExactExtremaIndex.prototype.syncStep;
  ExactExtremaIndex.prototype.syncStep = function (...args) {
    steps++;
    return original.apply(this, args);
  };
  globalThis.scheduler = {
    postTask: async (callback) => {
      if (++yields === 2) {
        state.windowVisible = false;
        chart.handleMonitorHidden();
      }
      return callback();
    },
  };
  try {
    chart.updateCharts();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(steps, 0);
    assert.equal(busy, false);
    assert.equal(document.hidden, false, 'WebView2 may report the document visible while minimized');
    state.windowVisible = true;
    globalThis.scheduler = previousScheduler;
    chart.updateCharts();
    while (busy) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(steps > 0, 'showing the monitor resumes preparation');
  } finally {
    globalThis.scheduler = previousScheduler;
    ExactExtremaIndex.prototype.syncStep = original;
    chart.handleMonitorHidden();
    state.windowVisible = true;
  }
});
test('cold pause publishes a complete coarse projection, accepts a bounded tail and upgrades exactly once', async () => {
  let busy = false;
  const host = {
    clientWidth: 600,
    setAttribute(_key, value) {
      busy = value === 'true';
    },
  };
  globalThis.document = { hidden: false, getElementById: () => host, querySelector: () => null, addEventListener() {} };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const { state, emptyChartColumns } = await import('../src/state.js');
  const chart = await import('../src/chart.js');
  const cs = emptyChartColumns();
  for (const [key, col] of Object.entries(cs))
    col.set(Float64Array.from({ length: 100003 }, (_, i) => (key === 'x' ? i / 1000 : i % 97)));
  state.chartSeries = cs;
  state.windowVisible = true;
  state.settings.activeView = 'monitor';
  state.isRecording = true;
  state.chartWindow = { mode: 'full', min: 0, max: 100.002, duration: 100.002 };
  state.navigatorChart = null;
  state.mainChart = {
    width: 600,
    submissions: 0,
    setData(data) {
      this.submissions++;
      this.data = data;
      queueMicrotask(() => {
        for (const hook of this.hooks?.draw ?? []) hook(this);
      });
    },
    setScale() {},
  };
  const original = ExactExtremaIndex.prototype.syncStep,
    scheduler = globalThis.scheduler;
  let index = null,
    steps = 0;
  ExactExtremaIndex.prototype.syncStep = function (...args) {
    index = this;
    steps++;
    return original.apply(this, args);
  };
  const tasks = [];
  const drain = async () => {
    for (let i = 0; i < 500; i++) {
      if (tasks.length) tasks.shift()();
      await new Promise((r) => setTimeout(r, 1));
      if (!busy && tasks.length === 0) return;
    }
    assert.fail('background work did not settle');
  };
  try {
    chart.syncChartSeries();
    chart.setChartXWindow(0, 100.002);
    chart.updateCharts('live');
    while (busy) await new Promise((r) => setTimeout(r, 2));
    state.isRecording = false;
    chart.updateCharts('maintenance', { force: false, reason: 'pause' });
    await Promise.resolve();
    assert.equal(
      state.mainChart.__chartProjection.quality,
      'fine',
      'a warm pause never substitutes a coarse first frame',
    );
    const { performanceDiagnostics } = await import('../src/performance-diagnostics.js');
    const warm = performanceDiagnostics.snapshot().charts.main.last;
    assert.equal(warm.pauseLength, 100003);
    assert.equal(warm.reason, 'pause');
    assert.ok(warm.pauseId > 0);
    assert.ok(warm.pauseToDrawMs >= 0);
    state.isRecording = true;
    chart.updateCharts('live');
    chart.setRangeDragging(true);
    chart.setRangeDragging(false);
    globalThis.scheduler = { postTask: () => new Promise((resolve) => tasks.push(resolve)) };
    index.reset();
    steps = 0;
    state.isRecording = false;
    const before = state.mainChart.submissions;
    chart.updateCharts();
    assert.equal(steps, 0, 'first complete frame cannot scan historical index blocks');
    assert.equal(state.mainChart.__chartProjection.quality, 'coarse');
    assert.equal(state.mainChart.submissions, before + 1);
    assert.equal(state.mainChart.data[0][0], 0);
    assert.equal(state.mainChart.data[0].at(-1), 100.002);
    assert.equal(tasks.length, 0, 'refinement waits for the actual coarse draw');
    for (let i = 100003; i < 100010; i++)
      for (const [key, col] of Object.entries(cs)) col.push(key === 'x' ? i / 1000 : i % 97);
    chart.setChartXWindow(0, 100.009);
    chart.updateCharts();
    assert.equal(state.mainChart.data[0].at(-1), 100.009, 'retained pause tail reaches the coarse frame');
    assert.equal(steps, 0);
    const coarseSubmissions = state.mainChart.submissions;
    await drain();
    assert.equal(state.mainChart.__chartProjection.quality, 'fine');
    const refined = performanceDiagnostics.snapshot().charts.main.last;
    assert.ok(refined.prepareMs > 0, 'refinement accounts for its cooperative preparation CPU time');
    assert.equal(state.mainChart.submissions, coarseSubmissions + 1, 'one atomic detail upgrade');
    const fine = state.mainChart.data.map((col) => Array.from(col));
    chart.setRangeDragging(true);
    chart.updateCharts();
    chart.setRangeDragging(false);
    chart.updateCharts();
    assert.deepEqual(
      state.mainChart.data.map((col) => Array.from(col)),
      fine,
      'release does not change a stable window',
    );
    for (const cancel of ['window', 'resume', 'hidden', 'source']) {
      state.isRecording = true;
      chart.updateCharts('live');
      while (busy) await drain();
      chart.setRangeDragging(true);
      chart.setRangeDragging(false);
      index.reset();
      state.isRecording = false;
      chart.updateCharts();
      assert.equal(state.mainChart.__chartProjection.quality, 'coarse');
      if (cancel === 'window') {
        chart.setChartXWindow(20, 20.01);
        chart.updateCharts();
      }
      if (cancel === 'resume') {
        state.isRecording = true;
        chart.updateCharts('live');
      }
      if (cancel === 'hidden') {
        state.windowVisible = false;
        chart.handleMonitorHidden();
      }
      if (cancel === 'source') {
        state.chartSeries = emptyChartColumns();
        chart.syncChartSeries();
        chart.updateCharts();
      }
      const submitted = state.mainChart.submissions;
      await drain();
      assert.equal(state.mainChart.submissions, submitted, `${cancel} retires obsolete refinement`);
      state.windowVisible = true;
      state.isRecording = true;
      state.chartSeries = cs;
      chart.syncChartSeries();
      chart.setChartXWindow(0, 100.009);
      globalThis.scheduler = scheduler;
      chart.updateCharts('live');
      while (busy) await new Promise((r) => setTimeout(r, 2));
      globalThis.scheduler = { postTask: () => new Promise((resolve) => tasks.push(resolve)) };
    }
  } finally {
    globalThis.scheduler = scheduler;
    ExactExtremaIndex.prototype.syncStep = original;
    chart.handleMonitorHidden();
    state.isRecording = false;
    state.windowVisible = true;
  }
});
