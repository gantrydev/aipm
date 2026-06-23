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
const WORK_PREFIX = "work:";
const MAX_ATTEMPTS = 3;

type ClusterWorkArgs = {
  event: RawEvent;
  threadNativeId: string;
  clusterId: string;
  hop: number;
};

interface ClusterWorkItem {
  args: ClusterWorkArgs;
  attempts: number;
  enqueuedAt: string;
}

/**
 * One Durable Object per CLUSTER id (issue #8). `process` persists incoming
 * work and an alarm drains one item at a time, so cluster ordering survives DO
 * resets without putting long network/LLM work inside blockConcurrencyWhile.
 */
export class ClusterCoordinator extends DurableObject<Env> {
  private draining: Promise<void> | undefined;

  async process(args: ClusterWorkArgs) {
    const key = `${WORK_PREFIX}${Date.now().toString().padStart(13, "0")}:${crypto.randomUUID()}`;
    await this.ctx.storage.put<ClusterWorkItem>(key, {
      args,
      attempts: 0,
      enqueuedAt: new Date().toISOString(),
    });
    await this.scheduleDrain();
  }

  override async alarm() {
    if (this.draining) return this.draining;
    this.draining = this.drainOne().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async scheduleDrain() {
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async drainOne() {
    const next = await this.nextWork();
    if (!next) return;

    const { key, item } = next;
    await this.ctx.storage.put<ClusterWorkItem>(key, {
      ...item,
      attempts: item.attempts + 1,
    });

    const processed = await Result.from(() => this.processOne(item.args));
    if (processed.ok) {
      await this.ctx.storage.delete(key);
    } else if (item.attempts + 1 >= MAX_ATTEMPTS) {
      console.error(
        `cluster work failed permanently for ${item.args.threadNativeId}:`,
        processed.error,
      );
      await this.ctx.storage.delete(key);
    } else {
      console.error(`cluster work failed for ${item.args.threadNativeId}:`, processed.error);
      await this.scheduleDrain();
      return;
    }

    if (await this.hasWork()) await this.scheduleDrain();
  }

  private async nextWork(): Promise<{ key: string; item: ClusterWorkItem } | undefined> {
    const items = await this.ctx.storage.list<ClusterWorkItem>({ prefix: WORK_PREFIX, limit: 1 });
    const first = items.entries().next().value as [string, ClusterWorkItem] | undefined;
    return first ? { key: first[0], item: first[1] } : undefined;
  }

  private async hasWork(): Promise<boolean> {
    const items = await this.ctx.storage.list<ClusterWorkItem>({ prefix: WORK_PREFIX, limit: 1 });
    return items.size > 0;
  }

  private async processOne(args: ClusterWorkArgs) {
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

  async forward(args: ClusterWorkArgs, target: string) {
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
