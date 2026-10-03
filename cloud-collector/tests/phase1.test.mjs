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
 assert.equal(c.state.connections['101'].lifecycle_status,'needs_auth');assert.equal(c.state.results['101'].history,'preserved');assert.equal(c.currentCycle(),undefined);
 const w=await c.prepare();await success(c,w);assert.equal(c.state.connections['101'].lifecycle_status,'active');assert.equal(c.state.connections['101'].auth_issue_reason,null);await publish(c);
 await c.request('/v1/connections','DELETE',{userId:'101'});assert.equal(c.state.connections['101'].lifecycle_status,'disconnected');assert.equal(c.state.connections['101'].token,undefined);
 await assert.rejects(c.request('/v1/jobs','POST',{userId:'101',...range}),/Reconnect/);
});

test('wrong identity does not activate a reconnect or publish its snapshot',async()=>{
 const c=control();await c.request('/v1/connections','POST',{userId:'101',token:'EA'+'y'.repeat(30)});
 const w=await c.prepare();await c.finish(w,snap('999'));assert.equal(c.state.connections['101'].auth_issue_reason,'wrong_identity');assert.equal(c.currentCycle(),undefined);assert.equal(c.state.jobs.at(-1).state,'needs_auth');assert.equal(c.state.results['101'],undefined);
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
 const d=control();w=await queue(d);d.currentCycle().deadlineAt=0;await d.expireCycle();await success(d,w);assert.equal(d.state.cycles.at(-1).failure_reason,'cycle_timeout');assert.equal(d.state.results['101'],undefined);
});

test('lazy additive state migration preserves credentials and recognizes legacy needs_auth',async()=>{
 const state=initialState();state.connections['101']={userId:'101',token:'secret',schedule:null};state.jobs.push({userId:'101',state:'needs_auth'});const c=new Control(state,async()=>{},async()=>{},{});
 assert.equal(c.state.connections['101'].lifecycle_status,'needs_auth');assert.equal(c.state.connections['101'].token,'secret');assert(c.state.connections['101'].lifecycle_updated_at);
 const revived=new Control(structuredClone(c.state),async()=>{},async()=>{},{});assert.deepEqual(revived.state,c.state);
});

test('failed reconnect validation cannot become mandatory in later active-only cycles',async()=>{
 const c=control(['101','102']);c.state.connections['102'].lifecycle_status='needs_auth';c.state.connections['102'].schedule=null;
 await c.request('/v1/connections','POST',{userId:'102',token:'EA'+'y'.repeat(30)});
 c.enqueueCycle({userId:'101',...range});
 let candidate=await c.prepare();assert.equal(candidate.job.userId,'102');
 const activeWork=await c.prepare();assert.equal(activeWork.job.userId,'101');await success(c,activeWork);
 for(let n=0;n<RETRY_LIMIT;n++){await c.finish(candidate,null,{code:'proxy'});if(n<RETRY_LIMIT){c.state.jobs.find(j=>j.id===candidate.job.id).retryAt=0;candidate=await c.prepare();}}
 assert.equal(c.state.connections['102'].validationPending,undefined);
 assert.deepEqual(c.currentCycle().active_collection_set,['101']);await publish(c);
 const w=await queue(c,'101');assert.deepEqual(c.currentCycle().validation_set,[]);await success(c,w);await publish(c);
});

test('validation checkpoint is traced separately and cannot fail a successful mandatory active cycle',async()=>{
 const c=control(['101','102']);c.state.connections['102'].lifecycle_status='needs_auth';
 const activeWork=await queue(c);
 await c.request('/v1/connections','POST',{userId:'102',token:'EA'+'y'.repeat(30)});
 const candidate=await c.prepare();const cycle=c.currentCycle();
 assert.equal(candidate.job.kind,'validation');assert.equal(candidate.job.cycle_id,undefined);
 assert.equal(candidate.job.validation_origin_cycle_id,cycle.cycle_id);assert.deepEqual(cycle.meta_jobs,[activeWork.job.id]);
 await success(c,activeWork);await c.finish(candidate,null,{code:'checkpoint'});
 assert.equal(c.state.connections['102'].lifecycle_status,'needs_auth');assert.equal(c.state.connections['102'].auth_issue_reason,'checkpoint');
 assert.equal(cycle.phase,'keitaro');await publish(c);assert.equal(cycle.result,'published');
});

test('successful candidate does not change the current mandatory set; next cycle includes its verified identity',async()=>{
 const c=control(['101','102']);c.state.connections['102'].lifecycle_status='needs_auth';const w=await queue(c);
 await c.request('/v1/connections','POST',{userId:'102',token:'EA'+'y'.repeat(30)});const candidate=await c.prepare();await success(c,candidate);
 assert.equal(c.state.connections['102'].lifecycle_status,'active');assert.deepEqual(c.currentCycle().active_collection_set,['101']);
 await success(c,w);await publish(c);c.enqueueCycle({userId:'101',...range});assert.deepEqual(c.currentCycle().active_collection_set,['101','102']);
});

for(const state of ['queued','running'])test(`existing ${state} campaign action cannot satisfy collection dedupe`,async()=>{
 const c=control();const action={id:'action',userId:'101',action:{campaignId:'12345',status:'PAUSED'},state,createdAt:new Date().toISOString()};
 c.state.jobs.push(action);let actionWork;
 if(state==='running'){action.attempt='action-attempt';action.leaseUntil=Date.now()+60000;actionWork={job:structuredClone(action),connection:structuredClone(c.state.connections['101'])};}
 const collection=c.enqueueCycle({userId:'101',...range});const cycle=c.currentCycle();
 assert.notEqual(collection.id,action.id);assert.equal(collection.kind,'collection');assert.equal(collection.cycle_id,cycle.cycle_id);assert.deepEqual(cycle.meta_jobs,[collection.id]);assert.equal(action.cycle_id,undefined);
 assert.equal(c.enqueue({userId:'101',...range}).id,collection.id);
 if(state==='queued')actionWork=await c.prepare();
 await c.finish(actionWork,{actionResult:{campaignId:'12345',state:'done',observedAt:new Date().toISOString()}});
 assert.deepEqual(cycle.meta_jobs,[collection.id]);collection.retryAt=0;const work=await c.prepare();assert.equal(work.job.id,collection.id);
 await success(c,work);await publish(c);assert.equal(cycle.result,'published');
});

import {graph} from '../../extension/meta.mjs';
import {collectionError} from '../../shared/collection-errors.mjs';
for(const status of [503,429])for(const json of [false,true])test(`HTTP ${status}, ${json?'JSON':'non-JSON'} preserves transport status and exhausts bounded retry without needs_auth`,async()=>{
 const c=control();c.runner.collectApi=()=>graph('me',{},'token',async()=>json?Response.json({error:{code:status===503?2:613}},{status}):new Response('<html>unavailable</html>',{status}));
 let w=await queue(c);
 for(let n=1;n<=RETRY_LIMIT;n++){
  const result=await c.execute(w);assert.equal(result.error.transient,true);assert.equal(result.error.httpStatus,status);
  await c.finish(w,null,result.error);assert.equal(c.state.connections['101'].lifecycle_status,'active');
  if(n<RETRY_LIMIT){assert(c.state.jobs.at(-1).retryAt>Date.now());c.state.jobs.at(-1).retryAt=0;w=await c.prepare();}
 }
 assert.equal(c.state.cycles.at(-1).result,'failed');assert.equal(c.state.jobs.at(-1).attempts.length,RETRY_LIMIT);
 let error;try{await c.runner.collectApi();}catch(e){error=e;}assert.equal(collectionError(error).httpStatus,status);assert.equal(collectionError(error).transient,true);
});

test('collection recovers after non-JSON 503; auth and permission failures do not retry',async()=>{
 const c=control();let calls=0;c.runner.collectApi=async()=>{if(++calls===1)return graph('me',{},'token',async()=>new Response('unavailable',{status:503}));return snap('101');};
 let w=await queue(c);let result=await c.execute(w);await c.finish(w,result.result,result.error);c.state.jobs.at(-1).retryAt=0;w=await c.prepare();result=await c.execute(w);await c.finish(w,result.result,result.error);await publish(c);assert.equal(calls,2);
 for(const code of [190,200]){const d=control();d.runner.collectApi=()=>graph('me',{},'token',async()=>Response.json({error:{code}},{status:403}));const work=await queue(d),failure=await d.execute(work);await d.finish(work,null,failure.error);assert.equal(d.state.cycles.at(-1).result,'failed');assert.equal(d.state.jobs.at(-1).attempts.length,1);assert.equal(d.state.connections['101'].lifecycle_status,code===190?'needs_auth':'active');}
});

async function completedAction(c,id='101',status='PAUSED'){
 const response=await c.request('/v1/actions','POST',{userId:id,campaignId:'12345',status});const action=await response.json();
 // Existing prepare serializes writes; simulate its already acquired work lease.
 const job=c.state.jobs.find(j=>j.id===action.id);job.state='running';job.attempt=crypto.randomUUID();job.leaseUntil=Date.now()+60000;
 const work={job:structuredClone(job),connection:structuredClone(c.state.connections[id])};
 await c.finish(work,{actionResult:{campaignId:'12345',state:'done',observedAt:new Date().toISOString()}});return {job,work};
}
for(const phase of ['meta','keitaro'])test(`action after A collection in ${phase} schedules durable successor after terminal current cycle`,async()=>{
 let c=control(['101','102']);const a=await queue(c);await success(c,a);const b=await c.prepare();
 if(phase==='keitaro')await success(c,b);
 const oldCycle=c.currentCycle(),oldGeneration=structuredClone(oldCycle.meta_generations['101']);
 const {job:action,work:actionWork}=await completedAction(c);
 assert.deepEqual(oldCycle.meta_generations['101'],oldGeneration);assert.equal(c.state.jobs.find(j=>j.id===a.job.id).post_action_reconciliation,undefined);
 assert.equal(c.state.pendingPostAction['101'][0].action_job_id,action.id);
 await c.finish(actionWork,{actionResult:{campaignId:'12345',state:'done'}});assert.equal(c.state.pendingPostAction['101'].length,1,'duplicate completion never replays a write or successor request');
 // Pending request survives encrypted-state reload while old cycle still runs.
 let alarmAt;c=new Control(structuredClone(c.state),async()=>{},async at=>{alarmAt=at;},{});
 if(phase==='meta')await success(c,b);await publish(c);assert(alarmAt<=Date.now()+1100,'terminal cycle re-arms pending successor immediately');
 for(const social of Object.values(c.state.connections))social.lastCollectedAt=0;
 let successor=await c.prepare();assert.equal(successor,null,'existing 15-minute collection cooldown remains intact');c.state.jobs.filter(j=>j.state==='queued').forEach(j=>j.retryAt=0);successor=await c.prepare();const next=c.currentCycle();assert.notEqual(next.cycle_id,oldCycle.cycle_id);assert.equal(next.trigger,'post_action');
 assert.equal(successor.job.userId,'101');assert.equal(successor.job.cycle_id,next.cycle_id);assert.notEqual(successor.job.id,a.job.id);
 assert.equal(successor.job.post_action_reconciliation[0].action_job_id,action.id);
 assert(Date.parse(successor.job.startedAt)>=Date.parse(action.action_completed_at));assert.equal(c.state.pendingPostAction['101'],undefined);
 await success(c,successor);const second=await c.prepare();await success(c,second);await publish(c);assert.equal(c.state.cycles.at(-1).result,'published');
 assert.equal(c.state.jobs.filter(j=>j.action).length,1,'no duplicate campaign writes');
});

test('multiple successful actions coalesce into one later collection; failed predecessor also wakes successor',async()=>{
 const c=control();const w=await queue(c);await success(c,w);const first=await completedAction(c),second=await completedAction(c,'101','ACTIVE');
 assert.equal(c.state.pendingPostAction['101'].length,2);c.endCycle(c.currentCycle(),'failed','keitaro_failure');c.state.connections['101'].lastCollectedAt=0;
 let job=await c.prepare();if(!job){c.state.jobs.filter(j=>j.state==='queued').forEach(j=>j.retryAt=0);job=await c.prepare();}
 assert.equal(job.job.post_action_reconciliation.length,2);assert(Date.parse(job.job.startedAt)>=Date.parse(second.job.action_completed_at));
 assert.deepEqual(job.job.post_action_reconciliation.map(a=>a.action_job_id),[first.job.id,second.job.id]);
 await success(c,job);await publish(c);
});

test('cancelling a queued successor before execution retains the post-action request',async()=>{
 const c=control();const {job:action}=await completedAction(c);const first=c.currentCycle();
 assert.equal(c.state.pendingPostAction['101'][0].action_job_id,action.id);
 c.endCycle(first,'failed','another_mandatory_social_failed');const next=await c.prepare();
 assert.notEqual(next.job.cycle_id,first.cycle_id);assert.equal(next.job.post_action_reconciliation[0].action_job_id,action.id);
 assert(Date.parse(next.job.startedAt)>=Date.parse(action.action_completed_at));assert.equal(c.state.pendingPostAction['101'],undefined);
 await success(c,next);await publish(c);
});
