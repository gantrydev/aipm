import {
  GitHubAdapter,
  installationTokenProvider,
  normalizeWebhookEvent,
} from "@aipm/adapter-github";
import type { RawEvent } from "@aipm/core";
import { Hono } from "hono";
import { ThreadCoordinator } from "./coordinator.js";
import type { Env } from "./env.js";
import { githubRoutes } from "./routes/github.js";
import { slackRoutes } from "./routes/slack.js";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, shadow: c.env.SHADOW_GLOBAL }));
app.route("/webhooks/github", githubRoutes);
app.route("/webhooks/slack", slackRoutes);

/** Route an event to its thread's DO so per-thread updates serialize (DESIGN §6). */
function threadKey(event: RawEvent): string {
  if (event.platform === "github") {
    const ref = normalizeWebhookEvent(event);
    if (ref) return `github:${ref.nativeId}`;
  }
  return `${event.platform}:delivery:${event.deliveryId ?? "unknown"}`;
}

interface SweepRepo {
  owner: string;
  repo: string;
  installationId: number;
}

export default {
  fetch: app.fetch,

  /** Ingest queue consumer (DESIGN §6): route each event to its thread DO. */
  async queue(batch: MessageBatch<RawEvent>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const id = env.THREAD_COORDINATOR.idFromName(threadKey(msg.body));
        await env.THREAD_COORDINATOR.get(id).process(msg.body);
        msg.ack();
      } catch {
        msg.retry();
      }
    }
  },

  /** Cron sweep (DESIGN §7/§10.1): enqueue refresh events for open threads. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
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

export { ThreadCoordinator };
