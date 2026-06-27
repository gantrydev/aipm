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
  Ok,
  Result,
  route,
  synthesize,
  synthesizeCluster,
  unwrap,
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

  async process(args: ClusterWorkArgs): Promise<Result<void, Error>> {
    const key = workKey(args);
    const delayMs = debounceMs(args.event);
    const stored = await Result.from(() =>
      this.ctx.storage.put<ClusterWorkItem>(key, {
        id: crypto.randomUUID(),
        args,
        attempts: 0,
        enqueuedAt: new Date().toISOString(),
        readyAt: Date.now() + delayMs,
      }),
    );
    if (!stored.ok) return stored;

    const scheduled = await this.scheduleDrain(delayMs);
    if (!scheduled.ok) return scheduled;
    return Ok(undefined);
  }

  override async alarm() {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      const drained = await this.drainOne();
      // RUNTIME-CRITICAL: surface a drain failure so the DO runtime re-fires the alarm.
      if (!drained.ok) throw drained.error;
    })().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async scheduleDrain(delayMs = 0): Promise<Result<void, Error>> {
    const target = Date.now() + delayMs;
    const alarm = await Result.from(() => this.ctx.storage.getAlarm());
    if (!alarm.ok) return alarm;
    const current = alarm.data;
    if (current === null || current > target) {
      const scheduled = await Result.from(() => this.ctx.storage.setAlarm(target));
      if (!scheduled.ok) return scheduled;
    }
    return Ok(undefined);
  }

  private async drainOne(): Promise<Result<void, Error>> {
    const next = await this.nextReadyWork();
    if (!next.ok) return next;
    if (!next.data) return Ok(undefined);

    const { key, item } = next.data;
    const markedAttempt = await Result.from(() =>
      this.ctx.storage.put<ClusterWorkItem>(key, {
        ...item,
        attempts: item.attempts + 1,
      }),
    );
    if (!markedAttempt.ok) return markedAttempt;

    const processed = await this.processOne(item.args);
    if (processed.ok) {
      const deleted = await this.deleteIfCurrent(key, item.id);
      if (!deleted.ok) return deleted;
    } else if (item.attempts + 1 >= MAX_ATTEMPTS) {
      console.error(
        `cluster work failed permanently for ${item.args.threadNativeId}:`,
        processed.error,
      );
      const deleted = await this.deleteIfCurrent(key, item.id);
      if (!deleted.ok) return deleted;
    } else {
      console.error(`cluster work failed for ${item.args.threadNativeId}:`, processed.error);
      const scheduled = await this.scheduleDrain();
      if (!scheduled.ok) return scheduled;
      return Ok(undefined);
    }

    const hasWork = await this.hasWork();
    if (!hasWork.ok) return hasWork;
    if (hasWork.data) {
      const scheduled = await this.scheduleDrain();
      if (!scheduled.ok) return scheduled;
    }
    return Ok(undefined);
  }

  private async deleteIfCurrent(key: string, id: string): Promise<Result<void, Error>> {
    const loaded = await Result.from(() => this.ctx.storage.get<ClusterWorkItem>(key));
    if (!loaded.ok) return loaded;
    const current = loaded.data;
    if (current?.id === id) {
      const deleted = await Result.from(() => this.ctx.storage.delete(key));
      if (!deleted.ok) return deleted;
    }
    return Ok(undefined);
  }

  private async nextReadyWork(): Promise<
    Result<{ key: string; item: ClusterWorkItem } | undefined, Error>
  > {
    const now = Date.now();
    const listed = await Result.from(() =>
      this.ctx.storage.list<ClusterWorkItem>({ prefix: WORK_PREFIX }),
    );
    if (!listed.ok) return listed;
    const items = listed.data;
    const entries = [...items];

    const ready = entries.find((entry) => entry[1].readyAt <= now);
    if (ready) return Ok({ key: ready[0], item: ready[1] });

    if (!entries.length) return Ok(undefined);
    const earliestReadyAt = Math.min(...entries.map((entry) => entry[1].readyAt));
    const scheduled = await Result.from(() => this.ctx.storage.setAlarm(earliestReadyAt));
    if (!scheduled.ok) return scheduled;
    return Ok(undefined);
  }

  private async hasWork(): Promise<Result<boolean, Error>> {
    const listed = await Result.from(() =>
      this.ctx.storage.list<ClusterWorkItem>({ prefix: WORK_PREFIX, limit: 1 }),
    );
    if (!listed.ok) return listed;
    const items = listed.data;
    return Ok(items.size > 0);
  }

  private async processOne(args: ClusterWorkArgs): Promise<Result<void, Error>> {
    const ctx = buildEngineContext(this.env, args.event);
    const store = ctx.store;

    const ownerBeforeResult = await store.findCluster(args.threadNativeId);
    if (!ownerBeforeResult.ok) return ownerBeforeResult;
    const ownerBefore = ownerBeforeResult.data;
    const movedBeforeIngest = ownerBefore !== undefined && ownerBefore !== args.clusterId;
    if (movedBeforeIngest) return this.forward(args, ownerBefore);

    const ingested = await ingest(ctx, args.event);
    if (!ingested.ok) return ingested;
    const thread = ingested.data;
    if (!thread) return Ok(undefined);

    const linksResult = await store.getLinks(thread.nativeId);
    if (!linksResult.ok) return linksResult;
    const links = linksResult.data;
    const ownClusterResult = await store.getOrCreateCluster(thread.nativeId);
    if (!ownClusterResult.ok) return ownClusterResult;
    const ownCluster = ownClusterResult.data;
    const linksLoop = await Result.from(() =>
      asyncForEach(links, async (link) => {
        const counterpart = link.from === thread.nativeId ? link.to : link.from;
        const counterpartCluster = unwrap(await store.getOrCreateCluster(counterpart));
        const crossesClusters = ownCluster !== counterpartCluster;
        if (!crossesClusters) return;
        const registryId = this.env.MERGE_REGISTRY.idFromName(MERGE_REGISTRY_KEY);
        await this.env.MERGE_REGISTRY.get(registryId).union({
          threadA: thread.nativeId,
          threadB: counterpart,
        });
      }),
    );
    if (!linksLoop.ok) return linksLoop;

    const ownerAfterResult = await store.findCluster(thread.nativeId);
    if (!ownerAfterResult.ok) return ownerAfterResult;
    const ownerAfter = ownerAfterResult.data;
    if (!ownerAfter) return Ok(undefined);
    const mergedAway = ownerAfter !== args.clusterId;
    if (mergedAway) return this.forward(args, ownerAfter);

    const hydratedGitHubThreads =
      thread.platform === "slack" ? await this.hydrateLinkedGitHubThreads(ctx, thread, links) : [];
    const membersResult = await store.listClusterThreads(args.clusterId);
    if (!membersResult.ok) return membersResult;
    const members = membersResult.data;
    const cluster = members.length > 1 ? { id: args.clusterId, threadIds: members } : undefined;

    if (cluster) {
      const synthesized = await synthesizeCluster(ctx, cluster);
      if (!synthesized.ok) {
        console.error(`cluster synth failed for ${args.clusterId}:`, synthesized.error);
      }
    }
    await asyncForEach(hydratedGitHubThreads, async (hydrated) => {
      const synthesizedThread = await synthesize(hydrated.ctx, hydrated.thread, cluster);
      if (!synthesizedThread.ok) {
        console.error(
          `synthesize failed for ${hydrated.thread.nativeId}:`,
          synthesizedThread.error,
        );
      }
    });
    if (thread.platform === "github") {
      const synthesizedThread = await synthesize(ctx, thread, cluster);
      if (!synthesizedThread.ok) {
        console.error(`synthesize failed for ${thread.nativeId}:`, synthesizedThread.error);
      }
    }
    const signals = await evaluate(ctx, thread);
    if (!signals.ok) {
      console.error(`evaluate failed for ${thread.nativeId}:`, signals.error);
    } else {
      const routed = await route(ctx, thread, signals.data);
      if (!routed.ok) {
        console.error(`route failed for ${thread.nativeId}:`, routed.error);
      }
    }
    return Ok(undefined);
  }

  async forward(args: ClusterWorkArgs, target: string): Promise<Result<void, Error>> {
    const overLimit = args.hop >= MAX_FORWARD_HOPS;
    if (overLimit) {
      console.error(`cluster forward hop limit for ${args.threadNativeId} -> ${target}`);
      return Ok(undefined);
    }
    const id = this.env.CLUSTER_COORDINATOR.idFromName(target);
    const forwarded = await this.env.CLUSTER_COORDINATOR.get(id).process({
      event: args.event,
      threadNativeId: args.threadNativeId,
      clusterId: target,
      hop: args.hop + 1,
    });
    if (!forwarded.ok) return forwarded;
    return Ok(undefined);
  }

  private async hydrateLinkedGitHubThreads(
    ctx: ReturnType<typeof buildEngineContext>,
    sourceThread: Thread,
    links: Array<Link>,
  ) {
    const typeHints = githubTypeHints(sourceThread);
    const candidateIds = links.flatMap((link) => {
      const fromId = looksLikeGitHubNativeId(link.from) ? [link.from] : [];
      const toId = looksLikeGitHubNativeId(link.to) ? [link.to] : [];
      return [...fromId, ...toId];
    });
    const nativeIds = new Set<string>(candidateIds);

    const hydratedResults = await asyncMap([...nativeIds], async (nativeId) => {
      const linked = await this.hydrateLinkedGitHubThread(ctx, nativeId, typeHints);
      if (linked.ok) return linked.data;
      console.error(`linked GitHub hydration failed for ${nativeId}:`, linked.error);
      return undefined;
    });
    return hydratedResults.flatMap((it) => (it ? [it] : []));
  }

  private async hydrateLinkedGitHubThread(
    ctx: ReturnType<typeof buildEngineContext>,
    nativeId: string,
    typeHints: Map<string, ThreadType>,
  ): Promise<
    Result<{ ctx: ReturnType<typeof buildEngineContext>; thread: Thread } | undefined, Error>
  > {
    const parsed = Result.fromSync(() => parseNativeId(nativeId));
    if (!parsed.ok) return Ok(undefined);
    const installationId = await this.resolveRepoInstallationId(
      parsed.data.owner,
      parsed.data.repo,
    );
    if (!installationId.ok) return installationId;
    if (!installationId.data) return Ok(undefined);

    const github = new GitHubAdapter({
      token: installationTokenProvider({
        kv: this.env.INSTALL_TOKENS,
        privateKeyPem: this.env.GITHUB_APP_PRIVATE_KEY!,
        clientId: this.env.GITHUB_APP_CLIENT_ID!,
        installationId: installationId.data,
      }),
      botAccounts: ctx.config.botAccounts,
    });
    const githubCtx = {
      ...ctx,
      platforms: new Map(ctx.platforms).set("github", github),
    };
    const fetchedThread = await github.getThread(nativeId, typeHints.get(nativeId));
    if (!fetchedThread.ok) return fetchedThread;
    const ingestedThread = await ingestThread(githubCtx, fetchedThread.data);
    if (!ingestedThread.ok) return ingestedThread;
    return Ok({ ctx: githubCtx, thread: ingestedThread.data });
  }

  private async resolveRepoInstallationId(
    owner: string,
    repo: string,
  ): Promise<Result<number | undefined, Error>> {
    const privateKey = this.env.GITHUB_APP_PRIVATE_KEY;
    const clientId = this.env.GITHUB_APP_CLIENT_ID;
    if (!privateKey || !clientId) return Ok(undefined);
    const key = `repo-inst:${owner}/${repo}`;
    const cachedResult = await Result.from(() => this.env.INSTALL_TOKENS.get(key));
    if (!cachedResult.ok) return cachedResult;
    const cached = cachedResult.data;
    if (cached && /^\d+$/.test(cached)) return Ok(Number(cached));

    const jwt = await mintAppJwt(privateKey, clientId);
    if (!jwt.ok) return jwt;
    const id = await resolveRepoInstallationId(jwt.data, owner, repo);
    if (!id.ok) return id;
    const cachedInstallation = await Result.from(() =>
      this.env.INSTALL_TOKENS.put(key, String(id.data), { expirationTtl: 86_400 }),
    );
    if (!cachedInstallation.ok) return cachedInstallation;
    return Ok(id.data);
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
