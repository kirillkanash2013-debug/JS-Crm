-- Snapshot replacement and publication receipt commit in the same D1 transaction.
ALTER TABLE stats_snapshots ADD COLUMN cycle_id TEXT;
CREATE TABLE stats_publication_receipts (
 tenant_id TEXT NOT NULL REFERENCES tenants(id),
 cycle_id TEXT NOT NULL,
 completed_at TEXT NOT NULL,
 source_times TEXT NOT NULL,
 PRIMARY KEY (tenant_id,cycle_id)
);
