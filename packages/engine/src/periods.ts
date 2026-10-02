/**
 * Time periods and their granularity (SPECS.md §3.1, §5). A period is written as a literal whose
 * shape gives its granularity: `2027` (year), `2027-Q1` (quarter), `2027-01` (month), `2027-W05`
 * (ISO week), `2027-01-15` (day), `2027-01-15T09` (hour).
 */

export type Granularity = "hour" | "day" | "week" | "month" | "quarter" | "year";

export const GRANULARITIES: readonly { value: Granularity; label: string }[] = [
  { value: "hour", label: "Hourly" },
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "quarter", label: "Quarterly" },
  { value: "year", label: "Yearly" },
];

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Number of ISO weeks (52 or 53) in a year. */
function isoWeeksInYear(year: number): number {
  const weekday = (y: number) => new Date(Date.UTC(y, 0, 1)).getUTCDay(); // 0 = Sunday
  // A year has 53 weeks if it starts on a Thursday, or is a leap year starting on a Wednesday.
  const leap = isValidDate(year, 2, 29);
  return weekday(year) === 4 || (leap && weekday(year) === 3) ? 53 : 52;
}

/**
 * The granularity of a period value, or null if it isn't a valid period. A whole number from
 * 1000 to 9999 (how a typed year is stored) counts as a year.
 */
export function granularityOf(value: number | string | undefined): Granularity | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1000 && value <= 9999 ? "year" : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  for (const [pattern, granularity, isValid] of PATTERNS) {
    const match = pattern.exec(text);
    if (match) return isValid(match.slice(1).map(Number)) ? granularity : null;
  }
  return null;
}

/** Period literal shapes, each with a check of its numeric parts (year first). */
const PATTERNS: readonly [RegExp, Granularity, (parts: number[]) => boolean][] = [
  [/^(\d{4})$/, "year", () => true],
  [/^(\d{4})-Q([1-4])$/, "quarter", () => true],
  [/^(\d{4})-(\d{2})$/, "month", ([, month = 0]) => month >= 1 && month <= 12],
  [
    /^(\d{4})-W(\d{2})$/,
    "week",
    ([year = 0, week = 0]) => week >= 1 && week <= isoWeeksInYear(year),
  ],
  [/^(\d{4})-(\d{2})-(\d{2})$/, "day", ([y = 0, m = 0, d = 0]) => isValidDate(y, m, d)],
  [
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/,
    "hour",
    ([y = 0, m = 0, d = 0, hour = 0]) => isValidDate(y, m, d) && hour <= 23,
  ],
];

const pad2 = (digits: string) => digits.padStart(2, "0");

/** Loose period spellings and how to write them properly: `2026-7` is `2026-07`, `2026-q1` is `2026-Q1`. */
const LOOSE_PERIODS: readonly [RegExp, (parts: string[]) => string][] = [
  [/^(\d{4})-(\d{1,2})$/, ([y = "", m = ""]) => `${y}-${pad2(m)}`],
  [/^(\d{4})-[qQ]([1-4])$/, ([y = "", q = ""]) => `${y}-Q${q}`],
  [/^(\d{4})-[wW](\d{1,2})$/, ([y = "", w = ""]) => `${y}-W${pad2(w)}`],
  [/^(\d{4})-(\d{1,2})-(\d{1,2})$/, ([y = "", m = "", d = ""]) => `${y}-${pad2(m)}-${pad2(d)}`],
  [
    /^(\d{4})-(\d{1,2})-(\d{1,2})[tT](\d{1,2})$/,
    ([y = "", m = "", d = "", h = ""]) => `${y}-${pad2(m)}-${pad2(d)}T${pad2(h)}`,
  ],
];

/**
 * Writes a loosely typed period in its standard form, e.g. `2026-7` → `2026-07`, `2026-q1` →
 * `2026-Q1`, `2026-3-5` → `2026-03-05`. Text that isn't a valid period is returned unchanged.
 */
export function normalizePeriod(text: string): string {
  const trimmed = text.trim();
  for (const [pattern, format] of LOOSE_PERIODS) {
    const match = pattern.exec(trimmed);
    if (match) {
      const normalized = format(match.slice(1));
      return granularityOf(normalized) ? normalized : text;
    }
  }
  return text;
}

/** ISO 8601 week-numbering year and week of a date (weeks start on Monday). */
function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - day); // the Thursday of this week decides the year
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return { year, week };
}

/** The Monday starting ISO week `week` of `year`, as a UTC date. */
function isoWeekStart(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (week - 1) * 7);
  return monday;
}

/** The period of a granularity containing a date (local time), e.g. month → `2026-09`. */
export function periodContaining(date: Date, granularity: Granularity): string {
  const y = date.getFullYear();
  const m = pad2(String(date.getMonth() + 1));
  const d = pad2(String(date.getDate()));
  switch (granularity) {
    case "year":
      return String(y);
    case "quarter":
      return `${y}-Q${Math.floor(date.getMonth() / 3) + 1}`;
    case "month":
      return `${y}-${m}`;
    case "week": {
      const { year, week } = isoWeek(date);
      return `${year}-W${pad2(String(week))}`;
    }
    case "day":
      return `${y}-${m}-${d}`;
    case "hour":
      return `${y}-${m}-${d}T${pad2(String(date.getHours()))}`;
  }
}

/** The period after `period` (which must be a valid period of its own granularity). */
export function nextPeriod(period: string): string | null {
  const granularity = granularityOf(period);
  if (!granularity) return null;
  const [y = 0, a = 0, b = 0, c = 0] = (period.match(/\d+/g) ?? []).map(Number);
  switch (granularity) {
    case "year":
      return String(y + 1);
    case "quarter":
      return a === 4 ? `${y + 1}-Q1` : `${y}-Q${a + 1}`;
    case "month":
      return a === 12 ? `${y + 1}-01` : `${y}-${pad2(String(a + 1))}`;
    case "week": {
      const next = isoWeekStart(y, a);
      next.setUTCDate(next.getUTCDate() + 7);
      const { year, week } = isoWeek(
        new Date(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate()),
      );
      return `${year}-W${pad2(String(week))}`;
    }
    case "day":
    case "hour": {
      const date = new Date(Date.UTC(y, a - 1, b, granularity === "hour" ? c + 1 : 0));
      if (granularity === "day") date.setUTCDate(date.getUTCDate() + 1);
      const text = `${date.getUTCFullYear()}-${pad2(String(date.getUTCMonth() + 1))}-${pad2(String(date.getUTCDate()))}`;
      return granularity === "hour" ? `${text}T${pad2(String(date.getUTCHours()))}` : text;
    }
  }
}

/*
 * Periods as values (SPECS.md §3.1). In calculations a period is a whole number counting periods
 * of its granularity, and its granularity is known when the formula is compiled:
 * - year: the year (2027);
 * - quarter: year × 4 + quarter − 1;
 * - month: year × 12 + month − 1;
 * - day: Excel's serial number (days since 1899-12-30, so Excel's date functions agree from
 *   March 1900 on);
 * - hour: serial × 24 + hour;
 * - week: ISO weeks since the one starting Monday 1900-01-01 (serial 2).
 * These stay small enough to be exact in single precision (the GPU), and `period + n` is plain
 * addition.
 */

/** Days from 1970-01-01 to a proleptic Gregorian date (H. Hinnant's days_from_civil). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The date `days` after 1970-01-01, as [year, month, day] (H. Hinnant's civil_from_days). */
export function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

/** Excel's serial number of 1970-01-01. */
export const UNIX_EPOCH_SERIAL = 25569;
/** The serial of Monday 1900-01-01, where week 0 starts. */
export const FIRST_MONDAY_SERIAL = 2;

/** The serial number of a date. */
export const serialOf = (year: number, month: number, day: number) =>
  daysFromCivil(year, month, day) + UNIX_EPOCH_SERIAL;

/** The serial of the Monday starting ISO week 1 of `year`: the week with 4 January in it. */
function isoWeekOneSerial(year: number): number {
  const jan4 = serialOf(year, 1, 4);
  return jan4 - ((jan4 - FIRST_MONDAY_SERIAL) % 7);
}

/** A period's value in calculations, with its granularity, or null if the text isn't a period. */
export function periodValue(text: string): { granularity: Granularity; index: number } | null {
  const normalized = normalizePeriod(text);
  const granularity = granularityOf(normalized);
  if (!granularity) return null;
  const [y = 0, a = 0, b = 0, c = 0] = (normalized.match(/\d+/g) ?? []).map(Number);
  switch (granularity) {
    case "year":
      return { granularity, index: y };
    case "quarter":
      return { granularity, index: y * 4 + a - 1 };
    case "month":
      return { granularity, index: y * 12 + a - 1 };
    case "week":
      return {
        granularity,
        index: (isoWeekOneSerial(y) + (a - 1) * 7 - FIRST_MONDAY_SERIAL) / 7,
      };
    case "day":
      return { granularity, index: serialOf(y, a, b) };
    case "hour":
      return { granularity, index: serialOf(y, a, b) * 24 + c };
  }
}

/** Writes a period's value as its literal: (24315, month) → `2026-04`. */
export function formatPeriod(index: number, granularity: Granularity): string {
  const i = Math.round(index);
  const date = (serial: number) => {
    const [y, m, d] = civilFromDays(serial - UNIX_EPOCH_SERIAL);
    return `${y}-${pad2(String(m))}-${pad2(String(d))}`;
  };
  switch (granularity) {
    case "year":
      return String(i);
    case "quarter":
      return `${Math.floor(i / 4)}-Q${(((i % 4) + 4) % 4) + 1}`;
    case "month":
      return `${Math.floor(i / 12)}-${pad2(String((((i % 12) + 12) % 12) + 1))}`;
    case "week": {
      // The ISO year is the year of the week's Thursday.
      const monday = i * 7 + FIRST_MONDAY_SERIAL;
      const [year] = civilFromDays(monday + 3 - UNIX_EPOCH_SERIAL);
      const week = (monday - isoWeekOneSerial(year)) / 7 + 1;
      return `${year}-W${pad2(String(week))}`;
    }
    case "day":
      return date(i);
    case "hour":
      return `${date(Math.floor(i / 24))}T${pad2(String(((i % 24) + 24) % 24))}`;
  }
}
