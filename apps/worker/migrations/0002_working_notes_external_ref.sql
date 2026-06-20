-- Sticky working-notes comment id (DESIGN §8): the platform message reference
-- so the bot edits its comment in place instead of appending new ones.
ALTER TABLE working_notes ADD COLUMN external_ref TEXT;
