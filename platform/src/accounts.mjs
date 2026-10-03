import {newInviteCode} from './invites.mjs';
import {sealSecret} from './secrets.mjs';
import {hashToken, newToken, tokenKind} from './tokens.mjs';

export const PLANS = {
  start: {name: 'Start', socialLimit: 3, days: 30},
  team: {name: 'Team', socialLimit: 15, days: 30},
  agency: {name: 'Agency', socialLimit: 50, days: 30}
};

const addDays = (from, days) => {
  const d = new Date(from + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

export function isActive(tenant, date = today()) {
  return !!tenant && tenant.status === 'active' && tenant.paidUntil >= date;
}

async function issueToken(store, tenantId, kind, masterKey) {
  const token = newToken(kind);
  await store.revokeTokens(tenantId, kind);
  await store.putToken(await hashToken(token), tenantId, kind);
  // Keep a sealed copy of the integration token so the platform can read the
  // tenant's data from the collector for the dashboard. Auth still uses the hash.
  if (kind === 'integration' && masterKey) await store.setIntegrationTokenEnc(tenantId, await sealSecret(masterKey, tenantId, token));
  return token;
}
export const rotateIntegrationToken = (store, tenantId, masterKey) => issueToken(store, tenantId, 'integration', masterKey);
export const rotateDashboardToken = (store, tenantId) => issueToken(store, tenantId, 'dashboard');

// Called after a confirmed payment. Idempotent per payment id: a retried
// webhook never creates a second client or a second token.
// With tenantId it is a renewal: the paid period is extended, tokens stay.
export async function applyPayment(store, {paymentId, provider, plan, name, tenantId, amount, currency, masterKey}) {
  const p = PLANS[plan];
  if (!p) throw new Error('Unknown plan');
  if (!paymentId) throw new Error('paymentId required');
  const existing = tenantId ? await store.tenant(tenantId) : null;
  if(tenantId&&!existing)throw new Error('Unknown tenant');
  const tenant=existing||{id:crypto.randomUUID(),name:String(name||'Клиент').slice(0,80),plan,socialLimit:p.socialLimit,paidUntil:addDays(today(),p.days)};
  const raw=tenantId?null:newToken('integration');
  const token=raw?{hash:await hashToken(raw),enc:masterKey?await sealSecret(masterKey,tenant.id,raw):null}:null;
  const result=await store.commitPayment({id:paymentId,provider,amount,currency,renewal:!!tenantId,days:p.days,today:today()},tenant,token);
  return {...result,integrationToken:result.duplicate?null:raw};
}

// Resolves a token to its tenant. Returns {tenant, error} so callers can
// tell "wrong token" from "subscription expired".
export async function authenticate(store, token, kind) {
  if (tokenKind(token) !== kind) return {tenant: null, error: 'invalid'};
  const id = await store.tokenTenant(await hashToken(token), kind);
  const tenant = id && await store.tenant(id);
  if (!tenant) return {tenant: null, error: 'invalid'};
  if (!isActive(tenant)) return {tenant, error: 'expired'};
  return {tenant, error: null};
}

// Free access by one-time invite codes. A code creates exactly one account
// and is then dead; a chat that already has an account cannot spend a code.
export async function createInvite(store, {plan = 'team', days = 30, note = '', validDays = 14} = {}) {
  if (!PLANS[plan]) throw new Error('Unknown plan');
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('days must be 1..365');
  const code = newInviteCode();
  const id = crypto.randomUUID().slice(0, 6);
  await store.createInvite({id, hash: await hashToken(code), plan, days, note: String(note).slice(0, 80), expiresAt: addDays(today(), validDays)});
  return {id, code, plan, days};
}

export async function redeemInvite(store, code, {chatId, name, masterKey}) {
  const hash = await hashToken(code);
  const invite = await store.invite(hash);
  if (!invite) return {error: 'invalid'};
  if (invite.revokedAt) return {error: 'revoked'};
  if (invite.usedAt) return {error: 'used'};
  if (invite.expiresAt < today()) return {error: 'expired'};
  const tenantId = crypto.randomUUID();
  // Claim first: two people sending the same code at once cannot both win.
  if (!await store.claimInvite(hash, tenantId, chatId)) return {error: 'used'};
  const tenant = await store.createTenant({id: tenantId, name: String(name || invite.note || 'Клиент').slice(0, 80), plan: invite.plan, socialLimit: PLANS[invite.plan].socialLimit, paidUntil: addDays(today(), invite.days)});
  await store.recordPayment({id: 'invite:' + invite.id, tenantId, provider: 'invite', amount: '0', currency: null});
  return {tenant, integrationToken: await rotateIntegrationToken(store, tenantId, masterKey)};
}
