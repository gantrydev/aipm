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
    const p = raw.payload as { channel?: string; threadTs?: string };
    if (!p.channel || !p.threadTs) return undefined;
    return { nativeId: `${p.channel}/${p.threadTs}`, type: "slack_thread" };
  }

  async listThreads(_query: Record<string, unknown>): Promise<Thread[]> {
    throw new Error("TODO: Slack thread sweeps");
  }

  /** Fetch a Slack thread's replies and normalize to a Thread. */
  async getThread(nativeId: string, _hint?: ThreadType): Promise<Thread> {
    const { channel, ts } = parseSlackNativeId(nativeId);
    const res = await this.get<{ messages?: SlackMessage[] }>("conversations.replies", {
      channel,
      ts,
      limit: "200",
    });
    const messages = res.messages ?? [];
    const root = messages[0];
    const participants = [
      ...new Set(messages.filter((m) => m.user && !m.bot_id).map((m) => m.user!)),
    ];
    return {
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
    };
  }

  async getTimeline(nativeId: string): Promise<TimelineEvent[]> {
    return (await this.getThread(nativeId)).timeline;
  }

  /** Cluster a Slack thread with referenced GitHub issues/PRs (DESIGN §8). */
  async discoverLinks(thread: Thread): Promise<Link[]> {
    const text = [thread.body ?? "", ...thread.timeline.map((e) => String(e.data.body ?? ""))].join(
      "\n",
    );
    const seen = new Set<string>();
    const links: Link[] = [];
    for (const m of text.matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g)) {
      const to = `${m[1]}#${m[2]}`;
      if (seen.has(to)) continue;
      seen.add(to);
      links.push({ from: thread.nativeId, to, kind: "cross_ref" });
    }
    return links;
  }

  /** Post into the thread (`target.threadNativeId` = `${channel}/${threadTs}`). */
  async postMessage(target: PostTarget, body: string): Promise<{ id: string }> {
    if (!target.threadNativeId) throw new Error("postMessage requires target.threadNativeId");
    const { channel, ts } = parseSlackNativeId(target.threadNativeId);
    const res = await this.post<{ ts?: string }>("chat.postMessage", {
      channel,
      thread_ts: ts,
      text: body,
    });
    return { id: `${channel}/${res.ts}` };
  }

  /** Edit a posted message (`messageId` = `${channel}/${messageTs}`). */
  async editMessage(messageId: string, body: string): Promise<void> {
    const { channel, ts } = parseSlackNativeId(messageId);
    await this.post("chat.update", { channel, ts, text: body });
  }

  async findStickyComment(threadNativeId: string, marker: string): Promise<string | undefined> {
    const { channel, ts } = parseSlackNativeId(threadNativeId);
    const res = await this.get<{ messages?: SlackMessage[] }>("conversations.replies", {
      channel,
      ts,
      limit: "200",
    });
    const hit = (res.messages ?? []).find((m) => m.text?.includes(marker));
    return hit ? `${channel}/${hit.ts}` : undefined;
  }

  async react(messageId: string, emoji: string): Promise<void> {
    const { channel, ts } = parseSlackNativeId(messageId);
    await this.post("reactions.add", { channel, timestamp: ts, name: emoji });
  }

  /**
   * Resolve a person to their Slack user id. handles.slack may already be a
   * "U…"/"W…" id (fast path) or a roster-supplied username — resolve the latter
   * via email then handle and let the caller cache the real id.
   */
  async resolvePerson(identity: Identity): Promise<string | undefined> {
    const cached = identity.handles.slack;
    if (cached && isSlackUserId(cached)) return cached;
    return resolveSlackId(this.config, { email: identity.email, handle: cached });
  }

  /** Open a DM and post the nudge (DESIGN §7). Requires a resolved Slack id. */
  async notifyPerson(identity: Identity, body: string): Promise<void> {
    const uid = identity.handles.slack;
    if (!uid) throw new Error(`no Slack id on identity ${identity.id}`);
    const opened = await this.post<{ channel?: { id?: string } }>("conversations.open", {
      users: uid,
    });
    const channel = opened.channel?.id;
    if (!channel) throw new Error("conversations.open returned no channel");
    await this.post("chat.postMessage", { channel, text: body });
  }

  private async post<T>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T & { ok: boolean }> {
    const base = this.config.apiBaseUrl ?? DEFAULT_BASE;
    const res = await (this.config.fetchImpl ?? fetch)(`${base}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}`);
    const json = (await res.json()) as T & { ok: boolean; error?: string };
    if (!json.ok) throw new Error(`Slack ${method} error: ${json.error ?? "unknown"}`);
    return json;
  }

  private async get<T>(
    method: string,
    params: Record<string, string>,
  ): Promise<T & { ok: boolean }> {
    const base = this.config.apiBaseUrl ?? DEFAULT_BASE;
    const url = `${base}/${method}?${new URLSearchParams(params).toString()}`;
    const res = await (this.config.fetchImpl ?? fetch)(url, {
      headers: { Authorization: `Bearer ${this.config.botToken}` },
    });
    if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}`);
    const json = (await res.json()) as T & { ok: boolean; error?: string };
    if (!json.ok) throw new Error(`Slack ${method} error: ${json.error ?? "unknown"}`);
    return json;
  }
}

interface SlackMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
}

/** `${channel}/${ts}` — channel ids have no '/', ts is `<seconds>.<micros>`. */
export function parseSlackNativeId(nativeId: string): { channel: string; ts: string } {
  const i = nativeId.indexOf("/");
  if (i < 0) throw new Error(`unparseable Slack nativeId: ${nativeId}`);
  return { channel: nativeId.slice(0, i), ts: nativeId.slice(i + 1) };
}

const slackTsToIso = (ts: string): string => new Date(Number.parseFloat(ts) * 1000).toISOString();

/** Slack mentions are `<@U…>`; return the bare user ids. */
function parseSlackMentions(text: string | undefined): string[] | undefined {
  if (!text) return undefined;
  const out = new Set<string>();
  for (const m of text.matchAll(/<@([UW][A-Z0-9]+)>/g)) out.add(m[1]!);
  return out.size ? [...out] : undefined;
}

const clean = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
