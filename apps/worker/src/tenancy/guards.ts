import { Err, Ok, Result } from "@aipm/core";
import {
  getInstallationRecord,
  isWorkspaceGithubMember,
  LEGACY_WORKSPACE_ID,
  workspaceIdFromTrustedSource,
  type WorkspaceContext,
  type WorkspaceId,
} from "@aipm/db";

export interface DbEnv {
  readonly DB: D1Database;
}

export interface WorkspaceMembership {
  readonly context: WorkspaceContext;
  readonly userId: string;
  readonly role: "owner" | "admin" | "member";
}

export const requireWorkspaceMember = async (
  env: DbEnv,
  workspaceId: WorkspaceId,
  userId: string,
  sessionId?: string,
): Promise<Result<WorkspaceMembership, Error>> => {
  const loaded = await Result.from(() =>
    env.DB.prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
      .bind(workspaceId, userId)
      .first<{ role: WorkspaceMembership["role"] }>(),
  );
  if (!loaded.ok) return loaded;
  if (!loaded.data) return Err(new Error("WORKSPACE_MEMBERSHIP_REQUIRED"));
  return Ok({
    context: {
      workspaceId,
      provenance: { kind: "session", sessionId: sessionId ?? userId },
    },
    userId,
    role: loaded.data.role,
  });
};

/** Control-plane entry: trust a route param only after membership is confirmed. */
export const requireWorkspaceMemberByParam = async (
  env: DbEnv,
  workspaceIdRaw: string,
  userId: string,
  sessionId?: string,
): Promise<Result<WorkspaceMembership, Error>> => {
  if (!workspaceIdRaw.trim()) return Err(new Error("WORKSPACE_ID_REQUIRED"));
  return requireWorkspaceMember(
    env,
    workspaceIdFromTrustedSource(workspaceIdRaw),
    userId,
    sessionId,
  );
};

export const resolveWorkspaceInstallation = async (
  env: DbEnv,
  installationId: number,
): Promise<Result<WorkspaceContext, Error>> => {
  const loaded = await getInstallationRecord(env.DB, installationId);
  if (!loaded.ok) return loaded;
  if (!loaded.data) return Err(new Error("ACTIVE_INSTALLATION_REQUIRED"));
  if (loaded.data.status !== "active") {
    return Err(new Error(`INSTALLATION_${loaded.data.status.toUpperCase()}`));
  }
  return Ok({
    workspaceId: loaded.data.workspaceId,
    provenance: { kind: "github-installation", installationId },
  });
};

/**
 * Resolve an installation to a workspace, falling back to the legacy self-host
 * workspace when no installation row exists yet (migration path). Suspended or
 * deleted installations are always rejected.
 */
export const resolveWorkspaceInstallationOrLegacy = async (
  env: DbEnv,
  installationId: number | undefined,
): Promise<Result<WorkspaceContext, Error>> => {
  if (installationId === undefined) {
    return Ok({
      workspaceId: LEGACY_WORKSPACE_ID,
      provenance: { kind: "legacy-bootstrap" },
    });
  }
  const loaded = await getInstallationRecord(env.DB, installationId);
  if (!loaded.ok) return loaded;
  if (!loaded.data) {
    return Ok({
      workspaceId: LEGACY_WORKSPACE_ID,
      provenance: { kind: "legacy-bootstrap" },
    });
  }
  if (loaded.data.status !== "active") {
    return Err(new Error(`INSTALLATION_${loaded.data.status.toUpperCase()}`));
  }
  return Ok({
    workspaceId: loaded.data.workspaceId,
    provenance: { kind: "github-installation", installationId },
  });
};

export interface EnabledRepository {
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: number;
  readonly installationId: number;
  readonly fullName: string;
}

export const requireEnabledRepository = async (
  env: DbEnv,
  context: WorkspaceContext,
  repositoryId: number,
): Promise<Result<EnabledRepository, Error>> => {
  const loaded = await Result.from(() =>
    env.DB.prepare(
      `SELECT repository_id, installation_id, full_name
       FROM github_repositories
       WHERE workspace_id = ? AND repository_id = ?
         AND enabled = 1 AND status = 'active'`,
    )
      .bind(context.workspaceId, repositoryId)
      .first<{
        repository_id: number;
        installation_id: number;
        full_name: string;
      }>(),
  );
  if (!loaded.ok) return loaded;
  if (!loaded.data) return Err(new Error("ENABLED_REPOSITORY_REQUIRED"));
  return Ok({
    workspaceId: context.workspaceId,
    repositoryId: loaded.data.repository_id,
    installationId: loaded.data.installation_id,
    fullName: loaded.data.full_name,
  });
};

/**
 * Managed workspaces require an enabled repository. The legacy self-host
 * workspace skips the registry check so existing SWEEP_REPOS deployments keep working.
 */
export const requireEnabledRepositoryUnlessLegacy = async (
  env: DbEnv,
  context: WorkspaceContext,
  repositoryId: number | undefined,
): Promise<Result<EnabledRepository | undefined, Error>> => {
  if (context.workspaceId === LEGACY_WORKSPACE_ID) return Ok(undefined);
  if (repositoryId === undefined) return Err(new Error("REPOSITORY_REQUIRED"));
  const enabled = await requireEnabledRepository(env, context, repositoryId);
  if (!enabled.ok) return enabled;
  return Ok(enabled.data);
};

export const verifyInstallationBelongsToWorkspace = async (
  env: DbEnv,
  installationId: number,
  workspaceId: WorkspaceId,
): Promise<boolean> => {
  const loaded = await getInstallationRecord(env.DB, installationId);
  if (!loaded.ok) return false;
  if (!loaded.data) {
    // Self-host path: no installation row yet, only the legacy workspace may proceed.
    return workspaceId === LEGACY_WORKSPACE_ID;
  }
  return loaded.data.status === "active" && loaded.data.workspaceId === workspaceId;
};

export const workspaceAllowsGithubActor = async (
  env: DbEnv,
  workspaceId: WorkspaceId,
  githubLogin: string | undefined,
): Promise<Result<boolean, Error>> => {
  if (!githubLogin) return Ok(false);
  if (workspaceId === LEGACY_WORKSPACE_ID) {
    return Ok(false);
  }
  return isWorkspaceGithubMember(env.DB, workspaceId, githubLogin);
};

export const installationWorkspaceId = async (
  env: DbEnv,
  installationId: number,
): Promise<Result<WorkspaceId | undefined, Error>> => {
  const loaded = await getInstallationRecord(env.DB, installationId);
  if (!loaded.ok) return loaded;
  if (!loaded.data) return Ok(undefined);
  return Ok(loaded.data.workspaceId);
};

export const scheduledWorkspaceContext = (workspaceId: WorkspaceId): WorkspaceContext => ({
  workspaceId,
  provenance: { kind: "scheduled" },
});

export const legacyWorkspaceContext = (): WorkspaceContext => ({
  workspaceId: workspaceIdFromTrustedSource(LEGACY_WORKSPACE_ID),
  provenance: { kind: "legacy-bootstrap" },
});
