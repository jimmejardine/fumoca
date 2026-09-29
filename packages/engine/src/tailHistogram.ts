/** A histogram's display window: bars over [lo, hi), and the fractions of samples outside it. */
export interface HistogramWindow {
  lo: number;
  hi: number;
  counts: number[];
  below: number;
  above: number;
}

/**
 * How a cell's samples are recorded for its histogram (SPECS.md §6.5): bins that are linear near
 * the centre of the distribution and logarithmic away from it (log-linear, like HDR histograms).
 * The body keeps a fine, even resolution however far out the outliers lie, the memory is fixed,
 * and every sample lands in a bin, however extreme.
 *
 * The centre and scale come from the first batch: its median, and its interquartile range. After
 * that the bin edges never change, so batches fold in exactly and in any order.
 *
 *     … log bins below │ 512 linear bins over centre ± scale │ log bins above …
 *
 * Log bins grow by 2% each, out to 10^15 scales from the centre.
 */

const LINEAR_BINS = 512;
const LOG_RATIO = 1.02;
const LOG_BINS = Math.ceil(Math.log(1e15) / Math.log(LOG_RATIO));
/** Bins in all: the log bins below the centre, the linear ones, and the log bins above. */
export const TAIL_HISTOGRAM_BINS = 2 * LOG_BINS + LINEAR_BINS;

/** The display window spans the samples from this quantile to its mirror image, padded. */
const WINDOW_QUANTILE = 0.005;
const WINDOW_PADDING = 0.25;
/** A window this close to the full occupied range shows the full range, clipping nothing. */
const FULL_RANGE_SHARE = 2 / 3;

export class TailHistogram {
  readonly counts = new Float64Array(TAIL_HISTOGRAM_BINS);
  private centre = 0;
  private scale = 0;
  private count = 0;

  /** Number of finite samples added. */
  get total(): number {
    return this.count;
  }

  /** Adds a batch of samples. Non-finite samples are ignored. */
  add(samples: ArrayLike<number>): void {
    if (this.count === 0 && !this.initialize(samples)) return;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i] as number;
      if (!Number.isFinite(x)) continue;
      const bin = this.binOf(x);
      this.counts[bin] = (this.counts[bin] as number) + 1;
      this.count++;
    }
  }

  /** The bin a value falls in. */
  binOf(x: number): number {
    const d = x - this.centre;
    const a = Math.abs(d);
    if (a < this.scale) {
      const linear = Math.floor(((d + this.scale) / (2 * this.scale)) * LINEAR_BINS);
      return LOG_BINS + Math.min(LINEAR_BINS - 1, Math.max(0, linear));
    }
    const k = Math.min(LOG_BINS - 1, Math.floor(Math.log(a / this.scale) / Math.log(LOG_RATIO)));
    return d > 0 ? LOG_BINS + LINEAR_BINS + k : LOG_BINS - 1 - k;
  }

  /** The lower and upper edges of bin `i`. */
  edges(i: number): [number, number] {
    const { centre: c, scale: s } = this;
    if (i >= LOG_BINS && i < LOG_BINS + LINEAR_BINS) {
      const width = (2 * s) / LINEAR_BINS;
      const lo = c - s + (i - LOG_BINS) * width;
      return [lo, lo + width];
    }
    if (i >= LOG_BINS + LINEAR_BINS) {
      const k = i - LOG_BINS - LINEAR_BINS;
      return [c + s * LOG_RATIO ** k, c + s * LOG_RATIO ** (k + 1)];
    }
    const k = LOG_BINS - 1 - i;
    return [c - s * LOG_RATIO ** (k + 1), c - s * LOG_RATIO ** k];
  }

  /** The value below which a fraction `p` of the samples lie, linear within a bin. */
  quantile(p: number): number {
    const target = p * this.count;
    let below = 0;
    for (let i = 0; i < TAIL_HISTOGRAM_BINS; i++) {
      const n = this.counts[i] as number;
      if (n > 0 && below + n >= target) {
        const [lo, hi] = this.edges(i);
        return lo + (Math.max(0, target - below) / n) * (hi - lo);
      }
      below += n;
    }
    return this.centre;
  }

  /**
   * The histogram to show (SPECS.md §6.5): `bins` bars over a window that holds the body of the
   * distribution, from its 0.5% to its 99.5% quantile, padded by 25% each side, and the fractions
   * of samples below and above it. Far outliers then can't squash the body into a bar or two.
   * When that window is most of the occupied range anyway, the whole range is shown, and nothing
   * is left out.
   */
  display(bins = 64): HistogramWindow {
    const counts = new Array<number>(bins).fill(0);
    if (this.count === 0) return { lo: 0, hi: 0, counts, below: 0, above: 0 };
    let first = 0;
    while ((this.counts[first] as number) === 0) first++;
    let last = TAIL_HISTOGRAM_BINS - 1;
    while ((this.counts[last] as number) === 0) last--;
    const occupiedLo = this.edges(first)[0];
    const occupiedHi = this.edges(last)[1];
    const occupied = occupiedHi - occupiedLo;

    const q1 = this.quantile(WINDOW_QUANTILE);
    const q2 = this.quantile(1 - WINDOW_QUANTILE);
    const pad = (q2 - q1) * WINDOW_PADDING;
    let lo = Math.max(occupiedLo, q1 - pad);
    let hi = Math.min(occupiedHi, q2 + pad);
    if (!(hi > lo) || hi - lo >= occupied * FULL_RANGE_SHARE) {
      const margin = occupied > 0 ? occupied * 0.05 : Math.max(Math.abs(occupiedLo), 1) * 1e-6;
      lo = occupiedLo - margin;
      hi = occupiedHi + margin;
    }

    const width = (hi - lo) / bins;
    let below = 0;
    let above = 0;
    for (let i = first; i <= last; i++) {
      const n = this.counts[i] as number;
      if (n === 0) continue;
      const [a, b] = this.edges(i);
      const binWidth = b - a;
      // The parts of this bin outside the window are tail; the rest is spread over the bars it
      // overlaps, in proportion.
      if (a < lo) below += (n * (Math.min(b, lo) - a)) / binWidth;
      if (b > hi) above += (n * (b - Math.max(a, hi))) / binWidth;
      const from = Math.max(a, lo);
      const to = Math.min(b, hi);
      if (to <= from) continue;
      const firstBar = Math.min(bins - 1, Math.floor((from - lo) / width));
      const lastBar = Math.min(bins - 1, Math.floor((to - lo) / width));
      for (let bar = firstBar; bar <= lastBar; bar++) {
        const overlap = Math.min(to, lo + (bar + 1) * width) - Math.max(from, lo + bar * width);
        if (overlap > 0) counts[bar] = (counts[bar] as number) + (n * overlap) / binWidth;
      }
    }
    return { lo, hi, counts, below: below / this.count, above: above / this.count };
  }

  /**
   * Sets the centre and scale from the first batch with finite samples: its median and its
   * interquartile range (or, if that's zero, a small scale around the value). Returns false if the
   * batch has no finite samples.
   */
  private initialize(samples: ArrayLike<number>): boolean {
    const finite: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i] as number;
      if (Number.isFinite(x)) finite.push(x);
    }
    if (finite.length === 0) return false;
    finite.sort((a, b) => a - b);
    const at = (p: number) =>
      finite[Math.min(finite.length - 1, Math.floor(p * finite.length))] ?? 0;
    this.centre = at(0.5);
    const spread = at(0.75) - at(0.25);
    const range = (finite.at(-1) ?? 0) - (finite[0] ?? 0);
    this.scale =
      spread > 0 ? spread : range > 0 ? range / 2 : Math.max(Math.abs(this.centre) * 1e-9, 1e-12);
    return true;
  }
}
