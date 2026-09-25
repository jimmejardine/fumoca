import { describe, expect, it } from "vitest";
import { compareSamples, relativeError } from "./crosscheck";

const samples = Float64Array.from({ length: 10_000 }, (_, i) => Math.sin(i) * 100 + i / 7);

describe("compareSamples", () => {
  it("agrees for identical samples", () => {
    expect(compareSamples(samples, samples, samples.length)).toEqual({
      maxRelativeError: 0,
      mismatches: 0,
      agrees: true,
    });
  });

  it("agrees for samples rounded to f32", () => {
    const result = compareSamples(samples, Float32Array.from(samples), samples.length);
    expect(result.agrees).toBe(true);
    expect(result.mismatches).toBe(0);
    expect(result.maxRelativeError).toBeLessThan(1e-6);
  });

  it("differs when many samples are wrong", () => {
    const wrong = samples.map((x) => x + 1);
    const result = compareSamples(samples, wrong, samples.length);
    expect(result.agrees).toBe(false);
    expect(result.mismatches).toBeGreaterThan(samples.length / 2);
  });

  it("tolerates a few flipped iterations, but not many", () => {
    const fewFlips = samples.slice();
    for (let i = 0; i < 10; i++) fewFlips[i * 100] = (fewFlips[i * 100] ?? 0) + 50;
    expect(compareSamples(samples, fewFlips, samples.length).agrees).toBe(true);
    const manyFlips = samples.slice();
    for (let i = 0; i < 20; i++) manyFlips[i * 100] = (manyFlips[i * 100] ?? 0) + 50;
    expect(compareSamples(samples, manyFlips, samples.length).agrees).toBe(false);
  });

  it("only compares the first `count` samples, and treats NaN as a mismatch", () => {
    const tailDiffers = samples.slice();
    tailDiffers[9_999] = 1e9;
    expect(compareSamples(samples, tailDiffers, 5_000).mismatches).toBe(0);
    expect(compareSamples([1, 2], [1, Number.NaN], 2).mismatches).toBe(1);
  });

  it("uses an absolute floor of 1 for values near zero", () => {
    expect(relativeError(0.001, 0.0011)).toBeCloseTo(0.0001, 10);
    expect(relativeError(200, 202)).toBeCloseTo(0.01, 10);
  });
});
