import { Err, Ok, type RawEvent, type Result } from "@aipm/core";
import { workspaceIdFromTrustedSource, type WorkspaceContext, type WorkspaceId } from "@aipm/db";

export const WORKSPACE_INGEST_MESSAGE_VERSION = 1 as const;

export interface WorkspaceIngestMessage {
  readonly version: typeof WORKSPACE_INGEST_MESSAGE_VERSION;
  readonly workspaceId: WorkspaceId;
  readonly installationId?: number;
  readonly event: RawEvent;
}

export const createWorkspaceIngestMessage = (
  context: WorkspaceContext,
  event: RawEvent,
): WorkspaceIngestMessage => ({
  version: WORKSPACE_INGEST_MESSAGE_VERSION,
  workspaceId: context.workspaceId,
  installationId:
    context.provenance.kind === "github-installation"
      ? context.provenance.installationId
      : event.installationId,
  event,
});

export type VerifyInstallationWorkspace = (
  installationId: number,
  workspaceId: WorkspaceId,
) => Promise<boolean>;

export const parseWorkspaceIngestMessage = async (
  value: unknown,
  verifyInstallationWorkspace: VerifyInstallationWorkspace,
): Promise<Result<WorkspaceIngestMessage, Error>> => {
  if (!isRecord(value) || value.version !== WORKSPACE_INGEST_MESSAGE_VERSION) {
    return Err(new Error("UNSUPPORTED_WORKSPACE_MESSAGE"));
  }
  if (typeof value.workspaceId !== "string" || !isRawEvent(value.event)) {
    return Err(new Error("INVALID_WORKSPACE_MESSAGE"));
  }
  const workspaceId = workspaceIdFromTrustedSource(value.workspaceId);
  const installationId = value.installationId;
  if (installationId !== undefined && typeof installationId !== "number") {
    return Err(new Error("INVALID_WORKSPACE_MESSAGE"));
  }
  if (
    installationId !== undefined &&
    !(await verifyInstallationWorkspace(installationId, workspaceId))
  ) {
    return Err(new Error("INSTALLATION_WORKSPACE_MISMATCH"));
  }
  return Ok({
    version: WORKSPACE_INGEST_MESSAGE_VERSION,
    workspaceId,
    installationId,
    event: value.event,
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isRawEvent = (value: unknown): value is RawEvent =>
  isRecord(value) && (value.platform === "github" || value.platform === "slack");
