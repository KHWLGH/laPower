// @ts-check
/**
 * @file 报告视频导出的选项与白名单（纯模块，无 DOM / Tauri）。
 *
 * 白名单同时被 UI（生成下拉项）、投影（决定帧数与桶数）和后端校验使用，因此只在这里
 * 定义一次。后端 `video_export::model::RESOLUTIONS` 必须与此一致；不一致会在
 * `video_export_start` 处被拒绝，而不是悄悄降级成别的分辨率。
 */

/** @typedef {{width:number, height:number}} VideoResolution */
/** @typedef {'h264'|'h265'} VideoCodec */
/** @typedef {'mp4'|'mov'} VideoFormat */
/** @typedef {'dark'|'light'} VideoTheme */
/** @typedef {'auto'|'hardware'|'software'} VideoAcceleration */
/** @typedef {'standard'|'high'|'ultra'} VideoQuality */

/**
 * @typedef {Object} VideoExportOptions
 * @property {number} width
 * @property {number} height
 * @property {number} fps
 * @property {VideoAcceleration} acceleration
 * @property {VideoQuality} quality
 * @property {VideoCodec} codec
 * @property {VideoFormat} format
 * @property {number} durationS
 * @property {VideoTheme} theme
 * @property {boolean[]} visibleSeries 电压 / 电流 / 功率 / 温度
 * @property {'image'|'video'} reportType
 * @property {'widescreen'|'long'} imageLayout
 * @property {boolean} showMarkers
 * @property {boolean} showMarkerDetails
 */

/** @type {VideoResolution[]} */
export const VIDEO_RESOLUTIONS = [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
];

/** @type {number[]} */
export const VIDEO_FRAME_RATES = [24, 30, 60];

/** @type {VideoCodec[]} */
export const VIDEO_CODECS = ['h264', 'h265'];

/** @type {VideoFormat[]} */
export const VIDEO_FORMATS = ['mp4', 'mov'];

/** 视频时长上下限；与后端 `MAX_DURATION_S` 一致。 */
export const VIDEO_MIN_DURATION_S = 1;
export const VIDEO_MAX_DURATION_S = 60;

/** 报告能标注的断点数量上限；与后端 `MAX_MARKERS` 一致。 */
export const VIDEO_MAX_MARKERS = 8;

/** 曲线投影桶数；与后端 `MAX_OVERVIEW_POINTS` 的上限相容。 */
export const VIDEO_OVERVIEW_BINS = 256;
/** First/last plus min/max of four channels per bucket; mirrored by the host. */
export const VIDEO_MAX_OVERVIEW_POINTS = VIDEO_OVERVIEW_BINS * 10;

/** @type {VideoExportOptions} */
export const defaultVideoExportOptions = {
  reportType: 'image',
  imageLayout: 'widescreen',
  showMarkers: true,
  showMarkerDetails: true,
  width: 1920,
  height: 1080,
  fps: 30,
  codec: 'h264',
  acceleration: 'auto',
  quality: 'high',
  format: 'mp4',
  durationS: 5,
  theme: 'light',
  visibleSeries: [true, true, true, true],
};

/**
 * @param {unknown} value
 * @returns {value is VideoResolution}
 */
function isResolution(value) {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = /** @type {VideoResolution} */ (value);
  return VIDEO_RESOLUTIONS.some(
    (resolution) => resolution.width === candidate.width && resolution.height === candidate.height,
  );
}

/**
 * 把已保存的选项收成合法值：任何越界或损坏的字段回落到默认值。
 * 只做白名单校验，不尝试"修正"用户的选择。
 * @param {unknown} saved
 * @returns {VideoExportOptions}
 */
export function normalizeVideoExportOptions(saved) {
  const source = /** @type {Partial<VideoExportOptions>} */ (saved && typeof saved === 'object' ? saved : {});
  const resolution = isResolution(source)
    ? { width: /** @type {VideoResolution} */ (source).width, height: /** @type {VideoResolution} */ (source).height }
    : { width: defaultVideoExportOptions.width, height: defaultVideoExportOptions.height };
  const durationS = Number(source.durationS);
  const visible = Array.isArray(source.visibleSeries) ? source.visibleSeries : [];
  return {
    ...resolution,
    reportType: source.reportType === 'video' ? 'video' : 'image',
    imageLayout: source.imageLayout === 'long' ? 'long' : 'widescreen',
    showMarkers: typeof source.showMarkers === 'boolean' ? source.showMarkers : true,
    showMarkerDetails: typeof source.showMarkerDetails === 'boolean' ? source.showMarkerDetails : true,
    acceleration:
      source.acceleration === 'hardware' || source.acceleration === 'software' ? source.acceleration : 'auto',
    quality: source.quality === 'standard' || source.quality === 'ultra' ? source.quality : 'high',
    fps: VIDEO_FRAME_RATES.includes(/** @type {number} */ (source.fps))
      ? /** @type {number} */ (source.fps)
      : defaultVideoExportOptions.fps,
    codec: VIDEO_CODECS.includes(/** @type {VideoCodec} */ (source.codec))
      ? /** @type {VideoCodec} */ (source.codec)
      : defaultVideoExportOptions.codec,
    format: VIDEO_FORMATS.includes(/** @type {VideoFormat} */ (source.format))
      ? /** @type {VideoFormat} */ (source.format)
      : defaultVideoExportOptions.format,
    durationS:
      Number.isInteger(durationS) && durationS >= VIDEO_MIN_DURATION_S && durationS <= VIDEO_MAX_DURATION_S
        ? durationS
        : defaultVideoExportOptions.durationS,
    theme: source.theme === 'dark' || source.theme === 'light' ? source.theme : defaultVideoExportOptions.theme,
    visibleSeries: [0, 1, 2, 3].map((index) =>
      typeof visible[index] === 'boolean' ? visible[index] : defaultVideoExportOptions.visibleSeries[index],
    ),
  };
}

/**
 * 某组选项的总帧数。投影、进度与后端校验共用这一个公式。
 * @param {{durationS:number, fps:number}} options
 * @returns {number}
 */
export function videoFrameCount(options) {
  if ('reportType' in options && options.reportType === 'image') return 1;
  return options.durationS * options.fps;
}

/**
 * 解析时长输入框的原始文本，同时给出可用的秒数。
 *
 * 输入框是用户唯一能敲出越界值的地方，所以校验必须能读到「还没提交的值」：61 不该被悄悄夹回 5，
 * 空串和小数都不能生成视频。调用方在 valid 为 false 时禁用生成，也不要把 value 当成用户的选择写回设置。
 * @param {unknown} raw 输入框的 value（或已保存的数值）
 * @returns {{value:number, valid:boolean}} 合法时 value 是 1–60 的整数
 */
export function parseDurationInput(raw) {
  const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '');
  if (!/^\d+$/.test(text)) return { value: Number.NaN, valid: false };
  const value = Number(text);
  const valid = Number.isInteger(value) && value >= VIDEO_MIN_DURATION_S && value <= VIDEO_MAX_DURATION_S;
  return { value, valid };
}
