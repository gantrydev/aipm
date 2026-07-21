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

export const mintOpaqueToken = (): string =>
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

export interface OAuthState {
  readonly nonce: string;
  readonly returnTo?: string;
  readonly issuedAt: number;
}

export const mintOAuthState = (returnTo?: string): { token: string; state: OAuthState } => {
  const state: OAuthState = {
    nonce: mintOpaqueToken(),
    returnTo,
    issuedAt: Date.now(),
  };
  return { token: encodeState(state), state };
};

export const verifyOAuthState = (
  cookieToken: string | undefined,
  queryToken: string | undefined,
): Result<OAuthState, Error> => {
  if (!cookieToken || !queryToken || cookieToken !== queryToken) {
    return Err(new Error("OAUTH_STATE_MISMATCH"));
  }
  const parsed = decodeState(queryToken);
  if (!parsed.ok) return parsed;
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

const encodeState = (state: OAuthState): string =>
  btoa(JSON.stringify(state)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const decodeState = (token: string): Result<OAuthState, Error> => {
  const normalized = token.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const parsed = Result.fromSync(() => JSON.parse(atob(padded)) as OAuthState);
  if (!parsed.ok) return Err(new Error("OAUTH_STATE_INVALID"));
  if (
    typeof parsed.data.nonce !== "string" ||
    typeof parsed.data.issuedAt !== "number" ||
    (parsed.data.returnTo !== undefined && typeof parsed.data.returnTo !== "string")
  ) {
    return Err(new Error("OAUTH_STATE_INVALID"));
  }
  return Ok(parsed.data);
};
