// GitHub App authentication using WebCrypto only (runs on Cloudflare Workers).
// App JWT (RS256) -> installation access token -> KV-cached for ~1h.

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

// --- PEM / base64url ----------------------------------------------------------

export function pkcs8PemToArrayBuffer(pem: string): ArrayBuffer {
  if (!pem.includes("BEGIN PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY must be PKCS#8 ('BEGIN PRIVATE KEY'). Convert GitHub's " +
        "downloaded PKCS#1 key once with: openssl pkcs8 -topk8 -nocrypt -in key.pem",
    );
  }
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

// --- JWT ----------------------------------------------------------------------

export async function mintAppJwt(
  pkcs8Pem: string,
  iss: string,
  now: number = Date.now(),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8PemToArrayBuffer(pkcs8Pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const iat = Math.floor(now / 1000) - 60; // backdate for clock skew
  const exp = iat + 60 + 540; // <= 10 min
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64urlText(JSON.stringify({ iat, exp, iss }));
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(sig)}`;
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
): Promise<number> {
  const base = opts.apiBaseUrl ?? DEFAULT_BASE;
  const res = await (opts.fetchImpl ?? fetch)(`${base}/repos/${owner}/${repo}/installation`, {
    headers: ghHeaders(appJwt),
  });
  if (!res.ok) throw new Error(`installation lookup HTTP ${res.status}`);
  return ((await res.json()) as { id: number }).id;
}

export async function mintInstallationToken(
  appJwt: string,
  installationId: number,
  opts: { apiBaseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<CachedToken> {
  const base = opts.apiBaseUrl ?? DEFAULT_BASE;
  const res = await (opts.fetchImpl ?? fetch)(
    `${base}/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers: ghHeaders(appJwt) },
  );
  if (!res.ok) throw new Error(`installation token HTTP ${res.status}`);
  const json = (await res.json()) as { token: string; expires_at: string };
  return { token: json.token, expiresAt: json.expires_at };
}

// --- Provider (KV-cached) -----------------------------------------------------

/**
 * Returns a token provider: a closure that yields a valid installation token,
 * minting + caching in KV on miss/expiry. The adapter holds only this closure,
 * so the Platform port stays auth-free (DESIGN §3).
 */
export function installationTokenProvider(
  config: InstallationTokenProviderConfig,
): () => Promise<string> {
  const now = config.now ?? Date.now;
  const key = `inst:${config.installationId}`;

  return async () => {
    const cached = await config.kv.get(key);
    if (cached) {
      // Treat a corrupt/unparseable entry as a miss rather than wedging forever.
      try {
        const { token, expiresAt } = JSON.parse(cached) as CachedToken;
        if (token && (Date.parse(expiresAt) - now()) / 1000 > SKEW_SECONDS) return token;
      } catch {
        /* fall through to mint */
      }
    }

    const jwt = await mintAppJwt(config.privateKeyPem, config.clientId, now());
    const fresh = await mintInstallationToken(jwt, config.installationId, {
      apiBaseUrl: config.apiBaseUrl,
      fetchImpl: config.fetchImpl,
    });
    const ttl = Math.floor((Date.parse(fresh.expiresAt) - now()) / 1000) - SKEW_SECONDS;
    await config.kv.put(key, JSON.stringify(fresh), { expirationTtl: Math.max(60, ttl) });
    return fresh.token;
  };
}
