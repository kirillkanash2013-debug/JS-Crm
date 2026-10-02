import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {applyPayment, authenticate, rotateDashboardToken} from '../src/accounts.mjs';
import {D1Store} from '../src/store.mjs';

// Minimal D1 API over SQLite so the real SQL and migration are exercised.
function d1(db) {
  return {prepare(sql) {
    let args = [];
    const stmt = {bind(...a) { args = a; return stmt; }, async run() { db.prepare(sql).run(...args); return {success: true}; }, async first() { return db.prepare(sql).get(...args) ?? null; }, async all() { return {results: db.prepare(sql).all(...args)}; }};
    return stmt;
  }};
}

test('D1Store works with the migration schema', async () => {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort())
    db.exec(fs.readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const store = new D1Store(d1(db));
  const {tenant, integrationToken} = await applyPayment(store, {paymentId: 'x1', provider: 'test', plan: 'start', name: 'A'});
  assert.equal((await authenticate(store, integrationToken, 'integration')).tenant.id, tenant.id);
  assert.equal((await applyPayment(store, {paymentId: 'x1', provider: 'test', plan: 'start'})).duplicate, true);
  const renewed = await applyPayment(store, {paymentId: 'x2', provider: 'test', plan: 'start', tenantId: tenant.id});
  assert(renewed.tenant.paidUntil > tenant.paidUntil);
  const d1Token = await rotateDashboardToken(store, tenant.id), d2Token = await rotateDashboardToken(store, tenant.id);
  assert.equal((await authenticate(store, d1Token, 'dashboard')).error, 'invalid');
  assert.equal((await authenticate(store, d2Token, 'dashboard')).error, null);
  await store.setChat(5, tenant.id, 'keitaro_url'); await store.setChat(5, tenant.id, 'ready');
  assert.deepEqual(await store.chat(5), {tenantId: tenant.id, state: 'ready'});
  await store.saveSettings(tenant.id, {keitaroUrl: 'https://k.test'}); await store.saveSettings(tenant.id, {timezone: 'UTC'});
  assert.deepEqual(await store.settings(tenant.id), {keitaroUrl: 'https://k.test', keitaroKeyEnc: null, keitaroSub: null, timezone: 'UTC', currency: null, onboardedAt: null});

  // Agents and socials.
  const ag = await store.createAgent(tenant.id, 'Иван');
  assert.deepEqual(await store.listAgents(tenant.id), [{id: ag.id, name: 'Иван'}]);
  assert.equal(await store.social(tenant.id, '100'), null);
  await store.addSocial(tenant.id, '100', 'Алина');
  assert.deepEqual(await store.social(tenant.id, '100'), {userId: '100', label: 'Алина', agentId: null, notifyMsgId: null, rk: null, bm: null, fp: null, collectedAt: null});
  await store.assignSocial(tenant.id, '100', ag.id);
  assert.equal((await store.social(tenant.id, '100')).agentId, ag.id);
  await store.setSocialNotifyMsg(tenant.id, '100', 777);
  await store.setSocialStats(tenant.id, '100', {rk: 5, bm: 1, fp: 2, collectedAt: '2026-10-02'});
  assert.deepEqual(await store.social(tenant.id, '100'), {userId: '100', label: 'Алина', agentId: ag.id, notifyMsgId: '777', rk: 5, bm: 1, fp: 2, collectedAt: '2026-10-02'});
  await store.deleteAgent(tenant.id, ag.id);
  assert.equal((await store.social(tenant.id, '100')).agentId, null);
  assert.deepEqual(await store.listAgents(tenant.id), []);
});
