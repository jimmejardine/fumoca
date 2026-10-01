import { describe, expect, it } from "vitest";
import { normalCdf, normalInverse, normalPdf } from "./special";

describe("normalCdf", () => {
  // Reference values of Φ(x) to 16 significant digits.
  it.each([
    [0, 0.5],
    [1, 0.8413447460685429],
    [-1, 0.15865525393145707],
    [-1.96, 0.024997895148220435],
    [2.5, 0.9937903346742238],
    [3, 0.9986501019683699],
    [-5, 2.866515718791939e-7],
    [-8, 6.220960574271785e-16],
    [-40, 0],
    [40, 1],
  ])("Φ(%d) = %d", (x, expected) => {
    expect(Math.abs(normalCdf(x) - expected)).toBeLessThanOrEqual(1e-14 * Math.max(1, expected));
    // Far tails keep good relative accuracy too (the continued fraction beyond |x| = 7.07
    // is accurate to about 1e-8 relative).
    if (expected > 0 && expected < 1e-3) {
      expect(Math.abs(normalCdf(x) - expected) / expected).toBeLessThan(1e-8);
    }
  });

  it("is symmetric: Φ(x) + Φ(−x) = 1", () => {
    for (const x of [0.1, 0.5, 1.3, 2.7, 4.2, 6.9, 7.5]) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 14);
    }
  });
});

describe("normalPdf", () => {
  it.each([
    [0, 0.3989422804014327],
    [1, 0.24197072451914337],
    [-2, 0.05399096651318806],
  ])("φ(%d) = %d", (x, expected) => {
    expect(normalPdf(x)).toBeCloseTo(expected, 15);
  });
});

describe("normalInverse", () => {
  it("inverts normalCdf to double precision, in the centre and the tails", () => {
    for (const p of [1e-12, 1e-6, 0.001, 0.02, 0.02425, 0.1, 0.5, 0.7, 0.97575, 0.999, 1 - 1e-9]) {
      const x = normalInverse(p);
      expect(Math.abs(normalCdf(x) - p) / Math.min(p, 1 - p)).toBeLessThan(1e-9);
    }
  });

  it("matches Excel's NORM.S.INV", () => {
    expect(normalInverse(0.975)).toBeCloseTo(1.959963984540054, 13);
    expect(normalInverse(0.05)).toBeCloseTo(-1.6448536269514729, 13);
  });

  it("is NaN outside (0, 1)", () => {
    for (const p of [0, 1, -0.1, 2, Number.NaN]) expect(normalInverse(p)).toBeNaN();
  });
});
