import { Err, Ok, Result } from "@aipm/core";
import {
  createWorkspaceForGithubAccount,
  findWorkspaceByGithubAccount,
  getInstallationRecord,
  markInstallationRepositoriesRemoved,
  markRepositoriesRemoved,
  setInstallationStatus,
  upsertGithubInstallation,
  upsertGithubRepositories,
  workspaceIdFromTrustedSource,
  type GithubAccountRef,
  type GithubRepositoryRef,
  type WorkspaceId,
} from "@aipm/db";
import type { DbEnv } from "./guards.js";

export interface InstallationLifecyclePayload {
  readonly action?: string;
  readonly installation?: {
    readonly id?: number;
    readonly account?: {
      readonly id?: number;
      readonly login?: string;
      readonly type?: string;
    };
  };
  readonly repositories?: ReadonlyArray<{
    readonly id?: number;
    readonly name?: string;
    readonly full_name?: string;
  }>;
  readonly repositories_added?: ReadonlyArray<{
    readonly id?: number;
    readonly name?: string;
    readonly full_name?: string;
  }>;
  readonly repositories_removed?: ReadonlyArray<{
    readonly id?: number;
    readonly name?: string;
    readonly full_name?: string;
  }>;
  readonly sender?: {
    readonly id?: number;
    readonly login?: string;
  };
}

export const isInstallationLifecycleEvent = (eventName: string | undefined): boolean =>
  eventName === "installation" || eventName === "installation_repositories";

export const handleGithubInstallationLifecycle = async (
  env: DbEnv,
  eventName: string,
  body: InstallationLifecyclePayload,
): Promise<Result<{ workspaceId: WorkspaceId; handled: string }, Error>> => {
  const installationId = body.installation?.id;
  if (installationId === undefined) return Err(new Error("INSTALLATION_ID_REQUIRED"));

  if (eventName === "installation") {
    return handleInstallationEvent(env, installationId, body);
  }
  if (eventName === "installation_repositories") {
    return handleInstallationRepositoriesEvent(env, installationId, body);
  }
  return Err(new Error("UNSUPPORTED_INSTALLATION_EVENT"));
};

const handleInstallationEvent = async (
  env: DbEnv,
  installationId: number,
  body: InstallationLifecyclePayload,
): Promise<Result<{ workspaceId: WorkspaceId; handled: string }, Error>> => {
  const action = body.action;
  if (action === "created") {
    const account = parseAccount(body);
    if (!account.ok) return account;
    const workspaceId = await resolveOrCreateWorkspace(env, account.data);
    if (!workspaceId.ok) return workspaceId;
    const upserted = await upsertGithubInstallation(
      env.DB,
      workspaceId.data,
      installationId,
      "active",
    );
    if (!upserted.ok) return upserted;
    const repos = parseRepositories(body.repositories ?? []);
    if (repos.length) {
      const written = await upsertGithubRepositories(
        env.DB,
        workspaceId.data,
        installationId,
        repos,
      );
      if (!written.ok) return written;
    }
    return Ok({ workspaceId: workspaceId.data, handled: "installation.created" });
  }

  if (action === "deleted") {
    const workspaceId = await workspaceIdForInstallation(env, installationId);
    if (!workspaceId.ok) return workspaceId;
    const status = await setInstallationStatus(env.DB, installationId, "deleted");
    if (!status.ok) return status;
    const removed = await markInstallationRepositoriesRemoved(env.DB, installationId);
    if (!removed.ok) return removed;
    return Ok({ workspaceId: workspaceId.data, handled: "installation.deleted" });
  }

  if (action === "suspend" || action === "suspended") {
    const workspaceId = await workspaceIdForInstallation(env, installationId);
    if (!workspaceId.ok) return workspaceId;
    const status = await setInstallationStatus(env.DB, installationId, "suspended");
    if (!status.ok) return status;
    return Ok({ workspaceId: workspaceId.data, handled: "installation.suspended" });
  }

  if (action === "unsuspend" || action === "unsuspended") {
    const workspaceId = await workspaceIdForInstallation(env, installationId);
    if (!workspaceId.ok) return workspaceId;
    const status = await setInstallationStatus(env.DB, installationId, "active");
    if (!status.ok) return status;
    return Ok({ workspaceId: workspaceId.data, handled: "installation.unsuspended" });
  }

  return Err(new Error(`UNSUPPORTED_INSTALLATION_ACTION:${action ?? "none"}`));
};

const handleInstallationRepositoriesEvent = async (
  env: DbEnv,
  installationId: number,
  body: InstallationLifecyclePayload,
): Promise<Result<{ workspaceId: WorkspaceId; handled: string }, Error>> => {
  const account = parseAccount(body);
  const workspaceId = account.ok
    ? await resolveOrCreateWorkspace(env, account.data)
    : await workspaceIdForInstallation(env, installationId);
  if (!workspaceId.ok) return workspaceId;

  const ensureInstall = await upsertGithubInstallation(
    env.DB,
    workspaceId.data,
    installationId,
    "active",
  );
  if (!ensureInstall.ok) return ensureInstall;

  const action = body.action;
  if (action === "added") {
    const repos = parseRepositories(body.repositories_added ?? body.repositories ?? []);
    if (repos.length) {
      const written = await upsertGithubRepositories(
        env.DB,
        workspaceId.data,
        installationId,
        repos,
      );
      if (!written.ok) return written;
    }
    return Ok({ workspaceId: workspaceId.data, handled: "installation_repositories.added" });
  }

  if (action === "removed") {
    const removedIds = (body.repositories_removed ?? [])
      .map((repo) => repo.id)
      .filter((id): id is number => typeof id === "number");
    const marked = await markRepositoriesRemoved(env.DB, workspaceId.data, removedIds);
    if (!marked.ok) return marked;
    return Ok({ workspaceId: workspaceId.data, handled: "installation_repositories.removed" });
  }

  return Err(new Error(`UNSUPPORTED_INSTALLATION_REPOSITORIES_ACTION:${action ?? "none"}`));
};

const resolveOrCreateWorkspace = async (
  env: DbEnv,
  account: GithubAccountRef,
): Promise<Result<WorkspaceId, Error>> => {
  const existing = await findWorkspaceByGithubAccount(env.DB, account);
  if (!existing.ok) return existing;
  if (existing.data) return Ok(existing.data);
  const workspaceId = workspaceIdFromTrustedSource(crypto.randomUUID());
  return createWorkspaceForGithubAccount(env.DB, account, workspaceId);
};

const workspaceIdForInstallation = async (
  env: DbEnv,
  installationId: number,
): Promise<Result<WorkspaceId, Error>> => {
  const loaded = await getInstallationRecord(env.DB, installationId);
  if (!loaded.ok) return loaded;
  if (!loaded.data) return Err(new Error("INSTALLATION_NOT_FOUND"));
  return Ok(loaded.data.workspaceId);
};

const parseAccount = (body: InstallationLifecyclePayload): Result<GithubAccountRef, Error> => {
  const account = body.installation?.account;
  if (
    !account ||
    typeof account.id !== "number" ||
    typeof account.login !== "string" ||
    (account.type !== "Organization" && account.type !== "User")
  ) {
    return Err(new Error("INSTALLATION_ACCOUNT_REQUIRED"));
  }
  return Ok({
    id: account.id,
    login: account.login,
    type: account.type,
  });
};

const parseRepositories = (
  repos: ReadonlyArray<{ id?: number; name?: string; full_name?: string }>,
): Array<GithubRepositoryRef> =>
  repos.flatMap((repo) => {
    if (typeof repo.id !== "number" || typeof repo.name !== "string") return [];
    const fullName = typeof repo.full_name === "string" ? repo.full_name : `unknown/${repo.name}`;
    const owner = fullName.split("/")[0];
    if (!owner) return [];
    return [{ id: repo.id, owner, name: repo.name, fullName }];
  });
