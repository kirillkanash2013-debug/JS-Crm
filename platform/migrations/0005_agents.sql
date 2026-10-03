-- Agents (buyers) a client distributes their socials across, for spend
-- accounting. Each social (one Facebook login = one userId) is tracked so new
-- ones can be detected and assigned later — one at a time or in bulk.
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX agents_tenant ON agents (tenant_id);

CREATE TABLE socials (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  label TEXT,
  agent_id TEXT,              -- NULL until assigned to an agent
  seen_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
