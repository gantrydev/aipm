import {
  asyncUnfold,
  Err,
  Ok,
  Result,
  unwrap,
  type Identity,
  type NormalizedRef,
  type Platform,
  type PostTarget,
  type RawEvent,
  type Thread,
  type ThreadType,
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
  token: string | (() => Promise<Result<string, Error>>);
  apiBaseUrl?: string; // default https://api.github.com
  /** Enable the regex link fallback (DESIGN §4). */
  regexLinkFallback?: boolean;
  /** Automation logins excluded from participants. */
  botAccounts?: Array<string>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const TIMELINE_PAGE = 100;
const COMMENTS_PAGE_SIZE = 100;

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

  async getThread(nativeId: string, hint?: ThreadType) {
    const parsedNativeId = Result.fromSync(() => parseNativeId(nativeId));
    if (!parsedNativeId.ok) return parsedNativeId;
    const { owner, repo, number } = parsedNativeId.data;
    const opts = { botAccounts: this.config.botAccounts };

    if (hint === "issue") {
      const fetchedNode = await this.fetchNode(owner, repo, number, "issue");
      if (!fetchedNode.ok) return fetchedNode;
      const node = fetchedNode.data;
      if (!node) return Err(new Error(`issue not found: ${nativeId}`));
      this.rawByNativeId.set(nativeId, node);
      return Ok(normalizeIssueGraphql(node, `${owner}/${repo}`, opts));
    }

    // hint 'pr' or unknown: try PR first, fall back to issue. GitHub GraphQL
    // returns an error, not null, when a number exists as an issue but not a PR.
    const pr = await this.fetchNodeIfExists(owner, repo, number, "pr");
    if (!pr.ok) return pr;
    if (pr.data) {
      this.rawByNativeId.set(nativeId, pr.data);
      return Ok(normalizePrGraphql(pr.data, `${owner}/${repo}`, opts));
    }
    const fetchedIssue = await this.fetchNode(owner, repo, number, "issue");
    if (!fetchedIssue.ok) return fetchedIssue;
    const issue = fetchedIssue.data;
    if (!issue) return Err(new Error(`thread not found: ${nativeId}`));
    this.rawByNativeId.set(nativeId, issue);
    return Ok(normalizeIssueGraphql(issue, `${owner}/${repo}`, opts));
  }

  async getTimeline(nativeId: string) {
    const fetchedThread = await this.getThread(nativeId);
    if (!fetchedThread.ok) return fetchedThread;
    return Ok(fetchedThread.data.timeline);
  }

  async listThreads(query: Record<string, unknown>) {
    const owner = String(query.owner);
    const repo = String(query.repo);
    const token = await this.resolveToken();
    if (!token.ok) return token;
    const repoFull = `${owner}/${repo}`;

    // Shallow Threads for sweeps; per-thread ingest does the full fetch.
    const seed: ListThreadsState = {
      issuesAfter: undefined,
      prsAfter: undefined,
      acc: [],
    };
    const swept = await Result.from(() =>
      asyncUnfold(seed, async (state) => {
        const data = unwrap(
          await ghGraphQL<RepoThreadsData>(
            token.data,
            LIST_THREADS_BY_REPO,
            { owner, repo, issuesAfter: state.issuesAfter, prsAfter: state.prsAfter },
            { apiBaseUrl: this.config.apiBaseUrl, fetchImpl: this.config.fetchImpl },
          ),
        );
        const issues = data.repository?.issues;
        const prs = data.repository?.pullRequests;
        const issueThreads = (issues?.nodes ?? []).map((n) => {
          return shallowThread(repoFull, n.number, "issue", "open");
        });
        const prThreads = (prs?.nodes ?? []).map((n) => {
          return shallowThread(repoFull, n.number, "pr", n.isDraft ? "draft" : "open");
        });
        const acc = [...state.acc, ...issueThreads, ...prThreads];
        const issuesAfter = issues?.pageInfo?.hasNextPage ? issues.pageInfo.endCursor : undefined;
        const prsAfter = prs?.pageInfo?.hasNextPage ? prs.pageInfo.endCursor : undefined;
        const hasMore = issuesAfter || prsAfter;
        if (!hasMore) return { kind: "STOP", value: acc };
        return { kind: "CONTINUE", next: { issuesAfter, prsAfter, acc } };
      }),
    );
    if (!swept.ok) return swept;
    return Ok(swept.data);
  }

  async discoverLinks(thread: Thread) {
    const raw = this.rawByNativeId.get(thread.nativeId);
    const nativeLinks = raw ? discoverLinksFromGraphql(thread.nativeId, raw) : [];
    if (!this.config.regexLinkFallback) return Ok(nativeLinks);
    const parsedNativeId = Result.fromSync(() => parseNativeId(thread.nativeId));
    if (!parsedNativeId.ok) return parsedNativeId;
    const { owner, repo } = parsedNativeId.data;
    const text = `${thread.title ?? ""}\n${thread.body ?? ""}`;
    const seen = new Set(nativeLinks.map((l) => `${l.to}:${l.kind}`));
    const textLinks = discoverLinksFromText(thread.nativeId, text, expandRef(`${owner}/${repo}`));
    const extraLinks = textLinks.flatMap((l) => {
      return seen.has(`${l.to}:${l.kind}`) ? [] : [l];
    });
    return Ok([...nativeLinks, ...extraLinks]);
  }

  // --- outbound ---
  /** Create a comment; returns its REST url as the opaque message id. */
  async postMessage(target: PostTarget, body: string) {
    if (!target.threadNativeId) {
      return Err(new Error("postMessage requires target.threadNativeId"));
    }
    const threadNativeId = target.threadNativeId;
    const parsedNativeId = Result.fromSync(() => parseNativeId(threadNativeId));
    if (!parsedNativeId.ok) return parsedNativeId;
    const { owner, repo, number } = parsedNativeId.data;
    const token = await this.resolveToken();
    if (!token.ok) return token;
    const response = await ghRest<{ url: string }>(
      token.data,
      "POST",
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      { body },
      this.restOpts(),
    );
    if (!response.ok) return response;
    return Ok({ id: response.data.url });
  }

  /** Edit the sticky comment in place. `messageId` is the comment REST url. */
  async editMessage(messageId: string, body: string) {
    const token = await this.resolveToken();
    if (!token.ok) return token;
    const edited = await ghRest(token.data, "PATCH", messageId, { body }, this.restOpts());
    if (!edited.ok) return edited;
    return Ok(undefined);
  }

  /** Find an existing comment containing the marker (the bot's sticky note). */
  async findStickyComment(threadNativeId: string, marker: string) {
    const parsedNativeId = Result.fromSync(() => parseNativeId(threadNativeId));
    if (!parsedNativeId.ok) return parsedNativeId;
    const { owner, repo, number } = parsedNativeId.data;
    const token = await this.resolveToken();
    if (!token.ok) return token;
    const seed: number = 1;
    const found = await Result.from(() =>
      asyncUnfold<number, string | undefined>(seed, async (page) => {
        const comments = unwrap(
          await ghRest<Array<{ url: string; body?: string }>>(
            token.data,
            "GET",
            `/repos/${owner}/${repo}/issues/${number}/comments?per_page=${COMMENTS_PAGE_SIZE}&page=${page}`,
            undefined,
            this.restOpts(),
          ),
        );
        const hit = comments.find((c) => c.body?.includes(marker));
        if (hit) return { kind: "STOP", value: hit.url };
        const isLastPage = comments.length < COMMENTS_PAGE_SIZE;
        if (isLastPage) return { kind: "STOP", value: undefined };
        return { kind: "CONTINUE", next: page + 1 };
      }),
    );
    if (!found.ok) return found;
    return Ok(found.data);
  }

  /** `messageId` is the comment REST url; `emoji` is a GitHub reaction content. */
  async react(messageId: string, emoji: string) {
    const token = await this.resolveToken();
    if (!token.ok) return token;
    const reacted = await ghRest(
      token.data,
      "POST",
      `${messageId}/reactions`,
      { content: emoji },
      this.restOpts(),
    );
    if (!reacted.ok) return reacted;
    return Ok(undefined);
  }

  async notifyPerson(_identity: Identity, _body: string) {
    // GitHub has no DM; nudges go out via Slack (phase-3).
    return Err(new Error("TODO(phase-3): GitHub has no DM channel"));
  }

  // --- internals ---
  private resolveToken() {
    return typeof this.config.token === "function"
      ? this.config.token()
      : Promise.resolve(Ok(this.config.token));
  }

  private restOpts(): GhRestOptions {
    return { apiBaseUrl: this.config.apiBaseUrl, fetchImpl: this.config.fetchImpl };
  }

  /** Fetch an issue/PR node with its timeline fully paginated, or undefined. */
  private async fetchNode(owner: string, repo: string, number: number, kind: "issue" | "pr") {
    const token = await this.resolveToken();
    if (!token.ok) return token;
    const query = kind === "pr" ? GET_PULL_REQUEST : GET_ISSUE;
    const field = kind === "pr" ? "pullRequest" : "issue";

    const seed: FetchNodeState = { cursor: undefined, acc: [] };
    const node = await Result.from(() =>
      asyncUnfold<FetchNodeState, Record<string, unknown> | undefined>(seed, async (state) => {
        const data = unwrap(
          await ghGraphQL<RepoNodeData>(
            token.data,
            query,
            { owner, repo, number, timelineCount: TIMELINE_PAGE, afterTimeline: state.cursor },
            { apiBaseUrl: this.config.apiBaseUrl, fetchImpl: this.config.fetchImpl },
          ),
        );
        const fetched = data.repository?.[field] as Record<string, unknown> | null | undefined;
        if (!fetched) return { kind: "STOP", value: undefined };
        const ti = fetched.timelineItems as TimelineConn | undefined;
        const acc = [...state.acc, ...(ti?.nodes ?? [])];
        const cursor = ti?.pageInfo?.hasNextPage ? ti.pageInfo.endCursor : undefined;
        if (cursor) return { kind: "CONTINUE", next: { cursor, acc } };
        fetched.timelineItems = { nodes: acc };
        return { kind: "STOP", value: fetched };
      }),
    );
    if (!node.ok) return node;
    return Ok(node.data);
  }

  private async fetchNodeIfExists(
    owner: string,
    repo: string,
    number: number,
    kind: "issue" | "pr",
  ) {
    const fetched = await this.fetchNode(owner, repo, number, kind);
    if (fetched.ok) return Ok(fetched.data);
    // A missing number is "absent" (try the other kind), not an error to propagate.
    if (isMissingNumberError(fetched.error, kind)) return Ok(undefined);
    return fetched;
  }
}

// --- shapes + helpers ---------------------------------------------------------

interface TimelineConn {
  nodes?: Array<unknown>;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string };
}
interface RepoNodeData {
  repository?: Record<string, unknown> | null;
}
interface RepoConn<T> {
  nodes?: Array<T>;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string };
}
interface RepoThreadsData {
  repository?: {
    issues?: RepoConn<{ number: number }>;
    pullRequests?: RepoConn<{ number: number; isDraft?: boolean }>;
  } | null;
}

interface ListThreadsState {
  issuesAfter: string | undefined;
  prsAfter: string | undefined;
  acc: Array<Thread>;
}

interface FetchNodeState {
  cursor: string | undefined;
  acc: Array<unknown>;
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

function isMissingNumberError(error: unknown, kind: "issue" | "pr"): boolean {
  const typeName = kind === "pr" ? "PullRequest" : "Issue";
  return String((error as { message?: unknown } | null)?.message ?? error).includes(
    `Could not resolve to a ${typeName} with the number`,
  );
}

const expandRef =
  (repoFull: string) =>
  (rawRef: string): string =>
    rawRef.startsWith("#") ? `${repoFull}${rawRef}` : rawRef;
