import { Ok, Result } from "@aipm/core";
import { LEGACY_WORKSPACE_ID, type WorkspaceId } from "@aipm/db";
import type { Env } from "../env.js";
import type { MemberGate } from "../members.js";
import { memberGate } from "../members.js";
import { workspaceAllowsGithubActor } from "./guards.js";

/**
 * Workspace-scoped actor authorization. Managed workspaces authorize against
 * workspace membership (fail closed). The legacy self-host workspace keeps the
 * IDENTITY_ROSTER gate for backwards compatibility.
 */
export const workspaceActorGate = (
  env: Env,
  workspaceId: WorkspaceId,
): Result<MemberGate, Error> => {
  if (workspaceId === LEGACY_WORKSPACE_ID) {
    return memberGate(env);
  }

  const required = env.REQUIRE_MEMBER_TRIGGER !== "false";
  const isMember: MemberGate["isMember"] = async (platform, handle) => {
    if (platform !== "github") return false;
    const allowed = await workspaceAllowsGithubActor(env, workspaceId, handle);
    return allowed.ok && allowed.data;
  };

  return Ok({
    required,
    isMember,
    async allows(platform, handle) {
      if (!required) return true;
      return isMember(platform, handle);
    },
  });
};
