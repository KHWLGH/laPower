import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeDevice,
  noteImportedSource,
  noteRecordedSource,
  POINT_RULE,
  parseDeviceList,
  provenanceOf,
  setSoftwareVersion,
  softwareLabel,
} from '../src/provenance.js';

const K2 = { model_name: 'WITRN K2', vid: 0x0716, pid: 0x5060 };

test('a device is named by model and USB VID:PID', () => {
  assert.equal(describeDevice(K2), 'WITRN K2 (0716:5060)');
  assert.equal(describeDevice({ model_name: 'POWER-Z KM003C' }), 'POWER-Z KM003C', 'no ids, no suffix');
  assert.equal(describeDevice({ model_name: 'A, "B"', vid: 1, pid: 2 }), 'A B (0001:0002)');
  assert.equal(describeDevice(null), null);
});

test('the writing software carries its version when known', () => {
  setSoftwareVersion('0.2.4');
  assert.equal(softwareLabel(), 'laPower 0.2.4');
  setSoftwareVersion(null);
  assert.equal(softwareLabel(), 'laPower');
});

test('a recording names its meter once and the rule it used', () => {
  const cols = {};
  assert.deepEqual(provenanceOf(cols), { devices: [], points: null });
  noteRecordedSource(cols, K2);
  noteRecordedSource(cols, K2);
  assert.deepEqual(provenanceOf(cols), { devices: ['WITRN K2 (0716:5060)'], points: POINT_RULE });
});

test('imported data keeps what the file declared and stays unknown when it declared nothing', () => {
  const declared = {};
  noteImportedSource(declared, { devices: ['WITRN U3 (0716:5063)'], points: 'mean' });
  noteRecordedSource(declared, K2);
  assert.deepEqual(provenanceOf(declared), {
    devices: ['WITRN U3 (0716:5063)', 'WITRN K2 (0716:5060)'],
    points: 'mean',
  });

  const legacy = {};
  noteImportedSource(legacy, { devices: [], points: null });
  noteRecordedSource(legacy, K2);
  assert.equal(provenanceOf(legacy).points, null, 'older points of unknown origin');

  const mixed = {};
  noteImportedSource(mixed, { devices: [], points: 'peak' });
  noteRecordedSource(mixed, K2);
  assert.equal(provenanceOf(mixed).points, null, 'two rules cannot share one label');

  const odd = {};
  noteImportedSource(odd, { points: 'mean; rm -rf' });
  assert.equal(provenanceOf(odd).points, null, 'only a plain rule name is believed');
});

test('a device list splits on the separator the writer uses', () => {
  assert.deepEqual(parseDeviceList('WITRN U3 (0716:5063) / WITRN K2 (0716:5060)'), [
    'WITRN U3 (0716:5063)',
    'WITRN K2 (0716:5060)',
  ]);
  assert.deepEqual(parseDeviceList('  '), []);
});
