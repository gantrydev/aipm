import type { KVLike } from "@aipm/adapter-github";
import type { WorkspaceId } from "@aipm/db";
import type { Env } from "../env.js";
import { deliveryKey, repositoryInstallationKey } from "./keys.js";
import { workspaceInstallTokenKv } from "./kv.js";

export const workspaceDeliveryDedupe = (
  env: Pick<Env, "DELIVERY_DEDUPE">,
  workspaceId: WorkspaceId,
) => ({
  get: (deliveryId: string) => env.DELIVERY_DEDUPE.get(deliveryKey(workspaceId, deliveryId)),
  put: (deliveryId: string, value: string, options?: { expirationTtl?: number }) =>
    env.DELIVERY_DEDUPE.put(deliveryKey(workspaceId, deliveryId), value, options),
  key: (deliveryId: string) => deliveryKey(workspaceId, deliveryId),
});

export const workspaceInstallTokens = (
  env: Pick<Env, "INSTALL_TOKENS">,
  workspaceId: WorkspaceId,
): KVLike => workspaceInstallTokenKv(env.INSTALL_TOKENS, workspaceId);

export const getCachedRepoInstallation = async (
  env: Pick<Env, "INSTALL_TOKENS">,
  workspaceId: WorkspaceId,
  fullName: string,
): Promise<string | null> =>
  env.INSTALL_TOKENS.get(repositoryInstallationKey(workspaceId, fullName));

export const putCachedRepoInstallation = async (
  env: Pick<Env, "INSTALL_TOKENS">,
  workspaceId: WorkspaceId,
  fullName: string,
  installationId: number,
  expirationTtl = 86_400,
): Promise<void> => {
  await env.INSTALL_TOKENS.put(
    repositoryInstallationKey(workspaceId, fullName),
    String(installationId),
    { expirationTtl },
  );
};

export const workspaceLog = (
  workspaceId: WorkspaceId,
  level: "error" | "info",
  message: string,
  detail?: unknown,
): void => {
  const line = `[workspace=${workspaceId}] ${message}`;
  if (level === "error") {
    if (detail === undefined) console.error(line);
    else console.error(line, detail);
    return;
  }
  if (detail === undefined) console.info(line);
  else console.info(line, detail);
};
