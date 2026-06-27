import type { Link, LinkKind } from "@aipm/core";

/**
 * Native link discovery from a fetched GraphQL issue/PR node (DESIGN §4). Live
 * connections (closingIssuesReferences, parent/subIssues, blockedBy/blocking)
 * are authoritative for current state; timeline events only contribute the
 * event-only kinds (refs via Connected/Disconnected, cross_ref via
 * CrossReferenced/MarkedAsDuplicate). `closes` comes solely from the dedicated
 * connection fields — its DESIGN primary source — so we don't also derive it
 * from CrossReferencedEvent.willCloseTarget (that would duplicate it in the
 * opposite direction).
 */
export function discoverLinksFromGraphql(
  fromNativeId: string,
  node: Record<string, unknown>,
): Array<Link> {
  const links = new Map<string, Link>();
  const key = (l: Link) => `${l.from}|${l.to}|${l.kind}`;
  const add = (from: string | undefined, to: string | undefined, kind: LinkKind) => {
    if (!from || !to || from === to) return;
    const l: Link = { from, to, kind };
    links.set(key(l), l);
  };
  const del = (from: string, to: string | undefined, kind: LinkKind) => {
    if (to) links.delete(key({ from, to, kind }));
  };

  // --- live connections (authoritative) ---
  conn(node, "closingIssuesReferences").forEach((r) => add(fromNativeId, ref(r), "closes"));
  conn(node, "closedByPullRequestsReferences").forEach((r) => add(ref(r), fromNativeId, "closes"));
  add(fromNativeId, ref((node as { parent?: unknown }).parent), "sub_issue");
  conn(node, "subIssues").forEach((r) => add(ref(r), fromNativeId, "sub_issue"));
  conn(node, "blockedBy").forEach((r) => add(fromNativeId, ref(r), "blocked_by"));
  conn(node, "blocking").forEach((r) => add(ref(r), fromNativeId, "blocked_by"));

  // --- timeline (event-only kinds + Connected/Disconnected negation) ---
  conn(node, "timelineItems").forEach((ev) => {
    const e = ev as Record<string, unknown>;
    switch (e.__typename) {
      case "ConnectedEvent":
        add(fromNativeId, ref(e.subject), "refs");
        break;
      case "DisconnectedEvent":
        del(fromNativeId, ref(e.subject), "refs");
        break;
      case "CrossReferencedEvent":
        add(ref(e.source), fromNativeId, "cross_ref");
        break;
      case "MarkedAsDuplicateEvent":
        add(fromNativeId, ref(e.canonical), "cross_ref");
        break;
    }
  });

  return [...links.values()];
}

export function linkNativeId(repoNameWithOwner: string, number: number): string {
  return `${repoNameWithOwner}#${number}`;
}

const conn = (node: Record<string, unknown>, field: string): Array<unknown> => {
  const nodes = (node[field] as { nodes?: unknown } | undefined)?.nodes;
  return Array.isArray(nodes) ? nodes : [];
};

const ref = (n: unknown): string | undefined => {
  const x = n as { number?: number; repository?: { nameWithOwner?: string } } | null | undefined;
  if (!x?.number || !x.repository?.nameWithOwner) return undefined;
  return `${x.repository.nameWithOwner}#${x.number}`;
};
