-- Thread Assistant — initial schema (DESIGN §9).
-- Nested collections (handles, participants, timeline, meta, selector) are
-- stored as JSON text columns; relational edges get their own tables.

CREATE TABLE identities (
  id           TEXT PRIMARY KEY,
  handles      TEXT NOT NULL DEFAULT '{}', -- JSON: { github, slack, … }
  email        TEXT,
  display_name TEXT
);
CREATE INDEX idx_identities_email ON identities (email);

CREATE TABLE threads (
  id           TEXT PRIMARY KEY,           -- `${platform}:${nativeId}`
  platform     TEXT NOT NULL,
  native_id    TEXT NOT NULL,
  type         TEXT NOT NULL,
  title        TEXT,
  body         TEXT,
  state        TEXT NOT NULL,
  participants TEXT NOT NULL DEFAULT '[]', -- JSON: Identity ids
  owner        TEXT,
  meta         TEXT NOT NULL DEFAULT '{}', -- JSON
  timeline     TEXT NOT NULL DEFAULT '[]', -- JSON: TimelineEvent[]
  updated_at   TEXT NOT NULL,
  UNIQUE (platform, native_id)
);

CREATE TABLE links (
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  kind    TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX idx_links_from ON links (from_id);
CREATE INDEX idx_links_to ON links (to_id);

CREATE TABLE clusters (
  id TEXT PRIMARY KEY
);

CREATE TABLE cluster_threads (
  cluster_id TEXT NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  thread_id  TEXT NOT NULL,
  PRIMARY KEY (cluster_id, thread_id)
);

CREATE TABLE signals (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  owed_by     TEXT,
  detected_at TEXT NOT NULL,
  cleared_at  TEXT
);
CREATE INDEX idx_signals_thread_open ON signals (thread_id) WHERE cleared_at IS NULL;

CREATE TABLE nudges (
  dedupe_key  TEXT PRIMARY KEY,           -- `${person}:${threadId}:${signalKind}`
  person      TEXT NOT NULL,
  signal_id   TEXT NOT NULL,
  channel     TEXT NOT NULL,
  sent_at     TEXT,
  state       TEXT NOT NULL,
  escalations INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_nudges_person ON nudges (person);

CREATE TABLE preferences (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  person   TEXT NOT NULL,
  rule     TEXT NOT NULL,
  selector TEXT NOT NULL DEFAULT '{}',    -- JSON
  until    TEXT
);
CREATE INDEX idx_preferences_person ON preferences (person);

CREATE TABLE working_notes (
  scope        TEXT NOT NULL,             -- 'thread' | 'cluster'
  target_id    TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,             -- idempotency
  provenance   TEXT NOT NULL,
  PRIMARY KEY (scope, target_id)
);
