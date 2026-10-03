-- Sealed copy of the integration token (AES-GCM, per-tenant key from MASTER_KEY).
-- The hash still authenticates the client; this lets the platform call the
-- collector on the tenant's behalf to render the dashboard. Decryptable only
-- with MASTER_KEY, so a leaked row does not expose the token.
ALTER TABLE tenants ADD COLUMN integration_token_enc TEXT;
