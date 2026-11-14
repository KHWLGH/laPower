// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import { foldRangeStatsChunk } from './range-stats.js';

const worker = /** @type {any} */ (self);
/** @type {import('./range-stats.js').RangeStats|null} */
let stats = null;
let jobId = 0;
worker.onmessage = (/** @type {MessageEvent} */ event) => {
  const message = event.data;
  const identity = { jobId: message.jobId, requestId: message.requestId };
  try {
    if (message.type === 'begin') {
      jobId = message.jobId;
      stats = message.stats;
    } else if (message.jobId !== jobId) return;
    else if (message.type === 'cancel') {
      stats = null;
      return;
    } else if (message.type === 'chunk') {
      if (!stats) throw new Error('范围统计尚未开始');
      foldRangeStatsChunk(stats, message.from, message.columns, message.previousX, message.previousSegment);
      worker.postMessage(
        { ...identity, type: 'ack', columns: message.columns },
        Object.values(message.columns).map((/** @type {any} */ column) => column.buffer),
      );
      return;
    } else if (message.type === 'end') {
      worker.postMessage({ ...identity, type: 'result', stats });
      stats = null;
      return;
    }
    worker.postMessage({ ...identity, type: 'ack' });
  } catch (error) {
    stats = null;
    worker.postMessage({ ...identity, type: 'error', error: String(error) });
  }
};
