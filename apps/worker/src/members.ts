import { configIdentitySource, type PlatformId } from "@aipm/core";
import type { Env } from "./env.js";

/**
 * Member-trigger gate (abuse/cost control). On a public repo anyone can comment
 * on an issue/PR, and GitHub delivers a *signed* webhook for it — so signature
 * verification alone doesn't stop a stranger (or a spam loop) from driving LLM
 * spend. The gate drops, at ingress, any event whose triggering actor isn't a
 * known member of the identity roster, before it ever reaches the queue/DO/LLM.
 *
 * Default ON (fail safe): set REQUIRE_MEMBER_TRIGGER="false" to process events
 * from anyone (e.g. a private repo where every commenter is trusted). With the
 * gate on and an empty roster, nothing is processed — intentional for a public
 * deployment that hasn't enrolled its team yet.
 */
export interface MemberGate {
  /** Whether the gate is enforced; when false, isMember is irrelevant. */
  readonly required: boolean;
  /** Is this platform handle (e.g. a GitHub login / Slack user id) a roster member? */
  isMember(platform: PlatformId, handle: string | undefined): Promise<boolean>;
  /** Convenience: should this actor's event be processed at all? */
  allows(platform: PlatformId, handle: string | undefined): Promise<boolean>;
}

export function memberGate(env: Env): MemberGate {
  const required = env.REQUIRE_MEMBER_TRIGGER !== "false";
  const source = configIdentitySource(env.IDENTITY_ROSTER ?? "[]");

  const isMember: MemberGate["isMember"] = async (platform, handle) => {
    if (!handle) return false;
    return !!(await source.resolve({ handle, platform }));
  };

  return {
    required,
    isMember,
    async allows(platform, handle) {
      if (!required) return true;
      return isMember(platform, handle);
    },
  };
}
