/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import { summarize } from '../../src/pd-model.js';
import fixtures from './pd-fixtures.json';
import { DEVICES, EPOCH, meterAt, PD_HANDSHAKES, PDOS, PROTOCOLS } from './scenario.js';

// This bridge is served only by the development server. Production has no dependency on it.
const options = new URLSearchParams(location.search);
const RealDate = Date;
let timeMs = 0;
let frozen = options.get('capture') === '1';
let advancing = false;
let device = null;
let generation = 0;
let seq = 0;
let acknowledged = 0;
let segment = 0;
let sessionStart = 0;
let segmentStart = 0;
let rate = 10;
let nextSample = 0;
let pdEnabled = false;
let pdGeneration = 0;
let pdCursor = 0;
let pdmOpen = false;
let targetVoltage = null;
let trigger = null;
let triggerCalls = 0;
let triggerDelayMs = null;
let failNextTrigger = false;
let nextDetectionCompletion = 'complete';
let pdVersionCapabilitiesEnabled = true;
let maximized = false;
let fullscreen = false;
let minimized = false;
let closed = false;
const handlers = new Map();
const pdLog = [];
const errors = [];
const files = new Map();
const textExports = [];
let fileId = 0;
const stored = new Map([
  [
    'appSettings',
    {
      theme: options.get('theme') === 'dark' ? 'dark' : options.get('theme') === 'system' ? 'system' : 'light',
      language: options.get('language') || 'auto',
      windowStyle: 'windows',
      sampleRate: 10,
      showDpDn: true,
      showCc: true,
      showTemp: true,
      tempSource: 'device',
      activeView: 'monitor',
      pdSplitSide: false,
      recordingTempSpool: true,
      uiScalePercent: 100,
    },
  ],
]);

window.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [EPOCH + timeMs]));
  }
  static now() {
    return EPOCH + timeMs;
  }
};
localStorage.setItem('lapower-theme', stored.get('appSettings').theme);
localStorage.setItem('lapower-window-style', 'windows');

function emit(name, payload) {
  for (const handler of handlers.get(name) ?? []) handler({ event: name, payload });
}
async function listen(name, handler) {
  if (!handlers.has(name)) handlers.set(name, new Set());
  handlers.get(name).add(handler);
  return () => handlers.get(name).delete(handler);
}
function boundary() {
  return {
    generation,
    after_seq: seq,
    segment,
    received_us: (timeMs - sessionStart) * 1000,
    wall_anchor_ms: EPOCH + sessionStart,
    rate_ms: rate,
  };
}
function verifyGeneration(args) {
  if (!device || (args.generation != null && args.generation !== generation)) {
    throw new Error('No matching virtual device session');
  }
}
function appendPd(at, fixture) {
  const last = meterAt(at, targetVoltage);
  const entry = {
    ...summarize(fixture.meta),
    bytes: fixture.bytes,
    meta: fixture.meta,
    t: EPOCH + at,
    seq: pdLog.length,
    gen: pdGeneration,
    vbus: last.voltage,
    ibus: last.current,
  };
  pdLog.push(entry);
  const { meta: _meta, ...compact } = entry;
  return compact;
}
function emitPd(until) {
  const batch = [];
  while (pdCursor < PD_HANDSHAKES.length * 7) {
    const handshake = PD_HANDSHAKES[Math.floor(pdCursor / 7)];
    const index = pdCursor % 7;
    const at = handshake.at + index * 45;
    if (at > until) break;
    pdCursor++;
    const fixtureIndex = [0, 1, handshake.position + 1, 7, 8, 9, 10][index];
    if (pdEnabled) batch.push(appendPd(at, fixtures[fixtureIndex]));
  }
  if (batch.length) emit('pd-data-batch', batch);
}
async function advance(ms) {
  if (!Number.isFinite(ms) || ms < 0 || ms > 300_000) throw new Error('Advance must be 0..300000 ms');
  if (advancing) throw new Error('Virtual clock is already advancing');
  advancing = true;
  try {
    const until = timeMs + ms;
    if (!device) {
      timeMs = until;
      return;
    }
    while (device && nextSample <= until) {
      const batch = [];
      while (batch.length < 256 && nextSample <= until) {
        timeMs = nextSample;
        batch.push({
          ...meterAt(timeMs, targetVoltage),
          generation,
          seq: ++seq,
          segment,
          received_us: (timeMs - sessionStart) * 1000,
          wall_anchor_ms: EPOCH + sessionStart,
          segment_start_us: (segmentStart - sessionStart) * 1000,
          rate_ms: rate,
        });
        nextSample += rate;
      }
      emit('device-data-batch', batch);
      emitPd(timeMs);
      await new Promise((accept) => setTimeout(accept, 0));
      if (seq - acknowledged > 4096) throw new Error('Virtual stream acknowledgment stalled');
    }
    timeMs = until;
    if (device) emitPd(until);
  } finally {
    advancing = false;
  }
}

function newFile(name, spool = false, bytes = new Uint8Array()) {
  const handle = ++fileId;
  const file = { handle, name, path: `memory://${name}`, size: bytes.length, bytes, cursor: 0, spool };
  files.set(handle, file);
  return { handle, name, path: file.path, size: file.size };
}
function fileFor(handle) {
  const file = files.get(Number(handle));
  if (!file) throw new Error(`Unknown virtual file handle: ${handle}`);
  return file;
}
function chooseFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}
function download(file) {
  const url = URL.createObjectURL(new Blob([file.bytes]));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function runTrigger(args) {
  verifyGeneration(args);
  if (!device.controls) throw new Error('WITRN has no protocol control interface');
  if (trigger) throw new Error('A virtual trigger is already running');
  const { cmd, reqId } = args;
  if (!pdmOpen && !['pdm_open', 'pdm_close', 'raw'].includes(cmd.type)) throw new Error('PDM is closed');
  const supported = [
    'pdm_open',
    'pdm_close',
    'pdm_set',
    'pd_pdo',
    'list',
    'reset',
    'pd_req',
    'qc',
    'qc3',
    'qc3_adjust',
    'fcp',
    'afc',
    'sfcp',
    'scp',
    'vfcp',
    'ufcs',
    'entry',
    'pd_cmd',
    'pd_data',
    'ufcs_pdo',
    'raw',
  ];
  if (!supported.includes(cmd.type)) throw new Error(`Unsupported virtual trigger: ${cmd.type}`);
  triggerCalls++;
  const active = { cancelled: false, generation };
  trigger = active;
  try {
    emit('km003c-trigger-progress', { generation, req_id: reqId, text: `> ${cmd.type}` });
    await new Promise((accept) => setTimeout(accept, triggerDelayMs ?? (frozen ? 0 : 200)));
    if (failNextTrigger) {
      failNextTrigger = false;
      throw new Error('Virtual trigger failure');
    }
    if (active.cancelled || !device || generation !== active.generation) throw new Error('Virtual trigger cancelled');
    if (cmd.type === 'pdm_open') pdmOpen = true;
    if (cmd.type === 'pdm_close') pdmOpen = false;
    if (cmd.type === 'reset') targetVoltage = null;
    if (cmd.type === 'pd_req') {
      const pdo = PDOS.find((entry) => entry.position === cmd.position);
      if (!pdo) throw new Error('Unknown PDO');
      targetVoltage = (pdo.programmable ? cmd.volt_mv : pdo.volt_max_mv) / 1000;
    } else if (cmd.volt_mv != null) targetVoltage = cmd.volt_mv / 1000;
    else if (cmd.voltage) targetVoltage = Number.parseFloat(cmd.voltage);
    if (cmd.type === 'qc3_adjust') targetVoltage = (targetVoltage ?? 5) + cmd.steps * 0.2;
    const listed = cmd.type === 'list';
    const detection = listed
      ? {
          results: [
            ...PROTOCOLS.map((p) => {
              const reportedPdos =
                p.id === 'pd' ? PDOS.filter((pdo) => pdVersionCapabilitiesEnabled || pdo.kind === 'fixed') : [];
              return {
                ...p,
                state: 'supported',
                source: p.id === 'pd' ? 'probe' : 'scan',
                detail:
                  p.id === 'pd'
                    ? reportedPdos.map((pdo) => pdo.label).join('\n')
                    : p.id === 'qc3'
                      ? `${p.label}: 3.6-12V`
                      : p.id === 'apple'
                        ? 'Apple 2.4A'
                        : `${p.label}: 5V,9V,12V`,
                voltages:
                  p.id === 'pd'
                    ? reportedPdos.map(({ kind, volt_min_mv, volt_max_mv }) => ({ kind, volt_min_mv, volt_max_mv }))
                    : p.id === 'qc3'
                      ? [{ kind: 'range', volt_min_mv: 3600, volt_max_mv: 12000 }]
                      : p.id === 'apple'
                        ? []
                        : [5000, 9000, 12000].map((mv) => ({ kind: 'fixed', volt_min_mv: mv, volt_max_mv: mv })),
                ...(reportedPdos.some((pdo) => pdo.kind === 'spr_avs')
                  ? {
                      pd_version_inference: {
                        minimum_major: 3,
                        minimum_minor: 2,
                        basis: 'spr_avs',
                      },
                    }
                  : {}),
                reason: '',
              };
            }),
            ...['BC 1.2', 'UFCS', 'VFCP', 'SCP', 'SFCP', 'TFCP'].map((label) => ({
              id: label === 'BC 1.2' ? 'bc' : label.toLowerCase(),
              label,
              state: 'unsupported',
              source: 'scan',
              detail: `${label}: null`,
              reason: '',
            })),
            ...[
              ['vooc', 'VOOC'],
              ['svooc', 'SVOOC'],
              ['pe1', 'MTK PE 1.0'],
              ['pe2', 'MTK PE 2.0'],
            ].map(([id, label]) => ({
              id,
              label,
              state: cmd.plus ? 'unsupported' : 'not_checked',
              source: cmd.plus ? 'scan' : 'none',
              detail: cmd.plus ? `${label}: null` : '',
              reason: cmd.plus ? '' : 'not_requested',
            })),
          ],
          phase: 'finished',
          pdos: PDOS.filter((pdo) => pdVersionCapabilitiesEnabled || pdo.kind === 'fixed'),
          active: null,
          completion: nextDetectionCompletion,
          pdm_version: '1.1',
          fallback_used: false,
          elapsed_ms: 200,
          diagnostics: [],
        }
      : undefined;
    if (listed) nextDetectionCompletion = 'complete';
    if (listed) {
      targetVoltage = null;
      emit('km003c-trigger-progress', { generation, req_id: reqId, text: '', detection });
    }
    const message = listed
      ? PROTOCOLS.map((entry) => `${entry.label}: OK`).join('\n')
      : cmd.type === 'pd_pdo'
        ? 'Source_Capabilities: 5V / 9V / 12V / 15V / 20V + PPS 3.3–21V\nOK'
        : cmd.type === 'pd_req'
          ? `PDO #${cmd.position}: ${targetVoltage.toFixed(2)}V — Accept, PS_RDY\nOK`
          : `${cmd.type}: OK`;
    emit('km003c-trigger-progress', { generation, req_id: reqId, text: message });
    return {
      ok: true,
      message,
      pdos: listed || cmd.type === 'pd_pdo' || cmd.type === 'pd_req' ? PDOS : [],
      protocols: listed ? PROTOCOLS : [],
      detection,
      pdm_open: pdmOpen,
    };
  } finally {
    if (trigger === active) trigger = null;
  }
}

async function invoke(command, args = {}, ipc = {}) {
  if (command.startsWith('plugin:store|')) {
    const operation = command.split('|')[1];
    switch (operation) {
      case 'load':
      case 'get_store':
        return 1;
      case 'get':
        return [stored.get(args.key) ?? null, stored.has(args.key)];
      case 'set':
        stored.set(args.key, structuredClone(args.value));
        return;
      case 'has':
        return stored.has(args.key);
      case 'delete':
        return stored.delete(args.key);
      case 'clear':
      case 'reset':
        stored.clear();
        return;
      case 'keys':
        return [...stored.keys()];
      case 'values':
        return [...stored.values()];
      case 'entries':
        return [...stored.entries()];
      case 'length':
        return stored.size;
      case 'save':
      case 'close':
      case 'reload':
        return;
      default:
        throw new Error(`Unsupported virtual store operation: ${operation}`);
    }
  }
  switch (command) {
    case 'check_for_updates': {
      emit('showcase:update-check', null);
      const mode = options.get('update') || 'current';
      if (mode === 'pending') return new Promise(() => {});
      if (
        [
          'updateTimeout',
          'updateNetworkError',
          'updateRateLimited',
          'updateServiceError',
          'updateInvalidResponse',
        ].includes(mode)
      )
        throw { code: mode };
      if (mode === 'invalid') return { status: 'invalid' };
      const newer = mode === 'available';
      return {
        status: mode === 'none' ? 'no_release' : newer ? 'available' : 'current',
        current_version: __SHOWCASE_VERSION__,
        latest_version: mode === 'none' ? null : newer ? '99.0.0' : mode === 'older' ? '0.0.1' : __SHOWCASE_VERSION__,
        tag: mode === 'none' ? null : newer ? 'v99.0.0' : `v${__SHOWCASE_VERSION__}`,
      };
    }
    case 'open_project_page':
      emit('showcase:project-page', args);
      return;
    case 'get_runtime_platform':
      return 'windows';
    case 'get_system_locale':
      return options.get('systemLocale') || navigator.language;
    case 'report_boot_timing':
      return;
    case 'enumerate_devices':
      return structuredClone(DEVICES);
    case 'get_current_device_info':
      return device ? structuredClone(device) : null;
    case 'connect_device_by_path': {
      if (device) throw new Error('Virtual device already connected');
      device = DEVICES.find((entry) => entry.path === args.path);
      if (!device) throw new Error('Unknown virtual device');
      generation++;
      seq = 0;
      acknowledged = 0;
      segment = 0;
      sessionStart = timeMs;
      segmentStart = timeMs;
      nextSample = timeMs;
      pdmOpen = false;
      targetVoltage = null;
      const open = { generation, wall_anchor_ms: EPOCH + sessionStart };
      emit('device-stream-open', open);
      return open;
    }
    case 'set_sample_rate': {
      if (!Number.isInteger(args.rate) || args.rate < (device?.family === 'witrn' ? 10 : 1) || args.rate > 60000) {
        throw new Error('Invalid virtual sample interval');
      }
      if (device) verifyGeneration(args);
      rate = args.rate;
      nextSample = timeMs + rate;
      return device ? boundary() : null;
    }
    case 'set_recording_segment':
      verifyGeneration(args);
      segment = args.segment;
      segmentStart = timeMs;
      pdEnabled = args.pdEnabled === true;
      return boundary();
    case 'ack_device_stream':
      if (args.generation !== generation || args.seq > seq || args.seq < acknowledged)
        throw new Error('Invalid virtual ACK');
      acknowledged = args.seq;
      return;
    case 'drain_device_stream': {
      if (!generation) return null;
      if (args.generation !== generation) throw new Error('Stale virtual drain');
      const end = { generation, last_seq: seq, error: null };
      device = null;
      segment = 0;
      pdmOpen = false;
      if (trigger) trigger.cancelled = true;
      emit('device-stream-end', end);
      return end;
    }
    case 'abandon_device_stream':
      device = null;
      segment = 0;
      return;
    case 'set_pd_capture_enabled':
      pdEnabled = args.enabled === true;
      return;
    case 'pd_log_clear':
      pdLog.length = 0;
      return ++pdGeneration;
    case 'pd_log_after': {
      if (args.generation != null && args.generation !== pdGeneration) throw new Error('Stale PD generation');
      const throughSeq = pdLog.length ? Math.min(args.throughSeq ?? pdLog.length - 1, pdLog.length - 1) : null;
      return {
        generation: pdGeneration,
        throughSeq,
        events: pdLog
          .slice(args.afterSeq == null ? 0 : args.afterSeq + 1, throughSeq == null ? 0 : throughSeq + 1)
          .slice(0, 512)
          .map(({ meta: _meta, ...entry }) => entry),
      };
    }
    case 'decode_pd_at': {
      if (args.generation !== pdGeneration) throw new Error('Stale PD generation');
      const entry = pdLog[args.index];
      if (!entry) throw new Error('Unknown virtual PD index');
      return structuredClone(entry.meta);
    }
    case 'pd_log_replace': {
      const replacements = args.entries.map((entry) => {
        if (entry.divider) return { entry, fixture: null };
        const fixture = fixtures.find((sample) => JSON.stringify(sample.bytes) === JSON.stringify(entry.bytes));
        if (!fixture) throw new Error('Virtual PD import supports only the bundled fixture reports');
        return { entry, fixture };
      });
      pdLog.length = 0;
      pdGeneration++;
      return replacements.map(({ entry, fixture }) => {
        if (entry.divider) return { t: entry.t, divider: true, gen: pdGeneration };
        return { ...appendPd(entry.t - EPOCH, fixture), vbus: entry.vbus, ibus: entry.ibus };
      });
    }
    case 'km003c_trigger':
      return runTrigger(args);
    case 'km003c_cancel_trigger':
      verifyGeneration(args);
      if (trigger) trigger.cancelled = true;
      return;
    case 'connect_temp_service':
      emit('temp-data', meterAt(timeMs).temperature);
      return;
    case 'disconnect_temp_service':
      return;
    case 'plugin:decorum|show_snap_overlay':
      return;
    case 'spool_recovery_list':
      return [];
    case 'spool_recovery_delete':
      return;
    case 'spool_open':
      return newFile(`${args.stem}.csv`, true);
    case 'csv_export_pick':
    case 'pd_export_pick':
    case 'png_export_pick':
      return newFile(args.defaultName);
    case 'paired_export_pick':
      return { csv: newFile(args.defaultName), pd: newFile(args.defaultName.replace(/\.csv$/i, '.pd.json')) };
    case 'video_export_pick':
      // The preview never writes a video: a stable virtual ticket is enough to drive the
      // dialog's state machine, and the encoder path is native-only.
      videoJob = null;
      return { ticket: 'showcase-ticket', name: args.defaultName };
    case 'video_export_capability':
      return videoCapability(args.options ?? {});
    case 'video_export_start': {
      const options = args.request?.payload?.options ?? {};
      videoJob = {
        id: `showcase-video-${++videoJobCounter}`,
        state: 'encoding',
        progress: 0,
        options,
        path: null,
        name: null,
        // Published the moment encoding starts, like the native host: the dialog must never have
        // to guess, and a preview that reports "software" here hides real reporting bugs.
        encoder: options.reportType === 'image' ? 'png' : videoCapability(options).encoder,
        fallback:
          options.reportType !== 'image' && options.acceleration === 'auto' && virtualEncoder === 'software'
            ? 'the virtual GPU path is disabled'
            : null,
        error: null,
      };
      videoJobStarted = performance.now();
      return structuredClone(videoJob);
    }
    case 'video_export_status': {
      if (!videoJob || videoJob.id !== args.id) throw new Error('videoJobUnknown');
      advanceVideoJob();
      return structuredClone(videoJob);
    }
    case 'video_export_current':
      // Advancing on every read (not only on status polls) keeps the virtual job moving while the
      // dialog is closed, which is what the native host does.
      advanceVideoJob();
      return videoJob ? structuredClone(videoJob) : null;
    case 'video_export_cancel':
      if (!videoJob || videoJob.id !== args.id) throw new Error('videoJobUnknown');
      videoJob.state = 'cancelled';
      return structuredClone(videoJob);
    case 'csv_import_pick': {
      const file = await chooseFile('.csv');
      return file ? newFile(file.name, false, new Uint8Array(await file.arrayBuffer())) : null;
    }
    case 'csv_read_chunk': {
      const file = fileFor(args.handle);
      const bytes = file.bytes.slice(file.cursor, file.cursor + 4 * 1024 * 1024);
      file.cursor += bytes.length;
      return bytes.buffer;
    }
    case 'csv_read_close':
      files.delete(args.handle);
      return;
    case 'csv_write_chunk': {
      const file = fileFor(ipc.headers['x-handle']);
      const bytes = new Uint8Array(args);
      const joined = new Uint8Array(file.bytes.length + bytes.length);
      joined.set(file.bytes);
      joined.set(bytes, file.bytes.length);
      file.bytes = joined;
      file.size = joined.length;
      return;
    }
    case 'csv_write_patch': {
      const file = fileFor(ipc.headers['x-handle']);
      const bytes = new Uint8Array(args);
      const offset = Number(ipc.headers['x-offset']);
      if (offset < 0 || offset + bytes.length > file.bytes.length) throw new Error('Invalid virtual file patch');
      file.bytes.set(bytes, offset);
      return;
    }
    case 'csv_write_sync':
      fileFor(args.handle);
      return;
    case 'csv_write_close': {
      const file = fileFor(args.handle);
      if (!file.spool && !args.options?.abort) download(file);
      files.delete(args.handle);
      return;
    }
    case 'shutdown':
      closed = true;
      frozen = true;
      emit('showcase:closed', null);
      return;
    default: {
      const message = `Unsupported virtual Tauri command: ${command}`;
      errors.push(message);
      throw new Error(message);
    }
  }
}

/** Which encoder the preview claims; `?videoEncoder=software` exercises the fallback copy. */
const virtualEncoder = options.get('videoEncoder') === 'software' ? 'software' : 'hardware';

/** One virtual combination. Every combination the dialog offers can be encoded, like the host. */
function videoCapability({ width, height, fps, codec, acceleration = 'auto', quality = 'high' }) {
  const base = { standard: 10_000_000, high: 20_000_000, ultra: 30_000_000 }[quality] ?? 20_000_000;
  const bitrate = Math.round(
    Math.min(
      240_000_000,
      Math.max(
        codec === 'h265' ? 3_000_000 : 4_000_000,
        (base * (codec === 'h265' ? 0.65 : 1) * width * height * fps) / (1920 * 1080 * 30),
      ),
    ),
  );
  const available = acceleration !== 'hardware' || virtualEncoder === 'hardware';
  return {
    width,
    height,
    fps,
    codec,
    bitrate,
    available,
    reason: available ? null : 'the virtual GPU path is disabled',
    encoder: available ? (acceleration === 'software' ? 'software' : virtualEncoder) : null,
  };
}

/** The preview's single fake encode: wall-clock paced so closing the dialog still lets it finish. */
let videoJob = null;
let videoJobCounter = 0;
let videoJobStarted = 0;
const VIDEO_JOB_MS = 4000;

function advanceVideoJob() {
  if (!videoJob || videoJob.state !== 'encoding') return;
  videoJob.progress = Math.min(1, (performance.now() - videoJobStarted) / VIDEO_JOB_MS);
  if (videoJob.progress >= 1) {
    videoJob.state = 'completed';
    videoJob.progress = 1;
    videoJob.name = `lapower_report.${videoJob.options.reportType === 'image' ? 'png' : videoJob.options.format}`;
    videoJob.path = `C:/virtual/${videoJob.name}`;
  }
}

const appWindow = {
  isMaximized: async () => maximized,
  isFullscreen: async () => fullscreen,
  isVisible: async () => !closed && !minimized,
  isMinimized: async () => minimized,
  onResized: (handler) => listen('showcase:resize', handler),
  onFocusChanged: (handler) => listen('showcase:focus', handler),
  onCloseRequested: (handler) => listen('showcase:close', handler),
  startDragging: async () => {},
  startResizeDragging: async () => {},
  setFocus: async () => {
    minimized = false;
    emit('showcase:focus', null);
  },
  minimize: async () => {
    minimized = true;
    emit('showcase:focus', null);
  },
  toggleMaximize: async () => {
    maximized = !maximized;
    emit('showcase:resize', null);
  },
  setFullscreen: async (value) => {
    fullscreen = value;
    emit('showcase:resize', null);
  },
  close: async () => {
    for (const handler of handlers.get('showcase:close') ?? []) handler({ preventDefault() {} });
  },
  scaleFactor: async () => devicePixelRatio,
};
window.__TAURI__ = {
  core: { invoke },
  event: { listen, emit: async (name, payload) => emit(name, payload) },
  window: { getCurrentWindow: () => appWindow },
  app: { getVersion: async () => __SHOWCASE_VERSION__, getName: async () => 'laPower' },
  dialog: {
    save: async () => 'memory://trigger-history.txt',
    open: async () => {
      const file = await chooseFile('.json');
      if (!file) return null;
      files.set('pd-import', file);
      return 'memory://pd-import';
    },
  },
  fs: {
    writeTextFile: async (path, content) => {
      if (path !== 'memory://trigger-history.txt') throw new Error('Invalid virtual output path');
      textExports.push(String(content));
    },
    readTextFile: async (path) => {
      if (path !== 'memory://pd-import') throw new Error('Invalid virtual path');
      return files.get('pd-import').text();
    },
  },
};
window.__SHOWCASE__ = {
  advance,
  freeze: () => {
    frozen = true;
  },
  resume: () => {
    minimized = false;
    closed = false;
    frozen = false;
    emit('showcase:focus', null);
  },
  diagnostics: () => ({
    timeMs,
    frozen,
    advancing,
    connected: !!device,
    generation,
    seq,
    acknowledged,
    segment,
    pdEntries: pdLog.length,
    errors: [...errors],
    openFiles: files.size,
    triggerCalls,
    lastTextExport: textExports.at(-1) ?? null,
  }),
  setTriggerDelay: (ms) => {
    triggerDelayMs = Math.max(0, Number(ms) || 0);
  },
  resetTriggerDelay: () => {
    triggerDelayMs = null;
  },
  failNextTrigger: () => {
    failNextTrigger = true;
  },
  setNextDetectionCompletion: (completion) => {
    nextDetectionCompletion = ['partial', 'failed', 'timeout', 'cancelled'].includes(completion)
      ? completion
      : 'complete';
  },
  setPdVersionCapabilities: (enabled) => {
    pdVersionCapabilitiesEnabled = enabled === true;
  },
  async waitFor(predicate) {
    const deadline = performance.now() + 10000;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error('Virtual state timed out');
      await new Promise((accept) => setTimeout(accept, 20));
    }
  },
};
setInterval(() => {
  if (!frozen && !advancing && device)
    void advance(50).catch((error) => {
      frozen = true;
      errors.push(String(error));
      console.error(error);
    });
}, 50);
// Same IDs/classes as tauri-plugin-decorum 1.1.1. Existing windowcontrols.js supplies icons.
document.addEventListener(
  'DOMContentLoaded',
  () => {
    const container = document.createElement('div');
    container.setAttribute('data-tauri-decorum-tb', '');
    for (const [name, action] of [
      ['minimize', () => appWindow.minimize()],
      ['maximize', () => appWindow.toggleMaximize()],
      ['close', () => appWindow.close()],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `decorum-tb-${name}`;
      button.className = 'decorum-tb-btn';
      button.addEventListener('click', action);
      container.append(button);
    }
    document.body.append(container);
  },
  { once: true },
);
