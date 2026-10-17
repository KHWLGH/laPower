import assert from 'node:assert/strict';
import test from 'node:test';
import { SeriesBuckets } from '../src/chart-buckets.js';
import { ExactExtremaIndex } from '../src/chart-extrema.js';
import { F64Col } from '../src/state.js';

function data(n) {
  const xs = Float64Array.from({ length: n }, (_, i) => Math.floor(i / 2) * 0.01);
  const special = [NaN, Infinity, -Infinity, -0, 0, -1, 1];
  const series = Array.from({ length: 8 }, (_, s) =>
    Float64Array.from({ length: n }, (_, i) =>
      s === 7 ? NaN : i % 19 < special.length ? special[i % 19] : Math.sin(i * (s + 1)),
    ),
  );
  return { xs, series };
}

function compare(xs, series, start, end, cap, index) {
  const reference = new SeriesBuckets();
  reference.rebuild(xs, series, start, end, cap);
  const actual = new SeriesBuckets();
  actual.rebuild(xs, series, start, end, cap, index);
  assert.deepStrictEqual(actual.list, reference.list);
  assert.deepStrictEqual(actual.flatten(), reference.flatten());
}

function assertFlat(buckets) {
  const flat = buckets.flatten();
  assert.ok(flat.x.length <= buckets.list.length * 2);
  for (const g of flat.channels) {
    assert.ok(g.x.length <= buckets.list.length * 4);
    for (let i = 1; i < g.indices.length; i++) assert.ok(g.indices[i] > g.indices[i - 1]);
  }
  assert.strictEqual(buckets.flatten(), flat);
}

test('indexed buckets preserve viewport phase, missing values and repeated timestamps', () => {
  const { xs, series } = data(100003);
  const index = new ExactExtremaIndex();
  index.sync(series, xs.length);
  for (const cap of [64, 127, 512, 1200]) {
    for (const start of [0, 1, 7, 31, 32, 33, 511, 1003]) {
      compare(xs, series, start, xs.length - start, cap, index);
    }
  }
});

test('chunked columns match typed arrays across storage blocks and partial stripes', () => {
  const { xs, series } = data(12_319);
  const chunkedX = new F64Col();
  chunkedX.set(xs);
  const chunkedSeries = series.map((values) => {
    const col = new F64Col();
    col.set(values);
    return col;
  });
  const index = new ExactExtremaIndex();
  index.sync(chunkedSeries, xs.length);
  for (const [start, end, cap] of [
    [0, xs.length, 64],
    [4089, 8201, 127],
    [8191, 12_317, 1200],
  ]) {
    const reference = new SeriesBuckets();
    reference.rebuild(xs, series, start, end, cap);
    const actual = new SeriesBuckets();
    const step = actual.beginRebuild(chunkedX, chunkedSeries, start, end, cap, index);
    while (!step(37)) {}
    assert.deepStrictEqual(actual.list, reference.list);
    assert.deepStrictEqual(actual.flatten(), reference.flatten());
  }
});

test('indexed extrema retain the first signed zero on equal extrema', () => {
  const xs = Float64Array.from({ length: 20000 }, (_, i) => i);
  for (const zero of [0, -0]) {
    const series = Array.from({ length: 8 }, () => Float64Array.from(xs, (_, i) => (i % 2 ? -zero : zero)));
    const index = new ExactExtremaIndex();
    index.sync(series, xs.length);
    for (const start of [0, 1, 31, 32, 33]) compare(xs, series, start, xs.length - 1, 64, index);
  }
});

test('index incrementally completes blocks across raw column reallocations', () => {
  const { xs, series } = data(30001);
  const index = new ExactExtremaIndex();
  for (const length of [0, 1, 31, 32, 33, 8000, 16383, 16384, 20003, 30001]) {
    const pages = index.levels.flat();
    const copies = series.map((col) => col.slice(0, length));
    index.sync(copies, length);
    assert.ok(
      pages.every((page) => index.levels.flat().includes(page)),
      'appends retain all existing index pages',
    );
    compare(xs, copies, 0, length, 64, index);
  }
  const before = index.byteLength;
  index.sync(series, xs.length);
  assert.equal(index.byteLength, before);
  assert.ok(before <= xs.length * 16 + index.levels.length * 64 * 16 * 8);
});

test('reset invalidates edited or replaced data and shrink invalidates completed blocks', () => {
  const { xs, series } = data(20000);
  const index = new ExactExtremaIndex();
  index.sync(series, xs.length);
  series[0][100] = 100000;
  index.reset();
  assert.equal(index.byteLength, 0);
  index.sync(series, xs.length);
  compare(xs, series, 0, xs.length, 64, index);
  index.sync(series, 10003);
  compare(xs, series, 0, 10003, 64, index);
});

test('queries scan uncached tails and unavailable channels exactly', () => {
  const { xs, series } = data(20000);
  const index = new ExactExtremaIndex();
  const partial = series.slice(0, 3);
  index.sync(partial, 10000);
  for (const start of [0, 7001, 9999, 10001]) compare(xs, partial, start, xs.length, 64, index);
});

test('fold equals the raw stripe scan in every band the speed selector may choose', () => {
  const { xs, series } = data(20003);
  const index = new ExactExtremaIndex();
  index.sync(series, xs.length);
  // n=20003 时 ppb 依次为 17 / 34 / 79 / 313：条带不超过一个块、介于块与冷建门槛之间、
  // 以及门槛以上。chart.js 按耗时在三者间挑路径，挑哪条都不许改变画出来的顶点。
  for (const cap of [1200, 600, 256, 64]) {
    for (const start of [0, 1, 33]) compare(xs, series, start, xs.length - start, cap, index);
  }
});

test('flatten retains ordered geometry through dirty tails, buffer growth, merges and reset', () => {
  const buckets = new SeriesBuckets();
  buckets.cap = 64;
  for (let i = 0; i < 5000; i++) {
    buckets.pushSample(
      i,
      Array.from({ length: 8 }, (_, s) => ((i + s) % 17 === 0 ? NaN : i % 3 ? -0 : i)),
    );
    assertFlat(buckets);
  }
  const { xs, series } = data(1000);
  for (const end of [0, 1, 2, 1000, 511, 17, 0, 1000]) {
    buckets.rebuild(xs, series, 0, end, 64);
    assertFlat(buckets);
  }
});

test('paged index stores indices/counts, preserves earliest ties across pages and fits 3.6M memory budget', () => {
  const n = 3_600_000;
  const col = new Float64Array(n);
  col.fill(-0);
  col[8191] = -4;
  col[8192] = -4;
  col[8200] = 7;
  col[8201] = 7;
  col[8194] = NaN;
  const index = new ExactExtremaIndex();
  index.sync([col], n);
  assert.ok(index.levels.flat().every((page) => page instanceof Uint32Array));
  assert.ok(index.byteLength <= 29_100_000);
  const result = {
    min: Array(8).fill(NaN),
    max: Array(8).fill(NaN),
    minIndex: Array(8).fill(-1),
    maxIndex: Array(8).fill(-1),
    count: Array(8).fill(0),
  };
  index.fold(result, [col], 8177, 8217);
  assert.equal(result.minIndex[0], 8191);
  assert.equal(result.maxIndex[0], 8200);
  assert.equal(result.count[0], 39);
  assert.equal(index.finiteCount(col, 0, 8177, 8217), 39);
});
