/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyLanguage, t } from '../src/i18n.js';

/**
 * 设置持久化的失败路径。
 *
 * 关键点：store 的读写失败今天只落 console.error，用户看到的却是「已保存」，
 * 于是重启后设置全部回滚而没人知道。这里把「失败必须被说出来」钉成契约。
 */

globalThis.window = { __TAURI__: { core: { invoke: async () => null } } };

const elements = new Map();
const cssProps = new Map();
/** @param {string} id */
function el(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      textContent: '',
      value: '',
      checked: false,
      disabled: false,
      hidden: false,
      title: '',
      style: { setProperty() {} },
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      setAttribute() {},
      getAttribute: () => null,
      appendChild() {},
      addEventListener() {},
      querySelector: () => null,
    });
  }
  return elements.get(id);
}
globalThis.document = {
  getElementById: el,
  documentElement: {
    style: {
      /** @param {string} name @param {string} value */
      setProperty(name, value) {
        cssProps.set(name, String(value));
      },
      /** @param {string} name */
      removeProperty(name) {
        cssProps.delete(name);
      },
    },
    setAttribute() {},
    getAttribute: () => null,
    classList: { toggle() {} },
  },
  addEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => el(`__created:${Math.random()}`),
  dispatchEvent: () => true,
};
globalThis.requestAnimationFrame = (cb) => {
  cb();
  return 0;
};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { defaultSettings, state } = await import('../src/state.js');
const {
  applyFontPreferences,
  buildFontStacks,
  CJK_FONT_ALIAS,
  echoFontUI,
  EN_MONO_FONT_ALIAS,
  EN_UI_FONT_ALIAS,
  LATIN_FONT_ALIAS,
  normalizeFontName,
  resolveDefaultFontLabel,
} = await import('../src/fonts.js');
const { getStore, loadSettings, saveSettings, resetSettings } = await import('../src/settings.js');
const { toast } = await import('../src/ui/toast.js');

/** @type {{command:string, args:Record<string,unknown>}[]} */
let calls = [];
/** @type {Map<string, (args:any)=>any>} */
let failures = new Map();
/** @type {any[]} */
let errorToasts = [];

function installStoreStub() {
  calls = [];
  failures = new Map();
  errorToasts = [];
  cssProps.clear();
  toast.error = (message) => errorToasts.push(String(typeof message === 'function' ? message() : message));
  toast.success = () => {};
  toast.warning = () => {};
  let rid = 0;
  const saved = new Map();
  globalThis.window.__TAURI__.core.invoke = async (command, args = {}) => {
    calls.push({ command, args });
    const failWith = failures.get(command);
    if (failWith) return failWith(args);
    if (command === 'plugin:store|load') return ++rid;
    if (command === 'plugin:store|get') {
      const has = saved.has(String(args.key));
      return [has ? saved.get(String(args.key)) : null, has];
    }
    if (command === 'plugin:store|set') saved.set(String(args.key), args.value);
    if (command === 'plugin:store|delete') saved.delete(String(args.key));
    return null;
  };
}

function resetSettingsState() {
  state.isConnected = false;
  state.isRecording = false;
  state.settings.sampleRate = 250;
}

const LOAD = 'plugin:store|load';
const SAVE = 'plugin:store|save';

test('a rejected store load is retried instead of poisoning persistence', async () => {
  installStoreStub();
  failures.set(LOAD, () => {
    throw new Error('store path unavailable');
  });
  resetSettingsState();

  const log = console.error;
  console.error = () => {};
  try {
    assert.equal(await saveSettings(), false, '加载失败必须报告为未持久化');
    failures.delete(LOAD);
    assert.equal(await saveSettings(), true, '恢复后必须重新尝试建 store');
  } finally {
    console.error = log;
  }
  const wrote = calls.filter((c) => c.command === 'plugin:store|set').length;
  assert.equal(wrote, 1, '一次成功写入');
});

test('a write failure is told to the user exactly once per fault period', async () => {
  installStoreStub();
  resetSettingsState();
  failures.set(SAVE, () => {
    throw new Error('EPERM');
  });

  const log = console.error;
  console.error = () => {};
  try {
    assert.equal(await saveSettings(), false);
    assert.equal(await saveSettings(), false);
    assert.equal(await saveSettings(), false);
    assert.equal(errorToasts.length, 1, '防抖保存会反复触发，刷屏就是新 bug');
    assert.match(errorToasts[0], /Failed to save|may not be saved/);

    failures.delete(SAVE);
    assert.equal(await saveSettings(), true);
    errorToasts.length = 0;
    failures.set(SAVE, () => {
      throw new Error('EPERM');
    });
    assert.equal(await saveSettings(), false);
    assert.equal(errorToasts.length, 1, '恢复过一次之后再次失败要重新提示');
  } finally {
    console.error = log;
  }
});

test('resetSettings reports whether the reset actually persisted', async () => {
  installStoreStub();
  resetSettingsState();

  const log = console.error;
  console.error = () => {};
  try {
    // 先跑一次干净的保存，结束上一个用例留下的故障期
    assert.equal(await saveSettings(), true);
    failures.set(SAVE, () => {
      throw new Error('locked by OneDrive');
    });
    assert.equal(await resetSettings(), false, 'UI 回到默认但没落盘，不能算成功');
    assert.equal(state.settings.sampleRate, 250, '默认值仍应落到内存里');
    assert.equal(errorToasts.at(-1), t('settingsWriteFailed'));
    assert.equal(state.settings.language, 'auto');
  } finally {
    console.error = log;
  }
});

test('a healthy store produces no failure toasts', async () => {
  installStoreStub();
  resetSettingsState();
  assert.equal(await saveSettings(), true);
  assert.equal(await getStore(), await getStore(), '单例仍然复用');
  assert.deepEqual(errorToasts, [], '干净路径不该出现任何错误提示');
});

test('background opacity, blur, legacy transparency migration and automatic stroke width survive reload and reset', async () => {
  installStoreStub();
  const previous = state.settings;
  const invoke = window.__TAURI__.core.invoke;
  const hadElement = 'HTMLElement' in globalThis;
  if (!hadElement) globalThis.HTMLElement = class {};
  try {
    state.settings = { ...defaultSettings, backgroundOpacity: 36, backgroundBlur: 22, chartAutoLineWidth: false };
    assert.equal(await saveSettings(), true);
    state.settings = { ...defaultSettings };
    await loadSettings();
    assert.equal(state.settings.backgroundOpacity, 36);
    assert.equal(el('background-opacity').value, '36');
    assert.equal(el('background-opacity-value').textContent, '36%');
    assert.equal(cssProps.get('--wallpaper-image-opacity'), '0.36');
    assert.equal(state.settings.backgroundBlur, 22);
    assert.equal(el('background-blur').value, '22');
    assert.equal(el('background-blur-value').textContent, '22 px');
    assert.equal(cssProps.get('--wallpaper-blur-radius'), '22px');
    assert.equal(cssProps.get('--wallpaper-blur-filter'), 'blur(22px)');
    assert.equal(state.settings.chartAutoLineWidth, false);
    assert.equal(el('chart-auto-line-width').checked, false);

    state.settings.backgroundOpacity = 250;
    state.settings.backgroundBlur = 99;
    assert.equal(await saveSettings(), true);
    await loadSettings();
    assert.equal(state.settings.backgroundOpacity, 100);
    assert.equal(cssProps.get('--wallpaper-image-opacity'), '1');
    assert.equal(state.settings.backgroundBlur, 40);
    assert.equal(cssProps.get('--wallpaper-blur-radius'), '40px');
    assert.equal(cssProps.get('--wallpaper-blur-filter'), 'blur(40px)');

    state.settings.backgroundOpacity = -10;
    state.settings.backgroundBlur = -5;
    assert.equal(await saveSettings(), true);
    await loadSettings();
    assert.equal(state.settings.backgroundOpacity, 0);
    assert.equal(cssProps.get('--wallpaper-image-opacity'), '0');
    assert.equal(state.settings.backgroundBlur, 0);
    assert.equal(cssProps.get('--wallpaper-blur-radius'), '0px');
    assert.equal(cssProps.get('--wallpaper-blur-filter'), 'none');

    for (const [legacy, expectedOpacity, expectedCss] of [
      [{ backgroundTransparency: 0 }, 100, '1'],
      [{ backgroundTransparency: 64 }, 36, '0.36'],
      [{ backgroundTransparency: 250 }, 0, '0'],
      [{ backgroundOpacity: 80, backgroundTransparency: 64 }, 80, '0.8'],
    ]) {
      window.__TAURI__.core.invoke = async (command, args = {}) => {
        if (command === 'plugin:store|get' && args.key === 'appSettings') return [legacy, true];
        return invoke(command, args);
      };
      state.settings = { ...defaultSettings };
      await loadSettings();
      assert.equal(state.settings.backgroundOpacity, expectedOpacity);
      assert.equal(cssProps.get('--wallpaper-image-opacity'), expectedCss);
      assert.equal(Object.hasOwn(state.settings, 'backgroundTransparency'), false);
    }

    window.__TAURI__.core.invoke = invoke;
    assert.equal(await saveSettings(), true);
    const saved = calls.findLast(({ command }) => command === 'plugin:store|set');
    assert.ok(saved);
    assert.equal(Object.hasOwn(saved.args.value, 'backgroundTransparency'), false);
    assert.equal(saved.args.value.backgroundOpacity, 80);

    assert.equal(await resetSettings(), true);
    assert.equal(state.settings.backgroundOpacity, 100);
    assert.equal(el('background-opacity').value, '100');
    assert.equal(el('background-opacity-value').textContent, '100%');
    assert.equal(cssProps.get('--wallpaper-image-opacity'), '1');
    assert.equal(state.settings.backgroundBlur, 14);
    assert.equal(el('background-blur').value, '14');
    assert.equal(el('background-blur-value').textContent, '14 px');
    assert.equal(cssProps.get('--wallpaper-blur-radius'), '14px');
    assert.equal(cssProps.get('--wallpaper-blur-filter'), 'blur(14px)');
    assert.equal(el('chart-auto-line-width').checked, true);
  } finally {
    state.settings = previous;
    window.__TAURI__.core.invoke = invoke;
    if (!hadElement) delete globalThis.HTMLElement;
  }
});

test('old and invalid language preferences use auto; valid choices survive a store reload', async () => {
  installStoreStub();
  const previous = state.settings;
  const invoke = window.__TAURI__.core.invoke;
  const hadElement = 'HTMLElement' in globalThis;
  if (!hadElement) globalThis.HTMLElement = class {};
  try {
    for (const language of [undefined, null, 'fr', 'zh-cn', 12, 'auto', 'zh-CN', 'zh-TW', 'en', 'ja']) {
      window.__TAURI__.core.invoke = async (command, args = {}) => {
        if (command === 'plugin:store|get' && args.key === 'appSettings') return [{ language }, true];
        return invoke(command, args);
      };
      state.settings = { ...defaultSettings };
      await loadSettings();
      assert.equal(
        state.settings.language,
        ['auto', 'zh-CN', 'zh-TW', 'en', 'ja'].includes(language) ? language : 'auto',
      );
    }
    window.__TAURI__.core.invoke = invoke;
    state.settings.language = 'ja';
    assert.equal(await saveSettings(), true);
    state.settings = { ...defaultSettings };
    await loadSettings();
    assert.equal(state.settings.language, 'ja');
    assert.equal(await resetSettings(), true);
    assert.equal(state.settings.language, 'auto');
  } finally {
    state.settings = previous;
    window.__TAURI__.core.invoke = invoke;
    if (!hadElement) delete globalThis.HTMLElement;
  }
});

test('retired window style is dropped when loading, saving and resetting settings', async () => {
  installStoreStub();
  const previous = state.settings;
  const invoke = window.__TAURI__.core.invoke;
  const hadElement = 'HTMLElement' in globalThis;
  if (!hadElement) globalThis.HTMLElement = class {};
  try {
    for (const windowStyle of [undefined, null, 'auto', 'invalid', 'windows', 'macos']) {
      window.__TAURI__.core.invoke = async (command, args = {}) => {
        if (command === 'plugin:store|get' && args.key === 'appSettings') return [{ windowStyle }, true];
        return invoke(command, args);
      };
      state.settings = { ...defaultSettings };
      await loadSettings();
      assert.equal(Object.hasOwn(state.settings, 'windowStyle'), false);
    }
    window.__TAURI__.core.invoke = invoke;
    assert.equal(await saveSettings(), true);
    const saved = calls.findLast(({ command }) => command === 'plugin:store|set');
    assert.ok(saved);
    assert.equal(Object.hasOwn(saved.args.value, 'windowStyle'), false);
    assert.equal(await resetSettings(), true);
    assert.equal(Object.hasOwn(state.settings, 'windowStyle'), false);
  } finally {
    state.settings = previous;
    window.__TAURI__.core.invoke = invoke;
    if (!hadElement) delete globalThis.HTMLElement;
  }
});

test('immediate marking defaults safely, persists both choices, echoes the toggle and resets', async () => {
  installStoreStub();
  const previous = state.settings;
  const invoke = window.__TAURI__.core.invoke;
  const hadElement = 'HTMLElement' in globalThis;
  if (!hadElement) globalThis.HTMLElement = class {};
  try {
    for (const immediateMarker of [undefined, null, 'true', 'false', 1, true, false]) {
      window.__TAURI__.core.invoke = async (command, args = {}) => {
        if (command === 'plugin:store|get' && args.key === 'appSettings') return [{ immediateMarker }, true];
        return invoke(command, args);
      };
      await loadSettings();
      assert.equal(state.settings.immediateMarker, immediateMarker === true);
      assert.equal(el('immediate-marker').checked, immediateMarker === true);
    }
    window.__TAURI__.core.invoke = invoke;
    for (const choice of [true, false]) {
      state.settings.immediateMarker = choice;
      assert.equal(await saveSettings(), true);
      state.settings = { ...defaultSettings };
      await loadSettings();
      assert.equal(state.settings.immediateMarker, choice);
      assert.equal(el('immediate-marker').checked, choice);
    }
    state.settings.immediateMarker = true;
    assert.equal(await resetSettings(), true);
    assert.equal(state.settings.immediateMarker, false);
    assert.equal(el('immediate-marker').checked, false);
  } finally {
    state.settings = previous;
    window.__TAURI__.core.invoke = invoke;
    if (!hadElement) delete globalThis.HTMLElement;
  }
});

test('curve shading defaults on, preserves opacity across reloads and resets', async () => {
  installStoreStub();
  const previous = state.settings;
  const invoke = window.__TAURI__.core.invoke;
  const hadElement = 'HTMLElement' in globalThis;
  if (!hadElement) globalThis.HTMLElement = class {};
  try {
    for (const value of [undefined, null, 'false', 0, true, false]) {
      window.__TAURI__.core.invoke = async (command, args = {}) => {
        if (command === 'plugin:store|get' && args.key === 'appSettings')
          return [{ chartFillEnabled: value, opacityVoltage: 29 }, true];
        return invoke(command, args);
      };
      await loadSettings();
      assert.equal(state.settings.chartFillEnabled, value !== false);
      assert.equal(el('chart-fill-enabled').checked, value !== false);
      assert.equal(state.settings.opacityVoltage, 29);
    }
    window.__TAURI__.core.invoke = invoke;
    for (const enabled of [false, true]) {
      state.settings.chartFillEnabled = enabled;
      assert.equal(await saveSettings(), true);
      state.settings = { ...defaultSettings };
      await loadSettings();
      assert.equal(state.settings.chartFillEnabled, enabled);
      assert.equal(state.settings.opacityVoltage, 29);
    }
    assert.equal(await resetSettings(), true);
    assert.equal(state.settings.chartFillEnabled, true);
  } finally {
    state.settings = previous;
    window.__TAURI__.core.invoke = invoke;
    if (!hadElement) delete globalThis.HTMLElement;
  }
});

test('custom channel colors are validated, echoed, persisted and reset', async () => {
  installStoreStub();
  const previous = state.settings;
  const invoke = window.__TAURI__.core.invoke;
  const hadElement = 'HTMLElement' in globalThis;
  if (!hadElement) globalThis.HTMLElement = class {};
  try {
    window.__TAURI__.core.invoke = async (command, args = {}) => {
      if (command === 'plugin:store|get' && args.key === 'appSettings') {
        return [{ channelColors: { voltage: '#112233', current: 'green', power: '#aabbcc', temp: '#ABCDEF' } }, true];
      }
      return invoke(command, args);
    };
    await loadSettings();
    assert.deepEqual(state.settings.channelColors, { voltage: '#112233', power: '#aabbcc', temp: '#ABCDEF' });
    assert.equal(el('color-voltage').value, '#112233');
    assert.equal(el('color-current').value, '#34d889');

    window.__TAURI__.core.invoke = invoke;
    assert.equal(await saveSettings(), true);
    state.settings = { ...defaultSettings, channelColors: {} };
    await loadSettings();
    assert.deepEqual(state.settings.channelColors, { voltage: '#112233', power: '#aabbcc', temp: '#ABCDEF' });
    assert.equal(el('color-temp').value, '#ABCDEF');

    assert.equal(await resetSettings(), true);
    assert.deepEqual(state.settings.channelColors, {});
  } finally {
    state.settings = previous;
    window.__TAURI__.core.invoke = invoke;
    if (!hadElement) delete globalThis.HTMLElement;
  }
});

test('loaded settings keep the protocol view and clamp PDM choices field by field', async () => {
  installStoreStub();
  const stored = globalThis.window.__TAURI__.core.invoke;
  globalThis.window.__TAURI__.core.invoke = async (command, args = {}) => {
    if (command === 'plugin:store|get' && args.key === 'appSettings') {
      return [{ activeView: 'trigger', km003cPdm: { pdType: 9, em: 2, sink: 'x' } }, true];
    }
    return stored(command, args);
  };
  const before = state.settings;
  // loadSettings 的收尾会回显读数栏宽度，需要能做 instanceof 判断。
  const hadElement = 'HTMLElement' in globalThis;
  if (!hadElement) globalThis.HTMLElement = class {};
  try {
    await loadSettings();
    assert.equal(state.settings.activeView, 'trigger');
    assert.deepEqual(state.settings.km003cPdm, { pdType: 1, em: 2, sink: 0 });
  } finally {
    state.settings = before;
    globalThis.window.__TAURI__.core.invoke = stored;
    if (!hadElement) delete globalThis.HTMLElement;
  }
});

test('shortcut unbinding and CSV options survive the existing settings store without connecting temperature', async () => {
  installStoreStub();
  const before = state.settings;
  const wasTempConnected = state.isTempConnected;
  const hadElement = 'HTMLElement' in globalThis;
  if (!hadElement) globalThis.HTMLElement = class {};
  try {
    const shortcuts = { ...defaultSettings.shortcuts, record: 'R', mark: '', clear: 'Mod+Shift+X' };
    const options = { withTemp: true, withDeviceInfo: false, withMarkers: false };
    state.settings = { ...defaultSettings, shortcuts, csvExportOptions: options, tempSource: 'device' };
    state.isTempConnected = false;
    await saveSettings();
    state.settings = { ...defaultSettings };
    await loadSettings();
    assert.deepEqual(state.settings.shortcuts, shortcuts);
    assert.deepEqual(state.settings.csvExportOptions, options);
    assert.equal(state.settings.tempSource, 'device');
    assert.equal(state.isTempConnected, false, 'loading preferences never starts a temperature session');
    assert.equal(
      calls.some(({ command }) => command === 'connect_temp_service'),
      false,
    );
  } finally {
    state.settings = before;
    state.isTempConnected = wasTempConnected;
    if (!hadElement) delete globalThis.HTMLElement;
  }
});

test('useSystemTime and custom CJK/Latin font settings normalize, apply CSS tokens, persist and reset', async () => {
  installStoreStub();
  const previous = state.settings;
  const invoke = window.__TAURI__.core.invoke;
  const hadElement = 'HTMLElement' in globalThis;
  if (!hadElement) globalThis.HTMLElement = class {};
  try {
    assert.equal(normalizeFontName('  JetBrains; Mono{}\n '), 'JetBrains Mono');
    assert.equal(normalizeFontName(123), '');

    const cjkOnly = buildFontStacks({ latinFont: '', cjkFont: 'Noto Serif SC', os: 'windows', language: 'zh-CN' });
    assert.equal(
      cjkOnly.ui,
      `"${CJK_FONT_ALIAS}", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`,
    );
    assert.equal(
      cjkOnly.mono,
      `"${CJK_FONT_ALIAS}", "Cascadia Mono", Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace`,
    );

    const latinOnly = buildFontStacks({ latinFont: 'Cascadia Code', cjkFont: '', os: 'windows', language: 'zh-CN' });
    assert.equal(
      latinOnly.ui,
      `"${LATIN_FONT_ALIAS}", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`,
    );
    assert.equal(
      latinOnly.mono,
      `"${LATIN_FONT_ALIAS}", "Cascadia Mono", Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace`,
    );

    const both = buildFontStacks({
      latinFont: 'JetBrains Mono',
      cjkFont: 'PingFang SC',
      os: 'macos',
      language: 'zh-CN',
    });
    assert.equal(
      both.ui,
      `"${LATIN_FONT_ALIAS}", "${CJK_FONT_ALIAS}", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif`,
    );
    assert.equal(
      both.mono,
      `"${LATIN_FONT_ALIAS}", "${CJK_FONT_ALIAS}", "SF Mono", Menlo, Monaco, "PingFang SC", "Hiragino Sans GB", monospace`,
    );

    const enUiOnly = buildFontStacks({ enUiFont: 'Inter', enMonoFont: '', os: 'windows', language: 'en' });
    assert.equal(
      enUiOnly.ui,
      `"${EN_UI_FONT_ALIAS}", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`,
    );
    assert.equal(enUiOnly.mono, '"Cascadia Mono", Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace');

    const enMonoOnly = buildFontStacks({ enUiFont: '', enMonoFont: 'JetBrains Mono', os: 'macos', language: 'en' });
    assert.equal(enMonoOnly.ui, '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif');
    assert.equal(
      enMonoOnly.mono,
      `"${EN_MONO_FONT_ALIAS}", "SF Mono", Menlo, Monaco, "PingFang SC", "Hiragino Sans GB", monospace`,
    );

    const jaOnly = buildFontStacks({ jaFont: 'Yu Gothic', latinFont: '', os: 'windows', language: 'ja' });
    assert.equal(
      jaOnly.ui,
      `"${CJK_FONT_ALIAS}", "Segoe UI Variable Text", "Segoe UI", "Yu Gothic UI", "Meiryo UI", "Microsoft YaHei UI", sans-serif`,
    );
    assert.equal(
      jaOnly.mono,
      `"${CJK_FONT_ALIAS}", "Cascadia Mono", Consolas, "Yu Gothic UI", "Meiryo UI", "Microsoft YaHei UI", monospace`,
    );

    assert.deepEqual(buildFontStacks({ enUiFont: '', enMonoFont: '', os: 'linux', language: 'en' }), {
      ui: null,
      mono: null,
    });

    const sampleFonts = [
      {
        family: 'Microsoft YaHei UI',
        zh_cn: '微软雅黑 UI',
        zh_tw: '微軟雅黑 UI',
        has_cjk: true,
        has_ja: false,
        has_latin: true,
      },
      { family: 'Yu Gothic UI', ja: '游ゴシック UI', has_cjk: true, has_ja: true, has_latin: true },
      { family: 'Segoe UI Variable Text', has_cjk: false, has_ja: false, has_latin: true },
      { family: 'Cascadia Mono', has_cjk: false, has_ja: false, has_latin: true },
    ];
    assert.equal(resolveDefaultFontLabel('primary', 'windows', 'zh-CN', sampleFonts), '微软雅黑 UI');
    assert.equal(
      resolveDefaultFontLabel('secondary', 'windows', 'zh-CN', sampleFonts),
      'Segoe UI Variable Text / Cascadia Mono',
    );
    assert.equal(resolveDefaultFontLabel('primary', 'windows', 'en', sampleFonts), 'Segoe UI Variable Text');
    assert.equal(resolveDefaultFontLabel('secondary', 'windows', 'en', sampleFonts), 'Cascadia Mono');
    assert.equal(resolveDefaultFontLabel('primary', 'windows', 'ja', sampleFonts), '游ゴシック UI');
    assert.equal(resolveDefaultFontLabel('primary', 'macos', 'zh-CN', []), 'PingFang SC');

    await applyLanguage('zh-CN');
    window.__TAURI__.core.invoke = async (command, args = {}) => {
      if (command === 'plugin:store|get' && args.key === 'appSettings') {
        return [
          {
            language: 'zh-CN',
            useSystemTime: true,
            cjkFont: 'SimHei;{}',
            jaFont: 'Meiryo UI',
            latinFont: 'Cascadia Code',
            enUiFont: 'Segoe UI',
            enMonoFont: 'JetBrains Mono',
          },
          true,
        ];
      }
      return invoke(command, args);
    };
    state.settings = { ...defaultSettings };
    await loadSettings();
    assert.equal(state.settings.useSystemTime, true);
    assert.equal(el('use-system-time').checked, true);
    assert.equal(state.settings.cjkFont, 'SimHei');
    assert.equal(state.settings.jaFont, 'Meiryo UI');
    assert.equal(state.settings.latinFont, 'Cascadia Code');
    assert.equal(state.settings.enUiFont, 'Segoe UI');
    assert.equal(state.settings.enMonoFont, 'JetBrains Mono');
    assert.equal(el('font-cjk-select').value, 'SimHei');
    assert.equal(el('font-latin-select').value, 'Cascadia Code');
    assert.equal(el('btn-font-reset').disabled, false);
    assert.match(
      cssProps.get('--font-ui') ?? '',
      new RegExp(`^"${LATIN_FONT_ALIAS}", "${CJK_FONT_ALIAS}", "Segoe UI Variable Text"`),
    );
    assert.match(
      cssProps.get('--font-mono') ?? '',
      new RegExp(`^"${LATIN_FONT_ALIAS}", "${CJK_FONT_ALIAS}", "Cascadia Mono"`),
    );

    await applyLanguage('en');
    applyFontPreferences();
    echoFontUI();
    assert.equal(el('font-cjk-select').value, 'Segoe UI');
    assert.equal(el('font-latin-select').value, 'JetBrains Mono');
    assert.match(cssProps.get('--font-ui') ?? '', new RegExp(`^"${EN_UI_FONT_ALIAS}", "Segoe UI Variable Text"`));
    assert.match(cssProps.get('--font-mono') ?? '', new RegExp(`^"${EN_MONO_FONT_ALIAS}", "Cascadia Mono"`));

    await applyLanguage('ja');
    applyFontPreferences();
    echoFontUI();
    assert.equal(el('font-cjk-select').value, 'Meiryo UI');
    assert.equal(el('font-latin-select').value, 'Cascadia Code');
    assert.match(
      cssProps.get('--font-ui') ?? '',
      new RegExp(`^"${LATIN_FONT_ALIAS}", "${CJK_FONT_ALIAS}", "Segoe UI Variable Text", "Segoe UI", "Yu Gothic UI"`),
    );

    window.__TAURI__.core.invoke = invoke;
    assert.equal(await saveSettings(), true);
    state.settings = { ...defaultSettings };
    await applyLanguage('zh-CN');
    await loadSettings();
    assert.equal(state.settings.useSystemTime, true);
    assert.equal(state.settings.cjkFont, 'SimHei');
    assert.equal(state.settings.jaFont, 'Meiryo UI');
    assert.equal(state.settings.latinFont, 'Cascadia Code');
    assert.equal(state.settings.enUiFont, 'Segoe UI');
    assert.equal(state.settings.enMonoFont, 'JetBrains Mono');

    assert.equal(await resetSettings(), true);
    assert.equal(state.settings.useSystemTime, false);
    assert.equal(el('use-system-time').checked, false);
    assert.equal(state.settings.cjkFont, '');
    assert.equal(state.settings.jaFont, '');
    assert.equal(state.settings.latinFont, '');
    assert.equal(state.settings.enUiFont, '');
    assert.equal(state.settings.enMonoFont, '');
    assert.equal(el('font-cjk-select').value, '');
    assert.equal(el('font-latin-select').value, '');
    assert.equal(el('btn-font-reset').disabled, true);
    assert.equal(cssProps.has('--font-ui'), false);
    assert.equal(cssProps.has('--font-mono'), false);
  } finally {
    state.settings = previous;
    window.__TAURI__.core.invoke = invoke;
    if (!hadElement) delete globalThis.HTMLElement;
  }
});
