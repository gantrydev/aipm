declare const workspaceIdBrand: unique symbol;

export type WorkspaceId = string & { readonly [workspaceIdBrand]: "WorkspaceId" };

export const LEGACY_WORKSPACE_ID = "legacy" as WorkspaceId;

export type WorkspaceProvenance =
  | { readonly kind: "legacy-bootstrap" }
  | { readonly kind: "github-installation"; readonly installationId: number }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "scheduled" };

export interface WorkspaceContext {
  readonly workspaceId: WorkspaceId;
  readonly provenance: WorkspaceProvenance;
}

/** Resolver/bootstrap boundary for converting a validated persisted id. */
export const workspaceIdFromTrustedSource = (value: string): WorkspaceId => {
  if (!value.trim()) throw new Error("WORKSPACE_ID_REQUIRED");
  return value as WorkspaceId;
};
