import { Ok, Result } from "@aipm/core";

const DEDUPE_TTL_SECONDS = 86_400;

/**
 * Mark a webhook delivery as processed in KV so a retried delivery dedupes
 * (DESIGN §6/§9). A null key (no delivery/event id) is a no-op, so callers pass
 * the id-or-null directly instead of branching at every site.
 */
export const markDelivered = async (kv: KVNamespace, key: string | null) => {
  if (!key) return Ok(undefined);
  return Result.from(() => kv.put(key, "1", { expirationTtl: DEDUPE_TTL_SECONDS }));
};
