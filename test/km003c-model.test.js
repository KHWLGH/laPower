import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTriggerCommand,
  clampPdm,
  cleanHex,
  commandNeedsPdm,
  DEFAULT_PDM,
  describePdo,
  detectionCanSelect,
  detectionStateLabel,
  detectionSummary,
  detectionVoltages,
  deviceSupportsControl,
  exportTriggerHistory,
  filterTriggerHistory,
  formatTriggerHistoryEntry,
  LOG_LIMIT,
  outcomeHead,
  outcomeHistoryStatus,
  pdoToRequestFields,
  pdVersionLabel,
  prependOutcome,
  protocolFields,
  summarizeTriggerCommand,
  triggerTimeoutMs,
  trimTriggerHistory,
} from '../src/km003c-model.js';

/** @param {Partial<import('../src/km003c-model.js').TriggerForm>} [over] */
const form = (over = {}) => ({ position: 2, voltMv: 9000, curMa: 3000, volt: '9V', ...over });

/** @param {Partial<import('../src/km003c-model.js').TriggerOutcome>} [over] */
const outcome = (over = {}) => ({ ok: true, message: 'ok', pdos: [], protocols: [], pdm_open: true, ...over });

test('PDM choices fall back field by field to the PD 3.0 / 20V 5A / 3A PPS default', () => {
  assert.deepEqual(clampPdm(undefined), DEFAULT_PDM);
  assert.deepEqual(clampPdm({ pdType: 2, em: 3, sink: 1 }), { pdType: 2, em: 3, sink: 1 });
  assert.deepEqual(clampPdm({ pdType: 9, em: '2', sink: 1.5 }), { pdType: 1, em: 2, sink: 0 });
  assert.deepEqual(clampPdm({ pdType: -1, em: null, sink: 'x' }), DEFAULT_PDM);
});

test('each protocol shows only the fields its command uses', () => {
  assert.deepEqual(
    ['pd', 'qc', 'qc3', 'fcp', 'scp', 'ufcs', 'bc'].map((proto) => {
      const f = protocolFields(proto);
      return [proto, f.position, f.fixedVolt, f.voltMv, f.curMa, f.qc3Adjust];
    }),
    [
      ['pd', true, false, true, true, false],
      ['qc', false, true, false, false, false],
      ['qc3', false, false, true, false, true],
      ['fcp', false, true, false, false, false],
      ['scp', false, false, true, true, false],
      ['ufcs', true, false, true, true, false],
      ['bc', false, false, false, false, false],
    ],
  );
  assert.equal(protocolFields('ufcs').positionLabel, 'Request position');
  assert.deepEqual(protocolFields('qc').voltChoices, ['5V', '9V', '12V', '20V']);
  assert.deepEqual(protocolFields('afc').voltChoices, ['5V', '9V', '12V']);
});

test('the form builds the exact command JSON the backend deserializes', () => {
  assert.deepEqual(buildTriggerCommand('pd', form()), {
    cmd: { type: 'pd_req', position: 2, volt_mv: 9000, cur_ma: 3000 },
  });
  assert.deepEqual(buildTriggerCommand('qc', form({ volt: '12V' })), { cmd: { type: 'qc', voltage: '12V' } });
  assert.deepEqual(buildTriggerCommand('qc3', form()), { cmd: { type: 'qc3', volt_mv: 9000 } });
  assert.deepEqual(buildTriggerCommand('sfcp', form()), { cmd: { type: 'sfcp', voltage: '9V' } });
  assert.deepEqual(buildTriggerCommand('vfcp', form()), { cmd: { type: 'vfcp', volt_mv: 9000, cur_ma: 3000 } });
  assert.deepEqual(buildTriggerCommand('ufcs', form()), {
    cmd: { type: 'ufcs', req: 2, volt_mv: 9000, cur_ma: 3000 },
  });
  assert.deepEqual(buildTriggerCommand('apple', form()), { cmd: { type: 'entry', protocol: 'apple' } });
});

test('invalid numbers are refused with a reason instead of being sent', () => {
  assert.match(/** @type {any} */ (buildTriggerCommand('pd', form({ position: 0 }))).error, /PDO position/);
  assert.match(/** @type {any} */ (buildTriggerCommand('ufcs', form({ position: 1.5 }))).error, /Request position/);
  assert.match(/** @type {any} */ (buildTriggerCommand('scp', form({ voltMv: 70000 }))).error, /Voltage/);
  assert.match(/** @type {any} */ (buildTriggerCommand('pd', form({ curMa: Number.NaN }))).error, /Current/);
  assert.match(/** @type {any} */ (buildTriggerCommand('fcp', form({ volt: '20V' }))).error, /Select a voltage/);
  // Fields a protocol does not use are not validated.
  assert.ok('cmd' in buildTriggerCommand('qc', form({ position: 0, curMa: -1 })));
});

test('pd data keeps hex digits only and needs whole bytes', () => {
  assert.equal(cleanHex('01 8f-14 01'), '018F1401');
  assert.equal(cleanHex('abc'), null);
  assert.equal(cleanHex(''), null);
});

test('scans get the long waits, and PDM-free commands are exactly open/close/raw', () => {
  assert.equal(triggerTimeoutMs({ type: 'list', plus: false }), 270_000);
  assert.equal(triggerTimeoutMs({ type: 'list', plus: true }), 450_000);
  assert.equal(triggerTimeoutMs({ type: 'pd_req' }), 45_000);
  assert.deepEqual(
    ['pdm_open', 'pdm_close', 'raw', 'pdm_set', 'pd_pdo', 'reset'].map((type) => commandNeedsPdm({ type })),
    [false, false, false, true, true, true],
  );
});

test('outcome heads distinguish scans, successes and failures', () => {
  assert.equal(outcomeHead(outcome()), 'OK');
  assert.equal(outcomeHead(outcome({ ok: false, message: 'fail' })), 'ERR');
  assert.equal(outcomeHead(outcome({ protocols: [{ id: 'pd', label: 'PD' }] })), 'OK');
  assert.equal(outcomeHead(outcome({ message: 'pdm_open: OK' })), 'OK');
  assert.equal(outcomeHead(outcome({ ok: false, protocols: [{ id: 'pd', label: 'PD' }] })), 'ERR');
});

test('partial scan results never become successful merely because one protocol was detected', () => {
  const result = {
    id: 'pd',
    label: 'PD',
    state: /** @type {const} */ ('supported'),
    source: 'scan',
    detail: 'PD: OK',
    reason: '',
  };
  const detection = {
    results: [result],
    phase: 'finished',
    active: null,
    completion: 'partial',
    pdm_version: null,
    fallback_used: true,
    elapsed_ms: 100,
    diagnostics: [],
  };
  assert.equal(
    outcomeHead(outcome({ ok: false, detection, protocols: [{ id: 'pd', label: 'PD' }] })),
    'Detection incomplete',
  );
  assert.equal(detectionSummary({ ...detection, completion: 'cancelled' }), 'Command cancelled');
  assert.equal(detectionStateLabel({ ...result, state: 'not_checked' }), 'Not checked');
  assert.equal(detectionCanSelect(result), true);
  assert.equal(detectionCanSelect({ ...result, state: 'failed' }), false);
  assert.equal(detectionCanSelect({ ...result, id: 'svooc' }), false);
});

test('detection terminal states separate partial results from command failure', () => {
  const detection = (completion) => ({ completion });
  assert.equal(outcomeHistoryStatus(outcome({ detection: detection('complete') })), 'success');
  assert.equal(
    outcomeHistoryStatus(outcome({ detection: detection('partial') })),
    'partial',
    'unconfirmed rows do not make a normally finished command fail',
  );
  assert.equal(outcomeHistoryStatus(outcome({ ok: false, detection: detection('failed') })), 'failure');
  assert.equal(outcomeHistoryStatus(outcome({ ok: false, detection: detection('timeout') })), 'failure');
  assert.equal(outcomeHistoryStatus(outcome({ ok: false, detection: detection('cancelled') })), 'cancelled');
  assert.equal(outcomeHistoryStatus(outcome({ ok: false }), { cancelRequested: true }), 'cancelled');
  assert.equal(outcomeHistoryStatus(outcome({ ok: false }), { cancelRequested: true, timedOut: true }), 'failure');
  assert.equal(
    outcomeHistoryStatus(outcome({ detection: detection('complete'), protocols: [] })),
    'success',
    'a complete scan with no supported protocols is still a successful scan',
  );
});

test('PD version display prefers a standard response and does not understate PDO capability', () => {
  const base = { id: 'pd', label: 'PD', state: 'supported', source: 'probe', detail: '', reason: '' };
  assert.match(
    pdVersionLabel({
      ...base,
      pd_revision: { revision_major: 3, revision_minor: 2, version_major: 1, version_minor: 2 },
      pd_reported_version: { major: 3, minor: 1 },
      pd_version_inference: { minimum_major: 3, minimum_minor: 0, basis: 'pps' },
    }),
    /PD 3\.2.*1\.2/,
  );
  assert.match(pdVersionLabel({ ...base, pd_reported_version: { major: 3, minor: 1 } }), /PD 3\.1.*meter scan/);
  assert.match(
    pdVersionLabel({
      ...base,
      pd_reported_version: { major: 3, minor: 0 },
      pd_version_inference: { minimum_major: 3, minimum_minor: 1, basis: 'epr' },
    }),
    /at least PD 3\.1.*EPR PDO/i,
  );
  assert.match(
    pdVersionLabel({
      ...base,
      pd_reported_version: { major: 3, minor: 2 },
      pd_version_inference: { minimum_major: 3, minimum_minor: 0, basis: 'pps' },
    }),
    /PD 3\.2.*meter scan/,
  );
  assert.match(
    pdVersionLabel({
      ...base,
      pd_version_inference: { minimum_major: 3, minimum_minor: 2, basis: 'spr_avs' },
    }),
    /at least PD 3\.2/i,
  );
  assert.match(pdVersionLabel(base), /cannot be inferred/i);
});

test('detection voltage display uses only scoped capabilities and preserves ranges', () => {
  const result = {
    id: 'pd',
    label: 'PD',
    state: /** @type {const} */ ('supported'),
    source: 'probe',
    reason: '',
    detail: 'QC2.0:5V,9V,12V\nFixed:20V 5A',
    voltages: [
      { kind: 'fixed', volt_min_mv: 5000, volt_max_mv: 5000 },
      { kind: 'pps', volt_min_mv: 3300, volt_max_mv: 21000 },
      { kind: 'pps', volt_min_mv: 3300, volt_max_mv: 21000 },
      { kind: 'spr_avs', volt_min_mv: 9000, volt_max_mv: 15000 },
    ],
  };
  assert.deepEqual(detectionVoltages(result), ['5 V', 'PPS 3.3–21 V', 'SPR AVS 9–15 V']);
  assert.deepEqual(detectionVoltages({ ...result, state: 'failed' }), []);
  assert.deepEqual(detectionVoltages({ ...result, voltages: undefined }), [], 'do not mine a mixed raw log');
  assert.deepEqual(
    detectionVoltages({ ...result, id: 'qc', voltages: [{ kind: 'verified', volt_min_mv: 5000, volt_max_mv: 5000 }] }),
    ['5 V verified'],
  );
});

test('the log shows streamed progress when the final reply is empty, newest first, bounded', () => {
  let log = prependOutcome('', outcome({ message: '' }), 'PD : OK\nQC2.0 : OK', '10:00:00');
  assert.equal(log, '[10:00:00] OK\nPD : OK\nQC2.0 : OK');
  log = prependOutcome(
    log,
    outcome({ ok: false, message: 'request rejected', code: 'protocol_rejected' }),
    '',
    '10:00:01',
  );
  assert.ok(log.startsWith('[10:00:01] ERR\nrequest rejected\n\n[10:00:00] OK'));
  const huge = prependOutcome('', outcome({ message: 'x'.repeat(LOG_LIMIT * 2) }), '', 't');
  assert.equal(huge.length, LOG_LIMIT);
});

test('command history can be filtered, copied and exported with status and timing', () => {
  const entries = [
    {
      id: 'new',
      command: { type: 'pd_req', position: 3, volt_mv: 15000, cur_ma: 3000 },
      startedAt: 1_700_000_000_000,
      elapsedMs: 240,
      status: /** @type {const} */ ('success'),
      progress: '> pd_req\nAccept, PS_RDY',
      reply: 'PDO #3: 15.00V',
    },
    {
      id: 'old',
      command: { type: 'pd_data', hex: '018F1401A000FF' },
      startedAt: 1_700_000_001_000,
      elapsedMs: 81,
      status: /** @type {const} */ ('failure'),
      progress: '> pd_data',
      reply: 'unsupported custom data',
    },
  ];

  assert.equal(summarizeTriggerCommand(entries[0].command), 'pd_req position=3 volt_mv=15000 cur_ma=3000');
  assert.deepEqual(
    filterTriggerHistory(entries, { command: 'pd_req' }).map((entry) => entry.id),
    ['new'],
  );
  assert.deepEqual(
    filterTriggerHistory(entries, { status: 'failure' }).map((entry) => entry.id),
    ['old'],
  );
  assert.deepEqual(
    filterTriggerHistory(entries, { text: 'custom data' }).map((entry) => entry.id),
    ['old'],
  );
  assert.match(formatTriggerHistoryEntry(entries[0]), /pd_req position=3/);
  assert.match(formatTriggerHistoryEntry(entries[0]), /240 ms/);
  assert.match(exportTriggerHistory(entries), /Accept, PS_RDY/);
  assert.match(exportTriggerHistory(entries), /unsupported custom data/);
});

test('partial command history has a neutral label, filter value and export entry', () => {
  const entry = {
    id: 'partial',
    command: { type: 'list', plus: false },
    startedAt: 1_700_000_000_000,
    elapsedMs: 1700,
    status: /** @type {const} */ ('partial'),
    progress: 'entry list\ndone',
    reply: 'FCP: no response',
  };
  assert.match(formatTriggerHistoryEntry(entry), /Partially complete/);
  assert.deepEqual(filterTriggerHistory([entry], { status: 'partial' }), [entry]);
  assert.match(exportTriggerHistory([entry]), /FCP: no response/);
});

test('command history trims oldest commands and bounds a single oversized raw reply', () => {
  const entry = (id, reply) => ({
    id,
    command: { type: 'raw', command: `test ${id}` },
    startedAt: 1_700_000_000_000,
    elapsedMs: 1,
    status: /** @type {const} */ ('success'),
    progress: '',
    reply,
  });
  const bounded = trimTriggerHistory([entry('new', 'a'.repeat(34_000)), entry('old', 'b'.repeat(34_000))]);
  assert.equal(bounded.length, 1, 'oldest entry is dropped to keep the visible log under 64 KB');
  assert.equal(bounded[0].id, 'new');
  assert.ok(exportTriggerHistory(bounded).length <= LOG_LIMIT);

  const single = trimTriggerHistory([entry('single', 'x'.repeat(LOG_LIMIT * 2))]);
  assert.ok(exportTriggerHistory(single).length <= LOG_LIMIT);
  assert.ok(single[0].reply.length < LOG_LIMIT);
});

test('PDO rows read like the meter and fill the request form sensibly', () => {
  const fixed = {
    position: 2,
    kind: 'fixed',
    volt_min_mv: 9000,
    volt_max_mv: 9000,
    cur_ma: 3000,
    label: '',
    programmable: false,
  };
  const pps = {
    position: 4,
    kind: 'pps',
    volt_min_mv: 3300,
    volt_max_mv: 11000,
    cur_ma: 5000,
    label: '',
    programmable: true,
  };
  const battery = {
    position: 5,
    kind: 'battery',
    volt_min_mv: 5000,
    volt_max_mv: 20000,
    label: '',
    programmable: true,
  };
  assert.deepEqual(describePdo(fixed), { position: '#2', kind: 'Fixed', voltage: '9.00 V', current: '3.00 A' });
  assert.deepEqual(describePdo(pps), { position: '#4', kind: 'PPS', voltage: '3.30–11.00 V', current: '5.00 A' });
  assert.equal(describePdo(battery).current, '—');
  assert.deepEqual(pdoToRequestFields(fixed, form({ voltMv: 5000 })), {
    proto: 'pd',
    position: 2,
    voltMv: 9000,
    curMa: 3000,
  });
  assert.equal(pdoToRequestFields(pps, form({ voltMv: 20000 })).voltMv, 11000, 'clamped into the PPS range');
  assert.equal(pdoToRequestFields(pps, form({ voltMv: 9000 })).voltMv, 9000);
  assert.equal(
    pdoToRequestFields(battery, form({ curMa: 1500 })).curMa,
    1500,
    'no nominal current keeps the form value',
  );
});

test('only POWER-Z devices offer protocol control; older payloads count as WITRN', () => {
  assert.equal(deviceSupportsControl(null), false);
  assert.equal(deviceSupportsControl({}), false);
  assert.equal(deviceSupportsControl({ family: 'witrn', controls: false }), false);
  assert.equal(deviceSupportsControl({ family: 'km003c', controls: true }), true);
  assert.equal(deviceSupportsControl({ family: 'km003c', controls: false }), false);
});
