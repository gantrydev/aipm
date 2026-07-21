import {
  GitHubAdapter,
  installationTokenProvider,
  normalizeWebhookEvent,
} from "@aipm/adapter-github";
import {
  aggregate,
  aggregateOrg,
  asyncForEach,
  asyncMap,
  capturePreference,
  chunk,
  Err,
  Ok,
  Result,
  type RawEvent,
} from "@aipm/core";
import { createWorkspaceStore, LEGACY_WORKSPACE_ID, type SweepRepository } from "@aipm/db";
import { Hono } from "hono";
import { buildEngineContext } from "./context.js";
import type { Env } from "./env.js";
import {
  createWorkspaceIngestMessage,
  parseWorkspaceIngestMessage,
  type WorkspaceIngestMessage,
} from "./messages.js";
import { cors } from "hono/cors";
import { apiRoutes } from "./routes/api.js";
import { authRoutes } from "./routes/auth.js";
import { githubRoutes } from "./routes/github.js";
import { slackRoutes } from "./routes/slack.js";
import { getClusterCoordinator } from "./tenancy/durable.js";
import {
  scheduledWorkspaceContext,
  verifyInstallationBelongsToWorkspace,
} from "./tenancy/guards.js";
import { workspaceInstallTokens, workspaceLog } from "./tenancy/index.js";
import { listSweepRepositories } from "./tenancy/sweeps.js";

const app = new Hono<{ Bindings: Env }>();

const siteCors = (origin: string) =>
  cors({
    origin,
    credentials: true,
    allowHeaders: ["Content-Type", "X-CSRF-Token"],
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
  });

app.use("/auth/*", async (c, next) => {
  const origin = c.env.SITE_ORIGIN;
  if (!origin) return next();
  return siteCors(origin)(c as never, next);
});
app.use("/api/*", async (c, next) => {
  const origin = c.env.SITE_ORIGIN;
  if (!origin) return next();
  return siteCors(origin)(c as never, next);
});

app.route("/auth", authRoutes);
app.route("/api", apiRoutes);
app.route("/webhooks/github", githubRoutes);
app.route("/webhooks/slack", slackRoutes);

/** The thread nativeId an event concerns (matches the adapter's thread.nativeId), or undefined to ignore. */
function deriveNativeId(event: RawEvent): string | undefined {
  if (event.platform === "github") {
    const ref = normalizeWebhookEvent(event);
    return ref ? ref.nativeId : undefined;
  }
  if (event.platform === "slack" && event.event === "thread_message") {
    const payload = event.payload as { channel?: string; threadTs?: string };
    if (!payload.channel || !payload.threadTs) return undefined;
    return `${payload.channel}/${payload.threadTs}`;
  }
  return undefined;
}

/** The cron expression that triggers the per-person digest (see wrangler.jsonc). */
const DIGEST_CRON = "0 14 * * *";

/** Retry signal for a preference-capture infra failure (reason:"error") at the queue boundary. */
const PREFERENCE_CAPTURE_FAILED = "PREFERENCE_CAPTURE_FAILED";

export default {
  fetch: app.fetch,

  /** Ingest queue consumer (DESIGN §6): route each event to its cluster DO. */
  async queue(batch: MessageBatch<WorkspaceIngestMessage>, env: Env): Promise<void> {
    await asyncForEach([...batch.messages], async (msg) => {
      let logWorkspaceId = LEGACY_WORKSPACE_ID;
      const handled = await (async (): Promise<Result<void, Error>> => {
        const parsed = await parseWorkspaceIngestMessage(msg.body, (installationId, workspaceId) =>
          verifyInstallationBelongsToWorkspace(env, installationId, workspaceId),
        );
        if (!parsed.ok) return parsed;
        const { workspaceId, event } = parsed.data;
        logWorkspaceId = workspaceId;

        if (event.platform === "slack" && event.event === "preference") {
          // Preference capture isn't thread-scoped; handle it directly (DESIGN §8).
          const { slackUserId, text } = event.payload as { slackUserId: string; text: string };
          const ctxResult = await buildEngineContext(env, event, workspaceId);
          if (!ctxResult.ok) return ctxResult;
          const captured = await capturePreference(ctxResult.data, slackUserId, text);
          if (captured.reason === "error") return Err(new Error(PREFERENCE_CAPTURE_FAILED));
          return Ok(undefined);
        }
        const nativeId = deriveNativeId(event);
        if (!nativeId) return Ok(undefined);
        const store = createWorkspaceStore(env.DB, workspaceId);
        const existing = await store.findCluster(nativeId);
        if (!existing.ok) return existing;
        const cluster = await (async () => {
          if (existing.data) return Ok(existing.data);
          return store.getOrCreateCluster(nativeId);
        })();
        if (!cluster.ok) return cluster;
        const processed = await getClusterCoordinator(env, workspaceId, cluster.data).process({
          event,
          threadNativeId: nativeId,
          clusterId: cluster.data,
          hop: 0,
          workspaceId,
        });
        if (!processed.ok) return processed;
        return Ok(undefined);
      })();
      if (handled.ok) msg.ack();
      else {
        workspaceLog(logWorkspaceId, "error", "queue message failed:", handled.error);
        msg.retry();
      }
    });
  },

  /** Cron: the daily trigger builds per-person digests; others sweep (DESIGN §7/§8). */
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === DIGEST_CRON) {
      // Digest remains on the legacy workspace until Slack is tenant-scoped.
      const ctxResult = await buildEngineContext(
        env,
        { platform: "slack", payload: {} },
        LEGACY_WORKSPACE_ID,
      );
      if (!ctxResult.ok) throw ctxResult.error;
      const ctx = ctxResult.data;
      const aggregated = await aggregate(ctx);
      if (!aggregated.ok) {
        workspaceLog(LEGACY_WORKSPACE_ID, "error", "digest cron failed:", aggregated.error);
        throw aggregated.error;
      }
      const rolled = await aggregateOrg(ctx, { channelId: env.ORG_ROLLUP_CHANNEL_ID });
      if (!rolled.ok) {
        workspaceLog(LEGACY_WORKSPACE_ID, "error", "digest cron failed:", rolled.error);
        throw rolled.error;
      }
      return;
    }

    const repos = await listSweepRepositories(env);
    if (!repos.ok) throw repos.error;
    if (!repos.data.length || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_CLIENT_ID) return;
    const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY;
    const clientId = env.GITHUB_APP_CLIENT_ID;

    const sweepResults = await asyncMap(repos.data, async (sweepRepo: SweepRepository) => {
      const token = installationTokenProvider({
        kv: workspaceInstallTokens(env, sweepRepo.workspaceId),
        privateKeyPem,
        clientId,
        installationId: sweepRepo.installationId,
      });
      const adapter = new GitHubAdapter({ token });
      const threadsResult = await adapter.listThreads({
        owner: sweepRepo.owner,
        repo: sweepRepo.name,
      });
      if (!threadsResult.ok) return threadsResult;
      const threads = threadsResult.data;
      const context = scheduledWorkspaceContext(sweepRepo.workspaceId);
      const messages = threads.map((t) => ({
        body: createWorkspaceIngestMessage(context, {
          platform: "github" as const,
          event: "sweep",
          installationId: sweepRepo.installationId,
          payload: { nativeId: t.nativeId, type: t.type },
        }),
      }));
      const batches = chunk(messages, 100);
      const sendResults = await asyncMap(batches, (batch) =>
        Result.from(() => env.INGEST_QUEUE.sendBatch(batch)),
      );
      const sendErrors = sendResults.flatMap((it) => (it.ok ? [] : [it]));
      const firstSendError = sendErrors[0];
      if (firstSendError) return firstSendError;
      return Ok(undefined);
    });
    const sweepErrors = sweepResults.flatMap((it) => (it.ok ? [] : [it]));
    const firstSweepError = sweepErrors[0];
    if (firstSweepError) {
      console.error("sweep cron failed:", firstSweepError.error);
      throw firstSweepError.error;
    }
  },
} satisfies ExportedHandler<Env, WorkspaceIngestMessage>;

export { ClusterCoordinator } from "./coordinator.js";
export { MergeRegistry } from "./merge-registry.js";
