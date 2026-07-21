import { D1Store } from "./d1-store.js";
import type { WorkspaceId } from "./workspace.js";

export const createWorkspaceStore = (db: D1Database, workspaceId: WorkspaceId): D1Store =>
  new D1Store(db, workspaceId);

export {
  LEGACY_WORKSPACE_ID,
  type WorkspaceContext,
  type WorkspaceId,
  type WorkspaceProvenance,
  workspaceIdFromTrustedSource,
} from "./workspace.js";

export {
  createSession,
  createWorkspaceForGithubAccount,
  deleteExpiredSessions,
  deleteSession,
  ensureWorkspaceMember,
  findUserByGithubId,
  findUserById,
  findWorkspaceByGithubAccount,
  getInstallationRecord,
  getSession,
  getWorkspaceConfig,
  isWorkspaceGithubMember,
  listActiveSweepRepositories,
  listGithubRepositories,
  listInstallationsForWorkspace,
  listWorkspacesForUser,
  markInstallationRepositoriesRemoved,
  markRepositoriesRemoved,
  setInstallationStatus,
  setRepositoriesEnabled,
  type GithubAccountRef,
  type GithubAccountType,
  type GithubRepositoryRef,
  type GithubRepositoryRow,
  type InstallationRecord,
  type InstallationStatus,
  type RepositoryStatus,
  type SessionRow,
  type SweepRepository,
  type UserRow,
  type WorkspaceConfigRow,
  type WorkspaceRole,
  type WorkspaceSummary,
  upsertGithubInstallation,
  upsertGithubRepositories,
  upsertUserFromGithub,
  upsertWorkspaceConfig,
} from "./control-plane.js";

export {
  appendAuditAction,
  auditOutcomes,
  enableWorkspaceCapability,
  listAuditActions,
  offboardWorkspace,
  type AppendAuditAction,
  type AuditAction,
  type AuditActor,
  type AuditOutcome,
  type AuditSource,
  type ManagedCapability,
  type WorkspaceCredentialRemover,
} from "./public-safety.js";
