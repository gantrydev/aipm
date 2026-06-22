import { DurableObject } from "cloudflare:workers";
import { D1Store } from "@aipm/db";
import type { Env } from "./env.js";

/**
 * Global singleton (addressed by idFromName("global")). Serializes every cluster
 * merge under blockConcurrencyWhile so transitive merges can't interleave into a
 * split. Re-resolves both threads to their live cluster ids inside the lock.
 */
export class MergeRegistry extends DurableObject<Env> {
  async union(args: { threadA: string; threadB: string }) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const store = new D1Store(this.env.DB);
      const clusterA = await store.getOrCreateCluster(args.threadA);
      const clusterB = await store.getOrCreateCluster(args.threadB);
      if (clusterA === clusterB) return clusterA;
      const winner = clusterA < clusterB ? clusterA : clusterB;
      const loser = clusterA < clusterB ? clusterB : clusterA;
      await store.repointCluster({ fromClusterId: loser, toClusterId: winner });
      await store.deleteCluster(loser);
      return winner;
    });
  }
}
