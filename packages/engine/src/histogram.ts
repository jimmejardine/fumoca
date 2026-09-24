/** The smallest positive normal double. */
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * A fixed-size histogram that accepts samples in batches without ever re-reading old samples,
 * ready for continuous sampling (SPECS.md §6.3, §6.5).
 *
 * The first batch sets the range: its [min, max], padded by 10% on each side. A later sample
 * outside the range doubles the range towards that side and merges neighbouring bins in pairs.
 *
 * Bin edges sit on a grid anchored at zero: a sample's bin is `floor(x / width) − start`, with an
 * integer `start`. Doubling the width is an exact power-of-two scaling, so
 * `floor(x / 2w) = floor(floor(x / w) / 2)` holds exactly in floating point. Every doubled grid
 * nests inside the previous one, and merged counts stay exact.
 */
export class StreamingHistogram {
  counts: Float64Array;
  private start = 0;
  private binWidth = 0;
  private count = 0;

  constructor(readonly bins = 32) {
    if (!Number.isInteger(bins) || bins < 2 || bins % 2 !== 0) {
      throw new RangeError(`bins must be an even integer of at least 2, got ${bins}`);
    }
    this.counts = new Float64Array(bins);
  }

  /** The lower edge of the first bin. */
  get lo(): number {
    return this.start * this.binWidth;
  }

  /** The upper edge of the last bin. */
  get hi(): number {
    return (this.start + this.bins) * this.binWidth;
  }

  get width(): number {
    return this.binWidth;
  }

  /** Number of samples added. */
  get total(): number {
    return this.count;
  }

  /**
   * The bin a value falls in on the current grid (may be outside 0 to bins − 1). Subnormal values
   * count as 0: dividing them loses precision, which would break the exact nesting of grids.
   */
  binOf(x: number): number {
    const value = Math.abs(x) < MIN_NORMAL ? 0 : x;
    return Math.floor(value / this.binWidth) - this.start;
  }

  /** Adds a batch of samples. Non-finite samples are ignored. */
  add(samples: ArrayLike<number>): void {
    if (this.count === 0) this.initialize(samples);
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i] as number;
      if (!Number.isFinite(x)) continue;
      let bin = this.binOf(x);
      while (bin < 0) {
        this.rebin(Math.ceil(this.start / 2) - this.bins / 2);
        bin = this.binOf(x);
      }
      while (bin >= this.bins) {
        this.rebin(Math.floor(this.start / 2));
        bin = this.binOf(x);
      }
      this.counts[bin] = (this.counts[bin] as number) + 1;
      this.count++;
    }
  }

  /** Bin heights scaled so the tallest bin is 1 (all zeros if empty). */
  normalized(): number[] {
    let max = 0;
    for (const c of this.counts) max = Math.max(max, c);
    return Array.from(this.counts, (c) => (max > 0 ? c / max : 0));
  }

  private initialize(samples: ArrayLike<number>): void {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i] as number;
      if (!Number.isFinite(x)) continue;
      if (x < min) min = x;
      if (x > max) max = x;
    }
    if (min > max) return; // No finite samples yet.
    const magnitude = Math.max(Math.abs(min), Math.abs(max), 1);
    // Pad by 10% each side; a constant batch gets a tiny range that later samples widen.
    const pad = max > min ? (max - min) * 0.1 : magnitude * 1e-9;
    // One spare bin absorbs the rounding of `start`, so [min − pad, max + pad] fits. Bins are
    // never narrower than 1e-12 of the values, so bin indices stay exact integers.
    this.binWidth = Math.max((max - min + 2 * pad) / (this.bins - 1), magnitude * 1e-12);
    this.start = Math.floor((min - pad) / this.binWidth);
  }

  /**
   * Doubles the bin width and moves the grid to start at `newStart` (in new-width bins). Old bin
   * `i` covers grid cell `start + i`, which lies in new cell `floor((start + i) / 2)`.
   */
  private rebin(newStart: number): void {
    const merged = new Float64Array(this.bins);
    for (let i = 0; i < this.bins; i++) {
      const j = Math.floor((this.start + i) / 2) - newStart;
      merged[j] = (merged[j] as number) + (this.counts[i] as number);
    }
    this.counts = merged;
    this.start = newStart;
    this.binWidth *= 2;
  }
}
