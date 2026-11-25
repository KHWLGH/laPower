// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import { t } from './i18n.js';
/**
 * @file 纯工具函数 — 无外部依赖，可被任意模块安全引用。
 */

/**
 * 将秒数格式化为 HH:mm:ss.s 相对时间字符串。
 * @param {number} seconds
 * @returns {string}
 */
export function formatRelativeHMS(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? seconds : 0;
  const totalTenths = Math.max(0, Math.round(safeSeconds * 10));

  const hours = Math.floor(totalTenths / 36000);
  const minutes = Math.floor((totalTenths % 36000) / 600);
  const secondsTenths = totalTenths % 600;
  const secs = Math.floor(secondsTenths / 10);
  const tenths = secondsTenths % 10;

  const hh = hours.toString().padStart(2, '0');
  const mm = minutes.toString().padStart(2, '0');
  const ss = secs.toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}.${tenths}`;
}

/**
 * 将墙钟毫秒时间戳格式化为本地 HH:mm:ss.s 字符串。
 * @param {number} ms
 * @returns {string}
 */
export function formatSystemHMS(ms) {
  if (!Number.isFinite(ms)) return '--';
  const roundedMs = Math.round(ms / 100) * 100;
  const d = new Date(roundedMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const tenths = Math.floor(d.getMilliseconds() / 100);
  return `${hh}:${mm}:${ss}.${tenths}`;
}

/**
 * 推导当前记录在相对秒 x = 0 处的系统墙钟毫秒起点。
 * @param {{ x?: { length?: number, valueAt?: (i: number) => number }, timestamps?: { length?: number, valueAt?: (i: number) => number } }|null|undefined} cols
 * @param {number|null|undefined} [fallbackStartTime=null]
 * @returns {number|null}
 */
export function recordingOriginMs(cols, fallbackStartTime = null) {
  if ((cols?.timestamps?.length ?? 0) > 0 && (cols?.x?.length ?? 0) > 0) {
    const t0 = cols?.timestamps?.valueAt?.(0);
    const x0 = cols?.x?.valueAt?.(0);
    if (Number.isFinite(t0) && Number.isFinite(x0)) {
      return Number(t0) - Number(x0) * 1000;
    }
  }
  return Number.isFinite(fallbackStartTime) ? Number(fallbackStartTime) : null;
}

/**
 * 按当前时间显示模式格式化记录时刻（相对秒或系统时间）。
 * @param {number} seconds
 * @param {{ useSystemTime?: boolean, originMs?: number|null }} [options]
 * @returns {string}
 */
export function formatRecordingTime(seconds, options = {}) {
  if (options.useSystemTime && Number.isFinite(options.originMs)) {
    const safeSeconds = Number.isFinite(seconds) ? seconds : 0;
    return formatSystemHMS(Number(options.originMs) + safeSeconds * 1000);
  }
  return formatRelativeHMS(seconds);
}

/**
 * 将 HEX 颜色字符串转换为 rgba() 格式。
 * @param {string} hex - 例如 "#65ade5"
 * @param {number} opacityPercent - 0-100
 * @returns {string}
 */
export function hexToRgba(hex, opacityPercent) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacityPercent / 100})`;
}

/**
 * 按采样率下拉框的既有文案约定，把采样间隔渲染成「N 次/秒」。
 * @param {number} intervalMs - 采样间隔（毫秒）
 * @returns {string}
 */
export function formatSampleRateLabel(intervalMs) {
  const perSecond = Number((1000 / intervalMs).toFixed(2));
  return intervalMs > 1000
    ? t('secondsPerSample', { value: perSecond, seconds: Number((intervalMs / 1000).toFixed(2)) })
    : t('samplesPerSecond', { value: perSecond });
}

/**
 * 把采样率写入下拉框。
 *
 * 后端与设置允许 1..60000ms 的任意值（CSV 导入会带进预设之外的采样率），
 * 而下拉框只列了 6 个常用档位。直接赋一个不在列表里的值会让 selectedIndex
 * 变成 -1、控件显示空白，所以这里按需补一个表示实际值的选项。
 *
 * @param {HTMLSelectElement} select
 * @param {number} intervalMs
 */
export function setSampleRateOption(select, intervalMs) {
  if (!select) return;
  const value = String(intervalMs);
  // Settings can be loaded before a real document exists (for example in a
  // headless host). Keep the state update useful without requiring Select DOM APIs.
  if (!select.options) {
    select.value = value;
    return;
  }
  if (!Array.from(select.options).some((o) => o.value === value)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = formatSampleRateLabel(intervalMs);
    // 按间隔升序插入，与预设选项的排列保持一致。
    const after = Array.from(select.options).find((o) => Number(o.value) > intervalMs);
    select.insertBefore(option, after ?? null);
  }
  select.value = value;
}
