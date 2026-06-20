import type {
  Cluster,
  Identity,
  Link,
  Nudge,
  Preference,
  Signal,
  Thread,
  WorkingNotes,
} from "./domain.js";

/**
 * Persistence port. The engine depends on this interface, not on D1 directly;
 * @aipm/db provides the D1-backed implementation.
 */
export interface Store {
  // identities
  upsertIdentity(identity: Identity): Promise<void>;
  getIdentity(id: string): Promise<Identity | undefined>;
  findIdentity(query: { handle?: string; email?: string }): Promise<Identity | undefined>;
  /** Remove an identity row (used to collapse a stale partial into a canonical id). */
  deleteIdentity(id: string): Promise<void>;
  /** Atomically set one platform handle without clobbering concurrent writes. */
  setIdentityHandle(id: string, platform: string, handle: string): Promise<void>;

  // threads + links
  upsertThread(thread: Thread): Promise<void>;
  getThread(platform: string, nativeId: string): Promise<Thread | undefined>;
  upsertLinks(links: Link[]): Promise<void>;
  getLinks(threadId: string): Promise<Link[]>;

  // clusters
  upsertCluster(cluster: Cluster): Promise<void>;
  getCluster(id: string): Promise<Cluster | undefined>;

  // signals
  upsertSignal(signal: Signal): Promise<void>;
  getOpenSignals(threadId: string): Promise<Signal[]>;
  getSignal(id: string): Promise<Signal | undefined>;
  clearSignal(id: string, clearedAt: string): Promise<void>;

  // nudges
  upsertNudge(nudge: Nudge): Promise<void>;
  getNudgeByDedupeKey(dedupeKey: string): Promise<Nudge | undefined>;
  /** Queued digest nudges awaiting the next per-person digest (DESIGN §8). */
  listPendingDigestNudges(): Promise<Nudge[]>;

  // preferences
  getPreferences(person: string): Promise<Preference[]>;
  upsertPreference(pref: Preference): Promise<void>;

  // working notes
  getWorkingNotes(
    scope: WorkingNotes["scope"],
    targetId: string,
  ): Promise<WorkingNotes | undefined>;
  upsertWorkingNotes(notes: WorkingNotes): Promise<void>;
  /** All working notes of a scope (e.g. every cluster note for the org rollup). */
  listWorkingNotes(scope: WorkingNotes["scope"]): Promise<WorkingNotes[]>;
}
