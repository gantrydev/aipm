import type { RawEvent } from "@aipm/core";
import type { ClusterCoordinator } from "./coordinator.js";
import type { MergeRegistry } from "./merge-registry.js";

/** Bindings declared in wrangler.jsonc, plus secrets (set via `wrangler secret`). */
export interface Env {
  // bindings
  DB: D1Database;
  /** Webhook delivery-id dedupe + other short-lived flags incl. LLM budget counters. */
  DELIVERY_DEDUPE: KVNamespace;
  INSTALL_TOKENS: KVNamespace;
  INGEST_QUEUE: Queue<RawEvent>;
  CLUSTER_COORDINATOR: DurableObjectNamespace<ClusterCoordinator>;
  MERGE_REGISTRY: DurableObjectNamespace<MergeRegistry>;
  AI: Ai;

  // vars
  SHADOW_GLOBAL: string;
  /** "false" disables the member-trigger gate (process everyone). Default on. */
  REQUIRE_MEMBER_TRIGGER?: string;
  /** Max LLM calls per UTC minute before the budget cap trips. Default 60. */
  LLM_PER_MINUTE_BUDGET?: string;
  /** Max LLM calls per UTC day before the budget cap trips. Default 1000. */
  LLM_DAILY_BUDGET?: string;
  /** Hard wall-clock bound (ms) on one LLM completion under the cluster lock. Default 30000. */
  LLM_REQUEST_TIMEOUT_MS?: string;
  /** Per-capability shadow overrides ("false" = go live for that capability). */
  SHADOW_WORKING_NOTES?: string;
  SHADOW_NUDGES?: string;
  SHADOW_DIGEST?: string;
  SHADOW_PROPOSALS?: string;
  SHADOW_ORG_ROLLUP?: string;
  /** Slack channel id for the daily org pulse. Missing means compute/store only. */
  ORG_ROLLUP_CHANNEL_ID?: string;
  AI_GATEWAY_ID: string;
  /** Workers AI model id; defaults to @cf/openai/gpt-oss-120b. */
  AI_MODEL?: string;
  /** "true" enables LLM-judged reply checks (mentioned_no_response). */
  LLM_JUDGE?: string;
  /** Working-notes system prompt; unset/blank falls back to the built-in default. */
  NOTES_PROMPT?: string;
  /** Cluster-summary system prompt; unset/blank falls back to the built-in default. */
  CLUSTER_PROMPT?: string;
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
