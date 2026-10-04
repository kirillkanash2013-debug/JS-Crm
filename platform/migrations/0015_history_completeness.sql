-- Historical ingestion is separate from refresh/publication ownership.
ALTER TABLE keitaro_events ADD COLUMN observed_at TEXT;
ALTER TABLE keitaro_events ADD COLUMN event_day TEXT;
UPDATE keitaro_events SET observed_at=ingested_at,
 event_day=substr(CASE json_extract(fact,'$.kind')
 WHEN 'registration' THEN json_extract(fact,'$.registration_at')
 WHEN 'ftd' THEN json_extract(fact,'$.ftd_at') ELSE json_extract(fact,'$.conversion_at') END,1,10);
UPDATE keitaro_events SET event_day=NULL WHERE event_day NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR date(event_day) IS NULL OR date(event_day)<>event_day;
CREATE INDEX keitaro_event_day ON keitaro_events(tenant_id,source,event_day);
CREATE TABLE keitaro_observation_history (
 tenant_id TEXT NOT NULL, source TEXT NOT NULL, event_key TEXT NOT NULL,
 observation_id TEXT NOT NULL, evidence_id TEXT NOT NULL, observed_at TEXT NOT NULL,
 fact TEXT NOT NULL, campaign_id TEXT,
 PRIMARY KEY(tenant_id,source,event_key,observation_id),
 FOREIGN KEY(tenant_id,source,event_key) REFERENCES keitaro_events(tenant_id,source,event_key)
);
INSERT INTO keitaro_observation_history
 SELECT tenant_id,source,event_key,'legacy:'||evidence_id,evidence_id,observed_at,fact,NULL
 FROM keitaro_event_observations;
CREATE TRIGGER immutable_observation_update BEFORE UPDATE ON keitaro_observation_history BEGIN SELECT RAISE(ABORT,'immutable source observation'); END;
CREATE TRIGGER immutable_observation_delete BEFORE DELETE ON keitaro_observation_history BEGIN SELECT RAISE(ABORT,'immutable source observation'); END;
CREATE TABLE keitaro_history_state (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), source TEXT NOT NULL,
 cursor_day TEXT, last_success_at TEXT, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 last_result TEXT, last_error TEXT, last_window TEXT,
 PRIMARY KEY(tenant_id,source)
);
CREATE TABLE keitaro_known_campaigns (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), campaign_id TEXT NOT NULL, first_seen_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,campaign_id)
);
ALTER TABLE keitaro_history_state ADD COLUMN capabilities TEXT;
ALTER TABLE keitaro_history_state ADD COLUMN capabilities_checked_at TEXT;

INSERT OR IGNORE INTO keitaro_known_campaigns
 SELECT tenant_id,campaign_id,MIN(updated_at) FROM keitaro_attribution
 WHERE state='matched' AND campaign_id IS NOT NULL GROUP BY tenant_id,campaign_id;

CREATE TRIGGER immutable_legacy_observation_update BEFORE UPDATE ON keitaro_event_observations BEGIN SELECT RAISE(ABORT,'immutable source observation'); END;
CREATE TRIGGER immutable_legacy_observation_delete BEFORE DELETE ON keitaro_event_observations BEGIN SELECT RAISE(ABORT,'immutable source observation'); END;
