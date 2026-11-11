/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ModuleWorker } from '../bench/module-worker.mjs';
import { pdoReportParameters, snapshotProtocolReport } from '../src/protocol-report-model.js';

const files = new Map();
const notifications = [];
let picks = 0;
let cancelPick = false;
let failCsv = false;
let onFirstWrite = null;
let pdGeneration = 0;
let pdBackend = [];
let onPdPage = null;
let onDecode = null;
let decodeCalls = 0;
const elements = new Map();
const emptyMeta = { raw: '', bit_loc: null, field: 'PD', value: [] };
let importedEntries = [{ t: 100, meta: emptyMeta }];
const decoder = new TextDecoder();
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command, args, options) => {
        if (command === 'pd_log_clear') {
          pdBackend = [];
          return ++pdGeneration;
        }
        if (command === 'pd_log_after') {
          assert.ok(args.generation == null || args.generation === pdGeneration);
          const throughSeq = args.throughSeq ?? (pdBackend.length ? pdBackend.length - 1 : null);
          const page = {
            generation: pdGeneration,
            throughSeq,
            events: pdBackend
              .slice(args.afterSeq == null ? 0 : args.afterSeq + 1, throughSeq == null ? 0 : throughSeq + 1)
              .slice(0, 512),
          };
          if (onPdPage) return onPdPage(args, page);
          return page;
        }
        if (command === 'pd_log_replace') {
          pdBackend = [];
          pdGeneration++;
          return args.entries.map((entry) => {
            if (entry.divider) return { t: entry.t, divider: true, gen: pdGeneration };
            const event = { ...pdEvent(pdBackend.length, entry.t), bytes: entry.bytes };
            pdBackend.push(event);
            return event;
          });
        }
        if (command === 'decode_pd_at') {
          decodeCalls++;
          assert.equal(args.generation, pdGeneration);
          if (onDecode) return onDecode(args);
          return structuredClone(emptyMeta);
        }
        if (command === 'paired_export_pick') {
          picks++;
          if (cancelPick) return null;
          const pair = { csv: { handle: 101, name: 'test.csv' }, pd: { handle: 102, name: 'test.pd.json' } };
          for (const file of Object.values(pair))
            files.set(file.handle, { ...file, bytes: [], committed: false, aborted: false });
          return pair;
        }
        if (command === 'csv_write_chunk') {
          const file = files.get(Number(options.headers['x-handle']));
          if (onFirstWrite) {
            const mutate = onFirstWrite;
            onFirstWrite = null;
            mutate();
          }
          if (failCsv && file.handle === 101) throw new Error('injected CSV failure');
          file.bytes.push(decoder.decode(args));
        }
        if (command === 'csv_write_close') {
          const file = files.get(args.handle);
          if (!file || file.committed) return;
          if (args.options.abort) file.aborted = true;
          else file.committed = true;
        }
        return null;
      },
    },
  },
};
window.__TAURI__.dialog = { open: async () => 'capture.json' };
window.__TAURI__.fs = {
  readTextFile: async () =>
    JSON.stringify({
      app: 'laPower',
      kind: 'pd-capture',
      version: 1,
      entries: importedEntries,
    }),
};
globalThis.document = {
  addEventListener() {},
  dispatchEvent() {},
  getElementById(id) {
    return elements.get(id) ?? null;
  },
  createElement: () => ({ appendChild() {}, append() {}, className: '' }),
  querySelector() {
    return null;
  },
};
globalThis.Worker = ModuleWorker;

const { state, emptyChartColumns, setChartColumns } = await import('../src/state.js');
const { captureCsvSnapshot } = await import('../src/csv.js');
const { formatCsvChunks, parseCsv } = await import('../src/csv-codec.js');
const { setMarkers, renameMarker } = await import('../src/markers.js');
const { noteRecordedSource } = await import('../src/provenance.js');
const {
  capturePdSnapshot,
  clearPdEntries,
  ingestPdBatch,
  fillPdGap,
  markPdDisconnect,
  selectPdEntry,
  importPdCapture,
} = await import('../src/views/pd.js');
const { exportBoth } = await import('../src/paired-export.js');
const { captureReport } = await import('../src/video-export.js');
const { defaultVideoExportOptions } = await import('../src/video-export-options.js');
const { terminateCsvExportWorker } = await import('../src/csv-export.js');
const { toast } = await import('../src/ui/toast.js');
for (const kind of ['info', 'success', 'warning', 'error'])
  toast[kind] = (message) => notifications.push([kind, typeof message === 'function' ? message() : message]);

function data() {
  const cols = emptyChartColumns();
  for (let i = 0; i < 2; i++) {
    for (const key of [
      'x',
      'timestamps',
      'voltage',
      'current',
      'power',
      'temp',
      'dp',
      'dn',
      'cc1',
      'cc2',
      'sampleIntervals',
    ]) {
      cols[key].push(
        key === 'x' ? i : key === 'timestamps' ? 1_700_000_000_000 + i * 1000 : key === 'temp' ? Number.NaN : 1,
      );
    }
  }
  setChartColumns(cols);
  setMarkers(cols, [{ index: 0, label: 'original' }], 2);
  noteRecordedSource(cols, { model_name: 'Test meter', vid: 1, pid: 2 });
  state.settings.csvExportOptions = { withTemp: true, withDeviceInfo: true, withMarkers: true };
  state.settings.pdFollowRecording = false;
  return cols;
}

test('all eight CSV options control only the requested columns and device metadata', () => {
  data();
  for (const withTemp of [false, true])
    for (const withDeviceInfo of [false, true])
      for (const withMarkers of [false, true]) {
        const snapshot = captureCsvSnapshot({ withTemp, withDeviceInfo, withMarkers });
        const text = [...formatCsvChunks(snapshot)].join('');
        assert.equal(text.includes('Temp(°C)'), withTemp);
        assert.equal(text.includes('\nDevice,'), withDeviceInfo);
        assert.equal(text.includes('Marker,'), withMarkers);
        assert.match(text, /\nSoftware,laPower/);
        assert.match(text, /\nPoints,mean/);
        const parsed = parseCsv(text, { signedCurrent: true });
        assert.equal(parsed.columns.x.length, 2);
        assert.equal(parsed.markers.length, withMarkers ? 1 : 0);
      }
});

test('selected empty optional columns remain present and unknown source is never substituted', () => {
  data();
  setChartColumns(emptyChartColumns());
  state.chartSeries.x.push(0);
  for (const key of ['timestamps', 'voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2', 'sampleIntervals'])
    state.chartSeries[key].push(Number.NaN);
  const text = [...formatCsvChunks(captureCsvSnapshot())].join('');
  assert.match(text, /Temp\(°C\)/);
  assert.match(text, /Marker/);
  assert.equal(text.includes('\nDevice,'), false);
});

async function preparePair() {
  data();
  clearPdEntries();
  await Promise.resolve();
  ingestPdBatch([{ t: 1_700_000_000_000, divider: true }], false);
  files.clear();
  notifications.length = 0;
  picks = 0;
  cancelPick = false;
  failCsv = false;
  onFirstWrite = null;
}

test('paired export works before opening PD and freezes both datasets before writing', async () => {
  await preparePair();
  const cols = state.chartSeries;
  onFirstWrite = () => {
    renameMarker(cols, 0, 'changed later');
    setChartColumns(emptyChartColumns());
    clearPdEntries();
  };
  await exportBoth();
  assert.equal(picks, 1);
  assert.equal(files.get(101).committed, true);
  assert.equal(files.get(102).committed, true);
  assert.match(files.get(101).bytes.join(''), /original/);
  assert.doesNotMatch(files.get(101).bytes.join(''), /changed later/);
  const pd = JSON.parse(files.get(102).bytes.join(''));
  assert.equal(pd.version, 2);
  assert.equal(pd.entries.length, 1);
  assert.equal(capturePdSnapshot().length, 0);
});

test('one failed export cleans its partial output while the other file still succeeds', async () => {
  await preparePair();
  failCsv = true;
  await exportBoth();
  assert.equal(files.get(101).aborted, true);
  assert.equal(files.get(101).committed, false);
  assert.equal(files.get(102).committed, true);
  assert.equal(notifications.filter(([kind]) => kind === 'error').length, 1);
});

test('chunked paired exports retain a fixed snapshot while acquisition and historical edits continue', async () => {
  await preparePair();
  const count = Number(process.env.LAPOWER_EXPORT_TEST_ROWS || 20_001);
  const cols = emptyChartColumns();
  for (let i = 0; i < count; i++) {
    cols.x.push(i / 1000);
    cols.timestamps.push(1_700_000_000_000 + i);
    cols.sampleIntervals.push(1);
    for (const key of ['voltage', 'current', 'power', 'temp', 'dp', 'dn', 'cc1', 'cc2'])
      cols[key].push(key === 'temp' ? Number.NaN : 1);
  }
  setChartColumns(cols);
  setMarkers(cols, [{ index: count - 1, label: 'snapshot end' }], count);
  ingestPdBatch(
    Array.from({ length: 513 }, (_, i) => ({ t: 1_700_000_000_001 + i, divider: true })),
    false,
  );
  onFirstWrite = () => {
    for (const key of Object.keys(cols)) if (typeof cols[key].push === 'function') cols[key].push(999);
    cols.voltage.setAt(count - 1, 999);
    renameMarker(cols, count - 1, 'edited after capture');
    ingestPdBatch([{ t: 1_700_000_999_999, divider: true }], false);
  };
  await exportBoth();
  assert.equal(files.get(101).committed, true);
  assert.equal(files.get(102).committed, true);
  assert.ok(files.get(101).bytes.length > 5, 'CSV is written in bounded chunks');
  assert.ok(files.get(102).bytes.length > 4, 'PD is written in bounded chunks');
  const parsed = parseCsv(files.get(101).bytes.join(''), { signedCurrent: true });
  assert.equal(parsed.columns.x.length, count);
  assert.equal(parsed.columns.voltage.at(-1), 1);
  assert.equal(parsed.markers.at(-1).label, 'snapshot end');
  assert.equal(JSON.parse(files.get(102).bytes.join('')).entries.length, 514);
  assert.equal(capturePdSnapshot().length, 515);
  assert.equal(state.chartSeries.x.length, count + 1);
});

test('cancel and repeated requests create no duplicate pair', async () => {
  await preparePair();
  cancelPick = true;
  await Promise.all([exportBoth(), exportBoth()]);
  assert.equal(picks, 1);
  assert.equal(files.size, 0);
});

function pdEvent(seq, t = seq) {
  return { t, seq, gen: pdGeneration, sop: 'SOP', type: 'Request', role: 'Sink', summary: '', bytes: [1, 2] };
}

async function resetPd() {
  onPdPage = onDecode = null;
  elements.clear();
  state.settings.pdFollowRecording = false;
  importedEntries = [{ t: 100, meta: emptyMeta }];
  clearPdEntries();
  await Promise.resolve();
}

test('PD recovers skipped events once, paginates a fixed horizon and then catches live append', async () => {
  await resetPd();
  pdBackend = Array.from({ length: 1200 }, (_, seq) => pdEvent(seq));
  ingestPdBatch([pdBackend[0], pdBackend[0]]);
  let pages = 0;
  let inflight = 0;
  onPdPage = async (args, page) => {
    assert.equal(++inflight, 1, 'only one recovery request at a time');
    pages++;
    if (pages === 1) {
      pdBackend.push(pdEvent(1200));
      ingestPdBatch([pdBackend[1200], pdBackend[2]]);
      await Promise.resolve();
    } else if (pages <= 3) assert.equal(args.throughSeq, 1199);
    inflight--;
    return page;
  };
  ingestPdBatch([pdBackend[2]]);
  assert.deepEqual(
    capturePdSnapshot().map((entry) => entry.seq),
    [0],
  );
  await fillPdGap();
  assert.equal(pages, 4);
  assert.deepEqual(
    capturePdSnapshot().map((entry) => entry.seq),
    Array.from({ length: 1201 }, (_, i) => i),
  );
  ingestPdBatch([pdBackend[1199], pdBackend[1200]]);
  assert.equal(capturePdSnapshot().length, 1201);
});

test('PD disconnect divider follows recovered messages and precedes the next session', async () => {
  await resetPd();
  pdBackend = [pdEvent(0, 1), pdEvent(1, 2), pdEvent(2, 3)];
  ingestPdBatch([pdBackend[0]]);
  let release;
  onPdPage = (_args, page) =>
    new Promise((resolve) => {
      release = () => resolve(page);
    });
  ingestPdBatch([pdBackend[2]]);
  markPdDisconnect();
  markPdDisconnect();
  const recovery = fillPdGap();
  onPdPage = null;
  release();
  await recovery;
  const result = capturePdSnapshot();
  assert.deepEqual(
    result.slice(0, 3).map((entry) => entry.seq),
    [0, 1, 2],
  );
  assert.equal(result[3].divider, true);
  pdBackend.push(pdEvent(3, Date.now() + 100));
  ingestPdBatch([pdBackend[3]]);
  assert.equal(capturePdSnapshot()[4].seq, 3);
});

test('clearing or importing invalidates an outstanding PD page', async () => {
  for (const replace of ['clear', 'import']) {
    await resetPd();
    pdBackend = [pdEvent(0), pdEvent(1), pdEvent(2)];
    let release;
    onPdPage = (_args, page) =>
      new Promise((resolve) => {
        release = () => resolve(page);
      });
    ingestPdBatch([pdBackend[2]]);
    const old = fillPdGap();
    if (replace === 'clear') {
      clearPdEntries();
      await Promise.resolve();
    } else await importPdCapture();
    release();
    await old;
    const result = capturePdSnapshot();
    assert.equal(result.length, replace === 'clear' ? 0 : 1);
    if (replace === 'import') {
      assert.deepEqual(result[0].meta, emptyMeta, 'legacy imported metadata is preserved');
      const before = decodeCalls;
      await selectPdEntry(0);
      assert.equal(decodeCalls, before);
    }
  }
});

test('PD decoded details stay in an eight-entry cache without retaining trees in the log', async () => {
  await resetPd();
  elements.set('pd-detail-body', { hidden: true, replaceChildren() {} });
  pdBackend = Array.from({ length: 100 }, (_, seq) => pdEvent(seq));
  ingestPdBatch(pdBackend);
  const before = decodeCalls;
  for (let i = 0; i < 100; i++) await selectPdEntry(i);
  assert.equal(decodeCalls - before, 100);
  assert.ok(capturePdSnapshot().every((entry) => !entry.meta));
  await selectPdEntry(99);
  await selectPdEntry(92);
  assert.equal(decodeCalls - before, 100);
  await selectPdEntry(91);
  assert.equal(decodeCalls - before, 101, 'evicted metadata must be requested again');
});

test('legacy imported trees are retained when raw frames also rebuild the backend log', async () => {
  await resetPd();
  importedEntries = [{ t: 100, meta: { ...emptyMeta, field: 'Imported tree' }, bytes: [1, 2] }];
  await importPdCapture();
  const before = decodeCalls;
  await selectPdEntry(0);
  assert.equal(decodeCalls, before);
  assert.equal(capturePdSnapshot()[0].meta.field, 'Imported tree');
  assert.equal(capturePdSnapshot()[0].gen, pdGeneration);
});

test('late PD decode cannot render after a clear or a newer selection', async () => {
  await resetPd();
  let renders = 0;
  elements.set('pd-detail-body', {
    hidden: true,
    replaceChildren() {
      renders++;
    },
  });
  pdBackend = [pdEvent(0), pdEvent(1)];
  ingestPdBatch(pdBackend);
  let release;
  onDecode = () =>
    new Promise((resolve) => {
      release = () => resolve(emptyMeta);
    });
  const oldSelection = selectPdEntry(0);
  onDecode = null;
  await selectPdEntry(1);
  assert.equal(renders, 1);
  release();
  await oldSelection;
  assert.equal(renders, 1);
  onDecode = () =>
    new Promise((resolve) => {
      release = () => resolve(emptyMeta);
    });
  const oldData = selectPdEntry(0);
  clearPdEntries();
  await Promise.resolve();
  pdBackend = [pdEvent(0)];
  ingestPdBatch(pdBackend);
  const afterClear = renders;
  release();
  await oldData;
  assert.equal(renders, afterClear);
  elements.clear();
  onDecode = onPdPage = null;
});

test('report preparation freezes provenance, recording status, markers and columns before yielding', async () => {
  const columns = data();
  state.isRecording = true;
  state.hasTempData = true;
  const options = { ...defaultVideoExportOptions, visibleSeries: [true, true, true, true], showMarkers: true };
  const pending = captureReport(options, new AbortController().signal);
  options.visibleSeries[0] = false;
  options.theme = 'dark';
  renameMarker(columns, 0, 'renamed during preparation');
  columns.voltage.setAt(0, 999);
  noteRecordedSource(columns, { model_name: 'New meter', vid: 3, pid: 4 });
  setChartColumns(emptyChartColumns());
  state.isRecording = false;
  state.hasTempData = false;
  const report = await pending;
  assert.equal(report.header.title, 'Test meter (0001:0002)');
  assert.equal(report.header.statusKind, 'recording');
  assert.equal(report.options.theme, 'light');
  assert.equal(report.options.visibleSeries[0], true);
  assert.equal(report.summary.hasTemperature, true);
  assert.equal(report.summary.points, 2);
  assert.equal(report.markers[0].label, 'original');
  assert.equal(report.overview.points[0][1], 1);
});

test('protocol reports keep detection-scoped PDOs and separate reported power from estimates', () => {
  const fixed = { position: 1, kind: 'fixed', volt_min_mv: 5000, volt_max_mv: 5000, cur_ma: 3000 };
  const band = { ...fixed, position: 6, kind: 'spr_avs', volt_min_mv: 9000, volt_max_mv: 15000 };
  const report = {
    results: [{ id: 'pd', state: 'supported' }],
    pdos: [fixed, band, { ...band, volt_min_mv: 15000, volt_max_mv: 20000, cur_ma: 5000 }],
    completion: 'partial',
  };
  const metadata = { device: 'Original meter', startedAt: 1000, full: true };
  const captured = snapshotProtocolReport(report, metadata);
  report.pdos[0].cur_ma = 1000;
  report.results[0].state = 'failed';
  metadata.device = 'Another meter';
  assert.equal(captured.report.pdos[0].cur_ma, 3000);
  assert.equal(captured.report.pdos[1].position, captured.report.pdos[2].position);
  assert.equal(captured.report.pdos.length, 3, 'both AVS bands must survive');
  assert.equal(captured.report.results[0].state, 'supported');
  assert.equal(captured.metadata.device, 'Original meter');
  assert.deepEqual(snapshotProtocolReport({ ...report, pdos: undefined }, metadata).report.pdos, []);
  assert.deepEqual(pdoReportParameters({ ...fixed, cur_ma: 3000 }), {
    currentMa: 3000,
    currentAtMaxVoltage: false,
    powerMw: 15000,
    powerSource: 'calculated',
  });
  assert.deepEqual(
    pdoReportParameters({ ...fixed, kind: 'epr_avs', volt_max_mv: 48000, cur_ma: 2916, max_power_mw: 140000 }),
    {
      currentMa: 2916,
      currentAtMaxVoltage: true,
      powerMw: 140000,
      powerSource: 'reported',
    },
  );
  assert.equal(pdoReportParameters({ ...fixed, kind: 'battery', max_power_mw: 36250 }).currentMa, null);
  assert.equal(pdoReportParameters({ ...fixed, cur_ma: undefined }).powerMw, null);
});

after(() => terminateCsvExportWorker());
