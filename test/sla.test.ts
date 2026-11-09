import { describe, expect, it } from "vitest";
import { addDuration, parseDate, parseDuration } from "../src/core/duration.js";
import { computeSla } from "../src/core/sla.js";

const NOW = new Date("2026-11-02T15:30:00Z");
const add = (date: string, dur: string) => addDuration(parseDate(date)!, parseDuration(dur)!).toISOString().slice(0, 10);

describe("duration arithmetic", () => {
  it("days and weeks are fixed", () => {
    expect(add("2026-10-15", "90d")).toBe("2027-01-13");
    expect(add("2026-02-25", "1w")).toBe("2026-03-04");
  });

  it("months clamp to the end of the target month", () => {
    expect(add("2026-01-31", "1m")).toBe("2026-02-28");
    expect(add("2028-01-31", "1m")).toBe("2028-02-29"); // leap year
    expect(add("2026-08-31", "1m")).toBe("2026-09-30");
    expect(add("2026-11-30", "3m")).toBe("2027-02-28");
  });

  it("years are calendar years", () => {
    expect(add("2028-02-29", "1y")).toBe("2029-02-28");
    expect(add("2026-10-15", "1y")).toBe("2027-10-15");
  });

  it("rejects impossible dates and bad periods", () => {
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("2026-13-01")).toBeNull();
    expect(parseDate("2026-1-1")).toBeNull();
    expect(parseDuration("90")).toBeNull();
    expect(parseDuration("0d")).toBeNull();
    expect(parseDuration("3 months")).toBeNull();
  });
});

describe("SLA state", () => {
  const sla = (lastVerified: unknown, every: unknown = "30d") => computeSla(lastVerified, every, NOW, 14);

  it("is fresh well inside the window", () => {
    expect(sla("2026-10-20")).toMatchObject({ state: "fresh", due: "2026-11-19", days_until_due: 17 });
  });

  it("is due_soon inside the warning window, inclusive", () => {
    expect(sla("2026-10-17")).toMatchObject({ state: "due_soon", days_until_due: 14 });
  });

  it("is still in SLA on the due day itself", () => {
    expect(sla("2026-10-03")).toMatchObject({ state: "due_soon", due: "2026-11-02", days_until_due: 0 });
  });

  it("is overdue the day after the due day, never due_soon", () => {
    expect(sla("2026-10-02")).toMatchObject({ state: "overdue", due: "2026-11-01", days_until_due: -1 });
  });

  it("uses the UTC calendar day regardless of time of day", () => {
    const lateUtc = computeSla("2026-10-03", "30d", new Date("2026-11-02T23:59:59Z"), 14);
    const earlyUtc = computeSla("2026-10-03", "30d", new Date("2026-11-02T00:00:00Z"), 14);
    expect(lateUtc.state).toBe("due_soon");
    expect(earlyUtc.state).toBe("due_soon");
  });

  it.each([[undefined], ["2026-02-30"], ["yesterday"], [20261015]])("is unverified for %s", (value) => {
    expect(sla(value).state).toBe("unverified");
  });

  it("is unverified when the period is invalid", () => {
    expect(sla("2026-10-20", "soon").state).toBe("unverified");
  });
});
