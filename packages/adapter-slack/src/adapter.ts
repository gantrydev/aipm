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

export interface SlackAdapterConfig {
  botToken: string;
  apiBaseUrl?: string; // default https://slack.com/api
}

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

  async react(_messageId: string, _emoji: string): Promise<void> {
    throw new Error("TODO(phase-3): reactions.add");
  }

  async notifyPerson(_identity: Identity, _body: string): Promise<void> {
    // TODO(phase-3): conversations.open(users: U…) then chat.postMessage.
    throw new Error("TODO(phase-3): open DM + postMessage");
  }
}
