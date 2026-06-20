import { DurableObject } from "cloudflare:workers";
import { ingest, synthesize, type RawEvent } from "@aipm/core";
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

    // Notes are suggest-only and best-effort: a synthesis failure must not undo
    // the (already-persisted) ingest or force a full re-ingest on retry.
    try {
      await synthesize(ctx, thread);
    } catch (err) {
      console.error(`synthesize failed for ${thread.nativeId}:`, err);
    }
    // TODO(phase-3): evaluate -> route (signals + nudges) after synthesize.
  }
}
