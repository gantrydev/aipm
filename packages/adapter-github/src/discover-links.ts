import type { Link, LinkKind } from "@aipm/core";
import type { GraphqlNode } from "./graphql-schema.js";

type Ref = { number?: number; repository?: { nameWithOwner?: string } } | null | undefined;

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
export function discoverLinksFromGraphql(fromNativeId: string, node: GraphqlNode): Array<Link> {
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
  connNodes(node.closingIssuesReferences).forEach((r) => add(fromNativeId, ref(r), "closes"));
  connNodes(node.closedByPullRequestsReferences).forEach((r) =>
    add(ref(r), fromNativeId, "closes"),
  );
  add(fromNativeId, ref(node.parent), "sub_issue");
  connNodes(node.subIssues).forEach((r) => add(ref(r), fromNativeId, "sub_issue"));
  connNodes(node.blockedBy).forEach((r) => add(fromNativeId, ref(r), "blocked_by"));
  connNodes(node.blocking).forEach((r) => add(ref(r), fromNativeId, "blocked_by"));

  // --- timeline (event-only kinds + Connected/Disconnected negation) ---
  connNodes(node.timelineItems).forEach((e) => {
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

const connNodes = <T>(conn: { nodes?: Array<T> | null } | null | undefined): Array<T> => {
  const nodes = conn?.nodes;
  if (!nodes) return [];
  return nodes;
};

const ref = (n: Ref): string | undefined => {
  if (!n) return undefined;
  if (!n.number) return undefined;
  const owner = n.repository?.nameWithOwner;
  if (!owner) return undefined;
  return `${owner}#${n.number}`;
};
