import { GitHubAdapter, installationTokenProvider } from "@aipm/adapter-github";
import { SlackAdapter } from "@aipm/adapter-slack";
import { BudgetedLlmAdapter, EchoLlmAdapter, WorkersAiLlmAdapter } from "@aipm/adapter-llm";
import { buildConfig } from "@aipm/config";
import {
  configIdentitySource,
  systemClock,
  type EngineContext,
  type LlmAdapter,
  type Platform,
  type PlatformId,
  type RawEvent,
} from "@aipm/core";
import { D1Store } from "@aipm/db";
import type { Env } from "./env.js";

const DEFAULT_MODEL = "@cf/openai/gpt-oss-120b";
const DEFAULT_LLM_TIMEOUT_MS = 30_000;

/**
 * Assemble an EngineContext for one event inside the thread DO. The GitHub
 * adapter is built per-event because the installation (and thus token) varies;
 * this keeps token scoping correct (DESIGN §6).
 */
export function buildEngineContext(env: Env, event: RawEvent): EngineContext {
  // Fail safe: shadow stays ON unless explicitly disabled with "false", both
  // globally and per capability — so a capability goes live only when its var is
  // exactly "false" (DESIGN §8/§10 staged rollout).
  const cap = (v: string | undefined) => (v === undefined ? undefined : v !== "false");
  const config = buildConfig({
    llmJudge: env.LLM_JUDGE === "true",
    notesPrompt: promptVar(env.NOTES_PROMPT),
    clusterPrompt: promptVar(env.CLUSTER_PROMPT),
    shadow: {
      global: env.SHADOW_GLOBAL !== "false",
      capabilities: {
        workingNotes: cap(env.SHADOW_WORKING_NOTES),
        nudges: cap(env.SHADOW_NUDGES),
        digest: cap(env.SHADOW_DIGEST),
        proposals: cap(env.SHADOW_PROPOSALS),
        orgRollup: cap(env.SHADOW_ORG_ROLLUP),
      },
    },
  });
  const store = new D1Store(env.DB);

  const platforms = new Map<PlatformId, Platform>();
  platforms.set("github", buildGitHubAdapter(env, event, config.botAccounts));
  if (env.SLACK_BOT_TOKEN) {
    platforms.set("slack", new SlackAdapter({ botToken: env.SLACK_BOT_TOKEN }));
  }

  const baseLlm: LlmAdapter = env.AI
    ? new WorkersAiLlmAdapter({
        ai: env.AI,
        model: env.AI_MODEL || DEFAULT_MODEL,
        gatewayId: env.AI_GATEWAY_ID,
        // gpt-oss is a reasoning model: reasoning shares the token budget, so
        // give the final message ample headroom or it can come back empty.
        defaultMaxTokens: 4000,
        requestTimeoutMs: intVar(env.LLM_REQUEST_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS),
      })
    : new EchoLlmAdapter();

  // Hard ceiling on LLM spend (bug/abuse backstop). Counters live in the
  // delivery-dedupe KV — both are the "short-lived flags" store (DESIGN §9) — under
  // a distinct `llm:budget:` key prefix. A non-positive budget disables that window.
  const llm: LlmAdapter = new BudgetedLlmAdapter(baseLlm, {
    store: {
      get: (k) => env.DELIVERY_DEDUPE.get(k),
      put: (k, v, o) => env.DELIVERY_DEDUPE.put(k, v, o),
    },
    perMinute: intVar(env.LLM_PER_MINUTE_BUDGET, 60),
    perDay: intVar(env.LLM_DAILY_BUDGET, 1000),
  });

  return {
    store,
    platforms,
    identities: configIdentitySource(env.IDENTITY_ROSTER ?? "[]"),
    llm,
    config,
    clock: systemClock,
  };
}

/**
 * Parse an integer Worker var, falling back to the default on a missing, blank,
 * or non-integer value — so a blank var can't silently disable a budget window
 * (Number("") is 0). Use "0" explicitly to disable a window.
 */
function intVar(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^-?\d+$/.test(raw.trim())) return fallback;
  return Number(raw.trim());
}

/**
 * Normalize a prompt-override var: undefined when unset or blank (so the schema
 * default takes over), otherwise the trimmed instruction text.
 */
function promptVar(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function buildGitHubAdapter(env: Env, event: RawEvent, botAccounts: string[]): GitHubAdapter {
  const token =
    env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_CLIENT_ID && event.installationId != null
      ? installationTokenProvider({
          kv: env.INSTALL_TOKENS,
          privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
          clientId: env.GITHUB_APP_CLIENT_ID,
          installationId: event.installationId,
        })
      : () => Promise.reject(new Error("GitHub App credentials/installation id missing"));

  return new GitHubAdapter({ token, botAccounts });
}
