import type {
  Cluster,
  Identity,
  Link,
  Nudge,
  Preference,
  Signal,
  Store,
  Thread,
  WorkingNotes,
} from "@aipm/core";

const threadKey = (platform: string, nativeId: string) => `${platform}:${nativeId}`;

const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown, fallback: T): T =>
  typeof v === "string" && v.length ? (JSON.parse(v) as T) : fallback;

interface ThreadRow {
  platform: string;
  native_id: string;
  type: string;
  title: string | null;
  body: string | null;
  state: string;
  participants: string;
  owner: string | null;
  meta: string;
  timeline: string;
}

function rowToThread(r: ThreadRow): Thread {
  return {
    platform: r.platform,
    nativeId: r.native_id,
    type: r.type as Thread["type"],
    title: r.title ?? undefined,
    body: r.body ?? undefined,
    state: r.state,
    participants: parse(r.participants, [] as string[]),
    owner: r.owner ?? undefined,
    meta: parse(r.meta, {} as Record<string, unknown>),
    timeline: parse(r.timeline, [] as Thread["timeline"]),
  };
}

function rowToNudge(r: Record<string, unknown>): Nudge {
  return {
    dedupeKey: r.dedupe_key as string,
    person: r.person as string,
    signalId: r.signal_id as string,
    channel: r.channel as Nudge["channel"],
    sentAt: (r.sent_at as string | null) ?? undefined,
    state: r.state as Nudge["state"],
    escalations: r.escalations as number,
  };
}

/** D1-backed implementation of the core Store port. */
export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  // --- identities ---
  async upsertIdentity(i: Identity): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO identities (id, handles, email, display_name) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET handles=excluded.handles, email=excluded.email, display_name=excluded.display_name`,
      )
      .bind(i.id, json(i.handles), i.email ?? null, i.displayName ?? null)
      .run();
  }

  async getIdentity(id: string): Promise<Identity | undefined> {
    const r = await this.db.prepare(`SELECT * FROM identities WHERE id = ?`).bind(id).first();
    return r ? this.rowToIdentity(r) : undefined;
  }

  async findIdentity(q: { handle?: string; email?: string }): Promise<Identity | undefined> {
    if (q.email) {
      const r = await this.db
        .prepare(`SELECT * FROM identities WHERE email = ? LIMIT 1`)
        .bind(q.email)
        .first();
      if (r) return this.rowToIdentity(r);
    }
    if (q.handle) {
      // handle match across any platform in the JSON blob.
      const { results } = await this.db.prepare(`SELECT * FROM identities`).all();
      for (const r of results) {
        const ident = this.rowToIdentity(r);
        if (Object.values(ident.handles).includes(q.handle)) return ident;
      }
    }
    return undefined;
  }

  async deleteIdentity(id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM identities WHERE id = ?`).bind(id).run();
  }

  async setIdentityHandle(id: string, platform: string, handle: string): Promise<void> {
    // json_set on the JSON column avoids a read-modify-write race across DOs.
    await this.db
      .prepare(`UPDATE identities SET handles = json_set(handles, '$.' || ?, ?) WHERE id = ?`)
      .bind(platform, handle, id)
      .run();
  }

  private rowToIdentity(r: Record<string, unknown>): Identity {
    return {
      id: r.id as string,
      handles: parse(r.handles, {} as Identity["handles"]),
      email: (r.email as string | null) ?? undefined,
      displayName: (r.display_name as string | null) ?? undefined,
    };
  }

  // --- threads + links ---
  async upsertThread(t: Thread): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO threads (id, platform, native_id, type, title, body, state, participants, owner, meta, timeline, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type=excluded.type, title=excluded.title, body=excluded.body,
           state=excluded.state, participants=excluded.participants, owner=excluded.owner,
           meta=excluded.meta, timeline=excluded.timeline, updated_at=excluded.updated_at`,
      )
      .bind(
        threadKey(t.platform, t.nativeId),
        t.platform,
        t.nativeId,
        t.type,
        t.title ?? null,
        t.body ?? null,
        t.state,
        json(t.participants),
        t.owner ?? null,
        json(t.meta),
        json(t.timeline),
        new Date().toISOString(),
      )
      .run();
  }

  async getThread(platform: string, nativeId: string): Promise<Thread | undefined> {
    const r = await this.db
      .prepare(`SELECT * FROM threads WHERE platform = ? AND native_id = ?`)
      .bind(platform, nativeId)
      .first<ThreadRow>();
    return r ? rowToThread(r) : undefined;
  }

  async upsertLinks(links: Link[]): Promise<void> {
    if (!links.length) return;
    await this.db.batch(
      links.map((l) =>
        this.db
          .prepare(`INSERT OR IGNORE INTO links (from_id, to_id, kind) VALUES (?, ?, ?)`)
          .bind(l.from, l.to, l.kind),
      ),
    );
  }

  async getLinks(threadId: string): Promise<Link[]> {
    const { results } = await this.db
      .prepare(`SELECT from_id, to_id, kind FROM links WHERE from_id = ? OR to_id = ?`)
      .bind(threadId, threadId)
      .all<{ from_id: string; to_id: string; kind: string }>();
    return results.map((r) => ({ from: r.from_id, to: r.to_id, kind: r.kind as Link["kind"] }));
  }

  // --- clusters ---
  async upsertCluster(c: Cluster): Promise<void> {
    await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO clusters (id) VALUES (?)`).bind(c.id),
      this.db.prepare(`DELETE FROM cluster_threads WHERE cluster_id = ?`).bind(c.id),
      ...c.threadIds.map((tid) =>
        this.db
          .prepare(`INSERT INTO cluster_threads (cluster_id, thread_id) VALUES (?, ?)`)
          .bind(c.id, tid),
      ),
    ]);
  }

  async getCluster(id: string): Promise<Cluster | undefined> {
    const c = await this.db.prepare(`SELECT id FROM clusters WHERE id = ?`).bind(id).first();
    if (!c) return undefined;
    const { results } = await this.db
      .prepare(`SELECT thread_id FROM cluster_threads WHERE cluster_id = ?`)
      .bind(id)
      .all<{ thread_id: string }>();
    return { id, threadIds: results.map((r) => r.thread_id) };
  }

  // --- signals ---
  async upsertSignal(s: Signal): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO signals (id, thread_id, kind, owed_by, detected_at, cleared_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET owed_by=excluded.owed_by, cleared_at=excluded.cleared_at`,
      )
      .bind(s.id, s.threadId, s.kind, s.owedBy ?? null, s.detectedAt, s.clearedAt ?? null)
      .run();
  }

  async getOpenSignals(threadId: string): Promise<Signal[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM signals WHERE thread_id = ? AND cleared_at IS NULL`)
      .bind(threadId)
      .all();
    return results.map((r) => ({
      id: r.id as string,
      threadId: r.thread_id as string,
      kind: r.kind as Signal["kind"],
      owedBy: (r.owed_by as string | null) ?? undefined,
      detectedAt: r.detected_at as string,
      clearedAt: (r.cleared_at as string | null) ?? undefined,
    }));
  }

  async getSignal(id: string): Promise<Signal | undefined> {
    const r = await this.db.prepare(`SELECT * FROM signals WHERE id = ?`).bind(id).first();
    if (!r) return undefined;
    return {
      id: r.id as string,
      threadId: r.thread_id as string,
      kind: r.kind as Signal["kind"],
      owedBy: (r.owed_by as string | null) ?? undefined,
      detectedAt: r.detected_at as string,
      clearedAt: (r.cleared_at as string | null) ?? undefined,
    };
  }

  async clearSignal(id: string, clearedAt: string): Promise<void> {
    await this.db
      .prepare(`UPDATE signals SET cleared_at = ? WHERE id = ?`)
      .bind(clearedAt, id)
      .run();
  }

  // --- nudges ---
  async upsertNudge(n: Nudge): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO nudges (dedupe_key, person, signal_id, channel, sent_at, state, escalations)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET signal_id=excluded.signal_id, channel=excluded.channel,
           sent_at=excluded.sent_at, state=excluded.state, escalations=excluded.escalations`,
      )
      .bind(n.dedupeKey, n.person, n.signalId, n.channel, n.sentAt ?? null, n.state, n.escalations)
      .run();
  }

  async getNudgeByDedupeKey(dedupeKey: string): Promise<Nudge | undefined> {
    const r = await this.db
      .prepare(`SELECT * FROM nudges WHERE dedupe_key = ?`)
      .bind(dedupeKey)
      .first();
    return r ? rowToNudge(r) : undefined;
  }

  async listPendingDigestNudges(): Promise<Nudge[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM nudges WHERE channel = 'digest' AND state = 'pending'`)
      .all();
    return results.map(rowToNudge);
  }

  // --- preferences ---
  async getPreferences(person: string): Promise<Preference[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM preferences WHERE person = ?`)
      .bind(person)
      .all();
    return results.map((r) => ({
      person: r.person as string,
      rule: r.rule as Preference["rule"],
      selector: parse(r.selector, {} as Record<string, unknown>),
      until: (r.until as string | null) ?? undefined,
    }));
  }

  async upsertPreference(p: Preference): Promise<void> {
    // Idempotent on (person, rule, selector): repeating a command updates `until`
    // (re-snooze) instead of piling up duplicate rows. selector JSON is canonical
    // because it's produced by fixed code paths.
    await this.db
      .prepare(
        `INSERT INTO preferences (person, rule, selector, until) VALUES (?, ?, ?, ?)
         ON CONFLICT(person, rule, selector) DO UPDATE SET until=excluded.until`,
      )
      .bind(p.person, p.rule, json(p.selector), p.until ?? null)
      .run();
  }

  // --- working notes ---
  async getWorkingNotes(
    scope: WorkingNotes["scope"],
    targetId: string,
  ): Promise<WorkingNotes | undefined> {
    const r = await this.db
      .prepare(`SELECT * FROM working_notes WHERE scope = ? AND target_id = ?`)
      .bind(scope, targetId)
      .first();
    if (!r) return undefined;
    return {
      scope: r.scope as WorkingNotes["scope"],
      targetId: r.target_id as string,
      content: r.content as string,
      contentHash: r.content_hash as string,
      provenance: r.provenance as string,
      externalRef: (r.external_ref as string | null) ?? undefined,
    };
  }

  async upsertWorkingNotes(n: WorkingNotes): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO working_notes (scope, target_id, content, content_hash, provenance, external_ref)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, target_id) DO UPDATE SET content=excluded.content,
           content_hash=excluded.content_hash, provenance=excluded.provenance,
           external_ref=excluded.external_ref`,
      )
      .bind(n.scope, n.targetId, n.content, n.contentHash, n.provenance, n.externalRef ?? null)
      .run();
  }
}
