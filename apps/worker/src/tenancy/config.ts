import { buildConfig, type EngineConfigInput } from "@aipm/config";
import { Ok, Result, type EngineConfig } from "@aipm/core";
import { getWorkspaceConfig, type WorkspaceId } from "@aipm/db";
import type { Env } from "../env.js";
import type { DbEnv } from "./guards.js";

export const loadStoredWorkspaceConfig = async (
  env: DbEnv,
  workspaceId: WorkspaceId,
): Promise<Result<EngineConfig | undefined, Error>> => {
  const stored = await getWorkspaceConfig(env.DB, workspaceId);
  if (!stored.ok) return stored;
  if (!stored.data) return Ok(undefined);
  const row = stored.data;
  const parsed = Result.fromSync(() => JSON.parse(row.configJson) as Partial<EngineConfigInput>);
  if (!parsed.ok) return parsed;
  return buildConfig(parsed.data);
};

export const buildConfigFromEnv = (env: Env): Result<EngineConfig, Error> => {
  const cap = (v: string | undefined) => (v === undefined ? undefined : v !== "false");
  return buildConfig({
    llmJudge: env.LLM_JUDGE === "true",
    notesPrompt: promptVar(env.NOTES_PROMPT),
    clusterPrompt: promptVar(env.CLUSTER_PROMPT),
    shadow: {
      global: env.SHADOW_GLOBAL !== "false",
      capabilities: {
        workingNotes: cap(env.SHADOW_WORKING_NOTES),
        nudges: cap(env.SHADOW_NUDGES),
        digest: cap(env.SHADOW_DIGEST),
        proposals: cap(env.SHADOW_PROPOSALS),
        orgRollup: cap(env.SHADOW_ORG_ROLLUP),
      },
    },
  });
};

const promptVar = (v: string | undefined): string | undefined => {
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return trimmed;
};
