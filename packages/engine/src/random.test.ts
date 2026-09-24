import { describe, expect, it } from "vitest";
import { compile } from "./compile";
import { evaluateCpu } from "./cpu";
import { hash32, randomU32, toUnit } from "./random";

const N = 200_000;

function stats(samples: Float64Array): { mean: number; sd: number } {
  let sum = 0;
  for (const x of samples) sum += x;
  const mean = sum / samples.length;
  let squares = 0;
  for (const x of samples) squares += (x - mean) ** 2;
  return { mean, sd: Math.sqrt(squares / (samples.length - 1)) };
}

function sampleCell(formula: string, seed = 42): Float64Array {
  const result = evaluateCpu(compile({ A1: formula }), {
    seed,
    iterationStart: 0,
    count: N,
    outputs: ["A1"],
  });
  return result.get("A1") ?? new Float64Array();
}

describe("random numbers", () => {
  it("hash32 produces unsigned 32-bit integers deterministically", () => {
    for (const x of [0, 1, 2 ** 31, 2 ** 32 - 1]) {
      const h = hash32(x);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
      expect(hash32(x)).toBe(h);
    }
  });

  it("depends on every part of the key", () => {
    const base = randomU32(1, 2, 3, 0);
    expect(randomU32(9, 2, 3, 0)).not.toBe(base);
    expect(randomU32(1, 9, 3, 0)).not.toBe(base);
    expect(randomU32(1, 2, 9, 0)).not.toBe(base);
    expect(randomU32(1, 2, 3, 1)).not.toBe(base);
  });

  it("maps to the open interval (0, 1) at values exactly representable in f32", () => {
    for (const u32 of [0, 1, 2 ** 31, 2 ** 32 - 1, 123456789]) {
      const u = toUnit(u32);
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
      expect(Math.fround(u)).toBe(u);
    }
  });
});

describe("distributions", () => {
  // Tolerances are 5 standard errors; the seed is fixed so these tests are deterministic.
  it.each([
    ["=UNIFORM(2, 5)", 3.5, Math.sqrt(9 / 12)],
    ["=RAND()", 0.5, Math.sqrt(1 / 12)],
    ["=NORMAL(100, 10)", 100, 10],
    // Excel convention: parameters of ln(X). Mean exp(μ + σ²/2), variance (exp(σ²) − 1)·exp(2μ + σ²).
    ["=LOGNORMAL(0, 0.5)", Math.exp(0.125), Math.sqrt((Math.exp(0.25) - 1) * Math.exp(0.25))],
    ["=TRIANGULAR(1, 2, 6)", 3, Math.sqrt((1 + 4 + 36 - 2 - 6 - 12) / 18)],
  ])("%s has mean %d and SD %d", (formula, mean, sd) => {
    const samples = sampleCell(formula);
    const s = stats(samples);
    expect(Math.abs(s.mean - mean)).toBeLessThan((5 * sd) / Math.sqrt(N));
    expect(Math.abs(s.sd - sd) / sd).toBeLessThan(0.01);
  });

  it("stays within the bounds of bounded distributions", () => {
    for (const x of sampleCell("=TRIANGULAR(1, 2, 6)")) {
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(6);
    }
  });

  it("gives every formula that refers to a cell the same sample", () => {
    const program = compile({ A1: "=NORMAL(0, 1)", B1: "=A1 - A1" });
    const result = evaluateCpu(program, {
      seed: 1,
      iterationStart: 0,
      count: 1000,
      outputs: ["B1"],
    });
    expect(result.get("B1")?.every((x) => x === 0)).toBe(true);
  });

  it("samples separate distribution calls independently", () => {
    // The difference of two independent standard normals has variance 2.
    const s = stats(sampleCell("=NORMAL(0, 1) - NORMAL(0, 1)"));
    expect(s.sd ** 2).toBeCloseTo(2, 1);
  });

  it("is reproducible for a seed and different across seeds", () => {
    expect(sampleCell("=NORMAL(0, 1)", 7)).toEqual(sampleCell("=NORMAL(0, 1)", 7));
    expect(sampleCell("=NORMAL(0, 1)", 7)[0]).not.toBe(sampleCell("=NORMAL(0, 1)", 8)[0]);
  });

  it("computes the same iteration regardless of which batch it is in", () => {
    const program = compile({ A1: "=NORMAL(0, 1)" });
    const whole = evaluateCpu(program, { seed: 3, iterationStart: 0, count: 100, outputs: ["A1"] });
    const tail = evaluateCpu(program, { seed: 3, iterationStart: 60, count: 40, outputs: ["A1"] });
    expect(tail.get("A1")).toEqual(whole.get("A1")?.slice(60));
  });
});
