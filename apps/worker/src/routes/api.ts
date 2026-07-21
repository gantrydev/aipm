import { buildConfig, type EngineConfigInput } from "@aipm/config";
import { installationTokenProvider, mintAppJwt } from "@aipm/adapter-github";
import { Err, Ok, Result } from "@aipm/core";
import {
  createWorkspaceForGithubAccount,
  enableWorkspaceCapability,
  ensureWorkspaceMember,
  findWorkspaceByGithubAccount,
  getWorkspaceConfig,
  listAuditActions,
  listGithubRepositories,
  listInstallationsForWorkspace,
  listWorkspacesForUser,
  setRepositoriesEnabled,
  upsertGithubInstallation,
  upsertGithubRepositories,
  upsertWorkspaceConfig,
  type GithubAccountRef,
  type GithubRepositoryRef,
  type ManagedCapability,
  type WorkspaceId,
} from "@aipm/db";
import { Hono } from "hono";
import type { Env } from "../env.js";
import { workspaceAudit } from "../tenancy/audit.js";
import { requireWorkspaceMemberByParam } from "../tenancy/guards.js";
import {
  CSRF_COOKIE,
  csrfCookieHeader,
  mintCsrfToken,
  readCookie,
  requireAuthedUser,
  requireCsrf,
} from "./auth.js";

export const apiRoutes = new Hono<{ Bindings: Env }>();

apiRoutes.get("/me", async (c) => {
  const user = await requireAuthedUser(c);
  if (!user.ok) return c.json({ error: "unauthenticated" }, 401);
  const workspaces = await listWorkspacesForUser(c.env.DB, user.data.userId);
  if (!workspaces.ok) return c.json({ error: "me_failed" }, 500);

  const existingCsrf = readCookie(c.req.header("cookie") ?? null, CSRF_COOKIE);
  const csrfToken = existingCsrf ?? mintCsrfToken();
  const payload = {
    user: { id: user.data.userId, githubLogin: user.data.githubLogin },
    workspaces: workspaces.data,
    slack: { available: false, status: "coming_next" as const },
    csrfToken,
  };
  const res = c.json(payload);
  if (!existingCsrf) res.headers.append("Set-Cookie", csrfCookieHeader(csrfToken));
  return res;
});

/** GitHub App setup URL landing: reconnect/create workspace from installation id. */
apiRoutes.get("/setup/github/callback", async (c) => {
  const user = await requireAuthedUser(c);
  if (!user.ok) {
    const publicBase = c.env.PUBLIC_BASE_URL ?? "";
    const site = c.env.SITE_ORIGIN ?? publicBase;
    const query = c.req.url.includes("?") ? c.req.url.slice(c.req.url.indexOf("?")) : "";
    const returnTo = encodeURIComponent(
      `${trimSlash(publicBase)}/api/setup/github/callback${query}`,
    );
    return c.redirect(`${trimSlash(site)}/login?returnTo=${returnTo}`, 302);
  }

  const installationIdRaw = c.req.query("installation_id");
  const installationId = installationIdRaw ? Number(installationIdRaw) : NaN;
  if (!Number.isFinite(installationId)) return c.json({ error: "installation_id_required" }, 400);

  const account = await fetchInstallationAccount(c.env, installationId);
  if (!account.ok) return c.json({ error: "installation_lookup_failed" }, 502);

  const existing = await findWorkspaceByGithubAccount(c.env.DB, account.data);
  if (!existing.ok) return c.json({ error: "workspace_lookup_failed" }, 500);

  const workspaceId: Result<WorkspaceId, Error> = existing.data
    ? Ok(existing.data)
    : await createWorkspaceForGithubAccount(c.env.DB, account.data);
  if (!workspaceId.ok) return c.json({ error: "workspace_create_failed" }, 500);

  const member = await ensureWorkspaceMember(c.env.DB, workspaceId.data, user.data.userId, "owner");
  if (!member.ok) return c.json({ error: "membership_failed" }, 500);

  const install = await upsertGithubInstallation(
    c.env.DB,
    workspaceId.data,
    installationId,
    "active",
  );
  if (!install.ok) return c.json({ error: "installation_record_failed" }, 500);

  // Best-effort repo sync; lifecycle webhooks remain source of truth (sibling-owned).
  const repos = await listInstallationRepositories(c.env, installationId);
  if (repos.ok && repos.data.length) {
    const written = await upsertGithubRepositories(
      c.env.DB,
      workspaceId.data,
      installationId,
      repos.data,
    );
    if (!written.ok) return c.json({ error: "repository_sync_failed" }, 500);
  }

  const site = c.env.SITE_ORIGIN ?? c.env.PUBLIC_BASE_URL;
  if (!site) return c.json({ workspaceId: workspaceId.data });
  return c.redirect(`${trimSlash(site)}/setup/repositories?workspace=${workspaceId.data}`, 302);
});

apiRoutes.get("/workspaces/:workspaceId/repositories", async (c) => {
  const gated = await authorizeWorkspace(c);
  if (!gated.ok) return gated.response;
  const repos = await listGithubRepositories(c.env.DB, gated.data.workspaceId);
  if (!repos.ok) return c.json({ error: "repositories_failed" }, 500);
  const installations = await listInstallationsForWorkspace(c.env.DB, gated.data.workspaceId);
  if (!installations.ok) return c.json({ error: "installations_failed" }, 500);
  return c.json({
    repositories: repos.data,
    installations: installations.data,
    shadowDefault: true,
  });
});

apiRoutes.put("/workspaces/:workspaceId/repositories", async (c) => {
  const csrf = requireCsrf(c);
  if (!csrf.ok) return c.json({ error: "csrf_required" }, 403);
  const gated = await authorizeWorkspace(c);
  if (!gated.ok) return gated.response;
  const body = await Result.from(() => c.req.json());
  if (!body.ok) return c.json({ error: "invalid_json" }, 400);
  const enabledIds = parseNumberArray(
    isRecord(body.data) ? body.data.enabledRepositoryIds : undefined,
  );
  if (!enabledIds.ok) return c.json({ error: "enabledRepositoryIds_required" }, 400);
  const updated = await setRepositoriesEnabled(c.env.DB, gated.data.workspaceId, enabledIds.data);
  if (!updated.ok) return c.json({ error: "repositories_update_failed" }, 500);
  const audited = await workspaceAudit(c.env, gated.data.workspaceId).append({
    action: "repositories.enabled_set",
    outcome: "revised",
    actor: {
      source: "control-plane",
      id: gated.data.userId,
      login: gated.data.githubLogin,
      kind: "user",
    },
    detail: { enabledRepositoryIds: enabledIds.data },
  });
  if (!audited.ok) return c.json({ error: "audit_failed" }, 500);
  const repos = await listGithubRepositories(c.env.DB, gated.data.workspaceId);
  if (!repos.ok) return c.json({ error: "repositories_failed" }, 500);
  return c.json({ repositories: repos.data });
});

apiRoutes.get("/workspaces/:workspaceId/config", async (c) => {
  const gated = await authorizeWorkspace(c);
  if (!gated.ok) return gated.response;
  const stored = await getWorkspaceConfig(c.env.DB, gated.data.workspaceId);
  if (!stored.ok) return c.json({ error: "config_failed" }, 500);
  const configRow = stored.data;
  const partial = configRow
    ? Result.fromSync(() => JSON.parse(configRow.configJson) as Partial<EngineConfigInput>)
    : Ok({ shadow: { global: true, capabilities: {} } });
  if (!partial.ok) return c.json({ error: "config_invalid" }, 500);
  const built = buildConfig(partial.data);
  if (!built.ok) return c.json({ error: "config_invalid" }, 500);
  return c.json({
    config: built.data,
    revision: configRow?.revision ?? 0,
    updatedAt: configRow?.updatedAt ?? null,
    updatedBy: configRow?.updatedBy ?? null,
    slack: { available: false, status: "coming_next" },
  });
});

apiRoutes.put("/workspaces/:workspaceId/config", async (c) => {
  const csrf = requireCsrf(c);
  if (!csrf.ok) return c.json({ error: "csrf_required" }, 403);
  const gated = await authorizeWorkspace(c);
  if (!gated.ok) return gated.response;
  const body = await Result.from(() => c.req.json());
  if (!body.ok || !isRecord(body.data)) return c.json({ error: "invalid_json" }, 400);
  const configInput =
    body.data.config !== undefined && isRecord(body.data.config) ? body.data.config : body.data;
  const built = buildConfig(configInput);
  if (!built.ok) return c.json({ error: "config_invalid", detail: String(built.error) }, 400);
  const shadowSafe = {
    ...built.data,
    shadow: {
      ...built.data.shadow,
      global: built.data.shadow.global,
    },
  };
  const configJson = Result.fromSync(() => JSON.stringify(shadowSafe));
  if (!configJson.ok) return c.json({ error: "config_serialize_failed" }, 500);
  const saved = await upsertWorkspaceConfig(
    c.env.DB,
    gated.data.workspaceId,
    configJson.data,
    gated.data.userId,
  );
  if (!saved.ok) return c.json({ error: "config_save_failed" }, 500);
  const audited = await workspaceAudit(c.env, gated.data.workspaceId).append({
    action: "config.updated",
    outcome: "revised",
    actor: {
      source: "control-plane",
      id: gated.data.userId,
      login: gated.data.githubLogin,
      kind: "user",
    },
    detail: { revision: saved.data.revision },
  });
  if (!audited.ok) return c.json({ error: "audit_failed" }, 500);
  return c.json({
    config: shadowSafe,
    revision: saved.data.revision,
    updatedAt: saved.data.updatedAt,
    updatedBy: saved.data.updatedBy,
  });
});

apiRoutes.post("/workspaces/:workspaceId/capabilities", async (c) => {
  const csrf = requireCsrf(c);
  if (!csrf.ok) return c.json({ error: "csrf_required" }, 403);
  const gated = await authorizeWorkspace(c);
  if (!gated.ok) return gated.response;
  const body = await Result.from(() => c.req.json());
  if (!body.ok || !isRecord(body.data)) return c.json({ error: "invalid_json" }, 400);
  const capability = body.data.capability;
  const shadow = body.data.shadow;
  if (typeof capability !== "string" || !isManagedCapability(capability)) {
    return c.json({ error: "capability_required" }, 400);
  }
  if (shadow !== false) {
    return c.json({ error: "only_go_live_supported" }, 400);
  }
  const revised = await enableWorkspaceCapability(c.env.DB, gated.data.workspaceId, capability, {
    source: "control-plane",
    id: gated.data.userId,
    login: gated.data.githubLogin,
    kind: "user",
  });
  if (!revised.ok) return c.json({ error: "capability_transition_failed" }, 500);
  return c.json({ capability, shadow: false, revision: revised.data });
});

apiRoutes.get("/workspaces/:workspaceId/activity", async (c) => {
  const gated = await authorizeWorkspace(c);
  if (!gated.ok) return gated.response;
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Number(limitRaw) : 50;
  const items = await listAuditActions(
    c.env.DB,
    gated.data.workspaceId,
    Number.isFinite(limit) ? limit : 50,
  );
  if (!items.ok) return c.json({ error: "activity_failed" }, 500);
  const repositoryIdRaw = c.req.query("repositoryId");
  const repositoryId = repositoryIdRaw ? Number(repositoryIdRaw) : undefined;
  const filtered =
    repositoryId !== undefined && Number.isFinite(repositoryId)
      ? items.data.filter((item) => item.repositoryId === repositoryId)
      : items.data;
  return c.json({ items: filtered });
});

apiRoutes.get("/workspaces/:workspaceId/activity/:actionId", async (c) => {
  const gated = await authorizeWorkspace(c);
  if (!gated.ok) return gated.response;
  const items = await listAuditActions(c.env.DB, gated.data.workspaceId, 250);
  if (!items.ok) return c.json({ error: "activity_failed" }, 500);
  const actionId = c.req.param("actionId");
  const item = items.data.find((entry) => entry.id === actionId);
  if (!item) return c.json({ error: "not_found" }, 404);
  return c.json({ item });
});

type AuthedWorkspace = {
  workspaceId: WorkspaceId;
  userId: string;
  githubLogin: string;
  role: "owner" | "admin" | "member";
};

const authorizeWorkspace = async (c: {
  env: Env;
  req: {
    param: (name: string) => string;
    header: (name: string) => string | undefined;
  };
}): Promise<{ ok: true; data: AuthedWorkspace } | { ok: false; response: Response }> => {
  const user = await requireAuthedUser(c);
  if (!user.ok) return { ok: false, response: jsonError({ error: "unauthenticated" }, 401) };
  const member = await requireWorkspaceMemberByParam(
    c.env,
    c.req.param("workspaceId"),
    user.data.userId,
  );
  if (!member.ok) return { ok: false, response: jsonError({ error: "forbidden" }, 403) };
  return {
    ok: true,
    data: {
      workspaceId: member.data.context.workspaceId,
      userId: user.data.userId,
      githubLogin: user.data.githubLogin,
      role: member.data.role,
    },
  };
};

const jsonError = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const fetchInstallationAccount = async (
  env: Env,
  installationId: number,
): Promise<Result<GithubAccountRef, Error>> => {
  if (!env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_CLIENT_ID) {
    return Err(new Error("GITHUB_APP_NOT_CONFIGURED"));
  }
  // TODO(lifecycle): prefer installation account fields persisted by webhook handlers when available.
  const jwt = await mintAppJwt(env.GITHUB_APP_PRIVATE_KEY, env.GITHUB_APP_CLIENT_ID);
  if (!jwt.ok) return jwt;
  const response = await Result.from(() =>
    fetch(`https://api.github.com/app/installations/${String(installationId)}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt.data}`,
        "User-Agent": "aipm-managed",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }),
  );
  if (!response.ok) return response;
  if (!response.data.ok) return Err(new Error("INSTALLATION_HTTP"));
  const body = await Result.from(() => response.data.json());
  if (!body.ok) return body;
  if (!isRecord(body.data) || !isRecord(body.data.account)) {
    return Err(new Error("INSTALLATION_ACCOUNT_MISSING"));
  }
  const account = body.data.account;
  if (
    typeof account.id !== "number" ||
    typeof account.login !== "string" ||
    (account.type !== "Organization" && account.type !== "User")
  ) {
    return Err(new Error("INSTALLATION_ACCOUNT_INVALID"));
  }
  return Ok({
    id: account.id,
    login: account.login,
    type: account.type,
  });
};

const listInstallationRepositories = async (
  env: Env,
  installationId: number,
): Promise<Result<Array<GithubRepositoryRef>, Error>> => {
  if (!env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_CLIENT_ID) return Ok([]);
  const token = await installationTokenProvider({
    kv: env.INSTALL_TOKENS,
    privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
    clientId: env.GITHUB_APP_CLIENT_ID,
    installationId,
  })();
  if (!token.ok) return Ok([]);
  const response = await Result.from(() =>
    fetch("https://api.github.com/installation/repositories?per_page=100", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token.data}`,
        "User-Agent": "aipm-managed",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }),
  );
  if (!response.ok || !response.data.ok) return Ok([]);
  const body = await Result.from(() => response.data.json());
  if (!body.ok || !isRecord(body.data) || !Array.isArray(body.data.repositories)) return Ok([]);
  return Ok(
    body.data.repositories.flatMap((repo) => {
      if (!isRecord(repo)) return [];
      if (typeof repo.id !== "number" || typeof repo.name !== "string") return [];
      const fullName = typeof repo.full_name === "string" ? repo.full_name : `unknown/${repo.name}`;
      const owner = fullName.split("/")[0];
      if (!owner) return [];
      return [{ id: repo.id, owner, name: repo.name, fullName }];
    }),
  );
};

const parseNumberArray = (value: unknown): Result<Array<number>, Error> => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) {
    return Err(new Error("INVALID_NUMBER_ARRAY"));
  }
  return Ok(value);
};

const isManagedCapability = (value: string): value is ManagedCapability =>
  value === "workingNotes" ||
  value === "nudges" ||
  value === "digest" ||
  value === "proposals" ||
  value === "orgRollup";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const trimSlash = (value: string) => value.replace(/\/+$/, "");
