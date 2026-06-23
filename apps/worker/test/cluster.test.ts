import { D1Store } from "@aipm/db";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Nudge } from "@aipm/core";

const MERGE_REGISTRY_KEY = "global";

describe("D1Store cluster membership (issue #8)", () => {
  it("getOrCreateCluster mints once and is idempotent for the same thread", async () => {
    const store = new D1Store(env.DB);
    const first = await store.getOrCreateCluster("o/r#1");
    const second = await store.getOrCreateCluster("o/r#1");
    expect(first).toBe(second);
    const found = await store.findCluster("o/r#1");
    expect(found).toBe(first);
  });

  it("findCluster returns undefined for an unknown thread", async () => {
    const store = new D1Store(env.DB);
    const found = await store.findCluster("o/r#never");
    expect(found).toBeUndefined();
  });

  it("two distinct threads get two distinct minted cluster ids", async () => {
    const store = new D1Store(env.DB);
    const a = await store.getOrCreateCluster("o/r#a");
    const b = await store.getOrCreateCluster("o/r#b");
    expect(a).not.toBe(b);
  });

  it("listClusterThreads returns the cluster's members ordered by thread id", async () => {
    const store = new D1Store(env.DB);
    const clusterId = await store.getOrCreateCluster("o/r#10");
    await store.repointCluster({
      fromClusterId: await store.getOrCreateCluster("o/r#2"),
      toClusterId: clusterId,
    });
    await store.repointCluster({
      fromClusterId: await store.getOrCreateCluster("o/r#5"),
      toClusterId: clusterId,
    });
    const members = await store.listClusterThreads(clusterId);
    expect(members).toEqual(["o/r#10", "o/r#2", "o/r#5"]);
  });

  it("repointCluster moves every member and deleteCluster drops the row + cluster note", async () => {
    const store = new D1Store(env.DB);
    const loser = await store.getOrCreateCluster("o/r#loser1");
    await store.repointCluster({
      fromClusterId: await store.getOrCreateCluster("o/r#loser2"),
      toClusterId: loser,
    });
    const winner = await store.getOrCreateCluster("o/r#winner");
    await store.upsertWorkingNotes({
      scope: "cluster",
      targetId: loser,
      content: "stale cluster note",
      contentHash: "h-loser",
      provenance: "cluster",
    });

    await store.repointCluster({ fromClusterId: loser, toClusterId: winner });
    await store.deleteCluster(loser);

    expect(await store.listClusterThreads(loser)).toEqual([]);
    const winnerMembers = await store.listClusterThreads(winner);
    expect(winnerMembers).toEqual(["o/r#loser1", "o/r#loser2", "o/r#winner"]);
    expect(await store.findCluster("o/r#loser1")).toBe(winner);
    expect(await store.getWorkingNotes("cluster", loser)).toBeUndefined();
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
    expect(wonFirst).toBe(true);
    const wonSecond = await store.tryClaimNudge(nudge({ dedupeKey: key, escalations: 99 }));
    expect(wonSecond).toBe(false);
    const persisted = await store.getNudgeByDedupeKey(key);
    expect(persisted?.escalations).toBe(1);
  });

  it("upgrades an existing shadow row to a real send (the go-live path)", async () => {
    const store = new D1Store(env.DB);
    const key = "u-1:o/r#shadow:review_requested";
    await store.upsertNudge(nudge({ dedupeKey: key, state: "shadow" }));
    const won = await store.tryClaimNudge(nudge({ dedupeKey: key, state: "sent" }));
    expect(won).toBe(true);
    const persisted = await store.getNudgeByDedupeKey(key);
    expect(persisted?.state).toBe("sent");
    const wonAgain = await store.tryClaimNudge(nudge({ dedupeKey: key, state: "sent" }));
    expect(wonAgain).toBe(false);
  });
});

describe("MergeRegistry.union (issue #8)", () => {
  it("merges two clusters to the lexicographically smaller winner and converges", async () => {
    const store = new D1Store(env.DB);
    const registryId = env.MERGE_REGISTRY.idFromName(MERGE_REGISTRY_KEY);
    const registry = env.MERGE_REGISTRY.get(registryId);

    const clusterA = await store.getOrCreateCluster("m/r#1");
    const clusterB = await store.getOrCreateCluster("m/r#2");
    const expectedWinner = clusterA < clusterB ? clusterA : clusterB;
    const expectedLoser = clusterA < clusterB ? clusterB : clusterA;

    const winner = await registry.union({ threadA: "m/r#1", threadB: "m/r#2" });
    expect(winner).toBe(expectedWinner);
    expect(await store.findCluster("m/r#1")).toBe(expectedWinner);
    expect(await store.findCluster("m/r#2")).toBe(expectedWinner);
    expect(await store.listClusterThreads(expectedLoser)).toEqual([]);

    const repeat = await registry.union({ threadA: "m/r#1", threadB: "m/r#2" });
    expect(repeat).toBe(expectedWinner);
  });

  it("is a no-op when both threads already share a cluster", async () => {
    const store = new D1Store(env.DB);
    const registry = env.MERGE_REGISTRY.get(env.MERGE_REGISTRY.idFromName(MERGE_REGISTRY_KEY));
    const shared = await store.getOrCreateCluster("m/r#same1");
    await store.repointCluster({
      fromClusterId: await store.getOrCreateCluster("m/r#same2"),
      toClusterId: shared,
    });
    const result = await registry.union({ threadA: "m/r#same1", threadB: "m/r#same2" });
    expect(result).toBe(shared);
    expect(await store.findCluster("m/r#same2")).toBe(shared);
  });
});
