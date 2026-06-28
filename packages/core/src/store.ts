import type { Identity, Link, Nudge, Preference, Signal, Thread, WorkingNotes } from "./domain.js";
import type { Result } from "./result.js";

/**
 * Persistence port. The engine depends on this interface, not on D1 directly;
 * @aipm/db provides the D1-backed implementation.
 */
export interface Store {
  // identities
  upsertIdentity(identity: Identity): Promise<Result<void, Error>>;
  getIdentity(id: string): Promise<Result<Identity | undefined, Error>>;
  findIdentity(query: {
    handle?: string;
    email?: string;
  }): Promise<Result<Identity | undefined, Error>>;
  /** Remove an identity row (used to collapse a stale partial into a canonical id). */
  deleteIdentity(id: string): Promise<Result<void, Error>>;
  /** Atomically set one platform handle without clobbering concurrent writes. */
  setIdentityHandle(id: string, platform: string, handle: string): Promise<Result<void, Error>>;

  // threads + links
  upsertThread(thread: Thread): Promise<Result<void, Error>>;
  getThread(platform: string, nativeId: string): Promise<Result<Thread | undefined, Error>>;
  upsertLinks(links: Array<Link>): Promise<Result<void, Error>>;
  replaceLinksFrom(fromId: string, links: Array<Link>): Promise<Result<void, Error>>;
  getLinks(threadId: string): Promise<Result<Array<Link>, Error>>;

  // clusters — flat thread→cluster membership; ids are minted, membership only grows (issue #8).
  /** The thread's current cluster id, or undefined if it has none yet. */
  findCluster(threadNativeId: string): Promise<Result<string | undefined, Error>>;
  /** The thread's cluster id, minting a fresh singleton cluster if it has none. Race-safe. */
  getOrCreateCluster(threadNativeId: string): Promise<Result<string, Error>>;
  /** All thread nativeIds in a cluster, ordered for a stable fingerprint. */
  listClusterThreads(clusterId: string): Promise<Result<Array<string>, Error>>;
  /** Move every thread from one cluster id to another (merge). */
  repointCluster(args: {
    fromClusterId: string;
    toClusterId: string;
  }): Promise<Result<void, Error>>;
  /** Drop a merged-away cluster's note + row. */
  deleteCluster(clusterId: string): Promise<Result<void, Error>>;

  // signals
  upsertSignal(signal: Signal): Promise<Result<void, Error>>;
  getOpenSignals(threadId: string): Promise<Result<Array<Signal>, Error>>;
  listOpenSignals(): Promise<Result<Array<Signal>, Error>>;
  getSignal(id: string): Promise<Result<Signal | undefined, Error>>;
  clearSignal(id: string, clearedAt: string): Promise<Result<void, Error>>;

  // nudges
  upsertNudge(nudge: Nudge): Promise<Result<void, Error>>;
  /**
   * Atomically claim the right to send the FIRST real nudge for a dedupe key:
   * inserts the row, or upgrades an existing shadow row to it. Returns true iff
   * this caller won the claim (then, and only then, send). A row already in a
   * non-shadow state means another caller/retry owns it → returns false.
   */
  tryClaimNudge(nudge: Nudge): Promise<Result<boolean, Error>>;
  getNudgeByDedupeKey(dedupeKey: string): Promise<Result<Nudge | undefined, Error>>;
  /** Queued digest nudges awaiting the next per-person digest (DESIGN §8). */
  listPendingDigestNudges(): Promise<Result<Array<Nudge>, Error>>;

  // preferences
  getPreferences(person: string): Promise<Result<Array<Preference>, Error>>;
  upsertPreference(pref: Preference): Promise<Result<void, Error>>;

  // working notes
  getWorkingNotes(
    scope: WorkingNotes["scope"],
    targetId: string,
  ): Promise<Result<WorkingNotes | undefined, Error>>;
  upsertWorkingNotes(notes: WorkingNotes): Promise<Result<void, Error>>;
  /** All working notes of a scope (e.g. every cluster note for the org rollup). */
  listWorkingNotes(scope: WorkingNotes["scope"]): Promise<Result<Array<WorkingNotes>, Error>>;
}
