// Who is calling the collector and which isolated space (Durable Object) they own.
import {authenticate} from '../../platform/src/accounts.mjs';
import {D1Store} from '../../platform/src/store.mjs';

export const OWNER_SOCIAL_LIMIT = 100;

export async function resolveCaller(authorization, env, equal) {
  const value = String(authorization || '');
  if (/^js_srv_[A-Za-z0-9_-]{43}$/.test(env.JS_CONTROL_OWNER_KEY || '') && await equal(value, 'Bearer ' + env.JS_CONTROL_OWNER_KEY))
    return {space: 'owner', socialLimit: OWNER_SOCIAL_LIMIT, account: {name: 'Owner', plan: 'owner', socialLimit: OWNER_SOCIAL_LIMIT, paidUntil: null}};
  const token = value.startsWith('Bearer jsi_') ? value.slice(7) : null;
  if (!token) return {error: 'unauthorized', status: 401};
  // Client tokens are checked against the platform database (bind it as DB).
  if (!env.DB) return {error: 'platform_not_configured', status: 503};
  const {tenant, error} = await authenticate(new D1Store(env.DB), token, 'integration');
  if (error === 'expired') return {error: 'subscription_expired', status: 402, account: {name: tenant.name, plan: tenant.plan, paidUntil: tenant.paidUntil}};
  if (error) return {error: 'unauthorized', status: 401};
  return {space: 'tenant:' + tenant.id, socialLimit: tenant.socialLimit, account: {name: tenant.name, plan: tenant.plan, socialLimit: tenant.socialLimit, paidUntil: tenant.paidUntil}};
}
