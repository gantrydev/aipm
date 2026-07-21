import type { ClusterCoordinator } from "./coordinator.js";
import type { MergeRegistry } from "./merge-registry.js";
import type { WorkspaceIngestMessage } from "./messages.js";

/** Bindings declared in wrangler.jsonc, plus secrets (set via `wrangler secret`). */
export interface Env {
  // bindings
  DB: D1Database;
  /** Webhook delivery-id dedupe + other short-lived flags incl. LLM budget counters. */
  DELIVERY_DEDUPE: KVNamespace;
  INSTALL_TOKENS: KVNamespace;
  INGEST_QUEUE: Queue<WorkspaceIngestMessage>;
  CLUSTER_COORDINATOR: DurableObjectNamespace<ClusterCoordinator>;
  MERGE_REGISTRY: DurableObjectNamespace<MergeRegistry>;
  /** Optional: absent in environments (e.g. local/test) without the AI binding configured. */
  AI?: Ai;

  // vars
  SHADOW_GLOBAL: string;
  /** "false" disables the member-trigger gate (process everyone). Default on. */
  REQUIRE_MEMBER_TRIGGER?: string;
  /** Max LLM calls per UTC minute before the budget cap trips. Default 60. */
  LLM_PER_MINUTE_BUDGET?: string;
  /** Max LLM calls per UTC day before the budget cap trips. Default 1000. */
  LLM_DAILY_BUDGET?: string;
  /** Deployment-wide LLM hard ceilings. These counters contain no tenant data. */
  GLOBAL_LLM_PER_MINUTE_HARD_CEILING?: string;
  GLOBAL_LLM_DAILY_HARD_CEILING?: string;
  /** Unpublished tenant ingress and deployment-wide hard ceilings. */
  TENANT_RATE_PER_MINUTE_CEILING?: string;
  GLOBAL_RATE_PER_MINUTE_HARD_CEILING?: string;
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
  /** Public Worker origin used for OAuth callback URLs, e.g. https://api.thepm.dev. */
  PUBLIC_BASE_URL?: string;
  /** Site origin for post-login redirects and CORS, e.g. https://thepm.dev. */
  SITE_ORIGIN?: string;
  /** GitHub App slug for install deep-links. */
  GITHUB_APP_SLUG?: string;

  // secrets (DESIGN §9)
  /** PKCS#8 PEM ("BEGIN PRIVATE KEY"); convert GitHub's PKCS#1 download first. */
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  /** GitHub App OAuth client secret (user-to-server login). */
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  /** Shared managed deployments disable legacy single-token Slack ingress. */
  MANAGED_MODE?: string;
  /** Identity roster JSON array (DESIGN §5); see @aipm/core configIdentitySource. */
  IDENTITY_ROSTER?: string;
  /** Cron sweep targets: JSON `[{owner,repo,installationId}]` (DESIGN §10.1). */
  SWEEP_REPOS?: string;
}
