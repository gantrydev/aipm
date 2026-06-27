import { Ok, Result } from "@aipm/core";

/**
 * Verify a Slack request signature (DESIGN §3). Slack signs
 * `v0:<timestamp>:<rawBody>` with HMAC-SHA256 and sends
 * `X-Slack-Signature: v0=<hex>` plus `X-Slack-Request-Timestamp`.
 */
export async function verifySlackRequest(
  signingSecret: string,
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  now: number = Date.now(),
): Promise<Result<boolean, Error>> {
  if (!signature?.startsWith("v0=") || !timestamp) return Ok(false);
  // Reject requests older than 5 minutes (replay protection).
  if (Math.abs(now / 1000 - Number(timestamp)) > 60 * 5) return Ok(false);

  const base = `v0:${timestamp}:${rawBody}`;
  const key = await Result.from(() =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  );
  if (!key.ok) return key;
  const sig = await Result.from(() =>
    crypto.subtle.sign("HMAC", key.data, new TextEncoder().encode(base)),
  );
  if (!sig.ok) return sig;
  const hex = [...new Uint8Array(sig.data)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const actual = `v0=${hex}`;
  if (actual.length !== signature.length) return Ok(false);
  const mismatch = [...actual].reduce(
    (acc, ch, i) => acc | (ch.charCodeAt(0) ^ signature.charCodeAt(i)),
    0,
  );
  return Ok(mismatch === 0);
}
