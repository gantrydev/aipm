import type { WorkspaceId } from "@aipm/db";
import type { Env } from "../env.js";
import { coordinatorName, mergeRegistryName } from "./keys.js";

export const getClusterCoordinator = (
  env: Pick<Env, "CLUSTER_COORDINATOR">,
  workspaceId: WorkspaceId,
  clusterId: string,
) => {
  const id = env.CLUSTER_COORDINATOR.idFromName(coordinatorName(workspaceId, clusterId));
  return env.CLUSTER_COORDINATOR.get(id);
};

export const getMergeRegistry = (env: Pick<Env, "MERGE_REGISTRY">, workspaceId: WorkspaceId) => {
  const id = env.MERGE_REGISTRY.idFromName(mergeRegistryName(workspaceId));
  return env.MERGE_REGISTRY.get(id);
};
