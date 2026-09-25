import { StreamingHistogram } from "./histogram";

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
  readonly histogram: StreamingHistogram;

  constructor(histogramBins = 64) {
    this.histogram = new StreamingHistogram(histogramBins);
  }

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
  normalizedHistogram(): number[] {
    return this.histogram.normalized();
  }
}

function sliceOf(samples: ArrayLike<number>, from: number, to: number): ArrayLike<number> {
  if (samples instanceof Float64Array || samples instanceof Float32Array) {
    return samples.subarray(from, to);
  }
  return Array.prototype.slice.call(samples, from, to) as number[];
}
