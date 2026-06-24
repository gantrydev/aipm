// Slack id resolution (DESIGN §5): email/handle -> "U…"/"W…" id. The caller
// caches the result on Identity.handles.slack; an unresolved participant is
// never DM'd (digest-only) — that routing fallback is phase-3, not here.

import { asyncUnfold, Err, Ok, Result, unwrap } from "@aipm/core";

export interface SlackResolveConfig {
  botToken: string;
  apiBaseUrl?: string; // default https://slack.com/api
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Max 429 retries before giving up (default 3). */
  maxRetries?: number;
}

interface SlackUser {
  id: string;
  name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { display_name?: string; display_name_normalized?: string };
}

const DEFAULT_BASE = "https://slack.com/api";
const FATAL = new Set(["missing_scope", "invalid_auth", "account_inactive", "token_revoked"]);

export async function resolveSlackId(
  config: SlackResolveConfig,
  query: { email?: string; handle?: string },
): Promise<Result<string | undefined, Error>> {
  if (query.email) {
    const byEmail = await lookupByEmail(config, query.email);
    if (!byEmail.ok) return byEmail;
    if (byEmail.data) return Ok(byEmail.data);
  }
  if (query.handle) return lookupByHandle(config, query.handle);
  return Ok(undefined);
}

async function lookupByEmail(
  config: SlackResolveConfig,
  email: string,
): Promise<Result<string | undefined, Error>> {
  const res = await call<{ user?: SlackUser }>(config, "users.lookupByEmail", { email });
  if (!res.ok) return res;
  if (res.data.ok) return Ok(res.data.user?.id);
  if (res.data.error === "users_not_found") return Ok(undefined); // gap: log upstream
  // Preserve the existing fail-fast semantics for Slack identity API errors.
  return Err(slackError(res.data.error));
}

async function lookupByHandle(
  config: SlackResolveConfig,
  handle: string,
): Promise<Result<string | undefined, Error>> {
  const seed: string | undefined = undefined;
  const looped = await Result.from(() =>
    asyncUnfold(seed, async (cursor: string | undefined) => {
      const res = unwrap(
        await call<{
          members?: SlackUser[];
          response_metadata?: { next_cursor?: string };
        }>(config, "users.list", { limit: "200", ...(cursor ? { cursor } : {}) }),
      );
      // Preserve the existing fail-fast semantics for Slack identity API errors.
      if (!res.ok) throw slackError(res.error);
      const match = (res.members ?? []).find((u) => {
        if (u.deleted || u.is_bot) return false;
        return (
          u.name === handle ||
          u.profile?.display_name === handle ||
          u.profile?.display_name_normalized === handle
        );
      });
      if (match) return { kind: "STOP" as const, value: match.id };
      const next = res.response_metadata?.next_cursor || undefined;
      if (next) return { kind: "CONTINUE" as const, next };
      return { kind: "STOP" as const, value: undefined };
    }),
  );
  if (!looped.ok) return looped;
  return Ok(looped.data);
}

interface SlackResponse {
  ok: boolean;
  error?: string;
}

async function call<T>(
  config: SlackResolveConfig,
  method: string,
  params: Record<string, string>,
): Promise<Result<SlackResponse & T, Error>> {
  const base = config.apiBaseUrl ?? DEFAULT_BASE;
  const url = `${base}/${method}?${new URLSearchParams(params).toString()}`;
  const doFetch = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = config.maxRetries ?? 3;

  const firstAttempt = 0;
  const looped = await Result.from(() =>
    asyncUnfold(firstAttempt, async (attempt) => {
      const fetched = await Result.from(() =>
        doFetch(url, {
          headers: { Authorization: `Bearer ${config.botToken}` },
        }),
      );
      const res = unwrap(fetched);
      const shouldRetry = res.status === 429 && attempt < maxRetries;
      if (shouldRetry) {
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
        const slept = await Result.from(() => sleep(retryAfter * 1000));
        unwrap(slept);
        return { kind: "CONTINUE" as const, next: attempt + 1 };
      }
      if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}`);
      const parsed = await Result.from(() => res.json());
      const body = unwrap(parsed) as SlackResponse & T;
      return { kind: "STOP" as const, value: body };
    }),
  );
  if (!looped.ok) return looped;
  return Ok(looped.data);
}

const slackError = (error?: string): Error => {
  const msg = `Slack API error: ${error ?? "unknown"}`;
  return Object.assign(new Error(msg), { fatal: FATAL.has(error ?? "") });
};
