import test from 'node:test';
import assert from 'node:assert/strict';
import {Control,initialState} from '../../cloud-collector/src/control.mjs';
import {createBot} from '../src/bot.mjs';
import {MemoryStore} from '../src/store.mjs';
import {applyPayment} from '../src/accounts.mjs';
import {sealSecret,openSecret} from '../src/secrets.mjs';
const MASTER_KEY=btoa('x'.repeat(32));

test('collector and platform share cycle identity: KT recovery publishes existing generation; changed generation retains previous snapshot',async()=>{
 const store=new MemoryStore();const {tenant}=await applyPayment(store,{paymentId:'phase1',provider:'test',plan:'team',masterKey:MASTER_KEY});
 await store.saveSettings(tenant.id,{timezone:'UTC',keitaroUrl:'https://k.test',keitaroKeyEnc:await sealSecret(MASTER_KEY,tenant.id,'api-key')});
 const state=initialState();state.connections['101']={userId:'101',lifecycle_status:'active',revision:'r',token:'EA'+'x'.repeat(30)};
 state.connections['102']={userId:'102',lifecycle_status:'needs_auth',auth_issue_reason:'selfie',schedule:null};
 const c=new Control(state,async()=>{},async()=>{},{});let metaCalls=0,ktCalls=0,fail=true,change=false;
 const env={MASTER_KEY,COLLECTOR_URL:'https://c.test',KEITARO_BRIDGE:{report:async()=>{ktCalls++;if(change)c.state.results['101'].observedAt=new Date(Date.now()+1000).toISOString();return fail?{result:'unreachable'}:{result:'ok',report:[],conversions:[]};}}};
 const bot=createBot({store,env,tg:async()=>({})});const real=globalThis.fetch;
 globalThis.fetch=async url=>{if(url.endsWith('/v1/status'))return Response.json(c.status());if(url.includes('/v1/campaigns'))return Response.json({campaigns:[]});return Response.json({});};
 const collect=async()=>{c.state.connections['101'].lastCollectedAt=0;c.enqueueCycle({userId:'101',since:'2026-10-01',until:'2026-10-02'});c.state.jobs.filter(j=>j.state==='queued').forEach(j=>j.retryAt=0);const w=await c.prepare();metaCalls++;await c.finish(w,{snapshot:{complete:true,source:'facebook-server',observedAt:new Date().toISOString(),social:{user:{id:'101'}},reports:{},structures:{}}});};
 const publish=async()=>{const w=await c.preparePublication();assert(w);try{const outcome=await bot.notifyStatsRefresh(tenant.id);await c.finishPublication(w,outcome);return outcome;}catch(e){await c.finishPublication(w,{result:'failed',reason:e.message});throw e;}};
 try{
  await collect();const cycle=c.currentCycle().cycle_id;assert.deepEqual(c.currentCycle().active_collection_set,['101']);
  assert.equal((await publish()).result,'retry');assert.equal(await store.statsSnapshot(tenant.id).then(s=>s?.enc),undefined);
  fail=false;c.state.notifyRetryAt=0;assert.equal((await publish()).result,'published');assert.equal(metaCalls,1);assert.equal(ktCalls,2);assert.equal(c.state.cycles.at(-1).result,'published');
  const first=await store.statsSnapshot(tenant.id);const decoded=JSON.parse(await openSecret(MASTER_KEY,tenant.id,first.enc));assert.equal(decoded.cycle_id,cycle);assert.equal(c.state.cycles.at(-1).published_snapshot.cycle_id,cycle);
  await collect();change=true;await assert.rejects(publish(),/facebook_cycle_changed/);assert.equal((await store.statsSnapshot(tenant.id)).enc,first.enc);assert.equal(c.state.cycles.at(-1).result,'failed');
 }finally{globalThis.fetch=real;}
});

import {resumeCollection} from '../src/refresh.mjs';
import {route} from '../src/index.mjs';
test('renewal webhook and replay wake a legacy collector without a reconnect or duplicate subscription extension',async()=>{
 const store=new MemoryStore();const {tenant}=await applyPayment(store,{paymentId:'legacy',provider:'test',plan:'start',masterKey:MASTER_KEY});
 const c=new Control({connections:{'101':{userId:'101',token:'preserved',schedule:null}},jobs:[],results:{}},async()=>{},async()=>{},{});
 let wakes=0,unavailable=true;const env={MASTER_KEY,BILLING_WEBHOOK_SECRET:'secret',WEB_PRICE_START:'49',COLLECTOR:{fetch:async(url,init)=>{wakes++;assert(url.endsWith('/v1/subscription/resume'));assert.match(init.headers.Authorization,/Bearer jsi_/);if(unavailable)return Response.json({},{status:503});return c.request('/v1/subscription/resume','POST',{});}}};
 const body=JSON.stringify({paymentId:'renew-legacy',provider:'test',plan:'start',tenantId:tenant.id,amount:49,currency:'USD'});
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=[...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const call=()=>route(new Request('https://p.test/billing/webhook',{method:'POST',headers:{'x-signature':sig},body}),env,{store,tg:async()=>({})});
 await assert.rejects(call(),/scheduler_resume_failed/);const renewed=(await store.tenant(tenant.id)).paidUntil;
 unavailable=false;const result=await (await call()).json();assert.equal(result.duplicate,true);assert.equal((await store.tenant(tenant.id)).paidUntil,renewed);assert.equal(wakes,2);assert(c.state.connections['101'].schedule);assert.equal(c.state.connections['101'].token,'preserved');
 await resumeCollection(store,{},tenant.id);
});
