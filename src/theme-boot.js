/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * 首屏引导：在样式表之前同步写入 <html data-theme> 与 <html data-os>。
 * data-theme 避免 LazyStore 异步读完之前闪错主题（键名须与 src/theme.js 的 THEME_STORAGE_KEY 一致）。
 * data-os 让 tokens.css 在首帧就选对平台原生字体与窗口控件布局。
 */
(() => {
  let pref = 'system';
  try {
    const stored = localStorage.getItem('lapower-theme');
    if (stored === 'light' || stored === 'system' || stored === 'dark') pref = stored;
  } catch {
    /* 隐私模式等读失败时跟随系统 */
  }
  let systemDark = true;
  try {
    systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    /* matchMedia 不可用时按深色解析 */
  }
  const resolved = pref === 'light' || (pref === 'system' && !systemDark) ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', resolved);

  const ua = navigator.userAgent;
  document.documentElement.setAttribute(
    'data-os',
    ua.includes('Windows') ? 'windows' : ua.includes('Mac OS') ? 'macos' : 'linux',
  );

  try {
    const raw = localStorage.getItem('lapower-fonts');
    if (raw) {
      const parsed = JSON.parse(raw);
      const valid = (v) => typeof v === 'string' && v.length > 0 && v.length < 1024 && !/[;{}]/.test(v);
      const sanitizeFaceName = (v) =>
        typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[;{}"]/.test(v) ? v.trim() : '';
      const latinRange = 'U+0020-007E, U+00A0-024F, U+0370-03FF, U+2000-206F, U+2190-22FF';
      const cjkRange = 'U+2E80-33FF, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FE30-FE4F, U+FF00-FFEF, U+20000-2FA1F';
      const aliasRanges = {
        __laPower_latin: latinRange,
        __laPower_ui: latinRange,
        __laPower_mono: latinRange,
        __laPower_cjk: cjkRange,
      };
      const registerBootFaces = (faces, alias, range) => {
        if (typeof FontFace !== 'function' || !document.fonts?.add || !Array.isArray(faces)) return [];
        const added = [];
        for (const face of faces) {
          if (!face || typeof face !== 'object') continue;
          const names = Array.isArray(face.names) ? face.names.map(sanitizeFaceName).filter(Boolean) : [];
          if (!names.length) continue;
          const numWeight = Number(face.weight);
          const weight = Number.isFinite(numWeight) ? Math.min(900, Math.max(100, Math.round(numWeight))) : 400;
          const src = names.map((n) => `local("${n.replace(/\\/g, '\\\\')}")`).join(', ');
          const ff = new FontFace(alias, src, {
            weight: String(weight),
            style: face.italic ? 'italic' : 'normal',
            unicodeRange: range,
          });
          document.fonts.add(ff);
          added.push(ff);
        }
        return added;
      };
      if (parsed && typeof parsed === 'object' && valid(parsed.ui) && valid(parsed.mono)) {
        const bootFonts = [];
        if (Array.isArray(parsed.entries)) {
          for (const item of parsed.entries) {
            if (!item || typeof item !== 'object' || !Object.hasOwn(aliasRanges, item.alias)) continue;
            bootFonts.push(...registerBootFaces(item.faces, item.alias, aliasRanges[item.alias]));
          }
        } else {
          bootFonts.push(
            ...registerBootFaces(parsed.latinFaces, '__laPower_latin', latinRange),
            ...registerBootFaces(parsed.cjkFaces, '__laPower_cjk', cjkRange),
          );
        }
        window.__laPowerBootFonts = bootFonts;
        document.documentElement.style.setProperty('--font-ui', parsed.ui);
        document.documentElement.style.setProperty('--font-mono', parsed.mono);
      }
    }
  } catch {
    /* 隐私模式或损坏缓存时回退默认 CSS 字体栈 */
  }
})();
