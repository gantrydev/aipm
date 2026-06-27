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
import { Err, Ok, Result } from "@aipm/core";
import { resolveSlackId } from "./identity.js";

export interface SlackAdapterConfig {
  botToken: string;
  apiBaseUrl?: string; // default https://slack.com/api
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://slack.com/api";

/** Slack user ids look like U… / W… (uppercase alnum); anything else is a handle. */
export const isSlackUserId = (s: string | undefined): boolean =>
  !!s && /^[UW][A-Z0-9]{6,}$/.test(s);

/**
 * SlackAdapter (DESIGN §3/§8). Verifies the signing secret (see verify.ts),
 * opens DMs, parses preference messages, and models Slack threads as Threads.
 */
export class SlackAdapter implements Platform {
  readonly id = "slack" as const;

  constructor(private readonly config: SlackAdapterConfig) {}

  /** A Slack thread event (channel message) → its thread ref `${channel}/${ts}`. */
  normalizeEvent(raw: RawEvent): NormalizedRef | undefined {
    if (raw.event !== "thread_message") return undefined;
    if (!isSlackThreadPayload(raw.payload)) return undefined;
    return { nativeId: `${raw.payload.channel}/${raw.payload.threadTs}`, type: "slack_thread" };
  }

  async listThreads(_query: Record<string, unknown>): Promise<Result<Array<Thread>, Error>> {
    return Err(new Error("TODO: Slack thread sweeps"));
  }

  /** Fetch a Slack thread's replies and normalize to a Thread. */
  async getThread(nativeId: string, _hint?: ThreadType): Promise<Result<Thread, Error>> {
    const parsed = Result.fromSync(() => parseSlackNativeId(nativeId));
    if (!parsed.ok) return parsed;
    const { channel, ts } = parsed.data;
    const res = await this.get<{ messages?: Array<SlackMessage> }>("conversations.replies", {
      channel,
      ts,
      limit: "200",
    });
    if (!res.ok) return res;
    const messages = res.data.messages ?? [];
    const root = messages[0];
    const participants = [
      ...new Set(messages.filter((m) => m.user && !m.bot_id).map((m) => m.user!)),
    ];
    return Ok({
      platform: "slack",
      nativeId,
      type: "slack_thread",
      title: (root?.text ?? "").split("\n")[0]?.slice(0, 120) || undefined,
      body: root?.text,
      state: "open",
      participants,
      meta: { channel },
      timeline: messages.map((m) => ({
        kind: "comment",
        actor: m.user,
        at: slackTsToIso(m.ts),
        data: clean({ body: m.text, mentions: parseSlackMentions(m.text) }),
      })),
    });
  }

  async getTimeline(nativeId: string): Promise<Result<Array<TimelineEvent>, Error>> {
    const t = await this.getThread(nativeId);
    if (!t.ok) return t;
    return Ok(t.data.timeline);
  }

  /** Cluster a Slack thread with referenced GitHub issues/PRs (DESIGN §8). */
  async discoverLinks(thread: Thread): Promise<Result<Array<Link>, Error>> {
    const text = [thread.body ?? "", ...thread.timeline.map((e) => String(e.data.body ?? ""))].join(
      "\n",
    );
    const seen = new Set<string>();
    const links = githubRefs(text).flatMap((to) => {
      if (!to || seen.has(to)) return [];
      seen.add(to);
      const link: Link = { from: thread.nativeId, to, kind: "cross_ref" };
      return [link];
    });
    return Ok(links);
  }

  /** Post into a channel (`meta.channelId`) or thread (`threadNativeId` = `${channel}/${threadTs}`). */
  async postMessage(target: PostTarget, body: string): Promise<Result<{ id: string }, Error>> {
    const channelMeta = target.meta?.channelId;
    const channelId = typeof channelMeta === "string" ? channelMeta : undefined;
    if (channelId) {
      const posted = await this.post<{ ts?: string }>("chat.postMessage", {
        channel: channelId,
        text: body,
      });
      if (!posted.ok) return posted;
      return Ok({ id: `${channelId}/${posted.data.ts}` });
    }
    const threadNativeId = target.threadNativeId;
    if (!threadNativeId) {
      return Err(new Error("postMessage requires target.threadNativeId"));
    }
    const parsed = Result.fromSync(() => parseSlackNativeId(threadNativeId));
    if (!parsed.ok) return parsed;
    const { channel, ts } = parsed.data;
    const res = await this.post<{ ts?: string }>("chat.postMessage", {
      channel,
      thread_ts: ts,
      text: body,
    });
    if (!res.ok) return res;
    return Ok({ id: `${channel}/${res.data.ts}` });
  }

  /** Edit a posted message (`messageId` = `${channel}/${messageTs}`). */
  async editMessage(messageId: string, body: string): Promise<Result<void, Error>> {
    const parsed = Result.fromSync(() => parseSlackNativeId(messageId));
    if (!parsed.ok) return parsed;
    const { channel, ts } = parsed.data;
    const r = await this.post("chat.update", { channel, ts, text: body });
    if (!r.ok) return r;
    return Ok(undefined);
  }

  async findStickyComment(
    threadNativeId: string,
    marker: string,
  ): Promise<Result<string | undefined, Error>> {
    const parsed = Result.fromSync(() => parseSlackNativeId(threadNativeId));
    if (!parsed.ok) return parsed;
    const { channel, ts } = parsed.data;
    const res = await this.get<{ messages?: Array<SlackMessage> }>("conversations.replies", {
      channel,
      ts,
      limit: "200",
    });
    if (!res.ok) return res;
    const hit = (res.data.messages ?? []).find((m) => m.text?.includes(marker));
    return Ok(hit ? `${channel}/${hit.ts}` : undefined);
  }

  async react(messageId: string, emoji: string): Promise<Result<void, Error>> {
    const parsed = Result.fromSync(() => parseSlackNativeId(messageId));
    if (!parsed.ok) return parsed;
    const { channel, ts } = parsed.data;
    const r = await this.post("reactions.add", { channel, timestamp: ts, name: emoji });
    if (!r.ok) return r;
    return Ok(undefined);
  }

  /**
   * Resolve a person to their Slack user id. handles.slack may already be a
   * "U…"/"W…" id (fast path) or a roster-supplied username — resolve the latter
   * via email then handle and let the caller cache the real id.
   */
  async resolvePerson(identity: Identity): Promise<Result<string | undefined, Error>> {
    const cached = identity.handles.slack;
    if (cached && isSlackUserId(cached)) return Ok(cached);
    return resolveSlackId(this.config, { email: identity.email, handle: cached });
  }

  /** Open a DM and post the nudge (DESIGN §7). Requires a resolved Slack id. */
  async notifyPerson(identity: Identity, body: string): Promise<Result<void, Error>> {
    const uid = identity.handles.slack;
    if (!uid) return Err(new Error(`no Slack id on identity ${identity.id}`));
    const opened = await this.post<{ channel?: { id?: string } }>("conversations.open", {
      users: uid,
    });
    if (!opened.ok) return opened;
    const channel = opened.data.channel?.id;
    if (!channel) return Err(new Error("conversations.open returned no channel"));
    const r = await this.post("chat.postMessage", { channel, text: body });
    if (!r.ok) return r;
    return Ok(undefined);
  }

  private async post<T>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<Result<T & { ok: boolean }, Error>> {
    const base = this.config.apiBaseUrl ?? DEFAULT_BASE;
    const requestBody = Result.fromSync(() => JSON.stringify(body));
    if (!requestBody.ok) return requestBody;
    const fetched = await Result.from(() =>
      (this.config.fetchImpl ?? fetch)(`${base}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.botToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: requestBody.data,
      }),
    );
    if (!fetched.ok) return fetched;
    const res = fetched.data;
    if (!res.ok) return Err(new Error(`Slack ${method} HTTP ${res.status}`));
    const parsed = await Result.from(() => res.json());
    if (!parsed.ok) return parsed;
    const json = parsed.data as T & { ok: boolean; error?: string };
    if (!json.ok) return Err(new Error(`Slack ${method} error: ${json.error ?? "unknown"}`));
    return Ok(json);
  }

  private async get<T>(
    method: string,
    params: Record<string, string>,
  ): Promise<Result<T & { ok: boolean }, Error>> {
    const base = this.config.apiBaseUrl ?? DEFAULT_BASE;
    const url = `${base}/${method}?${new URLSearchParams(params).toString()}`;
    const fetched = await Result.from(() =>
      (this.config.fetchImpl ?? fetch)(url, {
        headers: { Authorization: `Bearer ${this.config.botToken}` },
      }),
    );
    if (!fetched.ok) return fetched;
    const res = fetched.data;
    if (!res.ok) return Err(new Error(`Slack ${method} HTTP ${res.status}`));
    const parsed = await Result.from(() => res.json());
    if (!parsed.ok) return parsed;
    const json = parsed.data as T & { ok: boolean; error?: string };
    if (!json.ok) return Err(new Error(`Slack ${method} error: ${json.error ?? "unknown"}`));
    return Ok(json);
  }
}

interface SlackMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
}

/** `${channel}/${ts}` — channel ids have no '/', ts is `<seconds>.<micros>`. */
function parseSlackNativeId(nativeId: string): { channel: string; ts: string } {
  const i = nativeId.indexOf("/");
  if (i < 0) throw new Error(`unparseable Slack nativeId: ${nativeId}`);
  return { channel: nativeId.slice(0, i), ts: nativeId.slice(i + 1) };
}

const slackTsToIso = (ts: string): string => new Date(Number.parseFloat(ts) * 1000).toISOString();

function githubRefs(text: string): Array<string> {
  const shorthandRefs = [...text.matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g)].map(
    (m) => `${m[1]}#${m[2]}`,
  );
  const urlRefs = [
    ...text.matchAll(/\bhttps:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)\b/g),
  ].map((m) => `${m[1]}/${m[2]}#${m[3]}`);
  return [...shorthandRefs, ...urlRefs];
}

/** Slack mentions are `<@U…>`; return the bare user ids. */
function parseSlackMentions(text: string | undefined): Array<string> | undefined {
  if (!text) return undefined;
  const ids = [...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].flatMap((m) => (m[1] ? [m[1]] : []));
  const out = new Set(ids);
  return out.size ? [...out] : undefined;
}

const clean = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  const isObject = typeof value === "object";
  return isObject && value !== null;
};

const isSlackThreadPayload = (value: unknown): value is { channel: string; threadTs: string } => {
  if (!isRecord(value)) return false;
  const validChannel = typeof value.channel === "string" && value.channel.length > 0;
  const validThreadTs = typeof value.threadTs === "string" && value.threadTs.length > 0;
  return validChannel && validThreadTs;
};
