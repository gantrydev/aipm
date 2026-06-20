import type { CalendarConfig } from "./config.js";

/** Injectable clock so detectors and tests are deterministic. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(at: string | Date): Clock {
  const d = typeof at === "string" ? new Date(at) : at;
  return { now: () => new Date(d.getTime()) };
}

/**
 * Business-day-aware elapsed hours between two instants.
 *
 * TODO(phase-1): implement using `cal.timezone`, `cal.workingDays`,
 * `cal.workingHours`, and `cal.holidays`. Until then this is a placeholder that
 * returns wall-clock hours so the pipeline type-checks.
 */
export function businessHoursBetween(from: Date, to: Date, _cal: CalendarConfig): number {
  return Math.max(0, (to.getTime() - from.getTime()) / 3_600_000);
}
