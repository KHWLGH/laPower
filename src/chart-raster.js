// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * @file 主图表离屏转置桶光栅器与面积填充合成。
 *
 * 将高密度有序桶几何按屏幕 X 列扫描合并垂直覆盖区间后写入转置的 OffscreenCanvas，
 * 避免每帧把海量回溯 Path2D 交给 GPU 同步光栅化。
 */

import { rasterOrderedFill } from './chart-fill.js';

const IS_LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(0x04030201).buffer)[0] === 0x01;
const HEX6_RE = /^#[\da-f]{6}$/i;
const GESTURE_RASTER_PIXELS = 480_000;

/** @type {Path2D|null} */
let emptyPath = null;

/** @returns {Path2D} */
export function getEmptyPath() {
  if (!(emptyPath instanceof Path2D)) emptyPath = new Path2D();
  return emptyPath;
}

/** @param {number} r @param {number} g @param {number} b @param {number} a */
function packRgba(r, g, b, a) {
  return (
    (IS_LITTLE_ENDIAN
      ? ((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)
      : ((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0
  );
}

/** @type {Map<string, {rgb: number, opacity: number}|null>} */
const fillColorCache = new Map();

/** @param {string} fill */
function parseFillRgba(fill) {
  let cached = fillColorCache.get(fill);
  if (cached !== undefined) return cached;
  const rgba = fill.match(/[\d.]+/g)?.map(Number);
  cached =
    rgba && rgba.length === 4
      ? { rgb: (((rgba[2] & 255) << 16) | ((rgba[1] & 255) << 8) | (rgba[0] & 255)) >>> 0, opacity: rgba[3] }
      : null;
  fillColorCache.set(fill, cached);
  return cached;
}

/**
 * @typedef {{
 *   canvas: OffscreenCanvas,
 *   ctx: OffscreenCanvasRenderingContext2D,
 *   image: ImageData,
 *   pixels: Uint32Array,
 *   dirtyTop: number,
 *   dirtyBottom: number,
 *   dirtyLeft: number,
 *   dirtyRight: number,
 *   columns: number[][],
 *   columnLengths: Uint32Array,
 *   coverage: Float64Array,
 *   pending: boolean,
 *   scale: number,
 * }} BucketRasterState
 */

/**
 * 创建主图表的桶光栅化器与填充合成钩子。
 * @param {{
 *   isMainChart: (u: any) => boolean,
 *   isWindowBound: () => boolean,
 *   isRangeDragging: () => boolean,
 *   getPlotPixelRatio: () => number,
 *   getOrderedPaint: (u: any, seriesIdx: number) => any,
 *   recordPaintStage: (u: any, name: string, started: number, count?: number) => void,
 * }} hooks
 */
export function createBucketRasterizer(hooks) {
  /** @type {BucketRasterState|null} */
  let bucketRaster = null;
  /** @type {BucketRasterState|null} */
  let restingRaster = null;
  /** @type {BucketRasterState|null} */
  let gestureRaster = null;

  /** @param {any} u */
  function useBucketRaster(u) {
    if (!hooks.isMainChart(u) || !hooks.isWindowBound() || typeof OffscreenCanvas === 'undefined') return false;
    for (let i = 1; i < u.series.length; i++) {
      const s = u.series[i];
      if (s.show && (s.alpha !== 1 || !HEX6_RE.test(s.stroke(u, 0)))) return false;
    }
    return true;
  }

  /** @param {{rasterFill: boolean}} geometry @param {unknown} fill */
  function useRasterFill(geometry, fill) {
    // One upload for all supported strokes and shadows in a moving viewport.
    return (hooks.isRangeDragging() || geometry.rasterFill) && typeof fill === 'string' && fill.startsWith('rgba(');
  }

  /** @param {any} u */
  function flushBucketRaster(u) {
    if (!bucketRaster?.pending) return;
    bucketRaster.pending = false;
    const { dirtyTop, dirtyBottom, dirtyLeft, dirtyRight, scale } = bucketRaster;
    const bbox = u.bbox;
    const width = bucketRaster.canvas.height;
    const height = bucketRaster.canvas.width;
    if (dirtyBottom <= dirtyTop || dirtyRight <= dirtyLeft) return;
    const uploadStarted = performance.now();
    const scratch = bucketRaster.ctx;
    const pad = scale < 1 ? 1 : 0;
    const copyTop = Math.max(0, dirtyTop - pad);
    const copyBottom = Math.min(height, dirtyBottom + pad);
    const copyLeft = Math.max(0, dirtyLeft - pad);
    const copyRight = Math.min(width, dirtyRight + pad);
    scratch.putImageData(bucketRaster.image, 0, 0, copyTop, copyLeft, copyBottom - copyTop, copyRight - copyLeft);
    const dirtyW = dirtyBottom - dirtyTop;
    const dirtyH = dirtyRight - dirtyLeft;
    const ctx = u.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
    ctx.clip();
    const factor = 1 / scale;
    ctx.transform(0, factor, factor, 0, bbox.left, bbox.top);
    ctx.drawImage(bucketRaster.canvas, dirtyTop, dirtyLeft, dirtyW, dirtyH, dirtyTop, dirtyLeft, dirtyW, dirtyH);
    ctx.restore();
    hooks.recordPaintStage(u, 'bitmap', uploadStarted);
  }

  /** @param {any} u @param {any} geometry @param {string} fill */
  function rasterBucketFill(u, geometry, fill) {
    const started = performance.now();
    const parsed = parseFillRgba(fill);
    if (!parsed || !bucketRaster) return;
    const { scale } = bucketRaster;
    const width = bucketRaster.canvas.height;
    const dirty = { left: width, right: 0 };
    const bounds = rasterOrderedFill({
      points: geometry.points,
      connect: geometry.connect,
      base: (geometry.base - u.bbox.top) * scale,
      leftOffset: u.bbox.left,
      topOffset: u.bbox.top,
      scale,
      width,
      height: bucketRaster.canvas.width,
      pixels: bucketRaster.pixels,
      coverage: bucketRaster.coverage,
      rgb: parsed.rgb,
      opacity: parsed.opacity,
      transposed: true,
      opaque: geometry.raster,
      composite: bucketRaster.pending,
      dirty,
    });
    bucketRaster.dirtyTop = Math.min(bucketRaster.dirtyTop, bounds.top);
    bucketRaster.dirtyBottom = Math.max(bucketRaster.dirtyBottom, bounds.bottom);
    bucketRaster.dirtyLeft = Math.min(bucketRaster.dirtyLeft, dirty.left);
    bucketRaster.dirtyRight = Math.max(bucketRaster.dirtyRight, dirty.right);
    hooks.recordPaintStage(u, 'fill', started);
  }

  /** @param {any} u @param {number} seriesIdx */
  function drawBucketFill(u, seriesIdx) {
    if (!hooks.isWindowBound()) return;
    const geometry = hooks.getOrderedPaint(u, seriesIdx);
    const series = u.series[seriesIdx];
    const fill = series.fill(u, seriesIdx);
    if (!geometry || !fill || !Number.isFinite(geometry.base)) return;
    if (useBucketRaster(u) && useRasterFill(geometry, fill)) return;
    if (bucketRaster?.pending) flushBucketRaster(u);
    const started = performance.now();
    const { points, connect, base } = geometry;
    const ctx = u.ctx;
    const bbox = u.bbox;
    if (!geometry.fill) {
      const path = new Path2D();
      let open = false;
      let lastX = 0;
      const close = () => {
        if (!open) return;
        path.lineTo(lastX, base);
        path.closePath();
        open = false;
      };
      for (let i = 0; i < connect.length; i++) {
        const x = points[i * 2];
        const y = points[i * 2 + 1];
        if (!connect[i] || !Number.isFinite(x) || !Number.isFinite(y)) close();
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (!open) {
          path.moveTo(x, base);
          path.lineTo(x, y);
          open = true;
        } else path.lineTo(x, y);
        lastX = x;
      }
      close();
      geometry.fill = path;
    }
    // Keep the area on the destination canvas. Filling the CPU scratch before
    // drawImage forces its pending path to rasterize synchronously on WebView2.
    ctx.save();
    ctx.beginPath();
    ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
    ctx.clip();
    ctx.fillStyle = fill;
    ctx.globalAlpha = series.alpha;
    ctx.fill(geometry.fill);
    ctx.restore();
    hooks.recordPaintStage(u, 'fill', started);
  }

  /**
   * Scan-convert by x column, then union covered intervals before writing any pixels.
   * @param {any} u @param {number} seriesIdx
   */
  function drawBucketRaster(u, seriesIdx) {
    if (!useBucketRaster(u)) {
      if (!hooks.isMainChart(u) || !hooks.isWindowBound()) return;
      // Unfilled fallback paths are stroked by uPlot itself. Only a filled path
      // defers its stroke until after our custom area composition.
      if (!u.series[seriesIdx].fill(u, seriesIdx)) return;
      const stroke = hooks.getOrderedPaint(u, seriesIdx)?.stroke;
      if (!stroke) return;
      const ctx = u.ctx;
      const bbox = u.bbox;
      const series = u.series[seriesIdx];
      ctx.save();
      ctx.beginPath();
      ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
      ctx.clip();
      ctx.strokeStyle = series.stroke(u, seriesIdx);
      ctx.lineWidth = series.width * hooks.getPlotPixelRatio();
      ctx.globalAlpha = series.alpha;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'butt';
      ctx.stroke(stroke);
      ctx.restore();
      return;
    }
    const geometry = hooks.getOrderedPaint(u, seriesIdx);
    if (!geometry) return;
    const started = performance.now();
    const bbox = u.bbox;
    // Bound bitmap upload and blending while the viewport is moving, not at rest.
    const scale = hooks.isRangeDragging()
      ? Math.min(1, Math.sqrt(GESTURE_RASTER_PIXELS / (bbox.width * bbox.height)))
      : 1;
    const width = Math.ceil(bbox.width * scale);
    const height = Math.ceil(bbox.height * scale);
    bucketRaster = scale < 1 ? gestureRaster : restingRaster;
    if (!bucketRaster || bucketRaster.canvas.width !== height || bucketRaster.canvas.height !== width) {
      // Transpose the scratch: each screen column becomes one contiguous row.
      const canvas = new OffscreenCanvas(height, width);
      // The shared scratch is rewritten by CPU pixels after every channel.
      const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (
        canvas.getContext('2d', { willReadFrequently: true })
      );
      const image = ctx.createImageData(height, width);
      bucketRaster = {
        canvas,
        ctx,
        image,
        pixels: new Uint32Array(image.data.buffer),
        dirtyTop: height,
        dirtyBottom: 0,
        dirtyLeft: width,
        dirtyRight: 0,
        columns: Array.from({ length: width }, () => []),
        columnLengths: new Uint32Array(width),
        coverage: new Float64Array((height + 1) * 3),
        pending: false,
        scale,
      };
      if (scale < 1) gestureRaster = bucketRaster;
      else restingRaster = bucketRaster;
    }
    const { pixels, columns, columnLengths } = bucketRaster;
    if (!bucketRaster.pending) {
      if (bucketRaster.dirtyBottom > bucketRaster.dirtyTop && bucketRaster.dirtyRight > bucketRaster.dirtyLeft) {
        for (let x = bucketRaster.dirtyLeft; x < bucketRaster.dirtyRight; x++) {
          pixels.fill(0, x * height + bucketRaster.dirtyTop, x * height + bucketRaster.dirtyBottom);
        }
      }
      bucketRaster.dirtyTop = height;
      bucketRaster.dirtyBottom = 0;
      bucketRaster.dirtyLeft = width;
      bucketRaster.dirtyRight = 0;
    }
    const series = u.series[seriesIdx];
    const hex = Number.parseInt(series.stroke(u, seriesIdx).slice(1), 16);
    const color = packRgba(hex >>> 16, (hex >>> 8) & 255, hex & 255, 255);
    const fill = series.fill(u, seriesIdx);
    const half = (series.width * hooks.getPlotPixelRatio() * scale) / 2;
    const intervalStarted = performance.now();
    if (!geometry.raster || geometry.raster.half !== half || geometry.raster.scale !== scale) {
      columnLengths.fill(0);
      const { points, connect } = geometry;
      for (let i = 0; i < connect.length; i++) {
        const x1 = (points[i * 2] - bbox.left) * scale;
        const y1 = (points[i * 2 + 1] - bbox.top) * scale;
        if (!Number.isFinite(x1) || !Number.isFinite(y1)) continue;
        const x0 = connect[i] ? (points[(i - 1) * 2] - bbox.left) * scale : x1;
        const y0 = connect[i] ? (points[(i - 1) * 2 + 1] - bbox.top) * scale : y1;
        const maxX = x0 > x1 ? x0 : x1;
        const minX = x0 < x1 ? x0 : x1;
        if (maxX + half <= 0 || minX - half >= width) continue;
        const maxY = y0 > y1 ? y0 : y1;
        const minY = y0 < y1 ? y0 : y1;
        if (maxY + half <= 0 || minY - half >= height) continue;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const left = Math.max(0, Math.floor(minX - half));
        const right = Math.min(width, Math.ceil(maxX + half));
        for (let x = left; x < right; x++) {
          const ta = dx ? Math.max(0, Math.min(1, (x - half - x0) / dx)) : 0;
          const tb = dx ? Math.max(0, Math.min(1, (x + 1 + half - x0) / dx)) : 1;
          const a = y0 + dy * ta;
          const b = y0 + dy * tb;
          const top = Math.max(0, Math.floor(Math.min(a, b) - half));
          const bottom = Math.min(height, Math.ceil(Math.max(a, b) + half));
          if (top < bottom) {
            const n = columnLengths[x];
            columns[x][n] = top;
            columns[x][n + 1] = bottom;
            columnLengths[x] = n + 2;
          }
        }
      }
      let entries = 0;
      for (let x = 0; x < width; x++) {
        const length = columnLengths[x];
        if (length === 0) continue;
        const spans = columns[x];
        // In-place insertion sort of interval pairs; each column has a bounded candidate count.
        for (let i = 2; i < length; i += 2) {
          const a = spans[i];
          const b = spans[i + 1];
          let j = i;
          while (j > 0 && spans[j - 2] > a) {
            spans[j] = spans[j - 2];
            spans[j + 1] = spans[j - 1];
            j -= 2;
          }
          spans[j] = a;
          spans[j + 1] = b;
        }
        let top = spans[0];
        let bottom = spans[1];
        let count = 0;
        for (let i = 2; i <= length; i += 2) {
          if (i < length && spans[i] <= bottom) {
            bottom = Math.max(bottom, spans[i + 1]);
            continue;
          }
          if (bottom > top) {
            spans[count++] = top;
            spans[count++] = bottom;
          }
          top = spans[i];
          bottom = spans[i + 1];
        }
        columnLengths[x] = count;
        entries += count;
      }
      geometry.intervalBuffer =
        geometry.intervalBuffer?.length >= entries ? geometry.intervalBuffer : new Uint32Array(Math.max(64, entries));
      geometry.offsetBuffer =
        geometry.offsetBuffer?.length >= width + 1 ? geometry.offsetBuffer : new Uint32Array(width + 1);
      const spans = geometry.intervalBuffer.subarray(0, entries);
      const offsets = geometry.offsetBuffer.subarray(0, width + 1);
      let cursor = 0;
      for (let x = 0; x < width; x++) {
        offsets[x] = cursor;
        for (let i = 0; i < columnLengths[x]; i++) spans[cursor++] = columns[x][i];
      }
      offsets[width] = cursor;
      geometry.raster = { half, spans, offsets, scale };
      hooks.recordPaintStage(u, 'intervals', intervalStarted);
    } else hooks.recordPaintStage(u, 'intervalsCached', intervalStarted);
    const { spans, offsets } = geometry.raster;
    if (Number.isFinite(geometry.base) && useRasterFill(geometry, fill)) rasterBucketFill(u, geometry, fill);
    let { dirtyTop, dirtyBottom, dirtyLeft, dirtyRight } = bucketRaster;
    for (let x = 0; x < width; x++) {
      const startIdx = offsets[x];
      const endIdx = offsets[x + 1];
      if (startIdx >= endIdx) continue;
      if (x < dirtyLeft) dirtyLeft = x;
      dirtyRight = x + 1;
      for (let i = startIdx; i < endIdx; i += 2) {
        const top = spans[i];
        const bottom = spans[i + 1];
        dirtyTop = Math.min(dirtyTop, top);
        dirtyBottom = Math.max(dirtyBottom, bottom);
        pixels.fill(color, x * height + top, x * height + bottom);
      }
    }
    bucketRaster.dirtyTop = dirtyTop;
    bucketRaster.dirtyBottom = dirtyBottom;
    bucketRaster.dirtyLeft = dirtyLeft;
    bucketRaster.dirtyRight = dirtyRight;
    bucketRaster.pending = true;
    hooks.recordPaintStage(u, 'raster', started);
    for (let i = seriesIdx + 1; i < u.series.length; i++) if (u.series[i].show) return;
    flushBucketRaster(u);
  }

  return {
    useBucketRaster,
    drawBucketFill,
    drawBucketRaster,
    flushBucketRaster,
    reset() {
      bucketRaster = null;
      restingRaster = null;
      gestureRaster = null;
    },
    getMemoryBytes() {
      return {
        coverageBytes: bucketRaster?.coverage.byteLength ?? 0,
        rasterBytes: bucketRaster?.image.data.byteLength ?? 0,
      };
    },
    isScaledDown() {
      return Boolean(bucketRaster && bucketRaster.scale < 1);
    },
  };
}
