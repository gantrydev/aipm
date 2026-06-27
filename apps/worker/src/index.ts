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
import { D1Store } from "@aipm/db";
import { Hono } from "hono";
import { buildEngineContext } from "./context.js";
import type { Env } from "./env.js";
import { githubRoutes } from "./routes/github.js";
import { slackRoutes } from "./routes/slack.js";

const app = new Hono<{ Bindings: Env }>();

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

interface SweepRepo {
  owner: string;
  repo: string;
  installationId: number;
}

export default {
  fetch: app.fetch,

  /** Ingest queue consumer (DESIGN §6): route each event to its cluster DO. */
  async queue(batch: MessageBatch<RawEvent>, env: Env): Promise<void> {
    await asyncForEach([...batch.messages], async (msg) => {
      const handled = await (async (): Promise<Result<void, Error>> => {
        if (msg.body.platform === "slack" && msg.body.event === "preference") {
          // Preference capture isn't thread-scoped; handle it directly (DESIGN §8).
          const { slackUserId, text } = msg.body.payload as { slackUserId: string; text: string };
          const captured = await capturePreference(
            buildEngineContext(env, msg.body),
            slackUserId,
            text,
          );
          // Infra failure (findIdentity/upsertPreference) surfaces as reason:"error";
          // retry it to preserve today's retry-on-DB-failure. unknown_user/unparsed/
          // happy paths are terminal outcomes — ack them. notifyPerson failures are
          // best-effort and never reach here.
          if (captured.reason === "error") return Err(new Error(PREFERENCE_CAPTURE_FAILED));
          return Ok(undefined);
        }
        const nativeId = deriveNativeId(msg.body);
        if (!nativeId) return Ok(undefined);
        const store = new D1Store(env.DB);
        const existing = await store.findCluster(nativeId);
        if (!existing.ok) return existing;
        const cluster = await (async () => {
          if (existing.data) return Ok(existing.data);
          return store.getOrCreateCluster(nativeId);
        })();
        if (!cluster.ok) return cluster;
        const coordinatorId = env.CLUSTER_COORDINATOR.idFromName(cluster.data);
        const processed = await env.CLUSTER_COORDINATOR.get(coordinatorId).process({
          event: msg.body,
          threadNativeId: nativeId,
          clusterId: cluster.data,
          hop: 0,
        });
        if (!processed.ok) return processed;
        return Ok(undefined);
      })();
      if (handled.ok) msg.ack();
      else msg.retry();
    });
  },

  /** Cron: the daily trigger builds per-person digests; others sweep (DESIGN §7/§8). */
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === DIGEST_CRON) {
      // No installation needed; pass a synthetic event. Digest + org rollup.
      const ctx = buildEngineContext(env, { platform: "slack", payload: {} });
      const aggregated = await aggregate(ctx);
      if (!aggregated.ok) {
        console.error("digest cron failed:", aggregated.error);
        // RUNTIME-CRITICAL: surface to the runtime so the cron retries.
        throw aggregated.error;
      }
      const rolled = await aggregateOrg(ctx, { channelId: env.ORG_ROLLUP_CHANNEL_ID });
      if (!rolled.ok) {
        console.error("digest cron failed:", rolled.error);
        // RUNTIME-CRITICAL: surface to the runtime so the cron retries.
        throw rolled.error;
      }
      return;
    }

    const repos = parseSweepRepos(env.SWEEP_REPOS);
    if (!repos.length || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_CLIENT_ID) return;
    const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY;
    const clientId = env.GITHUB_APP_CLIENT_ID;

    const sweepResults = await asyncMap(repos, async (sweepRepo) => {
      const token = installationTokenProvider({
        kv: env.INSTALL_TOKENS,
        privateKeyPem,
        clientId,
        installationId: sweepRepo.installationId,
      });
      const adapter = new GitHubAdapter({ token });
      const threadsResult = await adapter.listThreads({
        owner: sweepRepo.owner,
        repo: sweepRepo.repo,
      });
      if (!threadsResult.ok) return threadsResult;
      const threads = threadsResult.data;
      const messages = threads.map((t) => ({
        body: {
          platform: "github" as const,
          event: "sweep",
          installationId: sweepRepo.installationId,
          payload: { nativeId: t.nativeId, type: t.type },
        },
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
      // RUNTIME-CRITICAL: surface to the runtime so the cron retries.
      throw firstSweepError.error;
    }
  },
} satisfies ExportedHandler<Env, RawEvent>;

function parseSweepRepos(raw: string | undefined): Array<SweepRepo> {
  if (!raw) return [];
  const parsed = Result.fromSync(() => JSON.parse(raw));
  if (!parsed.ok) return [];
  return Array.isArray(parsed.data) ? (parsed.data as Array<SweepRepo>) : [];
}

export { ClusterCoordinator } from "./coordinator.js";
export { MergeRegistry } from "./merge-registry.js";
