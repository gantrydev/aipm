import { groupBy } from "./common.helper.js";
import type { Link, SignalKind } from "./domain.js";

/**
 * Clusters are connected components over the Link set, plus any manual grouping
 * (DESIGN §4). Pure union-find over thread ids referenced by links.
 */
export function computeClusters(
  threadIds: Array<string>,
  links: Array<Link>,
): Array<Array<string>> {
  const parent = new Map<string, string>(threadIds.map((id) => [id, id] as const));
  const find = (x: string): string => {
    const p = parent.get(x);
    if (p === undefined || p === x) return x;
    return find(p);
  };
  const ensure = (id: string) => {
    if (!parent.has(id)) parent.set(id, id);
  };
  const union = (a: string, b: string) => {
    ensure(a);
    ensure(b);
    parent.set(find(a), find(b));
  };
  links.forEach((l) => union(l.from, l.to));

  const grouped = groupBy([...parent.keys()], (id) => find(id));
  const components = Object.values(grouped).flatMap((c) => (c ? [c] : []));
  return components.map((c) => [...c].sort());
}

/** Nudge dedupe key (DESIGN §2): `${person}:${threadId}:${signalKind}`. */
export function dedupeKey(person: string, threadId: string, kind: SignalKind): string {
  return `${person}:${threadId}:${kind}`;
}
