-- Last complete Facebook → Keitaro pair, encrypted with the tenant key.
CREATE TABLE stats_snapshots (
 tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
 enc TEXT,
 completed_at TEXT,
 lock_owner TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0
);
