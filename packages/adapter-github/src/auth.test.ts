import { describe, expect, it } from "vitest";
import { installationTokenProvider, mintAppJwt, type KVLike } from "./auth.js";

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function genKeyPair() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----`;
  return { pem, publicKey: pair.publicKey };
}

function fakeKv(): KVLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(k) {
      return store.get(k) ?? null;
    },
    async put(k, v) {
      store.set(k, v);
    },
  };
}

describe("mintAppJwt", () => {
  it("produces an RS256 JWT verifiable against the public key with iat backdated", async () => {
    const { pem, publicKey } = await genKeyPair();
    const now = 1_900_000_000_000;
    const jwt = await mintAppJwt(pem, "client-123", now);
    const [header, payload, sig] = jwt.split(".");

    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      b64urlToBytes(sig!),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(ok).toBe(true);

    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload!)));
    expect(claims.iss).toBe("client-123");
    expect(claims.iat).toBe(Math.floor(now / 1000) - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it("rejects a non-PKCS#8 key with a helpful error", async () => {
    await expect(
      mintAppJwt("-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----", "c"),
    ).rejects.toThrow(/PKCS#8/);
  });
});

describe("installationTokenProvider", () => {
  it("mints on miss, caches in KV, and reuses without re-fetching", async () => {
    const { pem } = await genKeyPair();
    const now = 1_900_000_000_000;
    const kv = fakeKv();
    let calls = 0;
    const fetchImpl = (async (_url: string) => {
      calls++;
      return new Response(
        JSON.stringify({ token: "ghs_abc", expires_at: new Date(now + 3600_000).toISOString() }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = installationTokenProvider({
      kv,
      privateKeyPem: pem,
      clientId: "client-123",
      installationId: 555,
      fetchImpl,
      now: () => now,
    });

    expect(await provider()).toBe("ghs_abc");
    expect(await provider()).toBe("ghs_abc");
    expect(calls).toBe(1); // second call served from KV
    expect(kv.store.has("inst:555")).toBe(true);
  });
});
