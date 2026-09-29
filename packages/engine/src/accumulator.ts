import type { BatchSummary } from "./backend";
import { type HistogramWindow, TailHistogram } from "./tailHistogram";

/**
 * Running statistics of one cell's samples, built up batch by batch (SPECS.md §6.3). Old samples
 * are never kept: each batch is folded in and can then be discarded.
 *
 * Mean and variance are merged per batch with Chan et al.'s parallel formula, which is numerically
 * stable and gives the same result however the samples are split into batches.
 */
export class CellAccumulator {
  private n = 0;
  /** Samples that were finite, which the mean and variance are over. */
  private finiteCount = 0;
  private runningMean = 0;
  /** Sum of squared deviations from the mean. */
  private m2 = 0;
  private firstValue = Number.NaN;
  private nan = false;
  private infinite = false;
  /** The samples' histogram, recorded log-linearly so outliers can't swamp it (SPECS.md §6.5). */
  readonly histogram = new TailHistogram();

  /** Number of samples folded in, including non-finite ones. */
  get count(): number {
    return this.n;
  }

  /** The first sample: the value of a deterministic cell, which is the same in every iteration. */
  get first(): number {
    return this.firstValue;
  }

  get mean(): number {
    return this.runningMean;
  }

  /** Sample standard deviation (n − 1 in the denominator). */
  get sd(): number {
    return this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : 0;
  }

  /** Whether any sample was NaN. */
  get hasNaN(): boolean {
    return this.nan;
  }

  /** Whether any sample was ±Infinity. */
  get hasInfinite(): boolean {
    return this.infinite;
  }

  /**
   * Folds in a batch's summary statistics (from a backend that reduces on the device). The
   * histogram only grows from raw batches, so it reflects the samples that were read back.
   */
  addSummary(summary: BatchSummary): void {
    const batchSize = summary.count + summary.nanCount + summary.infiniteCount;
    if (batchSize === 0) return;
    // A deterministic cell has the same value in every iteration, so its mean is that value.
    if (this.n === 0) this.firstValue = summary.count > 0 ? summary.mean : Number.NaN;
    if (summary.nanCount > 0) this.nan = true;
    if (summary.infiniteCount > 0) this.infinite = true;
    if (summary.count > 0) {
      const before = this.finiteCount;
      const total = before + summary.count;
      const delta = summary.mean - this.runningMean;
      this.runningMean += (delta * summary.count) / total;
      this.m2 += summary.m2 + (delta * delta * before * summary.count) / total;
      this.finiteCount = total;
    }
    this.n += batchSize;
  }

  /** Folds in `samples[from, to)`. */
  add(samples: ArrayLike<number>, from = 0, to = samples.length): void {
    if (to <= from) return;
    if (this.n === 0) this.firstValue = samples[from] as number;

    // Batch mean and M2 over the finite samples (two passes, for accuracy).
    let count = 0;
    let sum = 0;
    for (let i = from; i < to; i++) {
      const x = samples[i] as number;
      if (Number.isFinite(x)) {
        count++;
        sum += x;
      } else if (Number.isNaN(x)) this.nan = true;
      else this.infinite = true;
    }
    const batchMean = count > 0 ? sum / count : 0;
    let batchM2 = 0;
    for (let i = from; i < to; i++) {
      const x = samples[i] as number;
      if (Number.isFinite(x)) batchM2 += (x - batchMean) ** 2;
    }

    // Merge with the running statistics (Chan et al.).
    const finiteBefore = this.finiteCount;
    const total = finiteBefore + count;
    if (count > 0) {
      const delta = batchMean - this.runningMean;
      this.runningMean += (delta * count) / total;
      this.m2 += batchM2 + (delta * delta * finiteBefore * count) / total;
      this.finiteCount = total;
    }
    this.n += to - from;

    this.histogram.add(from === 0 && to === samples.length ? samples : sliceOf(samples, from, to));
  }

  /** Histogram bin heights scaled so the tallest is 1. */
  /**
   * The histogram to show (SPECS.md §6.5): `bins` bars over a window holding the body of the
   * distribution, scaled so the tallest is 1, and the fractions of samples beyond each side.
   */
  displayHistogram(bins = 64): HistogramWindow {
    const window = this.histogram.display(bins);
    const max = Math.max(0, ...window.counts);
    return { ...window, counts: window.counts.map((c) => (max > 0 ? c / max : 0)) };
  }
}

function sliceOf(samples: ArrayLike<number>, from: number, to: number): ArrayLike<number> {
  if (samples instanceof Float64Array || samples instanceof Float32Array) {
    return samples.subarray(from, to);
  }
  return Array.prototype.slice.call(samples, from, to) as number[];
}

/** Summary statistics of `samples[from, to)`: the host-side reference for device reductions. */
export function summarizeBatch(
  samples: ArrayLike<number>,
  from = 0,
  to = samples.length,
): BatchSummary {
  let count = 0;
  let mean = 0;
  let m2 = 0;
  let nanCount = 0;
  let infiniteCount = 0;
  for (let i = from; i < to; i++) {
    const x = samples[i] as number;
    if (Number.isNaN(x)) nanCount++;
    else if (!Number.isFinite(x)) infiniteCount++;
    else {
      count++;
      const delta = x - mean;
      mean += delta / count;
      m2 += delta * (x - mean);
    }
  }
  return { count, mean, m2, nanCount, infiniteCount };
}

/** Merges two batch summaries (Chan et al.), as if their samples had been summarized together. */
export function mergeSummaries(a: BatchSummary, b: BatchSummary): BatchSummary {
  const count = a.count + b.count;
  const nanCount = a.nanCount + b.nanCount;
  const infiniteCount = a.infiniteCount + b.infiniteCount;
  if (count === 0) return { count, mean: 0, m2: 0, nanCount, infiniteCount };
  const delta = b.mean - a.mean;
  return {
    count,
    mean: a.mean + (delta * b.count) / count,
    m2: a.m2 + b.m2 + (delta * delta * a.count * b.count) / count,
    nanCount,
    infiniteCount,
  };
}
