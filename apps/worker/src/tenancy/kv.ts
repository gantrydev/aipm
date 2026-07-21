import type { KVLike } from "@aipm/adapter-github";
import type { WorkspaceId } from "@aipm/db";
import { installationTokenKey, repositoryInstallationKey } from "./keys.js";

/** Remap adapter-owned cache keys onto workspace-scoped KV keys. */
export const workspaceInstallTokenKv = (kv: KVNamespace, workspaceId: WorkspaceId): KVLike => ({
  get: async (key) => {
    const remapped = remapInstallKey(workspaceId, key);
    return kv.get(remapped);
  },
  put: async (key, value, options) => {
    const remapped = remapInstallKey(workspaceId, key);
    await kv.put(remapped, value, options);
  },
});

const remapInstallKey = (workspaceId: WorkspaceId, key: string): string => {
  const inst = /^inst:(\d+)$/.exec(key);
  const installationId = inst?.[1];
  if (installationId !== undefined) {
    return installationTokenKey(workspaceId, Number(installationId));
  }
  const repo = /^repo-inst:(.+)$/.exec(key);
  const fullName = repo?.[1];
  if (fullName !== undefined) return repositoryInstallationKey(workspaceId, fullName);
  return installationTokenKey(workspaceId, 0) + ":" + encodeURIComponent(key);
};
