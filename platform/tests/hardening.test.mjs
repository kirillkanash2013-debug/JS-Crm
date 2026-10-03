import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {D1Store,MemoryStore} from '../src/store.mjs';
import {applyPayment} from '../src/accounts.mjs';
import {operationsRoute,OperationsStore,operationsTick} from '../src/operations.mjs';
import {buildNow} from '../src/today.mjs';
function database(){
 const db=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())db.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 let chain=Promise.resolve();
 return {prepare(sql){let args=[];const st={bind(...a){args=a;return st;},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:r.changes}};},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};}};return st;},batch(stmts){const p=chain.then(async()=>{db.exec('BEGIN');try{const result=[];for(const st of stmts)result.push(await st.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}});chain=p.catch(()=>{});return p;}};
}
test('concurrent duplicate payments create one client and renew exactly once on real SQL',async()=>{
 const store=new D1Store(database());const input={paymentId:'initial',provider:'test',plan:'team'};
 const out=await Promise.all(Array.from({length:20},()=>applyPayment(store,input)));
 assert.equal(new Set(out.map(r=>r.tenant.id)).size,1);assert.equal(out.filter(r=>!r.duplicate).length,1);
 const t=out[0].tenant;
 const renewed=await Promise.all(Array.from({length:20},()=>applyPayment(store,{...input,paymentId:'renew',tenantId:t.id})));
 assert.equal(renewed.filter(r=>!r.duplicate).length,1);
 const expected=new Date(t.paidUntil);expected.setUTCDate(expected.getUTCDate()+30);assert.equal((await store.tenant(t.id)).paidUntil,expected.toISOString().slice(0,10));
 assert.equal(await store.claimOwner(t.id,1),true);assert.equal(await store.claimOwner(t.id,2),false);
});
test('durable webhook dedupe survives new store instance',async()=>{
 const db=database(),store=new D1Store(db);assert(await store.claimUpdate(1));assert.equal(await new D1Store(db).claimUpdate(1),false);await store.finishUpdate(1,true);assert.equal(await new D1Store(db).claimUpdate(1),false);
});
test('admin API checks service key and actor; preview confirmation is single-use and private',async()=>{
 const db=database(),store=new D1Store(db),ops=new OperationsStore(db),sent=[];
 const {tenant}=await applyPayment(store,{paymentId:'a',provider:'test',plan:'team',name:'Client'});await store.setChat(42,tenant.id,'ready');
 const env={DB:db,ADMIN_API_KEY:'secret',ADMIN_CHAT_IDS:'7'};
 const call=(path,body={},actor='7',key='secret')=>operationsRoute(new Request('https://p/internal/admin/'+path,{method:'POST',headers:{authorization:'Bearer '+key,'x-admin-actor':actor},body:JSON.stringify(body)}),env,{store,ops,tg:async(m,b)=>sent.push(b)});
 assert.equal((await call('clients',{},'8')).status,403);assert.equal((await call('clients',{},'7','bad')).status,401);
 const clients=await (await call('clients')).json();assert(!JSON.stringify(clients).includes('integrationToken'));
 const d=await (await call('message/preview',{tenantId:tenant.id,text:'Обновление готово'})).json();assert.equal(sent.length,0);
 assert.equal((await call('message/confirm',{id:d.id})).status,200);assert.equal((await call('message/confirm',{id:d.id})).status,409);assert.equal(sent.length,1);assert.equal(sent[0].chat_id,'42');
});
test('uncertain Telegram delivery is not retried by a repeated confirmation',async()=>{
 const db=database(),store=new D1Store(db),ops=new OperationsStore(db);const {tenant}=await applyPayment(store,{paymentId:'b',provider:'test',plan:'team'});await store.setChat(42,tenant.id,'ready');const d=await ops.draft('7',tenant.id,'Test');
 let calls=0;const call=()=>operationsRoute(new Request('https://p/internal/admin/message/confirm',{method:'POST',headers:{authorization:'Bearer secret','x-admin-actor':'7'},body:JSON.stringify({id:d.id})}),{DB:db,ADMIN_API_KEY:'secret',ADMIN_CHAT_IDS:'7'},{store,ops,tg:async()=>{calls++;throw new Error('network');}});
 assert.equal((await call()).status,502);assert.equal((await call()).status,409);assert.equal(calls,1);
});
test('reports do not pretend missing revenue is zero or combine currencies',()=>{
 const absent=buildNow({day:'2026-10-03',campaigns:[{spend:10,name:'A'}]});assert(absent.includes('ROI —'));assert(!absent.includes('-100%'));
 const mixed=buildNow({day:'2026-10-03',campaigns:[{spend:10,currency:'USD'},{spend:20,currency:'EUR'}]});assert(mixed.includes('10.00 USD'));assert(mixed.includes('20.00 EUR'));assert(!mixed.includes('$30'));
});
test('broadcasts honor late opt-out, cap each tick and never repeat uncertain sends',async()=>{
 const db=database(),store=new D1Store(db),ops=new OperationsStore(db);
 const clients=[];
 for(let i=0;i<13;i++){
  const {tenant}=await applyPayment(store,{paymentId:'broadcast-'+i,provider:'test',plan:'team'});
  await store.claimOwner(tenant.id,100+i);await store.setChat(100+i,tenant.id,'ready');clients.push(tenant.id);
 }
 await store.setServiceMessages(clients[0],false);
 const draft=await ops.draft('7','*','Обновление');
 await ops.consume(draft.id,'7');await ops.queueBroadcast({...draft,tenant_id:'*'});
 const initial=await ops.deliveries(draft.id,'7');assert.equal(initial.counts[0].count,12);
 await store.setServiceMessages(clients[1],false);
 const calls=[];const tg=async(m,b)=>{calls.push(b.chat_id);if(b.chat_id==='102')throw new Error('ambiguous network failure');};
 await operationsTick({DB:db},tg);assert(calls.length<=10);
 await operationsTick({DB:db},tg);const n=calls.length;await operationsTick({DB:db},tg);
 assert.equal(calls.length,n);assert(!calls.includes('101'));assert.equal(calls.filter(c=>c==='102').length,1);
 const status=await ops.deliveries(draft.id,'7');assert.equal(status.state,'completed');assert.equal(status.counts.find(c=>c.state==='unknown').count,1);
 const cancelled=await ops.draft('7','*','Не отправлять');assert.equal(await ops.cancel(cancelled.id,'8'),false);assert.equal(await ops.cancel(cancelled.id,'7'),true);assert.equal(await ops.consume(cancelled.id,'7'),null);
});
