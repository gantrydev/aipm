import { listActiveSweepRepositories, workspaceIdFromTrustedSource } from "@aipm/db";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createUserSession,
  hashToken,
  mintOAuthState,
  resolveSessionToken,
  revokeSessionToken,
  verifyOAuthState,
} from "../src/auth/index.js";
import { resolveWorkspaceInstallation } from "../src/tenancy/guards.js";
import { handleGithubInstallationLifecycle } from "../src/tenancy/lifecycle.js";
import { listSweepRepositories } from "../src/tenancy/sweeps.js";
import { mergeRegistryName, coordinatorName, deliveryKey } from "../src/tenancy/keys.js";

describe("github installation lifecycle", () => {
  it("creates a workspace and persists repositories on installation.created", async () => {
    const handled = await handleGithubInstallationLifecycle(env, "installation", {
      action: "created",
      installation: {
        id: 8101,
        account: { id: 55001, login: "acme", type: "Organization" },
      },
      repositories: [
        { id: 9101, name: "web", full_name: "acme/web" },
        { id: 9102, name: "api", full_name: "acme/api" },
      ],
    });
    expect(handled.ok).toBe(true);
    if (!handled.ok) throw handled.error;

    const installation = await resolveWorkspaceInstallation(env, 8101);
    expect(installation.ok).toBe(true);
    if (!installation.ok) throw installation.error;
    expect(installation.data.workspaceId).toBe(handled.data.workspaceId);

    const repos = await env.DB.prepare(
      `SELECT full_name, enabled, status FROM github_repositories
       WHERE workspace_id = ? ORDER BY full_name`,
    )
      .bind(handled.data.workspaceId)
      .all<{ full_name: string; enabled: number; status: string }>();
    expect(repos.results).toEqual([
      { full_name: "acme/api", enabled: 0, status: "active" },
      { full_name: "acme/web", enabled: 0, status: "active" },
    ]);
  });

  it("reconnects the same workspace across reinstalls via github account id", async () => {
    const first = await handleGithubInstallationLifecycle(env, "installation", {
      action: "created",
      installation: {
        id: 8201,
        account: { id: 55002, login: "reconnect-co", type: "Organization" },
      },
      repositories: [{ id: 9201, name: "app", full_name: "reconnect-co/app" }],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;

    const deleted = await handleGithubInstallationLifecycle(env, "installation", {
      action: "deleted",
      installation: {
        id: 8201,
        account: { id: 55002, login: "reconnect-co", type: "Organization" },
      },
    });
    expect(deleted.ok).toBe(true);

    const second = await handleGithubInstallationLifecycle(env, "installation", {
      action: "created",
      installation: {
        id: 8202,
        account: { id: 55002, login: "reconnect-co", type: "Organization" },
      },
      repositories: [{ id: 9201, name: "app", full_name: "reconnect-co/app" }],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw second.error;
    expect(second.data.workspaceId).toBe(first.data.workspaceId);
  });

  it("rejects suspended installations and restores them on unsuspend", async () => {
    const created = await handleGithubInstallationLifecycle(env, "installation", {
      action: "created",
      installation: {
        id: 8301,
        account: { id: 55003, login: "suspend-co", type: "Organization" },
      },
    });
    expect(created.ok).toBe(true);

    const suspended = await handleGithubInstallationLifecycle(env, "installation", {
      action: "suspend",
      installation: { id: 8301 },
    });
    expect(suspended.ok).toBe(true);
    expect((await resolveWorkspaceInstallation(env, 8301)).ok).toBe(false);

    const unsuspended = await handleGithubInstallationLifecycle(env, "installation", {
      action: "unsuspend",
      installation: { id: 8301 },
    });
    expect(unsuspended.ok).toBe(true);
    expect((await resolveWorkspaceInstallation(env, 8301)).ok).toBe(true);
  });

  it("adds and removes repositories from an installation", async () => {
    const created = await handleGithubInstallationLifecycle(env, "installation", {
      action: "created",
      installation: {
        id: 8401,
        account: { id: 55004, login: "repos-co", type: "Organization" },
      },
      repositories: [{ id: 9401, name: "one", full_name: "repos-co/one" }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    const added = await handleGithubInstallationLifecycle(env, "installation_repositories", {
      action: "added",
      installation: {
        id: 8401,
        account: { id: 55004, login: "repos-co", type: "Organization" },
      },
      repositories_added: [{ id: 9402, name: "two", full_name: "repos-co/two" }],
    });
    expect(added.ok).toBe(true);

    const removed = await handleGithubInstallationLifecycle(env, "installation_repositories", {
      action: "removed",
      installation: {
        id: 8401,
        account: { id: 55004, login: "repos-co", type: "Organization" },
      },
      repositories_removed: [{ id: 9401, name: "one", full_name: "repos-co/one" }],
    });
    expect(removed.ok).toBe(true);

    const rows = await env.DB.prepare(
      `SELECT repository_id, status, enabled FROM github_repositories
       WHERE workspace_id = ? ORDER BY repository_id`,
    )
      .bind(created.data.workspaceId)
      .all<{ repository_id: number; status: string; enabled: number }>();
    expect(rows.results).toEqual([
      { repository_id: 9401, status: "removed", enabled: 0 },
      { repository_id: 9402, status: "active", enabled: 0 },
    ]);
  });
});

describe("tenant-scoped sweeps", () => {
  beforeAll(async () => {
    const workspaceId = workspaceIdFromTrustedSource("sweep-ws");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at)
         VALUES (?, 'Sweep', ?, ?)`,
      ).bind(workspaceId, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
      env.DB.prepare(
        `INSERT OR IGNORE INTO github_installations
           (workspace_id, installation_id, status, created_at, updated_at)
         VALUES (?, 8501, 'active', ?, ?)`,
      ).bind(workspaceId, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
      env.DB.prepare(
        `INSERT OR IGNORE INTO github_repositories
           (workspace_id, repository_id, installation_id, owner, name, full_name,
            enabled, status, created_at, updated_at)
         VALUES (?, 9501, 8501, 'sweep', 'live', 'sweep/live', 1, 'active', ?, ?)`,
      ).bind(workspaceId, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
      env.DB.prepare(
        `INSERT OR IGNORE INTO github_repositories
           (workspace_id, repository_id, installation_id, owner, name, full_name,
            enabled, status, created_at, updated_at)
         VALUES (?, 9502, 8501, 'sweep', 'shadow', 'sweep/shadow', 0, 'active', ?, ?)`,
      ).bind(workspaceId, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    ]);
  });

  it("lists only enabled active repositories from D1", async () => {
    const listed = await listActiveSweepRepositories(env.DB);
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw listed.error;
    const mine = listed.data.filter((row) => row.installationId === 8501);
    expect(mine).toEqual([
      {
        workspaceId: "sweep-ws",
        repositoryId: 9501,
        installationId: 8501,
        owner: "sweep",
        name: "live",
        fullName: "sweep/live",
      },
    ]);

    const viaHelper = await listSweepRepositories({ ...env, SWEEP_REPOS: undefined });
    expect(viaHelper.ok).toBe(true);
    if (!viaHelper.ok) throw viaHelper.error;
    expect(viaHelper.data.some((row) => row.name === "live")).toBe(true);
    expect(viaHelper.data.some((row) => row.name === "shadow")).toBe(false);
  });
});

describe("session auth primitives", () => {
  it("creates, resolves, and revokes opaque hashed sessions", async () => {
    const created = await createUserSession(env, {
      githubUserId: 42,
      githubLogin: "octocat",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    const resolved = await resolveSessionToken(env, created.data.token);
    expect(resolved.ok && resolved.data?.githubLogin).toBe("octocat");

    const idHash = await hashToken(created.data.token);
    const sessionRow = await env.DB.prepare(`SELECT user_id FROM sessions WHERE id_hash = ?`)
      .bind(idHash)
      .first<{ user_id: string }>();
    expect(sessionRow?.user_id).toBe(created.data.user.id);

    const revoked = await revokeSessionToken(env, created.data.token);
    expect(revoked.ok).toBe(true);
    const after = await resolveSessionToken(env, created.data.token);
    expect(after.ok && after.data).toBeUndefined();
  });

  it("validates oauth state cookies against the query token", () => {
    const minted = mintOAuthState("/setup/github");
    expect(verifyOAuthState(minted.token, minted.token).ok).toBe(true);
    expect(verifyOAuthState(minted.token, "tampered").ok).toBe(false);
    expect(verifyOAuthState(undefined, minted.token).ok).toBe(false);
  });
});

describe("durable object key namespacing", () => {
  it("keeps coordinator and merge registry names workspace-local", () => {
    const a = workspaceIdFromTrustedSource("do-a");
    const b = workspaceIdFromTrustedSource("do-b");
    expect(coordinatorName(a, "cluster-1")).not.toBe(coordinatorName(b, "cluster-1"));
    expect(mergeRegistryName(a)).not.toBe(mergeRegistryName(b));
    expect(deliveryKey(a, "gh:1")).not.toBe(deliveryKey(b, "gh:1"));
  });
});
