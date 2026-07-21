import { appendAuditAction, type AppendAuditAction, type WorkspaceId } from "@aipm/db";
import type { DbEnv } from "./guards.js";

/** Permanently binds audit writes to one verified workspace. */
export const workspaceAudit = (env: DbEnv, workspaceId: WorkspaceId) => ({
  append: (entry: AppendAuditAction) => appendAuditAction(env.DB, workspaceId, entry),
});
