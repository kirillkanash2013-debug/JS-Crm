import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {SqlArchive} from '../src/archive.mjs';
import {Control, initialState} from '../src/control.mjs';

// Durable Object ctx.storage.sql over node:sqlite, counting written rows like billing does.
function doSql() {
  const db = new DatabaseSync(':memory:');
  const sql = {written: 0, exec(q, ...b) {
    const st = db.prepare(q);
    if (/^\s*(SELECT)/i.test(q)) { const r = st.all(...b); return {toArray: () => r, one: () => r[0]}; }
    const r = st.run(...b); sql.written += r.changes; return {toArray: () => [], rowsWritten: r.changes};
  }};
  return sql;
}

const structure = (acc, at, budget = '1000', status = 'ACTIVE') => ({schemaVersion: 1, complete: true, observedAt: at, account: {id: acc, name: 'Acc ' + acc, currency: 'USD'},
  campaigns: [{id: acc + '1', accountId: acc, name: 'Camp', status, effectiveStatus: status, daily_budget: budget}],
  adsets: [{id: acc + '2', accountId: acc, campaignId: acc + '1', name: 'Set', status: 'ACTIVE', effectiveStatus: 'ACTIVE'}],
  ads: [{id: acc + '3', accountId: acc, campaignId: acc + '1', adsetId: acc + '2', name: 'Ad', status: 'ACTIVE', effectiveStatus: 'ACTIVE'}]});
const snap = (at, spend, s) => ({schemaVersion: 1, source: 'facebook-server', mode: 'api', complete: true, observedAt: at,
  social: {user: {id: '100', name: 'Owner'}, accounts: [{id: '555', name: 'Acc 555', currency: 'USD', timezone: 'UTC', statusRaw: 1, business: {id: '9', name: 'BM'}}]},
  reports: {'555': {account: {id: '555', currency: 'USD'}, campaigns: [{id: '5551', accountId: '555', name: 'Camp', status: s.campaigns[0].status, effectiveStatus: s.campaigns[0].effectiveStatus, dailyBudgetRaw: s.campaigns[0].daily_budget}],
    metrics: [{campaignId: '5551', since: '2026-10-01', until: '2026-10-01', spend, currency: 'USD'}]}},
  structures: {'555': s}});

test('history: only changes are written; change log; report; structure rebuilt for the cache', async () => {
  const sql = doSql(), puts = [];
  const bucket = {put: async (key, body, opts) => puts.push({key, body, opts})};
  const a = new SqlArchive(sql, bucket);
  const s1 = structure('555', '2026-10-01T10:00:00.000Z');
  sql.written = 0;
  const sum = await a.record('100', snap('2026-10-01T10:00:00.000Z', 10, s1));
  assert.deepEqual(sum.spendByCurrency, {USD: 10}); assert.equal(sum.ads, 1);
  const firstWrites = sql.written;

  sql.written = 0;
  await a.record('100', snap('2026-10-01T10:15:00.000Z', 10, s1));
  assert.equal(sql.written, 2, 'unchanged run writes only the social summary and the run log');
  assert(firstWrites > sql.written * 2);

  sql.written = 0;
  await a.record('100', snap('2026-10-01T10:30:00.000Z', 12.5, s1));
  assert.equal(sql.written, 3, 'one spend row more');

  const s2 = structure('555', '2026-10-01T11:00:00.000Z', '2000', 'PAUSED');
  await a.record('100', snap('2026-10-01T11:00:00.000Z', 12.5, s2));
  const log = a.changes({since: '2026-10-01'});
  assert.deepEqual(log.map(c => c.field + ':' + c.old + '→' + c.new).sort(), ['daily_budget:1000→2000', 'effective_status:ACTIVE→PAUSED', 'status:ACTIVE→PAUSED']);

  const rep = a.report({since: '2026-10-01', until: '2026-10-01'});
  assert.deepEqual(rep.totals, {USD: 12.5});
  assert.equal(rep.rows[0].campaignName, 'Camp'); assert.equal(rep.rows[0].accountName, 'Acc 555'); assert.equal(rep.rows[0].status, 'PAUSED');

  const camps = a.campaigns({userId: '100', date: '2026-10-01'});
  assert.equal(camps.length, 1);
  assert.equal(camps[0].campaignId, '5551');
  assert.equal(camps[0].name, 'Camp');
  assert.equal(camps[0].status, 'PAUSED');
  assert.equal(String(camps[0].dailyBudget), '2000');
  assert.equal(camps[0].spend, 12.5);
  assert.equal(camps[0].currency, 'USD');
  assert.throws(() => a.campaigns({userId: '100', date: 'bad'}), /Invalid date/);

  const prev = a.previous('100').structures['555'];
  assert.equal(prev.observedAt, s2.observedAt);
  assert.deepEqual(prev.campaigns, s2.campaigns.map(c => ({...c, daily_budget: '2000'})));
  assert.deepEqual(prev.ads, s2.ads);

  assert.equal(puts.at(-1).key, 'raw/100/2026-10-01/11.json.gz');
  assert.equal(JSON.parse(gunzipSync(Buffer.from(puts.at(-1).body))).observedAt, '2026-10-01T11:00:00.000Z');
  assert.throws(() => a.report({since: '2026-10-02', until: '2026-10-01'}), /Invalid period/);
});

test('collector keeps only compact summaries in state; report via API; history survives disconnect', async () => {
  const sql = doSql(), archive = new SqlArchive(sql);
  const s = structure('555', new Date().toISOString());
  let previousSeen;
  const runner = {validate: async x => x, collectApi: async (c, r, previous) => { previousSeen = previous; return {snapshot: snap(new Date().toISOString(), 7, s)}; }};
  const c = new Control(initialState(), async () => {}, async () => {}, runner, archive);
  await c.request('/v1/connections', 'POST', {userId: '100', token: 'EA' + 'x'.repeat(30)}, 5);
  for (let i = 0; i < 2; i++) {
    await c.request('/v1/jobs', 'POST', {userId: '100', since: '2026-10-01', until: '2026-10-01'}, 5);
    const w = await c.prepare(); const {result, error} = await c.execute(w); await c.finish(w, result, error);
  }
  assert.equal(previousSeen.structures['555'].observedAt, s.observedAt, 'second run gets the cached structure from SQL');
  const status = c.status();
  assert.deepEqual(Object.keys(status.results['100']).sort(), ['accounts', 'ads', 'adsets', 'businesses', 'campaigns', 'complete', 'mode', 'observedAt', 'pages', 'source', 'spendByCurrency']);
  assert(JSON.stringify(c.state).length < 3000, 'state blob stays small');
  const rep = await (await c.request('/v1/report', 'GET', {since: '2026-10-01', until: '2026-10-01'})).json();
  assert.deepEqual(rep.totals, {USD: 7});
  await c.request('/v1/connections', 'DELETE', {userId: '100'});
  assert.deepEqual(c.status().results, {});
  assert.deepEqual((await (await c.request('/v1/report', 'GET', {since: '2026-10-01', until: '2026-10-01'})).json()).totals, {USD: 7}, 'history kept');
});
