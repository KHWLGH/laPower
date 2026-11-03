// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { addMarker, markersOf } from '../src/markers.js';
import { F64Col } from '../src/state.js';
import {
  defaultVideoExportOptions,
  normalizeVideoExportOptions,
  parseDurationInput,
  videoFrameCount,
} from '../src/video-export-options.js';
import { VIDEO_PALETTE_DARK, VIDEO_PALETTE_LIGHT, videoPalette } from '../src/video-palette.js';
import { buildVideoPayload, projectVideo } from '../src/video-projection.js';

/** Build one immutable recording; `rows` is [seconds, voltage, current, power, temp]. */
function columns(rows, options = {}) {
  const cols = {
    x: new F64Col(),
    timestamps: new F64Col(),
    voltage: new F64Col(),
    current: new F64Col(),
    currentMagnitudes: new F64Col(),
    power: new F64Col(),
    temp: new F64Col(),
    dp: new F64Col(),
    dn: new F64Col(),
    cc1: new F64Col(),
    cc2: new F64Col(),
    recordingSegments: new F64Col(),
    sampleIntervals: new F64Col(),
  };
  for (const [seconds, voltage, current, power, temp] of rows) {
    cols.x.push(seconds);
    cols.timestamps.push(1_700_000_000_000 + seconds * 1000);
    cols.voltage.push(voltage);
    cols.current.push(current);
    cols.currentMagnitudes.push(options.currentMagnitudes ? current + 0.5 : Number.NaN);
    cols.power.push(power);
    cols.temp.push(temp);
    cols.dp.push(0);
    cols.dn.push(0);
    cols.cc1.push(0);
    cols.cc2.push(0);
    cols.recordingSegments.push(options.segment ?? 1);
    cols.sampleIntervals.push(options.intervalMs ?? 1000);
  }
  return cols;
}

/** Snapshot the columns the way the export path does. */
function snapshots(cols) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(cols)) out[key] = /** @type {F64Col} */ (value).snapshot();
  return out;
}

function record(count, step = 1) {
  /** @type {[number, number, number, number, number][]} */
  const rows = [];
  for (let index = 0; index < count; index++) {
    const seconds = index * step;
    rows.push([seconds, 5 + seconds * 0.001, 1 + seconds * 0.01, 5 + seconds * 0.05, 30 + seconds * 0.1]);
  }
  return rows;
}

test('video options fall back per field instead of dropping the whole block', () => {
  const normalized = normalizeVideoExportOptions({
    width: 1366,
    height: 768,
    fps: 25,
    codec: 'av1',
    format: 'mkv',
    durationS: 0,
    theme: 'sepia',
    visibleSeries: [true, 'yes'],
  });
  assert.deepEqual(normalized, {
    ...defaultVideoExportOptions,
    visibleSeries: [true, true, true, true],
  });
  assert.equal(normalizeVideoExportOptions(null).width, defaultVideoExportOptions.width);
  assert.equal(normalizeVideoExportOptions(undefined).durationS, defaultVideoExportOptions.durationS);
  // A valid resolution and duration survive while invalid siblings fall back.
  const partial = normalizeVideoExportOptions({ width: 3840, height: 2160, durationS: 60 });
  assert.deepEqual([partial.width, partial.height, partial.durationS], [3840, 2160, 60]);
  assert.equal(partial.fps, defaultVideoExportOptions.fps);
});

test('frame count is duration times frame rate', () => {
  assert.equal(videoFrameCount({ durationS: 5, fps: 30 }), 150);
  assert.equal(videoFrameCount({ durationS: 60, fps: 60 }), 3600);
});

test('duration input is parsed without silently clamping out-of-range text', () => {
  // 输入框里的 61 不能被当成 5：越界就是越界，界面上要能提示并挡住生成。
  assert.deepEqual(parseDurationInput('61'), { value: 61, valid: false });
  assert.deepEqual(parseDurationInput('0'), { value: 0, valid: false });
  assert.deepEqual(parseDurationInput('1'), { value: 1, valid: true });
  assert.deepEqual(parseDurationInput('60'), { value: 60, valid: true });
  assert.deepEqual(parseDurationInput(' 30 '), { value: 30, valid: true });
  for (const invalid of ['', '5.5', '-3', 'abc', '1e3', null, undefined]) {
    assert.equal(parseDurationInput(invalid).valid, false, String(invalid));
  }
  // 已保存的数值走同一条路径，因此持久化与手输的判定不会分叉。
  assert.deepEqual(parseDurationInput(12), { value: 12, valid: true });
});

test('projection covers the last sample exactly and keeps one reading per frame', () => {
  const cols = columns(record(61));
  const projection = projectVideo({
    columns: snapshots(cols),
    length: cols.x.length,
    frameCount: 12,
    intervalMs: 1000,
  });
  assert.equal(projection.frames.t.length, 12);
  assert.equal(projection.frames.t[0], 0);
  assert.equal(projection.frames.t.at(-1), 60);
  assert.equal(projection.frames.voltage.length, 12);
  // The last frame reads the last sample, not the one before it.
  assert.equal(projection.frames.voltage.at(-1), 5 + 60 * 0.001);
  assert.equal(projection.elapsedS, 60);
  assert.equal(projection.summary.points, 61);
});

test('a single-frame report samples time zero', () => {
  const cols = columns(record(5));
  const projection = projectVideo({
    columns: snapshots(cols),
    length: cols.x.length,
    frameCount: 1,
    intervalMs: 1000,
  });
  assert.deepEqual(projection.frames.t, [0]);
  assert.equal(projection.frames.voltage[0], 5);
});

test('gaps become missing readings instead of repeating the last value', () => {
  // 0..2 s normal, then a 30 s hole, then normal again: the energy rule skips it and the
  // video must show "no reading" for frames that land inside the hole.
  const rows = [...record(3), ...record(3).map(([t, v, c, p, temp]) => [t + 32, v, c, p, temp])];
  const cols = columns(rows);
  const projection = projectVideo({
    columns: snapshots(cols),
    length: cols.x.length,
    frameCount: 7,
    intervalMs: 1000,
  });
  // lastX is 34 s, so frames are 0, 5.67, 11.33, 17, 22.67, 28.33, 34.
  const missing = projection.frames.voltage.filter((value) => value === null).length;
  assert.ok(missing >= 3, `expected the gap to be missing, got ${missing}`);
  assert.equal(projection.frames.voltage.at(-1), 5 + 2 * 0.001);
  // The average power must not count the hole as 5 W for 30 seconds.
  assert.ok(projection.summary.averagePowerW < 6);
});

test('overview keeps the extrema of every bucket', () => {
  const rows = record(1200);
  // A single outlier in the middle of an evenly rising trace.
  rows[600][1] = 12;
  const cols = columns(rows);
  const projection = projectVideo({
    columns: snapshots(cols),
    length: cols.x.length,
    frameCount: 10,
    intervalMs: 1000,
    binCount: 64,
  });
  assert.ok(projection.overview.length > 64, 'buckets keep first/last and extrema');
  const voltages = projection.overview.map((point) => point[1]);
  assert.ok(voltages.includes(12), 'a spike inside a bucket must survive the projection');
  // Time must stay sorted so the renderer can draw a polyline, and it is in milliseconds:
  // the renderer converts the first element straight to a pixel offset.
  const times = projection.overview.map((point) => point[0]);
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
  assert.equal(times[0], 0);
  assert.equal(times.at(-1), 1_199_000);
  assert.ok(
    times.every((value) => Number.isInteger(value)),
    'the payload time axis is whole milliseconds',
  );
});

test('short recordings are projected sample by sample', () => {
  const cols = columns(record(40));
  const projection = projectVideo({
    columns: snapshots(cols),
    length: cols.x.length,
    frameCount: 8,
    intervalMs: 1000,
    binCount: 256,
  });
  assert.equal(projection.overview.length, 40);
});

test('no markers means no breakpoints in the report', () => {
  const cols = columns(record(20));
  const projection = projectVideo({
    columns: snapshots(cols),
    length: cols.x.length,
    frameCount: 5,
    intervalMs: 1000,
  });
  assert.deepEqual(projection.markers, []);
});

test('marker projection keeps the earliest settled markers in time order', () => {
  const cols = columns(record(100));
  addMarker(cols, 30, 'later');
  addMarker(cols, 4, 'earlier');
  addMarker(cols, 100, 'pending row');
  for (let index = 0; index < 10; index++) addMarker(cols, 50 + index, `filler ${index}`);
  const markers = markersOf(cols);
  const projection = projectVideo({
    columns: snapshots(cols),
    length: cols.x.length,
    frameCount: 5,
    intervalMs: 1000,
    markers,
  });
  assert.equal(projection.markers.length, 8);
  assert.equal(projection.markers[0].label, 'earlier');
  assert.equal(projection.markers[0].tS, 4);
  assert.equal(projection.markers[1].label, 'later');
  const times = projection.markers.map((marker) => marker.tS);
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
});

test('an empty or single-row recording has no report to draw', () => {
  const empty = columns([]);
  assert.throws(
    () => projectVideo({ columns: snapshots(empty), length: 0, frameCount: 5, intervalMs: 1000 }),
    /videoNoData/,
  );
  const one = columns(record(1));
  assert.throws(
    () => projectVideo({ columns: snapshots(one), length: 1, frameCount: 5, intervalMs: 1000 }),
    /videoNoData/,
  );
});

test('summary uses magnitudes and reports whether temperature exists', () => {
  const rows = record(10);
  rows[3][2] = -2;
  rows[4][4] = Number.NaN;
  const cols = columns(rows);
  const projection = projectVideo({
    columns: snapshots(cols),
    length: cols.x.length,
    frameCount: 10,
    intervalMs: 1000,
  });
  // Peak current is a magnitude, so a reverse reading counts as 2 A, not -2 A.
  assert.equal(projection.summary.peakCurrentA, 2);
  // The curve keeps the recorded sign; only the card prints the magnitude.
  assert.equal(projection.frames.current[3], -2);
  assert.equal(projection.summary.hasTemperature, true);
  assert.ok(projection.summary.capacityMah > 0);
  assert.ok(projection.summary.energyWh > 0);
});

test('both palettes expose the same shape and distinct series colours', () => {
  for (const palette of [VIDEO_PALETTE_LIGHT, VIDEO_PALETTE_DARK]) {
    assert.match(palette.background, /^#[0-9a-f]{6}$/);
    assert.equal(palette.series.length, 4);
    assert.equal(new Set(palette.series).size, 4, 'series colours must stay distinguishable');
    assert.ok(palette.energy && palette.soft && palette.accent && palette.border && palette.muted && palette.ink);
  }
  assert.equal(videoPalette('dark'), VIDEO_PALETTE_DARK);
  assert.equal(videoPalette('light'), VIDEO_PALETTE_LIGHT);
  assert.equal(videoPalette(undefined), VIDEO_PALETTE_LIGHT);
});
test('payload keys match the IPC contract the backend deserialises', () => {
  const cols = columns(record(30));
  const projection = projectVideo({
    columns: snapshots(cols),
    length: cols.x.length,
    frameCount: 5,
    intervalMs: 1000,
  });
  const labels = {
    eyebrow: 'laPower',
    chart: 'Chart',
    breakpoints: 'Markers',
    power: 'Power',
    voltage: 'Voltage',
    current: 'Current',
    temperature: 'Temperature',
    capacity: 'Capacity',
    points: 'points',
    noSeries: 'No curves',
    missing: 'No reading',
    unitW: 'W',
    unitV: 'V',
    unitA: 'A',
    unitC: 'C',
    unitWh: 'Wh',
  };
  const payload = buildVideoPayload({
    options: defaultVideoExportOptions,
    projection,
    header: { title: 'laPower', status: 'Recorded', statusKind: 'complete' },
    labels,
    palette: VIDEO_PALETTE_LIGHT,
  });
  // `src-tauri/src/video_export/model.rs` rejects unknown fields, so this list is a contract:
  // both sides must change together when a field is added or renamed.
  assert.deepEqual(Object.keys(payload).sort(), [
    'frames',
    'header',
    'labels',
    'markers',
    'options',
    'overview',
    'palette',
    'summary',
  ]);
  assert.deepEqual(Object.keys(payload.options).sort(), [
    'codec',
    'durationS',
    'format',
    'fps',
    'height',
    'theme',
    'visibleSeries',
    'width',
  ]);
  assert.deepEqual(Object.keys(payload.summary).sort(), [
    'averagePowerW',
    'capacityMah',
    'elapsedS',
    'energyWh',
    'hasTemperature',
    'maxTempC',
    'maxVoltageV',
    'minVoltageV',
    'peakCurrentA',
    'points',
  ]);
  assert.deepEqual(Object.keys(payload.frames).sort(), ['current', 'power', 't', 'temperature', 'voltage']);
  assert.deepEqual(Object.keys(payload.overview).sort(), ['bucketMs', 'points']);
  assert.equal(payload.frames.t.length, 5);
  assert.equal(payload.overview.points.length, projection.overview.length);
});
