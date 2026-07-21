import type { KVLike } from "@aipm/adapter-github";
import type { WorkspaceId } from "@aipm/db";
import { budgetKey, installationTokenKey, llmCacheKey, repositoryInstallationKey } from "./keys.js";

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

/** Wrap BudgetedLlmAdapter counter keys with a workspace namespace. */
export const workspaceBudgetStore = (kv: KVNamespace, workspaceId: WorkspaceId) => ({
  get: (key: string) => kv.get(remapBudgetKey(workspaceId, key)),
  put: (key: string, value: string, options?: { expirationTtl?: number }) =>
    kv.put(remapBudgetKey(workspaceId, key), value, options),
});

const remapBudgetKey = (workspaceId: WorkspaceId, adapterKey: string): string => {
  const stripped = adapterKey.replace(/^llm:budget:/, "");
  const minute = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/.exec(stripped)?.[1];
  if (minute !== undefined) return budgetKey(workspaceId, "minute", minute);
  const day = /^(\d{4}-\d{2}-\d{2})$/.exec(stripped)?.[1];
  if (day !== undefined) return budgetKey(workspaceId, "day", day);
  return budgetKey(workspaceId, "day", stripped);
};

export const workspaceLlmCacheKv = (kv: KVNamespace, workspaceId: WorkspaceId) => ({
  get: (digest: string) => kv.get(llmCacheKey(workspaceId, digest)),
  put: (digest: string, value: string, options?: { expirationTtl?: number }) =>
    kv.put(llmCacheKey(workspaceId, digest), value, options),
});
