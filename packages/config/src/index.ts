import type { EngineConfig, SignalConfig, SignalKind } from "@aipm/core";
import { engineConfigSchema, signalKinds, type EngineConfigInput } from "./schema.js";

export * from "./schema.js";

const HOUR = 1;
const DAY = 24 * HOUR;

/** Default per-signal thresholds from DESIGN §7. */
const defaultSignals: Record<SignalKind, SignalConfig> = {
  mentioned_no_response: { quietPeriodHours: 1 * DAY, maxEscalations: 3, enabled: true },
  review_requested: { quietPeriodHours: 1 * DAY, maxEscalations: 3, enabled: true },
  unaddressed_review_comments: { quietPeriodHours: 1 * DAY, maxEscalations: 3, enabled: true },
  pr_no_reviewer: { quietPeriodHours: 4 * HOUR, maxEscalations: 3, enabled: true },
  draft_pr_aged: { quietPeriodHours: 7 * DAY, maxEscalations: 3, enabled: true },
  in_progress_stale: { quietPeriodHours: 3 * DAY, maxEscalations: 3, enabled: true },
  // quietPeriodHours 0 = fire once (route suppresses repeats); maxEscalations 1
  // keeps the single nudge on its default DM channel.
  blocker_cleared: { quietPeriodHours: 0, maxEscalations: 1, enabled: true },
};

/**
 * Validate + merge a partial config over DESIGN defaults. Defaults to shadow
 * mode on (global: true) so a fresh deployment posts nothing.
 */
export function buildConfig(input: Partial<EngineConfigInput> = {}): EngineConfig {
  const signals = { ...defaultSignals, ...(input.signals ?? {}) };
  const parsed = engineConfigSchema.parse({ ...input, signals });
  // zod's record over an enum yields a partial type; defaults guarantee all keys.
  return parsed as EngineConfig;
}

export { signalKinds };
