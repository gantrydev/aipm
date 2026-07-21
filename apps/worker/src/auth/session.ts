import { Err, Ok, Result } from "@aipm/core";
import {
  createSession,
  deleteSession,
  getSession,
  upsertUserFromGithub,
  type UserRow,
} from "@aipm/db";
import type { DbEnv } from "../tenancy/guards.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export const SESSION_COOKIE = "aipm_session";
export const OAUTH_STATE_COOKIE = "aipm_oauth_state";

export const hashToken = async (token: string): Promise<string> => {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const mintOpaqueToken = (): string =>
  crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

export const createUserSession = async (
  env: DbEnv,
  user: { githubUserId: number; githubLogin: string; userId?: string },
): Promise<Result<{ token: string; expiresAt: string; user: UserRow }, Error>> => {
  const userId = user.userId ?? crypto.randomUUID();
  const upserted = await upsertUserFromGithub(env.DB, user.githubUserId, user.githubLogin, userId);
  if (!upserted.ok) return upserted;
  const token = mintOpaqueToken();
  const idHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const created = await createSession(env.DB, idHash, upserted.data.id, expiresAt);
  if (!created.ok) return created;
  return Ok({ token, expiresAt, user: upserted.data });
};

export const resolveSessionToken = async (
  env: DbEnv,
  token: string | undefined,
): Promise<Result<{ userId: string; githubLogin: string } | undefined, Error>> => {
  if (!token) return Ok(undefined);
  const idHash = await hashToken(token);
  const session = await getSession(env.DB, idHash);
  if (!session.ok) return session;
  if (!session.data) return Ok(undefined);
  if (Date.parse(session.data.expiresAt) <= Date.now()) {
    const cleared = await deleteSession(env.DB, idHash);
    if (!cleared.ok) return cleared;
    return Ok(undefined);
  }
  return Ok({
    userId: session.data.userId,
    githubLogin: session.data.githubLogin,
  });
};

export const revokeSessionToken = async (
  env: DbEnv,
  token: string | undefined,
): Promise<Result<void, Error>> => {
  if (!token) return Ok(undefined);
  const idHash = await hashToken(token);
  return deleteSession(env.DB, idHash);
};

/** Payload stored server-side for an OAuth login; the client only sees an opaque token. */
export interface OAuthState {
  readonly returnTo?: string;
  readonly issuedAt: number;
}

const oauthStateKey = (token: string) => `oauth:state:${token}`;

/**
 * Mint an opaque OAuth `state` token and persist `{ returnTo, issuedAt }` in KV
 * with a short TTL. The token itself carries no client-readable payload.
 */
export const mintOAuthState = async (
  kv: KVNamespace,
  returnTo?: string,
): Promise<Result<{ token: string }, Error>> => {
  const token = mintOpaqueToken();
  const state: OAuthState = {
    issuedAt: Date.now(),
    ...(returnTo === undefined ? {} : { returnTo }),
  };
  const body = Result.fromSync(() => JSON.stringify(state));
  if (!body.ok) return body;
  const put = await Result.from(() =>
    kv.put(oauthStateKey(token), body.data, {
      expirationTtl: Math.floor(OAUTH_STATE_TTL_MS / 1000),
    }),
  );
  if (!put.ok) return put;
  return Ok({ token });
};

/**
 * Verify the cookie/query double-submit, then atomically consume the KV record
 * so the state cannot be replayed.
 */
export const consumeOAuthState = async (
  kv: KVNamespace,
  cookieToken: string | undefined,
  queryToken: string | undefined,
): Promise<Result<OAuthState, Error>> => {
  if (!cookieToken || !queryToken || cookieToken !== queryToken) {
    return Err(new Error("OAUTH_STATE_MISMATCH"));
  }
  const key = oauthStateKey(queryToken);
  const raw = await Result.from(() => kv.get(key));
  if (!raw.ok) return raw;
  if (!raw.data) return Err(new Error("OAUTH_STATE_MISSING"));
  const deleted = await Result.from(() => kv.delete(key));
  if (!deleted.ok) return deleted;
  const parsed = Result.fromSync(() => JSON.parse(raw.data) as unknown);
  if (!parsed.ok) return Err(new Error("OAUTH_STATE_INVALID"));
  if (!isOAuthState(parsed.data)) return Err(new Error("OAUTH_STATE_INVALID"));
  if (Date.now() - parsed.data.issuedAt > OAUTH_STATE_TTL_MS) {
    return Err(new Error("OAUTH_STATE_EXPIRED"));
  }
  return Ok(parsed.data);
};

export const sessionCookieHeader = (token: string, expiresAt: string): string => {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${String(maxAge)}`;
};

export const clearSessionCookieHeader = (): string =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export const oauthStateCookieHeader = (token: string): string =>
  `${OAUTH_STATE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${String(Math.floor(OAUTH_STATE_TTL_MS / 1000))}`;

export const clearOAuthStateCookieHeader = (): string =>
  `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export const readCookie = (cookieHeader: string | null, name: string): string | undefined => {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(";").map((part) => part.trim());
  const match = parts.find((part) => part.startsWith(`${name}=`));
  if (!match) return undefined;
  return match.slice(name.length + 1);
};

const isOAuthState = (value: unknown): value is OAuthState => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.issuedAt !== "number") return false;
  if (row.returnTo !== undefined && typeof row.returnTo !== "string") return false;
  return true;
};
