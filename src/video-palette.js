// @ts-check
/**
 * @file 报告视频的调色板（纯数据，无 DOM / Tauri）。
 *
 * 唯一来源是 `src/styles/tokens.css`：这里记录的是各主题下解析后的最终十六进制值。
 * 为什么不能在渲染时读令牌：`data-theme` 挂在 `:root` 上，用 `getComputedStyle` 去解
 * "另一个主题"只会拿到当前生效的那一份；后端渲染又不能依赖 WebView。因此主题切换时
 * 无法重新解析，只能在这里各存一份。
 *
 * 改 tokens.css 的语义层或通道色时必须同步本文件；`test/video-export.test.js` 会校验
 * 两套主题的键集合一致、通道色互不相同。
 */

/**
 * @typedef {Object} VideoPalette
 * @property {string} background 视图背景
 * @property {string} card 卡片底色
 * @property {string} ink 主文字
 * @property {string} muted 次文字
 * @property {string} border 描边 / 网格
 * @property {string} accent 强调色（进度、断点编号）
 * @property {string} soft 二级块底色（胶囊、徽标、图例底）
 * @property {string} energy 累计能量色（与四条测量通道分开）
 * @property {[string,string,string,string]} series 电压 / 电流 / 功率 / 温度
 */

/** 暗色：tokens.css 的 :root（webDark alias）。 @type {VideoPalette} */
export const VIDEO_PALETTE_DARK = {
  background: '#292929', // --surface-content = --grey-16
  card: '#333333', // --surface-card = --grey-20
  ink: '#ffffff', // --text-primary = --white
  muted: '#d6d6d6', // --text-secondary = --grey-84
  border: '#525252', // --stroke-card = --grey-32
  accent: '#479ef5', // --accent-fill = --brand-100
  soft: '#383838', // --fill-subtle-hover = --grey-22
  energy: '#d161c4', // --ch-energy = --berry-tint20
  series: ['#65ade5', '#34d889', '#f98845', '#dc5e62'],
};

/** 浅色：`:root[data-theme="light"]`。 @type {VideoPalette} */
export const VIDEO_PALETTE_LIGHT = {
  background: '#ffffff', // --surface-content = --white
  card: '#fafafa', // --surface-card = --grey-98
  ink: '#242424', // --text-primary = --grey-14
  muted: '#424242', // --text-secondary = --grey-26
  border: '#e0e0e0', // --stroke-card = --grey-88
  accent: '#0f6cbd', // --accent-fill = --brand-80
  soft: '#f0f0f0', // --fill-subtle-hover = --grey-96
  energy: '#c239b3', // --ch-energy = --berry-primary
  series: ['#3a96dd', '#00cc6a', '#f7630c', '#d13438'],
};

/** @type {Record<'dark'|'light', VideoPalette>} */
export const VIDEO_PALETTES = { dark: VIDEO_PALETTE_DARK, light: VIDEO_PALETTE_LIGHT };

/**
 * @param {'dark'|'light'|string|undefined} theme
 * @returns {VideoPalette}
 */
export function videoPalette(theme) {
  return theme === 'dark' ? VIDEO_PALETTE_DARK : VIDEO_PALETTE_LIGHT;
}
