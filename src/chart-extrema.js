// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import { columnValue } from './chart-buckets.js';
/** @typedef {import('./chart-buckets.js').NumericColumn} NumericColumn */
/** @typedef {{min:number[],max:number[],minIndex?:number[],maxIndex?:number[],count?:number[]}} ExtremaResult */
export const BLOCK_SIZE = 32;
const PAGE_SHIFT = 8;
const PAGE_NODES = 1 << PAGE_SHIFT;
const PAGE_MASK = PAGE_NODES - 1;
const MISSING = 0xffffffff;

export class ExactExtremaIndex {
  /** @param {number} [channels=8] */
  constructor(channels = 8) {
    this.channels = channels;
    this.stride = channels * 3;
    this.valueStride = channels * 2;
    /** @type {(Uint32Array|undefined)[]} */
    this._pages = new Array(64);
    this._offsets = new Int32Array(64);
    /** @type {(Float32Array|null)[]} */
    this._vPages = new Array(64);
    this._vOffsets = new Int32Array(64);
  }
  /** 24 KiB pages hold indices and counts, never duplicate the source values. @type {Uint32Array[][]} */
  levels = [];
  /** Float32 extrema envelopes for level >= 2 to avoid random Float64 reads on non-winning subtrees. @type {Float32Array[][]} */
  valueLevels = [];
  blocks = 0;
  reset() {
    this.levels = [];
    this.valueLevels = [];
    this.blocks = 0;
  }
  get byteLength() {
    let bytes = 0;
    for (let l = 0; l < this.levels.length; l++) {
      const pages = this.levels[l];
      if (!pages) continue;
      for (let p = 0; p < pages.length; p++) if (pages[p]) bytes += pages[p].byteLength;
    }
    for (let l = 0; l < this.valueLevels.length; l++) {
      const pages = this.valueLevels[l];
      if (!pages) continue;
      for (let p = 0; p < pages.length; p++) if (pages[p]) bytes += pages[p].byteLength;
    }
    return bytes;
  }
  /** @param {number} level @param {number} node */
  ensure(level, node) {
    this.levels[level] ??= [];
    this.levels[level][node >>> PAGE_SHIFT] ??= new Uint32Array(PAGE_NODES * this.stride);
    return this.levels[level][node >>> PAGE_SHIFT];
  }
  /** @param {number} level @param {number} node */
  ensureValue(level, node) {
    this.valueLevels[level] ??= [];
    this.valueLevels[level][node >>> PAGE_SHIFT] ??= new Float32Array(PAGE_NODES * this.valueStride);
    return this.valueLevels[level][node >>> PAGE_SHIFT];
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
    if (through <= this.blocks) return through === complete;
    const channels = this.channels;
    const stride = this.stride;
    const valueStride = this.valueStride;
    const chunkLists = new Array(channels);
    for (let s = 0; s < channels; s++) {
      const col = series[s];
      chunkLists[s] = col && '_chunks' in col ? col._chunks : null;
    }
    for (let block = this.blocks; block < through; block++) {
      const leaves = this.ensure(0, block);
      const start = block * BLOCK_SIZE;
      const offset = (block & PAGE_MASK) * stride;
      for (let s = 0; s < channels; s++) {
        const col = series[s];
        let min = NaN,
          max = NaN,
          mi = MISSING,
          ma = MISSING,
          count = 0;
        if (col) {
          const chunks = chunkLists[s];
          if (chunks) {
            const chunk = chunks[block >>> 7];
            const base = (block & 127) << 5;
            for (let k = 0; k < BLOCK_SIZE; k++) {
              const v = chunk[base + k];
              if (!Number.isFinite(v)) continue;
              count++;
              const i = start + k;
              if (mi === MISSING || v < min) {
                min = v;
                mi = i;
              }
              if (ma === MISSING || v > max) {
                max = v;
                ma = i;
              }
            }
          } else {
            for (let k = 0; k < BLOCK_SIZE; k++) {
              const i = start + k;
              const v = Number(col[i]);
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
        }
        leaves[offset + s] = mi;
        leaves[offset + channels + s] = ma;
        leaves[offset + channels * 2 + s] = count;
      }
      let node = block;
      for (let level = 1; node % 2 === 1; level++) {
        const childPageIdx = node >>> PAGE_SHIFT;
        const child = this.levels[level - 1][childPageIdx];
        const a = ((node - 1) & PAGE_MASK) * stride;
        const b = (node & PAGE_MASK) * stride;
        const childValues = level >= 3 ? this.valueLevels[level - 1][childPageIdx] : null;
        const va = level >= 3 ? ((node - 1) & PAGE_MASK) * valueStride : 0;
        const vb = level >= 3 ? (node & PAGE_MASK) * valueStride : 0;
        node = Math.floor(node / 2);
        const parent = this.ensure(level, node);
        const target = (node & PAGE_MASK) * stride;
        const parentValues = level >= 2 ? this.ensureValue(level, node) : null;
        const vTarget = level >= 2 ? (node & PAGE_MASK) * valueStride : 0;
        for (let s = 0; s < channels; s++) {
          const col = series[s];
          const chunks = chunkLists[s];
          const ami = child[a + s];
          const bmi = child[b + s];
          const ama = child[a + channels + s];
          const bma = child[b + channels + s];
          let mi = MISSING;
          let ma = MISSING;
          if (childValues && parentValues) {
            if (ami === MISSING) {
              mi = bmi;
              parentValues[vTarget + s] = bmi !== MISSING ? childValues[vb + s] : NaN;
            } else if (bmi === MISSING) {
              mi = ami;
              parentValues[vTarget + s] = childValues[va + s];
            } else {
              const fa = childValues[va + s];
              const fb = childValues[vb + s];
              if (fb < fa) {
                mi = bmi;
                parentValues[vTarget + s] = fb;
              } else if (fb > fa) {
                mi = ami;
                parentValues[vTarget + s] = fa;
              } else {
                const va64 = chunks ? chunks[ami >>> 12][ami & 4095] : Number(col[ami]);
                const vb64 = chunks ? chunks[bmi >>> 12][bmi & 4095] : Number(col[bmi]);
                mi = vb64 < va64 ? bmi : ami;
                parentValues[vTarget + s] = fa;
              }
            }
            if (ama === MISSING) {
              ma = bma;
              parentValues[vTarget + channels + s] = bma !== MISSING ? childValues[vb + channels + s] : NaN;
            } else if (bma === MISSING) {
              ma = ama;
              parentValues[vTarget + channels + s] = childValues[va + channels + s];
            } else {
              const fa = childValues[va + channels + s];
              const fb = childValues[vb + channels + s];
              if (fb > fa) {
                ma = bma;
                parentValues[vTarget + channels + s] = fb;
              } else if (fb < fa) {
                ma = ama;
                parentValues[vTarget + channels + s] = fa;
              } else {
                const wa64 = chunks ? chunks[ama >>> 12][ama & 4095] : Number(col[ama]);
                const wb64 = chunks ? chunks[bma >>> 12][bma & 4095] : Number(col[bma]);
                ma = wb64 > wa64 ? bma : ama;
                parentValues[vTarget + channels + s] = fa;
              }
            }
          } else {
            let minVal = NaN;
            if (ami === MISSING) {
              mi = bmi;
              if (parentValues && bmi !== MISSING) minVal = chunks ? chunks[bmi >>> 12][bmi & 4095] : Number(col[bmi]);
            } else if (bmi === MISSING) {
              mi = ami;
              if (parentValues) minVal = chunks ? chunks[ami >>> 12][ami & 4095] : Number(col[ami]);
            } else {
              const va64 = chunks ? chunks[ami >>> 12][ami & 4095] : Number(col[ami]);
              const vb64 = chunks ? chunks[bmi >>> 12][bmi & 4095] : Number(col[bmi]);
              if (vb64 < va64) {
                mi = bmi;
                minVal = vb64;
              } else {
                mi = ami;
                minVal = va64;
              }
            }
            if (parentValues) parentValues[vTarget + s] = minVal;

            let maxVal = NaN;
            if (ama === MISSING) {
              ma = bma;
              if (parentValues && bma !== MISSING) maxVal = chunks ? chunks[bma >>> 12][bma & 4095] : Number(col[bma]);
            } else if (bma === MISSING) {
              ma = ama;
              if (parentValues) maxVal = chunks ? chunks[ama >>> 12][ama & 4095] : Number(col[ama]);
            } else {
              const wa64 = chunks ? chunks[ama >>> 12][ama & 4095] : Number(col[ama]);
              const wb64 = chunks ? chunks[bma >>> 12][bma & 4095] : Number(col[bma]);
              if (wb64 > wa64) {
                ma = bma;
                maxVal = wb64;
              } else {
                ma = ama;
                maxVal = wa64;
              }
            }
            if (parentValues) parentValues[vTarget + channels + s] = maxVal;
          }
          parent[target + s] = mi;
          parent[target + channels + s] = ma;
          parent[target + channels * 2 + s] = child[a + channels * 2 + s] + child[b + channels * 2 + s];
        }
      }
    }
    this.blocks = through;
    return through === complete;
  }

  /** @param {ExtremaResult} result @param {NumericColumn[]} series @param {number} start @param {number} end @param {number} [channelMask=0xffffffff] */
  fold(result, series, start, end, channelMask = 0xffffffff) {
    const stride = end - start;
    const channels = this.channels;
    if (
      stride >= BLOCK_SIZE &&
      (stride & (stride - 1)) === 0 &&
      start % stride === 0 &&
      end / BLOCK_SIZE <= this.blocks
    ) {
      const level = 31 - Math.clz32(stride / BLOCK_SIZE);
      const node = start / stride;
      const pageIdx = node >>> PAGE_SHIFT;
      const nodeInPage = node & PAGE_MASK;
      const page = this.levels[level][pageIdx];
      const offset = nodeInPage * this.stride;
      const vPage = level >= 2 ? this.valueLevels[level][pageIdx] : null;
      const vOffset = level >= 2 ? nodeInPage * this.valueStride : 0;
      for (let s = 0; s < channels; s++) {
        if ((channelMask & (1 << s)) === 0) continue;
        const col = series[s];
        if (!col) continue;
        const count = page[offset + channels * 2 + s];
        if (!count) continue;
        const low = page[offset + s];
        const high = page[offset + channels + s];
        const chunks = '_chunks' in col ? col._chunks : null;
        if (!vPage || !Number.isFinite(result.min[s]) || vPage[vOffset + s] <= Math.fround(result.min[s])) {
          const min = chunks ? chunks[low >>> 12][low & 4095] : columnValue(col, low);
          if (!Number.isFinite(result.min[s]) || min < result.min[s]) {
            result.min[s] = min;
            if (result.minIndex) result.minIndex[s] = low;
          }
        }
        if (!vPage || !Number.isFinite(result.max[s]) || vPage[vOffset + channels + s] >= Math.fround(result.max[s])) {
          const max = chunks ? chunks[high >>> 12][high & 4095] : columnValue(col, high);
          if (!Number.isFinite(result.max[s]) || max > result.max[s]) {
            result.max[s] = max;
            if (result.maxIndex) result.maxIndex[s] = high;
          }
        }
        if (result.count) result.count[s] += count;
      }
      return;
    }
    const first = Math.ceil(start / BLOCK_SIZE),
      last = Math.min(Math.floor(end / BLOCK_SIZE), this.blocks);
    if (first >= last) {
      this.foldRaw(result, series, start, end, channelMask);
      return;
    }
    const headEnd = Math.min(end, first * BLOCK_SIZE);
    let block = first;
    let nodeCount = 0;
    const pages = this._pages;
    const offsets = this._offsets;
    const vPages = this._vPages;
    const vOffsets = this._vOffsets;
    while (block < last) {
      const rem = last - block;
      const maxPow2 = 1 << (31 - Math.clz32(rem));
      const align = block === 0 ? maxPow2 : block & -block;
      const span = align < maxPow2 ? align : maxPow2;
      const level = 31 - Math.clz32(span);
      const node = block / span;
      const pageIdx = node >>> PAGE_SHIFT;
      const nodeInPage = node & PAGE_MASK;
      pages[nodeCount] = this.levels[level][pageIdx];
      offsets[nodeCount] = nodeInPage * this.stride;
      if (level >= 2) {
        vPages[nodeCount] = this.valueLevels[level][pageIdx];
        vOffsets[nodeCount] = nodeInPage * this.valueStride;
      } else {
        vPages[nodeCount] = null;
        vOffsets[nodeCount] = 0;
      }
      nodeCount++;
      block += span;
    }
    const tailStart = Math.max(headEnd, block * BLOCK_SIZE);
    const mins = result.min,
      maxs = result.max,
      minIndices = result.minIndex,
      maxIndices = result.maxIndex,
      counts = result.count;
    for (let s = 0; s < channels; s++) {
      if ((channelMask & (1 << s)) === 0) continue;
      const col = series[s];
      if (!col) continue;
      let min = Number.isFinite(mins[s]) ? mins[s] : Infinity,
        max = Number.isFinite(maxs[s]) ? maxs[s] : -Infinity;
      let minF32 = Math.fround(min),
        maxF32 = Math.fround(max);
      let mi = -1,
        ma = -1,
        count = 0;
      const chunks = '_chunks' in col ? col._chunks : null;
      for (let i = start; i < headEnd; ) {
        const ci = i >>> 12;
        const chunk = chunks ? chunks[ci] : col;
        const base = chunks ? ci * 4096 : 0;
        const stop = chunks ? Math.min(headEnd, (ci + 1) * 4096) : headEnd;
        for (; i < stop; i++) {
          const v = Number(chunk[i - base]);
          if (!Number.isFinite(v)) continue;
          count++;
          if (v < min) {
            min = v;
            minF32 = Math.fround(v);
            mi = i;
          }
          if (v > max) {
            max = v;
            maxF32 = Math.fround(v);
            ma = i;
          }
        }
      }
      for (let j = 0; j < nodeCount; j++) {
        const page = /** @type {Uint32Array} */ (pages[j]),
          offset = offsets[j];
        const finite = page[offset + channels * 2 + s];
        if (!finite) continue;
        count += finite;
        const vPage = vPages[j];
        if (vPage) {
          const vOffset = vOffsets[j];
          if (vPage[vOffset + s] <= minF32) {
            const a = page[offset + s];
            const v = chunks ? chunks[a >>> 12][a & 4095] : columnValue(col, a);
            if (v < min) {
              min = v;
              minF32 = Math.fround(v);
              mi = a;
            }
          }
          if (vPage[vOffset + channels + s] >= maxF32) {
            const b = page[offset + channels + s];
            const w = chunks ? chunks[b >>> 12][b & 4095] : columnValue(col, b);
            if (w > max) {
              max = w;
              maxF32 = Math.fround(w);
              ma = b;
            }
          }
        } else {
          const a = page[offset + s],
            b = page[offset + channels + s];
          const v = chunks ? chunks[a >>> 12][a & 4095] : columnValue(col, a);
          const w = chunks ? chunks[b >>> 12][b & 4095] : columnValue(col, b);
          if (v < min) {
            min = v;
            minF32 = Math.fround(v);
            mi = a;
          }
          if (w > max) {
            max = w;
            maxF32 = Math.fround(w);
            ma = b;
          }
        }
      }
      for (let i = tailStart; i < end; ) {
        const ci = i >>> 12;
        const chunk = chunks ? chunks[ci] : col;
        const base = chunks ? ci * 4096 : 0;
        const stop = chunks ? Math.min(end, (ci + 1) * 4096) : end;
        for (; i < stop; i++) {
          const v = Number(chunk[i - base]);
          if (!Number.isFinite(v)) continue;
          count++;
          if (v < min) {
            min = v;
            minF32 = Math.fround(v);
            mi = i;
          }
          if (v > max) {
            max = v;
            maxF32 = Math.fround(v);
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

  /** @param {ExtremaResult} result @param {NumericColumn[]} series @param {number} start @param {number} end @param {number} [channelMask=0xffffffff] */
  foldRaw(result, series, start, end, channelMask = 0xffffffff) {
    for (let s = 0; s < this.channels; s++) {
      if ((channelMask & (1 << s)) === 0) continue;
      const col = series[s];
      let min = result.min[s],
        max = result.max[s],
        mi = -1,
        ma = -1,
        count = 0;
      if (col) {
        const chunks = '_chunks' in col ? col._chunks : null;
        for (let i = start; i < end; ) {
          const ci = i >>> 12;
          const chunk = chunks ? chunks[ci] : col;
          const base = chunks ? ci * 4096 : 0;
          const stop = chunks ? Math.min(end, (ci + 1) * 4096) : end;
          for (; i < stop; i++) {
            const v = Number(chunk[i - base]);
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
    const chunks = '_chunks' in col ? col._chunks : null;
    while (i < end) {
      const block = Math.floor(i / BLOCK_SIZE);
      if ((i & 31) === 0 && block < this.blocks && i + BLOCK_SIZE <= end) {
        const maxBlocks = Math.min(this.blocks - block, (end - i) >>> 5);
        const maxPow2 = 1 << (31 - Math.clz32(maxBlocks));
        const align = block === 0 ? maxPow2 : block & -block;
        const span = align < maxPow2 ? align : maxPow2;
        const level = 31 - Math.clz32(span);
        const node = block / span;
        if (
          this.levels[level][node >>> PAGE_SHIFT][(node & PAGE_MASK) * this.stride + this.channels * 2 + channel] !==
          span * BLOCK_SIZE
        )
          return false;
        i += span * BLOCK_SIZE;
      } else {
        const until = Math.min(end, (block + 1) * BLOCK_SIZE);
        const ci = i >>> 12;
        const chunk = chunks ? chunks[ci] : col;
        const base = chunks ? ci * 4096 : 0;
        const stop = chunks ? Math.min(until, (ci + 1) * 4096) : until;
        for (; i < stop; i++) if (!Number.isFinite(Number(chunk[i - base]))) return false;
      }
    }
    return true;
  }

  /** Count omitted samples without bridging missing data. @param {NumericColumn} col @param {number} channel @param {number} start @param {number} end */
  finiteCount(col, channel, start, end) {
    let count = 0,
      i = start;
    const chunks = '_chunks' in col ? col._chunks : null;
    while (i < end) {
      const block = Math.floor(i / BLOCK_SIZE);
      if ((i & 31) === 0 && block < this.blocks && i + BLOCK_SIZE <= end) {
        const maxBlocks = Math.min(this.blocks - block, (end - i) >>> 5);
        const maxPow2 = 1 << (31 - Math.clz32(maxBlocks));
        const align = block === 0 ? maxPow2 : block & -block;
        const span = align < maxPow2 ? align : maxPow2;
        const level = 31 - Math.clz32(span);
        const node = block / span;
        count +=
          this.levels[level][node >>> PAGE_SHIFT][(node & PAGE_MASK) * this.stride + this.channels * 2 + channel];
        i += span * BLOCK_SIZE;
      } else {
        const until = Math.min(end, (block + 1) * BLOCK_SIZE);
        const ci = i >>> 12;
        const chunk = chunks ? chunks[ci] : col;
        const base = chunks ? ci * 4096 : 0;
        const stop = chunks ? Math.min(until, (ci + 1) * 4096) : until;
        for (; i < stop; i++) if (Number.isFinite(Number(chunk[i - base]))) count++;
      }
    }
    return count;
  }
}
