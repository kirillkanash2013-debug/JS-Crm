import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Control, initialState} from '../src/control.mjs';
import {collectViaApi} from '../src/api-collector.mjs';
import {resolveCaller} from '../src/tenants.mjs';
import {applyPayment} from '../../platform/src/accounts.mjs';
import {D1Store} from '../../platform/src/store.mjs';

const conn = (id, cookies = [{name: 'c_user', value: id, domain: '.facebook.com'}]) => ({userId: id, token: 'EA' + 'x'.repeat(30), cookies, userAgent: 'UA'});
const snapshot = (id, extra = {}) => ({snapshot: {complete: true, source: 'facebook-server', observedAt: new Date().toISOString(), social: {user: {id}}, structures: {}, reports: {}}, ...extra});
const fail = code => Object.assign(new Error('x'), {code});
const range = id => ({userId: id, since: '2026-10-01', until: '2026-10-01'});

function control(runner, limit = 10) {
  const c = new Control(initialState(), async () => {}, async () => {}, {validate: async x => x, ...runner});
  const add = async id => { await c.request('/v1/connections', 'POST', conn(id), limit); await c.request('/v1/jobs', 'POST', range(id), limit); };
  // Transport tests run queued work as if its cooldown has elapsed.
  const cycle = async () => { for(const j of c.state.jobs)if(j.state==='queued')j.retryAt=0; const w = await c.prepare(); const {result, error} = await c.execute(w); await c.finish(w, result, error);if(c.currentCycle()?.phase==='keitaro')c.endCycle(c.currentCycle(),'published'); return w; };
  return {c, add, cycle};
}

test('API mode needs no browser; browser is the fallback that also brings a fresh token', async () => {
  let api = 0, browser = 0;
  const {c, add, cycle} = control({
    collectApi: async (x, r, previous) => { api++; if (api === 2) throw fail(190); return snapshot(x.userId); },
    collect: async x => { browser++; return snapshot(x.userId, {token: 'EA' + 'n'.repeat(30), storageState: {cookies: [{name: 'xs'}]}}); }
  });
  await add('101'); await cycle();
  assert.equal(api, 1); assert.equal(browser, 0); assert.equal(c.state.jobs[0].mode, 'api');
  await c.request('/v1/jobs', 'POST', range('101'), 10); await cycle();
  assert.equal(browser, 1, 'dead token → one browser run');
  assert.equal(c.state.connections['101'].token, 'EA' + 'n'.repeat(30));
  assert.deepEqual(c.state.connections['101'].storageState, {cookies: [{name: 'xs'}]});
  assert.equal(c.state.connections['101'].mode, 'api', 'token refresh keeps the cheap mode');
  assert(!JSON.stringify(c.status()).includes('EA' + 'n'.repeat(30)));
});

test('after 3 API rejections (code 1) the social uses the browser for a day, then API again', async () => {
  let api = 0;
  const {c, add, cycle} = control({collectApi: async () => { api++; throw fail(1); }, collect: async x => snapshot(x.userId)});
  await add('102');
  for (let i = 0; i < 3; i++) { if (i) await c.request('/v1/jobs', 'POST', range('102'), 10); await cycle(); }
  assert.equal(c.state.connections['102'].mode, 'browser'); assert.equal(api, 3);
  await c.request('/v1/jobs', 'POST', range('102'), 10); await cycle();
  assert.equal(api, 3, 'browser mode skips the API');
  c.state.connections['102'].apiRetryAt = 0;
  await c.request('/v1/jobs', 'POST', range('102'), 10); await cycle();
  assert.equal(api, 4); assert.equal(c.status().connections[0].collectMode, 'browser', 'still failing → stays in browser mode again later');
});

test('proxy and rate-limit errors retry without a browser or auth transition', async () => {
 let browser=0,code='proxy';
 const {c,add,cycle}=control({collectApi:async()=>{throw fail(code);},collect:async x=>{browser++;return snapshot(x.userId);}});
 await add('103');await cycle();assert.equal(browser,0);assert.equal(c.state.jobs[0].state,'queued');
 code=17;await cycle();await cycle();assert.equal(c.state.jobs[0].state,'failed');assert.equal(c.currentCycle(),undefined);
 assert.notEqual(c.state.connections['103'].auth_issue_reason,'invalid_token');
});

test('up to 4 API jobs run in parallel; browser jobs run alone; connection count is unlimited', async () => {
  const {c, add} = control({collectApi: async x => snapshot(x.userId), collect: async x => snapshot(x.userId)}, 6);
  for (const id of ['1001', '1002', '1003', '1004', '1005', '1006']) await add(id);
  const limited = await c.request('/v1/connections', 'POST', conn('1007'), 6);
  assert.equal(limited.status, 201); assert.equal(Object.keys(c.state.connections).length,7);
  const works = [];
  for (let w; (w = await c.prepare());) works.push(w);
  assert.equal(works.length, 4);
  for (const w of works) { const {result, error} = await c.execute(w); await c.finish(w, result, error); }
  c.state.connections['1005'].mode = 'browser'; c.state.connections['1005'].apiRetryAt = Date.now() + 1e6;
  const w5 = await c.prepare();
  assert.equal(w5.job.userId, '1005');
  assert.equal(await c.prepare(), null, 'nothing runs next to a browser job');
});

test('structure is re-read at most hourly; spend every run', async () => {
  const calls = [];
  const fetcher = async url => {
    const u = new URL(url); calls.push(u.pathname);
    const p = u.pathname.replace('/v25.0/', '');
    const body = p === 'me' ? {id: '100', name: 'O'} : p === '100/adaccounts' ? {data: [{account_id: '555', name: 'A', currency: 'USD'}]}
      : p === 'act_555' ? {account_id: '555', name: 'A', currency: 'USD'} : {data: []};
    return {ok: true, status: 200, json: async () => body};
  };
  fetcher.pageContext = true;
  const c = conn('100'), r = {since: '2026-10-01', until: '2026-10-01'};
  const first = await collectViaApi(c, r, {fetcher});
  const n = calls.length;
  assert(calls.includes('/v25.0/act_555/ads'));
  const second = await collectViaApi(c, r, {fetcher, previous: first.snapshot});
  assert(!calls.slice(n).includes('/v25.0/act_555/ads'), 'cached structure reused');
  assert(calls.slice(n).includes('/v25.0/act_555/insights'), 'spend read again');
  assert.strictEqual(second.snapshot.structures['555'], first.snapshot.structures['555']);
  calls.length = 0;
  await collectViaApi(c, r, {fetcher, previous: first.snapshot, now: () => Date.now() + 61 * 60000});
  assert(calls.includes('/v25.0/act_555/ads'), 'refreshed after an hour');
});

test('collector access: owner and client have unlimited connections; expired and unknown still refused', async () => {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(new URL('../../platform/migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL('../../platform/migrations/' + f, import.meta.url), 'utf8'));
  const d1 = {async batch(stmts){db.exec('BEGIN');try{const out=[];for(const st of stmts)out.push(await st.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}},prepare(sql) { let a = []; const st = {bind(...x) { a = x; return st; }, async run() { const r = db.prepare(sql).run(...a); return {meta: {changes: r.changes}}; }, async first() { return db.prepare(sql).get(...a) ?? null; }}; return st; }};
  const store = new D1Store(d1);
  const {tenant, integrationToken} = await applyPayment(store, {paymentId: 'p', provider: 't', plan: 'start'});
  const owner = 'js_srv_' + 'o'.repeat(43), equal = async (a, b) => a === b;
  const env = {JS_CONTROL_OWNER_KEY: owner, DB: d1};
  const asOwner = await resolveCaller('Bearer ' + owner, env, equal);
  assert.equal(asOwner.space, 'owner'); assert.equal(asOwner.socialLimit, 0);
  const asTenant = await resolveCaller('Bearer ' + integrationToken, env, equal);
  assert.equal(asTenant.space, 'tenant:' + tenant.id); assert.equal(asTenant.socialLimit, 0);
  assert.equal(asTenant.account.plan, 'start'); assert.equal(asTenant.account.socialLimit, 0);
  assert.equal((await resolveCaller('Bearer jsi_' + 'z'.repeat(43), env, equal)).status, 401);
  assert.equal((await resolveCaller('Bearer ' + integrationToken, {JS_CONTROL_OWNER_KEY: owner}, equal)).status, 503);
  await store.extendTenant(tenant.id, '2020-01-01');
  assert.equal((await resolveCaller('Bearer ' + integrationToken, env, equal)).status, 402);
});
test('bulk import ignores the old persisted connection quota',()=>{
 const c=new Control({...initialState(),socialLimit:1},async()=>{},async()=>{},{ });
 const job={state:'running'};
 c.applyImport(job,{at:new Date().toISOString(),found:20,items:Array.from({length:20},(_,i)=>({userId:String(1000+i)})),skipped:[]},null);
 assert.equal(Object.keys(c.state.connections).length,20);assert.equal(job.state,'done');
});

test('bookmarklet connection (no cookies): dead token asks the client to reconnect, no browser run', async () => {
  let browser = 0;
  const c = new Control(initialState(), async () => {}, async () => {}, {validate: async x => x, collectApi: async () => { throw fail(190); }, collect: async x => { browser++; return snapshot(x.userId); }});
  await c.request('/v1/connections', 'POST', conn('104', []), 10);
  await c.request('/v1/schedule', 'POST', {userId: '104', minutes: 15}, 10);
  await c.request('/v1/jobs', 'POST', range('104'), 10);
  const w = await c.prepare(); const {result, error} = await c.execute(w); await c.finish(w, result, error);
  assert.equal(browser, 0); assert.equal(c.state.jobs[0].state, 'needs_auth');
  // Reconnect through the bookmark keeps the client's schedule settings untouched until set again.
  await c.request('/v1/connections', 'POST', {...conn('104', []), token: 'EA' + 'y'.repeat(30)}, 10);
  assert.equal(c.state.connections['104'].token, 'EA' + 'y'.repeat(30));
});

test('connect errors are reported as readable codes', async () => {
  const c = new Control(initialState(), async () => {}, async () => {}, {validateApi: async () => { throw fail('proxy'); }});
  const r = await c.request('/v1/connections', 'POST', conn('105'), 10);
  assert.equal(r.status, 422); assert.deepEqual(await r.json(), {error: 'proxy_failed', detail: 'x'});
});
