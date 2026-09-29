import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CellAccumulator, summarizeBatch } from "./accumulator";

function direct(samples: number[]) {
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance =
    samples.length > 1
      ? samples.reduce((a, x) => a + (x - mean) ** 2, 0) / (samples.length - 1)
      : 0;
  return { mean, sd: Math.sqrt(variance) };
}

describe("CellAccumulator", () => {
  it("computes count, mean, SD and the first value", () => {
    const acc = new CellAccumulator();
    acc.add([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(acc.count).toBe(8);
    expect(acc.first).toBe(2);
    expect(acc.mean).toBe(5);
    expect(acc.sd).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });

  it("folds in a sub-range of a batch", () => {
    const acc = new CellAccumulator();
    acc.add(Float64Array.from([100, 1, 2, 3, 100]), 1, 4);
    expect(acc.count).toBe(3);
    expect(acc.mean).toBe(2);
    expect(acc.first).toBe(1);
    expect(acc.histogram.total).toBe(3);
  });

  it("gives the same statistics and histogram however samples are split into batches", () => {
    const sample = fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });
    fc.assert(
      fc.property(
        fc.array(fc.array(sample, { minLength: 1, maxLength: 40 }), { minLength: 1, maxLength: 6 }),
        (batches) => {
          const split = new CellAccumulator();
          for (const batch of batches) split.add(batch);
          const all = batches.flat();
          const whole = new CellAccumulator();
          whole.add(all);
          const expected = direct(all);
          const scale = Math.max(1, Math.abs(expected.mean), expected.sd);
          expect(split.count).toBe(all.length);
          expect(Math.abs(split.mean - expected.mean) / scale).toBeLessThan(1e-9);
          expect(Math.abs(split.sd - expected.sd) / scale).toBeLessThan(1e-9);
          expect(split.histogram.total).toBe(whole.histogram.total);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("records NaN and infinite samples, keeping statistics over the finite ones", () => {
    const acc = new CellAccumulator();
    acc.add([1, Number.NaN, 3]);
    acc.add([Number.POSITIVE_INFINITY, 5]);
    expect(acc.hasNaN).toBe(true);
    expect(acc.hasInfinite).toBe(true);
    expect(acc.count).toBe(5);
    expect(acc.mean).toBe(3);
  });

  it("gives an SD of 0 for constant samples", () => {
    const acc = new CellAccumulator();
    acc.add([7, 7]);
    acc.add([7]);
    expect(acc.sd).toBe(0);
    expect(acc.mean).toBe(7);
  });

  it("gives the same statistics from batch summaries as from raw samples", () => {
    const batches = [
      [1, 2, 3, 4],
      [10, Number.NaN, 12],
      [-5, Number.POSITIVE_INFINITY, 0.5, 7],
    ];
    const raw = new CellAccumulator();
    const summarized = new CellAccumulator();
    for (const batch of batches) {
      raw.add(batch);
      summarized.addSummary(summarizeBatch(batch));
    }
    expect(summarized.count).toBe(raw.count);
    expect(summarized.mean).toBeCloseTo(raw.mean, 12);
    expect(summarized.sd).toBeCloseTo(raw.sd, 12);
    expect(summarized.hasNaN).toBe(true);
    expect(summarized.hasInfinite).toBe(true);
  });

  it("takes a deterministic cell's value from its first summary", () => {
    const acc = new CellAccumulator();
    acc.addSummary(summarizeBatch([42, 42, 42]));
    expect(acc.first).toBe(42);
    expect(acc.sd).toBe(0);
  });
});
