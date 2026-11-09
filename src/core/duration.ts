// Date-only calendar arithmetic for review SLAs.
//
// All dates are UTC midnight `Date`s produced by `parseDate`, so a page verified on
// 2026-10-15 is due on the same calendar day for every reader regardless of timezone.

export type DurationUnit = "d" | "w" | "m" | "y";
export interface Duration {
  n: number;
  unit: DurationUnit;
}

export const DURATION_RE = /^([1-9]\d{0,3})([dwmy])$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function parseDuration(s: unknown): Duration | null {
  if (typeof s !== "string") return null;
  const m = DURATION_RE.exec(s.trim());
  return m ? { n: Number(m[1]), unit: m[2] as DurationUnit } : null;
}

/** Parse `YYYY-MM-DD` to UTC midnight; rejects impossible dates like 2026-02-30. */
export function parseDate(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const m = DATE_RE.exec(s.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  const roundTrips =
    date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
  return roundTrips ? date : null;
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The UTC calendar day containing `now`. */
export function utcToday(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Add a duration. Days and weeks are fixed; months and years are calendar units
 * clamped to the end of the target month (Jan 31 + 1m = Feb 28/29).
 */
export function addDuration(date: Date, dur: Duration): Date {
  if (dur.unit === "d" || dur.unit === "w") {
    return new Date(date.getTime() + dur.n * (dur.unit === "w" ? 7 : 1) * DAY_MS);
  }
  const months = dur.unit === "y" ? dur.n * 12 : dur.n;
  const y = date.getUTCFullYear();
  const targetMonth = date.getUTCMonth() + months;
  const lastDayOfTarget = new Date(Date.UTC(y, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, targetMonth, Math.min(date.getUTCDate(), lastDayOfTarget)));
}

/** Go back by a duration, clamping the same way (Mar 31 − 1m = Feb 28/29). */
export function subtractDuration(date: Date, dur: Duration): Date {
  if (dur.unit === "d" || dur.unit === "w") {
    return new Date(date.getTime() - dur.n * (dur.unit === "w" ? 7 : 1) * DAY_MS);
  }
  const months = dur.unit === "y" ? dur.n * 12 : dur.n;
  const y = date.getUTCFullYear();
  const targetMonth = date.getUTCMonth() - months;
  const lastDayOfTarget = new Date(Date.UTC(y, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, targetMonth, Math.min(date.getUTCDate(), lastDayOfTarget)));
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}
