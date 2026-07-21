import {
  createSession,
  createWorkspaceForGithubAccount,
  ensureWorkspaceMember,
  upsertGithubInstallation,
  upsertGithubRepositories,
  upsertUserFromGithub,
  workspaceIdFromTrustedSource,
} from "@aipm/db";
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createUserSession, hashToken } from "../src/auth/session.js";
import { CSRF_COOKIE, CSRF_HEADER, mintCsrfToken } from "../src/routes/auth.js";

const workspaceA = workspaceIdFromTrustedSource("cp-a");
const workspaceB = workspaceIdFromTrustedSource("cp-b");
const now = "2026-01-01T00:00:00.000Z";

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO workspaces
         (id, github_account_id, github_account_type, github_account_login, name, created_at, updated_at)
       VALUES (?, 11, 'Organization', 'org-a', 'Org A', ?, ?)`,
    ).bind(workspaceA, now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO workspaces
         (id, github_account_id, github_account_type, github_account_login, name, created_at, updated_at)
       VALUES (?, 22, 'Organization', 'org-b', 'Org B', ?, ?)`,
    ).bind(workspaceB, now, now),
  ]);

  const userA = await upsertUserFromGithub(env.DB, 501, "alice", "user-alice");
  const userB = await upsertUserFromGithub(env.DB, 502, "bob", "user-bob");
  expect(userA.ok).toBe(true);
  expect(userB.ok).toBe(true);

  expect((await ensureWorkspaceMember(env.DB, workspaceA, "user-alice", "owner")).ok).toBe(true);
  expect((await ensureWorkspaceMember(env.DB, workspaceB, "user-bob", "owner")).ok).toBe(true);
  expect((await upsertGithubInstallation(env.DB, workspaceA, 8001, "active")).ok).toBe(true);
  expect(
    (
      await upsertGithubRepositories(env.DB, workspaceA, 8001, [
        { id: 9001, owner: "org-a", name: "repo", fullName: "org-a/repo" },
      ])
    ).ok,
  ).toBe(true);
});

const sessionCookie = async (userId: string, githubUserId: number, login: string) => {
  const session = await createUserSession(env, {
    userId,
    githubUserId,
    githubLogin: login,
  });
  expect(session.ok).toBe(true);
  if (!session.ok) throw session.error;
  return `aipm_session=${session.data.token}`;
};

describe("auth sessions", () => {
  it("stores opaque sessions hashed and resolves the user", async () => {
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const idHash = await hashToken(token);
    const created = await createSession(
      env.DB,
      idHash,
      "user-alice",
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(created.ok).toBe(true);

    const rows = await env.DB.prepare(`SELECT id_hash FROM sessions WHERE user_id = ?`)
      .bind("user-alice")
      .all<{ id_hash: string }>();
    expect(rows.results?.some((row) => row.id_hash === idHash)).toBe(true);
    expect(rows.results?.some((row) => row.id_hash === token)).toBe(false);
  });

  it("rejects /api/me without a session", async () => {
    const res = await SELF.fetch("https://example.com/api/me");
    expect(res.status).toBe(401);
  });

  it("returns the authed user and workspaces from /api/me", async () => {
    const cookie = await sessionCookie("user-alice", 501, "alice");
    const res = await SELF.fetch("https://example.com/api/me", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { githubLogin: string };
      workspaces: Array<{ id: string }>;
      slack: { status: string };
      csrfToken: string;
    };
    expect(body.user.githubLogin).toBe("alice");
    expect(body.workspaces.map((w) => w.id)).toContain(workspaceA);
    expect(body.workspaces.map((w) => w.id)).not.toContain(workspaceB);
    expect(body.slack.status).toBe("coming_next");
    expect(body.csrfToken.length).toBeGreaterThan(8);
  });

  it("requires CSRF for logout", async () => {
    const cookie = await sessionCookie("user-alice", 501, "alice");
    const denied = await SELF.fetch("https://example.com/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(denied.status).toBe(403);

    const csrf = mintCsrfToken();
    const allowed = await SELF.fetch("https://example.com/auth/logout", {
      method: "POST",
      headers: {
        cookie: `${cookie}; ${CSRF_COOKIE}=${csrf}`,
        [CSRF_HEADER]: csrf,
      },
    });
    expect(allowed.status).toBe(200);
  });
});

describe("control-plane authorization", () => {
  it("forbids reading another workspace repositories", async () => {
    const cookie = await sessionCookie("user-alice", 501, "alice");
    const res = await SELF.fetch(`https://example.com/api/workspaces/${workspaceB}/repositories`, {
      headers: { cookie },
    });
    expect(res.status).toBe(403);
  });

  it("allows a member to list their own repositories", async () => {
    const cookie = await sessionCookie("user-alice", 501, "alice");
    const res = await SELF.fetch(`https://example.com/api/workspaces/${workspaceA}/repositories`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repositories: Array<{ fullName: string; enabled: boolean }>;
      shadowDefault: boolean;
    };
    expect(body.shadowDefault).toBe(true);
    expect(body.repositories[0]?.fullName).toBe("org-a/repo");
    expect(body.repositories[0]?.enabled).toBe(false);
  });

  it("requires CSRF to mutate repositories and keeps cross-tenant isolation", async () => {
    const cookie = await sessionCookie("user-alice", 501, "alice");
    const csrf = mintCsrfToken();
    const denied = await SELF.fetch(
      `https://example.com/api/workspaces/${workspaceA}/repositories`,
      {
        method: "PUT",
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabledRepositoryIds: [9001] }),
      },
    );
    expect(denied.status).toBe(403);

    const cross = await SELF.fetch(
      `https://example.com/api/workspaces/${workspaceB}/repositories`,
      {
        method: "PUT",
        headers: {
          cookie: `${cookie}; ${CSRF_COOKIE}=${csrf}`,
          [CSRF_HEADER]: csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabledRepositoryIds: [9001] }),
      },
    );
    expect(cross.status).toBe(403);

    const ok = await SELF.fetch(`https://example.com/api/workspaces/${workspaceA}/repositories`, {
      method: "PUT",
      headers: {
        cookie: `${cookie}; ${CSRF_COOKIE}=${csrf}`,
        [CSRF_HEADER]: csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ enabledRepositoryIds: [9001] }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { repositories: Array<{ enabled: boolean }> };
    expect(body.repositories[0]?.enabled).toBe(true);
  });

  it("returns shadow-first config and blocks foreign workspace config reads", async () => {
    const cookie = await sessionCookie("user-alice", 501, "alice");
    const forbidden = await SELF.fetch(`https://example.com/api/workspaces/${workspaceB}/config`, {
      headers: { cookie },
    });
    expect(forbidden.status).toBe(403);

    // Trigger inserts default shadow config for non-legacy workspaces (migration 0006).
    const created = await createWorkspaceForGithubAccount(env.DB, {
      id: 33,
      login: "org-c",
      type: "Organization",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;
    expect((await ensureWorkspaceMember(env.DB, created.data, "user-alice", "owner")).ok).toBe(
      true,
    );

    const res = await SELF.fetch(`https://example.com/api/workspaces/${created.data}/config`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: { shadow: { global: boolean } };
      slack: { status: string };
    };
    expect(body.config.shadow.global).toBe(true);
    expect(body.slack.status).toBe("coming_next");
  });
});
