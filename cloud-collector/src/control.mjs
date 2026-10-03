import {active,authReason,transient,lifecycle,normalize,RETRY_LIMIT,backoff} from './lifecycle.mjs';
import {diagnostic,diagnosticCode} from './diagnostics.mjs';
import {REIMPORT_MS} from './importer.mjs';
const API_PARALLEL=4;
// Single server-side default for the collection interval. All settings live
// here, never in the client plugin: change this (and redeploy) to retune every
// client at once, with no need to redistribute the extension.
const DEFAULT_SCHEDULE_MINUTES=60;
const IMPORT_USER='__import__';
// Диапазон сбора «текущего дня»: вчера+сегодня по UTC. Шире одного дня, чтобы
// текущие сутки любого рекламного аккаунта (FB считает спенд в поясе кабинета)
// точно попадали в запрос, даже когда пояс аккаунта смещён относительно UTC.
const COLLECT_RANGE=()=>{const t=Date.now(),d=u=>new Date(u).toISOString().slice(0,10);return {since:d(t-86400000),until:d(t)};};
// Следующий слот сбора, выровненный по часам на :01 (минуты не зависят от пояса).
// Для 60 мин — HH:01 каждый час, для 30 — :01/:31, для 120 — через 2 часа в :01.
// Так сбор привязан к часам, а не «плавает» от момента подключения/ручного обновления.
const NEXT_SLOT=(minutes,seed='')=>{const step=(minutes||60)*60000,now=Date.now();let next=Math.floor(now/step)*step+60000+[...seed].reduce((h,c)=>(h*31+c.charCodeAt(0))>>>0,0)%240000;while(next<=now)next+=step;return next;};
// Graph API rejected the cookie+token request (1) or the token died (190/102).
const BROWSER_FALLBACK=[1,190,102];
const CONNECT_ERRORS={proxy:'proxy_failed',190:'token_invalid',102:'token_invalid',identity:'wrong_user',cookies_owner:'cookies_owner',cookies:'validation_failed',invalid:'validation_failed',container_unavailable:'validation_failed'};
const validateAction=a=>{
 const campaignId=String(a?.campaignId||'');
 if(!/^\d{5,20}$/.test(campaignId))throw new Error('Unsupported action');
 const out={campaignId};
 if(a?.status!==undefined){if(!['ACTIVE','PAUSED'].includes(a.status))throw new Error('Unsupported action');out.status=a.status;}
 if(a?.dailyBudget!==undefined&&a?.dailyBudget!==null){const b=Number(a.dailyBudget);if(!Number.isInteger(b)||b<100||b>100000000)throw new Error('Unsupported action');out.dailyBudget=b;}
 if(out.status===undefined&&out.dailyBudget===undefined)throw new Error('Unsupported action');
 return out;};
import {period} from '../../extension/core.mjs';
export const reply=(status,body)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export function initialState(){return {connections:{},jobs:[],results:{}};}
export class Control {
 // archive: per-client SQLite history (src/archive.mjs). Without it the latest
 // full snapshot is kept in state, as in the prototype.
 constructor(state,save,schedule,runner,archive=null){this.state=state;this.save=save;this.schedule=schedule;this.runner=runner;this.archive=archive;normalize(state);}
 async persist(){await this.save(this.state);await this.plan();}
 async plan(){let next=Infinity;const cycle=this.currentCycle();if(cycle)next=Math.min(next,cycle.deadlineAt);if(this.state.pendingAnnounce?.length||this.state.pendingRefresh)next=Math.min(next,this.state.notifyRetryAt||Date.now()+10000);for(const j of this.state.jobs){if(j.state==='queued')next=Math.min(next,j.retryAt||Date.now()+1000);if(j.state==='running')next=Math.min(next,j.leaseUntil);}for(const c of Object.values(this.state.connections))if(active(c)&&c.schedule&&!this.state.subscriptionSuspended)next=Math.min(next,c.schedule.nextAt);await this.schedule(Number.isFinite(next)?Math.max(Date.now()+1000,next):null);}
 status(){return {mode:'live',platformCheck:this.state.platformCheck||null,connections:Object.values(this.state.connections).filter(c=>c.lifecycle_status!=='disconnected').map(c=>{const sum=this.archive?.socialSummary?.(c.userId)||null;return {userId:c.userId,label:c.label||null,lifecycle_status:c.lifecycle_status,auth_issue_reason:c.auth_issue_reason,lifecycle_updated_at:c.lifecycle_updated_at,source:c.profileId?'antidetect':'manual',connectedAt:c.connectedAt,schedule:c.schedule||null,collectMode:c.mode||'api',accounts:sum?.accounts??null,businesses:sum?.businesses??null,pages:sum?.pages??null,refreshAllowedAt:c.lastCollectedAt?c.lastCollectedAt+15*60000:null,collectedAt:sum?.lastAt||this.state.results[c.userId]?.observedAt||null};}),antidetect:this.antidetectStatus(),cycles:this.state.cycles,cycle:this.currentCycle()||this.state.cycles.at(-1)||null,jobs:this.state.jobs,results:this.state.results};}
 antidetectStatus(){const a=this.state.antidetect;return a?{type:a.type,connectedAt:a.connectedAt,nextImportAt:a.nextAt,lastImport:a.lastImport}:null;}
 currentCycle(){return this.state.cycles.find(c=>c.result==='processing');}
 endCycle(c,result,reason=null,snapshot=null){if(!c||c.result!=='processing')return;if(result==='failed'&&!['connection_replaced','validation_set_changed'].includes(reason))for(const id of c.validation_set){const social=this.state.connections[id];if(social&&!active(social)){delete social.validationPending;social.schedule=null;}}if(result==='failed')for(const j of this.state.jobs)if(j.cycle_id===c.cycle_id&&['queued','running'].includes(j.state)){j.state='cancelled';j.finishedAt=new Date().toISOString();}c.result=result;c.failure_reason=reason;c.finished_at=new Date().toISOString();c.published_snapshot=snapshot;c.meta_attempts=this.state.jobs.filter(j=>j.cycle_id===c.cycle_id).map(j=>({job_id:j.id,user_id:j.userId,result:j.state,attempts:j.attempts||[],finished_at:j.finishedAt||null}));this.state.pendingRefresh=false;delete this.state.notifyRetryAt;}
 startCycle(trigger,requested){
  let c=this.currentCycle();if(c)return c;
  const ids=Object.values(this.state.connections).filter(active).map(c=>c.userId);
  c={cycle_id:crypto.randomUUID(),trigger,active_collection_set:ids,validation_set:Object.values(this.state.connections).filter(c=>c.validationPending&&!active(c)&&c.lifecycle_status!=='disconnected').map(c=>c.userId),meta_jobs:[],meta_generations:{},keitaro_attempts:[],started_at:new Date().toISOString(),deadlineAt:Date.now()+45*60000,result:'processing',phase:'meta'};
  this.state.cycles=this.state.cycles.slice(-99).concat(c);return c;
 }
 enqueueCycle(b,trigger='manual'){
  const connection=this.state.connections[String(b.userId)];
  if(!connection||connection.lifecycle_status==='disconnected'||(!active(connection)&&!connection.validationPending))throw new Error('Reconnect first');
  const cycle=this.startCycle(trigger,String(b.userId));
  if(cycle.phase!=='meta')return this.state.jobs.find(j=>j.cycle_id===cycle.cycle_id);
  for(const userId of [...cycle.active_collection_set,...cycle.validation_set]){
   const done=this.state.jobs.find(j=>j.userId===userId&&j.cycle_id===cycle.cycle_id&&j.state==='done');if(done)continue;
   const j=this.enqueue({...b,userId});j.cycle_id=cycle.cycle_id;if(!cycle.meta_jobs.includes(j.id))cycle.meta_jobs.push(j.id);
  }
  return this.state.jobs.find(j=>j.cycle_id===cycle.cycle_id&&j.userId===String(b.userId));
 }
 expireCycle(){const c=this.currentCycle();if(c&&c.deadlineAt<=Date.now())this.endCycle(c,'failed','cycle_timeout');}
 async preparePublication(){
  this.expireCycle();const c=this.currentCycle();
  if(!c||c.phase!=='keitaro'||!this.state.pendingRefresh||(this.state.notifyRetryAt||0)>Date.now())return null;
  const previous=c.keitaro_attempts.at(-1);if(previous&&!previous.finished_at&&previous.lease_until>Date.now())return null;
  if(c.keitaro_attempts.length>=RETRY_LIMIT){this.endCycle(c,'failed','publication_attempts_exhausted');await this.persist();return null;}
  const attempt={attempt:c.keitaro_attempts.length+1,started_at:new Date().toISOString(),lease_until:Date.now()+5*60000};c.keitaro_attempts.push(attempt);await this.persist();return {cycle_id:c.cycle_id,attempt:attempt.attempt};
 }
 async finishPublication(work,outcome){
  const c=this.currentCycle();if(!c||c.cycle_id!==work.cycle_id)return;
  const attempt=c.keitaro_attempts[work.attempt-1];if(!attempt||attempt.finished_at||c.keitaro_attempts.at(-1)!==attempt)return;
  Object.assign(attempt,{finished_at:new Date().toISOString(),result:outcome?.result||'failed',reason:outcome?.reason||null});
  if(outcome?.result==='published'&&outcome.cycle_id===c.cycle_id)this.endCycle(c,'published',null,outcome.snapshot);
  else if(outcome?.result==='retry'&&c.keitaro_attempts.length<RETRY_LIMIT)this.state.notifyRetryAt=Date.now()+backoff(c.keitaro_attempts.length);
  else this.endCycle(c,'failed',outcome?.reason||'publication_failed');
  await this.persist();
 }
 async subscription(enabled){
  this.state.subscriptionSuspended=!enabled;
  if(!enabled){this.endCycle(this.currentCycle(),'failed','subscription_expired');for(const j of this.state.jobs)if(!j.action&&['queued','running'].includes(j.state)){j.state='failed';j.finishedAt=new Date().toISOString();}}
  else for(const c of Object.values(this.state.connections))if(active(c)&&!c.schedule)c.schedule={minutes:this.state.refreshMinutes||DEFAULT_SCHEDULE_MINUTES,nextAt:Date.now()};
  await this.persist();
 }
 enqueue(b){const userId=String(b.userId||'');if(!this.state.connections[userId])throw new Error('Connect first');const range=period(b.since,b.until);const existing=this.state.jobs.find(j=>j.userId===userId&&['queued','running'].includes(j.state));if(existing)return existing;
 const lastAt=Number(this.state.connections[userId].lastCollectedAt)||Date.parse(this.archive?.socialSummary?.(userId)?.lastAt||this.state.results[userId]?.observedAt)||0;
 const j={id:crypto.randomUUID(),userId,range,retryAt:Math.max(Date.now(),lastAt+15*60000),state:'queued',source:'facebook-server',createdAt:new Date().toISOString()};const cycleId=this.currentCycle()?.cycle_id;this.state.jobs=this.state.jobs.filter(x=>['queued','running'].includes(x.state)||x.cycle_id===cycleId).concat(this.state.jobs.filter(x=>!['queued','running'].includes(x.state)&&x.cycle_id!==cycleId).slice(-99));this.state.jobs.push(j);return j;}
 async request(path,method,b){
  delete this.state.socialLimit;
  if(method==='POST'&&path==='/v1/subscription/resume'){await this.subscription(true);return reply(200,{ok:true});}
  if(path==='/v1/antidetect'){
   if(method==='GET')return reply(200,this.antidetectStatus());
   if(method==='DELETE'){delete this.state.antidetect;await this.persist();return reply(200,{ok:true});}
   if(method==='POST'){
    const config={type:String(b?.type||''),token:String(b?.token||'').trim()};
    if(!config.token||config.token.length>4096)return reply(422,{error:'antidetect_token'});
    let profiles;
    try{profiles=await this.runner.antidetectProfiles(config);}catch(e){return reply(422,{error:e.code==='antidetect_auth'?'antidetect_auth':e.code==='antidetect_type'?'antidetect_type':'antidetect_unavailable'});}
    this.state.antidetect={...config,connectedAt:new Date().toISOString(),nextAt:Date.now(),lastImport:null};
    await this.persist();return reply(201,{profiles:profiles.length});
   }
  }
  if(method==='GET'&&path==='/v1/errors')return reply(200,{errors:this.state.errors||[]});
  if(method==='GET'&&path==='/v1/status')return reply(200,this.status());
  if(method==='GET'&&path==='/v1/report'){if(!this.archive)return reply(404,{error:'not_found'});return reply(200,this.archive.report({since:b?.since,until:b?.until,userId:b?.userId||null}));}
  if(method==='GET'&&path==='/v1/changes'){if(!this.archive)return reply(404,{error:'not_found'});return reply(200,{changes:this.archive.changes({since:b?.since||'1970-01-01',objectId:b?.objectId||null})});}
  if(method==='GET'&&path==='/v1/campaigns'){if(!this.archive)return reply(404,{error:'not_found'});const accountToday=b?.accountToday==='1'||b?.accountToday===true;return reply(200,{campaigns:this.archive.campaigns({userId:b?.userId||null,date:accountToday?null:(b?.date||new Date().toISOString().slice(0,10)),accountToday})});}
  if(method==='POST'&&path==='/v1/connections'){
   // Bookmark without a proxy: take proxy and name from the antidetect profile with the same User-Agent.
   if(!b?.proxy?.server&&this.state.antidetect&&this.runner.matchProfile){
    const p=await this.runner.matchProfile(this.state.antidetect,b?.userAgent).catch(()=>null);
    if(p?.proxy)b={...b,proxy:p.proxy,label:p.name};
   }
   // Cheap check through the social's proxy when available; the browser container only as before.
   let c;
   try{c=this.runner.validateApi?await this.runner.validateApi(b):await this.runner.validate(b);}
   catch(e){return reply(422,{error:CONNECT_ERRORS[e.code]||'validation_failed',detail:((e&&(e.detail||e.message))?String(e.detail||e.message):null)?.slice(0,200)??null});}
   const old=this.state.connections[c.userId];
   this.endCycle(this.currentCycle(),'failed','connection_replaced');
   for(const j of this.state.jobs)if(j.userId===c.userId&&['queued','running'].includes(j.state)){j.state='cancelled';j.finishedAt=new Date().toISOString();}
   // The server owns the settings: a social gets the default schedule from the
   // server (not the client) and an immediate first collection. The plugin only
   // forwards credentials — it never sends a schedule or a collection job.
   const conn=this.state.connections[c.userId]={...c,label:b?.label||old?.label||null,mode:'api',apiFailures:0,schedule:old?.schedule||{minutes:this.state.refreshMinutes||DEFAULT_SCHEDULE_MINUTES,nextAt:NEXT_SLOT(this.state.refreshMinutes||DEFAULT_SCHEDULE_MINUTES,this.state.tenantId||c.userId)},revision:crypto.randomUUID(),connectedAt:new Date().toISOString()};
   // Re-arm the one-time "collected" notification for this (re)connection, so the
   // fresh card gets its "✅ loaded" update even if the social was announced before.
   if(this.state.announced)delete this.state.announced[c.userId];
   lifecycle(conn,'needs_auth',null);conn.validationPending=true;
   const r=COLLECT_RANGE();this.enqueueCycle({userId:c.userId,since:r.since,until:r.until});
   await this.persist();return reply(201,{userId:c.userId,label:conn.label,state:this.runner.validateApi?'verified':'unverified',schedule:conn.schedule});
  }
  if(method==='POST'&&path==='/v1/actions'){const action=validateAction(b);if(!this.state.connections[b.userId]||this.state.connections[b.userId].lifecycle_status==='disconnected')throw new Error('Connect first');
   if(this.archive&&!this.archive.ownsCampaign(b.userId,action.campaignId))return reply(403,{error:'campaign_forbidden'});
   const duplicate=this.state.jobs.find(j=>j.userId===b.userId&&j.action&&JSON.stringify(j.action)===JSON.stringify(action)&&(['queued','running'].includes(j.state)||Date.now()-Date.parse(j.createdAt)<60000));
   if(duplicate)return reply(202,duplicate);
   // Allow queuing several actions at once (bulk budget / on-off). prepare()
   // runs heavy/action jobs one at a time, so they apply sequentially; cap the
   // pending action queue to avoid abuse.
   if(this.state.jobs.filter(j=>j.action&&['queued','running'].includes(j.state)).length>=25)return reply(409,{error:'busy'});
   const j={id:crypto.randomUUID(),userId:b.userId,action,state:'queued',source:'facebook-server',createdAt:new Date().toISOString()};this.state.jobs.push(j);await this.persist();return reply(202,j);}
  if(method==='POST'&&path==='/v1/jobs'){const j=this.enqueueCycle(b);await this.persist();return reply(202,j);}
 if(method==='POST'&&path==='/v1/schedule'){
   const c=this.state.connections[b.userId];if(!c||!Number.isInteger(b.minutes)||b.minutes<0||b.minutes>1440||(b.minutes>0&&b.minutes<15))throw new Error('Invalid schedule');
   c.schedule=b.minutes?{minutes:b.minutes,nextAt:NEXT_SLOT(b.minutes,this.state.tenantId||b.userId)}:null;await this.persist();return reply(200,{ok:true});
  }
  if(method==='POST'&&path==='/v1/refresh-frequency'){
   if(![30,60,120].includes(b?.minutes))return reply(422,{error:'invalid_frequency'});
   this.state.refreshMinutes=b.minutes;
   for(const c of Object.values(this.state.connections))if(c.schedule)c.schedule={minutes:b.minutes,nextAt:NEXT_SLOT(b.minutes,this.state.tenantId||c.userId)};
   await this.persist();return reply(200,{ok:true,minutes:b.minutes});
  }
  if(method==='DELETE'&&path==='/v1/connections'){
   delete this.state.results[b.userId];
   const c=this.state.connections[b.userId];if(c){lifecycle(c,'disconnected');c.schedule=null;delete c.validationPending;for(const key of ['token','cookies','storageState','proxy'])delete c[key];}this.endCycle(this.currentCycle(),'failed','social_disconnected');for(const j of this.state.jobs)if(j.userId===b.userId&&['queued','running'].includes(j.state))j.state='cancelled';await this.persist();return reply(200,{ok:true});
  }
  return reply(404,{error:'not_found'});
 }
 // Caller serializes prepare and finish, but releases the DO gate during collection.
 // Cheap API jobs run up to API_PARALLEL at once; browser and action jobs run alone.
 async prepare(){
  if(this.state.subscriptionSuspended){await this.persist();return null;}
  const now=Date.now();
  if(!this.currentCycle()){const legacy=this.state.jobs.find(j=>!j.action&&j.kind!=='import'&&['queued','running'].includes(j.state)&&this.state.connections[j.userId]&&(active(this.state.connections[j.userId])||this.state.connections[j.userId].validationPending));if(legacy)this.enqueueCycle({userId:legacy.userId,...legacy.range},'scheduled');}
  const cycle=this.currentCycle();if(cycle&&cycle.deadlineAt<=now){this.endCycle(cycle,'failed','cycle_timeout');for(const j of this.state.jobs)if(j.cycle_id===cycle.cycle_id&&['queued','running'].includes(j.state)){j.state='failed';j.finishedAt=new Date().toISOString();}}
  for(const j of this.state.jobs)if(j.state==='running'&&j.leaseUntil<=now){j.state=j.action?'unverified':(j.attemptCount||0)>=RETRY_LIMIT?'failed':'queued';j.recovered=true;if(j.attempts?.length)Object.assign(j.attempts.at(-1),{finished_at:new Date().toISOString(),result:'lease_expired'});if(j.state==='queued'&&j.attemptCount>1)j.retryAt=now+backoff(j.attemptCount);if(j.state==='failed'){j.finishedAt=new Date().toISOString();this.endCycle(this.currentCycle(),'failed','meta_lease_exhausted');}}
  for(const c of Object.values(this.state.connections)){
   // Daily retry of the cheap path; one more rejection sends it back to the browser.
   if(c.mode==='browser'&&c.apiRetryAt<=now){c.mode='api';c.apiFailures=2;}
   if(active(c)&&!this.state.subscriptionSuspended&&c.schedule?.nextAt<=now){const r=COLLECT_RANGE();this.enqueueCycle({userId:c.userId,since:r.since,until:r.until},'scheduled');c.schedule.nextAt=NEXT_SLOT(c.schedule.minutes,this.state.tenantId||c.userId);}
  }
  const ad=this.state.antidetect;
  if(ad&&ad.nextAt<=now&&!this.state.jobs.some(j=>j.kind==='import'&&['queued','running'].includes(j.state))){
   this.state.jobs.push({id:crypto.randomUUID(),userId:IMPORT_USER,kind:'import',state:'queued',createdAt:new Date().toISOString()});ad.nextAt=now+REIMPORT_MS;
  }
  const running=this.state.jobs.filter(j=>j.state==='running');
  const exclusive=running.some(j=>j.action||j.kind==='import'||this.state.connections[j.userId]?.mode==='browser');
  const j=this.state.jobs.find(x=>x.state==='queued'&&(!x.retryAt||x.retryAt<=now)&&!running.some(r=>r.userId===x.userId));
  const isImport=j?.kind==='import';
  if(isImport&&!ad){j.state='cancelled';await this.persist();return null;}
  const c=j&&!isImport&&this.state.connections[j.userId];
  if(j&&!isImport&&!c){j.state='cancelled';await this.persist();return null;}
  const heavy=j&&(isImport||j.action||c.mode==='browser'||!c.token);
  if(!j||exclusive||running.length>=API_PARALLEL||(heavy&&running.length)){await this.persist();return null;}
  j.attemptCount=(j.attemptCount||0)+1;j.attempts??=[];j.attempt=crypto.randomUUID();j.attempts.push({attempt_id:j.attempt,number:j.attemptCount,started_at:new Date().toISOString()});j.state='running';j.startedAt=new Date().toISOString();j.leaseUntil=now+(heavy?15:5)*60000;await this.persist();
  if(isImport)return {job:structuredClone(j),antidetect:structuredClone(ad)};
  return {job:structuredClone(j),connection:structuredClone(c),previous:this.archive?this.archive.previous(j.userId):this.state.results[j.userId]?structuredClone(this.state.results[j.userId]):null};
 }
 // Runs one prepared job: API first, one browser attempt when the API path is
 // rejected or the token died (the browser run also fetches a fresh token).
 async execute(work){
  const {job,connection,previous}=work;
  if(job.kind==='import'){try{return {result:await this.runner.importProfiles(work.antidetect)};}catch(e){return {error:{code:e.code||'import_failed'}};}}
  if(job.action){try{return {result:await this.runner.action(connection,job.action)};}catch(e){return {error:{code:e.code,message:e.message}};}}
  let apiError=null;
  if(connection.token&&connection.mode!=='browser'&&this.runner.collectApi){
   try{return {result:await this.runner.collectApi(connection,job.range,previous)};}
   catch(e){
    apiError=e;
    // Dead token but live cookies: take a new token from the Ads Manager page, no browser.
    if([190,102].includes(e.code)&&connection.cookies?.length&&this.runner.refreshToken){
     try{const token=await this.runner.refreshToken(connection);const result=await this.runner.collectApi({...connection,token},job.range,previous);return {result:{...result,token}};}catch{}
    }
    if(!BROWSER_FALLBACK.includes(e.code)||!this.runner.collect||!connection.cookies?.length)return {error:{code:e.code||(['AbortError','TimeoutError'].includes(e.name)?'timeout':'network'),transient:!!e.transient||e.httpStatus===429||e.httpStatus>=500,subcode:e.subcode}};
    // Without cookies (bookmarklet connection) there is no browser fallback: the client clicks the bookmark again.
   }
  }
  try{const result=await this.runner.collect(connection,job.range);return {result:{...result,viaBrowser:true,apiError:apiError?.code??null}};}
  catch(e){return {error:{code:e.code||(['AbortError','TimeoutError'].includes(e.name)?'timeout':'network'),transient:!!e.transient||e.httpStatus===429||e.httpStatus>=500,subcode:e.subcode}};}
 }
 // Adds or refreshes socials found in the antidetect account. Existing socials
 // keep their schedule; new ones start on the server's default schedule.
 applyImport(j,result,error){
  const a=this.state.antidetect;
  if(error||!result){j.state='failed';j.error={code:error?.code||'import_failed'};if(a)a.lastImport={at:new Date().toISOString(),error:j.error.code};return;}
  const skipped=[...result.skipped];let added=0,updated=0;const validation=[];
  for(const item of result.items){
   const old=this.state.connections[item.userId];
   if(old?.lifecycle_status==='disconnected')continue;
   this.state.connections[item.userId]={...old,...item,token:item.token||old?.token||null,mode:'api',apiFailures:0,
    schedule:old?.schedule||{minutes:this.state.refreshMinutes||DEFAULT_SCHEDULE_MINUTES,nextAt:Date.now()},revision:crypto.randomUUID(),connectedAt:old?.connectedAt||new Date().toISOString()};
   const c=this.state.connections[item.userId];if(!old||!active(old)){lifecycle(c,'needs_auth',null);c.validationPending=true;validation.push(item.userId);}
   old?updated++:added++;
  }
  if(validation.length){this.endCycle(this.currentCycle(),'failed','validation_set_changed');this.enqueueCycle({userId:validation[0],...COLLECT_RANGE()},'scheduled');}
  j.state='done';
  if(a)a.lastImport={at:result.at,found:result.found,added,updated,skipped:skipped.slice(0,200)};
 }
 async finish(work,result,error){const j=this.state.jobs.find(x=>x.id===work.job.id);if(!j||j.state!=='running'||j.attempt!==work.job.attempt)return;
  delete j.error;
  if(j.kind==='import'){this.applyImport(j,result,error);delete j.leaseUntil;j.finishedAt=new Date().toISOString();await this.persist();return;}
  const c=this.state.connections[j.userId];
  if(!c||c.revision!==work.connection.revision)j.state='cancelled';
  else if(error){
   const reason=authReason(error.code);
   j.state=reason?'needs_auth':'failed';j.error={code:diagnosticCode(error.code)};
   if(reason){lifecycle(c,'needs_auth',reason);c.schedule=null;delete c.validationPending;}
   else if(!j.action&&(error.transient||transient(error.code))&&(j.attemptCount||0)<RETRY_LIMIT){j.state='queued';j.retryAt=Date.now()+backoff(j.attemptCount);}
   if(j.state!=='queued')this.endCycle(this.state.cycles.find(c=>c.cycle_id===j.cycle_id),'failed',reason||j.error.code);

  }
  else if(j.action){const a=result?.actionResult;if(!a||a.campaignId!==j.action.campaignId){j.state='failed';j.error={code:'invalid_action_result'};}else{j.state=a.state;j.actionResult=a;j.observedAt=a.observedAt;if(result.storageState)c.storageState=result.storageState;
   // Успешное действие → ставим пересбор, чтобы архив (источник статуса/бюджета)
   // быстро подтянул новое состояние из кабинета (persist ниже назначит аларм).
   if(a.state==='done'){try{const r=COLLECT_RANGE();this.enqueue({userId:j.userId,since:r.since,until:r.until});}catch{}}}}
  else if(result?.snapshot?.social?.user.id&&result.snapshot.social.user.id!==j.userId){lifecycle(c,'needs_auth','wrong_identity');c.schedule=null;delete c.validationPending;j.state='needs_auth';j.error={code:'identity'};this.endCycle(this.state.cycles.find(c=>c.cycle_id===j.cycle_id),'failed','wrong_identity');}
  else if(!Number.isFinite(Date.parse(result?.snapshot?.observedAt))||!result?.snapshot?.complete||result.snapshot.source!=='facebook-server'||result.snapshot.social?.user.id!==j.userId){j.state='failed';j.error={code:'invalid_snapshot'};}
  else{
   // History goes to the client's database; state keeps only a compact summary.
   this.state.results[j.userId]=this.archive?await this.archive.record(j.userId,result.snapshot,result.viaBrowser?'browser':'api',c.label):result.snapshot;j.state='done';j.observedAt=result.snapshot.observedAt;j.mode=result.viaBrowser?'browser':'api';
   // First successful collection for this social → queue a one-time "connected"
   // notification to the bot (with real accounts/БМ/pages counts). The DO sends
   // it outside the storage gate after the alarm finishes.
   c.lastCollectedAt=Date.now();lifecycle(c,'active');delete c.validationPending;if(!c.schedule)c.schedule={minutes:this.state.refreshMinutes||DEFAULT_SCHEDULE_MINUTES,nextAt:NEXT_SLOT(this.state.refreshMinutes||DEFAULT_SCHEDULE_MINUTES,this.state.tenantId||c.userId)};
   const cycle=this.state.cycles.find(c=>c.cycle_id===j.cycle_id);if(cycle?.result==='processing'){cycle.meta_generations[j.userId]={job_id:j.id,attempt:j.attempt,generation:result.snapshot.observedAt};if(cycle.meta_jobs.every(id=>this.state.jobs.find(j=>j.id===id)?.state==='done')){cycle.phase='keitaro';cycle.meta_completed_at=new Date().toISOString();this.state.pendingRefresh=true;}}
   if(!j.action){this.state.announced=this.state.announced||{};this.state.pendingAnnounce=this.state.pendingAnnounce||[];if(!this.state.announced[j.userId]){this.state.announced[j.userId]=true;this.state.pendingAnnounce.push(j.userId);}}
   if(result.storageState)c.storageState=result.storageState;
   if(typeof result.token==='string'&&/^EA[A-Za-z0-9_-]{18,4094}$/.test(result.token))c.token=result.token;
   if(!result.viaBrowser)c.apiFailures=0;
   // The API path was rejected but the browser worked: after 3 such runs use
   // the browser for a day, then try the cheap path again.
   else if(result.apiError===1&&++c.apiFailures>=3){c.mode='browser';c.apiRetryAt=Date.now()+24*60*60000;}
  }
  if(j.state!=='queued')j.finishedAt=new Date().toISOString();
  if(j.attempts?.length)Object.assign(j.attempts.at(-1),{finished_at:new Date().toISOString(),result:j.state,error:j.error?.code||null});
  if(['failed','cancelled'].includes(j.state))this.endCycle(this.state.cycles.find(c=>c.cycle_id===j.cycle_id),'failed',j.error?.code||j.state);
  if(j.error){this.state.errors=(this.state.errors||[]).filter(e=>Date.parse(e.at)>Date.now()-90*864e5).slice(-199);this.state.errors.push(diagnostic(j,j.error));}
  delete j.leaseUntil;await this.persist();
 }
}
