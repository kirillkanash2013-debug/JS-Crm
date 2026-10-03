-- Additive migration; existing payment records are already applied.
ALTER TABLE payments ADD COLUMN applied INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN stats_msg_id TEXT;
CREATE TABLE webhook_updates (id TEXT PRIMARY KEY, state TEXT NOT NULL, lease_until INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE operations_audit (id TEXT PRIMARY KEY, actor TEXT NOT NULL, kind TEXT NOT NULL, tenant_id TEXT, created_at TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE admin_drafts (id TEXT PRIMARY KEY, actor TEXT NOT NULL, tenant_id TEXT NOT NULL, body TEXT NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending');

ALTER TABLE tenants ADD COLUMN owner_chat_id TEXT;
UPDATE tenants SET owner_chat_id=(SELECT chat_id FROM chats WHERE tenant_id=tenants.id ORDER BY updated_at DESC LIMIT 1);
CREATE TABLE stars_orders(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,tenant_id TEXT,plan TEXT NOT NULL,amount INTEGER NOT NULL,created_at TEXT NOT NULL,expires_at INTEGER NOT NULL);
ALTER TABLE settings ADD COLUMN service_messages INTEGER NOT NULL DEFAULT 1;
CREATE TABLE admin_deliveries(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL,tenant_id TEXT NOT NULL,chat_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',updated_at TEXT NOT NULL);
CREATE INDEX admin_deliveries_pending ON admin_deliveries(state,updated_at);
