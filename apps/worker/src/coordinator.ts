import { DurableObject } from "cloudflare:workers";
import {
  GitHubAdapter,
  installationTokenProvider,
  mintAppJwt,
  parseNativeId,
  resolveRepoInstallationId,
} from "@aipm/adapter-github";
import {
  asyncForEach,
  asyncMap,
  evaluate,
  ingest,
  ingestThread,
  Result,
  route,
  synthesize,
  synthesizeCluster,
  type Link,
  type RawEvent,
  type Thread,
  type ThreadType,
} from "@aipm/core";
import { buildEngineContext } from "./context.js";
import type { Env } from "./env.js";

const MERGE_REGISTRY_KEY = "global";
const MAX_FORWARD_HOPS = 8;
const WORK_PREFIX = "work:";
const MAX_ATTEMPTS = 3;
const SLACK_DEBOUNCE_MS = 90_000;
const GITHUB_DEBOUNCE_MS = 20_000;

type ClusterWorkArgs = {
  event: RawEvent;
  threadNativeId: string;
  clusterId: string;
  hop: number;
};

interface ClusterWorkItem {
  id: string;
  args: ClusterWorkArgs;
  attempts: number;
  enqueuedAt: string;
  readyAt: number;
}

/**
 * One Durable Object per CLUSTER id (issue #8). `process` persists incoming
 * work and an alarm drains one item at a time, so cluster ordering survives DO
 * resets without putting long network/LLM work inside blockConcurrencyWhile.
 */
export class ClusterCoordinator extends DurableObject<Env> {
  private draining: Promise<void> | undefined;

  async process(args: ClusterWorkArgs) {
    const key = workKey(args);
    const delayMs = debounceMs(args.event);
    await this.ctx.storage.put<ClusterWorkItem>(key, {
      id: crypto.randomUUID(),
      args,
      attempts: 0,
      enqueuedAt: new Date().toISOString(),
      readyAt: Date.now() + delayMs,
    });
    await this.scheduleDrain(delayMs);
  }

  override async alarm() {
    if (this.draining) return this.draining;
    this.draining = this.drainOne().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async scheduleDrain(delayMs = 0) {
    const target = Date.now() + delayMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  private async drainOne() {
    const next = await this.nextReadyWork();
    if (!next) return;

    const { key, item } = next;
    await this.ctx.storage.put<ClusterWorkItem>(key, {
      ...item,
      attempts: item.attempts + 1,
    });

    const processed = await Result.from(() => this.processOne(item.args));
    if (processed.ok) {
      await this.deleteIfCurrent(key, item.id);
    } else if (item.attempts + 1 >= MAX_ATTEMPTS) {
      console.error(
        `cluster work failed permanently for ${item.args.threadNativeId}:`,
        processed.error,
      );
      await this.deleteIfCurrent(key, item.id);
    } else {
      console.error(`cluster work failed for ${item.args.threadNativeId}:`, processed.error);
      await this.scheduleDrain();
      return;
    }

    if (await this.hasWork()) await this.scheduleDrain();
  }

  private async deleteIfCurrent(key: string, id: string) {
    const current = await this.ctx.storage.get<ClusterWorkItem>(key);
    if (current?.id === id) await this.ctx.storage.delete(key);
  }

  private async nextReadyWork(): Promise<{ key: string; item: ClusterWorkItem } | undefined> {
    const now = Date.now();
    const items = await this.ctx.storage.list<ClusterWorkItem>({ prefix: WORK_PREFIX });
    const entries = [...items];

    const ready = entries.find((entry) => entry[1].readyAt <= now);
    if (ready) return { key: ready[0], item: ready[1] };

    if (!entries.length) return undefined;
    const earliestReadyAt = Math.min(...entries.map((entry) => entry[1].readyAt));
    await this.ctx.storage.setAlarm(earliestReadyAt);
    return undefined;
  }

  private async hasWork(): Promise<boolean> {
    const items = await this.ctx.storage.list<ClusterWorkItem>({ prefix: WORK_PREFIX, limit: 1 });
    return items.size > 0;
  }

  private async processOne(args: ClusterWorkArgs) {
    const ctx = buildEngineContext(this.env, args.event);
    const store = ctx.store;

    const ownerBefore = await store.findCluster(args.threadNativeId);
    const movedBeforeIngest = ownerBefore !== undefined && ownerBefore !== args.clusterId;
    if (movedBeforeIngest) return this.forward(args, ownerBefore);

    const thread = await ingest(ctx, args.event);
    if (!thread) return;

    const links = await store.getLinks(thread.nativeId);
    const ownCluster = await store.getOrCreateCluster(thread.nativeId);
    await asyncForEach(links, async (link) => {
      const counterpart = link.from === thread.nativeId ? link.to : link.from;
      const counterpartCluster = await store.getOrCreateCluster(counterpart);
      const crossesClusters = ownCluster !== counterpartCluster;
      if (crossesClusters) {
        const registryId = this.env.MERGE_REGISTRY.idFromName(MERGE_REGISTRY_KEY);
        await this.env.MERGE_REGISTRY.get(registryId).union({
          threadA: thread.nativeId,
          threadB: counterpart,
        });
      }
    });

    const ownerAfter = await store.findCluster(thread.nativeId);
    if (!ownerAfter) return;
    const mergedAway = ownerAfter !== args.clusterId;
    if (mergedAway) return this.forward(args, ownerAfter);

    const hydratedGitHubThreads =
      thread.platform === "slack" ? await this.hydrateLinkedGitHubThreads(ctx, thread, links) : [];
    const members = await store.listClusterThreads(args.clusterId);
    const cluster = members.length > 1 ? { id: args.clusterId, threadIds: members } : undefined;

    if (cluster) {
      const synthesized = await Result.from(() => synthesizeCluster(ctx, cluster));
      if (!synthesized.ok) {
        console.error(`cluster synth failed for ${args.clusterId}:`, synthesized.error);
      }
    }
    await asyncForEach(hydratedGitHubThreads, async (hydrated) => {
      const synthesizedThread = await Result.from(() =>
        synthesize(hydrated.ctx, hydrated.thread, cluster),
      );
      if (!synthesizedThread.ok) {
        console.error(
          `synthesize failed for ${hydrated.thread.nativeId}:`,
          synthesizedThread.error,
        );
      }
    });
    if (thread.platform === "github") {
      const synthesizedThread = await Result.from(() => synthesize(ctx, thread, cluster));
      if (!synthesizedThread.ok) {
        console.error(`synthesize failed for ${thread.nativeId}:`, synthesizedThread.error);
      }
    }
    const routed = await Result.from(async () => {
      const signals = await evaluate(ctx, thread);
      await route(ctx, thread, signals);
    });
    if (!routed.ok) {
      console.error(`evaluate/route failed for ${thread.nativeId}:`, routed.error);
    }
  }

  async forward(args: ClusterWorkArgs, target: string) {
    const overLimit = args.hop >= MAX_FORWARD_HOPS;
    if (overLimit) {
      console.error(`cluster forward hop limit for ${args.threadNativeId} -> ${target}`);
      return;
    }
    const id = this.env.CLUSTER_COORDINATOR.idFromName(target);
    await this.env.CLUSTER_COORDINATOR.get(id).process({
      event: args.event,
      threadNativeId: args.threadNativeId,
      clusterId: target,
      hop: args.hop + 1,
    });
  }

  private async hydrateLinkedGitHubThreads(
    ctx: ReturnType<typeof buildEngineContext>,
    sourceThread: Thread,
    links: Link[],
  ) {
    const typeHints = githubTypeHints(sourceThread);
    const candidateIds = links.flatMap((link) => {
      const fromId = looksLikeGitHubNativeId(link.from) ? [link.from] : [];
      const toId = looksLikeGitHubNativeId(link.to) ? [link.to] : [];
      return [...fromId, ...toId];
    });
    const nativeIds = new Set<string>(candidateIds);

    const hydratedResults = await asyncMap([...nativeIds], async (nativeId) => {
      const linked = await Result.from(() =>
        this.hydrateLinkedGitHubThread(ctx, nativeId, typeHints),
      );
      if (linked.ok && linked.data) return linked.data;
      if (!linked.ok) {
        console.error(`linked GitHub hydration failed for ${nativeId}:`, linked.error);
      }
      return undefined;
    });
    return hydratedResults.flatMap((it) => (it ? [it] : []));
  }

  private async hydrateLinkedGitHubThread(
    ctx: ReturnType<typeof buildEngineContext>,
    nativeId: string,
    typeHints: Map<string, ThreadType>,
  ): Promise<{ ctx: ReturnType<typeof buildEngineContext>; thread: Thread } | undefined> {
    const parsed = Result.fromSync(() => parseNativeId(nativeId));
    if (!parsed.ok) return undefined;
    const installationId = await this.resolveRepoInstallationId(
      parsed.data.owner,
      parsed.data.repo,
    );
    if (!installationId) return undefined;

    const github = new GitHubAdapter({
      token: installationTokenProvider({
        kv: this.env.INSTALL_TOKENS,
        privateKeyPem: this.env.GITHUB_APP_PRIVATE_KEY!,
        clientId: this.env.GITHUB_APP_CLIENT_ID!,
        installationId,
      }),
      botAccounts: ctx.config.botAccounts,
    });
    const githubCtx = {
      ...ctx,
      platforms: new Map(ctx.platforms).set("github", github),
    };
    const thread = await github.getThread(nativeId, typeHints.get(nativeId));
    return { ctx: githubCtx, thread: await ingestThread(githubCtx, thread) };
  }

  private async resolveRepoInstallationId(
    owner: string,
    repo: string,
  ): Promise<number | undefined> {
    if (!this.env.GITHUB_APP_PRIVATE_KEY || !this.env.GITHUB_APP_CLIENT_ID) return undefined;
    const key = `repo-inst:${owner}/${repo}`;
    const cached = await this.env.INSTALL_TOKENS.get(key);
    if (cached && /^\d+$/.test(cached)) return Number(cached);

    const jwt = await mintAppJwt(this.env.GITHUB_APP_PRIVATE_KEY, this.env.GITHUB_APP_CLIENT_ID);
    const id = await resolveRepoInstallationId(jwt, owner, repo);
    await this.env.INSTALL_TOKENS.put(key, String(id), { expirationTtl: 86_400 });
    return id;
  }
}

const looksLikeGitHubNativeId = (nativeId: string): boolean => /^[^/]+\/[^#]+#\d+$/.test(nativeId);

const workKey = (args: ClusterWorkArgs): string =>
  `${WORK_PREFIX}${encodeURIComponent(args.threadNativeId)}`;

export const debounceMs = (event: RawEvent): number => {
  if (event.platform === "slack") return SLACK_DEBOUNCE_MS;
  if (event.platform === "github" && event.event !== "sweep") return GITHUB_DEBOUNCE_MS;
  return 0;
};

export function githubTypeHints(
  thread: Pick<Thread, "body" | "timeline">,
): Map<string, ThreadType> {
  const text = [thread.body ?? "", ...thread.timeline.map((e) => String(e.data.body ?? ""))].join(
    "\n",
  );
  const matches = [
    ...text.matchAll(/\bhttps:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)\b/g),
  ];
  const entries = matches.map((match) => {
    const key = `${match[1]}/${match[2]}#${match[4]}`;
    const type: ThreadType = match[3] === "issues" ? "issue" : "pr";
    return [key, type] as const;
  });
  return new Map<string, ThreadType>(entries);
}
