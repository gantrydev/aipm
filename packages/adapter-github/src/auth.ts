// GitHub App authentication using WebCrypto only (runs on Cloudflare Workers).
// App JWT (RS256) -> installation access token -> KV-cached for ~1h.

import { Err, Ok, Result } from "@aipm/core";
import { z } from "zod";

/** Minimal KV surface so this module needn't depend on @cloudflare/workers-types. */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface CachedToken {
  token: string;
  /** ISO expiry from GitHub. */
  expiresAt: string;
}

export interface InstallationTokenProviderConfig {
  kv: KVLike;
  /** PKCS#8 PEM ("BEGIN PRIVATE KEY"). GitHub downloads PKCS#1 — convert first. */
  privateKeyPem: string;
  /** App client id (or numeric App id) — the JWT `iss`. */
  clientId: string;
  installationId: number;
  apiBaseUrl?: string; // default https://api.github.com
  fetchImpl?: typeof fetch;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
}

const DEFAULT_BASE = "https://api.github.com";
const SKEW_SECONDS = 300;

// Boundary schemas: GitHub REST replies (loose — only the consumed field is
// declared) and the KV round-trip of our own CachedToken.
const installationSchema = z.looseObject({ id: z.number() });
const installationTokenSchema = z.looseObject({ token: z.string(), expires_at: z.string() });
const cachedTokenSchema = z.object({ token: z.string(), expiresAt: z.string() });

// --- PEM / base64url ----------------------------------------------------------

export function pkcs8PemToArrayBuffer(pem: string): Result<ArrayBuffer, Error> {
  if (!pem.includes("BEGIN PRIVATE KEY")) {
    return Err(
      new Error(
        "GITHUB_APP_PRIVATE_KEY must be PKCS#8 ('BEGIN PRIVATE KEY'). Convert GitHub's " +
          "downloaded PKCS#1 key once with: openssl pkcs8 -topk8 -nocrypt -in key.pem",
      ),
    );
  }
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const decoded = Result.fromSync<string>(() => atob(b64));
  if (!decoded.ok) return decoded;
  const bin = decoded.data;
  const buf = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return Ok(buf.buffer);
}

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const bin = String.fromCharCode(...arr);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

// --- JWT ----------------------------------------------------------------------

export async function mintAppJwt(
  pkcs8Pem: string,
  iss: string,
  now: number = Date.now(),
): Promise<Result<string, Error>> {
  const pem = pkcs8PemToArrayBuffer(pkcs8Pem);
  if (!pem.ok) return pem;
  const key = await Result.from(() =>
    crypto.subtle.importKey(
      "pkcs8",
      pem.data,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  );
  if (!key.ok) return key;
  const iat = Math.floor(now / 1000) - 60; // backdate for clock skew
  const exp = iat + 60 + 540; // <= 10 min
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64urlText(JSON.stringify({ iat, exp, iss }));
  const signingInput = `${header}.${payload}`;
  const sig = await Result.from(() =>
    crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.data, new TextEncoder().encode(signingInput)),
  );
  if (!sig.ok) return sig;
  return Ok(`${signingInput}.${b64url(sig.data)}`);
}

// --- REST: installation id + token --------------------------------------------

const ghHeaders = (auth: string) => ({
  Authorization: `Bearer ${auth}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "aipm-worker",
  "X-GitHub-Api-Version": "2022-11-28",
});

export async function resolveRepoInstallationId(
  appJwt: string,
  owner: string,
  repo: string,
  opts: { apiBaseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<Result<number, Error>> {
  const base = opts.apiBaseUrl ?? DEFAULT_BASE;
  const fetched = await Result.from(() =>
    (opts.fetchImpl ?? fetch)(`${base}/repos/${owner}/${repo}/installation`, {
      headers: ghHeaders(appJwt),
    }),
  );
  if (!fetched.ok) return fetched;
  const res = fetched.data;
  if (!res.ok) return Err(new Error(`installation lookup HTTP ${res.status}`));
  const parsed = await Result.from(() => res.json());
  if (!parsed.ok) return parsed;
  const validated = installationSchema.safeParse(parsed.data);
  if (!validated.success) return Err(new Error(`installation lookup: ${validated.error.message}`));
  return Ok(validated.data.id);
}

export async function mintInstallationToken(
  appJwt: string,
  installationId: number,
  opts: { apiBaseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<Result<CachedToken, Error>> {
  const base = opts.apiBaseUrl ?? DEFAULT_BASE;
  const fetched = await Result.from(() =>
    (opts.fetchImpl ?? fetch)(`${base}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: ghHeaders(appJwt),
    }),
  );
  if (!fetched.ok) return fetched;
  const res = fetched.data;
  if (!res.ok) return Err(new Error(`installation token HTTP ${res.status}`));
  const parsed = await Result.from(() => res.json());
  if (!parsed.ok) return parsed;
  const validated = installationTokenSchema.safeParse(parsed.data);
  if (!validated.success) return Err(new Error(`installation token: ${validated.error.message}`));
  return Ok({ token: validated.data.token, expiresAt: validated.data.expires_at });
}

// --- Provider (KV-cached) -----------------------------------------------------

/**
 * Returns a token provider: a closure that yields a valid installation token,
 * minting + caching in KV on miss/expiry. The adapter holds only this closure,
 * so the Platform port stays auth-free (DESIGN §3).
 */
export function installationTokenProvider(
  config: InstallationTokenProviderConfig,
): () => Promise<Result<string, Error>> {
  const now = config.now ?? Date.now;
  const key = `inst:${config.installationId}`;

  return async () => {
    const cachedResult = await Result.from(() => config.kv.get(key));
    if (!cachedResult.ok) return cachedResult;
    const cached = cachedResult.data;
    // Treat a corrupt/unparseable/invalid entry as a miss rather than wedging forever.
    const validCachedToken = (() => {
      if (!cached) return null;
      const json = Result.fromSync(() => JSON.parse(cached));
      if (!json.ok) return null;
      const parsed = cachedTokenSchema.safeParse(json.data);
      if (!parsed.success) return null;
      const token = parsed.data.token;
      const stillValid = (Date.parse(parsed.data.expiresAt) - now()) / 1000 > SKEW_SECONDS;
      if (!token || !stillValid) return null;
      return token;
    })();
    if (validCachedToken) return Ok(validCachedToken);

    const jwt = await mintAppJwt(config.privateKeyPem, config.clientId, now());
    if (!jwt.ok) return jwt;
    const fresh = await mintInstallationToken(jwt.data, config.installationId, {
      apiBaseUrl: config.apiBaseUrl,
      fetchImpl: config.fetchImpl,
    });
    if (!fresh.ok) return fresh;
    const ttl = Math.floor((Date.parse(fresh.data.expiresAt) - now()) / 1000) - SKEW_SECONDS;
    const cachedFresh = await Result.from(() =>
      config.kv.put(key, JSON.stringify(fresh.data), { expirationTtl: Math.max(60, ttl) }),
    );
    if (!cachedFresh.ok) return cachedFresh;
    return Ok(fresh.data.token);
  };
}
