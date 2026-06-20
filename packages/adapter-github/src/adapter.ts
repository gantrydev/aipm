import type {
  Identity,
  Link,
  NormalizedRef,
  Platform,
  PostTarget,
  RawEvent,
  Thread,
  ThreadType,
  TimelineEvent,
} from "@aipm/core";
import { discoverLinksFromGraphql } from "./discover-links.js";
import { ghGraphQL } from "./graphql.js";
import { discoverLinksFromText } from "./links.js";
import {
  normalizeIssueGraphql,
  normalizePrGraphql,
  normalizeWebhookEvent,
  parseNativeId,
} from "./normalize.js";
import { GET_ISSUE, GET_PULL_REQUEST, LIST_THREADS_BY_REPO } from "./queries.js";
import { ghRest, type GhRestOptions } from "./rest.js";

export interface GitHubAdapterConfig {
  /** Installation token, or a provider that mints/caches one (see auth.ts). */
  token: string | (() => Promise<string>);
  apiBaseUrl?: string; // default https://api.github.com
  /** Enable the regex link fallback (DESIGN §4). */
  regexLinkFallback?: boolean;
  /** Automation logins excluded from participants. */
  botAccounts?: string[];
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const TIMELINE_PAGE = 100;

/**
 * GitHubAdapter (DESIGN §3/§4). Normalizes GraphQL reads into Thread/Timeline,
 * discovers links via native relations (+ optional regex fallback), and posts
 * the sticky working-notes comment (phase-2). Construct one per event/install;
 * the raw-node cache below is intentionally short-lived.
 */
export class GitHubAdapter implements Platform {
  readonly id = "github" as const;
  private readonly rawByNativeId = new Map<string, Record<string, unknown>>();

  constructor(private readonly config: GitHubAdapterConfig) {}

  normalizeEvent(raw: RawEvent): NormalizedRef | undefined {
    return normalizeWebhookEvent(raw);
  }

  async getThread(nativeId: string, hint?: ThreadType): Promise<Thread> {
    const { owner, repo, number } = parseNativeId(nativeId);
    const opts = { botAccounts: this.config.botAccounts };

    if (hint === "issue") {
      const node = await this.fetchNode(owner, repo, number, "issue");
      if (!node) throw new Error(`issue not found: ${nativeId}`);
      this.rawByNativeId.set(nativeId, node);
      return normalizeIssueGraphql(node, `${owner}/${repo}`, opts);
    }

    // hint 'pr' or unknown: try PR first, fall back to issue.
    const pr = await this.fetchNode(owner, repo, number, "pr");
    if (pr) {
      this.rawByNativeId.set(nativeId, pr);
      return normalizePrGraphql(pr, `${owner}/${repo}`, opts);
    }
    const issue = await this.fetchNode(owner, repo, number, "issue");
    if (!issue) throw new Error(`thread not found: ${nativeId}`);
    this.rawByNativeId.set(nativeId, issue);
    return normalizeIssueGraphql(issue, `${owner}/${repo}`, opts);
  }

  async getTimeline(nativeId: string): Promise<TimelineEvent[]> {
    const thread = await this.getThread(nativeId);
    return thread.timeline;
  }

  async listThreads(query: Record<string, unknown>): Promise<Thread[]> {
    const owner = String(query.owner);
    const repo = String(query.repo);
    const token = await this.resolveToken();
    const repoFull = `${owner}/${repo}`;
    const out: Thread[] = [];
    let issuesAfter: string | undefined;
    let prsAfter: string | undefined;

    // Shallow Threads for sweeps; per-thread ingest does the full fetch.
    do {
      const data = await ghGraphQL<RepoThreadsData>(
        token,
        LIST_THREADS_BY_REPO,
        { owner, repo, issuesAfter, prsAfter },
        { apiBaseUrl: this.config.apiBaseUrl, fetchImpl: this.config.fetchImpl },
      );
      const issues = data.repository?.issues;
      const prs = data.repository?.pullRequests;
      for (const n of issues?.nodes ?? [])
        out.push(shallowThread(repoFull, n.number, "issue", "open"));
      for (const n of prs?.nodes ?? [])
        out.push(shallowThread(repoFull, n.number, "pr", n.isDraft ? "draft" : "open"));
      issuesAfter = issues?.pageInfo?.hasNextPage ? issues.pageInfo.endCursor : undefined;
      prsAfter = prs?.pageInfo?.hasNextPage ? prs.pageInfo.endCursor : undefined;
    } while (issuesAfter || prsAfter);

    return out;
  }

  async discoverLinks(thread: Thread): Promise<Link[]> {
    const raw = this.rawByNativeId.get(thread.nativeId);
    const links = raw ? discoverLinksFromGraphql(thread.nativeId, raw) : [];
    if (this.config.regexLinkFallback) {
      const { owner, repo } = parseNativeId(thread.nativeId);
      const text = `${thread.title ?? ""}\n${thread.body ?? ""}`;
      const seen = new Set(links.map((l) => `${l.to}:${l.kind}`));
      for (const l of discoverLinksFromText(thread.nativeId, text, expandRef(`${owner}/${repo}`))) {
        if (!seen.has(`${l.to}:${l.kind}`)) links.push(l);
      }
    }
    return links;
  }

  // --- outbound ---
  /** Create a comment; returns its REST url as the opaque message id. */
  async postMessage(target: PostTarget, body: string): Promise<{ id: string }> {
    if (!target.threadNativeId) throw new Error("postMessage requires target.threadNativeId");
    const { owner, repo, number } = parseNativeId(target.threadNativeId);
    const resp = await ghRest<{ url: string }>(
      await this.resolveToken(),
      "POST",
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      { body },
      this.restOpts(),
    );
    return { id: resp.url };
  }

  /** Edit the sticky comment in place. `messageId` is the comment REST url. */
  async editMessage(messageId: string, body: string): Promise<void> {
    await ghRest(await this.resolveToken(), "PATCH", messageId, { body }, this.restOpts());
  }

  /** Find an existing comment containing the marker (the bot's sticky note). */
  async findStickyComment(threadNativeId: string, marker: string): Promise<string | undefined> {
    const { owner, repo, number } = parseNativeId(threadNativeId);
    const token = await this.resolveToken();
    for (let page = 1; ; page++) {
      const comments = await ghRest<Array<{ url: string; body?: string }>>(
        token,
        "GET",
        `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
        undefined,
        this.restOpts(),
      );
      const hit = comments.find((c) => c.body?.includes(marker));
      if (hit) return hit.url;
      if (comments.length < 100) return undefined;
    }
  }

  /** `messageId` is the comment REST url; `emoji` is a GitHub reaction content. */
  async react(messageId: string, emoji: string): Promise<void> {
    await ghRest(
      await this.resolveToken(),
      "POST",
      `${messageId}/reactions`,
      { content: emoji },
      this.restOpts(),
    );
  }

  async notifyPerson(_identity: Identity, _body: string): Promise<void> {
    // GitHub has no DM; nudges go out via Slack (phase-3).
    throw new Error("TODO(phase-3): GitHub has no DM channel");
  }

  // --- internals ---
  private resolveToken(): Promise<string> {
    return typeof this.config.token === "function"
      ? this.config.token()
      : Promise.resolve(this.config.token);
  }

  private restOpts(): GhRestOptions {
    return { apiBaseUrl: this.config.apiBaseUrl, fetchImpl: this.config.fetchImpl };
  }

  /** Fetch an issue/PR node with its timeline fully paginated, or undefined. */
  private async fetchNode(
    owner: string,
    repo: string,
    number: number,
    kind: "issue" | "pr",
  ): Promise<Record<string, unknown> | undefined> {
    const token = await this.resolveToken();
    const query = kind === "pr" ? GET_PULL_REQUEST : GET_ISSUE;
    const field = kind === "pr" ? "pullRequest" : "issue";

    let cursor: string | undefined;
    let node: Record<string, unknown> | undefined;
    const timeline: unknown[] = [];

    do {
      const data = await ghGraphQL<RepoNodeData>(
        token,
        query,
        { owner, repo, number, timelineCount: TIMELINE_PAGE, afterTimeline: cursor },
        { apiBaseUrl: this.config.apiBaseUrl, fetchImpl: this.config.fetchImpl },
      );
      const fetched = data.repository?.[field] as Record<string, unknown> | null | undefined;
      if (!fetched) return undefined;
      node = fetched;
      const ti = fetched.timelineItems as TimelineConn | undefined;
      timeline.push(...(ti?.nodes ?? []));
      cursor = ti?.pageInfo?.hasNextPage ? ti.pageInfo.endCursor : undefined;
    } while (cursor);

    if (node) node.timelineItems = { nodes: timeline };
    return node;
  }
}

// --- shapes + helpers ---------------------------------------------------------

interface TimelineConn {
  nodes?: unknown[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string };
}
interface RepoNodeData {
  repository?: Record<string, unknown> | null;
}
interface RepoConn<T> {
  nodes?: T[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string };
}
interface RepoThreadsData {
  repository?: {
    issues?: RepoConn<{ number: number }>;
    pullRequests?: RepoConn<{ number: number; isDraft?: boolean }>;
  } | null;
}

const shallowThread = (
  repoFull: string,
  number: number,
  type: ThreadType,
  state: string,
): Thread => ({
  platform: "github",
  nativeId: `${repoFull}#${number}`,
  type,
  state,
  participants: [],
  meta: { repo: repoFull, shallow: true },
  timeline: [],
});

const expandRef =
  (repoFull: string) =>
  (rawRef: string): string =>
    rawRef.startsWith("#") ? `${repoFull}${rawRef}` : rawRef;
