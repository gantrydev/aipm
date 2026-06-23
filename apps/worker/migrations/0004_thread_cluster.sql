-- 0004 — make the cluster the unit of work (issue #8).
-- Flat thread→cluster membership with minted ids, replacing cluster_threads.

CREATE TABLE IF NOT EXISTS thread_cluster (
  thread_id  TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_cluster_cluster ON thread_cluster (cluster_id);

-- Mint one fresh id per existing cluster group (randomblob = minted, not derived).
CREATE TABLE cluster_id_remap (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL
);
INSERT INTO cluster_id_remap (old_id, new_id)
  SELECT id, lower(hex(randomblob(16))) FROM clusters;

-- Backfill existing multi-thread membership under the minted ids.
-- INSERT OR IGNORE: if a thread was (corruptly) in two clusters, the first wins.
INSERT OR IGNORE INTO thread_cluster (thread_id, cluster_id)
  SELECT ct.thread_id, r.new_id
  FROM cluster_threads ct
  JOIN cluster_id_remap r ON r.old_id = ct.cluster_id;

-- Backfill singletons: every thread not yet in thread_cluster gets its own minted cluster.
INSERT OR IGNORE INTO thread_cluster (thread_id, cluster_id)
  SELECT native_id, lower(hex(randomblob(16)))
  FROM threads
  WHERE native_id NOT IN (SELECT thread_id FROM thread_cluster);

-- Drop the old membership table (removes its FK dependency on clusters).
DROP TABLE cluster_threads;

-- Rebuild clusters to hold exactly the minted ids now in use.
DELETE FROM clusters;
INSERT INTO clusters (id) SELECT DISTINCT cluster_id FROM thread_cluster;

DROP TABLE cluster_id_remap;
