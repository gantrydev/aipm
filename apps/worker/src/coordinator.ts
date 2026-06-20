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
    try {
      await synthesize(ctx, thread);
    } catch (err) {
      console.error(`synthesize failed for ${thread.nativeId}:`, err);
    }
    try {
      const signals = await evaluate(ctx, thread);
      await route(ctx, thread, signals);
    } catch (err) {
      console.error(`evaluate/route failed for ${thread.nativeId}:`, err);
    }
    try {
      const cluster = await maintainCluster(ctx, thread.nativeId);
      if (cluster) await synthesizeCluster(ctx, cluster, thread.platform);
    } catch (err) {
      console.error(`clustering failed for ${thread.nativeId}:`, err);
    }
  }
}
