import { DurableObject } from "cloudflare:workers";
import { ingest, type RawEvent } from "@aipm/core";
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
    await ingest(ctx, event);
    // TODO(phase-2/3): evaluate -> synthesize -> route after ingest lands.
  }
}
