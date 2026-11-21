import assert from 'node:assert/strict';
import test from 'node:test';
import { createGpuiChartBridge, encodeGpuiChartFrame } from '../src/gpui-chart.js';

function frame(slot, left = 12) {
  return encodeGpuiChartFrame({
    slot,
    visible: true,
    left,
    top: 3,
    width: 100,
    height: 50,
    ratio: 1.5,
    series: [
      {
        channel: 2,
        color: 0x123456,
        width: 2.5,
        fillOpacity: 0.25,
        baseline: 48,
        points: [1, 2, Number.NaN, Number.NaN, 3, 4],
      },
    ],
  });
}

test('encodes GPUI chart metadata, color, geometry and gap separators', () => {
  const bytes = frame(1);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x4750_5549);
  assert.deepEqual([view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7)], [1, 1, 1, 1]);
  assert.deepEqual([view.getFloat32(8, true), view.getFloat32(12, true)], [12, 3]);
  assert.deepEqual([view.getUint32(32, true), view.getFloat32(36, true), view.getFloat32(40, true)], [2, 2.5, 0.25]);
  assert.deepEqual([view.getUint8(52), view.getUint8(53), view.getUint8(54)], [0x12, 0x34, 0x56]);
  assert.deepEqual(
    [view.getFloat32(56, true), view.getFloat32(60, true), view.getFloat32(64, true), view.getFloat32(68, true)],
    [1, 2, Number.NaN, Number.NaN],
  );
});

test('rejects malformed frame geometry before IPC', () => {
  assert.throws(
    () =>
      encodeGpuiChartFrame({
        ...decodeFrame(frame(0)),
        series: [{ ...decodeFrame(frame(0)).series[0], points: [1, Number.NaN] }],
      }),
    /paired NaNs/,
  );
});

test('coalesces pending native frames to the newest frame per surface', async () => {
  const frames = [];
  let releaseFirst;
  let holdNext = false;
  const bridge = createGpuiChartBridge(async (command, payload) => {
    if (command === 'gpui_chart_ready') return true;
    if (command === 'gpui_chart_frame') {
      const left = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getFloat32(8, true);
      frames.push(left);
      if (holdNext) {
        holdNext = false;
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
    }
  });

  assert.equal(await bridge.start(() => [frame(0), frame(1)]), true);
  frames.length = 0;
  holdNext = true;
  bridge.submit(0, frame(0, 20));
  await new Promise((resolve) => setTimeout(resolve, 0));
  bridge.submit(0, frame(0, 30));
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(frames, [20, 30]);
});

function decodeFrame(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    slot: view.getUint8(5),
    visible: view.getUint8(6) !== 0,
    left: view.getFloat32(8, true),
    top: view.getFloat32(12, true),
    width: view.getFloat32(16, true),
    height: view.getFloat32(20, true),
    ratio: view.getFloat32(24, true),
    series: [
      {
        channel: view.getUint32(32, true),
        color: 0x123456,
        width: view.getFloat32(36, true),
        fillOpacity: view.getFloat32(40, true),
        baseline: view.getFloat32(44, true),
        points: [1, Number.NaN],
      },
    ],
  };
}
