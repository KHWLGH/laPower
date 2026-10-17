import assert from 'node:assert/strict';
import test from 'node:test';
import { rasterOrderedFill } from '../src/chart-fill.js';

// Independent polygon clipping reference; no row integrals or difference arrays.
function pixelArea(polygon, x, y) {
  for (const [axis, boundary, sign] of [
    [0, x, 1],
    [0, x + 1, -1],
    [1, y, 1],
    [1, y + 1, -1],
  ]) {
    const out = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length];
      const insideA = (a[axis] - boundary) * sign >= 0,
        insideB = (b[axis] - boundary) * sign >= 0;
      if (insideA) out.push(a);
      if (insideA !== insideB) {
        const t = (boundary - a[axis]) / (b[axis] - a[axis]);
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
    polygon = out;
  }
  return (
    Math.abs(
      polygon.reduce((area, a, i) => {
        const b = polygon[(i + 1) % polygon.length];
        return area + a[0] * b[1] - b[0] * a[1];
      }, 0),
    ) / 2
  );
}

function verify(
  xs,
  ys,
  base,
  connect = xs.map((_, i) => Number(i > 0 && Number.isFinite(ys[i]) && Number.isFinite(ys[i - 1]))),
  opacity = 0.12,
) {
  const width = 8,
    height = 6,
    leftOffset = 11.25,
    topOffset = 7.5;
  const points = Float64Array.from(xs.flatMap((x, i) => [x + leftOffset, ys[i] + topOffset]));
  const pixels = new Uint32Array(width * height),
    coverage = new Float64Array((height + 1) * 3);
  const actual = rasterOrderedFill({
    points,
    connect: Uint8Array.from(connect),
    base,
    leftOffset,
    topOffset,
    width,
    height,
    pixels,
    coverage,
    rgb: 0x334455,
    opacity,
  });
  const polygons = [];
  for (let i = 1; i < xs.length; i++) {
    if (!connect[i]) continue;
    const a = [xs[i - 1], ys[i - 1]],
      b = [xs[i], ys[i]];
    const add = (a, b) => polygons.push([[a[0], base], a, b, [b[0], base]]);
    if ((a[1] - base) * (b[1] - base) < 0) {
      const middle = [a[0] + ((b[0] - a[0]) * (base - a[1])) / (b[1] - a[1]), base];
      add(a, middle);
      add(middle, b);
    } else add(a, b);
  }
  let first = height,
    last = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const expected = Math.round(
        Math.min(
          1,
          polygons.reduce((sum, p) => sum + pixelArea(p, x, y), 0),
        ) *
          opacity *
          255,
      );
      const alpha = pixels[y * width + x] >>> 24;
      assert.ok(Math.abs(alpha - expected) <= 1, `pixel ${x},${y}: ${alpha} vs ${expected}`);
      if (alpha) {
        first = Math.min(first, y);
        last = Math.max(last, y + 1);
        assert.equal(pixels[y * width + x] & 0xffffff, 0x334455);
      }
    }
  assert.deepEqual(actual, { top: first, bottom: last });
  return pixels;
}

test('analytic fill matches clipped polygon area across ramps, steps, baseline crossings and duplicate time', () => {
  for (const base of [-2.25, 0, 2.3, 6, 9])
    for (const opacity of [0, 0.12, 0.7, 1]) {
      verify([-2, 0.2, 2.7, 2.7, 4.4, 8.6], [5, -2, 4, -3, 8, 1], base, undefined, opacity);
      verify([0, 2, 2, 5, 8], [1, 1, 4, 4, 2], base, undefined, opacity);
      verify([0, 1.5, 3, 4, 5.3, 7, 8], [1, 3, NaN, NaN, -2, 4, 1], base, undefined, opacity);
    }
});

test('many subpixel segments accumulate area before one alpha composition and preserve missing gaps', () => {
  const xs = Array.from({ length: 129 }, (_, i) => i / 16),
    ys = xs.map((_, i) => (i % 2 ? 0 : 6));
  verify(xs, ys, 5.75);
  const pixels = verify([0, 2, 3, 5, 6, 8], [1, 1, NaN, 1, 1, 1], 6);
  assert.equal(pixels[4 * 8 + 3] >>> 24, 0, 'a missing interval remains transparent');
  assert.equal(pixels[4 * 8 + 6] >>> 24, 31, 'opacity is applied once');
});

test('seeded ordered geometry matches independent clipped areas', () => {
  let seed = 9271;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let run = 0; run < 60; run++) {
    let x = -1;
    const xs = [],
      ys = [],
      connect = [];
    for (let i = 0; i < 28; i++) {
      x += random() < 0.2 ? 0 : random() * 0.8;
      xs.push(x);
      ys.push(random() * 14 - 4);
      connect.push(Number(i > 0 && random() > 0.15));
    }
    verify(xs, ys, random() * 12 - 3, connect, random());
  }
});

test('transposed coverage skips opaque intervals and composites channels in source-over order', () => {
  const width = 8,
    height = 6,
    points = Float64Array.of(0, 1, 1.3, 5, 2.1, -1, 2.1, 4, 4.6, 2, 6.1, 5, 8, 0),
    connect = Uint8Array.of(0, 1, 1, 1, 0, 1, 1),
    plain = new Uint32Array(width * height),
    pixels = new Uint32Array(width * height),
    spans = Uint32Array.of(0, 6, 1, 3, 4, 5, 0, 2, 2, 6),
    offsets = Uint32Array.of(0, 2, 2, 6, 6, 8, 8, 10, 10);
  const options = {
    points,
    connect,
    base: 5.2,
    leftOffset: 0,
    topOffset: 0,
    width,
    height,
    coverage: new Float64Array((height + 1) * 3),
    rgb: 0x6030e0,
    opacity: 0.7,
  };
  rasterOrderedFill({ ...options, pixels: plain });
  for (let x = 0; x < width; x++)
    for (let y = 0; y < height; y++) pixels[x * height + y] = ((x + y) % 3 ? 0x80408020 : 0xffe02040) >>> 0;
  const before = pixels.slice();
  rasterOrderedFill({ ...options, pixels, transposed: true, opaque: { spans, offsets }, composite: true });
  for (let x = 0; x < width; x++)
    for (let y = 0; y < height; y++) {
      const index = x * height + y,
        source = plain[y * width + x],
        destination = before[index],
        covered = Array.from({ length: (offsets[x + 1] - offsets[x]) / 2 }, (_, i) => offsets[x] + i * 2).some(
          (i) => y >= spans[i] && y < spans[i + 1],
        );
      if (covered || !source) assert.equal(pixels[index], destination, `untouched ${x},${y}`);
      else {
        const a = (source >>> 24) / 255,
          b = (destination >>> 24) / 255,
          alpha = a + b * (1 - a);
        assert.ok(Math.abs((pixels[index] >>> 24) - alpha * 255) <= 1);
        for (const shift of [0, 8, 16]) {
          const expected = (((source >>> shift) & 255) * a + ((destination >>> shift) & 255) * b * (1 - a)) / alpha;
          assert.ok(Math.abs(((pixels[index] >>> shift) & 255) - expected) <= 1, `blend ${x},${y},${shift}`);
        }
      }
    }
  pixels.fill(0);
  rasterOrderedFill({ ...options, pixels, transposed: true });
  for (let x = 0; x < width; x++)
    for (let y = 0; y < height; y++) assert.equal(pixels[x * height + y], plain[y * width + x]);
});

test('an enclosing opaque stroke reduces visible fill to its exact baseline strip, including fractional missing time', () => {
  const xs = [-1, 0.3, 1.7, 1.7, 2.2, 3.1, 3.8, 5.4, 8.3],
    ys = [2.2, 3.8, 2.5, 3.4, 3.6, 2.7, 3.2, 2.8, 3.7],
    connect = [0, 1, 1, 1, 0, 1, 0, 1, 1],
    width = 8,
    height = 6,
    opaque = {
      spans: Uint32Array.from({ length: width * 2 }, (_, i) => (i % 2 ? 4 : 2)),
      offsets: Uint32Array.from({ length: width + 1 }, (_, i) => i * 2),
    };
  for (const base of [-2, 0, 1.25, 2.5, 5.1, 6, 9]) {
    const plain = verify(xs, ys, base, connect, 0.7);
    for (const transposed of [false, true]) {
      const pixels = new Uint32Array(width * height);
      rasterOrderedFill({
        points: Float64Array.from(xs.flatMap((x, i) => [x, ys[i]])),
        connect: Uint8Array.from(connect),
        base,
        leftOffset: 0,
        topOffset: 0,
        width,
        height,
        coverage: new Float64Array((height + 1) * 3),
        rgb: 0x334455,
        opacity: 0.7,
        pixels,
        opaque,
        transposed,
      });
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const actual = pixels[transposed ? x * height + y : y * width + x];
          if (y >= 2 && y < 4) assert.equal(actual, 0);
          else assert.ok(Math.abs((actual >>> 24) - (plain[y * width + x] >>> 24)) <= 1);
        }
    }
  }
});
