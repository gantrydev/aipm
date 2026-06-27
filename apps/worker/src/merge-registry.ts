import { DurableObject } from "cloudflare:workers";
import { Ok } from "@aipm/core";
import { D1Store } from "@aipm/db";
import type { Env } from "./env.js";

/**
 * Global singleton (addressed by idFromName("global")). Serializes every cluster
 * merge under blockConcurrencyWhile so transitive merges can't interleave into a
 * split. Re-resolves both threads to their live cluster ids inside the lock.
 */
export class MergeRegistry extends DurableObject<Env> {
  async union(args: { threadA: string; threadB: string }) {
    const mergeResult = await this.ctx.blockConcurrencyWhile(async () => {
      const store = new D1Store(this.env.DB);
      const clusterAResult = await store.getOrCreateCluster(args.threadA);
      if (!clusterAResult.ok) return clusterAResult;
      const clusterA = clusterAResult.data;
      const clusterBResult = await store.getOrCreateCluster(args.threadB);
      if (!clusterBResult.ok) return clusterBResult;
      const clusterB = clusterBResult.data;
      if (clusterA === clusterB) return Ok(clusterA);
      const winner = clusterA < clusterB ? clusterA : clusterB;
      const loser = clusterA < clusterB ? clusterB : clusterA;
      const repointArgs = { fromClusterId: loser, toClusterId: winner };
      const repointResult = await store.repointCluster(repointArgs);
      if (!repointResult.ok) return repointResult;
      const deleteResult = await store.deleteCluster(loser);
      if (!deleteResult.ok) return deleteResult;
      return Ok(winner);
    });
    // RUNTIME-CRITICAL: DO retry on merge failure.
    if (!mergeResult.ok) throw mergeResult.error;
    return mergeResult.data;
  }
}
