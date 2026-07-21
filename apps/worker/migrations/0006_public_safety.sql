-- 0006 — public-free safeguards.
-- Managed workspaces are shadow-first and audit records are append-only for the
-- lifetime of a workspace. Cascading removal during workspace offboarding is
-- intentionally allowed.

CREATE TRIGGER workspace_shadow_config_after_insert
AFTER INSERT ON workspaces
WHEN NEW.id <> 'legacy'
  AND NOT EXISTS (
    SELECT 1 FROM workspace_config WHERE workspace_id = NEW.id
  )
BEGIN
  INSERT INTO workspace_config (
    workspace_id,
    config_json,
    revision,
    updated_at
  ) VALUES (
    NEW.id,
    '{"shadow":{"global":true,"capabilities":{}}}',
    1,
    datetime('now')
  );
END;

INSERT INTO workspace_config (workspace_id, config_json, revision, updated_at)
SELECT
  id,
  '{"shadow":{"global":true,"capabilities":{}}}',
  1,
  datetime('now')
FROM workspaces
WHERE id <> 'legacy'
ON CONFLICT(workspace_id) DO NOTHING;

CREATE TRIGGER audit_actions_no_update
BEFORE UPDATE ON audit_actions
BEGIN
  SELECT RAISE(ABORT, 'audit_actions are immutable');
END;

CREATE TRIGGER audit_actions_no_delete
BEFORE DELETE ON audit_actions
WHEN EXISTS (
  SELECT 1 FROM workspaces WHERE id = OLD.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'audit_actions are immutable');
END;
