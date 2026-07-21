import { Ok, Result } from "@aipm/core";
import { LEGACY_WORKSPACE_ID, listActiveSweepRepositories, type SweepRepository } from "@aipm/db";
import type { Env } from "../env.js";
import type { DbEnv } from "./guards.js";

/**
 * Active repositories for cron sweeps. Prefers D1-backed enabled repos from
 * installation lifecycle; falls back to SWEEP_REPOS for legacy self-host.
 */
export const listSweepRepositories = async (
  env: DbEnv & Pick<Env, "SWEEP_REPOS">,
): Promise<Result<Array<SweepRepository>, Error>> => {
  const fromDb = await listActiveSweepRepositories(env.DB);
  if (!fromDb.ok) return fromDb;
  if (fromDb.data.length) return fromDb;

  const legacy = parseSweepRepos(env.SWEEP_REPOS);
  return Ok(
    legacy.map((repo) => ({
      workspaceId: LEGACY_WORKSPACE_ID,
      repositoryId: 0,
      installationId: repo.installationId,
      owner: repo.owner,
      name: repo.repo,
      fullName: `${repo.owner}/${repo.repo}`,
    })),
  );
};

function parseSweepRepos(
  raw: string | undefined,
): Array<{ owner: string; repo: string; installationId: number }> {
  if (!raw) return [];
  const parsed = Result.fromSync(() => JSON.parse(raw) as unknown);
  if (!parsed.ok) return [];
  if (!Array.isArray(parsed.data)) return [];
  return parsed.data.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (
      typeof row.owner !== "string" ||
      typeof row.repo !== "string" ||
      typeof row.installationId !== "number"
    ) {
      return [];
    }
    return [
      {
        owner: row.owner,
        repo: row.repo,
        installationId: row.installationId,
      },
    ];
  });
}
