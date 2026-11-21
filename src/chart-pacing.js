// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */

/** Reserve time for input, including raster work that finishes after the JS draw hook. */
export function liveChartIntervalMs(workMs, dense = false, nextFrameDelayMs = 0, idleFrameMs = 1000 / 60) {
  const frameBudget = Number.isFinite(idleFrameMs) && idleFrameMs > 0 ? idleFrameMs : 1000 / 60;
  const cpu = Number.isFinite(workMs) ? Math.max(0, workMs) : 0;
  const raster = dense && Number.isFinite(nextFrameDelayMs) ? Math.max(0, nextFrameDelayMs - frameBudget) : 0;
  const work = cpu + raster;
  if (work <= Math.min(8, frameBudget / 2)) return 0;
  return Math.min(100, Math.max(20, work * 2));
}

/**
 * Taper strokes as more samples share each screen pixel, without changing the samples.
 * @param {number} pointCount
 * @param {number} plotWidth CSS pixels
 */
export function zoomStrokeFactor(pointCount, plotWidth) {
  const density = pointCount / Math.max(1, plotWidth);
  return density <= 1 ? 1 : Math.max(0.5, density ** -0.22);
}

/** Display-only feedback; acquisition and the stored samples never use this policy. */
export class ChartRenderPolicy {
  /** @param {{initialDensity?:number, maxDensity?:number}} [options] */
  constructor({ initialDensity = 2, maxDensity = 16 } = {}) {
    this.initialDensity = initialDensity;
    this.maxDensity = maxDensity;
    this.pixelsPerBucket = initialDensity;
  }
  idleFrameMs = 1000 / 60;
  nextFrameDelayMs = 0;
  slowFrames = 0;
  /** @type {number|null} */
  stableSince = null;
  lastChangeAt = 0;
  /** @type {number|null} */
  lastFeedbackAt = null;

  reset() {
    this.pixelsPerBucket = this.initialDensity;
    this.nextFrameDelayMs = 0;
    this.lastChangeAt = 0;
    this.breakFeedback();
  }

  /** Background time and unrelated windows cannot count towards stable recovery. */
  breakFeedback() {
    this.slowFrames = 0;
    this.stableSince = null;
    this.lastFeedbackAt = null;
  }

  /**
   * @param {{delayMs: number, at: number, idleFrameMs?: number, visible: boolean, dense: boolean, interactive?: boolean}} sample
   * @returns {boolean} Whether the display density changed.
   */
  observe({ delayMs, at, idleFrameMs = this.idleFrameMs, visible, dense, interactive = false }) {
    if (!visible || !dense || !Number.isFinite(delayMs) || delayMs < 0 || !Number.isFinite(at)) {
      this.breakFeedback();
      return false;
    }
    if (Number.isFinite(idleFrameMs) && idleFrameMs > 0) this.idleFrameMs = idleFrameMs;
    this.nextFrameDelayMs = delayMs;
    // Sparse/hidden intervals are not evidence of two seconds of healthy chart paints.
    if (this.lastFeedbackAt !== null && (at < this.lastFeedbackAt || at - this.lastFeedbackAt > 250)) {
      this.slowFrames = 0;
      this.stableSince = null;
    }
    this.lastFeedbackAt = at;
    const slow = delayMs > Math.max(33, this.idleFrameMs * 2);
    this.slowFrames = slow ? this.slowFrames + 1 : 0;
    if (slow) this.stableSince = null;
    const old = this.pixelsPerBucket;
    // Continuous input needs the next window promptly; a measured slow frame
    // can lower its display budget immediately. Static/live paints still confirm.
    if (delayMs > 100 || this.slowFrames >= 2 || (interactive && slow)) {
      this.pixelsPerBucket = Math.min(this.maxDensity, old * (delayMs > 100 ? 4 : 2));
      this.slowFrames = 0;
    } else if (delayMs <= this.idleFrameMs * 1.5) {
      this.stableSince ??= at;
      if (at - this.stableSince >= 2000 && at - this.lastChangeAt >= 5000) {
        this.pixelsPerBucket = Math.max(1, old / 2);
        this.stableSince = at;
      }
    } else {
      this.stableSince = null;
    }
    if (old === this.pixelsPerBucket) return false;
    this.lastChangeAt = at;
    this.stableSince = null;
    return true;
  }
}
