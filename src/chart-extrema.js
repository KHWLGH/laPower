// @ts-check
import { columnSpan, columnValue } from './chart-buckets.js';
/** @typedef {import('./chart-buckets.js').NumericColumn} NumericColumn */
/** @typedef {{min:number[],max:number[],minIndex?:number[],maxIndex?:number[],count?:number[]}} ExtremaResult */
export const BLOCK_SIZE = 32;
const CHANNELS = 8;
const STRIDE = CHANNELS * 3;
const PAGE_SHIFT = 8;
const PAGE_NODES = 1 << PAGE_SHIFT;
const PAGE_MASK = PAGE_NODES - 1;
const MISSING = 0xffffffff;

export class ExactExtremaIndex {
  /** 24 KiB pages hold indices and counts, never duplicate the source values. @type {Uint32Array[][]} */
  levels = [];
  blocks = 0;
  reset() {
    this.levels = [];
    this.blocks = 0;
  }
  get byteLength() {
    return this.levels.reduce((sum, pages) => sum + pages.reduce((n, p) => n + p.byteLength, 0), 0);
  }
  /** @param {number} level @param {number} node */
  ensure(level, node) {
    this.levels[level] ??= [];
    this.levels[level][node >>> PAGE_SHIFT] ??= new Uint32Array(PAGE_NODES * STRIDE);
    return this.levels[level][node >>> PAGE_SHIFT];
  }
  /** @param {NumericColumn[]} series @param {number} length */
  sync(series, length) {
    this.syncStep(series, length, Infinity);
  }
  /** Publish only complete leaves and ancestors; unfinished tails remain queryable raw.
   * @param {NumericColumn[]} series @param {number} length @param {number} [maxBlocks=128] */
  syncStep(series, length, maxBlocks = 128) {
    const complete = Math.floor(length / BLOCK_SIZE);
    if (complete < this.blocks) this.reset();
    const through = Math.min(complete, this.blocks + Math.max(1, Math.floor(maxBlocks)));
    for (let block = this.blocks; block < through; block++) {
      const leaves = this.ensure(0, block),
        start = block * BLOCK_SIZE,
        offset = (block & PAGE_MASK) * STRIDE;
      for (let s = 0; s < CHANNELS; s++) {
        const col = series[s];
        let min = NaN,
          max = NaN,
          mi = MISSING,
          ma = MISSING,
          count = 0;
        if (col) {
          const span = columnSpan(col, start, start + BLOCK_SIZE);
          for (let i = start; i < start + BLOCK_SIZE; i++) {
            const v = Number(span.values[i - span.base]);
            if (!Number.isFinite(v)) continue;
            count++;
            if (mi === MISSING || v < min) {
              min = v;
              mi = i;
            }
            if (ma === MISSING || v > max) {
              max = v;
              ma = i;
            }
          }
        }
        leaves[offset + s] = mi;
        leaves[offset + CHANNELS + s] = ma;
        leaves[offset + CHANNELS * 2 + s] = count;
      }
      let node = block;
      for (let level = 1; node % 2 === 1; level++) {
        const child = this.levels[level - 1][node >>> PAGE_SHIFT];
        const a = ((node - 1) & PAGE_MASK) * STRIDE,
          b = (node & PAGE_MASK) * STRIDE;
        node = Math.floor(node / 2);
        const parent = this.ensure(level, node),
          target = (node & PAGE_MASK) * STRIDE;
        for (let s = 0; s < CHANNELS; s++) {
          const col = series[s],
            ami = child[a + s],
            bmi = child[b + s],
            ama = child[a + CHANNELS + s],
            bma = child[b + CHANNELS + s];
          parent[target + s] =
            ami === MISSING || (bmi !== MISSING && columnValue(col, bmi) < columnValue(col, ami)) ? bmi : ami;
          parent[target + CHANNELS + s] =
            ama === MISSING || (bma !== MISSING && columnValue(col, bma) > columnValue(col, ama)) ? bma : ama;
          parent[target + CHANNELS * 2 + s] = child[a + CHANNELS * 2 + s] + child[b + CHANNELS * 2 + s];
        }
      }
    }
    this.blocks = through;
    return through === complete;
  }

  /** @param {ExtremaResult} result @param {NumericColumn[]} series @param {number} start @param {number} end */
  fold(result, series, start, end) {
    const first = Math.ceil(start / BLOCK_SIZE),
      last = Math.min(Math.floor(end / BLOCK_SIZE), this.blocks);
    const headEnd = Math.min(end, first * BLOCK_SIZE);
    let block = first;
    const pages = [],
      offsets = [];
    while (block < last) {
      let level = 0,
        span = 1;
      while (block % (span * 2) === 0 && block + span * 2 <= last) {
        span *= 2;
        level++;
      }
      const node = block / span;
      pages.push(this.levels[level][node >>> PAGE_SHIFT]);
      offsets.push((node & PAGE_MASK) * STRIDE);
      block += span;
    }
    const mins = result.min,
      maxs = result.max,
      minIndices = result.minIndex,
      maxIndices = result.maxIndex,
      counts = result.count;
    for (let s = 0; s < CHANNELS; s++) {
      const col = series[s];
      if (!col) continue;
      let min = Number.isFinite(mins[s]) ? mins[s] : Infinity,
        max = Number.isFinite(maxs[s]) ? maxs[s] : -Infinity;
      let mi = -1,
        ma = -1,
        count = 0;
      const chunks = '_chunks' in col ? col._chunks : null;
      for (let i = start; i < headEnd; ) {
        const span = columnSpan(col, i, headEnd);
        for (; i < span.end; i++) {
          const v = Number(span.values[i - span.base]);
          if (!Number.isFinite(v)) continue;
          count++;
          if (v < min) {
            min = v;
            mi = i;
          }
          if (v > max) {
            max = v;
            ma = i;
          }
        }
      }
      for (let j = 0; j < pages.length; j++) {
        const page = pages[j],
          offset = offsets[j];
        const finite = page[offset + CHANNELS * 2 + s];
        if (!finite) continue;
        count += finite;
        const a = page[offset + s],
          b = page[offset + CHANNELS + s];
        const v = chunks ? chunks[a >>> 12][a & 4095] : col[a];
        const w = chunks ? chunks[b >>> 12][b & 4095] : col[b];
        if (v < min) {
          min = v;
          mi = a;
        }
        if (w > max) {
          max = w;
          ma = b;
        }
      }
      for (let i = Math.max(headEnd, block * BLOCK_SIZE); i < end; ) {
        const span = columnSpan(col, i, end);
        for (; i < span.end; i++) {
          const v = Number(span.values[i - span.base]);
          if (!Number.isFinite(v)) continue;
          count++;
          if (v < min) {
            min = v;
            mi = i;
          }
          if (v > max) {
            max = v;
            ma = i;
          }
        }
      }
      mins[s] = min === Infinity ? NaN : min;
      maxs[s] = max === -Infinity ? NaN : max;
      if (minIndices && mi >= 0) minIndices[s] = mi;
      if (maxIndices && ma >= 0) maxIndices[s] = ma;
      if (counts) counts[s] += count;
    }
  }

  /** @param {ExtremaResult} result @param {NumericColumn[]} series @param {number} start @param {number} end */
  foldRaw(result, series, start, end) {
    for (let s = 0; s < CHANNELS; s++) {
      const col = series[s];
      let min = result.min[s],
        max = result.max[s],
        mi = -1,
        ma = -1,
        count = 0;
      if (col)
        for (let i = start; i < end; ) {
          const span = columnSpan(col, i, end);
          for (; i < span.end; i++) {
            const v = Number(span.values[i - span.base]);
            if (!Number.isFinite(v)) continue;
            count++;
            if (!Number.isFinite(min) || v < min) {
              min = v;
              mi = i;
            }
            if (!Number.isFinite(max) || v > max) {
              max = v;
              ma = i;
            }
          }
        }
      result.min[s] = min;
      result.max[s] = max;
      if (result.minIndex && mi >= 0) result.minIndex[s] = mi;
      if (result.maxIndex && ma >= 0) result.maxIndex[s] = ma;
      if (result.count) result.count[s] += count;
    }
  }

  /** @param {NumericColumn} col @param {number} channel @param {number} start @param {number} end */
  allFinite(col, channel, start, end) {
    let i = start;
    while (i < end) {
      const block = Math.floor(i / BLOCK_SIZE);
      if (i % BLOCK_SIZE === 0 && block < this.blocks && i + BLOCK_SIZE <= end) {
        let span = 1,
          level = 0;
        while (block % (span * 2) === 0 && block + span * 2 <= this.blocks && i + span * 2 * BLOCK_SIZE <= end) {
          span *= 2;
          level++;
        }
        const node = block / span;
        if (
          this.levels[level][node >>> PAGE_SHIFT][(node & PAGE_MASK) * STRIDE + CHANNELS * 2 + channel] !==
          span * BLOCK_SIZE
        )
          return false;
        i += span * BLOCK_SIZE;
      } else {
        const span = columnSpan(col, i, Math.min(end, (block + 1) * BLOCK_SIZE));
        for (; i < span.end; i++) if (!Number.isFinite(Number(span.values[i - span.base]))) return false;
      }
    }
    return true;
  }

  /** Count omitted samples without bridging missing data. @param {NumericColumn} col @param {number} channel @param {number} start @param {number} end */
  finiteCount(col, channel, start, end) {
    let count = 0,
      i = start;
    while (i < end) {
      const block = Math.floor(i / BLOCK_SIZE);
      if (i % BLOCK_SIZE === 0 && block < this.blocks && i + BLOCK_SIZE <= end) {
        let span = 1,
          level = 0;
        while (block % (span * 2) === 0 && block + span * 2 <= this.blocks && i + span * 2 * BLOCK_SIZE <= end) {
          span *= 2;
          level++;
        }
        const node = block / span;
        count += this.levels[level][node >>> PAGE_SHIFT][(node & PAGE_MASK) * STRIDE + CHANNELS * 2 + channel];
        i += span * BLOCK_SIZE;
      } else {
        const until = Math.min(end, (block + 1) * BLOCK_SIZE);
        const span = columnSpan(col, i, until);
        for (; i < span.end; i++) if (Number.isFinite(Number(span.values[i - span.base]))) count++;
      }
    }
    return count;
  }
}
