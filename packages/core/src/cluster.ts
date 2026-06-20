import type { Link, SignalKind } from "./domain.js";

/**
 * Clusters are connected components over the Link set, plus any manual grouping
 * (DESIGN §4). Pure union-find over thread ids referenced by links.
 */
export function computeClusters(threadIds: string[], links: Link[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root && parent.has(root)) root = parent.get(root)!;
    return root;
  };
  for (const id of threadIds) parent.set(id, id);
  const ensure = (id: string) => {
    if (!parent.has(id)) parent.set(id, id);
  };
  const union = (a: string, b: string) => {
    ensure(a);
    ensure(b);
    parent.set(find(a), find(b));
  };
  for (const l of links) union(l.from, l.to);

  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(id);
  }
  return [...groups.values()].map((g) => g.sort());
}

/** Nudge dedupe key (DESIGN §2): `${person}:${threadId}:${signalKind}`. */
export function dedupeKey(person: string, threadId: string, kind: SignalKind): string {
  return `${person}:${threadId}:${kind}`;
}
