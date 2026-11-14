// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import { computeRangeStatsAsync, initialStats } from './range-stats.js';

const keys = /** @type {const} */ ([
  'x',
  'voltage',
  'current',
  'currentMagnitudes',
  'power',
  'temp',
  'recordingSegments',
  'sampleIntervals',
]);
/** @type {Worker|null} */
let worker = null;
/** @type {typeof Worker|null} */
let workerConstructor = null;
/** @type {{jobId:number,requestId:number,resolve:(reply:any)=>void,reject:(error:Error)=>void}|null} */
let pending = null;
/** @type {Record<string,Float64Array>|null} */
let buffers = null;
let nextJob = 0;
let nextRequest = 0;
let queue = Promise.resolve();

export function terminateRangeStatsWorker() {
  worker?.terminate();
  worker = null;
  workerConstructor = null;
  buffers = null;
  const request = pending;
  pending = null;
  request?.reject(new Error('范围统计 Worker 已停止'));
}

function getWorker() {
  if (worker && workerConstructor !== Worker) terminateRangeStatsWorker();
  if (!worker) {
    const active = new Worker(new URL('./range-stats-worker.js', import.meta.url), { type: 'module' });
    worker = active;
    workerConstructor = Worker;
    active.onmessage = ({ data }) => {
      if (!pending || worker !== active || data.jobId !== pending.jobId || data.requestId !== pending.requestId) return;
      const request = pending;
      pending = null;
      if (data.type === 'error') request.reject(new Error(data.error));
      else request.resolve(data);
    };
    active.onerror = active.onmessageerror = () => {
      if (worker === active) terminateRangeStatsWorker();
    };
  }
  return worker;
}

/** Transfer bounded scratch buffers, never source buffers. Jobs are serialized even across cancellation.
 * @param {import('./range-stats.js').RangeStatsSnapshot} snapshot
 * @param {import('./range-stats.js').FoldOptions & {isCancelled:()=>boolean,signal:AbortSignal}} options
 * @returns {Promise<import('./range-stats.js').RangeStats|null>}
 */
export function computeRangeStatsBackground(snapshot, options) {
  const jobId = ++nextJob;
  const job = queue.then(async () => {
    const cancelled = () => options.isCancelled() || options.signal.aborted;
    if (cancelled()) return null;
    if (typeof Worker === 'undefined') return computeRangeStatsAsync(snapshot, options);
    /** @type {Worker|null} */
    let active = null;
    const abort = () => {
      if (pending?.jobId === jobId) {
        const request = pending;
        pending = null;
        request.reject(new Error('范围统计已取消'));
      }
      active?.postMessage({ type: 'cancel', jobId });
    };
    try {
      active = getWorker();
      options.signal.addEventListener('abort', abort, { once: true });
      /** @param {Record<string,any>} message @param {Transferable[]} [transfer] */
      const send = (message, transfer = []) =>
        new Promise((resolve, reject) => {
          if (cancelled()) {
            reject(new Error('范围统计已取消'));
            return;
          }
          const requestId = ++nextRequest;
          pending = { jobId, requestId, resolve, reject };
          active?.postMessage({ ...message, jobId, requestId }, transfer);
        });
      const { columns: _source, ...stats } = initialStats(snapshot, options.seed ?? null);
      await send({ type: 'begin', stats, revision: snapshot.revision });
      for (let from = options.foldStart ?? snapshot.startIndex; from <= snapshot.endIndex; from += 4096) {
        if (cancelled()) return null;
        const to = Math.min(snapshot.endIndex + 1, from + 4096);
        const pool = buffers ?? Object.fromEntries(keys.map((key) => [key, new Float64Array(4096)]));
        buffers = null;
        const columns = {};
        const transfer = [];
        for (const key of keys) {
          const values = pool[key].subarray(0, to - from);
          snapshot[key].forEachChunk((chunk, offset) => values.set(chunk, offset - from), from, to);
          columns[key] = values;
          transfer.push(values.buffer);
        }
        const reply = await send(
          {
            type: 'chunk',
            from,
            columns,
            previousX: snapshot.x.valueAt(from - 1),
            previousSegment: snapshot.recordingSegments.valueAt(from - 1),
          },
          transfer,
        );
        buffers = Object.fromEntries(keys.map((key) => [key, new Float64Array(reply.columns[key].buffer)]));
      }
      const reply = await send({ type: 'end' });
      if (cancelled()) return null;
      if (reply.type !== 'result' || !reply.stats) throw new Error('范围统计 Worker 返回无效数据');
      return { ...reply.stats, columns: snapshot.columns };
    } catch (error) {
      if (cancelled()) return null;
      terminateRangeStatsWorker();
      console.warn('范围统计 Worker 不可用，使用协作分片:', error);
      return computeRangeStatsAsync(snapshot, options);
    } finally {
      options.signal.removeEventListener('abort', abort);
    }
  });
  queue = job.then(
    () => {},
    () => {},
  );
  return job;
}
