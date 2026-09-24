import { describe, expect, it } from "vitest";
import { normalCdf, normalPdf } from "./special";

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
