import type { RawEvent } from "@aipm/core";
import type { ThreadCoordinator } from "./coordinator.js";

/** Bindings declared in wrangler.jsonc, plus secrets (set via `wrangler secret`). */
export interface Env {
  // bindings
  DB: D1Database;
  DELIVERY_DEDUPE: KVNamespace;
  INSTALL_TOKENS: KVNamespace;
  INGEST_QUEUE: Queue<RawEvent>;
  THREAD_COORDINATOR: DurableObjectNamespace<ThreadCoordinator>;
  AI: Ai;

  // vars
  SHADOW_GLOBAL: string;
  /** Per-capability shadow overrides ("false" = go live for that capability). */
  SHADOW_WORKING_NOTES?: string;
  SHADOW_NUDGES?: string;
  SHADOW_DIGEST?: string;
  SHADOW_PROPOSALS?: string;
  AI_GATEWAY_ID: string;
  /** GitHub App client id (or numeric App id) — the JWT `iss`. */
  GITHUB_APP_CLIENT_ID: string;

  // secrets (DESIGN §9)
  /** PKCS#8 PEM ("BEGIN PRIVATE KEY"); convert GitHub's PKCS#1 download first. */
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  /** Identity roster JSON array (DESIGN §5); see @aipm/core configIdentitySource. */
  IDENTITY_ROSTER?: string;
  /** Cron sweep targets: JSON `[{owner,repo,installationId}]` (DESIGN §10.1). */
  SWEEP_REPOS?: string;
}
