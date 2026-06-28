// Slack id resolution (DESIGN §5): email/handle -> "U…"/"W…" id. The caller
// caches the result on Identity.handles.slack; an unresolved participant is
// never DM'd (digest-only) — that routing fallback is phase-3, not here.

import { asyncUnfold, Err, Ok, Result } from "@aipm/core";
import { z } from "zod";

export interface SlackResolveConfig {
  botToken: string;
  apiBaseUrl?: string; // default https://slack.com/api
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Max 429 retries before giving up (default 3). */
  maxRetries?: number;
}

const slackUserSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  deleted: z.boolean().optional(),
  is_bot: z.boolean().optional(),
  profile: z
    .object({
      display_name: z.string().optional(),
      display_name_normalized: z.string().optional(),
    })
    .optional(),
});

const slackEnvelopeSchema = z.object({ ok: z.boolean(), error: z.string().optional() });
const usersLookupByEmailSchema = slackEnvelopeSchema.extend({ user: slackUserSchema.optional() });
const usersListSchema = slackEnvelopeSchema.extend({
  members: z.array(slackUserSchema).optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});

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
  const res = await call(config, "users.lookupByEmail", { email }, usersLookupByEmailSchema);
  if (!res.ok) return res;
  if (res.data.ok) return Ok(res.data.user?.id);
  if (res.data.error === "users_not_found") return Ok(undefined); // gap: log upstream
  return Err(slackError(res.data.error));
}

async function lookupByHandle(
  config: SlackResolveConfig,
  handle: string,
): Promise<Result<string | undefined, Error>> {
  const seed = "";
  return asyncUnfold(seed, async (cursor) => {
    const listResult = await call(
      config,
      "users.list",
      { limit: "200", ...(cursor ? { cursor } : {}) },
      usersListSchema,
    );
    if (!listResult.ok) return { kind: "STOP" as const, value: listResult };
    const res = listResult.data;
    if (!res.ok) {
      const apiError = slackError(res.error);
      return { kind: "STOP" as const, value: Err(apiError) };
    }
    const members = res.members ?? [];
    const match = members.find((u) => {
      if (u.deleted || u.is_bot) return false;
      return (
        u.name === handle ||
        u.profile?.display_name === handle ||
        u.profile?.display_name_normalized === handle
      );
    });
    if (match) return { kind: "STOP" as const, value: Ok(match.id) };
    const nextCursor = res.response_metadata?.next_cursor;
    const next = nextCursor || undefined;
    if (next) return { kind: "CONTINUE" as const, next };
    return { kind: "STOP" as const, value: Ok(undefined) };
  });
}

async function call<S extends z.ZodType>(
  config: SlackResolveConfig,
  method: string,
  params: Record<string, string>,
  schema: S,
): Promise<Result<z.infer<S>, Error>> {
  const base = config.apiBaseUrl ?? DEFAULT_BASE;
  const url = `${base}/${method}?${new URLSearchParams(params).toString()}`;
  const doFetch = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = config.maxRetries ?? 3;

  const firstAttempt = 0;
  return asyncUnfold(firstAttempt, async (attempt) => {
    const fetched = await Result.from(() =>
      doFetch(url, {
        headers: { Authorization: `Bearer ${config.botToken}` },
      }),
    );
    if (!fetched.ok) return { kind: "STOP" as const, value: fetched };
    const res = fetched.data;
    const isRateLimited = res.status === 429;
    const hasRetriesLeft = attempt < maxRetries;
    const shouldRetry = isRateLimited && hasRetriesLeft;
    if (shouldRetry) {
      const retryAfterHeader = Number(res.headers.get("retry-after"));
      const retryAfter = retryAfterHeader || 1;
      const slept = await Result.from(() => sleep(retryAfter * 1000));
      if (!slept.ok) return { kind: "STOP" as const, value: slept };
      return { kind: "CONTINUE" as const, next: attempt + 1 };
    }
    const httpFailed = !res.ok;
    if (httpFailed) {
      const httpError = new Error(`Slack ${method} HTTP ${res.status}`);
      return { kind: "STOP" as const, value: Err(httpError) };
    }
    const parsed = await Result.from(() => res.json());
    if (!parsed.ok) return { kind: "STOP" as const, value: parsed };
    const validated = schema.safeParse(parsed.data);
    if (!validated.success) {
      const parseError = new Error(`Slack ${method}: ${validated.error.message}`);
      return { kind: "STOP" as const, value: Err(parseError) };
    }
    return { kind: "STOP" as const, value: Ok(validated.data) };
  });
}

const slackError = (error?: string): Error => {
  const msg = `Slack API error: ${error ?? "unknown"}`;
  return Object.assign(new Error(msg), { fatal: FATAL.has(error ?? "") });
};
