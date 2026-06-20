import { GitHubAdapter, installationTokenProvider } from "@aipm/adapter-github";
import { SlackAdapter } from "@aipm/adapter-slack";
import { EchoLlmAdapter, WorkersAiLlmAdapter } from "@aipm/adapter-llm";
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
    shadow: {
      global: env.SHADOW_GLOBAL !== "false",
      capabilities: {
        workingNotes: cap(env.SHADOW_WORKING_NOTES),
        nudges: cap(env.SHADOW_NUDGES),
        digest: cap(env.SHADOW_DIGEST),
        proposals: cap(env.SHADOW_PROPOSALS),
      },
    },
  });
  const store = new D1Store(env.DB);

  const platforms = new Map<PlatformId, Platform>();
  platforms.set("github", buildGitHubAdapter(env, event, config.botAccounts));
  if (env.SLACK_BOT_TOKEN) {
    platforms.set("slack", new SlackAdapter({ botToken: env.SLACK_BOT_TOKEN }));
  }

  const llm: LlmAdapter = env.AI
    ? new WorkersAiLlmAdapter({
        ai: env.AI,
        model: env.AI_MODEL || DEFAULT_MODEL,
        gatewayId: env.AI_GATEWAY_ID,
      })
    : new EchoLlmAdapter();

  return {
    store,
    platforms,
    identities: configIdentitySource(env.IDENTITY_ROSTER ?? "[]"),
    llm,
    config,
    clock: systemClock,
  };
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
