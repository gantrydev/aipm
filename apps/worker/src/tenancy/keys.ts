import type { WorkspaceId } from "@aipm/db";

const segment = (value: string | number): string => encodeURIComponent(String(value));
const scoped = (prefix: string, workspaceId: WorkspaceId, suffix: string): string =>
  `${prefix}:${segment(workspaceId)}:${suffix}`;

export const deliveryKey = (workspaceId: WorkspaceId, deliveryId: string): string =>
  scoped("delivery", workspaceId, segment(deliveryId));

export const installationTokenKey = (workspaceId: WorkspaceId, installationId: number): string =>
  scoped("installation-token", workspaceId, segment(installationId));

export const repositoryInstallationKey = (workspaceId: WorkspaceId, fullName: string): string =>
  scoped("repository-installation", workspaceId, segment(fullName));

export const budgetKey = (
  workspaceId: WorkspaceId,
  window: "minute" | "day",
  bucket: string,
): string => scoped("llm-budget", workspaceId, `${window}:${segment(bucket)}`);

export const llmCacheKey = (workspaceId: WorkspaceId, digest: string): string =>
  scoped("llm-cache", workspaceId, segment(digest));

export const coordinatorName = (workspaceId: WorkspaceId, clusterId: string): string =>
  scoped("coordinator", workspaceId, segment(clusterId));

export const mergeRegistryName = (workspaceId: WorkspaceId): string =>
  scoped("merge-registry", workspaceId, "registry");
