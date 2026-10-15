import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { __TAURI__: { core: { invoke: async () => null } } };

const elements = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        textContent: '',
        value: '',
        checked: false,
        disabled: false,
        hidden: false,
        title: '',
        style: {},
        classList: { toggle() {} },
        setAttribute() {},
      });
    }
    return elements.get(id);
  },
  dispatchEvent: () => true,
};

const { state } = await import('../src/state.js');
const { setTempConnected, setTempReadingAvailable, updateTempUIVisibility } = await import('../src/temperature.js');
const { setConnected } = await import('../src/device.js');
const { toast } = await import('../src/ui/toast.js');

const toastCalls = [];
toast.success = () => toastCalls.push('success');
toast.error = () => toastCalls.push('error');
toast.warning = () => toastCalls.push('warning');

function resetTempDisconnectState(source) {
  state.isConnected = true;
  state.isRecording = false;
  state.recordingStartTime = null;
  state.settings.tempSource = source;
  state.isTempConnected = false;
  state.hasTempData = false;
  state.currentTemp = null;
  toastCalls.length = 0;
}

test('unplugging the meter disconnects the device temperature source', async () => {
  resetTempDisconnectState('device');
  setTempConnected(true);
  state.currentTemp = 42;
  document.getElementById('rt-temp').textContent = '42.0';
  document.getElementById('lv-temp').style.transform = 'scaleX(0.8)';

  await setConnected(false);

  assert.equal(state.isTempConnected, false, 'the 本机 temperature source dies with the meter');
  assert.equal(state.currentTemp, null);
  assert.equal(document.getElementById('rt-temp').textContent, '--');
  assert.equal(document.getElementById('lv-temp').style.transform, 'scaleX(0)');
  assert.equal(document.getElementById('temp-source-device').disabled, false, '来源单选必须重新可用');
  assert.equal(document.getElementById('temp-ip').disabled, false);
});

test('refreshing temperature layout preserves the live reading state', () => {
  resetTempDisconnectState('external');
  setTempConnected(true);
  setTempReadingAvailable(true);
  const status = document.getElementById('temp-state').textContent;
  updateTempUIVisibility();
  assert.equal(document.getElementById('temp-state').textContent, status);
  setTempReadingAvailable(false);
  assert.notEqual(document.getElementById('temp-state').textContent, status);
});

test('an external temperature service survives an HID disconnect', async () => {
  resetTempDisconnectState('external');
  setTempConnected(true);
  state.currentTemp = 42;

  await setConnected(false);

  assert.equal(state.isTempConnected, true, 'TCP 温度会话与仪表流相互独立');
  assert.equal(state.currentTemp, 42);
});

test('the device-source reset is silent and keeps recorded temperature data', async () => {
  resetTempDisconnectState('device');
  setTempConnected(true);
  assert.equal(state.hasTempData, false, '连接本身不代表已有温度数据');
  state.chartSeries.temp.push(42);
  state.hasTempData = true;
  toastCalls.length = 0;

  await setConnected(false);

  assert.deepEqual(toastCalls, [], '被动注销不是用户操作失败，不该弹提示');
  assert.equal(state.hasTempData, true, '已记录的温度曲线不能被这次重置一起藏掉');
  assert.equal(document.getElementById('temp-card').style.display, 'grid');
  assert.equal(document.getElementById('show-temp-container').style.display, 'flex');
});

test('temperature controls remain visible and preferences survive connection transitions', () => {
  resetTempDisconnectState('external');
  state.settings.showTemp = false;
  state.settings.csvExportOptions = { withTemp: true, withDeviceInfo: false, withMarkers: true };
  const preferences = { ...state.settings.csvExportOptions };
  for (const connected of [false, true, false]) {
    setTempConnected(connected);
    assert.equal(document.getElementById('temp-card').style.display, 'grid');
    assert.equal(document.getElementById('show-temp-container').style.display, 'flex');
    assert.equal(state.settings.showTemp, false);
    assert.deepEqual(state.settings.csvExportOptions, preferences);
    assert.equal(state.settings.tempSource, 'external');
  }
});
