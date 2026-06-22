import { DurableObject } from "cloudflare:workers";
import { evaluate, ingest, route, synthesize, synthesizeCluster, type RawEvent } from "@aipm/core";
import { buildEngineContext } from "./context.js";
import type { Env } from "./env.js";

const MERGE_REGISTRY_KEY = "global";
const MAX_FORWARD_HOPS = 8;

/**
 * One Durable Object per CLUSTER id (issue #8). The whole body runs under
 * blockConcurrencyWhile so every event for a cluster is processed one at a time,
 * across the D1 awaits — the per-thread DO could not guarantee this because it
 * holds no DO storage, so its input gate reopened on every network await.
 */
export class ClusterCoordinator extends DurableObject<Env> {
  async process(args: { event: RawEvent; threadNativeId: string; clusterId: string; hop: number }) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const ctx = buildEngineContext(this.env, args.event);
      const store = ctx.store;

      const ownerBefore = await store.findCluster(args.threadNativeId);
      const movedBeforeIngest = ownerBefore !== undefined && ownerBefore !== args.clusterId;
      if (movedBeforeIngest) return this.forward(args, ownerBefore);

      const thread = await ingest(ctx, args.event);
      if (!thread) return;

      const links = await store.getLinks(thread.nativeId);
      for (const link of links) {
        const fromCluster = await store.getOrCreateCluster(link.from);
        const toCluster = await store.getOrCreateCluster(link.to);
        const crossesClusters = fromCluster !== toCluster;
        if (crossesClusters) {
          const registryId = this.env.MERGE_REGISTRY.idFromName(MERGE_REGISTRY_KEY);
          await this.env.MERGE_REGISTRY.get(registryId).union({ threadA: link.from, threadB: link.to });
        }
      }

      const ownerAfter = await store.findCluster(thread.nativeId);
      if (!ownerAfter) return;
      const mergedAway = ownerAfter !== args.clusterId;
      if (mergedAway) return this.forward(args, ownerAfter);

      const members = await store.listClusterThreads(args.clusterId);
      const cluster = members.length > 1 ? { id: args.clusterId, threadIds: members } : undefined;

      try {
        if (cluster) await synthesizeCluster(ctx, cluster);
      } catch (err) {
        console.error(`cluster synth failed for ${args.clusterId}:`, err);
      }
      if (thread.platform === "github") {
        try {
          await synthesize(ctx, thread, cluster);
        } catch (err) {
          console.error(`synthesize failed for ${thread.nativeId}:`, err);
        }
      }
      try {
        const signals = await evaluate(ctx, thread);
        await route(ctx, thread, signals);
      } catch (err) {
        console.error(`evaluate/route failed for ${thread.nativeId}:`, err);
      }
    });
  }

  async forward(
    args: { event: RawEvent; threadNativeId: string; clusterId: string; hop: number },
    target: string,
  ) {
    const overLimit = args.hop >= MAX_FORWARD_HOPS;
    if (overLimit) {
      console.error(`cluster forward hop limit for ${args.threadNativeId} -> ${target}`);
      return;
    }
    const id = this.env.CLUSTER_COORDINATOR.idFromName(target);
    await this.env.CLUSTER_COORDINATOR.get(id).process({
      event: args.event,
      threadNativeId: args.threadNativeId,
      clusterId: target,
      hop: args.hop + 1,
    });
  }
}
