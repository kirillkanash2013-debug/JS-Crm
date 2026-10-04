-- Additive: legacy aggregates and receipts remain intact.
CREATE TABLE keitaro_evidence (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), source TEXT NOT NULL, evidence_id TEXT NOT NULL,
 ingested_at TEXT NOT NULL, context TEXT NOT NULL, enc TEXT NOT NULL,
 PRIMARY KEY(tenant_id,source,evidence_id)
);
CREATE TABLE keitaro_events (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), source TEXT NOT NULL, event_key TEXT NOT NULL,
 source_id TEXT, evidence_id TEXT NOT NULL, ingested_at TEXT NOT NULL, fact TEXT NOT NULL,
 PRIMARY KEY(tenant_id,source,event_key)
);
CREATE TABLE keitaro_attribution (
 tenant_id TEXT NOT NULL, source TEXT NOT NULL, event_key TEXT NOT NULL,
 campaign_id TEXT, state TEXT NOT NULL CHECK(state IN ('matched','unmatched','unattributed')),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,source,event_key),
 FOREIGN KEY(tenant_id,source,event_key) REFERENCES keitaro_events(tenant_id,source,event_key)
);
CREATE TABLE stats_snapshot_history (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), cycle_id TEXT NOT NULL,
 completed_at TEXT NOT NULL, source_times TEXT NOT NULL, enc TEXT NOT NULL,
 PRIMARY KEY(tenant_id,cycle_id)
);
CREATE TRIGGER immutable_snapshot_update BEFORE UPDATE ON stats_snapshot_history BEGIN SELECT RAISE(ABORT,'immutable published snapshot'); END;
CREATE TRIGGER immutable_snapshot_delete BEFORE DELETE ON stats_snapshot_history BEGIN SELECT RAISE(ABORT,'immutable published snapshot'); END;
CREATE INDEX keitaro_attribution_pending ON keitaro_attribution(tenant_id,source,state,campaign_id);

CREATE TABLE keitaro_event_observations (
 tenant_id TEXT NOT NULL, source TEXT NOT NULL, event_key TEXT NOT NULL, evidence_id TEXT NOT NULL,
 observed_at TEXT NOT NULL, fact TEXT NOT NULL,
 PRIMARY KEY(tenant_id,source,event_key,evidence_id),
 FOREIGN KEY(tenant_id,source,event_key) REFERENCES keitaro_events(tenant_id,source,event_key)
);

-- Only the still-available latest payload can be recovered; never invent old history.
INSERT OR IGNORE INTO stats_snapshot_history
 SELECT s.tenant_id,s.cycle_id,s.completed_at,r.source_times,s.enc
 FROM stats_snapshots s JOIN stats_publication_receipts r
 ON r.tenant_id=s.tenant_id AND r.cycle_id=s.cycle_id
 WHERE s.enc IS NOT NULL AND s.completed_at IS NOT NULL;
