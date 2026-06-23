import { businessHoursBetween, type Clock } from "./clock.js";
import type { EngineConfig } from "./config.js";
import type { SignalKind, Thread, TimelineEvent } from "./domain.js";

/** A currently-owed signal. `evaluate` reconciles these against open Signal rows. */
export interface ActiveSignal {
  kind: SignalKind;
  /** Identity id who owes the action. */
  owedBy?: string;
}

export interface DetectorContext {
  config: EngineConfig;
  clock: Clock;
}

/**
 * A deterministic detector for one signal kind (DESIGN §7). No LLM. Returns the
 * signals that are owed *right now*; a signal clears simply by no longer being
 * returned (e.g. the reviewer reviewed, the author replied).
 */
export interface Detector {
  kind: SignalKind;
  detect(thread: Thread, ctx: DetectorContext): ActiveSignal[];
}

// --- helpers ------------------------------------------------------------------

export function isTerminal(thread: Thread): boolean {
  return ["closed", "merged", "done", "resolved"].includes(thread.state.toLowerCase());
}

const at = (e: TimelineEvent) => Date.parse(e.at);
const quiet = (ctx: DetectorContext, kind: SignalKind) =>
  ctx.config.signals[kind]?.quietPeriodHours ?? Infinity;

/** Business hours elapsed since `iso` (undefined => not yet eligible). */
function elapsed(iso: string | undefined, ctx: DetectorContext): number {
  if (!iso) return -1;
  return businessHoursBetween(new Date(iso), ctx.clock.now(), ctx.config.calendar);
}

const metaStr = (thread: Thread, key: string): string | undefined => {
  const v = thread.meta[key];
  return typeof v === "string" ? v : undefined;
};

/** Net set of currently-requested reviewers → the time of their latest request. */
function currentRequestedReviewers(thread: Thread): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of thread.timeline) {
    if (e.kind !== "review_request") continue;
    const target = typeof e.data.target === "string" ? e.data.target : undefined;
    if (!target) continue;
    if (e.data.removed) m.delete(target);
    else m.set(target, e.at);
  }
  return m;
}

// --- V1 detectors (DESIGN §7) -------------------------------------------------

export const prNoReviewer: Detector = {
  kind: "pr_no_reviewer",
  detect(thread, ctx) {
    if (thread.type !== "pr" || thread.state !== "open") return [];
    if (currentRequestedReviewers(thread).size > 0) return [];
    if (thread.timeline.some((e) => e.kind === "review")) return [];
    if (elapsed(metaStr(thread, "createdAt"), ctx) < quiet(ctx, "pr_no_reviewer")) return [];
    const author = metaStr(thread, "author");
    return author ? [{ kind: "pr_no_reviewer", owedBy: author }] : [];
  },
};

export const reviewRequested: Detector = {
  kind: "review_requested",
  detect(thread, ctx) {
    // Reviews are commonly requested on draft PRs too; only terminal PRs opt out.
    if (thread.type !== "pr" || isTerminal(thread)) return [];
    const out: ActiveSignal[] = [];
    for (const [reviewer, reqAt] of currentRequestedReviewers(thread)) {
      // Only a substantive review (approve / changes requested) clears the ask;
      // a COMMENTED/DISMISSED review does not satisfy the request.
      const reviewed = thread.timeline.some(
        (e) =>
          e.kind === "review" &&
          e.actor === reviewer &&
          (e.data.state === "APPROVED" || e.data.state === "CHANGES_REQUESTED") &&
          at(e) >= Date.parse(reqAt),
      );
      if (reviewed) continue;
      if (elapsed(reqAt, ctx) < quiet(ctx, "review_requested")) continue;
      out.push({ kind: "review_requested", owedBy: reviewer });
    }
    return out;
  },
};

export const unaddressedReviewComments: Detector = {
  kind: "unaddressed_review_comments",
  detect(thread, ctx) {
    if (thread.type !== "pr" || thread.state !== "open") return [];
    const author = metaStr(thread, "author");
    if (!author) return [];
    const changeReqs = thread.timeline.filter(
      (e) => e.kind === "review" && e.data.state === "CHANGES_REQUESTED",
    );
    if (!changeReqs.length) return [];
    const dated = changeReqs.flatMap((e) => (Number.isFinite(at(e)) ? [e] : []));
    if (!dated.length) return [];
    const last = Math.max(...dated.map(at));
    // Addressed only by a genuine author response (reply/review). A status event
    // (ready_for_review/reopened) is not a reply and must not clear this.
    // TODO(phase-5): also clear on a push once we ingest commit events.
    const addressed = thread.timeline.some(
      (e) => e.actor === author && at(e) > last && (e.kind === "comment" || e.kind === "review"),
    );
    if (addressed) return [];
    const newest = dated.find((e) => at(e) === last);
    if (!newest) return [];
    const lastIso = newest.at;
    if (elapsed(lastIso, ctx) < quiet(ctx, "unaddressed_review_comments")) return [];
    return [{ kind: "unaddressed_review_comments", owedBy: author }];
  },
};

export const mentionedNoResponse: Detector = {
  kind: "mentioned_no_response",
  detect(thread, ctx) {
    if (isTerminal(thread)) return []; // mentions on draft PRs still count
    // Latest mention time per mentioned identity (ignoring self-mentions).
    const lastMention = new Map<string, string>();
    for (const e of thread.timeline) {
      if (e.kind !== "comment" && e.kind !== "review") continue;
      const mentions = Array.isArray(e.data.mentions) ? (e.data.mentions as string[]) : [];
      for (const id of mentions) {
        if (id === e.actor) continue;
        const prev = lastMention.get(id);
        if (!prev || at(e) > Date.parse(prev)) lastMention.set(id, e.at);
      }
    }
    const out: ActiveSignal[] = [];
    for (const [id, when] of lastMention) {
      const responded = thread.timeline.some(
        (e) =>
          e.actor === id &&
          (e.kind === "comment" || e.kind === "review") &&
          at(e) > Date.parse(when),
      );
      if (responded) continue;
      if (elapsed(when, ctx) < quiet(ctx, "mentioned_no_response")) continue;
      out.push({ kind: "mentioned_no_response", owedBy: id });
    }
    return out;
  },
};

export const draftPrAged: Detector = {
  kind: "draft_pr_aged",
  detect(thread, ctx) {
    if (thread.type !== "pr" || thread.state !== "draft") return [];
    if (elapsed(metaStr(thread, "createdAt"), ctx) < quiet(ctx, "draft_pr_aged")) return [];
    const author = metaStr(thread, "author");
    return author ? [{ kind: "draft_pr_aged", owedBy: author }] : [];
  },
};

export const inProgressStale: Detector = {
  kind: "in_progress_stale",
  // TODO(phase-5): needs deployment-defined "in progress" (board status/label)
  // from thread.meta; staleness over updatedAt vs N days. Deferred.
  detect: () => [],
};

/** Pure per-thread detectors. `blocker_cleared` is cross-thread (see evaluate). */
export const detectors: Detector[] = [
  prNoReviewer,
  reviewRequested,
  unaddressedReviewComments,
  mentionedNoResponse,
  draftPrAged,
  inProgressStale,
];
