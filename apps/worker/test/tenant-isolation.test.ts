import { createWorkspaceStore, workspaceIdFromTrustedSource, type WorkspaceId } from "@aipm/db";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  budgetKey,
  coordinatorName,
  deliveryKey,
  installationTokenKey,
  llmCacheKey,
  mergeRegistryName,
} from "../src/tenancy/keys.js";
import {
  requireEnabledRepository,
  requireWorkspaceMember,
  resolveWorkspaceInstallation,
} from "../src/tenancy/guards.js";
import { createWorkspaceIngestMessage, parseWorkspaceIngestMessage } from "../src/messages.js";

const workspaceA = workspaceIdFromTrustedSource("isolation-a");
const workspaceB = workspaceIdFromTrustedSource("isolation-b");

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
  )
    .bind(
      workspaceA,
      "Isolation A",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
      workspaceB,
      "Isolation B",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    )
    .run();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO users
         (id, github_user_id, github_login, created_at, updated_at)
         VALUES ('user-a', 1001, 'user-a', ?, ?)`,
    ).bind("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO workspace_members
         (workspace_id, user_id, role, created_at) VALUES (?, 'user-a', 'owner', ?)`,
    ).bind(workspaceA, "2026-01-01T00:00:00Z"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO github_installations
         (workspace_id, installation_id, status, created_at, updated_at)
         VALUES (?, 7001, 'active', ?, ?)`,
    ).bind(workspaceA, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO github_installations
         (workspace_id, installation_id, status, created_at, updated_at)
         VALUES (?, 7002, 'suspended', ?, ?)`,
    ).bind(workspaceB, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO github_repositories
         (workspace_id, repository_id, installation_id, owner, name, full_name,
          enabled, status, created_at, updated_at)
         VALUES (?, 9001, 7001, 'same', 'repo', 'same/repo', 1, 'active', ?, ?)`,
    ).bind(workspaceA, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
  ]);
});

describe("workspace-scoped D1 store", () => {
  it("creates the control plane and legacy migration workspace", async () => {
    const legacy = await env.DB.prepare(`SELECT name FROM workspaces WHERE id = 'legacy'`).first<{
      name: string;
    }>();
    const columns = await env.DB.prepare(`PRAGMA table_info(threads)`).all<{ name: string }>();

    expect(legacy?.name).toBe("Legacy self-hosted workspace");
    expect(columns.results.map((column) => column.name)).toContain("workspace_id");
  });

  it("isolates identical engine identifiers across two workspaces", async () => {
    const a = createWorkspaceStore(env.DB, workspaceA);
    const b = createWorkspaceStore(env.DB, workspaceB);
    const identity = { id: "same-user", handles: { github: "same-handle" } };
    const thread = {
      platform: "github",
      nativeId: "same/repo#1",
      type: "issue" as const,
      state: "open",
      participants: ["same-user"],
      meta: {},
      timeline: [],
    };

    expect((await a.upsertIdentity({ ...identity, displayName: "Workspace A" })).ok).toBe(true);
    expect((await b.upsertIdentity({ ...identity, displayName: "Workspace B" })).ok).toBe(true);
    expect((await a.upsertThread({ ...thread, title: "Thread A" })).ok).toBe(true);
    expect((await b.upsertThread({ ...thread, title: "Thread B" })).ok).toBe(true);
    expect(
      (
        await a.upsertSignal({
          id: "same-signal",
          threadId: thread.nativeId,
          kind: "mentioned_no_response",
          detectedAt: "2026-01-01T00:00:00Z",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await b.upsertSignal({
          id: "same-signal",
          threadId: thread.nativeId,
          kind: "mentioned_no_response",
          detectedAt: "2026-01-02T00:00:00Z",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await a.upsertWorkingNotes({
          scope: "thread",
          targetId: thread.nativeId,
          content: "A",
          contentHash: "same-hash",
          provenance: "test",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await b.upsertWorkingNotes({
          scope: "thread",
          targetId: thread.nativeId,
          content: "B",
          contentHash: "same-hash",
          provenance: "test",
        })
      ).ok,
    ).toBe(true);

    expect((await a.getIdentity("same-user")).data?.displayName).toBe("Workspace A");
    expect((await b.getIdentity("same-user")).data?.displayName).toBe("Workspace B");
    expect((await a.getThread("github", thread.nativeId)).data?.title).toBe("Thread A");
    expect((await b.getThread("github", thread.nativeId)).data?.title).toBe("Thread B");
    expect((await a.listOpenSignals()).data?.[0]?.detectedAt).toBe("2026-01-01T00:00:00Z");
    expect((await b.listOpenSignals()).data?.[0]?.detectedAt).toBe("2026-01-02T00:00:00Z");
    expect((await a.getWorkingNotes("thread", thread.nativeId)).data?.content).toBe("A");
    expect((await b.getWorkingNotes("thread", thread.nativeId)).data?.content).toBe("B");

    expect((await a.deleteIdentity("same-user")).ok).toBe(true);
    expect((await a.getIdentity("same-user")).data).toBeUndefined();
    expect((await b.getIdentity("same-user")).data?.displayName).toBe("Workspace B");
  });

  it("isolates cluster membership with identical thread ids", async () => {
    const a = createWorkspaceStore(env.DB, workspaceA);
    const b = createWorkspaceStore(env.DB, workspaceB);
    const clusterA = await a.getOrCreateCluster("same/repo#cluster");
    const clusterB = await b.getOrCreateCluster("same/repo#cluster");

    expect(clusterA.ok && clusterB.ok).toBe(true);
    expect(clusterA.data).not.toBe(clusterB.data);
    expect((await a.listClusterThreads(clusterA.data!)).data).toEqual(["same/repo#cluster"]);
    expect((await b.listClusterThreads(clusterA.data!)).data).toEqual([]);
  });
});

describe("tenant key helpers", () => {
  const assertSeparated = (helper: (workspaceId: WorkspaceId) => string) => {
    expect(helper(workspaceA)).not.toBe(helper(workspaceB));
    expect(helper(workspaceA)).toContain(encodeURIComponent(workspaceA));
  };

  it("namespaces every external primitive by workspace", () => {
    assertSeparated((id) => deliveryKey(id, "same-delivery"));
    assertSeparated((id) => installationTokenKey(id, 42));
    assertSeparated((id) => budgetKey(id, "minute", "same-window"));
    assertSeparated((id) => llmCacheKey(id, "same-digest"));
    assertSeparated((id) => coordinatorName(id, "same-cluster"));
    assertSeparated(mergeRegistryName);
  });
});

describe("workspace guards", () => {
  it("rejects cross-workspace membership and repository access", async () => {
    const membershipA = await requireWorkspaceMember(env, workspaceA, "user-a");
    const membershipB = await requireWorkspaceMember(env, workspaceB, "user-a");
    expect(membershipA.ok).toBe(true);
    expect(membershipB.ok).toBe(false);

    const installation = await resolveWorkspaceInstallation(env, 7001);
    expect(installation.ok && installation.data.workspaceId).toBe(workspaceA);
    expect(
      (
        await requireEnabledRepository(
          env,
          { workspaceId: workspaceB, provenance: { kind: "scheduled" } },
          9001,
        )
      ).ok,
    ).toBe(false);
  });

  it("rejects suspended installations", async () => {
    const suspended = await resolveWorkspaceInstallation(env, 7002);
    expect(suspended.ok).toBe(false);
    if (!suspended.ok) expect(suspended.error.message).toBe("INSTALLATION_SUSPENDED");
  });
});

describe("workspace message envelope", () => {
  it("revalidates installation ownership while parsing", async () => {
    const message = createWorkspaceIngestMessage(
      {
        workspaceId: workspaceA,
        provenance: { kind: "github-installation", installationId: 7001 },
      },
      { platform: "github", installationId: 7001, payload: {} },
    );
    const accepted = await parseWorkspaceIngestMessage(
      message,
      async (installationId, workspaceId) => installationId === 7001 && workspaceId === workspaceA,
    );
    const rejected = await parseWorkspaceIngestMessage(message, async () => false);

    expect(accepted.ok).toBe(true);
    expect(rejected.ok).toBe(false);
  });

  it("rejects a crafted cross-workspace envelope", async () => {
    const crafted = {
      version: 1,
      workspaceId: workspaceB,
      installationId: 7001,
      event: { platform: "github", installationId: 7001, payload: {} },
    };
    const parsed = await parseWorkspaceIngestMessage(
      crafted,
      async (installationId, workspaceId) => installationId === 7001 && workspaceId === workspaceA,
    );

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toBe("INSTALLATION_WORKSPACE_MISMATCH");
  });
});
