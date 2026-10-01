import {newInviteCode} from './invites.mjs';
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

async function issueToken(store, tenantId, kind) {
  const token = newToken(kind);
  await store.revokeTokens(tenantId, kind);
  await store.putToken(await hashToken(token), tenantId, kind);
  return token;
}
export const rotateIntegrationToken = (store, tenantId) => issueToken(store, tenantId, 'integration');
export const rotateDashboardToken = (store, tenantId) => issueToken(store, tenantId, 'dashboard');

// Called after a confirmed payment. Idempotent per payment id: a retried
// webhook never creates a second client or a second token.
// With tenantId it is a renewal: the paid period is extended, tokens stay.
export async function applyPayment(store, {paymentId, provider, plan, name, tenantId, amount, currency}) {
  const p = PLANS[plan];
  if (!p) throw new Error('Unknown plan');
  if (!paymentId) throw new Error('paymentId required');
  const seen = await store.payment(paymentId);
  if (seen) return {tenant: await store.tenant(seen.tenantId), integrationToken: null, duplicate: true};

  if (tenantId) {
    const t = await store.tenant(tenantId);
    if (!t) throw new Error('Unknown tenant');
    const from = t.paidUntil >= today() ? t.paidUntil : today();
    await store.extendTenant(t.id, addDays(from, p.days));
    await store.recordPayment({id: paymentId, tenantId: t.id, provider, amount, currency});
    return {tenant: await store.tenant(t.id), integrationToken: null, duplicate: false};
  }

  const tenant = await store.createTenant({id: crypto.randomUUID(), name: String(name || 'Клиент').slice(0, 80), plan, socialLimit: p.socialLimit, paidUntil: addDays(today(), p.days)});
  await store.recordPayment({id: paymentId, tenantId: tenant.id, provider, amount, currency});
  return {tenant, integrationToken: await rotateIntegrationToken(store, tenant.id), duplicate: false};
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

export async function redeemInvite(store, code, {chatId, name}) {
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
  return {tenant, integrationToken: await rotateIntegrationToken(store, tenantId)};
}
