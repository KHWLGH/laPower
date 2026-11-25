// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * @file 系统字体枚举与按界面语言适配的中/日/英数字体栈管理。
 */

import { getResolvedLanguage, t } from './i18n.js';
import { state } from './state.js';

/** 与 src/theme-boot.js 共用的 localStorage 键。 */
export const FONT_STORAGE_KEY = 'lapower-fonts';

export const CJK_FONT_ALIAS = '__laPower_cjk';
export const LATIN_FONT_ALIAS = '__laPower_latin';
export const EN_UI_FONT_ALIAS = '__laPower_ui';
export const EN_MONO_FONT_ALIAS = '__laPower_mono';
export const LATIN_UNICODE_RANGE = 'U+0020-007E, U+00A0-024F, U+0370-03FF, U+2000-206F, U+2190-22FF';
export const CJK_UNICODE_RANGE =
  'U+2E80-33FF, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FE30-FE4F, U+FF00-FFEF, U+20000-2FA1F';

/**
 * 后端枚举返回的单个字重/斜体字面。
 * @typedef {Object} SystemFontFace
 * @property {number} weight
 * @property {boolean} italic
 * @property {string[]} names
 */

/**
 * 后端枚举返回的单个系统字体信息。
 * @typedef {Object} SystemFontEntry
 * @property {string} family
 * @property {string} [zh_cn]
 * @property {string} [zh_tw]
 * @property {string} [ja]
 * @property {boolean} has_cjk
 * @property {boolean} [has_ja]
 * @property {boolean} has_latin
 * @property {SystemFontFace[]} [faces]
 */

/** @type {SystemFontEntry[]|null} */
let cachedFonts = null;
/** @type {Promise<SystemFontEntry[]>|null} */
let loadingPromise = null;
/** @type {FontFace[]} */
let activeFontFaces = [];
let applyGeneration = 0;

/**
 * 清洗字体族名称，拒绝控制字符与 CSS 注入符号。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeFontName(value) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || ch === ';' || ch === '{' || ch === '}') continue;
    out += ch;
  }
  return out.trim().slice(0, 128);
}

/**
 * 将字体族名称安全引号包裹为 CSS font-family 项。
 * @param {string} name
 * @returns {string}
 */
export function quoteFontFamily(name) {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** @param {string[]} items @returns {string[]} */
function uniqueItems(items) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 与 src/styles/tokens.css 完全一致的平台及语言默认字体回退栈。
 * @param {string} os
 * @param {string} language
 * @returns {{ ui: string[], mono: string[] }}
 */
function platformDefaultStacks(os, language) {
  if (os === 'macos') {
    if (language === 'ja') {
      return {
        ui: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Hiragino Sans"',
          '"Hiragino Kaku Gothic ProN"',
          '"PingFang SC"',
          'sans-serif',
        ],
        mono: [
          '"SF Mono"',
          'Menlo',
          'Monaco',
          '"Hiragino Sans"',
          '"Hiragino Kaku Gothic ProN"',
          '"PingFang SC"',
          'monospace',
        ],
      };
    }
    return {
      ui: ['-apple-system', 'BlinkMacSystemFont', '"PingFang SC"', '"Hiragino Sans GB"', 'sans-serif'],
      mono: ['"SF Mono"', 'Menlo', 'Monaco', '"PingFang SC"', '"Hiragino Sans GB"', 'monospace'],
    };
  }
  if (os === 'linux') {
    if (language === 'ja') {
      return {
        ui: ['system-ui', '"Noto Sans CJK JP"', '"Noto Sans JP"', '"Noto Sans CJK SC"', 'sans-serif'],
        mono: [
          'ui-monospace',
          '"Noto Sans Mono"',
          '"DejaVu Sans Mono"',
          '"Liberation Mono"',
          '"Ubuntu Mono"',
          '"Noto Sans CJK JP"',
          '"Noto Sans JP"',
          '"Noto Sans CJK SC"',
          'monospace',
        ],
      };
    }
    return {
      ui: [
        'system-ui',
        '"Noto Sans CJK SC"',
        '"Noto Sans SC"',
        '"Source Han Sans SC"',
        '"WenQuanYi Micro Hei"',
        'sans-serif',
      ],
      mono: [
        'ui-monospace',
        '"Noto Sans Mono"',
        '"DejaVu Sans Mono"',
        '"Liberation Mono"',
        '"Ubuntu Mono"',
        '"Noto Sans CJK SC"',
        '"Noto Sans SC"',
        '"Source Han Sans SC"',
        'monospace',
      ],
    };
  }
  if (language === 'ja') {
    return {
      ui: [
        '"Segoe UI Variable Text"',
        '"Segoe UI"',
        '"Yu Gothic UI"',
        '"Meiryo UI"',
        '"Microsoft YaHei UI"',
        'sans-serif',
      ],
      mono: ['"Cascadia Mono"', 'Consolas', '"Yu Gothic UI"', '"Meiryo UI"', '"Microsoft YaHei UI"', 'monospace'],
    };
  }
  if (language === 'zh-TW') {
    return {
      ui: [
        '"Segoe UI Variable Text"',
        '"Segoe UI"',
        '"Microsoft YaHei UI"',
        '"Microsoft YaHei"',
        '"Microsoft JhengHei UI"',
        '"Microsoft JhengHei"',
        '"Noto Sans CJK TC"',
        '"Noto Sans TC"',
        'sans-serif',
      ],
      mono: [
        '"Cascadia Mono"',
        'Consolas',
        '"Microsoft YaHei UI"',
        '"Microsoft YaHei"',
        '"Microsoft JhengHei UI"',
        '"Microsoft JhengHei"',
        '"Noto Sans CJK TC"',
        '"Noto Sans TC"',
        'monospace',
      ],
    };
  }
  return {
    ui: ['"Segoe UI Variable Text"', '"Segoe UI"', '"Microsoft YaHei UI"', '"Microsoft YaHei"', 'sans-serif'],
    mono: ['"Cascadia Mono"', 'Consolas', '"Microsoft YaHei UI"', '"Microsoft YaHei"', 'monospace'],
  };
}

/**
 * 读取当前界面语言对应的两项字体设置值。
 * @param {{ cjkFont?: unknown, jaFont?: unknown, latinFont?: unknown, enUiFont?: unknown, enMonoFont?: unknown }} [prefs]
 * @param {string} [language]
 * @returns {{ primary: string, secondary: string }}
 */
export function activeFontValues(prefs = state.settings, language = getResolvedLanguage()) {
  if (language === 'en') {
    return {
      primary: normalizeFontName(prefs?.enUiFont),
      secondary: normalizeFontName(prefs?.enMonoFont),
    };
  }
  return {
    primary: normalizeFontName(language === 'ja' ? prefs?.jaFont : prefs?.cjkFont),
    secondary: normalizeFontName(prefs?.latinFont),
  };
}

/** @param {string} value */
export function setPrimaryFontSetting(value) {
  const clean = normalizeFontName(value);
  const language = getResolvedLanguage();
  if (language === 'en') state.settings.enUiFont = clean;
  else if (language === 'ja') state.settings.jaFont = clean;
  else state.settings.cjkFont = clean;
}

/** @param {string} value */
export function setSecondaryFontSetting(value) {
  const clean = normalizeFontName(value);
  const language = getResolvedLanguage();
  if (language === 'en') state.settings.enMonoFont = clean;
  else state.settings.latinFont = clean;
}

export function resetActiveFontSettings() {
  setPrimaryFontSetting('');
  setSecondaryFontSetting('');
}

/**
 * 生成 `--font-ui` 与 `--font-mono` 令牌值；当前语言对应两项都为空时返回 null（恢复样式表默认栈）。
 * 自定义字体通过 `unicode-range` 隔离的内部别名挂载在原有默认栈之前，彼此互不串扰。
 * @param {{ latinFont?: unknown, cjkFont?: unknown, jaFont?: unknown, enUiFont?: unknown, enMonoFont?: unknown, os?: string, language?: string }} [options]
 * @returns {{ ui: string|null, mono: string|null }}
 */
export function buildFontStacks({
  latinFont,
  cjkFont,
  jaFont,
  enUiFont,
  enMonoFont,
  os = 'windows',
  language = 'en',
} = {}) {
  const defaults = platformDefaultStacks(os, language);

  if (language === 'en') {
    const uiName = normalizeFontName(enUiFont);
    const monoName = normalizeFontName(enMonoFont);
    if (!uiName && !monoName) return { ui: null, mono: null };
    return {
      ui: uniqueItems([...(uiName ? [quoteFontFamily(EN_UI_FONT_ALIAS)] : []), ...defaults.ui]).join(', '),
      mono: uniqueItems([...(monoName ? [quoteFontFamily(EN_MONO_FONT_ALIAS)] : []), ...defaults.mono]).join(', '),
    };
  }

  const primary = normalizeFontName(language === 'ja' ? jaFont : cjkFont);
  const latin = normalizeFontName(latinFont);
  if (!latin && !primary) return { ui: null, mono: null };

  const prefix = [
    ...(latin ? [quoteFontFamily(LATIN_FONT_ALIAS)] : []),
    ...(primary ? [quoteFontFamily(CJK_FONT_ALIAS)] : []),
  ];
  return {
    ui: uniqueItems([...prefix, ...defaults.ui]).join(', '),
    mono: uniqueItems([...prefix, ...defaults.mono]).join(', '),
  };
}

/**
 * 按当前界面语言返回字体展示名。
 * @param {SystemFontEntry} entry
 * @param {string} [language]
 * @returns {string}
 */
export function fontDisplayName(entry, language = getResolvedLanguage()) {
  if (language === 'zh-CN' && entry.zh_cn) return entry.zh_cn;
  if (language === 'zh-TW' && entry.zh_tw) return entry.zh_tw;
  if (language === 'ja' && entry.ja) return entry.ja;
  return entry.family;
}

/**
 * 按候选顺序查找系统已安装字体的本地化显示名。
 * @param {string[]} candidates
 * @param {string} fallback
 * @param {string} language
 * @param {SystemFontEntry[]|null} fonts
 * @returns {string}
 */
function firstInstalledLabel(candidates, fallback, language, fonts) {
  if (Array.isArray(fonts) && fonts.length > 0) {
    for (const candidate of candidates) {
      const lower = candidate.toLowerCase();
      const entry = fonts.find((item) => item.family.toLowerCase() === lower);
      if (entry) return fontDisplayName(entry, language);
    }
  }
  return fallback;
}

/**
 * 解析当前平台与语言下原本默认使用的两项字体展示名称。
 * @param {'primary'|'secondary'|'cjk'|'latin'} kind
 * @param {string} [os='windows']
 * @param {string} [language]
 * @param {SystemFontEntry[]|null} [fonts=cachedFonts]
 * @returns {string}
 */
export function resolveDefaultFontLabel(kind, os = 'windows', language = getResolvedLanguage(), fonts = cachedFonts) {
  const slot = kind === 'cjk' ? 'primary' : kind === 'latin' ? 'secondary' : kind;

  const resolveLatinUi = () => {
    if (os === 'macos')
      return firstInstalledLabel(['SF Pro Text', 'SF Pro', 'Helvetica Neue'], 'SF Pro', language, fonts);
    if (os === 'linux') {
      return firstInstalledLabel(
        ['Noto Sans', 'Liberation Sans', 'DejaVu Sans', 'Ubuntu', 'Cantarell'],
        'system-ui',
        language,
        fonts,
      );
    }
    return firstInstalledLabel(['Segoe UI Variable Text', 'Segoe UI'], 'Segoe UI', language, fonts);
  };

  const resolveLatinMono = () => {
    if (os === 'macos') return firstInstalledLabel(['SF Mono', 'Menlo', 'Monaco'], 'SF Mono', language, fonts);
    if (os === 'linux') {
      return firstInstalledLabel(
        ['Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Ubuntu Mono'],
        'ui-monospace',
        language,
        fonts,
      );
    }
    return firstInstalledLabel(['Cascadia Mono', 'Consolas'], 'Cascadia Mono', language, fonts);
  };

  if (language === 'en') {
    return slot === 'primary' ? resolveLatinUi() : resolveLatinMono();
  }

  if (slot === 'primary') {
    if (language === 'ja') {
      if (os === 'macos') {
        return firstInstalledLabel(
          ['Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'PingFang SC'],
          'Hiragino Sans',
          language,
          fonts,
        );
      }
      if (os === 'linux') {
        return firstInstalledLabel(
          ['Noto Sans CJK JP', 'Noto Sans JP', 'Noto Sans CJK SC'],
          'Noto Sans CJK JP',
          language,
          fonts,
        );
      }
      return firstInstalledLabel(['Yu Gothic UI', 'Meiryo UI', 'Microsoft YaHei UI'], 'Yu Gothic UI', language, fonts);
    }
    if (os === 'macos') {
      return firstInstalledLabel(['PingFang SC', 'Hiragino Sans GB'], 'PingFang SC', language, fonts);
    }
    if (os === 'linux') {
      return firstInstalledLabel(
        ['Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', 'WenQuanYi Micro Hei'],
        'Noto Sans CJK SC',
        language,
        fonts,
      );
    }
    const candidates =
      language === 'zh-TW'
        ? [
            'Microsoft YaHei UI',
            'Microsoft YaHei',
            'Microsoft JhengHei UI',
            'Microsoft JhengHei',
            'Noto Sans CJK TC',
            'Noto Sans TC',
          ]
        : ['Microsoft YaHei UI', 'Microsoft YaHei'];
    return firstInstalledLabel(candidates, 'Microsoft YaHei UI', language, fonts);
  }

  const uiName = resolveLatinUi();
  const monoName = resolveLatinMono();
  return uiName === monoName ? uiName : `${uiName} / ${monoName}`;
}

/** @param {'primary'|'secondary'} kind */
function defaultOptionLabel(kind) {
  const os =
    (typeof document !== 'undefined' ? document.documentElement?.getAttribute?.('data-os') : null) || 'windows';
  const language = getResolvedLanguage();
  return t('fontDefaultNamed', { name: resolveDefaultFontLabel(kind, os, language) });
}

/** @param {unknown} value */
function clampWeight(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 400;
  return Math.min(900, Math.max(100, Math.round(num)));
}

/**
 * 清洗并规范化字面元数据数组。
 * @param {unknown} rawFaces
 * @returns {SystemFontFace[]}
 */
function sanitizeFaces(rawFaces) {
  if (!Array.isArray(rawFaces)) return [];
  /** @type {SystemFontFace[]} */
  const out = [];
  for (const face of rawFaces) {
    if (!face || typeof face !== 'object') continue;
    const names = uniqueItems((Array.isArray(face.names) ? face.names : []).map(normalizeFontName).filter(Boolean));
    if (!names.length) continue;
    out.push({
      weight: clampWeight(face.weight),
      italic: Boolean(face.italic),
      names,
    });
  }
  return out;
}

/**
 * @param {string} family
 * @returns {SystemFontFace[]}
 */
function resolveFacesForFamily(family) {
  if (!family) return [];
  if (Array.isArray(cachedFonts)) {
    const lower = family.toLowerCase();
    const entry = cachedFonts.find((item) => item.family.toLowerCase() === lower);
    if (entry?.faces?.length) {
      const cleaned = sanitizeFaces(entry.faces);
      if (cleaned.length) return cleaned;
    }
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(FONT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const byFamily = parsed?.byFamily && typeof parsed.byFamily === 'object' ? parsed.byFamily : null;
        if (byFamily && Object.hasOwn(byFamily, family)) {
          const cleaned = sanitizeFaces(byFamily[family]);
          if (cleaned.length) return cleaned;
        }
        if (parsed?.latinFont === family) {
          const cleaned = sanitizeFaces(parsed.latinFaces);
          if (cleaned.length) return cleaned;
        }
        if (parsed?.cjkFont === family) {
          const cleaned = sanitizeFaces(parsed.cjkFaces);
          if (cleaned.length) return cleaned;
        }
      }
    } catch {
      /* 忽略损坏或受限缓存 */
    }
  }
  return [{ weight: 400, italic: false, names: [family] }];
}

function clearRegisteredFontFaces() {
  const fontSet = typeof document !== 'undefined' ? document.fonts : null;
  const bootFonts =
    typeof window !== 'undefined' && Array.isArray(window.__laPowerBootFonts) ? window.__laPowerBootFonts : [];
  for (const face of [...activeFontFaces, ...bootFonts]) {
    try {
      fontSet?.delete?.(face);
    } catch {
      /* ignore */
    }
  }
  activeFontFaces = [];
  if (typeof window !== 'undefined' && '__laPowerBootFonts' in window) {
    window.__laPowerBootFonts = [];
  }
}

/**
 * 为指定字面列表向 document.fonts 注册带 unicodeRange 隔离的 FontFace。
 * @param {string} alias
 * @param {SystemFontFace[]} faces
 * @param {string} unicodeRange
 * @returns {FontFace[]}
 */
function registerIsolatedFaces(alias, faces, unicodeRange) {
  if (typeof FontFace !== 'function' || typeof document === 'undefined' || !document.fonts?.add) return [];
  /** @type {FontFace[]} */
  const added = [];
  for (const face of faces) {
    const src = face.names.map((name) => `local(${quoteFontFamily(name)})`).join(', ');
    if (!src) continue;
    try {
      const fontFace = new FontFace(alias, src, {
        weight: String(face.weight),
        style: face.italic ? 'italic' : 'normal',
        unicodeRange,
      });
      document.fonts.add(fontFace);
      activeFontFaces.push(fontFace);
      added.push(fontFace);
    } catch {
      /* 单个异常字面不影响回退 */
    }
  }
  return added;
}

function dispatchFontsChanged() {
  if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') {
    const EventCtor = typeof CustomEvent === 'function' ? CustomEvent : null;
    if (EventCtor) document.dispatchEvent(new EventCtor('lapower:fonts-changed'));
  }
}

/**
 * 将当前界面语言对应的字体偏好写入根 CSS 令牌及首屏缓存，注册 unicode-range 隔离字体，并通知监听方刷新。
 * @param {{ latinFont?: unknown, cjkFont?: unknown, jaFont?: unknown, enUiFont?: unknown, enMonoFont?: unknown }} [prefs]
 */
export function applyFontPreferences(prefs = state.settings) {
  const gen = ++applyGeneration;
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const os = root?.getAttribute?.('data-os') || 'windows';
  const language = getResolvedLanguage();

  clearRegisteredFontFaces();
  const { primary, secondary } = activeFontValues(prefs, language);

  /** @type {{ alias: string, family: string, range: string }[]} */
  const slots =
    language === 'en'
      ? [
          { alias: EN_UI_FONT_ALIAS, family: primary, range: LATIN_UNICODE_RANGE },
          { alias: EN_MONO_FONT_ALIAS, family: secondary, range: LATIN_UNICODE_RANGE },
        ]
      : [
          { alias: LATIN_FONT_ALIAS, family: secondary, range: LATIN_UNICODE_RANGE },
          { alias: CJK_FONT_ALIAS, family: primary, range: CJK_UNICODE_RANGE },
        ];

  /** @type {FontFace[]} */
  const registered = [];
  /** @type {Record<string, SystemFontFace[]>} */
  const byFamily = {};
  /** @type {{ alias: string, faces: SystemFontFace[] }[]} */
  const entries = [];

  for (const slot of slots) {
    if (!slot.family) continue;
    const faces = resolveFacesForFamily(slot.family);
    byFamily[slot.family] = faces;
    entries.push({ alias: slot.alias, faces });
    registered.push(...registerIsolatedFaces(slot.alias, faces, slot.range));
  }

  const { ui, mono } = buildFontStacks({
    latinFont: prefs?.latinFont,
    cjkFont: prefs?.cjkFont,
    jaFont: prefs?.jaFont,
    enUiFont: prefs?.enUiFont,
    enMonoFont: prefs?.enMonoFont,
    os,
    language,
  });

  if (root?.style) {
    if (ui && mono) {
      root.style.setProperty?.('--font-ui', ui);
      root.style.setProperty?.('--font-mono', mono);
    } else {
      root.style.removeProperty?.('--font-ui');
      root.style.removeProperty?.('--font-mono');
    }
  }

  if (typeof localStorage !== 'undefined') {
    try {
      if (ui && mono) {
        localStorage.setItem(FONT_STORAGE_KEY, JSON.stringify({ ui, mono, byFamily, entries }));
      } else {
        localStorage.removeItem(FONT_STORAGE_KEY);
      }
    } catch {
      /* 隐私模式写失败不影响当前会话生效 */
    }
  }

  dispatchFontsChanged();

  if (registered.length > 0) {
    void Promise.allSettled(registered.map((ff) => ff.load())).then(() => {
      if (gen === applyGeneration) dispatchFontsChanged();
    });
  }

  if (
    (primary || secondary) &&
    !cachedFonts &&
    typeof window !== 'undefined' &&
    typeof window.__TAURI__?.core?.invoke === 'function'
  ) {
    void loadSystemFonts().catch(() => {});
  }
}

/**
 * 确保 select 内存在目标选项、更新默认字体名并回显选中值（兼容测试桩 DOM）。
 * @param {string} id
 * @param {'primary'|'secondary'} kind
 * @param {string} value
 */
function echoSelectValue(id, kind, value) {
  const select = /** @type {HTMLSelectElement|null} */ (
    typeof document !== 'undefined' ? document.getElementById(id) : null
  );
  if (!select) return;
  const defaultOpt = select.querySelector?.('option[value=""]');
  if (defaultOpt) defaultOpt.textContent = defaultOptionLabel(kind);
  if (!select.options) {
    select.value = value;
    return;
  }
  const hasOption = Array.from(select.options).some((opt) => opt.value === value);
  if (value && !hasOption) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = cachedFonts ? `${value} (${t('fontNotFound')})` : value;
    opt.dataset.missing = 'true';
    select.appendChild(opt);
  }
  select.value = value;
}

/** 回显字体下拉框与重置按钮状态。 */
export function echoFontUI() {
  const { primary, secondary } = activeFontValues(state.settings, getResolvedLanguage());
  echoSelectValue('font-cjk-select', 'primary', primary);
  echoSelectValue('font-latin-select', 'secondary', secondary);
  const resetBtn = /** @type {HTMLButtonElement|null} */ (
    typeof document !== 'undefined' ? document.getElementById('btn-font-reset') : null
  );
  if (resetBtn) resetBtn.disabled = !primary && !secondary;
}

/**
 * 填充单个字体下拉列表。
 * @param {string} id
 * @param {'primary'|'secondary'} kind
 * @param {SystemFontEntry[]} fonts
 * @param {string} savedValue
 * @param {string} language
 */
function fillFontSelect(id, kind, fonts, savedValue, language) {
  const select = /** @type {HTMLSelectElement|null} */ (
    typeof document !== 'undefined' ? document.getElementById(id) : null
  );
  if (!select || !select.options) return;

  const sorted = [...fonts].sort((a, b) =>
    fontDisplayName(a, language).localeCompare(fontDisplayName(b, language), language),
  );
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = defaultOptionLabel(kind);

  const options = [defaultOpt];
  let matched = savedValue === '';
  for (const entry of sorted) {
    const opt = document.createElement('option');
    opt.value = entry.family;
    const label = fontDisplayName(entry, language);
    opt.textContent = label === entry.family ? label : `${label} (${entry.family})`;
    if (entry.family === savedValue) matched = true;
    options.push(opt);
  }

  if (savedValue && !matched) {
    const missingOpt = document.createElement('option');
    missingOpt.value = savedValue;
    missingOpt.textContent = `${savedValue} (${t('fontNotFound')})`;
    missingOpt.dataset.missing = 'true';
    options.push(missingOpt);
  }

  select.replaceChildren(...options);
  select.value = savedValue;
}

/** 使用已缓存字体重建下拉选项。 */
export function populateFontSelectors() {
  if (!cachedFonts) {
    echoFontUI();
    return;
  }
  const language = getResolvedLanguage();
  const { primary, secondary } = activeFontValues(state.settings, language);
  const primaryFonts = cachedFonts.filter((entry) =>
    language === 'en' ? entry.has_latin : language === 'ja' ? (entry.has_ja ?? entry.has_cjk) : entry.has_cjk,
  );
  fillFontSelect('font-cjk-select', 'primary', primaryFonts, primary, language);
  fillFontSelect(
    'font-latin-select',
    'secondary',
    cachedFonts.filter((entry) => entry.has_latin),
    secondary,
    language,
  );
  echoFontUI();
}

/** 界面语言变化后刷新字体列表的本地化展示名。 */
export function refreshFontSelectorLanguage() {
  if (cachedFonts) {
    populateFontSelectors();
  } else {
    echoFontUI();
  }
}

/**
 * 向后端枚举系统已安装字体并填充设置下拉框。
 * @returns {Promise<SystemFontEntry[]>}
 */
export async function loadSystemFonts() {
  if (cachedFonts) {
    populateFontSelectors();
    return cachedFonts;
  }
  if (loadingPromise) return loadingPromise;
  const invoke = typeof window !== 'undefined' ? window.__TAURI__?.core?.invoke : null;
  if (typeof invoke !== 'function') return [];

  loadingPromise = Promise.resolve(invoke('list_system_fonts'))
    .then((result) => {
      cachedFonts = Array.isArray(result) ? result : [];
      populateFontSelectors();
      const { primary, secondary } = activeFontValues(state.settings, getResolvedLanguage());
      if (primary || secondary) applyFontPreferences();
      return cachedFonts;
    })
    .finally(() => {
      loadingPromise = null;
    });

  return loadingPromise;
}
