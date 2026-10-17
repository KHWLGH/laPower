// @ts-check
import { F64_CHUNK_SIZE } from './state.js';
/**
 * 主图显示用 min/max 桶。全量数据仍在 F64Col；这里只为 uPlot 准备 O(宽度) 顶点。
 */

export const BUCKET_MIN = 64;
export const DISPLAY_SERIES = 8;

/** @typedef {ArrayLike<number>|import('./state.js').F64Col|import('./state.js').F64Snapshot} NumericColumn */

/** @param {NumericColumn} column @param {number} index */
export function columnValue(column, index) {
  return Number('valueAt' in column ? column.valueAt(index) : column[index]);
}

/** A direct view of one storage block (or the full ordinary array). @param {NumericColumn} column @param {number} index @param {number} end */
export function columnSpan(column, index, end) {
  if ('_chunks' in column) {
    const chunk = column._chunks[index >>> 12];
    return {
      values: chunk,
      base: (index >>> 12) * F64_CHUNK_SIZE,
      end: Math.min(end, ((index >>> 12) + 1) * F64_CHUNK_SIZE),
    };
  }
  return { values: column, base: 0, end };
}

/** @param {number} width */
export function bucketCap(width) {
  const w = Number.isFinite(width) && width > 0 ? width : 600;
  return Math.max(BUCKET_MIN, Math.floor(w));
}

/**
 * 窗口条带宽度（每桶样本数）。`rebuild` 与调用方的复用判断必须同源，否则「已经画对了」
 * 会被误判成需要重建 —— 或反过来让两种密度同时存在。
 * @param {number} count @param {number} cap
 */
export function stripePpb(count, cap) {
  const required = Math.max(1, Math.ceil(count / Math.max(BUCKET_MIN, cap | 0)));
  // Keep a live projection's density stable as history grows. A one-step increase
  // would rebuild the entire history every ~cap incoming samples at 1KSPS.
  return 2 ** Math.ceil(Math.log2(required));
}

/**
 * @param {NumericColumn} xs
 * @param {number} length
 * @param {number} xVal
 * @returns {number}
 */
export function nearestIndex(xs, length, xVal) {
  if (length <= 0) return 0;
  if (!Number.isFinite(xVal)) return 0;
  let lo = 0;
  let hi = length - 1;
  const first = Number(columnValue(xs, lo));
  const last = Number(columnValue(xs, hi));
  if (xVal <= first) return lo;
  if (xVal >= last) return hi;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(columnValue(xs, mid)) <= xVal) lo = mid;
    else hi = mid;
  }
  return xVal - Number(columnValue(xs, lo)) <= Number(columnValue(xs, hi)) - xVal ? lo : hi;
}

/**
 * 第一个 x >= target 的下标；全部更小则返回 length。
 * @param {NumericColumn} xs
 * @param {number} length
 * @param {number} target
 */
export function firstIndexAtOrAfter(xs, length, target) {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (columnValue(xs, mid) >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * 第一个 x > target 的下标（exclusive end）。
 * @param {NumericColumn} xs
 * @param {number} length
 * @param {number} target
 */
export function firstIndexAfter(xs, length, target) {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (columnValue(xs, mid) > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * @typedef {{x0:number,x1:number,start:number,n:number,min:number[],max:number[],minIndex:number[],maxIndex:number[],count:number[]}} DisplayBucket
 * @typedef {{x:Float64Array,y:Float64Array,indices:Uint32Array,connect:Uint8Array}} OrderedGeometry
 * @typedef {{first:number[],last:number[],minX:number[],maxX:number[],minRank:number[],maxRank:number[]}} StreamPoints
 */

export class SeriesBuckets {
  /** @type {DisplayBucket[]} */
  list = [];
  ppb = 1;
  srcStart = 0;
  srcEnd = 0;
  cap = BUCKET_MIN;
  /** @type {{x:Float64Array,ys:Float64Array[],channels:OrderedGeometry[]}|null} */
  _flatView = null;
  _dirty = 0;
  /** @type {NumericColumn|null} */
  _xs = null;
  /** @type {NumericColumn[]} */
  _series = [];
  /** @type {import('./chart-extrema.js').ExactExtremaIndex|null} */
  _index = null;
  /** Only standalone pushSample needs endpoint values/ranks; ordinary projections read source columns. @type {WeakMap<DisplayBucket,StreamPoints>} */
  _stream = new WeakMap();
  /** @type {{x:Float64Array,y:Float64Array,indices:Uint32Array,connect:Uint8Array,ends:Uint32Array}[]} */
  _buffers = [];

  /** @param {number} [start=0] */
  reset(start = 0) {
    this.list = [];
    this.ppb = 1;
    this.srcStart = this.srcEnd = start;
    this.cap = BUCKET_MIN;
    this._flatView = null;
    this._dirty = 0;
    this._xs = null;
    this._series = [];
    this._index = null;
    this._stream = new WeakMap();
  }
  /** @param {number} start @param {number} end */
  canAppend(start, end) {
    return this.srcStart === start && this.srcEnd >= start && this.srcEnd <= end;
  }
  /** @param {number} x @param {number[]} values */
  pushSample(x, values) {
    this.pushSampleInternal(x, values, true);
  }
  /** @param {number} x @param {number[]} values */
  pushSampleFixed(x, values) {
    this.pushSampleInternal(x, values, false);
  }
  /** @param {number} x @param {number[]} values @param {boolean} merge */
  pushSampleInternal(x, values, merge) {
    const last = this.list.at(-1),
      partial = last && last.n < this.ppb;
    this._dirty = Math.min(this._dirty, partial ? this.list.length - 1 : this.list.length);
    if (partial) {
      const meta = this._stream.get(last);
      foldValues(last, values, this.srcEnd);
      last.x1 = x;
      last.n++;
      if (meta) updateStream(meta, last, x, values, this.srcEnd);
    } else {
      const bucket = makeBucket(x, values, this.srcEnd);
      this.list.push(bucket);
      if (!this._xs)
        this._stream.set(bucket, {
          first: values.slice(),
          last: values.slice(),
          minX: Array(8).fill(x),
          maxX: Array(8).fill(x),
          minRank: bucket.count.slice(),
          maxRank: bucket.count.slice(),
        });
    }
    this.srcEnd++;
    this._flatView = null;
    if (merge) this.mergeDown();
  }
  mergeDown() {
    while (this.list.length > this.cap) this.coarsenTo(this.ppb * 2);
  }
  /** @param {number} ppb */
  coarsenTo(ppb) {
    if (!Number.isFinite(ppb) || ppb < this.ppb || Math.log2(ppb / this.ppb) % 1 !== 0)
      throw new RangeError('Bucket density must be a power-of-two multiple of the current density');
    while (this.ppb < ppb) {
      const merged = [];
      for (let i = 0; i < this.list.length; i += 2) {
        const a = this.list[i],
          b = this.list[i + 1];
        if (!b) {
          merged.push(a);
          continue;
        }
        const out = mergeBucket(a, b),
          am = this._stream.get(a),
          bm = this._stream.get(b);
        if (am && bm) {
          const meta = {
            first: am.first,
            last: bm.last,
            minX: am.minX.slice(),
            maxX: am.maxX.slice(),
            minRank: am.minRank.slice(),
            maxRank: am.maxRank.slice(),
          };
          for (let s = 0; s < 8; s++) {
            if (out.minIndex[s] === b.minIndex[s] && b.minIndex[s] >= 0) {
              meta.minX[s] = bm.minX[s];
              meta.minRank[s] = a.count[s] + bm.minRank[s];
            }
            if (out.maxIndex[s] === b.maxIndex[s] && b.maxIndex[s] >= 0) {
              meta.maxX[s] = bm.maxX[s];
              meta.maxRank[s] = a.count[s] + bm.maxRank[s];
            }
          }
          this._stream.set(out, meta);
        }
        merged.push(out);
      }
      this.list = merged;
      this.ppb *= 2;
      this._flatView = null;
      this._dirty = 0;
    }
  }

  /** @param {NumericColumn} xs @param {NumericColumn[]} series @param {number} start @param {number} end @param {number} cap @param {import('./chart-extrema.js').ExactExtremaIndex|null} [index=null] */
  rebuild(xs, series, start, end, cap, index = null) {
    const step = this.beginRebuild(xs, series, start, end, cap, index);
    while (!step(Infinity)) {
      /* synchronous API */
    }
  }
  /** @param {NumericColumn} xs @param {NumericColumn[]} series @param {number} start @param {number} end @param {number} cap @param {import('./chart-extrema.js').ExactExtremaIndex|null} [index=null] */
  beginRebuild(xs, series, start, end, cap, index = null) {
    this.reset(start);
    this._xs = xs;
    this._series = series;
    this._index = index;
    this.ppb = stripePpb(end - start, cap);
    let i = start;
    /** @type {DisplayBucket|null} */
    let bucket = null;
    const values = new Array(8);
    return (maxSamples = 4096, maxBuckets = Infinity) => {
      let remaining = Math.max(1, maxSamples),
        bucketsRemaining = Math.max(1, maxBuckets);
      while (i < end && remaining > 0 && bucketsRemaining > 0) {
        if (!bucket) {
          for (let s = 0; s < 8; s++) values[s] = series[s] ? columnValue(series[s], i) : NaN;
          bucket = makeBucket(columnValue(xs, i), values, i++);
          remaining--;
        }
        const through = Math.min(end, bucket.start + this.ppb, i + remaining);
        if (index) index.fold(bucket, series, i, through);
        else {
          for (let s = 0; s < 8; s++) {
            const col = series[s];
            if (!col) continue;
            let min = bucket.min[s],
              max = bucket.max[s],
              mi = bucket.minIndex[s],
              ma = bucket.maxIndex[s],
              count = bucket.count[s];
            for (let j = i; j < through; ) {
              const span = columnSpan(col, j, through);
              for (; j < span.end; j++) {
                const v = Number(span.values[j - span.base]);
                if (!Number.isFinite(v)) continue;
                count++;
                if (mi < 0 || v < min) {
                  min = v;
                  mi = j;
                }
                if (ma < 0 || v > max) {
                  max = v;
                  ma = j;
                }
              }
            }
            bucket.min[s] = min;
            bucket.max[s] = max;
            bucket.minIndex[s] = mi;
            bucket.maxIndex[s] = ma;
            bucket.count[s] = count;
          }
        }
        bucket.n += through - i;
        bucket.x1 = columnValue(xs, through - 1);
        remaining -= through - i;
        i = through;
        if (i === end || i === bucket.start + this.ppb) {
          this.list.push(bucket);
          bucket = null;
          bucketsRemaining--;
        }
      }
      this.srcEnd = i;
      this._flatView = null;
      if (i === end) this.cap = Math.max(BUCKET_MIN, this.list.length * 2);
      return i === end;
    };
  }

  /** @param {NumericColumn} xs @param {NumericColumn[]} series @param {number} end */
  appendThrough(xs, series, end) {
    this.appendThroughMode(xs, series, end, false);
  }
  /** @param {NumericColumn} xs @param {NumericColumn[]} series @param {number} end */
  appendThroughFixed(xs, series, end) {
    this.appendThroughMode(xs, series, end, true);
  }
  /** @param {NumericColumn} xs @param {NumericColumn[]} series @param {number} end @param {boolean} fixed */
  appendThroughMode(xs, series, end, fixed) {
    this._xs = xs;
    this._series = series;
    const values = new Array(8);
    for (let i = this.srcEnd; i < end; ) {
      const xSpan = columnSpan(xs, i, end),
        spans = series.map((col) => (col ? columnSpan(col, i, end) : null));
      const through = Math.min(xSpan.end, ...spans.map((span) => span?.end ?? end));
      for (; i < through; i++) {
        for (let s = 0; s < 8; s++) {
          const span = spans[s];
          values[s] = span ? Number(span.values[i - span.base]) : NaN;
        }
        this.pushSampleInternal(Number(xSpan.values[i - xSpan.base]), values, !fixed);
      }
    }
  }

  /** @param {DisplayBucket} b @param {number} s @param {number} a @param {number} end */
  connected(b, s, a, end) {
    if (b.count[s] === b.n) return true;
    const col = this._series[s];
    if (col) {
      if (this._index) return this._index.allFinite(col, s, a, end + 1);
      for (let i = a; i <= end; ) {
        const span = columnSpan(col, i, end + 1);
        for (; i < span.end; i++) if (!Number.isFinite(Number(span.values[i - span.base]))) return false;
      }
      return true;
    }
    const meta = this._stream.get(b);
    if (!meta) return false;
    const rank = (i) =>
      i === b.start
        ? Number(Number.isFinite(meta.first[s]))
        : i === b.start + b.n - 1
          ? b.count[s]
          : i === b.minIndex[s]
            ? meta.minRank[s]
            : meta.maxRank[s];
    return rank(end) - rank(a) === end - a;
  }

  /** Per-channel candidates stay independent; the shared carrier only drives scales/cursor. */
  flatten() {
    if (this._flatView) return this._flatView;
    const size = this.list.length * 4;
    const channels = Array.from({ length: 8 }, (_, s) => {
      let buffer = this._buffers[s];
      const reused = !!buffer && buffer.x.length >= size;
      if (!reused) {
        const capacity = Math.max(64, size, buffer ? buffer.x.length * 2 : 0);
        buffer = {
          x: new Float64Array(capacity),
          y: new Float64Array(capacity),
          indices: new Uint32Array(capacity),
          connect: new Uint8Array(capacity),
          ends: new Uint32Array(capacity / 4),
        };
        this._buffers[s] = buffer;
      }
      const { x, y, indices, connect, ends } = buffer,
        dirty = reused ? this._dirty : 0;
      let n = dirty ? ends[dirty - 1] : 0;
      const candidates = new Array(4),
        col = this._series[s];
      for (let bi = n ? dirty : 0; bi < this.list.length; bi++) {
        const b = this.list[bi],
          meta = this._stream.get(b);
        candidates[0] = b.start;
        candidates[1] = b.minIndex[s];
        candidates[2] = b.maxIndex[s];
        candidates[3] = b.start + b.n - 1;
        candidates.sort((a, b) => a - b);
        let previous = -1;
        for (const i of candidates) {
          if (i < 0 || i === previous) continue;
          const first = i === b.start,
            last = i === b.start + b.n - 1,
            min = i === b.minIndex[s];
          const px = this._xs
            ? columnValue(this._xs, i)
            : first
              ? b.x0
              : last
                ? b.x1
                : min
                  ? meta?.minX[s]
                  : meta?.maxX[s];
          const py = col
            ? columnValue(col, i)
            : first
              ? meta?.first[s]
              : last
                ? meta?.last[s]
                : min
                  ? b.min[s]
                  : b.max[s];
          connect[n] = Number(
            Number.isFinite(py) &&
              n > 0 &&
              Number.isFinite(y[n - 1]) &&
              (previous < 0 ? i === indices[n - 1] + 1 : this.connected(b, s, previous, i)),
          );
          x[n] = Number(px);
          y[n] = Number(py);
          indices[n++] = i;
          previous = i;
        }
        ends[bi] = n;
      }
      return {
        x: x.subarray(0, n),
        y: y.subarray(0, n),
        indices: indices.subarray(0, n),
        connect: connect.subarray(0, n),
      };
    });
    const x = new Float64Array(this.list.length * 2),
      ys = Array.from({ length: 8 }, () => new Float64Array(x.length));
    let n = 0;
    for (const b of this.list)
      for (const last of [false, true]) {
        const px = last ? b.x1 : b.x0,
          meta = this._stream.get(b);
        if (n > 0 && x[n - 1] === px) n--;
        x[n] = px;
        for (let s = 0; s < 8; s++)
          ys[s][n] = this._series[s]
            ? columnValue(this._series[s], last ? b.start + b.n - 1 : b.start)
            : ((last ? meta?.last[s] : meta?.first[s]) ?? NaN);
        n++;
      }
    this._dirty = this.list.length;
    this._flatView = { x: x.subarray(0, n), ys: ys.map((col) => col.subarray(0, n)), channels };
    return this._flatView;
  }
}

/** @param {number} x @param {number[]} values @param {number} start @returns {DisplayBucket} */
function makeBucket(x, values, start) {
  const min = new Array(8),
    max = new Array(8),
    minIndex = new Array(8),
    maxIndex = new Array(8),
    count = new Array(8);
  for (let s = 0; s < 8; s++) {
    const v = values[s],
      valid = Number.isFinite(v);
    min[s] = max[s] = valid ? v : NaN;
    minIndex[s] = maxIndex[s] = valid ? start : -1;
    count[s] = Number(valid);
  }
  return { x0: x, x1: x, start, n: 1, min, max, minIndex, maxIndex, count };
}
/** @param {DisplayBucket} b @param {number[]} values @param {number} i */
function foldValues(b, values, i) {
  for (let s = 0; s < 8; s++) {
    const v = values[s];
    if (!Number.isFinite(v)) continue;
    b.count[s]++;
    if (b.minIndex[s] < 0 || v < b.min[s]) {
      b.min[s] = v;
      b.minIndex[s] = i;
    }
    if (b.maxIndex[s] < 0 || v > b.max[s]) {
      b.max[s] = v;
      b.maxIndex[s] = i;
    }
  }
}
/** @param {StreamPoints} meta @param {DisplayBucket} b @param {number} x @param {number[]} values @param {number} i */
function updateStream(meta, b, x, values, i) {
  meta.last = values.slice();
  for (let s = 0; s < 8; s++) {
    if (b.minIndex[s] === i) {
      meta.minX[s] = x;
      meta.minRank[s] = b.count[s];
    }
    if (b.maxIndex[s] === i) {
      meta.maxX[s] = x;
      meta.maxRank[s] = b.count[s];
    }
  }
}
/** @param {DisplayBucket} a @param {DisplayBucket} b @returns {DisplayBucket} */
function mergeBucket(a, b) {
  const out = {
    x0: a.x0,
    x1: b.x1,
    start: a.start,
    n: a.n + b.n,
    min: a.min.slice(),
    max: a.max.slice(),
    minIndex: a.minIndex.slice(),
    maxIndex: a.maxIndex.slice(),
    count: a.count.map((n, s) => n + b.count[s]),
  };
  for (let s = 0; s < 8; s++) {
    if (b.minIndex[s] >= 0 && (a.minIndex[s] < 0 || b.min[s] < a.min[s])) {
      out.min[s] = b.min[s];
      out.minIndex[s] = b.minIndex[s];
    }
    if (b.maxIndex[s] >= 0 && (a.maxIndex[s] < 0 || b.max[s] > a.max[s])) {
      out.max[s] = b.max[s];
      out.maxIndex[s] = b.maxIndex[s];
    }
  }
  return out;
}
