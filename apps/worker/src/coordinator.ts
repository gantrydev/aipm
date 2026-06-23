import { DurableObject } from "cloudflare:workers";
import {
  evaluate,
  ingest,
  Result,
  route,
  synthesize,
  synthesizeCluster,
  type RawEvent,
} from "@aipm/core";
import { buildEngineContext } from "./context.js";
import type { Env } from "./env.js";

const MERGE_REGISTRY_KEY = "global";
const MAX_FORWARD_HOPS = 8;

/**
 * One Durable Object per CLUSTER id (issue #8). Events for a cluster are chained
 * through an instance-local queue so long network/LLM work does not sit inside
 * blockConcurrencyWhile, which Cloudflare cancels after a short wait.
 */
export class ClusterCoordinator extends DurableObject<Env> {
  private processing: Promise<void> = Promise.resolve();

  async process(args: { event: RawEvent; threadNativeId: string; clusterId: string; hop: number }) {
    const current = this.processing.catch(() => undefined).then(() => this.processOne(args));
    this.processing = current.catch(() => undefined);
    await current;
  }

  private async processOne(args: {
    event: RawEvent;
    threadNativeId: string;
    clusterId: string;
    hop: number;
  }) {
    const ctx = buildEngineContext(this.env, args.event);
    const store = ctx.store;

    const ownerBefore = await store.findCluster(args.threadNativeId);
    const movedBeforeIngest = ownerBefore !== undefined && ownerBefore !== args.clusterId;
    if (movedBeforeIngest) return this.forward(args, ownerBefore);

    const thread = await ingest(ctx, args.event);
    if (!thread) return;

    const links = await store.getLinks(thread.nativeId);
    const ownCluster = await store.getOrCreateCluster(thread.nativeId);
    for (const link of links) {
      const counterpart = link.from === thread.nativeId ? link.to : link.from;
      const counterpartCluster = await store.getOrCreateCluster(counterpart);
      const crossesClusters = ownCluster !== counterpartCluster;
      if (crossesClusters) {
        const registryId = this.env.MERGE_REGISTRY.idFromName(MERGE_REGISTRY_KEY);
        await this.env.MERGE_REGISTRY.get(registryId).union({
          threadA: thread.nativeId,
          threadB: counterpart,
        });
      }
    }

    const ownerAfter = await store.findCluster(thread.nativeId);
    if (!ownerAfter) return;
    const mergedAway = ownerAfter !== args.clusterId;
    if (mergedAway) return this.forward(args, ownerAfter);

    const members = await store.listClusterThreads(args.clusterId);
    const cluster = members.length > 1 ? { id: args.clusterId, threadIds: members } : undefined;

    if (cluster) {
      const synthesized = await Result.from(() => synthesizeCluster(ctx, cluster));
      if (!synthesized.ok) {
        console.error(`cluster synth failed for ${args.clusterId}:`, synthesized.error);
      }
    }
    if (thread.platform === "github") {
      const synthesizedThread = await Result.from(() => synthesize(ctx, thread, cluster));
      if (!synthesizedThread.ok) {
        console.error(`synthesize failed for ${thread.nativeId}:`, synthesizedThread.error);
      }
    }
    const routed = await Result.from(async () => {
      const signals = await evaluate(ctx, thread);
      await route(ctx, thread, signals);
    });
    if (!routed.ok) {
      console.error(`evaluate/route failed for ${thread.nativeId}:`, routed.error);
    }
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
