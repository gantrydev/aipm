import {
  GitHubAdapter,
  installationTokenProvider,
  normalizeWebhookEvent,
} from "@aipm/adapter-github";
import { aggregate, aggregateOrg, capturePreference, type RawEvent } from "@aipm/core";
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

interface SweepRepo {
  owner: string;
  repo: string;
  installationId: number;
}

export default {
  fetch: app.fetch,

  /** Ingest queue consumer (DESIGN §6): route each event to its cluster DO. */
  async queue(batch: MessageBatch<RawEvent>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        if (msg.body.platform === "slack" && msg.body.event === "preference") {
          // Preference capture isn't thread-scoped; handle it directly (DESIGN §8).
          const { slackUserId, text } = msg.body.payload as { slackUserId: string; text: string };
          await capturePreference(buildEngineContext(env, msg.body), slackUserId, text);
          msg.ack();
          continue;
        }
        const nativeId = deriveNativeId(msg.body);
        if (!nativeId) {
          msg.ack();
          continue;
        }
        const store = new D1Store(env.DB);
        const existing = await store.findCluster(nativeId);
        const clusterId = existing ?? (await store.getOrCreateCluster(nativeId));
        const coordinatorId = env.CLUSTER_COORDINATOR.idFromName(clusterId);
        await env.CLUSTER_COORDINATOR.get(coordinatorId).process({
          event: msg.body,
          threadNativeId: nativeId,
          clusterId,
          hop: 0,
        });
        msg.ack();
      } catch {
        msg.retry();
      }
    }
  },

  /** Cron: the daily trigger builds per-person digests; others sweep (DESIGN §7/§8). */
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === DIGEST_CRON) {
      // No installation needed; pass a synthetic event. Digest + org rollup.
      const ctx = buildEngineContext(env, { platform: "slack", payload: {} });
      await aggregate(ctx);
      await aggregateOrg(ctx);
      return;
    }

    const repos = parseSweepRepos(env.SWEEP_REPOS);
    if (!repos.length || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_CLIENT_ID) return;

    for (const { owner, repo, installationId } of repos) {
      const token = installationTokenProvider({
        kv: env.INSTALL_TOKENS,
        privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
        clientId: env.GITHUB_APP_CLIENT_ID,
        installationId,
      });
      const adapter = new GitHubAdapter({ token });
      const threads = await adapter.listThreads({ owner, repo });
      const messages = threads.map((t) => ({
        body: {
          platform: "github" as const,
          event: "sweep",
          installationId,
          payload: { nativeId: t.nativeId, type: t.type },
        },
      }));
      for (let i = 0; i < messages.length; i += 100) {
        await env.INGEST_QUEUE.sendBatch(messages.slice(i, i + 100));
      }
    }
  },
} satisfies ExportedHandler<Env, RawEvent>;

function parseSweepRepos(raw: string | undefined): SweepRepo[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as SweepRepo[]) : [];
  } catch {
    return [];
  }
}

export { ClusterCoordinator } from "./coordinator.js";
export { MergeRegistry } from "./merge-registry.js";
