import { DurableObject } from "cloudflare:workers";
import { Result, unwrap } from "@aipm/core";
import { D1Store } from "@aipm/db";
import type { Env } from "./env.js";

/**
 * Global singleton (addressed by idFromName("global")). Serializes every cluster
 * merge under blockConcurrencyWhile so transitive merges can't interleave into a
 * split. Re-resolves both threads to their live cluster ids inside the lock.
 */
export class MergeRegistry extends DurableObject<Env> {
  async union(args: { threadA: string; threadB: string }) {
    const merged = await Result.from(() =>
      this.ctx.blockConcurrencyWhile(async () => {
        const store = new D1Store(this.env.DB);
        const clusterA = unwrap(await store.getOrCreateCluster(args.threadA));
        const clusterB = unwrap(await store.getOrCreateCluster(args.threadB));
        if (clusterA === clusterB) return clusterA;
        const winner = clusterA < clusterB ? clusterA : clusterB;
        const loser = clusterA < clusterB ? clusterB : clusterA;
        unwrap(await store.repointCluster({ fromClusterId: loser, toClusterId: winner }));
        unwrap(await store.deleteCluster(loser));
        return winner;
      }),
    );
    // RUNTIME-CRITICAL: DO retry on merge failure.
    if (!merged.ok) throw merged.error;
    return merged.data;
  }
}
