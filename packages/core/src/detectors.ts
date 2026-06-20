import type { Clock } from "./clock.js";
import type { EngineConfig } from "./config.js";
import type { Signal, SignalKind, Thread } from "./domain.js";

/** What a detector returns: signals to open and signal ids to clear. */
export interface DetectionResult {
  open: Array<Omit<Signal, "id" | "detectedAt">>;
  clear: Array<{ kind: SignalKind; reason: string }>;
}

export interface DetectorContext {
  config: EngineConfig;
  clock: Clock;
  /** Already-open signals for this thread, for clear decisions. */
  openSignals: Signal[];
}

/**
 * A deterministic detector for one signal kind (DESIGN §7). No LLM here —
 * detection of *that* an action is owed is plain logic over the timeline.
 */
export interface Detector {
  kind: SignalKind;
  detect(thread: Thread, ctx: DetectorContext): DetectionResult;
}

const empty: DetectionResult = { open: [], clear: [] };

/** Helper: terminal threads clear everything (universal stop condition). */
export function isTerminal(thread: Thread): boolean {
  return ["closed", "merged", "done", "resolved"].includes(thread.state.toLowerCase());
}

// --- V1 detectors (DESIGN §7) -------------------------------------------------
// Each is a stub returning no signals until phase-3 implementation. Unit tests
// (DESIGN §11) will drive synthetic timelines through each row.

export const mentionedNoResponse: Detector = {
  kind: "mentioned_no_response",
  detect: () => empty, // TODO(phase-3): @mention with no reply within quiet period.
};

export const reviewRequested: Detector = {
  kind: "review_requested",
  detect: () => empty, // TODO(phase-3): review requested, none submitted.
};

export const unaddressedReviewComments: Detector = {
  kind: "unaddressed_review_comments",
  detect: () => empty, // TODO(phase-3): review comments with no author reply/push.
};

export const prNoReviewer: Detector = {
  kind: "pr_no_reviewer",
  detect: () => empty, // TODO(phase-3): open PR with no reviewer (4h).
};

export const draftPrAged: Detector = {
  kind: "draft_pr_aged",
  detect: () => empty, // TODO(phase-5/sweep): draft PR older than threshold.
};

export const inProgressStale: Detector = {
  kind: "in_progress_stale",
  detect: () => empty, // TODO(phase-5/sweep): in-progress, no update for N days.
};

export const blockerCleared: Detector = {
  kind: "blocker_cleared",
  detect: () => empty, // TODO(phase-5): blocker resolved -> notify blocked owner.
};

export const detectors: Detector[] = [
  mentionedNoResponse,
  reviewRequested,
  unaddressedReviewComments,
  prNoReviewer,
  draftPrAged,
  inProgressStale,
  blockerCleared,
];
