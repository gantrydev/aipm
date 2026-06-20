// Slack id resolution (DESIGN §5): email/handle -> "U…"/"W…" id. The caller
// caches the result on Identity.handles.slack; an unresolved participant is
// never DM'd (digest-only) — that routing fallback is phase-3, not here.

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
): Promise<string | undefined> {
  if (query.email) {
    const byEmail = await lookupByEmail(config, query.email);
    if (byEmail) return byEmail;
  }
  if (query.handle) return lookupByHandle(config, query.handle);
  return undefined;
}

async function lookupByEmail(
  config: SlackResolveConfig,
  email: string,
): Promise<string | undefined> {
  const res = await call<{ user?: SlackUser }>(config, "users.lookupByEmail", { email });
  if (res.ok) return res.user?.id;
  if (res.error === "users_not_found") return undefined; // gap: log upstream
  throw slackError(res.error);
}

async function lookupByHandle(
  config: SlackResolveConfig,
  handle: string,
): Promise<string | undefined> {
  let cursor: string | undefined;
  do {
    const res = await call<{ members?: SlackUser[]; response_metadata?: { next_cursor?: string } }>(
      config,
      "users.list",
      { limit: "200", ...(cursor ? { cursor } : {}) },
    );
    if (!res.ok) throw slackError(res.error);
    for (const u of res.members ?? []) {
      if (u.deleted || u.is_bot) continue;
      if (
        u.name === handle ||
        u.profile?.display_name === handle ||
        u.profile?.display_name_normalized === handle
      ) {
        return u.id;
      }
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return undefined;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
}

async function call<T>(
  config: SlackResolveConfig,
  method: string,
  params: Record<string, string>,
): Promise<SlackResponse & T> {
  const base = config.apiBaseUrl ?? DEFAULT_BASE;
  const url = `${base}/${method}?${new URLSearchParams(params).toString()}`;
  const doFetch = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = config.maxRetries ?? 3;

  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(url, { headers: { Authorization: `Bearer ${config.botToken}` } });
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after")) || 1;
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}`);
    return (await res.json()) as SlackResponse & T;
  }
}

const slackError = (error?: string): Error => {
  const msg = `Slack API error: ${error ?? "unknown"}`;
  return Object.assign(new Error(msg), { fatal: FATAL.has(error ?? "") });
};
