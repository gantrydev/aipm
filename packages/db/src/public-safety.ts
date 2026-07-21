import { Err, Ok, Result, findMap } from "@aipm/core";
import type { WorkspaceId } from "./workspace.js";

export const auditOutcomes = [
  "preview",
  "attempted",
  "sent",
  "skipped",
  "suppressed",
  "failed",
  "revised",
] as const;

export type AuditOutcome = (typeof auditOutcomes)[number];
export type AuditSource = "github" | "control-plane" | "worker" | "scheduler" | "system";

export interface AuditActor {
  readonly source: AuditSource;
  readonly id?: string;
  readonly login?: string;
  readonly kind?: "user" | "installation" | "service";
}

export interface AuditAction {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly repositoryId?: number;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly actor: AuditActor;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface AppendAuditAction {
  readonly id?: string;
  readonly repositoryId?: number;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly actor: AuditActor;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly createdAt?: string;
}

/** Append-only audit boundary. No update/delete API is exposed. */
export async function appendAuditAction(
  db: D1Database,
  workspaceId: WorkspaceId,
  entry: AppendAuditAction,
): Promise<Result<AuditAction, Error>> {
  const action: AuditAction = {
    id: entry.id ?? crypto.randomUUID(),
    workspaceId,
    ...(entry.repositoryId === undefined ? {} : { repositoryId: entry.repositoryId }),
    action: entry.action,
    outcome: entry.outcome,
    actor: entry.actor,
    detail: entry.detail ?? {},
    createdAt: entry.createdAt ?? new Date().toISOString(),
  };
  const serialized = serializeAudit(action);
  if (!serialized.ok) return serialized;
  const written = await Result.from(() =>
    db
      .prepare(
        `INSERT INTO audit_actions (
           workspace_id, id, repository_id, action, outcome,
           actor_json, detail_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        workspaceId,
        action.id,
        action.repositoryId ?? null,
        action.action,
        action.outcome,
        serialized.data.actor,
        serialized.data.detail,
        action.createdAt,
      )
      .run(),
  );
  if (!written.ok) return written;
  return Ok(action);
}

export async function listAuditActions(
  db: D1Database,
  workspaceId: WorkspaceId,
  limit = 100,
): Promise<Result<Array<AuditAction>, Error>> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 250));
  const loaded = await Result.from(() =>
    db
      .prepare(
        `SELECT id, repository_id, action, outcome, actor_json, detail_json, created_at
         FROM audit_actions
         WHERE workspace_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(workspaceId, safeLimit)
      .all<AuditRow>(),
  );
  if (!loaded.ok) return loaded;
  const parsed = loaded.data.results.map((row) => parseAuditRow(workspaceId, row));
  const firstError = findMap(parsed, (result) =>
    result.ok ? { kind: "CONTINUE" as const } : { kind: "FOUND" as const, data: result },
  );
  if (firstError) return firstError;
  return Ok(parsed.flatMap((result) => (result.ok ? [result.data] : [])));
}

export type ManagedCapability = "workingNotes" | "nudges" | "digest" | "proposals" | "orgRollup";

/**
 * Explicitly transitions one capability live and records the config revision
 * in the same D1 batch. Unknown config fields are preserved.
 */
export async function enableWorkspaceCapability(
  db: D1Database,
  workspaceId: WorkspaceId,
  capability: ManagedCapability,
  actor: AuditActor,
): Promise<Result<number, Error>> {
  const loaded = await Result.from(() =>
    db
      .prepare(`SELECT config_json, revision FROM workspace_config WHERE workspace_id = ?`)
      .bind(workspaceId)
      .first<{ config_json: string; revision: number }>(),
  );
  if (!loaded.ok) return loaded;
  if (!loaded.data) return Err(new Error("WORKSPACE_CONFIG_REQUIRED"));
  const parsed = parseConfig(loaded.data.config_json);
  if (!parsed.ok) return parsed;

  const previousRevision = loaded.data.revision;
  const revision = previousRevision + 1;
  const config = {
    ...parsed.data,
    shadow: {
      ...asRecord(parsed.data.shadow),
      global: asRecord(parsed.data.shadow).global ?? true,
      capabilities: {
        ...asRecord(asRecord(parsed.data.shadow).capabilities),
        [capability]: false,
      },
    },
  };
  const audit: AuditAction = {
    id: crypto.randomUUID(),
    workspaceId,
    action: "capability.go_live",
    outcome: "revised",
    actor,
    detail: { capability, previousRevision, revision },
    createdAt: new Date().toISOString(),
  };
  const serialized = serializeAudit(audit);
  if (!serialized.ok) return serialized;
  const configJson = Result.fromSync(() => JSON.stringify(config));
  if (!configJson.ok) return configJson;

  const written = await Result.from(() =>
    db.batch([
      db
        .prepare(
          `UPDATE workspace_config
           SET config_json = ?, revision = ?, updated_by = ?, updated_at = ?
           WHERE workspace_id = ? AND revision = ?`,
        )
        .bind(
          configJson.data,
          revision,
          actor.id ?? actor.source,
          audit.createdAt,
          workspaceId,
          previousRevision,
        ),
      db
        .prepare(
          `INSERT INTO audit_actions (
             workspace_id, id, repository_id, action, outcome,
             actor_json, detail_json, created_at
           ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .bind(
          workspaceId,
          audit.id,
          audit.action,
          audit.outcome,
          serialized.data.actor,
          serialized.data.detail,
          audit.createdAt,
        ),
    ]),
  );
  if (!written.ok) return written;
  if (written.data[0]?.meta.changes !== 1) return Err(new Error("CONFIG_REVISION_CONFLICT"));
  return Ok(revision);
}

export interface WorkspaceCredentialRemover {
  deleteInstallationCredential(installationId: number): Promise<void>;
  deleteWorkspaceCredentials?(workspaceId: WorkspaceId): Promise<void>;
}

/**
 * Offboards in fail-safe order: installations/repositories are disabled first,
 * credentials are removed second, and workspace-owned D1 rows are removed last.
 * A credential failure leaves the workspace disabled and safe to retry.
 */
export async function offboardWorkspace(
  db: D1Database,
  workspaceId: WorkspaceId,
  credentials: WorkspaceCredentialRemover,
): Promise<Result<void, Error>> {
  const installations = await Result.from(() =>
    db
      .prepare(`SELECT installation_id FROM github_installations WHERE workspace_id = ?`)
      .bind(workspaceId)
      .all<{ installation_id: number }>(),
  );
  if (!installations.ok) return installations;

  const disabled = await Result.from(() =>
    db.batch([
      db
        .prepare(
          `UPDATE github_installations
           SET status = 'deleted', updated_at = ?
           WHERE workspace_id = ?`,
        )
        .bind(new Date().toISOString(), workspaceId),
      db
        .prepare(
          `UPDATE github_repositories
           SET enabled = 0, status = 'removed', updated_at = ?
           WHERE workspace_id = ?`,
        )
        .bind(new Date().toISOString(), workspaceId),
    ]),
  );
  if (!disabled.ok) return disabled;

  const removedCredentials = await Result.from(async () => {
    await Promise.all(
      installations.data.results.map(({ installation_id }) =>
        credentials.deleteInstallationCredential(installation_id),
      ),
    );
    await credentials.deleteWorkspaceCredentials?.(workspaceId);
  });
  if (!removedCredentials.ok) return removedCredentials;

  const removedData = await Result.from(() =>
    db.prepare(`DELETE FROM workspaces WHERE id = ?`).bind(workspaceId).run(),
  );
  if (!removedData.ok) return removedData;
  return Ok(undefined);
}

interface AuditRow {
  id: string;
  repository_id: number | null;
  action: string;
  outcome: string;
  actor_json: string;
  detail_json: string;
  created_at: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const parseConfig = (raw: string): Result<Record<string, unknown>, Error> => {
  const parsed = Result.fromSync(() => JSON.parse(raw) as unknown);
  if (!parsed.ok) return parsed;
  if (Object.keys(asRecord(parsed.data)).length === 0 && parsed.data !== null) {
    return Err(new Error("INVALID_WORKSPACE_CONFIG"));
  }
  return Ok(asRecord(parsed.data));
};

const serializeAudit = (action: AuditAction): Result<{ actor: string; detail: string }, Error> => {
  const actor = Result.fromSync(() => JSON.stringify(action.actor));
  if (!actor.ok) return actor;
  const detail = Result.fromSync(() => JSON.stringify(action.detail));
  if (!detail.ok) return detail;
  return Ok({ actor: actor.data, detail: detail.data });
};

const parseAuditRow = (workspaceId: WorkspaceId, row: AuditRow): Result<AuditAction, Error> => {
  const actor = Result.fromSync(() => JSON.parse(row.actor_json) as AuditActor);
  if (!actor.ok) return actor;
  const detail = Result.fromSync(
    () => JSON.parse(row.detail_json) as Readonly<Record<string, unknown>>,
  );
  if (!detail.ok) return detail;
  if (!auditOutcomes.includes(row.outcome as AuditOutcome)) {
    return Err(new Error(`INVALID_AUDIT_OUTCOME:${row.outcome}`));
  }
  return Ok({
    id: row.id,
    workspaceId,
    ...(row.repository_id === null ? {} : { repositoryId: row.repository_id }),
    action: row.action,
    outcome: row.outcome as AuditOutcome,
    actor: actor.data,
    detail: detail.data,
    createdAt: row.created_at,
  });
};
