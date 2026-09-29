import { describe, expect, it } from "vitest";
import { hash32 } from "./random";
import { TailHistogram } from "./tailHistogram";

/** Deterministic uniforms in (0, 1). */
const uniforms = (n: number, seed = 1) =>
  Array.from({ length: n }, (_, i) => ((hash32(seed * 1_000_003 + i) >>> 0) + 0.5) / 2 ** 32);

/** Standard normals by Box–Muller. */
function normals(n: number, seed = 1): number[] {
  const u = uniforms(2 * n, seed);
  return Array.from({ length: n }, (_, i) => {
    const a = u[2 * i] ?? 0.5;
    const b = u[2 * i + 1] ?? 0.5;
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
  });
}

function record(samples: number[]): TailHistogram {
  const histogram = new TailHistogram();
  // In batches, as the engine folds them in.
  for (let i = 0; i < samples.length; i += 10_000) histogram.add(samples.slice(i, i + 10_000));
  return histogram;
}

const max = (values: number[]) => values.reduce((a, b) => Math.max(a, b), -Infinity);
const min = (values: number[]) => values.reduce((a, b) => Math.min(a, b), Infinity);
const nonEmpty = (counts: number[]) => counts.filter((c) => c > 0).length;
const sum = (counts: number[]) => counts.reduce((a, b) => a + b, 0);

describe("histogram display windows", () => {
  it("show the full range of a well-behaved distribution, leaving nothing out", () => {
    const samples = normals(100_000);
    const window = record(samples).display(64);
    expect(window.below).toBe(0);
    expect(window.above).toBe(0);
    expect(window.lo).toBeLessThan(min(samples));
    expect(window.hi).toBeGreaterThan(max(samples));
    expect(sum(window.counts)).toBeCloseTo(100_000, 6);
    expect(nonEmpty(window.counts)).toBeGreaterThan(50);
  });

  it("keep the body of a long-tailed distribution readable", () => {
    // Lognormal(0, 1.5): a few samples are hundreds of times the median.
    const samples = normals(200_000, 2).map((z) => Math.exp(1.5 * z));
    const histogram = record(samples);
    const window = histogram.display(64);
    expect(window.above).toBeGreaterThan(0);
    expect(window.above).toBeLessThan(0.01);
    expect(window.hi).toBeLessThan(max(samples) / 5);
    expect(nonEmpty(window.counts)).toBeGreaterThanOrEqual(30);
    // Nothing is lost: bars plus tails account for every sample.
    const total = sum(window.counts) + (window.below + window.above) * samples.length;
    expect(total).toBeCloseTo(samples.length, 3);
  });

  it("aren't stretched by a handful of far outliers", () => {
    const samples = normals(100_000, 3);
    for (let i = 0; i < 20; i++) samples[i * 5000] = 10_000 + i;
    const window = record(samples).display(64);
    expect(window.hi).toBeLessThan(10);
    // The outliers, and at most a sliver of the normal's own tail beyond the padded window.
    expect(window.above).toBeGreaterThanOrEqual(20 / 100_000);
    expect(window.above).toBeLessThan(20 / 100_000 + 0.0002);
    expect(nonEmpty(window.counts)).toBeGreaterThan(40);
  });

  it("give quantiles close to the samples'", () => {
    const samples = normals(50_000, 4);
    const histogram = record(samples);
    const sorted = [...samples].sort((a, b) => a - b);
    for (const p of [0.01, 0.1, 0.5, 0.9, 0.99]) {
      const exact = sorted[Math.floor(p * sorted.length)] ?? 0;
      expect(Math.abs(histogram.quantile(p) - exact)).toBeLessThan(0.02);
    }
  });

  it("keep the body's resolution whatever the outliers, and count every sample", () => {
    const samples = normals(100_000, 5);
    samples[0] = 1e12;
    samples[1] = -1e9;
    const histogram = record(samples);
    expect(histogram.total).toBe(100_000);
    const window = histogram.display(64);
    expect(window.hi - window.lo).toBeLessThan(10);
    expect(nonEmpty(window.counts)).toBeGreaterThan(50);
  });

  it("fold batches in exactly, in any split after the first", () => {
    const samples = normals(30_000, 6);
    const whole = new TailHistogram();
    whole.add(samples.slice(0, 10_000));
    whole.add(samples.slice(10_000));
    const split = new TailHistogram();
    split.add(samples.slice(0, 10_000));
    for (let i = 10_000; i < 30_000; i += 777) split.add(samples.slice(i, i + 777));
    expect(Array.from(split.counts)).toEqual(Array.from(whole.counts));
  });

  it("are empty before any samples", () => {
    expect(new TailHistogram().display(8)).toEqual({
      lo: 0,
      hi: 0,
      counts: [0, 0, 0, 0, 0, 0, 0, 0],
      below: 0,
      above: 0,
    });
  });
});
