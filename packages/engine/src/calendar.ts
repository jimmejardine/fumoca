import type { BinaryFn, Reg, UnaryFn } from "./ir";
import { FIRST_MONDAY_SERIAL, type Granularity, UNIX_EPOCH_SERIAL } from "./periods";

/**
 * Calendar arithmetic on period values (see periods.ts for how periods are numbered), emitted as
 * IR so it runs per iteration on every backend: a period can be uncertain, or calculated. It uses
 * only floor, comparisons and arithmetic, on numbers small enough to be exact in single precision.
 */

/** What the calendar needs from the compiler to emit operations. */
export interface Emitter {
  constant(value: number): Reg;
  un(fn: UnaryFn, a: Reg): Reg;
  bin(fn: BinaryFn, a: Reg, b: Reg): Reg;
  select(cond: Reg, then: Reg, otherwise: Reg): Reg;
}

export function calendar(e: Emitter) {
  const k = (value: number) => e.constant(value);
  const add = (a: Reg, b: Reg) => e.bin("add", a, b);
  const sub = (a: Reg, b: Reg) => e.bin("sub", a, b);
  const mul = (a: Reg, b: Reg) => e.bin("mul", a, b);
  /** floor(a / n) for a whole number a and a positive whole n. */
  const div = (a: Reg, n: number) => e.un("floor", e.bin("div", a, k(n)));
  /** a mod n, from 0 to n − 1. */
  const mod = (a: Reg, n: number) => sub(a, mul(div(a, n), k(n)));

  /** The serial of a date given as year, month (1–12) and day (H. Hinnant's days_from_civil). */
  const serialOf = (year: Reg, month: Reg, day: Reg): Reg => {
    const early = e.bin("le", month, k(2));
    const y = e.select(early, sub(year, k(1)), year);
    const era = div(y, 400);
    const yoe = sub(y, mul(era, k(400)));
    const shifted = e.select(early, add(month, k(9)), sub(month, k(3)));
    const doy = add(div(add(mul(k(153), shifted), k(2)), 5), sub(day, k(1)));
    const doe = add(sub(add(mul(yoe, k(365)), div(yoe, 4)), div(yoe, 100)), doy);
    return add(add(mul(era, k(146097)), doe), k(UNIX_EPOCH_SERIAL - 719468));
  };

  /** A serial's year, month (1–12) and day (H. Hinnant's civil_from_days). */
  const dateOf = (serial: Reg): { year: Reg; month: Reg; day: Reg } => {
    const z = add(serial, k(719468 - UNIX_EPOCH_SERIAL));
    const era = div(z, 146097);
    const doe = sub(z, mul(era, k(146097)));
    const yoe = div(sub(add(sub(doe, div(doe, 1460)), div(doe, 36524)), div(doe, 146096)), 365);
    const doy = sub(doe, sub(add(mul(k(365), yoe), div(yoe, 4)), div(yoe, 100)));
    const mp = div(add(mul(k(5), doy), k(2)), 153);
    const day = add(sub(doy, div(add(mul(k(153), mp), k(2)), 5)), k(1));
    const month = e.select(e.bin("lt", mp, k(10)), add(mp, k(3)), sub(mp, k(9)));
    const year = add(add(yoe, mul(era, k(400))), e.bin("le", month, k(2)));
    return { year, month, day };
  };

  /** A period's first day, as a serial. */
  const toDay = (p: Reg, from: Granularity): Reg => {
    switch (from) {
      case "day":
        return p;
      case "hour":
        return div(p, 24);
      case "week":
        return add(mul(p, k(7)), k(FIRST_MONDAY_SERIAL));
      default: {
        const month = toMonth(p, from);
        return serialOf(div(month, 12), add(mod(month, 12), k(1)), k(1));
      }
    }
  };

  /** The month a period starts in, as a month value. */
  function toMonth(p: Reg, from: Granularity): Reg {
    switch (from) {
      case "year":
        return mul(p, k(12));
      case "quarter":
        return mul(p, k(3));
      case "month":
        return p;
      default: {
        const { year, month } = dateOf(toDay(p, from));
        return add(mul(year, k(12)), sub(month, k(1)));
      }
    }
  }

  /**
   * A period at another granularity: the period containing its start when going coarser, or
   * its first sub-period when going finer (SPECS.md §3.1). Weeks belong to the month and year of
   * their Monday.
   */
  const convert = (p: Reg, from: Granularity, to: Granularity): Reg => {
    if (from === to) return p;
    switch (to) {
      case "year":
        return div(toMonth(p, from), 12);
      case "quarter":
        return div(toMonth(p, from), 3);
      case "month":
        return toMonth(p, from);
      case "day":
        return toDay(p, from);
      case "hour":
        return mul(toDay(p, from), k(24));
      case "week":
        return div(sub(toDay(p, from), k(FIRST_MONDAY_SERIAL)), 7);
    }
  };

  return { serialOf, dateOf, toDay, toMonth, convert, div, mod };
}

/** The calendar on plain numbers, worked out at once: for periods known when compiling. */
export const jsCalendar = calendar({
  constant: (value) => value,
  un: (fn, a) => {
    if (fn === "floor") return Math.floor(a);
    if (fn === "neg") return -a;
    throw new Error(`jsCalendar: unexpected ${fn}`);
  },
  bin: (fn, a, b) => {
    switch (fn) {
      case "add":
        return a + b;
      case "sub":
        return a - b;
      case "mul":
        return a * b;
      case "div":
        return a / b;
      case "lt":
        return a < b ? 1 : 0;
      case "le":
        return a <= b ? 1 : 0;
      default:
        throw new Error(`jsCalendar: unexpected ${fn}`);
    }
  },
  select: (cond, then, otherwise) => (cond !== 0 ? then : otherwise),
});

/** Granularities from finest to coarsest. */
export const GRANULARITY_ORDER: readonly Granularity[] = [
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
];
