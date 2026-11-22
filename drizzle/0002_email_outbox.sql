CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  customer_id TEXT,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt INTEGER,
  next_attempt INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_due ON email_outbox(status, next_attempt);
