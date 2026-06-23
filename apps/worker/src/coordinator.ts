import { DurableObject } from "cloudflare:workers";
import {
  evaluate,
  ingest,
  maintainCluster,
  Result,
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
    const maintained = await Result.from(() => maintainCluster(ctx, thread.nativeId));
    if (!maintained.ok) {
      console.error(`clustering failed for ${thread.nativeId}:`, maintained.error);
    }
    const cluster = maintained.ok ? maintained.data : undefined;
    if (cluster) {
      const synthesized = await Result.from(() => synthesizeCluster(ctx, cluster));
      if (!synthesized.ok) {
        console.error(`clustering failed for ${thread.nativeId}:`, synthesized.error);
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
}
