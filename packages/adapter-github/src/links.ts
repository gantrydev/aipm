import type { Link, LinkKind } from "@aipm/core";

/**
 * Regex fallback for link discovery (DESIGN §4). Native GraphQL relations are
 * preferred; this layer is configured per deployment, never relied on in core.
 * Recognizes closing keywords + `owner/repo#N` / `#N` references.
 */
const CLOSING = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b\s+(?<ref>(?:[\w.-]+\/[\w.-]+)?#\d+)/giu;
const REF = /(?<ref>(?:[\w.-]+\/[\w.-]+)?#\d+)/giu;

export function discoverLinksFromText(
  fromNativeId: string,
  text: string,
  resolveRef: (ref: string) => string = (r) => r,
): Link[] {
  const links: Link[] = [];
  const seen = new Set<string>();
  const push = (ref: string, kind: LinkKind) => {
    const to = resolveRef(ref);
    const key = `${to}:${kind}`;
    if (to === fromNativeId || seen.has(key)) return;
    seen.add(key);
    links.push({ from: fromNativeId, to, kind });
  };

  const closingMatches = [...text.matchAll(CLOSING)];
  closingMatches.forEach((m) => {
    if (m.groups?.ref) push(m.groups.ref, "closes");
  });
  const refMatches = [...text.matchAll(REF)];
  refMatches.forEach((m) => {
    if (m.groups?.ref) push(m.groups.ref, "refs");
  });
  return links;
}
