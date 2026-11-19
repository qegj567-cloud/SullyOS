ALTER TABLE beauty_repos ADD COLUMN inbox_delivered_at INTEGER;
-- Both historical queues were reviewed. Backfill them once, leaving pending mail private.
UPDATE beauty_repos SET status='sent', inbox_delivered_at=unixepoch()*1000
  WHERE status IN ('sent','archived');
CREATE INDEX beauty_repos_inbox ON beauty_repos(submission_id, inbox_delivered_at DESC, created_at DESC, id DESC)
  WHERE inbox_delivered_at IS NOT NULL;
