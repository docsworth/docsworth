import { addDuration, daysBetween, formatDate, parseDate, parseDuration, utcToday } from "./duration.js";

export type SlaState = "fresh" | "due_soon" | "overdue" | "unverified";

export interface Sla {
  state: SlaState;
  /** YYYY-MM-DD, or null when the page has no valid verification date/period. */
  due: string | null;
  /** Negative once overdue. */
  days_until_due: number | null;
}

/**
 * Review-SLA state of a page, evaluated in a fixed order so states never overlap:
 * invalid input → unverified; past the due day → overdue; within the warning window →
 * due_soon; otherwise fresh. The due day itself is still within SLA.
 */
export function computeSla(
  lastVerified: unknown,
  reviewEvery: unknown,
  now: Date,
  dueSoonDays: number,
): Sla {
  const verified = parseDate(lastVerified);
  const period = parseDuration(reviewEvery);
  if (!verified || !period) return { state: "unverified", due: null, days_until_due: null };

  const due = addDuration(verified, period);
  const daysLeft = daysBetween(utcToday(now), due);
  const state: SlaState = daysLeft < 0 ? "overdue" : daysLeft <= dueSoonDays ? "due_soon" : "fresh";
  return { state, due: formatDate(due), days_until_due: daysLeft };
}

/** Within SLA = may be cited (together with status: canonical, see gate.ts). */
export function withinSla(state: SlaState): boolean {
  return state === "fresh" || state === "due_soon";
}
