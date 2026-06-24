import type { NormalizedRef, RawEvent, Thread, ThreadType, TimelineEvent } from "@aipm/core";

// --- helpers ------------------------------------------------------------------

export interface ParsedNativeId {
  owner: string;
  repo: string;
  number: number;
}

export function parseNativeId(nativeId: string): ParsedNativeId {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(nativeId);
  if (!m) throw new Error(`unparseable GitHub nativeId: ${nativeId}`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

export function isBotLogin(login: string | undefined, botAccounts: string[] = []): boolean {
  if (!login) return true;
  const normalized = login.toLowerCase();
  return normalized.endsWith("[bot]") || botAccounts.includes(normalized);
}

const loginOf = (a: unknown): string | undefined => {
  const login = (a as { login?: unknown } | null | undefined)?.login;
  return typeof login === "string" ? login : undefined;
};

const MENTION = /(?<![\w@])@([a-zA-Z\d](?:[a-zA-Z\d-]{0,38})?)\b/g;

/** Extract @-mention logins from a comment/review body (deduped), or undefined. */
function mentionsOf(body: unknown): string[] | undefined {
  if (typeof body !== "string") return undefined;
  const matches = [...body.matchAll(MENTION)];
  const out = new Set(matches.flatMap((m) => (m[1] ? [m[1]] : [])));
  return out.size ? [...out] : undefined;
}

const nodesOf = <T = unknown>(conn: unknown): T[] => {
  const nodes = (conn as { nodes?: unknown } | null | undefined)?.nodes;
  return Array.isArray(nodes) ? (nodes as T[]) : [];
};

// --- webhook event -> routable ref --------------------------------------------

interface WebhookPayload {
  repository?: { full_name?: string };
  issue?: { number?: number; pull_request?: unknown };
  pull_request?: { number?: number };
}

/**
 * Classify a webhook by its `X-GitHub-Event` header (RawEvent.event) — never by
 * `action`, whose values (opened/closed/created/…) collide across event types.
 * Returns undefined for events we don't ingest.
 */
export function normalizeWebhookEvent(raw: RawEvent): NormalizedRef | undefined {
  // Synthetic sweep events (cron) carry the ref directly (DESIGN §10.1 sweep).
  if (raw.event === "sweep") {
    const sp = raw.payload as { nativeId?: string; type?: ThreadType };
    return sp.nativeId && sp.type ? { nativeId: sp.nativeId, type: sp.type } : undefined;
  }

  const p = raw.payload as WebhookPayload;
  const full = p.repository?.full_name;
  if (!full) return undefined;

  const mk = (number: number | undefined, type: ThreadType): NormalizedRef | undefined =>
    number ? { nativeId: `${full}#${number}`, type } : undefined;

  switch (raw.event) {
    case "issues":
      return mk(p.issue?.number, "issue");
    case "issue_comment":
      // issue_comment fires for both issues and PRs; the PR marker disambiguates.
      return mk(p.issue?.number, p.issue?.pull_request ? "pr" : "issue");
    case "pull_request":
    case "pull_request_review":
    case "pull_request_review_comment":
    case "pull_request_review_thread":
      return mk(p.pull_request?.number, "pr");
    default:
      return undefined;
  }
}

// --- GraphQL node -> Thread ---------------------------------------------------

export interface NormalizeOptions {
  botAccounts?: string[];
}

export function issueState(node: { state?: string }): string {
  return node.state === "CLOSED" ? "closed" : "open";
}

export function prState(node: {
  state?: string;
  merged?: boolean;
  mergedAt?: string | null;
  isDraft?: boolean;
}): string {
  if (node.merged || node.mergedAt) return "merged";
  if (node.state === "CLOSED") return "closed";
  if (node.isDraft) return "draft";
  return "open";
}

/** All distinct human (non-bot) logins touching a thread → participant handles. */
export function collectParticipantLogins(
  node: Record<string, unknown>,
  opts: NormalizeOptions = {},
): string[] {
  const bots = opts.botAccounts ?? [];
  const out = new Set<string>();
  const add = (login: string | undefined) => {
    if (login && !isBotLogin(login, bots)) out.add(login);
  };

  add(loginOf(node.author));
  nodesOf(node.assignees).forEach((a) => add(loginOf(a)));
  nodesOf<Record<string, unknown>>(node.timelineItems).forEach((n) => {
    add(loginOf(n.actor) ?? loginOf(n.author));
  });
  nodesOf<Record<string, unknown>>(node.reviews).forEach((r) => add(loginOf(r.author)));
  nodesOf<Record<string, unknown>>(node.reviewRequests).forEach((r) => {
    add(loginOf((r as { requestedReviewer?: unknown }).requestedReviewer));
  });
  nodesOf<Record<string, unknown>>(node.reviewThreads).forEach((t) => {
    nodesOf<Record<string, unknown>>(t.comments).forEach((c) => add(loginOf(c.author)));
  });
  return [...out];
}

const clean = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null),
  ) as Partial<T>;

/** Map filtered timeline union nodes to TimelineEvents. Link-only nodes (cross-ref,
 *  connected, sub-issue, blocked-by, …) are dropped here and handled by discoverLinks. */
export function normalizeTimeline(nodes: Array<Record<string, unknown>>): TimelineEvent[] {
  return nodes.flatMap((n) => {
    const actor = loginOf(n.actor) ?? loginOf(n.author);
    const at = (n.createdAt ?? n.submittedAt) as string | undefined;
    const mapped = mapTimelineNode(n);
    if (!mapped || !at) return [];
    return [clean({ kind: mapped.kind, actor, at, data: mapped.data }) as TimelineEvent];
  });
}

function mapTimelineNode(
  n: Record<string, unknown>,
): { kind: string; data: Record<string, unknown> } | undefined {
  const t = n.__typename;
  const name = (x: unknown) => (x as { name?: string } | null)?.name;
  switch (t) {
    case "IssueComment":
      return { kind: "comment", data: clean({ body: n.body, mentions: mentionsOf(n.body) }) };
    case "PullRequestReview":
      return {
        kind: "review",
        data: clean({ state: n.state, body: n.body, mentions: mentionsOf(n.body) }),
      };
    case "ReviewRequestedEvent":
      return {
        kind: "review_request",
        data: clean({ target: reviewerHandle(n.requestedReviewer), removed: false }),
      };
    case "ReviewRequestRemovedEvent":
      return {
        kind: "review_request",
        data: clean({ target: reviewerHandle(n.requestedReviewer), removed: true }),
      };
    case "ReadyForReviewEvent":
      return { kind: "status", data: { state: "ready_for_review" } };
    case "ConvertToDraftEvent":
      return { kind: "status", data: { state: "draft" } };
    case "MergedEvent":
      return {
        kind: "status",
        data: clean({ state: "merged", commit: (n.commit as { oid?: string } | null)?.oid }),
      };
    case "ClosedEvent":
      return { kind: "status", data: clean({ state: "closed", stateReason: n.stateReason }) };
    case "ReopenedEvent":
      return { kind: "status", data: { state: "reopened" } };
    case "LabeledEvent":
      return { kind: "label", data: clean({ label: name(n.label), removed: false }) };
    case "UnlabeledEvent":
      return { kind: "label", data: clean({ label: name(n.label), removed: true }) };
    case "AssignedEvent":
      return { kind: "assignment", data: clean({ assignee: loginOf(n.assignee), removed: false }) };
    case "UnassignedEvent":
      return { kind: "assignment", data: clean({ assignee: loginOf(n.assignee), removed: true }) };
    case "MentionedEvent":
      return { kind: "mention", data: {} };
    case "RenamedTitleEvent":
      return {
        kind: "status",
        data: clean({ previousTitle: n.previousTitle, currentTitle: n.currentTitle }),
      };
    default:
      return undefined; // link-only or unmapped node
  }
}

const reviewerHandle = (r: unknown): string | undefined => {
  const rr = r as { login?: string; slug?: string } | null | undefined;
  return rr?.login ?? rr?.slug ?? undefined;
};

function baseMeta(node: Record<string, unknown>, repoFullName: string): Record<string, unknown> {
  return clean({
    repo: repoFullName,
    author: loginOf(node.author),
    labels: nodesOf<{ name?: string }>(node.labels)
      .map((l) => l.name)
      .filter(Boolean),
    assignees: nodesOf(node.assignees).map(loginOf).filter(Boolean),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  });
}

export function normalizeIssueGraphql(
  node: Record<string, unknown>,
  repoFullName: string,
  opts: NormalizeOptions = {},
): Thread {
  return {
    platform: "github",
    nativeId: `${repoFullName}#${node.number as number}`,
    type: "issue",
    title: (node.title as string) ?? undefined,
    body: (node.body as string) ?? undefined,
    state: issueState(node as { state?: string }),
    participants: collectParticipantLogins(node, opts),
    meta: clean({
      ...baseMeta(node, repoFullName),
      stateReason: node.stateReason,
      subIssuesSummary: node.subIssuesSummary,
      issueDependenciesSummary: node.issueDependenciesSummary,
    }),
    timeline: normalizeTimeline(nodesOf<Record<string, unknown>>(node.timelineItems)),
  };
}

export function normalizePrGraphql(
  node: Record<string, unknown>,
  repoFullName: string,
  opts: NormalizeOptions = {},
): Thread {
  return {
    platform: "github",
    nativeId: `${repoFullName}#${node.number as number}`,
    type: "pr",
    title: (node.title as string) ?? undefined,
    body: (node.body as string) ?? undefined,
    state: prState(node as Parameters<typeof prState>[0]),
    participants: collectParticipantLogins(node, opts),
    meta: clean({
      ...baseMeta(node, repoFullName),
      draft: node.isDraft,
      merged: node.merged,
      mergedAt: node.mergedAt,
      reviewDecision: node.reviewDecision,
    }),
    timeline: normalizeTimeline(nodesOf<Record<string, unknown>>(node.timelineItems)),
  };
}
