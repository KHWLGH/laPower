// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */

const MAGIC = 0x4750_5549;
const HEADER_BYTES = 32;
const SERIES_BYTES = 24;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_POINTS_PER_SERIES = 100_000;

/**
 * Encode one projected chart surface for the native GPUI renderer. Coordinates are
 * in physical pixels relative to the plot area; surface bounds are CSS pixels.
 * @param {{slot:number,visible:boolean,left:number,top:number,width:number,height:number,ratio:number,series:{channel:number,color:number,width:number,fillOpacity:number,baseline:number,points:ArrayLike<number>}[]}} frame
 */
export function encodeGpuiChartFrame(frame) {
  if (frame.slot !== 0 && frame.slot !== 1) throw new RangeError('invalid GPUI chart slot');
  if (frame.series.length > 8) throw new RangeError('too many GPUI chart series');

  let byteLength = HEADER_BYTES;
  for (const series of frame.series) {
    const pointCount = series.points.length / 2;
    if (!Number.isInteger(pointCount) || pointCount > MAX_POINTS_PER_SERIES) {
      throw new RangeError('invalid GPUI chart point count');
    }
    byteLength += SERIES_BYTES + pointCount * 8;
  }
  if (byteLength > MAX_FRAME_BYTES) throw new RangeError('GPUI chart frame exceeds 16 MiB');

  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint8(4, 1);
  view.setUint8(5, frame.slot);
  view.setUint8(6, frame.visible ? 1 : 0);
  view.setUint8(7, frame.series.length);
  for (const [offset, value] of [
    [8, frame.left],
    [12, frame.top],
    [16, frame.width],
    [20, frame.height],
    [24, frame.ratio],
  ]) {
    if (!Number.isFinite(value)) throw new RangeError('invalid GPUI chart bounds');
    view.setFloat32(offset, value, true);
  }

  let offset = HEADER_BYTES;
  for (const series of frame.series) {
    const pointCount = series.points.length / 2;
    if (
      !Number.isInteger(series.channel) ||
      series.channel < 0 ||
      series.channel > 7 ||
      !Number.isInteger(series.color) ||
      series.color < 0 ||
      series.color > 0xffffff ||
      !(series.width >= 0.25 && series.width <= 64) ||
      !(series.fillOpacity >= 0 && series.fillOpacity <= 1) ||
      !Number.isFinite(series.baseline)
    ) {
      throw new RangeError('invalid GPUI chart series');
    }
    view.setUint32(offset, series.channel, true);
    view.setFloat32(offset + 4, series.width, true);
    view.setFloat32(offset + 8, series.fillOpacity, true);
    view.setFloat32(offset + 12, series.baseline, true);
    view.setUint32(offset + 16, pointCount, true);
    view.setUint8(offset + 20, (series.color >> 16) & 0xff);
    view.setUint8(offset + 21, (series.color >> 8) & 0xff);
    view.setUint8(offset + 22, series.color & 0xff);
    offset += SERIES_BYTES;

    for (let index = 0; index < series.points.length; index += 2) {
      const x = series.points[index];
      const y = series.points[index + 1];
      if (!((Number.isFinite(x) && Number.isFinite(y)) || (Number.isNaN(x) && Number.isNaN(y)))) {
        throw new RangeError('GPUI chart points must be finite or paired NaNs');
      }
      view.setFloat32(offset, x, true);
      view.setFloat32(offset + 4, y, true);
      offset += 8;
    }
  }
  return bytes;
}

/**
 * Serialize access to Tauri IPC. Only the newest pending frame per surface is
 * retained while a native submission is in flight, preventing a render backlog.
 * @param {(command:string, args?:unknown)=>Promise<unknown>} invoke
 * @param {{onReady?:()=>void,onFailure?:(error:unknown)=>void}} [callbacks]
 */
export function createGpuiChartBridge(invoke, { onReady = () => {}, onFailure = () => {} } = {}) {
  /** @type {[Uint8Array|null, Uint8Array|null]} */
  const pending = [null, null];
  let ready = false;
  let starting = null;
  let sending = false;
  let hidePending = false;
  /** @type {number[][] | null} */
  let overlayPending = null;
  let failed = false;
  let preferredSlot = 0;

  async function fail(error) {
    if (failed) return;
    failed = true;
    ready = false;
    pending[0] = pending[1] = null;
    hidePending = false;
    overlayPending = null;
    try {
      await invoke('gpui_chart_hide');
    } catch {
      // The renderer may have already shut down.
    }
    onFailure(error);
  }

  async function drain() {
    if (sending || !ready) return;
    sending = true;
    try {
      while (ready) {
        if (hidePending) {
          hidePending = false;
          await invoke('gpui_chart_hide');
          continue;
        }
        if (overlayPending) {
          const rects = overlayPending;
          overlayPending = null;
          await invoke('gpui_chart_overlays', { rects });
        }
        const slot = pending[preferredSlot] ? preferredSlot : 1 - preferredSlot;
        const bytes = pending[slot];
        if (!bytes) break;
        preferredSlot = 1 - slot;
        pending[slot] = null;
        await invoke('gpui_chart_frame', bytes);
      }
    } catch (error) {
      await fail(error);
    } finally {
      sending = false;
      if (ready && (hidePending || overlayPending || pending.some((frame) => frame !== null))) void drain();
    }
  }

  /** @param {() => [Uint8Array, Uint8Array]} makeInitialFrames */
  function start(makeInitialFrames) {
    if (ready) return Promise.resolve(true);
    if (starting) return starting;
    starting = (async () => {
      const deadline = Date.now() + 8_000;
      while (!failed && Date.now() < deadline) {
        try {
          if (await invoke('gpui_chart_ready')) {
            const frames = makeInitialFrames();
            await Promise.all(frames.map((bytes) => invoke('gpui_chart_frame', bytes)));
            ready = true;
            onReady();
            void drain();
            return true;
          }
        } catch (error) {
          await fail(error);
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      return false;
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  /** @param {0|1} slot @param {Uint8Array} bytes */
  function submit(slot, bytes) {
    if (!ready || failed) return;
    pending[slot] = bytes;
    void drain();
  }

  function hide() {
    if (!ready || failed) return;
    pending[0] = pending[1] = null;
    hidePending = true;
    void drain();
  }

  /** @param {number[][]} rects */
  function setOverlays(rects) {
    if (!ready || failed) return;
    overlayPending = rects;
    void drain();
  }

  return { start, submit, hide, setOverlays, isReady: () => ready };
}

const FOREGROUND_SELECTOR = '.chart-tooltip,.flyout-panel,.cs-menu,.range-handle,#toast-region > *,dialog';

/** @param {(rects: number[][]) => void} update */
export function watchGpuiChartOverlays(update) {
  let request = 0;
  let previous = '';
  const watched = new Set();
  const observer = new MutationObserver(schedule);
  const resize = new ResizeObserver(schedule);

  function sync() {
    request = 0;
    const ratio = window.devicePixelRatio || 1;
    const elements = [...document.querySelectorAll(FOREGROUND_SELECTOR)];
    if (elements.length !== watched.size || elements.some((el) => !watched.has(el))) {
      watched.clear();
      observer.disconnect();
      resize.disconnect();
      for (const el of elements) {
        watched.add(el);
        observer.observe(el, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open'] });
        resize.observe(el);
      }
    }
    const rects = [];
    for (const el of elements) {
      const { left, top, right, bottom, width, height } = el.getBoundingClientRect();
      if (width < 1 || height < 1 || getComputedStyle(el).visibility === 'hidden') continue;
      if (el.matches('dialog:modal')) {
        rects.splice(0, rects.length, [0, 0, Math.ceil(innerWidth * ratio), Math.ceil(innerHeight * ratio)]);
        break;
      }
      rects.push([
        Math.floor((left - 2) * ratio),
        Math.floor((top - 2) * ratio),
        Math.ceil((right + 2) * ratio),
        Math.ceil((bottom + 2) * ratio),
      ]);
      if (rects.length === 32) break;
    }
    const key = rects.join(';');
    if (key !== previous) {
      previous = key;
      update(rects);
    }
  }

  function schedule() {
    if (!request) request = requestAnimationFrame(sync);
  }

  // Toasts, tooltip and delayed dialog elements can be mounted dynamically.
  const mounting = new MutationObserver((records) => {
    if (
      records.some(({ addedNodes, removedNodes }) =>
        [...addedNodes, ...removedNodes].some(
          (node) =>
            node instanceof Element &&
            (watched.has(node) || node.matches(FOREGROUND_SELECTOR) || node.querySelector(FOREGROUND_SELECTOR)),
        ),
      )
    )
      schedule();
  });
  mounting.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  sync();
  return {
    refresh: schedule,
    stop() {
      observer.disconnect();
      mounting.disconnect();
      resize.disconnect();
      window.removeEventListener('resize', schedule);
      if (request) cancelAnimationFrame(request);
    },
  };
}
