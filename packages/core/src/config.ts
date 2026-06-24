import type { PlatformId, SignalKind } from "./domain.js";

/** Business-calendar config for quiet-period math (DESIGN §7). */
export interface CalendarConfig {
  /** IANA timezone, e.g. "America/New_York". */
  timezone: string;
  /** Working days as ISO weekday numbers (1 = Mon … 7 = Sun). */
  workingDays: number[];
  /** Working hours window in local time, 24h, e.g. [9, 17]. */
  workingHours?: [number, number];
  /** ISO dates (YYYY-MM-DD) treated as holidays. */
  holidays?: string[];
}

/** Per-signal threshold + routing config. All thresholds are configuration. */
export interface SignalConfig {
  /** Quiet period before (re-)nudging, in business hours. */
  quietPeriodHours: number;
  /** Drop to digest-only after this many escalations. */
  maxEscalations: number;
  enabled: boolean;
}

/** Global + per-capability shadow flags (DESIGN §8). */
export interface ShadowConfig {
  /** Master switch — when true, nothing is posted anywhere. */
  global: boolean;
  /** Per-capability overrides (e.g. nudges, workingNotes, proposals). */
  capabilities: Partial<
    Record<"nudges" | "workingNotes" | "proposals" | "digest" | "orgRollup", boolean>
  >;
}

export type ShadowCapability = "nudges" | "workingNotes" | "proposals" | "digest" | "orgRollup";

/**
 * Whether a capability is in shadow mode (compute + log, post nothing). A
 * per-capability flag overrides the global default, so you flip one capability
 * live at a time (DESIGN §8).
 */
export function isShadowed(config: EngineConfig, capability: ShadowCapability): boolean {
  return config.shadow.capabilities[capability] ?? config.shadow.global;
}

export interface EngineConfig {
  calendar: CalendarConfig;
  signals: Record<SignalKind, SignalConfig>;
  shadow: ShadowConfig;
  /** Logins/handles never nudged and ignored for "is a reply owed" (DESIGN §7). */
  botAccounts: string[];
  /** Enable bounded LLM judgment of replies (e.g. did an @mention get answered). */
  llmJudge: boolean;
  /** Per-platform free-form deployment config (regex fallbacks, repos, etc.). */
  platforms: Partial<Record<PlatformId, Record<string, unknown>>>;
}
