import type {
  Identity,
  Link,
  Nudge,
  Preference,
  Signal,
  Store,
  Thread,
  WorkingNotes,
} from "@aipm/core";
import { Err, Ok, Result } from "@aipm/core";

const threadKey = (platform: string, nativeId: string) => `${platform}:${nativeId}`;

const json = (v: unknown) => {
  const stringified = Result.fromSync(() => JSON.stringify(v));
  // Preserve the existing fail-fast or retry semantics for this failure.
  if (!stringified.ok) throw stringified.error;
  return stringified.data;
};

const parse = <T>(v: unknown, fallback: T): T => {
  const hasJson = typeof v === "string" && v.length > 0;
  if (!hasJson) return fallback;
  const parsed = Result.fromSync(() => JSON.parse(v));
  // Preserve the existing fail-fast or retry semantics for this failure.
  if (!parsed.ok) throw parsed.error;
  return parsed.data as T;
};

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
    participants: parse(r.participants, [] as Array<string>),
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

function rowToSignal(r: Record<string, unknown>): Signal {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    kind: r.kind as Signal["kind"],
    owedBy: (r.owed_by as string | null) ?? undefined,
    detectedAt: r.detected_at as string,
    clearedAt: (r.cleared_at as string | null) ?? undefined,
  };
}

function rowToWorkingNotes(r: Record<string, unknown>): WorkingNotes {
  return {
    scope: r.scope as WorkingNotes["scope"],
    targetId: r.target_id as string,
    content: r.content as string,
    contentHash: r.content_hash as string,
    provenance: r.provenance as string,
    externalRef: (r.external_ref as string | null) ?? undefined,
  };
}

/** D1-backed implementation of the core Store port. */
export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  // --- identities ---
  async upsertIdentity(i: Identity): Promise<Result<void, Error>> {
    const data = Result.fromSync(() => ({
      handles: json(i.handles),
      email: i.email ?? null,
      displayName: i.displayName ?? null,
    }));
    if (!data.ok) return data;
    const written = await Result.from(() =>
      this.db
        .prepare(
          `INSERT INTO identities (id, handles, email, display_name) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET handles=excluded.handles, email=excluded.email, display_name=excluded.display_name`,
        )
        .bind(i.id, data.data.handles, data.data.email, data.data.displayName)
        .run(),
    );
    if (!written.ok) return written;
    return Ok(undefined);
  }

  async getIdentity(id: string): Promise<Result<Identity | undefined, Error>> {
    const r = await Result.from(() =>
      this.db.prepare(`SELECT * FROM identities WHERE id = ?`).bind(id).first(),
    );
    if (!r.ok) return r;
    const row = r.data;
    if (!row) return Ok(undefined);
    const mapped = Result.fromSync(() => this.rowToIdentity(row));
    if (!mapped.ok) return mapped;
    return Ok(mapped.data);
  }

  async findIdentity(q: {
    handle?: string;
    email?: string;
  }): Promise<Result<Identity | undefined, Error>> {
    if (q.email) {
      const r = await Result.from(() =>
        this.db.prepare(`SELECT * FROM identities WHERE email = ? LIMIT 1`).bind(q.email).first(),
      );
      if (!r.ok) return r;
      const row = r.data;
      if (row) {
        const mapped = Result.fromSync(() => this.rowToIdentity(row));
        if (!mapped.ok) return mapped;
        return Ok(mapped.data);
      }
    }
    if (q.handle) {
      // handle match across any platform in the JSON blob.
      const handle = q.handle;
      const queried = await Result.from(() => this.db.prepare(`SELECT * FROM identities`).all());
      if (!queried.ok) return queried;
      const mapped = Result.fromSync(() => queried.data.results.map((r) => this.rowToIdentity(r)));
      if (!mapped.ok) return mapped;
      const match = mapped.data.find((ident) => Object.values(ident.handles).includes(handle));
      if (match) return Ok(match);
    }
    return Ok(undefined);
  }

  async deleteIdentity(id: string): Promise<Result<void, Error>> {
    const written = await Result.from(() =>
      this.db.prepare(`DELETE FROM identities WHERE id = ?`).bind(id).run(),
    );
    if (!written.ok) return written;
    return Ok(undefined);
  }

  async setIdentityHandle(
    id: string,
    platform: string,
    handle: string,
  ): Promise<Result<void, Error>> {
    // json_set on the JSON column avoids a read-modify-write race across DOs.
    const written = await Result.from(() =>
      this.db
        .prepare(`UPDATE identities SET handles = json_set(handles, '$.' || ?, ?) WHERE id = ?`)
        .bind(platform, handle, id)
        .run(),
    );
    if (!written.ok) return written;
    return Ok(undefined);
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
  async upsertThread(t: Thread): Promise<Result<void, Error>> {
    const data = Result.fromSync(() => ({
      participants: json(t.participants),
      meta: json(t.meta),
      timeline: json(t.timeline),
    }));
    if (!data.ok) return data;
    const written = await Result.from(() =>
      this.db
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
          data.data.participants,
          t.owner ?? null,
          data.data.meta,
          data.data.timeline,
          new Date().toISOString(),
        )
        .run(),
    );
    if (!written.ok) return written;
    return Ok(undefined);
  }

  async getThread(platform: string, nativeId: string): Promise<Result<Thread | undefined, Error>> {
    const r = await Result.from(() =>
      this.db
        .prepare(`SELECT * FROM threads WHERE platform = ? AND native_id = ?`)
        .bind(platform, nativeId)
        .first<ThreadRow>(),
    );
    if (!r.ok) return r;
    const row = r.data;
    if (!row) return Ok(undefined);
    const mapped = Result.fromSync(() => rowToThread(row));
    if (!mapped.ok) return mapped;
    return Ok(mapped.data);
  }

  async upsertLinks(links: Array<Link>): Promise<Result<void, Error>> {
    if (!links.length) return Ok(undefined);
    const written = await Result.from(() =>
      this.db.batch(
        links.map((l) =>
          this.db
            .prepare(`INSERT OR IGNORE INTO links (from_id, to_id, kind) VALUES (?, ?, ?)`)
            .bind(l.from, l.to, l.kind),
        ),
      ),
    );
    if (!written.ok) return written;
    return Ok(undefined);
  }

  async replaceLinksFrom(fromId: string, links: Array<Link>): Promise<Result<void, Error>> {
    const written = await Result.from(() =>
      this.db.batch([
        this.db.prepare(`DELETE FROM links WHERE from_id = ?`).bind(fromId),
        ...links
          .filter((l) => l.from === fromId)
          .map((l) =>
            this.db
              .prepare(`INSERT OR IGNORE INTO links (from_id, to_id, kind) VALUES (?, ?, ?)`)
              .bind(l.from, l.to, l.kind),
          ),
      ]),
    );
    if (!written.ok) return written;
    return Ok(undefined);
  }

  async getLinks(threadId: string): Promise<Result<Array<Link>, Error>> {
    const queried = await Result.from(() =>
      this.db
        .prepare(`SELECT from_id, to_id, kind FROM links WHERE from_id = ? OR to_id = ?`)
        .bind(threadId, threadId)
        .all<{ from_id: string; to_id: string; kind: string }>(),
    );
    if (!queried.ok) return queried;
    const links = queried.data.results.map((r) => ({
      from: r.from_id,
      to: r.to_id,
      kind: r.kind as Link["kind"],
    }));
    return Ok(links);
  }

  // --- clusters ---
  async findCluster(threadNativeId: string): Promise<Result<string | undefined, Error>> {
    const row = await Result.from(() =>
      this.db
        .prepare(`SELECT cluster_id FROM thread_cluster WHERE thread_id = ?`)
        .bind(threadNativeId)
        .first<{ cluster_id: string }>(),
    );
    if (!row.ok) return row;
    return Ok(row.data ? row.data.cluster_id : undefined);
  }

  async getOrCreateCluster(threadNativeId: string): Promise<Result<string, Error>> {
    const freshId = crypto.randomUUID();
    const inserted = await Result.from(() =>
      this.db
        .prepare(`INSERT OR IGNORE INTO thread_cluster (thread_id, cluster_id) VALUES (?, ?)`)
        .bind(threadNativeId, freshId)
        .run(),
    );
    if (!inserted.ok) return inserted;
    const row = await Result.from(() =>
      this.db
        .prepare(`SELECT cluster_id FROM thread_cluster WHERE thread_id = ?`)
        .bind(threadNativeId)
        .first<{ cluster_id: string }>(),
    );
    if (!row.ok) return row;
    if (!row.data) return Err(new Error("CLUSTER_MEMBERSHIP_LOST"));
    const clusterId = row.data.cluster_id;
    const ensured = await Result.from(() =>
      this.db.prepare(`INSERT OR IGNORE INTO clusters (id) VALUES (?)`).bind(clusterId).run(),
    );
    if (!ensured.ok) return ensured;
    return Ok(clusterId);
  }

  async listClusterThreads(clusterId: string): Promise<Result<Array<string>, Error>> {
    const queried = await Result.from(() =>
      this.db
        .prepare(`SELECT thread_id FROM thread_cluster WHERE cluster_id = ? ORDER BY thread_id`)
        .bind(clusterId)
        .all<{ thread_id: string }>(),
    );
    if (!queried.ok) return queried;
    return Ok(queried.data.results.map((it) => it.thread_id));
  }

  async repointCluster(args: {
    fromClusterId: string;
    toClusterId: string;
  }): Promise<Result<void, Error>> {
    const written = await Result.from(() =>
      this.db
        .prepare(`UPDATE thread_cluster SET cluster_id = ? WHERE cluster_id = ?`)
        .bind(args.toClusterId, args.fromClusterId)
        .run(),
    );
    if (!written.ok) return written;
    return Ok(undefined);
  }

  async deleteCluster(clusterId: string): Promise<Result<void, Error>> {
    const written = await Result.from(() =>
      this.db.batch([
        this.db
          .prepare(`DELETE FROM working_notes WHERE scope = 'cluster' AND target_id = ?`)
          .bind(clusterId),
        this.db.prepare(`DELETE FROM clusters WHERE id = ?`).bind(clusterId),
      ]),
    );
    if (!written.ok) return written;
    return Ok(undefined);
  }

  // --- signals ---
  async upsertSignal(s: Signal): Promise<Result<void, Error>> {
    const written = await Result.from(() =>
      this.db
        .prepare(
          `INSERT INTO signals (id, thread_id, kind, owed_by, detected_at, cleared_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET owed_by=excluded.owed_by, cleared_at=excluded.cleared_at`,
        )
        .bind(s.id, s.threadId, s.kind, s.owedBy ?? null, s.detectedAt, s.clearedAt ?? null)
        .run(),
    );
    if (!written.ok) return written;
    return Ok(undefined);
  }

  async getOpenSignals(threadId: string): Promise<Result<Array<Signal>, Error>> {
    const queried = await Result.from(() =>
      this.db
        .prepare(`SELECT * FROM signals WHERE thread_id = ? AND cleared_at IS NULL`)
        .bind(threadId)
        .all(),
    );
    if (!queried.ok) return queried;
    const signals = queried.data.results.map(rowToSignal);
    return Ok(signals);
  }

  async listOpenSignals(): Promise<Result<Array<Signal>, Error>> {
    const queried = await Result.from(() =>
      this.db.prepare(`SELECT * FROM signals WHERE cleared_at IS NULL ORDER BY detected_at`).all(),
    );
    if (!queried.ok) return queried;
    const signals = queried.data.results.map(rowToSignal);
    return Ok(signals);
  }

  async getSignal(id: string): Promise<Result<Signal | undefined, Error>> {
    const r = await Result.from(() =>
      this.db.prepare(`SELECT * FROM signals WHERE id = ?`).bind(id).first(),
    );
    if (!r.ok) return r;
    if (!r.data) return Ok(undefined);
    return Ok(rowToSignal(r.data));
  }

  async clearSignal(id: string, clearedAt: string): Promise<Result<void, Error>> {
    const written = await Result.from(() =>
      this.db.prepare(`UPDATE signals SET cleared_at = ? WHERE id = ?`).bind(clearedAt, id).run(),
    );
    if (!written.ok) return written;
    return Ok(undefined);
  }

  // --- nudges ---
  async upsertNudge(n: Nudge): Promise<Result<void, Error>> {
    const written = await Result.from(() =>
      this.db
        .prepare(
          `INSERT INTO nudges (dedupe_key, person, signal_id, channel, sent_at, state, escalations)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET signal_id=excluded.signal_id, channel=excluded.channel,
           sent_at=excluded.sent_at, state=excluded.state, escalations=excluded.escalations`,
        )
        .bind(
          n.dedupeKey,
          n.person,
          n.signalId,
          n.channel,
          n.sentAt ?? null,
          n.state,
          n.escalations,
        )
        .run(),
    );
    if (!written.ok) return written;
    return Ok(undefined);
  }

  async tryClaimNudge(n: Nudge): Promise<Result<boolean, Error>> {
    const res = await Result.from(() =>
      this.db
        .prepare(
          `INSERT INTO nudges (dedupe_key, person, signal_id, channel, sent_at, state, escalations)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET person=excluded.person, signal_id=excluded.signal_id,
           channel=excluded.channel, sent_at=excluded.sent_at, state=excluded.state,
           escalations=excluded.escalations
         WHERE nudges.state = 'shadow'`,
        )
        .bind(
          n.dedupeKey,
          n.person,
          n.signalId,
          n.channel,
          n.sentAt ?? null,
          n.state,
          n.escalations,
        )
        .run(),
    );
    if (!res.ok) return res;
    return Ok(res.data.meta.changes === 1);
  }

  async getNudgeByDedupeKey(dedupeKey: string): Promise<Result<Nudge | undefined, Error>> {
    const r = await Result.from(() =>
      this.db.prepare(`SELECT * FROM nudges WHERE dedupe_key = ?`).bind(dedupeKey).first(),
    );
    if (!r.ok) return r;
    return Ok(r.data ? rowToNudge(r.data) : undefined);
  }

  async listPendingDigestNudges(): Promise<Result<Array<Nudge>, Error>> {
    const queried = await Result.from(() =>
      this.db.prepare(`SELECT * FROM nudges WHERE channel = 'digest' AND state = 'pending'`).all(),
    );
    if (!queried.ok) return queried;
    return Ok(queried.data.results.map(rowToNudge));
  }

  // --- preferences ---
  async getPreferences(person: string): Promise<Result<Array<Preference>, Error>> {
    const queried = await Result.from(() =>
      this.db.prepare(`SELECT * FROM preferences WHERE person = ?`).bind(person).all(),
    );
    if (!queried.ok) return queried;
    const mapped = Result.fromSync(() =>
      queried.data.results.map((r) => ({
        person: r.person as string,
        rule: r.rule as Preference["rule"],
        selector: parse(r.selector, {} as Record<string, unknown>),
        until: (r.until as string | null) ?? undefined,
      })),
    );
    if (!mapped.ok) return mapped;
    return Ok(mapped.data);
  }

  async upsertPreference(p: Preference): Promise<Result<void, Error>> {
    // Idempotent on (person, rule, selector): repeating a command updates `until`
    // (re-snooze) instead of piling up duplicate rows. selector JSON is canonical
    // because it's produced by fixed code paths.
    const selector = Result.fromSync(() => json(p.selector));
    if (!selector.ok) return selector;
    const written = await Result.from(() =>
      this.db
        .prepare(
          `INSERT INTO preferences (person, rule, selector, until) VALUES (?, ?, ?, ?)
         ON CONFLICT(person, rule, selector) DO UPDATE SET until=excluded.until`,
        )
        .bind(p.person, p.rule, selector.data, p.until ?? null)
        .run(),
    );
    if (!written.ok) return written;
    return Ok(undefined);
  }

  // --- working notes ---
  async getWorkingNotes(
    scope: WorkingNotes["scope"],
    targetId: string,
  ): Promise<Result<WorkingNotes | undefined, Error>> {
    const r = await Result.from(() =>
      this.db
        .prepare(`SELECT * FROM working_notes WHERE scope = ? AND target_id = ?`)
        .bind(scope, targetId)
        .first(),
    );
    if (!r.ok) return r;
    return Ok(r.data ? rowToWorkingNotes(r.data) : undefined);
  }

  async listWorkingNotes(
    scope: WorkingNotes["scope"],
  ): Promise<Result<Array<WorkingNotes>, Error>> {
    const queried = await Result.from(() =>
      this.db.prepare(`SELECT * FROM working_notes WHERE scope = ?`).bind(scope).all(),
    );
    if (!queried.ok) return queried;
    return Ok(queried.data.results.map(rowToWorkingNotes));
  }

  async upsertWorkingNotes(n: WorkingNotes): Promise<Result<void, Error>> {
    const written = await Result.from(() =>
      this.db
        .prepare(
          `INSERT INTO working_notes (scope, target_id, content, content_hash, provenance, external_ref)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, target_id) DO UPDATE SET content=excluded.content,
           content_hash=excluded.content_hash, provenance=excluded.provenance,
           external_ref=excluded.external_ref`,
        )
        .bind(n.scope, n.targetId, n.content, n.contentHash, n.provenance, n.externalRef ?? null)
        .run(),
    );
    if (!written.ok) return written;
    return Ok(undefined);
  }
}
