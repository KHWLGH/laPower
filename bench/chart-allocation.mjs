import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SeriesBuckets } from '../src/chart-buckets.js';
import { ExactExtremaIndex } from '../src/chart-extrema.js';
import { F64Col } from '../src/state.js';
import { environment, options, provenance, quantiles, saveJson } from './common.mjs';

const config = options(process.argv.slice(2), { output: 'bench/results/chart-research/allocation.json' });
const before = await provenance();
const results = [];
for (const n of [100_000, 1_000_000, 3_600_000]) {
  const series = Array.from({ length: 8 }, (_, s) =>
    Float64Array.from({ length: n + 1000 }, (_, i) => s + (i % 37) / 10),
  );
  const runs = [];
  for (let run = 0; run < 9; run++) {
    const index = new ExactExtremaIndex();
    index.sync(series, n);
    const previous = index.levels.flat();
    const started = performance.now();
    index.syncStep(series, n + 128, 128);
    const appendMs = performance.now() - started;
    const afterAppend = new Set(index.levels.flat());
    const copiedBytes = previous.reduce((bytes, value) => bytes + (!afterAppend.has(value) ? value.byteLength : 0), 0);
    const beforeNext = index.levels.flat();
    const next = performance.now();
    index.syncStep(series, n + 256, 128);
    const normalMs = performance.now() - next;
    const afterNext = new Set(index.levels.flat());
    const nextCopiedBytes = beforeNext.reduce(
      (bytes, value) => bytes + (!afterNext.has(value) ? value.byteLength : 0),
      0,
    );
    runs.push({ appendMs, normalMs, copiedBytes, nextCopiedBytes, allocatedBytes: index.byteLength });
  }
  results.push({
    n,
    append128WithGrowth: quantiles(runs.map((r) => r.appendMs)),
    next128: quantiles(runs.map((r) => r.normalMs)),
    copiedBytes: runs[0].copiedBytes,
    nextCopiedBytes: runs[0].nextCopiedBytes,
    runs,
  });
}
const xs = Float64Array.from({ length: 4096 }, (_, i) => i);
const ramp = Float64Array.from(xs, (_, i) => 100 - i / 4096);
const buckets = new SeriesBuckets();
buckets.rebuild(xs, [ramp], 0, 4096, 1024);
const geometry = buckets.flatten().channels[0];
const flat = { x: geometry.x, ys: [geometry.y] };
let inventedRises = 0,
  duplicateX = 0;
for (let i = 1; i < flat.x.length; i++) {
  if (flat.ys[0][i] > flat.ys[0][i - 1]) inventedRises++;
  if (flat.x[i] === flat.x[i - 1]) duplicateX++;
}
assert.equal(duplicateX, 0);
assert.equal(inventedRises, 0);
const column = new F64Col();
column.set(new Float64Array(3_600_000).fill(1));
const copies = [];
for (const rows of [1024, 2048, 4096, 8192]) {
  const times = [];
  for (let run = 0; run < 23; run++) {
    const started = performance.now();
    for (let field = 0; field < 13; field++) column.copyRange(1_000_001, 1_000_001 + rows);
    if (run >= 3) times.push(performance.now() - started);
  }
  copies.push({ rows, thirteenColumnCopyMs: quantiles(times), transferBytes: rows * 13 * 8 });
}
const result = {
  environment: environment(),
  provenance: before,
  results,
  ramp: {
    samples: 4096,
    outputPoints: flat.x.length,
    duplicateX,
    inventedRises,
    note: 'Ordered source candidates preserve the falling ramp without invented rises or timestamp offsets.',
  },
  csvCopies: copies,
  limitations:
    'Node timings, not browser FPS or native disk throughput; copiedBytes counts replaced typed-array contents only. Probes begin at the same N-point prefixes that forced growth in the former contiguous index, then request 128 more samples. Paged storage may already have spare page capacity at these points; these are not random real-session events.',
};
result.sourceStable = before.sourceSha256 === (await provenance()).sourceSha256;
assert.ok(result.sourceStable, 'Production source changed during the benchmark');
await saveJson(config.output, result);
console.log(
  JSON.stringify({
    output: config.output,
    results: result.results.map(({ n, append128WithGrowth, next128, copiedBytes }) => ({
      n,
      append128WithGrowth,
      next128,
      copiedBytes,
    })),
    ramp: result.ramp,
    csvCopies: result.csvCopies,
    sourceStable: result.sourceStable,
  }),
);
