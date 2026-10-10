import assert from 'node:assert/strict';
import test from 'node:test';
import { ModuleWorker } from '../bench/module-worker.mjs';
import { parseCsv } from '../src/csv-codec.js';
import { computeCsvImport } from '../src/csv-import-core.js';
import { calculateEnergyInRange } from '../src/measurement.js';
import { columnTransferBuffers, emptyChartColumns } from '../src/state.js';

const options = { signedCurrent: true, fallbackStartTime: 1234 };
const text =
  'SampTime(ms),5000\nTime(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),Temp(°C),RelativeTime(s),Timestamp(ms),RecordingSegment\n00:00:10,Infinity,NaN,18,,10,10000,2\n00:00:00,-0,-0,10,25,0,0,1\n00:00:05,6,-3,18,Infinity,5,5000,1\n00:00:05,7,2,14,26,5,5000,1';

test('import computation retains stable exact columns and matches energy/stat semantics', () => {
  const result = computeCsvImport(text, options);
  const parsed = parseCsv(text, options);
  for (const key of Object.keys(parsed.columns)) {
    assert.deepEqual(result.columns[key].view(), parsed.columns[key].view(), key);
  }
  assert.ok(Object.is(result.columns.voltage.buf[0], -0));
  assert.deepEqual([...result.columns.voltage.view()], [-0, 6, 7, Infinity]);
  assert.deepEqual(result.stats.voltage, { min: -0, max: 7, sum: 13, count: 3 });
  assert.deepEqual(result.stats.temp, { min: 25, max: 26, sum: 51, count: 2 });
  assert.equal(result.hasTempData, true);
  assert.deepEqual(
    result.energy,
    calculateEnergyInRange(
      parsed.columns.x.view(),
      parsed.columns.current.view(),
      parsed.columns.power.view(),
      0,
      3,
      parsed.columns.recordingSegments.view(),
      parsed.intervalMs,
    ),
  );
});

test('only newly imported buffers are detached when transferring results', () => {
  const live = emptyChartColumns();
  live.voltage.push(123);
  const liveBuffer = live.voltage.buf.buffer;
  const result = computeCsvImport(text, options);
  const buffers = columnTransferBuffers(result.columns);
  const received = structuredClone(result, { transfer: buffers });
  assert.ok(buffers.every((buffer) => buffer.byteLength === 0));
  assert.ok(liveBuffer.byteLength > 0);
  assert.equal(live.voltage.at(0), 123);
  assert.deepEqual([...received.columns.current._chunks[0].subarray(0, 4)], [-0, -3, 2, NaN]);
});

test('invalid file never returns partial computation', () => {
  assert.throws(() => computeCsvImport('invalid', options), /Header not found/);
});

test('real CSV Worker transfers shared chunks, preserving missing values and exact intervals', async () => {
  const rows = 3 * 4096 + 7;
  const header =
    'SampTime(ms),1\nTime(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),RelativeTime(s),Timestamp(ms),RecordingSegment,SampleInterval(ms),\n';
  const worker = new ModuleWorker(new URL('../src/csv-import-worker.js', import.meta.url));
  const send = (message, transfer = []) =>
    new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => (data.type === 'error' ? reject(new Error(data.error)) : resolve(data));
      worker.onerror = ({ message }) => reject(new Error(message));
      worker.postMessage(message, transfer);
    });
  try {
    await send({ type: 'begin', options });
    let text = header;
    for (let i = 0; i < rows; i++) text += `00:00:00,5,-0,0,${i / 1000},${1700000000000 + i},1,1,\n`;
    const bytes = new TextEncoder().encode(text).buffer;
    await send({ type: 'chunk', bytes }, [bytes]);
    const reply = await send({ type: 'end' });
    assert.equal(reply.type, 'done');
    assert.equal(reply.result.columns.x.length, rows);
    for (const key of ['temp', 'sampleIntervals', 'recordingSegments']) {
      const column = reply.result.columns[key];
      assert.equal(column._chunks[0], column._chunks[2], key);
      assert.notEqual(column._chunks[2], column._chunks[3], key);
    }
    assert.ok(Number.isNaN(reply.result.columns.temp._chunks[0][1]));
    assert.ok(Object.is(reply.result.columns.current._chunks[0][1], -0));
    assert.equal(reply.result.columns.sampleIntervals._chunks[0][1], 1);
    assert.equal(reply.result.columns.timestamps._chunks[3][6], 1700000000000 + rows - 1);
  } finally {
    worker.terminate();
  }
});
