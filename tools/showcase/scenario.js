// Development fixtures only. Sample values depend on virtual time and a fixed seed.
//
// v2/v3 (promo): the session is a 20-minute charge profile instead of a 2-minute loop.
// v3: the CV tail decays with a 2600 s constant so a 20-minute window still shows
//     ~2.7 A at 15 V (about 40 W) and the 2-minute load pulses stay visible.
//   0-12s    5V  attach, 0.32A
//   12-35s   9V  1.35A
//   35-60s   12V 1.85A
//   60-85s   15V 2.2A
//   85-100s  15V 3.2A   (fast charge)
//   100s+    CV taper   3.2A -> ~0.5A, with a 20s load pulse every 2 minutes
// A protocol trigger (targetVoltage) starts a fresh high-current load, so
// requesting 20V visibly jumps 15V/0.5A -> 20V/3A in the UI.
export const EPOCH = Date.UTC(2026, 9, 4, 4, 0, 0);
export const DURATION_MS = 120_000;
export const SEED = 0x6d2b79f5;
export const PD_HANDSHAKES = [
  { at: 1000, position: 1 },
  { at: 12000, position: 2 },
  { at: 35000, position: 3 },
  { at: 60000, position: 4 },
];
export const DEVICES = [
  {
    path: 'showcase:k2',
    vid: 0x0716,
    pid: 0x5060,
    model_name: 'WITRN K2',
    display_name: 'WITRN K2 (USB 4-4)',
    serial_number: '20230727',
    usb_port: '4-4',
    manufacturer: 'WITRN',
    product: 'K2',
    interface_number: 0,
    usage_page: 0xff00,
    family: 'witrn',
    controls: false,
    max_rate_hz: 100,
  },
  {
    path: 'showcase:km003c',
    vid: 0x5fc9,
    pid: 0x0063,
    model_name: 'POWER-Z KM003C',
    display_name: 'POWER-Z KM003C (USB 4-5)',
    serial_number: 'KM003C-DEMO-001',
    usb_port: '4-5',
    manufacturer: 'ChargerLAB',
    product: 'KM003C',
    interface_number: 0,
    usage_page: 0,
    family: 'km003c',
    controls: true,
    max_rate_hz: 1000,
  },
];
export const PDOS = [
  ...[5, 9, 12, 15, 20].map((volts, i) => ({
    position: i + 1,
    kind: 'fixed',
    volt_min_mv: volts * 1000,
    volt_max_mv: volts * 1000,
    cur_ma: volts === 20 ? 3250 : 3000,
    label: `${volts}V`,
    programmable: false,
  })),
  { position: 6, kind: 'pps', volt_min_mv: 3300, volt_max_mv: 21000, cur_ma: 3000, label: 'PPS', programmable: true },
  {
    position: 7,
    kind: 'spr_avs',
    volt_min_mv: 9000,
    volt_max_mv: 20000,
    cur_ma: 3000,
    label: 'SPR AVS',
    programmable: true,
  },
];
export const PROTOCOLS = [
  { id: 'pd', label: 'PD 3.0' },
  { id: 'qc', label: 'QC 2.0' },
  { id: 'qc3', label: 'QC 3.0' },
  { id: 'afc', label: 'AFC' },
  { id: 'fcp', label: 'FCP' },
  { id: 'apple', label: 'Apple 2.4A' },
];

/** Deterministic white-ish noise in [-1, 1] for a 1ms grid. */
function noiseAt(ms, salt) {
  const hash = Math.imul(Math.floor(ms / 10) ^ SEED ^ (salt * 0x9e3779b1), 0x45d9f3b) >>> 0;
  return hash / 0xffffffff - 0.5;
}

/** 20s load pulse every 120s after the CV phase starts. */
function pulseAt(t) {
  if (t < 130) return 0;
  const phase = (t - 130) % 120;
  if (phase > 20) return 0;
  const edge = Math.min(phase, 20 - phase) / 2;
  return Math.min(1, edge) * (0.55 + 0.1 * Math.sin(phase * 0.9));
}

export function meterAt(ms, targetVoltage = null) {
  const t = ms / 1000;
  const fixed = t < 12 ? 5 : t < 35 ? 9 : t < 60 ? 12 : 15;

  // CV taper: 3.2A fast-charge, then an exponential decay to ~0.5A over ~15 min.
  const cv =
    t < 8
      ? 0.32
      : t < 35
        ? 1.35
        : t < 60
          ? 1.85
          : t < 85
            ? 2.2
            : t < 100
              ? 3.2
              : 0.5 + 2.7 * Math.exp(-(t - 100) / 2600);
  const load = t >= 100 ? 0.3 : 0;
  const triggered = targetVoltage != null;
  const voltage = (triggered ? targetVoltage : fixed) + Math.sin(t * 3.1) * 0.018 + noiseAt(ms, 1) * 0.02;
  const current = triggered
    ? 2.95 + noiseAt(ms, 2) * 0.06
    : cv + load + pulseAt(t) + noiseAt(ms, 3) * 0.05 + Math.sin(t * 1.7) * 0.02;
  const power = voltage * current;
  // First-order thermal model driven by the actual dissipation.
  const temperature = 26 + 3.3 * current + 6 * (1 - Math.exp(-t / 150)) + noiseAt(ms, 4) * 0.05;
  const afterEnum = t >= 12;
  return {
    voltage,
    current,
    power,
    temperature,
    dp: afterEnum ? 2.7 + noiseAt(ms, 5) * 0.03 : 0.6,
    dn: afterEnum ? 2.7 + noiseAt(ms, 6) * 0.03 : 0.08,
    cc1: 1.62 + Math.sin(t * 0.35) * 0.025,
    cc2: 0.32 + noiseAt(ms, 7) * 0.02,
  };
}
