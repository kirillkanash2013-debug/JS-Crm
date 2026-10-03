-- Operational phases contain no customer traffic data.
CREATE TABLE stats_refresh_state (
 tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
 phase TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
