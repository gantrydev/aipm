import type { NudgeChannel, SignalKind, Thread } from "./domain.js";

/** Default delivery channel per signal kind (DESIGN §7). */
const DEFAULT_CHANNEL: Record<SignalKind, NudgeChannel> = {
  mentioned_no_response: "dm",
  review_requested: "dm",
  unaddressed_review_comments: "dm",
  pr_no_reviewer: "dm",
  blocker_cleared: "dm",
  draft_pr_aged: "digest",
  in_progress_stale: "digest",
};

/**
 * Channel routing (DESIGN §7): high-priority → immediate DM; after maxEscalations
 * a signal drops to digest-only; otherwise the signal's default channel.
 */
export function chooseChannel(
  kind: SignalKind,
  thread: Thread,
  escalations: number,
  maxEscalations: number,
): NudgeChannel {
  if (escalations > maxEscalations) return "digest";
  if (thread.meta.priority === "high") return "dm";
  return DEFAULT_CHANNEL[kind];
}

const TITLE = (t: Thread) => t.title ?? t.nativeId;

/** Concise, deterministic DM body for a signal (LLM wording is a later polish). */
export function buildNudgeMessage(thread: Thread, kind: SignalKind): string {
  const ref = `*${TITLE(thread)}* (\`${thread.nativeId}\`)`;
  switch (kind) {
    case "review_requested":
      return `👀 A review is waiting on you: ${ref}.`;
    case "pr_no_reviewer":
      return `🧑‍🔧 Your PR has no reviewer yet: ${ref}. Consider requesting one.`;
    case "unaddressed_review_comments":
      return `💬 There are review comments awaiting your reply on ${ref}.`;
    case "mentioned_no_response":
      return `📣 You were mentioned and haven't replied on ${ref}.`;
    case "draft_pr_aged":
      return `📜 Your draft PR has been open a while: ${ref}. Mark ready or close it?`;
    case "in_progress_stale":
      return `🕰️ This looks stalled: ${ref}. A quick update would help.`;
    case "blocker_cleared":
      return `✅ A blocker cleared — ${ref} may be unblocked now.`;
  }
}
