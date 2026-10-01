-- One-time invite codes for free access. Only the hash of a code is stored.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,                -- short public id for /invites and /revoke
  hash TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL,
  days INTEGER NOT NULL,              -- access length after redemption
  note TEXT,                          -- who it was given to
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,           -- last day the code can be redeemed
  revoked_at TEXT,
  used_at TEXT,
  tenant_id TEXT,                     -- set before the tenant row exists (claim first), so no FK
  used_by_chat TEXT
);
