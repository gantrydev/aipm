// Platform-neutral domain model (DESIGN §2).
// No type in this file may name GitHub or Slack.

export type PlatformId = "github" | "slack" | (string & {});

export interface Identity {
  /** Canonical internal id. */
  id: string;
  /** Per-platform handles, e.g. { github: login, slack: "U…" }. */
  handles: Partial<Record<PlatformId, string>>;
  email?: string;
  displayName?: string;
}

export type ThreadType = "issue" | "pr" | "slack_thread" | "channel";

export interface Thread {
  platform: PlatformId;
  /** e.g. "owner/repo#123" or Slack "C…/ts". */
  nativeId: string;
  type: ThreadType;
  title?: string;
  body?: string;
  /** Adapter-normalized lifecycle state (open/closed/merged/…). */
  state: string;
  /** Identity ids. */
  participants: string[];
  /** Identity id of who owns the next step. */
  owner?: string;
  /** Labels, board status, draft flag, etc. Shape is the deployment's concern. */
  meta: Record<string, unknown>;
  timeline: TimelineEvent[];
}

export interface TimelineEvent {
  /** comment, review, label, mention, status, … */
  kind: string;
  /** Identity id. */
  actor?: string;
  /** ISO timestamp. */
  at: string;
  data: Record<string, unknown>;
}

export type LinkKind =
  | "closes"
  | "refs"
  | "sub_issue"
  | "blocked_by"
  | "cross_ref"
  | "mention"
  | "manual";

export interface Link {
  /** Thread nativeId (or internal thread id) of the source. */
  from: string;
  /** Thread nativeId (or internal thread id) of the target. */
  to: string;
  kind: LinkKind;
}

export interface Cluster {
  id: string;
  threadIds: string[];
}

export interface WorkingNotes {
  scope: "thread" | "cluster";
  targetId: string;
  content: string;
  /** Idempotency key over content — re-post only when this changes. */
  contentHash: string;
  provenance: string;
}

export type SignalKind =
  | "mentioned_no_response"
  | "review_requested"
  | "unaddressed_review_comments"
  | "pr_no_reviewer"
  | "draft_pr_aged"
  | "in_progress_stale"
  | "blocker_cleared";

export interface Signal {
  id: string;
  threadId: string;
  kind: SignalKind;
  /** Identity id who owes the action. */
  owedBy?: string;
  detectedAt: string;
  clearedAt?: string;
}

export type NudgeChannel = "dm" | "digest";
export type NudgeState = "pending" | "sent" | "cleared" | "shadow";

export interface Nudge {
  /** Identity id. */
  person: string;
  signalId: string;
  channel: NudgeChannel;
  /** `${person}:${threadId}:${signalKind}` */
  dedupeKey: string;
  sentAt?: string;
  state: NudgeState;
  escalations: number;
}

export type PreferenceRule = "mute" | "snooze" | "route" | "own";

export interface Preference {
  /** Identity id. */
  person: string;
  rule: PreferenceRule;
  /** e.g. { repo, priority } or { threadId }. */
  selector: Record<string, unknown>;
  /** For snooze: ISO timestamp until which it applies. */
  until?: string;
}
