import { D1Store } from "@aipm/db";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Nudge } from "@aipm/core";

const MERGE_REGISTRY_KEY = "global";

describe("D1Store cluster membership (issue #8)", () => {
  it("getOrCreateCluster mints once and is idempotent for the same thread", async () => {
    const store = new D1Store(env.DB);
    const first = await store.getOrCreateCluster("o/r#1");
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;
    const second = await store.getOrCreateCluster("o/r#1");
    expect(second.ok).toBe(true);
    if (!second.ok) throw second.error;
    expect(first.data).toBe(second.data);
    const found = await store.findCluster("o/r#1");
    expect(found.ok).toBe(true);
    if (!found.ok) throw found.error;
    expect(found.data).toBe(first.data);
  });

  it("findCluster returns undefined for an unknown thread", async () => {
    const store = new D1Store(env.DB);
    const found = await store.findCluster("o/r#never");
    expect(found.ok).toBe(true);
    if (!found.ok) throw found.error;
    expect(found.data).toBeUndefined();
  });

  it("two distinct threads get two distinct minted cluster ids", async () => {
    const store = new D1Store(env.DB);
    const a = await store.getOrCreateCluster("o/r#a");
    expect(a.ok).toBe(true);
    if (!a.ok) throw a.error;
    const b = await store.getOrCreateCluster("o/r#b");
    expect(b.ok).toBe(true);
    if (!b.ok) throw b.error;
    expect(a.data).not.toBe(b.data);
  });

  it("listClusterThreads returns the cluster's members ordered by thread id", async () => {
    const store = new D1Store(env.DB);
    const clusterId = await store.getOrCreateCluster("o/r#10");
    expect(clusterId.ok).toBe(true);
    if (!clusterId.ok) throw clusterId.error;
    const member2 = await store.getOrCreateCluster("o/r#2");
    expect(member2.ok).toBe(true);
    if (!member2.ok) throw member2.error;
    const repointed2 = await store.repointCluster({
      fromClusterId: member2.data,
      toClusterId: clusterId.data,
    });
    expect(repointed2.ok).toBe(true);
    if (!repointed2.ok) throw repointed2.error;
    const member5 = await store.getOrCreateCluster("o/r#5");
    expect(member5.ok).toBe(true);
    if (!member5.ok) throw member5.error;
    const repointed5 = await store.repointCluster({
      fromClusterId: member5.data,
      toClusterId: clusterId.data,
    });
    expect(repointed5.ok).toBe(true);
    if (!repointed5.ok) throw repointed5.error;
    const members = await store.listClusterThreads(clusterId.data);
    expect(members.ok).toBe(true);
    if (!members.ok) throw members.error;
    expect(members.data).toEqual(["o/r#10", "o/r#2", "o/r#5"]);
  });

  it("repointCluster moves every member and deleteCluster drops the row + cluster note", async () => {
    const store = new D1Store(env.DB);
    const loser = await store.getOrCreateCluster("o/r#loser1");
    expect(loser.ok).toBe(true);
    if (!loser.ok) throw loser.error;
    const loser2 = await store.getOrCreateCluster("o/r#loser2");
    expect(loser2.ok).toBe(true);
    if (!loser2.ok) throw loser2.error;
    const repointedLoser2 = await store.repointCluster({
      fromClusterId: loser2.data,
      toClusterId: loser.data,
    });
    expect(repointedLoser2.ok).toBe(true);
    if (!repointedLoser2.ok) throw repointedLoser2.error;
    const winner = await store.getOrCreateCluster("o/r#winner");
    expect(winner.ok).toBe(true);
    if (!winner.ok) throw winner.error;
    const noted = await store.upsertWorkingNotes({
      scope: "cluster",
      targetId: loser.data,
      content: "stale cluster note",
      contentHash: "h-loser",
      provenance: "cluster",
    });
    expect(noted.ok).toBe(true);
    if (!noted.ok) throw noted.error;

    const repointedLoser = await store.repointCluster({
      fromClusterId: loser.data,
      toClusterId: winner.data,
    });
    expect(repointedLoser.ok).toBe(true);
    if (!repointedLoser.ok) throw repointedLoser.error;
    const deleted = await store.deleteCluster(loser.data);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) throw deleted.error;

    const loserMembers = await store.listClusterThreads(loser.data);
    expect(loserMembers.ok).toBe(true);
    if (!loserMembers.ok) throw loserMembers.error;
    expect(loserMembers.data).toEqual([]);
    const winnerMembers = await store.listClusterThreads(winner.data);
    expect(winnerMembers.ok).toBe(true);
    if (!winnerMembers.ok) throw winnerMembers.error;
    expect(winnerMembers.data).toEqual(["o/r#loser1", "o/r#loser2", "o/r#winner"]);
    const foundLoser1 = await store.findCluster("o/r#loser1");
    expect(foundLoser1.ok).toBe(true);
    if (!foundLoser1.ok) throw foundLoser1.error;
    expect(foundLoser1.data).toBe(winner.data);
    const loserNote = await store.getWorkingNotes("cluster", loser.data);
    expect(loserNote.ok).toBe(true);
    if (!loserNote.ok) throw loserNote.error;
    expect(loserNote.data).toBeUndefined();
  });
});

describe("D1Store.tryClaimNudge atomic claim (issue #8)", () => {
  const nudge = (over: Partial<Nudge>): Nudge => ({
    person: "u-1",
    signalId: "sig-1",
    channel: "dm",
    dedupeKey: "u-1:o/r#1:review_requested",
    sentAt: "2026-01-10T00:00:00.000Z",
    state: "sent",
    escalations: 1,
    ...over,
  });

  it("first claimant wins; a second claim on a live row loses and does not overwrite", async () => {
    const store = new D1Store(env.DB);
    const key = "u-1:o/r#claim:review_requested";
    const wonFirst = await store.tryClaimNudge(nudge({ dedupeKey: key, escalations: 1 }));
    expect(wonFirst.ok).toBe(true);
    if (!wonFirst.ok) throw wonFirst.error;
    expect(wonFirst.data).toBe(true);
    const wonSecond = await store.tryClaimNudge(nudge({ dedupeKey: key, escalations: 99 }));
    expect(wonSecond.ok).toBe(true);
    if (!wonSecond.ok) throw wonSecond.error;
    expect(wonSecond.data).toBe(false);
    const persisted = await store.getNudgeByDedupeKey(key);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) throw persisted.error;
    expect(persisted.data?.escalations).toBe(1);
  });

  it("upgrades an existing shadow row to a real send (the go-live path)", async () => {
    const store = new D1Store(env.DB);
    const key = "u-1:o/r#shadow:review_requested";
    const seeded = await store.upsertNudge(nudge({ dedupeKey: key, state: "shadow" }));
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) throw seeded.error;
    const won = await store.tryClaimNudge(nudge({ dedupeKey: key, state: "sent" }));
    expect(won.ok).toBe(true);
    if (!won.ok) throw won.error;
    expect(won.data).toBe(true);
    const persisted = await store.getNudgeByDedupeKey(key);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) throw persisted.error;
    expect(persisted.data?.state).toBe("sent");
    const wonAgain = await store.tryClaimNudge(nudge({ dedupeKey: key, state: "sent" }));
    expect(wonAgain.ok).toBe(true);
    if (!wonAgain.ok) throw wonAgain.error;
    expect(wonAgain.data).toBe(false);
  });
});

describe("D1Store.replaceLinksFrom", () => {
  it("replaces only links owned by the source thread", async () => {
    const store = new D1Store(env.DB);
    const seeded = await store.upsertLinks([
      { from: "links/source", to: "links/stale", kind: "refs" },
      { from: "links/inbound", to: "links/source", kind: "refs" },
    ]);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) throw seeded.error;

    const replaced = await store.replaceLinksFrom("links/source", [
      { from: "links/source", to: "links/fresh", kind: "refs" },
      { from: "links/other", to: "links/ignored", kind: "refs" },
    ]);
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) throw replaced.error;

    const links = await store.getLinks("links/source");
    expect(links.ok).toBe(true);
    if (!links.ok) throw links.error;
    expect(links.data).toHaveLength(2);
    expect(links.data).toContainEqual({ from: "links/inbound", to: "links/source", kind: "refs" });
    expect(links.data).toContainEqual({ from: "links/source", to: "links/fresh", kind: "refs" });
  });
});

describe("MergeRegistry.union (issue #8)", () => {
  it("merges two clusters to the lexicographically smaller winner and converges", async () => {
    const store = new D1Store(env.DB);
    const registryId = env.MERGE_REGISTRY.idFromName(MERGE_REGISTRY_KEY);
    const registry = env.MERGE_REGISTRY.get(registryId);

    const clusterA = await store.getOrCreateCluster("m/r#1");
    expect(clusterA.ok).toBe(true);
    if (!clusterA.ok) throw clusterA.error;
    const clusterB = await store.getOrCreateCluster("m/r#2");
    expect(clusterB.ok).toBe(true);
    if (!clusterB.ok) throw clusterB.error;
    const expectedWinner = clusterA.data < clusterB.data ? clusterA.data : clusterB.data;
    const expectedLoser = clusterA.data < clusterB.data ? clusterB.data : clusterA.data;

    const winner = await registry.union({ threadA: "m/r#1", threadB: "m/r#2" });
    expect(winner).toBe(expectedWinner);
    const foundA = await store.findCluster("m/r#1");
    expect(foundA.ok).toBe(true);
    if (!foundA.ok) throw foundA.error;
    expect(foundA.data).toBe(expectedWinner);
    const foundB = await store.findCluster("m/r#2");
    expect(foundB.ok).toBe(true);
    if (!foundB.ok) throw foundB.error;
    expect(foundB.data).toBe(expectedWinner);
    const loserMembers = await store.listClusterThreads(expectedLoser);
    expect(loserMembers.ok).toBe(true);
    if (!loserMembers.ok) throw loserMembers.error;
    expect(loserMembers.data).toEqual([]);

    const repeat = await registry.union({ threadA: "m/r#1", threadB: "m/r#2" });
    expect(repeat).toBe(expectedWinner);
  });

  it("is a no-op when both threads already share a cluster", async () => {
    const store = new D1Store(env.DB);
    const registry = env.MERGE_REGISTRY.get(env.MERGE_REGISTRY.idFromName(MERGE_REGISTRY_KEY));
    const shared = await store.getOrCreateCluster("m/r#same1");
    expect(shared.ok).toBe(true);
    if (!shared.ok) throw shared.error;
    const same2 = await store.getOrCreateCluster("m/r#same2");
    expect(same2.ok).toBe(true);
    if (!same2.ok) throw same2.error;
    const repointed = await store.repointCluster({
      fromClusterId: same2.data,
      toClusterId: shared.data,
    });
    expect(repointed.ok).toBe(true);
    if (!repointed.ok) throw repointed.error;
    const result = await registry.union({ threadA: "m/r#same1", threadB: "m/r#same2" });
    expect(result).toBe(shared.data);
    const foundSame2 = await store.findCluster("m/r#same2");
    expect(foundSame2.ok).toBe(true);
    if (!foundSame2.ok) throw foundSame2.error;
    expect(foundSame2.data).toBe(shared.data);
  });
});
