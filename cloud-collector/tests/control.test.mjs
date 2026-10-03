import test from 'node:test';
import assert from 'node:assert/strict';
import {EncryptedStore} from '../src/crypto-store.mjs';
import {Control,initialState} from '../src/control.mjs';
const key=Buffer.alloc(32,7).toString('base64');
function storage(){const data=new Map();return {data,get:async k=>data.get(k),put:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k),transaction:async fn=>{const copy=new Map(data);try{return await fn({get:async k=>data.get(k),put:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k)});}catch(e){data.clear();for(const [k,v] of copy)data.set(k,v);throw e;}}};}
const connection={userId:'100123456',token:'EA'+'x'.repeat(30),cookies:[{name:'xs',value:'secret-cookie'}]};
const body=async r=>r.json();
test('refresh frequency updates all active schedules and becomes the default for future connections',async()=>{
 const c=new Control(initialState(),async()=>{},async()=>{},{validate:async x=>x});
 await c.request('/v1/connections','POST',connection);
 await c.request('/v1/connections','POST',{...connection,userId:'100123457'});
 c.state.connections['100123457'].schedule=null;
 assert.equal((await c.request('/v1/refresh-frequency','POST',{minutes:30})).status,200);
 assert.equal(c.state.connections[connection.userId].schedule.minutes,30);
 assert.equal(c.state.connections['100123457'].schedule,null);
 await c.request('/v1/connections','POST',{...connection,userId:'100123458'});
 assert.equal(c.state.connections['100123458'].schedule.minutes,30);
 assert.equal((await c.request('/v1/refresh-frequency','POST',{minutes:1})).status,422);
 assert.equal(c.state.refreshMinutes,30);
});
const range={userId:connection.userId,since:'2026-10-01',until:'2026-10-01'};
test('Durable Object vault survives new instance, chunks large snapshots, detects tampering and shrinks',async()=>{
 const db=storage(),v=new EncryptedStore(db,key),payload={cookie:'secret-cookie',large:'z'.repeat(200000)};await v.save(payload);assert(db.data.get('chunks')>1);for(const [k,b] of db.data)if(k.startsWith('part:'))assert(!Buffer.from(b).includes(Buffer.from('secret-cookie')));
 assert.deepEqual(await new EncryptedStore(db,key).load(),payload);await v.save({small:true});assert.equal(db.data.get('chunks'),1);assert.equal(db.data.has('part:1'),false);assert.deepEqual(await v.load(),{small:true});db.data.get('part:0')[25]^=1;await assert.rejects(v.load());
});
test('persisted alarm job runs without extension, verifies owner and retains last snapshot after error',async()=>{
 const db=storage(),v=new EncryptedStore(db,key);let alarm=null,calls=0;const runner={validate:async c=>c,collect:async(c,r)=>{calls++;return {snapshot:{complete:true,source:'facebook-server',observedAt:new Date().toISOString(),social:{user:{id:c.userId}},structures:{},reports:{}},storageState:{cookies:[]}};}};
 let c=new Control(initialState(),s=>v.save(s),time=>{alarm=time;},runner);
 await c.request('/v1/connections','POST',connection);const queued=await body(await c.request('/v1/jobs','POST',range));assert.equal(queued.state,'queued');assert(alarm>Date.now());
 // Drop the control instance as if its runtime was evicted. All input is persisted.
 c=new Control(await v.load(),s=>v.save(s),time=>{alarm=time;},runner);const work=await c.prepare();await c.finish(work,await runner.collect(work.connection,work.job.range));assert.equal(calls,1);assert.equal(c.status().jobs[0].state,'done');assert(alarm>Date.now(),'server keeps the default schedule armed for the next run');assert(!JSON.stringify(c.status()).includes(connection.token));assert(!JSON.stringify(c.status()).includes('secret-cookie'));
 const previous=c.status().results[connection.userId];c.state.connections[connection.userId].lastCollectedAt=Date.now()-16*60000;await c.request('/v1/schedule','POST',{userId:connection.userId,minutes:15});await c.request('/v1/jobs','POST',range);const failed=await c.prepare();await c.finish(failed,null,{code:190});assert.equal(c.status().jobs.at(-1).state,'needs_auth');assert.deepEqual(c.status().results[connection.userId],previous);assert.equal(c.status().connections[0].schedule,null);
});
test('deleting or replacing a session prevents late job results from being published',async()=>{
 const c=new Control(initialState(),async()=>{},async()=>{},{validate:async x=>x});await c.request('/v1/connections','POST',connection);await c.request('/v1/jobs','POST',range);const work=await c.prepare();await c.request('/v1/connections','DELETE',{userId:connection.userId});await c.finish(work,{snapshot:{complete:true,source:'facebook-server',social:{user:{id:connection.userId}}}});assert.deepEqual(c.status().results,{});assert.equal(c.status().jobs[0].state,'cancelled');
});
test('expired leases recover, schedules enqueue autonomously, wrong owner never replaces result',async()=>{
 const c=new Control(initialState(),async()=>{},async()=>{},{validate:async x=>x});await c.request('/v1/connections','POST',connection);await c.request('/v1/schedule','POST',{userId:connection.userId,minutes:15});c.state.connections[connection.userId].schedule.nextAt=0;const first=await c.prepare();assert.equal(first.job.state,'running');c.state.jobs[0].leaseUntil=0;const recovered=await c.prepare();assert.equal(recovered.job.recovered,true);assert.notEqual(recovered.job.attempt,first.job.attempt);
 await c.finish(first,{snapshot:{complete:true,source:'facebook-server',social:{user:{id:connection.userId}}}});assert.equal(c.state.jobs[0].state,'running');await c.finish(recovered,{snapshot:{complete:true,source:'facebook-server',social:{user:{id:'999999'}}}});assert.equal(c.state.jobs[0].state,'failed');assert.deepEqual(c.state.results,{});
});

test('manual and scheduled collections wait at least 15 minutes after success, including restart',async()=>{
 const state=initialState(),c=new Control(state,async()=>{},async()=>{},{validate:async x=>x});
 await c.request('/v1/connections','POST',connection);
 c.state.jobs=[];c.state.connections[connection.userId].lastCollectedAt=Date.now();
 c.state.connections[connection.userId].schedule.nextAt=0;
 assert.equal(await c.prepare(),null);
 const j=c.state.jobs[0];assert(j.retryAt>=c.state.connections[connection.userId].lastCollectedAt+15*60000);
 const manual=await body(await c.request('/v1/jobs','POST',range));assert.equal(manual.id,j.id,'button reuses the pending scheduled job');
 const restarted=new Control(structuredClone(c.state),async()=>{},async()=>{},{validate:async x=>x});
 assert.equal(await restarted.prepare(),null,'restart cannot bypass cooldown');
 restarted.state.jobs[0].retryAt=Date.now()-1;
 assert.equal((await restarted.prepare()).job.id,j.id,'work starts once the cooldown has elapsed');
});
