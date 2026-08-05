-- Job priority helper index (claim order still uses CASE on kind)
CREATE INDEX IF NOT EXISTS idx_jobs_pending_kind ON jobs(status, kind, created_at);

-- Track discovery cursor / strategy knobs on crawler_state
ALTER TABLE crawler_state ADD COLUMN prefer_new INTEGER NOT NULL DEFAULT 1;
