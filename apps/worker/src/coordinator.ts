import { DurableObject } from "cloudflare:workers";
import {
  evaluate,
  ingest,
  maintainCluster,
  route,
  synthesize,
  synthesizeCluster,
  type RawEvent,
} from "@aipm/core";
import { buildEngineContext } from "./context.js";
import type { Env } from "./env.js";

/**
 * One Durable Object per thread serializes updates so concurrent events can't
 * double-nudge (DESIGN §6). Routed by idFromName(`${platform}:${nativeId}`).
 */
export class ThreadCoordinator extends DurableObject<Env> {
  /** Process one normalized event under the DO's single-threaded lock. */
  async process(event: RawEvent): Promise<void> {
    const ctx = buildEngineContext(this.env, event);
    const thread = await ingest(ctx, event);
    if (!thread) return;

    // Notes + nudges are suggest-only and best-effort: a failure here must not
    // undo the (already-persisted) ingest or force a full re-ingest on retry.
    // Sticky working-notes are posted on GitHub only; Slack threads are ingested
    // for clustering + signals, not annotated in-channel (avoids noise).

    // Cluster first so the cluster note is fresh, then the issue note can fold
    // its cross-thread summary in (DESIGN §8).
    let cluster;
    try {
      cluster = await maintainCluster(ctx, thread.nativeId);
      if (cluster) await synthesizeCluster(ctx, cluster);
    } catch (err) {
      console.error(`clustering failed for ${thread.nativeId}:`, err);
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
  }
}
