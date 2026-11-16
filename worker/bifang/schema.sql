-- Applied explicitly before deployment. Memorial GET requests never create tables.
CREATE TABLE IF NOT EXISTS po_archive_recovery (
  device TEXT NOT NULL,
  revision TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  token TEXT,
  PRIMARY KEY (device, revision)
);
CREATE TABLE IF NOT EXISTS po_archive_manifest (
  revision TEXT PRIMARY KEY,
  poem_count INTEGER NOT NULL,
  line_count INTEGER NOT NULL
);
