import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { StreamingHistogram } from "./histogram";

/** Bins samples directly on a histogram's final grid, for comparison. */
function directCounts(h: StreamingHistogram, samples: number[]): number[] {
  const counts = new Array<number>(h.bins).fill(0);
  for (const x of samples) {
    const bin = h.binOf(x);
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  return counts;
}

const sum = (counts: ArrayLike<number>) => Array.from(counts).reduce((a, b) => a + b, 0);

describe("StreamingHistogram", () => {
  it("sets its range from the first batch, padded by about 10% each side", () => {
    const h = new StreamingHistogram(32);
    h.add([0, 5, 10]);
    // [min − pad, max + pad] = [−1, 11] fits, with bins of 12/31 (one spare bin for alignment).
    expect(h.width).toBeCloseTo(12 / 31, 12);
    expect(h.lo).toBeLessThanOrEqual(-1);
    expect(h.lo).toBeGreaterThan(-1 - h.width);
    expect(h.hi).toBeGreaterThanOrEqual(11);
    expect(h.total).toBe(3);
    expect(sum(h.counts)).toBe(3);
  });

  it("doubles the range upwards for a sample above it, keeping counts exact", () => {
    const h = new StreamingHistogram(4);
    const first = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    h.add(first);
    const { lo, hi, width } = h;
    h.add([hi + 0.5]);
    expect(h.width).toBe(2 * width);
    expect(h.lo).toBeLessThanOrEqual(lo);
    expect(h.hi).toBeGreaterThan(hi + 0.5);
    expect(Array.from(h.counts)).toEqual(directCounts(h, [...first, hi + 0.5]));
  });

  it("doubles the range downwards for a sample below it, keeping counts exact", () => {
    const h = new StreamingHistogram(4);
    const first = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    h.add(first);
    const { lo, hi, width } = h;
    h.add([lo - 0.5]);
    expect(h.width).toBe(2 * width);
    expect(h.hi).toBeGreaterThanOrEqual(hi);
    expect(h.lo).toBeLessThanOrEqual(lo - 0.5);
    expect(Array.from(h.counts)).toEqual(directCounts(h, [...first, lo - 0.5]));
  });

  it("doubles repeatedly for a far outlier", () => {
    const h = new StreamingHistogram(32);
    h.add([0, 1]);
    h.add([1000]);
    expect(h.hi).toBeGreaterThan(1000);
    expect(h.hi - h.lo).toBeLessThan(4 * 1000);
    expect(h.total).toBe(3);
    expect(sum(h.counts)).toBe(3);
  });

  it("handles constant samples, and widens when other values arrive", () => {
    const h = new StreamingHistogram(32);
    h.add([5, 5, 5]);
    expect(h.normalized().filter((v) => v === 1)).toHaveLength(1);
    h.add([6]);
    expect(h.total).toBe(4);
    expect(h.hi).toBeGreaterThan(6);
  });

  it("ignores non-finite samples and normalizes to a peak of 1", () => {
    const h = new StreamingHistogram(8);
    h.add([Number.NaN, 1, 2, 2, 3, Number.POSITIVE_INFINITY]);
    expect(h.total).toBe(4);
    expect(Math.max(...h.normalized())).toBe(1);
    expect(new StreamingHistogram().normalized().every((v) => v === 0)).toBe(true);
  });

  it("rejects odd or tiny bin counts", () => {
    expect(() => new StreamingHistogram(31)).toThrow(RangeError);
    expect(() => new StreamingHistogram(0)).toThrow(RangeError);
  });

  it("matches a direct binning of all samples, however they are split into batches", () => {
    const sample = fc.double({ min: -1e9, max: 1e9, noNaN: true, noDefaultInfinity: true });
    const batches = fc.array(fc.array(sample, { minLength: 1, maxLength: 50 }), {
      minLength: 1,
      maxLength: 6,
    });
    fc.assert(
      fc.property(batches, (split) => {
        const h = new StreamingHistogram(32);
        for (const batch of split) h.add(batch);
        const all = split.flat();
        expect(h.total).toBe(all.length);
        expect(Array.from(h.counts)).toEqual(directCounts(h, all));
        for (const x of all) {
          expect(x).toBeGreaterThanOrEqual(h.lo);
          expect(x).toBeLessThan(h.hi);
        }
      }),
      { numRuns: 500 },
    );
  });
});
