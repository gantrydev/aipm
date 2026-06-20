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
): Promise<boolean> {
  if (!signature?.startsWith("v0=") || !timestamp) return false;
  // Reject requests older than 5 minutes (replay protection).
  if (Math.abs(now / 1000 - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  const actual =
    "v0=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (actual.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < actual.length; i++)
    mismatch |= actual.charCodeAt(i) ^ signature.charCodeAt(i);
  return mismatch === 0;
}
