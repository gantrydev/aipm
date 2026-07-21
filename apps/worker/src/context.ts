import { GitHubAdapter, installationTokenProvider } from "@aipm/adapter-github";
import { SlackAdapter } from "@aipm/adapter-slack";
import { EchoLlmAdapter, WorkersAiLlmAdapter } from "@aipm/adapter-llm";
import {
  configIdentitySource,
  Err,
  Ok,
  Result,
  systemClock,
  type EngineConfig,
  type EngineContext,
  type LlmAdapter,
  type Platform,
  type PlatformId,
  type RawEvent,
} from "@aipm/core";
import { createWorkspaceStore, LEGACY_WORKSPACE_ID, type WorkspaceId } from "@aipm/db";
import type { Env } from "./env.js";
import { workspaceAudit } from "./tenancy/audit.js";
import { createWorkspaceBudgetedLlm } from "./tenancy/budgets.js";
import { buildConfigFromEnv, loadStoredWorkspaceConfig } from "./tenancy/config.js";
import { workspaceInstallTokenKv } from "./tenancy/kv.js";

const DEFAULT_MODEL = "@cf/openai/gpt-oss-120b";
const DEFAULT_LLM_TIMEOUT_MS = 30_000;

/**
 * Assemble an EngineContext for one event inside the thread DO. Loads
 * workspace_config when present; otherwise falls back to deployment env vars
 * (legacy self-host path).
 */
export async function buildEngineContext(
  env: Env,
  event: RawEvent,
  workspaceId: WorkspaceId = LEGACY_WORKSPACE_ID,
): Promise<Result<EngineContext, Error>> {
  const configResult = await loadWorkspaceEngineConfig(env, workspaceId);
  if (!configResult.ok) return configResult;
  const config = configResult.data;
  const identitiesResult = configIdentitySource(env.IDENTITY_ROSTER ?? "[]");
  if (!identitiesResult.ok) return identitiesResult;
  const store = createWorkspaceStore(env.DB, workspaceId);

  const platforms = new Map<PlatformId, Platform>();
  platforms.set("github", buildGitHubAdapter(env, event, workspaceId, config.botAccounts));
  // A deployment-global Slack token is legacy self-host configuration. Managed
  // workspaces stay GitHub-only until workspace-scoped Slack OAuth is shipped.
  if (workspaceId === LEGACY_WORKSPACE_ID && env.SLACK_BOT_TOKEN) {
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

  const llm: LlmAdapter = createWorkspaceBudgetedLlm(baseLlm, env, workspaceId);
  const audit = workspaceAudit(env, workspaceId);

  return Ok({
    store,
    platforms,
    identities: identitiesResult.data,
    llm,
    config,
    clock: systemClock,
    audit: {
      record: (entry) =>
        audit.append({
          action: entry.action,
          outcome: entry.outcome,
          actor: { source: "worker", kind: "service" },
          ...(entry.repositoryId === undefined ? {} : { repositoryId: entry.repositoryId }),
          detail: entry.detail,
        }),
    },
  });
}

async function loadWorkspaceEngineConfig(
  env: Env,
  workspaceId: WorkspaceId,
): Promise<Result<EngineConfig, Error>> {
  const stored = await loadStoredWorkspaceConfig(env, workspaceId);
  if (!stored.ok) return stored;
  if (stored.data) return Ok(stored.data);
  return buildConfigFromEnv(env);
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

function buildGitHubAdapter(
  env: Env,
  event: RawEvent,
  workspaceId: WorkspaceId,
  botAccounts: Array<string>,
): GitHubAdapter {
  const token =
    env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_CLIENT_ID && event.installationId != null
      ? installationTokenProvider({
          kv: workspaceInstallTokenKv(env.INSTALL_TOKENS, workspaceId),
          privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
          clientId: env.GITHUB_APP_CLIENT_ID,
          installationId: event.installationId,
        })
      : () => Promise.resolve(Err(new Error("GitHub App credentials/installation id missing")));

  return new GitHubAdapter({ token, botAccounts });
}
