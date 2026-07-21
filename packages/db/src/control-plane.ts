import { Err, Ok, Result } from "@aipm/core";
import { workspaceIdFromTrustedSource, type WorkspaceId } from "./workspace.js";

export type WorkspaceRole = "owner" | "admin" | "member";
export type GithubAccountType = "Organization" | "User";
export type InstallationStatus = "active" | "suspended" | "deleted";
export type RepositoryStatus = "active" | "removed";

export interface GithubAccountRef {
  readonly id: number;
  readonly login: string;
  readonly type: GithubAccountType;
}

export interface GithubRepositoryRef {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
}

export interface UserRow {
  readonly id: string;
  readonly githubUserId: number;
  readonly githubLogin: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionRow {
  readonly idHash: string;
  readonly userId: string;
  readonly githubLogin: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface WorkspaceConfigRow {
  readonly workspaceId: WorkspaceId;
  readonly configJson: string;
  readonly revision: number;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
}

export interface InstallationRecord {
  readonly workspaceId: WorkspaceId;
  readonly installationId: number;
  readonly status: InstallationStatus;
  readonly suspendedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SweepRepository {
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: number;
  readonly installationId: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
}

export interface GithubRepositoryRow {
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: number;
  readonly installationId: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly enabled: boolean;
  readonly status: RepositoryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceSummary {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly githubAccountId: number | null;
  readonly githubAccountType: string | null;
  readonly githubAccountLogin: string | null;
  readonly role: WorkspaceRole;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const nowIso = () => new Date().toISOString();

export const upsertUserFromGithub = async (
  db: D1Database,
  githubUserId: number,
  githubLogin: string,
  userId: string,
): Promise<Result<UserRow, Error>> => {
  const now = nowIso();
  const written = await Result.from(() =>
    db
      .prepare(
        `INSERT INTO users (id, github_user_id, github_login, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(github_user_id) DO UPDATE SET
           github_login = excluded.github_login,
           updated_at = excluded.updated_at`,
      )
      .bind(userId, githubUserId, githubLogin, now, now)
      .run(),
  );
  if (!written.ok) return written;
  return findUserByGithubId(db, githubUserId).then((found) => {
    if (!found.ok) return found;
    if (!found.data) return Err(new Error("USER_UPSERT_FAILED"));
    return Ok(found.data);
  });
};

export const findUserByGithubId = async (
  db: D1Database,
  githubUserId: number,
): Promise<Result<UserRow | null, Error>> => {
  const loaded = await Result.from(() =>
    db
      .prepare(
        `SELECT id, github_user_id, github_login, created_at, updated_at
         FROM users WHERE github_user_id = ?`,
      )
      .bind(githubUserId)
      .first<{
        id: string;
        github_user_id: number;
        github_login: string;
        created_at: string;
        updated_at: string;
      }>(),
  );
  if (!loaded.ok) return loaded;
  if (!loaded.data) return Ok(null);
  return Ok({
    id: loaded.data.id,
    githubUserId: loaded.data.github_user_id,
    githubLogin: loaded.data.github_login,
    createdAt: loaded.data.created_at,
    updatedAt: loaded.data.updated_at,
  });
};

export const findUserById = async (
  db: D1Database,
  userId: string,
): Promise<Result<UserRow | null, Error>> => {
  const loaded = await Result.from(() =>
    db
      .prepare(
        `SELECT id, github_user_id, github_login, created_at, updated_at
         FROM users WHERE id = ?`,
      )
      .bind(userId)
      .first<{
        id: string;
        github_user_id: number;
        github_login: string;
        created_at: string;
        updated_at: string;
      }>(),
  );
  if (!loaded.ok) return loaded;
  if (!loaded.data) return Ok(null);
  return Ok({
    id: loaded.data.id,
    githubUserId: loaded.data.github_user_id,
    githubLogin: loaded.data.github_login,
    createdAt: loaded.data.created_at,
    updatedAt: loaded.data.updated_at,
  });
};

export const createSession = async (
  db: D1Database,
  idHash: string,
  userId: string,
  expiresAt: string,
): Promise<Result<void, Error>> =>
  Result.from(async () => {
    await db
      .prepare(
        `INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(idHash, userId, expiresAt, nowIso())
      .run();
  });

export const getSession = async (
  db: D1Database,
  idHash: string,
): Promise<Result<SessionRow | null, Error>> => {
  const loaded = await Result.from(() =>
    db
      .prepare(
        `SELECT s.id_hash, s.user_id, s.expires_at, s.created_at, u.github_login
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id_hash = ?`,
      )
      .bind(idHash)
      .first<{
        id_hash: string;
        user_id: string;
        expires_at: string;
        created_at: string;
        github_login: string;
      }>(),
  );
  if (!loaded.ok) return loaded;
  if (!loaded.data) return Ok(null);
  return Ok({
    idHash: loaded.data.id_hash,
    userId: loaded.data.user_id,
    githubLogin: loaded.data.github_login,
    expiresAt: loaded.data.expires_at,
    createdAt: loaded.data.created_at,
  });
};

export const deleteSession = async (db: D1Database, idHash: string): Promise<Result<void, Error>> =>
  Result.from(async () => {
    await db.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(idHash).run();
  });

export const deleteExpiredSessions = async (
  db: D1Database,
  now: string = nowIso(),
): Promise<Result<number, Error>> => {
  const deleted = await Result.from(() =>
    db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(now).run(),
  );
  if (!deleted.ok) return deleted;
  return Ok(deleted.data.meta.changes);
};

export const findWorkspaceByGithubAccount = async (
  db: D1Database,
  account: GithubAccountRef,
): Promise<Result<WorkspaceId | null, Error>> => {
  const loaded = await Result.from(() =>
    db
      .prepare(
        `SELECT id FROM workspaces
         WHERE github_account_id = ? AND github_account_type = ?`,
      )
      .bind(account.id, account.type)
      .first<{ id: string }>(),
  );
  if (!loaded.ok) return loaded;
  if (!loaded.data) return Ok(null);
  return Ok(workspaceIdFromTrustedSource(loaded.data.id));
};

export const createWorkspaceForGithubAccount = async (
  db: D1Database,
  account: GithubAccountRef,
  workspaceId: WorkspaceId = workspaceIdFromTrustedSource(crypto.randomUUID()),
): Promise<Result<WorkspaceId, Error>> => {
  const now = nowIso();
  const written = await Result.from(() =>
    db
      .prepare(
        `INSERT INTO workspaces
           (id, github_account_id, github_account_type, github_account_login, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(workspaceId, account.id, account.type, account.login, account.login, now, now)
      .run(),
  );
  if (!written.ok) return written;
  return Ok(workspaceId);
};

export const ensureWorkspaceMember = async (
  db: D1Database,
  workspaceId: WorkspaceId,
  userId: string,
  role: WorkspaceRole = "owner",
): Promise<Result<void, Error>> =>
  Result.from(async () => {
    await db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .bind(workspaceId, userId, role, nowIso())
      .run();
  });

export const listWorkspacesForUser = async (
  db: D1Database,
  userId: string,
): Promise<Result<Array<WorkspaceSummary>, Error>> => {
  const loaded = await Result.from(() =>
    db
      .prepare(
        `SELECT w.id, w.name, w.github_account_id, w.github_account_type, w.github_account_login,
                w.created_at, w.updated_at, m.role
         FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = ?
         ORDER BY w.name ASC`,
      )
      .bind(userId)
      .all<{
        id: string;
        name: string;
        github_account_id: number | null;
        github_account_type: string | null;
        github_account_login: string | null;
        created_at: string;
        updated_at: string;
        role: WorkspaceRole;
      }>(),
  );
  if (!loaded.ok) return loaded;
  return Ok(
    loaded.data.results.map((row) => ({
      id: workspaceIdFromTrustedSource(row.id),
      name: row.name,
      githubAccountId: row.github_account_id,
      githubAccountType: row.github_account_type,
      githubAccountLogin: row.github_account_login,
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  );
};

export const isWorkspaceGithubMember = async (
  db: D1Database,
  workspaceId: WorkspaceId,
  githubLogin: string,
): Promise<Result<boolean, Error>> => {
  const loaded = await Result.from(() =>
    db
      .prepare(
        `SELECT 1 AS ok
         FROM workspace_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ? AND lower(u.github_login) = lower(?)`,
      )
      .bind(workspaceId, githubLogin)
      .first<{ ok: number }>(),
  );
  if (!loaded.ok) return loaded;
  return Ok(Boolean(loaded.data));
};

export const getInstallationRecord = async (
  db: D1Database,
  installationId: number,
): Promise<Result<InstallationRecord | null, Error>> => {
  const loaded = await Result.from(() =>
    db
      .prepare(
        `SELECT workspace_id, installation_id, status, suspended_at, created_at, updated_at
         FROM github_installations WHERE installation_id = ?`,
      )
      .bind(installationId)
      .first<{
        workspace_id: string;
        installation_id: number;
        status: InstallationStatus;
        suspended_at: string | null;
        created_at: string;
        updated_at: string;
      }>(),
  );
  if (!loaded.ok) return loaded;
  if (!loaded.data) return Ok(null);
  return Ok({
    workspaceId: workspaceIdFromTrustedSource(loaded.data.workspace_id),
    installationId: loaded.data.installation_id,
    status: loaded.data.status,
    suspendedAt: loaded.data.suspended_at,
    createdAt: loaded.data.created_at,
    updatedAt: loaded.data.updated_at,
  });
};

export const upsertGithubInstallation = async (
  db: D1Database,
  workspaceId: WorkspaceId,
  installationId: number,
  status: InstallationStatus,
): Promise<Result<void, Error>> => {
  const now = nowIso();
  const suspendedAt = status === "suspended" ? now : null;
  return Result.from(async () => {
    await db
      .prepare(
        `INSERT INTO github_installations
           (workspace_id, installation_id, status, suspended_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           status = excluded.status,
           suspended_at = excluded.suspended_at,
           updated_at = excluded.updated_at`,
      )
      .bind(workspaceId, installationId, status, suspendedAt, now, now)
      .run();
  });
};

export const setInstallationStatus = async (
  db: D1Database,
  installationId: number,
  status: InstallationStatus,
): Promise<Result<void, Error>> => {
  const now = nowIso();
  const suspendedAt = status === "suspended" ? now : null;
  return Result.from(async () => {
    await db
      .prepare(
        `UPDATE github_installations
         SET status = ?, suspended_at = ?, updated_at = ?
         WHERE installation_id = ?`,
      )
      .bind(status, suspendedAt, now, installationId)
      .run();
  });
};

export const upsertGithubRepositories = async (
  db: D1Database,
  workspaceId: WorkspaceId,
  installationId: number,
  repos: ReadonlyArray<GithubRepositoryRef>,
): Promise<Result<void, Error>> => {
  if (!repos.length) return Ok(undefined);
  const now = nowIso();
  return Result.from(async () => {
    await db.batch(
      repos.map((repo) =>
        db
          .prepare(
            `INSERT INTO github_repositories
               (workspace_id, repository_id, installation_id, owner, name, full_name,
                enabled, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)
             ON CONFLICT(workspace_id, repository_id) DO UPDATE SET
               installation_id = excluded.installation_id,
               owner = excluded.owner,
               name = excluded.name,
               full_name = excluded.full_name,
               status = 'active',
               updated_at = excluded.updated_at`,
          )
          .bind(
            workspaceId,
            repo.id,
            installationId,
            repo.owner,
            repo.name,
            repo.fullName,
            now,
            now,
          ),
      ),
    );
  });
};

export const markRepositoriesRemoved = async (
  db: D1Database,
  workspaceId: WorkspaceId,
  repositoryIds: ReadonlyArray<number>,
): Promise<Result<void, Error>> => {
  if (!repositoryIds.length) return Ok(undefined);
  const now = nowIso();
  return Result.from(async () => {
    await db.batch(
      repositoryIds.map((repositoryId) =>
        db
          .prepare(
            `UPDATE github_repositories
             SET enabled = 0, status = 'removed', updated_at = ?
             WHERE workspace_id = ? AND repository_id = ?`,
          )
          .bind(now, workspaceId, repositoryId),
      ),
    );
  });
};

export const markInstallationRepositoriesRemoved = async (
  db: D1Database,
  installationId: number,
): Promise<Result<void, Error>> =>
  Result.from(async () => {
    await db
      .prepare(
        `UPDATE github_repositories
         SET enabled = 0, status = 'removed', updated_at = ?
         WHERE installation_id = ?`,
      )
      .bind(nowIso(), installationId)
      .run();
  });

export const listGithubRepositories = async (
  db: D1Database,
  workspaceId: WorkspaceId,
): Promise<Result<Array<GithubRepositoryRow>, Error>> => {
  const loaded = await Result.from(() =>
    db
      .prepare(
        `SELECT workspace_id, repository_id, installation_id, owner, name, full_name,
                enabled, status, created_at, updated_at
         FROM github_repositories
         WHERE workspace_id = ?
         ORDER BY full_name ASC`,
      )
      .bind(workspaceId)
      .all<{
        workspace_id: string;
        repository_id: number;
        installation_id: number;
        owner: string;
        name: string;
        full_name: string;
        enabled: number;
        status: RepositoryStatus;
        created_at: string;
        updated_at: string;
      }>(),
  );
  if (!loaded.ok) return loaded;
  return Ok(
    loaded.data.results.map((row) => ({
      workspaceId: workspaceIdFromTrustedSource(row.workspace_id),
      repositoryId: row.repository_id,
      installationId: row.installation_id,
      owner: row.owner,
      name: row.name,
      fullName: row.full_name,
      enabled: row.enabled === 1,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  );
};

export const setRepositoriesEnabled = async (
  db: D1Database,
  workspaceId: WorkspaceId,
  repositoryIds: ReadonlyArray<number>,
): Promise<Result<void, Error>> => {
  const now = nowIso();
  const cleared = await Result.from(() =>
    db
      .prepare(
        `UPDATE github_repositories SET enabled = 0, updated_at = ?
         WHERE workspace_id = ? AND status = 'active'`,
      )
      .bind(now, workspaceId)
      .run(),
  );
  if (!cleared.ok) return cleared;
  if (!repositoryIds.length) return Ok(undefined);
  return Result.from(async () => {
    await db.batch(
      repositoryIds.map((repositoryId) =>
        db
          .prepare(
            `UPDATE github_repositories SET enabled = 1, updated_at = ?
             WHERE workspace_id = ? AND repository_id = ? AND status = 'active'`,
          )
          .bind(now, workspaceId, repositoryId),
      ),
    );
  });
};

export const listActiveSweepRepositories = async (
  db: D1Database,
): Promise<Result<Array<SweepRepository>, Error>> => {
  const loaded = await Result.from(() =>
    db
      .prepare(
        `SELECT r.workspace_id, r.repository_id, r.installation_id, r.owner, r.name, r.full_name
         FROM github_repositories r
         JOIN github_installations i
           ON i.workspace_id = r.workspace_id AND i.installation_id = r.installation_id
         WHERE r.enabled = 1 AND r.status = 'active' AND i.status = 'active'
         ORDER BY r.workspace_id, r.full_name`,
      )
      .all<{
        workspace_id: string;
        repository_id: number;
        installation_id: number;
        owner: string;
        name: string;
        full_name: string;
      }>(),
  );
  if (!loaded.ok) return loaded;
  return Ok(
    loaded.data.results.map((row) => ({
      workspaceId: workspaceIdFromTrustedSource(row.workspace_id),
      repositoryId: row.repository_id,
      installationId: row.installation_id,
      owner: row.owner,
      name: row.name,
      fullName: row.full_name,
    })),
  );
};

export const getWorkspaceConfig = async (
  db: D1Database,
  workspaceId: WorkspaceId,
): Promise<Result<WorkspaceConfigRow | null, Error>> => {
  const loaded = await Result.from(() =>
    db
      .prepare(
        `SELECT workspace_id, config_json, revision, updated_by, updated_at
         FROM workspace_config WHERE workspace_id = ?`,
      )
      .bind(workspaceId)
      .first<{
        workspace_id: string;
        config_json: string;
        revision: number;
        updated_by: string | null;
        updated_at: string;
      }>(),
  );
  if (!loaded.ok) return loaded;
  if (!loaded.data) return Ok(null);
  return Ok({
    workspaceId: workspaceIdFromTrustedSource(loaded.data.workspace_id),
    configJson: loaded.data.config_json,
    revision: loaded.data.revision,
    updatedBy: loaded.data.updated_by,
    updatedAt: loaded.data.updated_at,
  });
};

export const upsertWorkspaceConfig = async (
  db: D1Database,
  workspaceId: WorkspaceId,
  configJson: string,
  updatedBy: string,
): Promise<Result<WorkspaceConfigRow, Error>> => {
  const now = nowIso();
  const written = await Result.from(() =>
    db
      .prepare(
        `INSERT INTO workspace_config (workspace_id, config_json, revision, updated_by, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           config_json = excluded.config_json,
           revision = workspace_config.revision + 1,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .bind(workspaceId, configJson, updatedBy, now)
      .run(),
  );
  if (!written.ok) return written;
  const loaded = await getWorkspaceConfig(db, workspaceId);
  if (!loaded.ok) return loaded;
  if (!loaded.data) return Err(new Error("CONFIG_PUT_FAILED"));
  return Ok(loaded.data);
};

export const listInstallationsForWorkspace = async (
  db: D1Database,
  workspaceId: WorkspaceId,
): Promise<Result<Array<InstallationRecord>, Error>> => {
  const loaded = await Result.from(() =>
    db
      .prepare(
        `SELECT workspace_id, installation_id, status, suspended_at, created_at, updated_at
         FROM github_installations WHERE workspace_id = ?
         ORDER BY installation_id ASC`,
      )
      .bind(workspaceId)
      .all<{
        workspace_id: string;
        installation_id: number;
        status: InstallationStatus;
        suspended_at: string | null;
        created_at: string;
        updated_at: string;
      }>(),
  );
  if (!loaded.ok) return loaded;
  return Ok(
    loaded.data.results.map((row) => ({
      workspaceId: workspaceIdFromTrustedSource(row.workspace_id),
      installationId: row.installation_id,
      status: row.status,
      suspendedAt: row.suspended_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  );
};
