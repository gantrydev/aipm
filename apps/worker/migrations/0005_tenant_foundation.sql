-- 0005 — managed tenant foundation.
-- Existing self-hosted data is assigned to a stable legacy workspace while
-- engine-domain primary keys and indexes become workspace-scoped.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  github_account_id INTEGER,
  github_account_type TEXT,
  github_account_login TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (github_account_id, github_account_type)
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE github_installations (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'deleted')),
  suspended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, installation_id)
);

CREATE TABLE github_repositories (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, repository_id),
  UNIQUE (workspace_id, full_name)
);
CREATE INDEX idx_github_repositories_installation
  ON github_repositories (workspace_id, installation_id, status, enabled);

CREATE TABLE workspace_config (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  config_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_actions (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  repository_id INTEGER,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  actor_json TEXT NOT NULL DEFAULT '{}',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_audit_actions_created
  ON audit_actions (workspace_id, created_at DESC);

INSERT INTO workspaces (id, name, created_at, updated_at)
VALUES ('legacy', 'Legacy self-hosted workspace', datetime('now'), datetime('now'));

ALTER TABLE identities RENAME TO identities_legacy;
CREATE TABLE identities (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  handles TEXT NOT NULL DEFAULT '{}',
  email TEXT,
  display_name TEXT,
  PRIMARY KEY (workspace_id, id)
);
INSERT INTO identities SELECT 'legacy', id, handles, email, display_name FROM identities_legacy;
DROP TABLE identities_legacy;
CREATE INDEX idx_identities_email ON identities (workspace_id, email);

ALTER TABLE threads RENAME TO threads_legacy;
CREATE TABLE threads (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  platform TEXT NOT NULL,
  native_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  body TEXT,
  state TEXT NOT NULL,
  participants TEXT NOT NULL DEFAULT '[]',
  owner TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  timeline TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, platform, native_id)
);
INSERT INTO threads
  SELECT 'legacy', id, platform, native_id, type, title, body, state,
    participants, owner, meta, timeline, updated_at
  FROM threads_legacy;
DROP TABLE threads_legacy;

ALTER TABLE links RENAME TO links_legacy;
CREATE TABLE links (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (workspace_id, from_id, to_id, kind)
);
INSERT INTO links SELECT 'legacy', from_id, to_id, kind FROM links_legacy;
DROP TABLE links_legacy;
CREATE INDEX idx_links_from ON links (workspace_id, from_id);
CREATE INDEX idx_links_to ON links (workspace_id, to_id);

ALTER TABLE clusters RENAME TO clusters_legacy;
CREATE TABLE clusters (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
INSERT INTO clusters SELECT 'legacy', id FROM clusters_legacy;
DROP TABLE clusters_legacy;

ALTER TABLE thread_cluster RENAME TO thread_cluster_legacy;
CREATE TABLE thread_cluster (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, thread_id)
);
INSERT INTO thread_cluster SELECT 'legacy', thread_id, cluster_id FROM thread_cluster_legacy;
DROP TABLE thread_cluster_legacy;
CREATE INDEX idx_thread_cluster_cluster
  ON thread_cluster (workspace_id, cluster_id);

ALTER TABLE signals RENAME TO signals_legacy;
CREATE TABLE signals (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  owed_by TEXT,
  detected_at TEXT NOT NULL,
  cleared_at TEXT,
  PRIMARY KEY (workspace_id, id)
);
INSERT INTO signals
  SELECT 'legacy', id, thread_id, kind, owed_by, detected_at, cleared_at FROM signals_legacy;
DROP TABLE signals_legacy;
CREATE INDEX idx_signals_thread_open
  ON signals (workspace_id, thread_id) WHERE cleared_at IS NULL;

ALTER TABLE nudges RENAME TO nudges_legacy;
CREATE TABLE nudges (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  person TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  sent_at TEXT,
  state TEXT NOT NULL,
  escalations INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, dedupe_key)
);
INSERT INTO nudges
  SELECT 'legacy', dedupe_key, person, signal_id, channel, sent_at, state, escalations
  FROM nudges_legacy;
DROP TABLE nudges_legacy;
CREATE INDEX idx_nudges_person ON nudges (workspace_id, person);

ALTER TABLE preferences RENAME TO preferences_legacy;
CREATE TABLE preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  person TEXT NOT NULL,
  rule TEXT NOT NULL,
  selector TEXT NOT NULL DEFAULT '{}',
  until TEXT,
  UNIQUE (workspace_id, person, rule, selector)
);
INSERT INTO preferences (workspace_id, person, rule, selector, until)
  SELECT 'legacy', person, rule, selector, until FROM preferences_legacy;
DROP TABLE preferences_legacy;
CREATE INDEX idx_preferences_person ON preferences (workspace_id, person);

ALTER TABLE working_notes RENAME TO working_notes_legacy;
CREATE TABLE working_notes (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  target_id TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  provenance TEXT NOT NULL,
  external_ref TEXT,
  PRIMARY KEY (workspace_id, scope, target_id)
);
INSERT INTO working_notes
  SELECT 'legacy', scope, target_id, content, content_hash, provenance, external_ref
  FROM working_notes_legacy;
DROP TABLE working_notes_legacy;
