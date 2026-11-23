/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
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
  reconcileTriggerTranscript,
  summarizeTriggerCommand,
  triggerTimeoutMs,
  trimTriggerHistory,
  validatePdData,
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

test('pd data preserves bytes and refuses malformed input', () => {
  assert.equal(cleanHex('01 8f-14 01'), '018F1401');
  assert.equal(cleanHex('0x01, 0x8f:0x14-0x01'), '018F1401');
  assert.equal(cleanHex('01 GG 02'), null);
  assert.equal(cleanHex('0x1 02'), null);
  assert.equal(cleanHex('abc'), null);
  assert.equal(validatePdData('008F5141A000FF992E0018181500000000000040400800'), 'valid');
  assert.equal(validatePdData('018F1401'), 'invalid');
  assert.equal(validatePdData('000080'), 'extended');
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

test('SPR AVS evidence survives lower or missing version summaries and conflicting revision replies', () => {
  const base = {
    id: 'pd',
    label: 'PD',
    state: 'supported',
    source: 'probe',
    reason: '',
    detail: 'max power 140W\nAVS: 9-20V3.00A,5.00A\nFixed: 28.00V 5.00A\nAVS: 15.00-28.00V 140W',
    voltages: [
      { kind: 'avs', volt_min_mv: 9000, volt_max_mv: 15000 },
      { kind: 'avs', volt_min_mv: 15000, volt_max_mv: 20000 },
      { kind: 'epr_fixed', volt_min_mv: 28000, volt_max_mv: 28000 },
      { kind: 'epr_avs', volt_min_mv: 15000, volt_max_mv: 28000 },
    ],
  };
  for (const summary of [undefined, { minimum_major: 3, minimum_minor: 1, basis: 'epr' }]) {
    assert.match(pdVersionLabel({ ...base, pd_version_inference: summary }), /at least PD 3\.2.*SPR AVS/i);
    assert.match(
      pdVersionLabel({ ...base, pd_version_inference: summary, pd_reported_version: { major: 3, minor: 1 } }),
      /at least PD 3\.2.*SPR AVS/i,
    );
    assert.match(
      pdVersionLabel({ ...base, pd_version_inference: summary, pd_reported_version: { major: 3, minor: 2 } }),
      /PD 3\.2.*meter scan/,
    );
  }
  const conflict = pdVersionLabel({
    ...base,
    pd_revision: { revision_major: 3, revision_minor: 1, version_major: 1, version_minor: 7 },
  });
  assert.match(conflict, /^At least PD 3\.2.*SPR AVS/i);
  assert.match(conflict, /conflict.*PD 3\.1.*Get_Revision/i, 'keep the contradictory response visible');
  assert.match(
    pdVersionLabel({
      ...base,
      voltages: [],
      pd_reported_version: { major: 3, minor: 2 },
      pd_revision: { revision_major: 3, revision_minor: 1, version_major: 1, version_minor: 7 },
    }),
    /^PD 3\.2.*meter scan.*conflict.*PD 3\.1/i,
    'a lower standard response cannot silently replace the meter scan either',
  );
  assert.match(
    pdVersionLabel({ ...base, voltages: [{ kind: 'spr_avs', volt_min_mv: 9000, volt_max_mv: 15000 }] }),
    /at least PD 3\.2.*SPR AVS/i,
  );
  assert.match(
    pdVersionLabel({ ...base, voltages: base.voltages.slice(2) }),
    /at least PD 3\.1.*EPR/i,
    'EPR AVS alone does not prove PD 3.2',
  );
  assert.match(
    pdVersionLabel({ ...base, voltages: [] }),
    /cannot be inferred/i,
    'a raw text log is not structured PDO evidence',
  );
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

test('final transcript fills missing events without duplicating the streamed preview', () => {
  const entry = {
    id: 'pdo',
    command: { type: 'pd_pdo' },
    startedAt: 0,
    elapsedMs: null,
    status: /** @type {const} */ ('running'),
    progress: '> pd pdo\nready',
    reply: '',
  };
  const transcript = '> pd pdo\nready\n#1 FIXED 5V\n#2 FIXED 9V';
  const final = reconcileTriggerTranscript(entry, outcome({ transcript }));
  assert.equal(final.progress, transcript);
  assert.equal(final.progress.match(/ready/g).length, 1);
  assert.equal(entry.progress, '> pd pdo\nready', 'the original preview stays independent');
  assert.equal(reconcileTriggerTranscript(entry, outcome()).progress, entry.progress, 'old backend compatibility');
  assert.equal(reconcileTriggerTranscript(entry, outcome({ transcript: '' })).progress, '');
  assert.equal(reconcileTriggerTranscript(entry, outcome({ transcript, transcript_truncated: true })).truncated, true);
  const repeated = [
    '> entry pd',
    'ok',
    'cc1 attach',
    'ready:5100mV,0mA',
    '> pd pdo',
    'ok',
    'cc1 detach',
    'cc2 attach',
    'ready:5097mV,0mA',
    '> pd pdo',
    'ok',
    'ready:5100mV,0mA',
    'ready:5100mV,0mA',
  ].join('\n');
  const reconciled = reconcileTriggerTranscript({ ...entry, progress: repeated }, outcome({ transcript: repeated }));
  assert.equal(reconciled.progress, repeated, 'identical replies at different times are separate occurrences');
  assert.equal(exportTriggerHistory([reconciled]).split('ready:5100mV,0mA').length - 1, 3);
});

test('large process logs retain lines above 16000 characters and trim only the necessary oldest lines', () => {
  const progress = Array.from({ length: 250 }, (_, i) => `stage-${i} ${'p'.repeat(100)}`).join('\n');
  const entry = {
    id: 'pdo',
    command: { type: 'pd_pdo' },
    startedAt: 0,
    elapsedMs: 1,
    status: /** @type {const} */ ('success'),
    progress,
    reply: 'OK',
  };
  assert.ok(progress.length > 16_000);
  assert.equal(trimTriggerHistory([entry])[0].progress, progress);
  const reply = Array.from({ length: 400 }, (_, i) => `reply-${i} ${'r'.repeat(100)}`).join('\n');
  const [trimmed] = trimTriggerHistory([{ ...entry, reply }]);
  assert.ok(trimmed.progress.length > 0, 'combined overflow must not clear the entire process');
  assert.ok(progress.endsWith(trimmed.progress));
  assert.match(trimmed.progress, /^stage-\d+ /, 'never retain a partial line');
  assert.equal(trimmed.reply, reply);
  assert.equal(trimmed.truncated, true);
  const exported = exportTriggerHistory([trimmed]);
  assert.ok(exported.length <= LOG_LIMIT);
  assert.match(exported, /Earlier log content was removed/);
  assert.ok(exported.includes(trimmed.progress));
  assert.ok(exported.includes(trimmed.reply));
  assert.deepEqual(trimTriggerHistory([trimmed]), [trimmed], 'repeated updates do not discard further content');
});

test('history eviction protects an active command even when a newer PDM status arrives', () => {
  const entry = {
    id: 'running',
    command: { type: 'list' },
    startedAt: 0,
    elapsedMs: null,
    status: /** @type {const} */ ('running'),
    progress: 'line\n'.repeat(11_000),
    reply: '',
  };
  const notice = {
    ...entry,
    id: 'pdm',
    command: { type: 'pdm_state' },
    status: /** @type {const} */ ('failure'),
    progress: '',
    reply: 'connection lost\n'.repeat(1000),
  };
  assert.deepEqual(
    trimTriggerHistory([notice, entry]).map((item) => item.id),
    ['running'],
  );
  const [final] = trimTriggerHistory([
    reconcileTriggerTranscript(
      entry,
      outcome({ transcript: `${entry.progress}final line`, transcript_truncated: true }),
    ),
  ]);
  assert.ok(final.progress.endsWith('final line'));
  assert.match(exportTriggerHistory([final]), /Earlier log content was removed/);
});

test('trimTriggerHistory handles many completed entries and long progress linearly within LOG_LIMIT', () => {
  const entries = Array.from({ length: 120 }, (_, index) => ({
    id: `cmd-${index}`,
    command: { type: 'raw', command: `cmd ${index}` },
    startedAt: 1_700_000_000_000 + index * 1000,
    elapsedMs: 12,
    status: /** @type {const} */ ('success'),
    progress: '',
    reply: `${'x'.repeat(1200)}\n`,
  }));
  const trimmed = trimTriggerHistory(entries);
  assert.ok(trimmed.length > 0 && trimmed.length < entries.length);
  assert.equal(trimmed[0].id, 'cmd-0', 'newest entries stay at the front');
  assert.ok(trimmed.map(formatTriggerHistoryEntry).join('\n\n').length <= LOG_LIMIT);
  assert.deepEqual(trimTriggerHistory(trimmed), trimmed, 'trimming is idempotent');
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

test('fixed PD requests omit ignored voltage and UFCS capabilities retain their own route', () => {
  const fixed = {
    position: 2,
    kind: 'fixed',
    volt_min_mv: 9000,
    volt_max_mv: 9000,
    cur_ma: 3000,
    programmable: false,
    label: '9V',
  };
  assert.deepEqual(buildTriggerCommand('pd', form({ voltMv: 5000 }), [fixed]), {
    cmd: { type: 'pd_req', position: 2, volt_mv: null, cur_ma: 3000 },
  });
  const ufcs = {
    ...fixed,
    protocol: 'ufcs',
    position: 3,
    kind: 'ufcs',
    volt_min_mv: 3400,
    volt_max_mv: 11000,
    programmable: true,
  };
  const fields = pdoToRequestFields(ufcs, form());
  assert.equal(fields.proto, 'ufcs');
  assert.equal(fields.position, 3);
  assert.deepEqual(buildTriggerCommand(fields.proto, { ...form(), ...fields }), {
    cmd: { type: 'ufcs', req: 3, volt_mv: 9000, cur_ma: 3000 },
  });
  assert.ok('cmd' in buildTriggerCommand('qc3', form({ voltMv: 5010 })));
  assert.ok('cmd' in buildTriggerCommand('vfcp', form({ voltMv: 5000 })));
});
