import { Err, Ok, Result } from "@aipm/core";
import {
  clearOAuthStateCookieHeader,
  clearSessionCookieHeader,
  createUserSession,
  mintOAuthState,
  OAUTH_STATE_COOKIE,
  oauthStateCookieHeader,
  readCookie,
  resolveSessionToken,
  revokeSessionToken,
  SESSION_COOKIE,
  sessionCookieHeader,
  verifyOAuthState,
} from "../auth/session.js";
import type { Env } from "../env.js";
import { Hono } from "hono";

export { readCookie, SESSION_COOKIE };

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.get("/github", (c) => {
  const clientId = c.env.GITHUB_APP_CLIENT_ID;
  const publicBase = c.env.PUBLIC_BASE_URL;
  if (!clientId || !publicBase) {
    return c.json({ error: "oauth_not_configured" }, 503);
  }
  const returnTo = c.req.query("returnTo") ?? undefined;
  const minted = mintOAuthState(returnTo);
  const redirectUri = `${trimSlash(publicBase)}/auth/github/callback`;
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", minted.token);
  url.searchParams.set("scope", "read:user");
  const res = c.redirect(url.toString(), 302);
  res.headers.append("Set-Cookie", oauthStateCookieHeader(minted.token));
  return res;
});

authRoutes.get("/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieState = readCookie(c.req.header("cookie") ?? null, OAUTH_STATE_COOKIE);
  const verified = verifyOAuthState(cookieState, state);
  if (!verified.ok) return c.json({ error: "invalid_oauth_state" }, 400);
  if (!code) return c.json({ error: "missing_code" }, 400);

  const clientId = c.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = c.env.GITHUB_OAUTH_CLIENT_SECRET;
  const publicBase = c.env.PUBLIC_BASE_URL;
  const siteOrigin = c.env.SITE_ORIGIN ?? publicBase;
  if (!clientId || !clientSecret || !publicBase || !siteOrigin) {
    return c.json({ error: "oauth_not_configured" }, 503);
  }

  const tokenResult = await exchangeCodeForToken({
    clientId,
    clientSecret,
    code,
    redirectUri: `${trimSlash(publicBase)}/auth/github/callback`,
  });
  if (!tokenResult.ok) return c.json({ error: "oauth_exchange_failed" }, 502);

  const profile = await fetchGithubUser(tokenResult.data);
  if (!profile.ok) return c.json({ error: "oauth_profile_failed" }, 502);

  const session = await createUserSession(c.env, {
    githubUserId: profile.data.id,
    githubLogin: profile.data.login,
  });
  if (!session.ok) return c.json({ error: "session_create_failed" }, 500);

  const returnTo =
    safeReturnTo(verified.data.returnTo, siteOrigin) ?? `${trimSlash(siteOrigin)}/setup/github`;
  const res = c.redirect(returnTo, 302);
  res.headers.append("Set-Cookie", sessionCookieHeader(session.data.token, session.data.expiresAt));
  res.headers.append("Set-Cookie", clearOAuthStateCookieHeader());
  return res;
});

authRoutes.post("/logout", async (c) => {
  const csrf = requireCsrf(c);
  if (!csrf.ok) return c.json({ error: "csrf_required" }, 403);
  const token = readCookie(c.req.header("cookie") ?? null, SESSION_COOKIE);
  const revoked = await revokeSessionToken(c.env, token);
  if (!revoked.ok) return c.json({ error: "logout_failed" }, 500);
  const res = c.json({ ok: true });
  res.headers.append("Set-Cookie", clearSessionCookieHeader());
  res.headers.append("Set-Cookie", clearCsrfCookieHeader());
  return res;
});

const exchangeCodeForToken = async (input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<Result<string, Error>> => {
  const response = await Result.from(() =>
    fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    }),
  );
  if (!response.ok) return response;
  if (!response.data.ok) return Err(new Error("OAUTH_TOKEN_HTTP"));
  const body = await Result.from(() => response.data.json());
  if (!body.ok) return body;
  if (!isRecord(body.data) || typeof body.data.access_token !== "string") {
    return Err(new Error("OAUTH_TOKEN_MISSING"));
  }
  return Ok(body.data.access_token);
};

const fetchGithubUser = async (
  accessToken: string,
): Promise<Result<{ id: number; login: string }, Error>> => {
  const response = await Result.from(() =>
    fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "aipm-managed",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }),
  );
  if (!response.ok) return response;
  if (!response.data.ok) return Err(new Error("OAUTH_USER_HTTP"));
  const body = await Result.from(() => response.data.json());
  if (!body.ok) return body;
  if (
    !isRecord(body.data) ||
    typeof body.data.id !== "number" ||
    typeof body.data.login !== "string"
  ) {
    return Err(new Error("OAUTH_USER_INVALID"));
  }
  return Ok({ id: body.data.id, login: body.data.login });
};

const trimSlash = (value: string) => value.replace(/\/+$/, "");

const safeReturnTo = (candidate: string | undefined, siteOrigin: string): string | undefined => {
  if (!candidate) return undefined;
  if (candidate.startsWith("/") && !candidate.startsWith("//")) {
    return `${trimSlash(siteOrigin)}${candidate}`;
  }
  const parsed = Result.fromSync(() => new URL(candidate));
  if (!parsed.ok) return undefined;
  const origin = Result.fromSync(() => new URL(siteOrigin));
  if (!origin.ok) return undefined;
  if (parsed.data.origin !== origin.data.origin) return undefined;
  return parsed.data.toString();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const CSRF_COOKIE = "aipm_csrf";
export const CSRF_HEADER = "x-csrf-token";

export const mintCsrfToken = (): string => crypto.randomUUID().replaceAll("-", "");

export const csrfCookieHeader = (token: string): string =>
  `${CSRF_COOKIE}=${token}; Path=/; Secure; SameSite=Lax; Max-Age=${String(60 * 60 * 24 * 30)}`;

export const clearCsrfCookieHeader = (): string =>
  `${CSRF_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`;

export const requireCsrf = (c: {
  req: { header: (name: string) => string | undefined };
}): Result<void, Error> => {
  const cookieToken = readCookie(c.req.header("cookie") ?? null, CSRF_COOKIE);
  const headerToken = c.req.header(CSRF_HEADER);
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return Err(new Error("CSRF_REQUIRED"));
  }
  return Ok(undefined);
};

export const requireAuthedUser = async (c: {
  env: Env;
  req: { header: (name: string) => string | undefined };
}): Promise<Result<{ userId: string; githubLogin: string }, Error>> => {
  const token = readCookie(c.req.header("cookie") ?? null, SESSION_COOKIE);
  const session = await resolveSessionToken(c.env, token);
  if (!session.ok) return session;
  if (!session.data) return Err(new Error("UNAUTHENTICATED"));
  return Ok(session.data);
};
