import { offboardWorkspace, type WorkspaceId } from "@aipm/db";
import type { Env } from "../env.js";
import { installationTokenKey } from "./keys.js";

/**
 * Worker-owned offboarding wiring. The DB helper disables installations before
 * this callback removes provider credentials, then cascades tenant-owned D1 data.
 */
export const offboardManagedWorkspace = (
  env: Pick<Env, "DB" | "INSTALL_TOKENS">,
  workspaceId: WorkspaceId,
) =>
  offboardWorkspace(env.DB, workspaceId, {
    deleteInstallationCredential: (installationId) =>
      env.INSTALL_TOKENS.delete(installationTokenKey(workspaceId, installationId)),
  });
