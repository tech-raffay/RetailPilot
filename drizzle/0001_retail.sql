CREATE TABLE organizations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, document TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE members (org_id TEXT NOT NULL, principal TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (org_id,principal));
--> statement-breakpoint
CREATE INDEX member_principal ON members(principal);
--> statement-breakpoint
CREATE TABLE sessions (token TEXT PRIMARY KEY, org_id TEXT NOT NULL, principal TEXT NOT NULL, expires INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE invites (token TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, expires INTEGER NOT NULL);
