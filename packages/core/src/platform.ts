import type { Identity, Link, PlatformId, Thread, ThreadType, TimelineEvent } from "./domain.js";

/** A target for posting — a thread, a person, or a platform-native location. */
export interface PostTarget {
  threadNativeId?: string;
  identityId?: string;
  /** Adapter-specific routing hints (channel id, reply ts, etc.). */
  meta?: Record<string, unknown>;
}

/** A normalized, adapter-agnostic webhook or sweep event handed to the engine. */
export interface RawEvent {
  platform: PlatformId;
  /** Platform event name (e.g. GitHub `X-GitHub-Event`); classifies the payload. */
  event?: string;
  /** Platform action discriminator (e.g. opened/closed/submitted). */
  action?: string;
  /** Delivery id for dedupe/provenance. */
  deliveryId?: string;
  /** GitHub App installation id, when present — used to mint a scoped token. */
  installationId?: number;
  /** Adapter-specific payload (webhook body or sweep descriptor). */
  payload: unknown;
}

/** The routable identity of the thread an event concerns. */
export interface NormalizedRef {
  nativeId: string;
  type: ThreadType;
}

/**
 * Platform adapter contract (DESIGN §3). Everything platform-specific lives
 * behind an implementation of this interface; the engine never names a platform.
 *
 * Identity contract: `getThread`/`listThreads` return `participants` and `owner`
 * as platform-native **handles** (e.g. GitHub logins), not canonical Identity
 * ids. The engine (ingest) resolves them to Identity ids via the IdentitySource
 * and rewrites them before persisting — adapters never touch the Store.
 */
export interface Platform {
  readonly id: PlatformId;

  /**
   * Turn a raw event into the thread it concerns, or `undefined` to ignore it.
   * Lets the engine route + ingest without knowing the payload shape.
   */
  normalizeEvent(raw: RawEvent): NormalizedRef | undefined;

  /** For sweeps. Query shape is adapter-defined. */
  listThreads(query: Record<string, unknown>): Promise<Thread[]>;
  /** `hint` (from `normalizeEvent`) avoids an issue-vs-PR probe round-trip. */
  getThread(nativeId: string, hint?: ThreadType): Promise<Thread>;
  getTimeline(nativeId: string): Promise<TimelineEvent[]>;
  discoverLinks(thread: Thread): Promise<Link[]>;

  postMessage(target: PostTarget, body: string): Promise<{ id: string }>;
  editMessage(messageId: string, body: string): Promise<void>;
  /**
   * Find the bot's existing sticky comment on a thread by a hidden marker, if
   * any — so the engine edits-or-creates one comment even if its stored id was
   * lost (D1 reset) or never persisted (retry after a partial post).
   */
  findStickyComment(threadNativeId: string, marker: string): Promise<string | undefined>;
  react(messageId: string, emoji: string): Promise<void>;
  /** DM / mention a specific person. */
  notifyPerson(identity: Identity, body: string): Promise<void>;
}

/** LLM adapter — a thin completion behind AI Gateway (swappable + cached). */
export interface LlmAdapter {
  complete(prompt: string, opts?: LlmOptions): Promise<string>;
}

export interface LlmOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Cache key override; defaults to a hash of the prompt. */
  cacheKey?: string;
}

/**
 * Identity source (DESIGN §5). Produces partial Identity rows from a config
 * file, directory/SCIM sync, or org enumeration. Slack-id resolution layers
 * on top of this.
 */
export interface IdentitySource {
  list(): Promise<Identity[]>;
  resolve(query: {
    handle?: string;
    email?: string;
    platform?: PlatformId;
  }): Promise<Identity | undefined>;
}
