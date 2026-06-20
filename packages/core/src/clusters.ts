import type { Cluster, PlatformId } from "./domain.js";
import { stableHash } from "./notes.js";
import type { EngineContext } from "./pipeline.js";

const CLUSTER_MARKER = "<!-- aipm:cluster-notes -->";
const ROLLUP_MARKER = "<!-- aipm:org-rollup -->";
const ORG_TARGET = "org";

/**
 * Recompute the connected component (over Link edges, DESIGN §4) containing a
 * thread and upsert it as a Cluster. The cluster id is anchored on the
 * lexicographically smallest member so it's stable while that member remains.
 * Singletons aren't clustered.
 */
export async function maintainCluster(
  ctx: EngineContext,
  threadNativeId: string,
): Promise<Cluster | undefined> {
  const members = await connectedComponent(ctx, threadNativeId);
  if (members.length < 2) return undefined;
  const cluster: Cluster = { id: `cluster:${members[0]}`, threadIds: members };
  await ctx.store.upsertCluster(cluster);
  return cluster;
}

async function connectedComponent(ctx: EngineContext, start: string): Promise<string[]> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    for (const l of await ctx.store.getLinks(id)) {
      const other = l.from === id ? l.to : l.from;
      if (!seen.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return [...seen].sort();
}

/**
 * Cluster notes (DESIGN §8): roll the per-thread working notes of related work
 * into one cluster artifact. Deterministic structuring over already-synthesized
 * member notes (no extra LLM); idempotent via a hash of member note hashes.
 */
export async function synthesizeCluster(
  ctx: EngineContext,
  cluster: Cluster,
  platform: PlatformId,
): Promise<void> {
  const lines: string[] = [];
  const memberHashes: string[] = [];
  for (const nid of cluster.threadIds) {
    // A cluster can span platforms; a GitHub nativeId carries '#<number>',
    // a Slack one is `channel/ts`. Look each member up on its own platform.
    const memberPlatform: PlatformId = nid.includes("#") ? "github" : platform;
    const thread = await ctx.store.getThread(memberPlatform, nid);
    const notes = await ctx.store.getWorkingNotes("thread", nid);
    lines.push(`- \`${nid}\` — ${thread?.state ?? "unknown"}${notes ? "" : " (no notes yet)"}`);
    memberHashes.push(notes?.contentHash ?? "none");
  }

  const contentHash = stableHash(
    `${cluster.id}|${cluster.threadIds.join(",")}|${memberHashes.join(",")}`,
  );
  const stored = await ctx.store.getWorkingNotes("cluster", cluster.id);
  if (stored?.contentHash === contentHash) return;

  const body = `${CLUSTER_MARKER}\n**🧩 Cluster** — ${cluster.threadIds.length} related threads\n${lines.join("\n")}`;
  await ctx.store.upsertWorkingNotes({
    scope: "cluster",
    targetId: cluster.id,
    content: `${body}\n\n<sub>aipm · ${contentHash}</sub>`,
    contentHash,
    provenance: "cluster",
  });
}

/**
 * Org rollup (DESIGN §8): a single read-only artifact over all cluster notes.
 * Stored as a cluster-scoped note under a reserved target; served by the Worker.
 */
export async function aggregateOrg(ctx: EngineContext): Promise<void> {
  const notes = (await ctx.store.listWorkingNotes("cluster")).filter(
    (n) => n.targetId !== ORG_TARGET,
  );
  const contentHash = stableHash(
    notes
      .map((n) => `${n.targetId}:${n.contentHash}`)
      .sort()
      .join(","),
  );
  const stored = await ctx.store.getWorkingNotes("cluster", ORG_TARGET);
  if (stored?.contentHash === contentHash) return;

  const sections = notes
    .map((n) => n.content.replace(CLUSTER_MARKER, "").trim())
    .join("\n\n---\n\n");
  const content = `${ROLLUP_MARKER}\n# Org rollup — ${notes.length} cluster(s)\n\n${sections}\n\n<sub>aipm · ${contentHash}</sub>`;
  await ctx.store.upsertWorkingNotes({
    scope: "cluster",
    targetId: ORG_TARGET,
    content,
    contentHash,
    provenance: "org-rollup",
  });
}

export { ORG_TARGET };
