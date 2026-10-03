-- Explicit social lifecycle for the JS CRM MVP.
-- `paused` is intentionally NOT part of the lifecycle contract.
ALTER TABLE socials ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE socials ADD COLUMN auth_issue_reason TEXT;
ALTER TABLE socials ADD COLUMN lifecycle_updated_at TEXT;
ALTER TABLE socials ADD COLUMN disconnected_at TEXT;

CREATE INDEX IF NOT EXISTS socials_tenant_lifecycle
  ON socials (tenant_id, lifecycle_status);
