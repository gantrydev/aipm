import { EchoLlmAdapter, LlmBudgetExceededError } from "@aipm/adapter-llm";
import {
  appendAuditAction,
  enableWorkspaceCapability,
  listAuditActions,
  offboardWorkspace,
  workspaceIdFromTrustedSource,
} from "@aipm/db";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { consumeWorkspaceRateBudget, createWorkspaceBudgetedLlm } from "../src/tenancy/budgets.js";

const now = "2026-07-21T12:00:00.000Z";

describe("public-free audit safeguards", () => {
  it("defaults managed workspaces to shadow and records immutable outcomes", async () => {
    const workspace = workspaceIdFromTrustedSource(`audit-${crypto.randomUUID()}`);
    await insertWorkspace(workspace);

    const config = await env.DB.prepare(
      `SELECT config_json, revision FROM workspace_config WHERE workspace_id = ?`,
    )
      .bind(workspace)
      .first<{ config_json: string; revision: number }>();
    expect(JSON.parse(config!.config_json)).toMatchObject({ shadow: { global: true } });

    for (const outcome of [
      "preview",
      "attempted",
      "sent",
      "skipped",
      "suppressed",
      "failed",
    ] as const) {
      const recorded = await appendAuditAction(env.DB, workspace, {
        action: "working_note",
        outcome,
        actor: { source: "worker", kind: "service" },
        detail: { outcome },
        createdAt: now,
      });
      expect(recorded.ok).toBe(true);
    }

    const actions = await listAuditActions(env.DB, workspace);
    expect(actions.ok && actions.data.map((action) => action.outcome).sort()).toEqual(
      ["attempted", "failed", "preview", "sent", "skipped", "suppressed"].sort(),
    );
    await expect(
      env.DB.prepare(`UPDATE audit_actions SET outcome = 'sent' WHERE workspace_id = ?`)
        .bind(workspace)
        .run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      env.DB.prepare(`DELETE FROM audit_actions WHERE workspace_id = ?`).bind(workspace).run(),
    ).rejects.toThrow(/immutable/);
  });

  it("records a capability-level go-live revision", async () => {
    const workspace = workspaceIdFromTrustedSource(`live-${crypto.randomUUID()}`);
    await insertWorkspace(workspace);

    const enabled = await enableWorkspaceCapability(env.DB, workspace, "workingNotes", {
      source: "control-plane",
      kind: "user",
      id: "user-1",
      login: "maintainer",
    });
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) throw enabled.error;
    expect(enabled.data).toBe(2);

    const config = await env.DB.prepare(
      `SELECT config_json, revision FROM workspace_config WHERE workspace_id = ?`,
    )
      .bind(workspace)
      .first<{ config_json: string; revision: number }>();
    expect(config?.revision).toBe(2);
    expect(JSON.parse(config!.config_json)).toMatchObject({
      shadow: { global: true, capabilities: { workingNotes: false } },
    });
    const actions = await listAuditActions(env.DB, workspace);
    expect(actions.ok && actions.data[0]).toMatchObject({
      action: "capability.go_live",
      outcome: "revised",
      detail: { capability: "workingNotes", previousRevision: 1, revision: 2 },
    });
  });
});

describe("workspace offboarding", () => {
  it("disables access, removes credentials, then deletes tenant-owned rows", async () => {
    const workspace = workspaceIdFromTrustedSource(`offboard-${crypto.randomUUID()}`);
    await insertWorkspace(workspace);
    await env.DB.prepare(
      `INSERT INTO github_installations (
         workspace_id, installation_id, status, created_at, updated_at
       ) VALUES (?, ?, 'active', ?, ?)`,
    )
      .bind(workspace, 81001, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO github_repositories (
         workspace_id, repository_id, installation_id, owner, name, full_name,
         enabled, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'same', 'repo', 'same/repo', 1, 'active', ?, ?)`,
    )
      .bind(workspace, 91001, 81001, now, now)
      .run();
    await appendAuditAction(env.DB, workspace, {
      action: "workspace.offboard",
      outcome: "attempted",
      actor: { source: "control-plane", kind: "user", id: "owner" },
    });

    const removed: number[] = [];
    const result = await offboardWorkspace(env.DB, workspace, {
      deleteInstallationCredential: async (installationId) => {
        const status = await env.DB.prepare(
          `SELECT status FROM github_installations
           WHERE workspace_id = ? AND installation_id = ?`,
        )
          .bind(workspace, installationId)
          .first<{ status: string }>();
        expect(status?.status).toBe("deleted");
        removed.push(installationId);
      },
    });
    expect(result.ok).toBe(true);
    expect(removed).toEqual([81001]);
    expect(
      await env.DB.prepare(`SELECT id FROM workspaces WHERE id = ?`).bind(workspace).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(`SELECT id FROM audit_actions WHERE workspace_id = ?`)
        .bind(workspace)
        .first(),
    ).toBeNull();
  });
});

describe("workspace safety ceiling isolation", () => {
  it("exhausting one tenant's rate and AI budget does not block another", async () => {
    const workspaceA = workspaceIdFromTrustedSource("budget-a");
    const workspaceB = workspaceIdFromTrustedSource("budget-b");
    const map = new Map<string, string>();
    const fakeEnv = {
      DELIVERY_DEDUPE: {
        get: async (key: string) => map.get(key) ?? null,
        put: async (key: string, value: string) => {
          map.set(key, value);
        },
      },
      LLM_PER_MINUTE_BUDGET: "1",
      LLM_DAILY_BUDGET: "10",
      GLOBAL_LLM_PER_MINUTE_HARD_CEILING: "10",
      GLOBAL_LLM_DAILY_HARD_CEILING: "100",
      TENANT_RATE_PER_MINUTE_CEILING: "1",
      GLOBAL_RATE_PER_MINUTE_HARD_CEILING: "10",
    } as unknown as Env;

    const a = createWorkspaceBudgetedLlm(new EchoLlmAdapter(), fakeEnv, workspaceA);
    const b = createWorkspaceBudgetedLlm(new EchoLlmAdapter(), fakeEnv, workspaceB);
    expect((await a.complete("a")).ok).toBe(true);
    const exhausted = await a.complete("again");
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.error).toBeInstanceOf(LlmBudgetExceededError);
    expect((await b.complete("b")).ok).toBe(true);

    const at = new Date(now);
    expect((await consumeWorkspaceRateBudget(fakeEnv, workspaceA, at)).data).toEqual({
      allowed: true,
    });
    expect((await consumeWorkspaceRateBudget(fakeEnv, workspaceA, at)).data).toEqual({
      allowed: false,
      exhausted: "tenant",
    });
    expect((await consumeWorkspaceRateBudget(fakeEnv, workspaceB, at)).data).toEqual({
      allowed: true,
    });
    expect([...map.keys()].some((key) => key.includes("budget-a"))).toBe(true);
    expect([...map.keys()].some((key) => key.includes("budget-b"))).toBe(true);
  });

  it("enforces the deployment-wide hard ceiling across tenants", async () => {
    const map = new Map<string, string>();
    const fakeEnv = {
      DELIVERY_DEDUPE: {
        get: async (key: string) => map.get(key) ?? null,
        put: async (key: string, value: string) => {
          map.set(key, value);
        },
      },
      LLM_PER_MINUTE_BUDGET: "10",
      LLM_DAILY_BUDGET: "100",
      GLOBAL_LLM_PER_MINUTE_HARD_CEILING: "1",
      GLOBAL_LLM_DAILY_HARD_CEILING: "100",
    } as unknown as Env;
    const workspaceA = workspaceIdFromTrustedSource("global-a");
    const workspaceB = workspaceIdFromTrustedSource("global-b");

    expect(
      (await createWorkspaceBudgetedLlm(new EchoLlmAdapter(), fakeEnv, workspaceA).complete("a"))
        .ok,
    ).toBe(true);
    const blocked = await createWorkspaceBudgetedLlm(
      new EchoLlmAdapter(),
      fakeEnv,
      workspaceB,
    ).complete("b");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toBeInstanceOf(LlmBudgetExceededError);
    expect([...map.keys()].some((key) => key.startsWith("global-budget:llm:"))).toBe(true);
  });
});

async function insertWorkspace(workspaceId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(workspaceId, workspaceId, now, now)
    .run();
}
