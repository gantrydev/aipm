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

/**
 * SlackAdapter (DESIGN §3/§8). Verifies the signing secret (see verify.ts),
 * opens DMs, parses preference messages, and models Slack threads as Threads.
 */
export class SlackAdapter implements Platform {
  readonly id = "slack" as const;

  constructor(private readonly config: SlackAdapterConfig) {}

  normalizeEvent(_raw: RawEvent): NormalizedRef | undefined {
    return undefined; // TODO(phase-5): map Slack events to a thread ref.
  }

  async listThreads(_query: Record<string, unknown>): Promise<Thread[]> {
    throw new Error("TODO(phase-5): list Slack threads");
  }

  async getThread(_nativeId: string, _hint?: ThreadType): Promise<Thread> {
    throw new Error("TODO(phase-5): conversations.replies -> normalized Thread");
  }

  async getTimeline(_nativeId: string): Promise<TimelineEvent[]> {
    throw new Error("TODO(phase-5): replies -> TimelineEvent[]");
  }

  async discoverLinks(_thread: Thread): Promise<Link[]> {
    return []; // Slack links come from cross-refs to GitHub; phase-5.
  }

  async postMessage(_target: PostTarget, _body: string): Promise<{ id: string }> {
    throw new Error("TODO(phase-3): chat.postMessage");
  }

  async editMessage(_messageId: string, _body: string): Promise<void> {
    throw new Error("TODO(phase-3): chat.update");
  }

  async findStickyComment(_threadNativeId: string, _marker: string): Promise<string | undefined> {
    return undefined; // Slack working notes are phase-5.
  }

  async react(_messageId: string, _emoji: string): Promise<void> {
    throw new Error("TODO(phase-3): reactions.add");
  }

  /** Resolve a person to their Slack user id (cached by the caller on Identity). */
  async resolvePerson(identity: Identity): Promise<string | undefined> {
    if (identity.handles.slack) return identity.handles.slack;
    return resolveSlackId(this.config, { email: identity.email });
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
}
