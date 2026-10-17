// @ts-check
/** Rasterize the area between monotone ordered line segments and their baseline.
 * Each pixel receives its analytic coverage once, including baseline crossings.
 * Scratch storage is three row arrays, independent of the number of samples.
 * @param {{points:Float64Array,connect:Uint8Array,base:number,leftOffset:number,topOffset:number,width:number,height:number,pixels:Uint32Array,coverage:Float64Array,rgb:number,opacity:number,transposed?:boolean,opaque?:{spans:Uint32Array,offsets:Uint32Array},composite?:boolean}} options
 */
export function rasterOrderedFill({
  points,
  connect,
  base,
  leftOffset,
  topOffset,
  width,
  height,
  pixels,
  coverage,
  rgb,
  opacity,
  transposed = false,
  opaque,
  composite = false,
}) {
  const stride = height + 1;
  const constant = coverage.subarray(0, stride),
    slope = coverage.subarray(stride, stride * 2),
    edge = coverage.subarray(stride * 2);
  // Changes occur only at segment endpoints and their fractional edge rows.
  // Visit these events instead of scanning the entire height of every column.
  const events = [];
  const spans = opaque?.spans ?? new Uint32Array(0);
  const blend = (prior, alpha) => {
    const oldAlpha = prior >>> 24;
    if (!oldAlpha) return rgb | (alpha << 24);
    const retained = oldAlpha * (1 - alpha / 255),
      total = alpha + retained;
    const red = Math.round(((rgb & 255) * alpha + (prior & 255) * retained) / total),
      green = Math.round((((rgb >>> 8) & 255) * alpha + ((prior >>> 8) & 255) * retained) / total),
      blue = Math.round((((rgb >>> 16) & 255) * alpha + ((prior >>> 16) & 255) * retained) / total);
    return red | (green << 8) | (blue << 16) | (Math.round(total) << 24);
  };
  let lastPrior = -1,
    lastAlpha = -1,
    lastColor = 0;
  const paint = (index, alpha) => {
    const prior = composite ? pixels[index] : 0;
    if (prior !== lastPrior || alpha !== lastAlpha) {
      lastPrior = prior;
      lastAlpha = alpha;
      lastColor = blend(prior, alpha);
    }
    pixels[index] = lastColor;
  };
  const paintRange = (x, top, bottom, alpha) => {
    if (!alpha || top >= bottom) return;
    if (transposed) {
      let at = x * height + top;
      const end = x * height + bottom;
      if (!composite) pixels.fill(rgb | (alpha << 24), at, end);
      else {
        // Flat coverage usually overlays one uniform prior fill. Blend its
        // color once, then write the entire contiguous run.
        while (at < end) {
          const prior = pixels[at];
          let stop = at + 1;
          while (stop < end && pixels[stop] === prior) stop++;
          pixels.fill(blend(prior, alpha), at, stop);
          at = stop;
        }
      }
    } else for (let row = top; row < bottom; row++) paint(row * width + x, alpha);
    dirtyTop = Math.min(dirtyTop, top);
    dirtyBottom = Math.max(dirtyBottom, bottom);
  };
  // A clipped linear segment integrates to the difference of two quadratic
  // ramps. At integer pixel rows each ramp is linear except its one edge row,
  // so accumulate range differences instead of visiting every crossed row.
  const primitive = (value, weight, integral) => {
    if (!(value > 0)) return;
    const end = Math.min(height, Math.floor(value));
    const intercept = weight * (integral ? value - 0.5 : 1);
    constant[0] += intercept;
    constant[end] -= intercept;
    events.push(end);
    if (integral) {
      slope[0] -= weight;
      slope[end] += weight;
    }
    if (end < height) {
      const fraction = value - end;
      edge[end] += weight * (integral ? (fraction * fraction) / 2 : fraction);
      events.push(end + 1);
    }
  };
  const add = (a, b, span) => {
    const signed = ((a + b) / 2 >= base ? 1 : -1) * span;
    if (a === b) primitive(a, signed, false);
    else {
      const low = Math.min(a, b),
        high = Math.max(a, b),
        weight = signed / (high - low);
      primitive(high, weight, true);
      primitive(low, -weight, true);
    }
    primitive(base, -signed, false);
  };
  let first = 1,
    dirtyTop = height,
    dirtyBottom = 0;
  for (let x = 0; x < width; x++) {
    while (first < connect.length && points[first * 2] - leftOffset <= x) first++;
    const spanStart = opaque?.offsets[x] ?? 0,
      spanEnd = opaque?.offsets[x + 1] ?? 0;
    if (spanEnd - spanStart === 2) {
      const top = spans[spanStart],
        bottom = spans[spanStart + 1];
      let total = 0,
        enclosed = true;
      for (let i = first; i < connect.length; i++) {
        const x0 = points[(i - 1) * 2] - leftOffset,
          x1 = points[i * 2] - leftOffset;
        if (x0 >= x + 1) break;
        if (!connect[i] || !(x1 > x0)) continue;
        const left = Math.max(x, x0),
          right = Math.min(x + 1, x1);
        if (!(right > left)) continue;
        const y0 = points[(i - 1) * 2 + 1] - topOffset,
          y1 = points[i * 2 + 1] - topOffset,
          a = y0 + ((left - x0) / (x1 - x0)) * (y1 - y0),
          b = y0 + ((right - x0) / (x1 - x0)) * (y1 - y0);
        if (Math.max(0, Math.min(a, b)) < top || Math.min(height, Math.max(a, b)) > bottom) {
          enclosed = false;
          break;
        }
        total += right - left;
      }
      if (enclosed) {
        // When one opaque interval encloses every segment, visible fill is a
        // constant-area strip to the baseline. Missing x intervals still reduce
        // total coverage; all retracing and baseline crossings remain hidden.
        const alpha = Math.round(Math.min(1, total) * opacity * 255);
        if (base > bottom) {
          const end = Math.min(height, Math.floor(base));
          paintRange(x, bottom, end, alpha);
          if (end < height) paintRange(x, end, end + 1, Math.round(total * (base - end) * opacity * 255));
        } else if (base < top) {
          const start = Math.max(0, Math.ceil(base));
          paintRange(x, start, top, alpha);
          if (start > 0) paintRange(x, start - 1, start, Math.round(total * (start - base) * opacity * 255));
        }
        continue;
      }
    }
    coverage.fill(0);
    events.length = 0;
    events.push(0, height);
    for (let i = first; i < connect.length; i++) {
      const x0 = points[(i - 1) * 2] - leftOffset,
        x1 = points[i * 2] - leftOffset;
      if (x0 >= x + 1) break;
      if (!connect[i] || !(x1 > x0)) continue;
      const left = Math.max(x, x0),
        right = Math.min(x + 1, x1);
      if (!(right > left)) continue;
      const y0 = points[(i - 1) * 2 + 1] - topOffset,
        y1 = points[i * 2 + 1] - topOffset;
      const a = y0 + ((left - x0) / (x1 - x0)) * (y1 - y0),
        b = y0 + ((right - x0) / (x1 - x0)) * (y1 - y0);
      if ((a - base) * (b - base) < 0) {
        const split = (base - a) / (b - a);
        add(a, base, (right - left) * split);
        add(base, b, (right - left) * (1 - split));
      } else add(a, b, right - left);
    }
    events.sort((a, b) => a - b);
    let c = 0,
      m = 0,
      event = 0,
      y = 0,
      span = spanStart;
    while (y < height) {
      // Opaque strokes are composited immediately after this fill. Its hidden
      // pixels need neither area evaluation nor a temporary alpha write.
      while (span < spanEnd && spans[span + 1] <= y) span += 2;
      const hidden = span < spanEnd && spans[span] <= y;
      const end = hidden ? spans[span + 1] : span < spanEnd ? spans[span] : height;
      while (event < events.length && events[event] <= y) {
        const row = events[event];
        c += constant[row];
        m += slope[row];
        while (events[event] === row) event++;
      }
      if (hidden) {
        while (event < events.length && events[event] < end) {
          const row = events[event];
          c += constant[row];
          m += slope[row];
          while (events[event] === row) event++;
        }
        y = end;
        continue;
      }
      const next = Math.min(end, events[event] ?? height);
      if (Math.abs(m) < 1e-14) {
        const alpha = Math.round(Math.max(0, Math.min(1, edge[y] + c)) * opacity * 255);
        paintRange(x, y, next, alpha);
      } else {
        for (let row = y; row < next; row++) {
          const alpha = Math.round(Math.max(0, Math.min(1, edge[row] + c + m * row)) * opacity * 255);
          if (!alpha) continue;
          paint(transposed ? x * height + row : row * width + x, alpha);
          dirtyTop = Math.min(dirtyTop, row);
          dirtyBottom = Math.max(dirtyBottom, row + 1);
        }
      }
      y = next;
    }
  }
  return { top: dirtyTop, bottom: dirtyBottom };
}
