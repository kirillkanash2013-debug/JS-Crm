-- JS Control platform: one row per paying client (tenant).
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL,
  social_limit INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',      -- active | suspended
  paid_until TEXT NOT NULL,                   -- ISO date, inclusive
  created_at TEXT NOT NULL
);

-- Only SHA-256 hashes are stored; the token itself is shown to the client once.
CREATE TABLE access_tokens (
  hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL,                         -- integration | dashboard
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX access_tokens_tenant ON access_tokens(tenant_id, kind);

-- Telegram chats bound to a tenant and their onboarding step.
CREATE TABLE chats (
  chat_id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Client settings entered in the bot. API keys are AES-GCM encrypted.
CREATE TABLE settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  keitaro_url TEXT,
  keitaro_key_enc TEXT,
  timezone TEXT,
  currency TEXT,
  onboarded_at TEXT
);

-- Idempotency for payment webhooks and Telegram Stars payments.
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  amount TEXT,
  currency TEXT,
  created_at TEXT NOT NULL
);
