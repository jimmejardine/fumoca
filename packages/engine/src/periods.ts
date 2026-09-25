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

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

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

/** `count` consecutive monthly periods starting with the month of `start` (local time). */
export function monthlyPeriods(start: Date, count: number): string[] {
  const year = start.getFullYear();
  const month = start.getMonth(); // 0-based
  return Array.from({ length: count }, (_, i) => {
    const total = month + i;
    return `${year + Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
  });
}
