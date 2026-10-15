import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ModuleWorker } from '../bench/module-worker.mjs';

const files = new Map();
const notifications = [];
let picks = 0;
let cancelPick = false;
let failCsv = false;
let onFirstWrite = null;
const decoder = new TextDecoder();
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command, args, options) => {
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
globalThis.document = {
  addEventListener() {},
  dispatchEvent() {},
  getElementById() {
    return null;
  },
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
const { capturePdSnapshot, clearPdEntries, ingestPdBatch } = await import('../src/views/pd.js');
const { exportBoth } = await import('../src/paired-export.js');
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

after(() => terminateCsvExportWorker());
