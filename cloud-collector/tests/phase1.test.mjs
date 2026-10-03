import test from 'node:test';
import assert from 'node:assert/strict';
import {Control,initialState} from '../src/control.mjs';
import {authReason,backoff,RETRY_LIMIT} from '../src/lifecycle.mjs';
const range={since:'2026-10-01',until:'2026-10-02'};
const conn=id=>({userId:id,token:'EA'+'x'.repeat(30),revision:'r'+id,lifecycle_status:'active',schedule:{minutes:60,nextAt:Date.now()+3600000}});
const snap=id=>({snapshot:{complete:true,source:'facebook-server',observedAt:new Date().toISOString(),social:{user:{id}},structures:{},reports:{}}});
function control(ids=['101']){const state=initialState();for(const id of ids)state.connections[id]=conn(id);return new Control(state,async()=>{},async()=>{},{validateApi:async b=>b});}
async function queue(c,id='101',trigger='manual'){c.enqueueCycle({userId:id,...range},trigger);for(const j of c.state.jobs)if(j.state==='queued')j.retryAt=0;return c.prepare();}
async function success(c,w){await c.finish(w,snap(w.job.userId));}
async function publish(c){const w=await c.preparePublication();assert(w);await c.finishPublication(w,{result:'published',cycle_id:w.cycle_id,snapshot:{cycle_id:w.cycle_id}});}

test('auth during a cycle fails that cycle; next mandatory set excludes needs_auth and disconnected',async()=>{
 const c=control(['101','102','103']);c.state.connections['103'].lifecycle_status='disconnected';
 const w=await queue(c);const id=w.job.cycle_id;
 assert.deepEqual(c.currentCycle().active_collection_set,['101','102']);
 await c.finish(w,null,{code:'checkpoint'});
 assert.equal(c.state.cycles.at(-1).result,'failed');assert.equal(c.state.connections['101'].auth_issue_reason,'checkpoint');
 const next=await queue(c,'102','scheduled');assert.notEqual(next.job.cycle_id,id);assert.deepEqual(c.currentCycle().active_collection_set,['102']);
 await success(c,next);await publish(c);assert.equal(c.state.cycles.at(-1).result,'published');
});

test('all auth reasons normalize; transient failures stay active and exhaust bounded retries with increasing backoff',async()=>{
 for(const code of ['selfie','checkpoint','verification_required','expired_session','invalid_token','wrong_identity','unknown_auth_error'])assert.equal(authReason(code),code);
 for(const code of ['network','proxy','container_unavailable',17,'capacity_busy','temporary_provider_failure']){
  const c=control();let w=await queue(c),previousDelay=0;
  for(let n=1;n<=RETRY_LIMIT;n++){
   const before=Date.now();await c.finish(w,null,{code});assert.equal(c.state.connections['101'].lifecycle_status,'active');
   if(n<RETRY_LIMIT){const j=c.state.jobs.at(-1);assert.equal(j.state,'queued');assert(j.retryAt-before>=backoff(n));assert(backoff(n)>previousDelay);previousDelay=backoff(n);assert.equal(await c.prepare(),null);j.retryAt=0;w=await c.prepare();}
  }
  assert.equal(c.state.cycles.at(-1).result,'failed');assert.equal(c.state.jobs.at(-1).attempts.length,RETRY_LIMIT);
 }
});

test('reconnect validation alone does not activate; same identity preserves results and history',async()=>{
 const c=control();c.state.results['101']={observedAt:'2026-10-01T00:00:00Z',history:'preserved'};
 c.state.connections['101'].lifecycle_status='needs_auth';
 await c.request('/v1/connections','POST',{userId:'101',token:'EA'+'y'.repeat(30)});
 assert.equal(c.state.connections['101'].lifecycle_status,'needs_auth');assert.equal(c.state.results['101'].history,'preserved');assert.deepEqual(c.currentCycle().active_collection_set,[]);
 const w=await c.prepare();await success(c,w);assert.equal(c.state.connections['101'].lifecycle_status,'active');assert.equal(c.state.connections['101'].auth_issue_reason,null);await publish(c);
 await c.request('/v1/connections','DELETE',{userId:'101'});assert.equal(c.state.connections['101'].lifecycle_status,'disconnected');assert.equal(c.state.connections['101'].token,undefined);
 await assert.rejects(c.request('/v1/jobs','POST',{userId:'101',...range}),/Reconnect/);
});

test('wrong identity does not activate a reconnect or publish its snapshot',async()=>{
 const c=control();await c.request('/v1/connections','POST',{userId:'101',token:'EA'+'y'.repeat(30)});
 const w=await c.prepare();await c.finish(w,snap('999'));assert.equal(c.state.connections['101'].auth_issue_reason,'wrong_identity');assert.equal(c.state.cycles.at(-1).result,'failed');assert.equal(c.state.results['101'],undefined);
});

test('Keitaro retries reuse Meta generation across restart and terminate without another Meta job',async()=>{
 let c=control();const w=await queue(c);await success(c,w);const generations=structuredClone(c.currentCycle().meta_generations),jobs=c.state.jobs.length;
 let publication=await c.preparePublication();assert.equal(await c.preparePublication(),null,'concurrent callback is leased');await c.finishPublication(publication,{result:'retry',reason:'keitaro_cycle_failed'});
 assert.equal(await c.preparePublication(),null,'backoff survives');
 c=new Control(structuredClone(c.state),async()=>{},async()=>{},{});c.state.notifyRetryAt=0;
 publication=await c.preparePublication();await c.finishPublication(publication,{result:'retry',reason:'keitaro_cycle_failed'});c.state.notifyRetryAt=0;
 publication=await c.preparePublication();await c.finishPublication(publication,{result:'retry',reason:'keitaro_cycle_failed'});
 assert.equal(c.state.cycles.at(-1).result,'failed');assert.deepEqual(c.state.cycles.at(-1).meta_generations,generations);assert.equal(c.state.jobs.length,jobs);assert.equal(c.state.cycles.at(-1).keitaro_attempts.length,3);
});

test('renewal automatically re-arms active socials, excludes auth/disconnected and rejects expired late results',async()=>{
 const c=control(['101','102','103']);c.state.connections['102'].lifecycle_status='needs_auth';c.state.connections['102'].schedule=null;c.state.connections['103'].lifecycle_status='disconnected';c.state.connections['103'].schedule=null;
 const w=await queue(c);await c.subscription(false);assert.equal(await c.prepare(),null);await success(c,w);assert.equal(c.state.results['101'],undefined);
 c.state.connections['101'].schedule=null;await c.subscription(true);assert(c.state.connections['101'].schedule);assert.equal(c.state.connections['102'].schedule,null);assert.equal(c.state.connections['103'].schedule,null);
 let restored=await c.prepare();if(!restored){for(const j of c.state.jobs)if(j.state==='queued')j.retryAt=0;restored=await c.prepare();}assert(restored);assert.equal(restored.job.userId,'101');assert.equal(c.state.connections['101'].lifecycle_status,'active');
});

test('deadline and repeated lease expiry always end processing; stale attempts cannot publish',async()=>{
 const c=control();let w=await queue(c);const first=w;
 c.state.jobs.at(-1).leaseUntil=0;w=await c.prepare();assert(w);await success(c,first);assert.equal(c.state.jobs.at(-1).state,'running');
 c.state.jobs.at(-1).leaseUntil=0;assert.equal(await c.prepare(),null);c.state.jobs.at(-1).retryAt=0;w=await c.prepare();c.state.jobs.at(-1).leaseUntil=0;await c.prepare();assert.equal(c.state.cycles.at(-1).result,'failed');
 const d=control();w=await queue(d);d.currentCycle().deadlineAt=0;d.expireCycle();await success(d,w);assert.equal(d.state.cycles.at(-1).failure_reason,'cycle_timeout');assert.equal(d.state.results['101'],undefined);
});

test('lazy additive state migration preserves credentials and recognizes legacy needs_auth',async()=>{
 const state=initialState();state.connections['101']={userId:'101',token:'secret',schedule:null};state.jobs.push({userId:'101',state:'needs_auth'});const c=new Control(state,async()=>{},async()=>{},{});
 assert.equal(c.state.connections['101'].lifecycle_status,'needs_auth');assert.equal(c.state.connections['101'].token,'secret');assert(c.state.connections['101'].lifecycle_updated_at);
 const revived=new Control(structuredClone(c.state),async()=>{},async()=>{},{});assert.deepEqual(revived.state,c.state);
});

test('failed reconnect validation cannot become mandatory in later active-only cycles',async()=>{
 const c=control(['101','102']);c.state.connections['102'].lifecycle_status='needs_auth';c.state.connections['102'].schedule=null;
 await c.request('/v1/connections','POST',{userId:'102',token:'EA'+'y'.repeat(30)});
 const activeWork=await c.prepare();assert.equal(activeWork.job.userId,'101');await success(c,activeWork);
 let candidate=await c.prepare();
 for(let n=0;n<RETRY_LIMIT;n++){await c.finish(candidate,null,{code:'proxy'});if(n<RETRY_LIMIT){c.state.jobs.find(j=>j.id===candidate.job.id).retryAt=0;candidate=await c.prepare();}}
 assert.equal(c.state.connections['102'].validationPending,undefined);
 const w=await queue(c,'101');assert.deepEqual(c.currentCycle().active_collection_set,['101']);assert.deepEqual(c.currentCycle().validation_set,[]);await success(c,w);await publish(c);
});
