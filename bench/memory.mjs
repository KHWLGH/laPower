import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { environment, options, saveJson } from './common.mjs';

const here = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const epoch = 1704067200000;

function values(i, size) {
  const voltage = 5 + (i % 201) / 10000;
  const current = ((i % 101) - 50) / 100;
  return [
    i / 1000,
    epoch + i,
    voltage,
    current,
    Math.abs(voltage * current),
    NaN,
    (i % 17) / 10,
    (i % 19) / 10,
    (i % 13) / 10,
    (i % 11) / 10,
    1 + Math.floor(i / Math.ceil(size / 5)),
    1,
  ];
}

function retainedBytes(columns) {
  const buffers = new Set(Object.values(columns).flatMap((col) => col._chunks.map((chunk) => chunk.buffer)));
  return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}

function hash(columns) {
  const digest = createHash('sha256');
  for (const col of Object.values(columns))
    for (const { values } of col.chunks())
      digest.update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  return digest.digest('hex');
}

async function child(moduleDir, size, scenario) {
  const { emptyChartColumns } = await import(pathToFileURL(resolve(moduleDir, 'state.js')));
  let columns = null;
  let snapshot = null;
  let peakSampledRss = process.memoryUsage().rss;
  let peakSampledArrayBuffers = 0;
  const sample = () => {
    const memory = process.memoryUsage();
    peakSampledRss = Math.max(peakSampledRss, memory.rss);
    peakSampledArrayBuffers = Math.max(peakSampledArrayBuffers, memory.arrayBuffers);
  };
  globalThis.gc();
  const initialMemory = process.memoryUsage();
  const started = performance.now();
  if (scenario === 'append') {
    columns = emptyChartColumns();
    const keys = Object.keys(columns);
    for (let i = 0; i < size; i++) {
      const row = values(i, size);
      for (let k = 0; k < keys.length; k++) columns[keys[k]].push(row[k]);
      if (i % 4096 === 0) sample();
    }
    snapshot = Object.fromEntries(Object.entries(columns).map(([key, col]) => [key, col.snapshot()]));
    // A fixed export snapshot coexists with recording append without copying history.
    for (let i = size; i < size + 4097; i++) {
      const row = values(i, size);
      for (let k = 0; k < keys.length; k++) columns[keys[k]].push(row[k]);
    }
    assert.equal(snapshot.x.length, size);
    assert.equal(snapshot.x.at(-1), (size - 1) / 1000);
    sample();
  } else {
    const { createCsvImport } = await import(pathToFileURL(resolve(moduleDir, 'csv-import-core.js')));
    let parser = createCsvImport({ signedCurrent: true, fallbackStartTime: epoch });
    parser.push(
      'SampTime(ms),1\nTime(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),Temp(°C),D+(V),D-(V),CC1(V),CC2(V),RelativeTime(s),Timestamp(ms),RecordingSegment,SampleInterval(ms),\n',
    );
    for (let from = 0; from < size; from += 4096) {
      let text = '';
      for (let i = from; i < Math.min(size, from + 4096); i++) {
        const row = values(i, size);
        text += `00:00:00,${row
          .slice(2, 10)
          .map((v) => (Number.isNaN(v) ? '' : String(v)))
          .join(',')},${row[0]},${row[1]},${row[10]},1,\n`;
      }
      parser.push(text);
      sample();
    }
    columns = parser.finish().columns;
    parser = null;
    sample();
  }
  const elapsedMs = performance.now() - started;
  globalThis.gc();
  const result = {
    scenario,
    rows: columns.x.length,
    retainedColumnBytes: retainedBytes(columns),
    sha256: hash(columns),
    elapsedMs,
    initialMemory,
    retainedMemory: process.memoryUsage(),
    peakSampledRss,
    peakSampledArrayBuffers,
  };
  columns = null;
  snapshot = null;
  // ArrayBuffer finalizers and async stack roots can survive the collecting turn.
  for (let i = 0; i < 3; i++) {
    await new Promise((done) => setImmediate(done));
    globalThis.gc();
  }
  result.clearedMemory = process.memoryUsage();
  result.repeatedClearMemory = [];
  for (let pass = 0; pass < 3; pass++) {
    columns = emptyChartColumns();
    for (const col of Object.values(columns)) col.set(new Float64Array(100_000).fill(pass));
    columns = null;
    await new Promise((done) => setImmediate(done));
    globalThis.gc();
    await new Promise((done) => setImmediate(done));
    globalThis.gc();
    result.repeatedClearMemory.push(process.memoryUsage());
  }
  assert.ok(result.clearedMemory.arrayBuffers < initialMemory.arrayBuffers + 1024 * 1024, 'history released');
  assert.ok(
    result.repeatedClearMemory.every((memory) => memory.arrayBuffers < initialMemory.arrayBuffers + 2 * 1024 * 1024),
    'repeated replacement releases old column caches',
  );
  result.osMaxRssBytes = process.resourceUsage().maxRSS * 1024;
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[2] === '--child') {
  await child(process.argv[3], Number(process.argv[4]), process.argv[5]);
} else {
  const config = options(process.argv.slice(2), {
    sizes: [1_000_000, 5_000_000],
    baseline: 'bench/results/memory-before',
    output: 'bench/results/memory.json',
  });
  const result = {
    environment: environment(),
    config,
    cases: [],
    limitations: [
      'Fresh Node processes measure columns and streamed CSV parsing, not the Tauri/WebView2/GPU process tree.',
      'Sampled peaks can miss short allocations; OS max RSS is reported separately and includes runtime startup.',
      'Fixture varies all signal channels, with no temperature, fixed 1 ms cadence and five recording segments.',
    ],
  };
  for (const size of config.sizes)
    for (const scenario of ['append', 'import']) {
      const item = { size, scenario };
      for (const [name, dir] of [
        ['before', resolve(root, config.baseline)],
        ['after', resolve(root, 'src')],
      ]) {
        const run = spawnSync(process.execPath, ['--expose-gc', here, '--child', dir, String(size), scenario], {
          encoding: 'utf8',
        });
        if (run.status !== 0) throw new Error(run.stderr || `Memory benchmark child exited ${run.status}`);
        item[name] = JSON.parse(run.stdout);
      }
      assert.equal(item.before.sha256, item.after.sha256, `${scenario}/${size}: exact data`);
      item.columnReduction = 1 - item.after.retainedColumnBytes / item.before.retainedColumnBytes;
      assert.ok(item.columnReduction >= 0.2, `${scenario}/${size}: at least 20% column reduction`);
      result.cases.push(item);
      console.log(JSON.stringify(item));
    }
  await saveJson(config.output, result);
  await writeFile(
    resolve(root, 'bench/results/memory-summary.txt'),
    result.cases
      .map(
        (item) =>
          `${item.scenario} ${item.size}: columns ${(item.columnReduction * 100).toFixed(1)}% lower; RSS peak before/after ${(item.before.peakSampledRss / 1048576).toFixed(1)}/${(item.after.peakSampledRss / 1048576).toFixed(1)} MiB`,
      )
      .join('\n'),
  );
}
