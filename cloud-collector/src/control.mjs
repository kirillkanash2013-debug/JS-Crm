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
const NEEDS_AUTH=['needs_auth','identity',190,102];
const RATE_LIMIT=[4,17,32,613,80004];
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
 constructor(state,save,schedule,runner,archive=null){this.state=state;this.save=save;this.schedule=schedule;this.runner=runner;this.archive=archive;}
 async persist(){await this.save(this.state);await this.plan();}
 async plan(){let next=Infinity;if(this.state.pendingAnnounce?.length||this.state.pendingRefresh)next=this.state.notifyRetryAt||Date.now()+10000;for(const j of this.state.jobs){if(j.state==='queued')next=Math.min(next,j.retryAt||Date.now()+1000);if(j.state==='running')next=Math.min(next,j.leaseUntil);}for(const c of Object.values(this.state.connections))if(c.schedule)next=Math.min(next,c.schedule.nextAt);await this.schedule(Number.isFinite(next)?Math.max(Date.now()+1000,next):null);}
 status(){return {mode:'live',platformCheck:this.state.platformCheck||null,connections:Object.values(this.state.connections).map(c=>{const sum=this.archive?.socialSummary?.(c.userId)||null;return {userId:c.userId,label:c.label||null,source:c.profileId?'antidetect':'manual',connectedAt:c.connectedAt,schedule:c.schedule||null,collectMode:c.mode||'api',accounts:sum?.accounts??null,businesses:sum?.businesses??null,pages:sum?.pages??null,collectedAt:sum?.lastAt||null};}),antidetect:this.antidetectStatus(),jobs:this.state.jobs,results:this.state.results};}
 antidetectStatus(){const a=this.state.antidetect;return a?{type:a.type,connectedAt:a.connectedAt,nextImportAt:a.nextAt,lastImport:a.lastImport}:null;}
 enqueue(b){const userId=String(b.userId||'');if(!this.state.connections[userId])throw new Error('Connect first');const range=period(b.since,b.until);const existing=this.state.jobs.find(j=>j.userId===userId&&['queued','running'].includes(j.state));if(existing)return existing;
 const j={id:crypto.randomUUID(),userId,range,state:'queued',source:'facebook-server',createdAt:new Date().toISOString()};this.state.jobs=this.state.jobs.filter(x=>['queued','running'].includes(x.state)).concat(this.state.jobs.filter(x=>!['queued','running'].includes(x.state)).slice(-99));this.state.jobs.push(j);return j;}
 async request(path,method,b,limit=1){
  this.state.socialLimit=limit;
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
   if(Object.keys(this.state.connections).length>=limit&&!this.state.connections[b?.userId])return reply(409,{error:'social_limit',limit});
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
   // The server owns the settings: a social gets the default schedule from the
   // server (not the client) and an immediate first collection. The plugin only
   // forwards credentials — it never sends a schedule or a collection job.
   const conn=this.state.connections[c.userId]={...c,label:b?.label||old?.label||null,mode:'api',apiFailures:0,schedule:old?.schedule||{minutes:DEFAULT_SCHEDULE_MINUTES,nextAt:NEXT_SLOT(DEFAULT_SCHEDULE_MINUTES,this.state.tenantId||c.userId)},revision:crypto.randomUUID(),connectedAt:new Date().toISOString()};
   // Re-arm the one-time "collected" notification for this (re)connection, so the
   // fresh card gets its "✅ loaded" update even if the social was announced before.
   if(this.state.announced)delete this.state.announced[c.userId];
   const r=COLLECT_RANGE();this.enqueue({userId:c.userId,since:r.since,until:r.until});
   await this.persist();return reply(201,{userId:c.userId,label:conn.label,state:this.runner.validateApi?'verified':'unverified',schedule:conn.schedule});
  }
  if(method==='POST'&&path==='/v1/actions'){const action=validateAction(b);if(!this.state.connections[b.userId])throw new Error('Connect first');
   if(this.archive&&!this.archive.ownsCampaign(b.userId,action.campaignId))return reply(403,{error:'campaign_forbidden'});
   const duplicate=this.state.jobs.find(j=>j.userId===b.userId&&j.action&&JSON.stringify(j.action)===JSON.stringify(action)&&(['queued','running'].includes(j.state)||Date.now()-Date.parse(j.createdAt)<60000));
   if(duplicate)return reply(202,duplicate);
   // Allow queuing several actions at once (bulk budget / on-off). prepare()
   // runs heavy/action jobs one at a time, so they apply sequentially; cap the
   // pending action queue to avoid abuse.
   if(this.state.jobs.filter(j=>j.action&&['queued','running'].includes(j.state)).length>=25)return reply(409,{error:'busy'});
   const j={id:crypto.randomUUID(),userId:b.userId,action,state:'queued',source:'facebook-server',createdAt:new Date().toISOString()};this.state.jobs.push(j);await this.persist();return reply(202,j);}
  if(method==='POST'&&path==='/v1/jobs'){const j=this.enqueue(b);await this.persist();return reply(202,j);}
  if(method==='POST'&&path==='/v1/schedule'){
   const c=this.state.connections[b.userId];if(!c||!Number.isInteger(b.minutes)||b.minutes<0||b.minutes>1440||(b.minutes>0&&b.minutes<15))throw new Error('Invalid schedule');
   c.schedule=b.minutes?{minutes:b.minutes,nextAt:NEXT_SLOT(b.minutes,this.state.tenantId||b.userId)}:null;await this.persist();return reply(200,{ok:true});
  }
  if(method==='DELETE'&&path==='/v1/connections'){
   delete this.state.connections[b.userId];delete this.state.results[b.userId];this.archive?.forget(b.userId);for(const j of this.state.jobs)if(j.userId===b.userId&&['queued','running'].includes(j.state))j.state='cancelled';await this.persist();return reply(200,{ok:true});
  }
  return reply(404,{error:'not_found'});
 }
 // Caller serializes prepare and finish, but releases the DO gate during collection.
 // Cheap API jobs run up to API_PARALLEL at once; browser and action jobs run alone.
 async prepare(){
  const now=Date.now();
  for(const j of this.state.jobs)if(j.state==='running'&&j.leaseUntil<=now){j.state=j.action?'unverified':'queued';j.recovered=true;}
  for(const c of Object.values(this.state.connections)){
   // Daily retry of the cheap path; one more rejection sends it back to the browser.
   if(c.mode==='browser'&&c.apiRetryAt<=now){c.mode='api';c.apiFailures=2;}
   if(c.schedule?.nextAt<=now){const r=COLLECT_RANGE();this.enqueue({userId:c.userId,since:r.since,until:r.until});c.schedule.nextAt=NEXT_SLOT(c.schedule.minutes,this.state.tenantId||c.userId);}
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
  j.state='running';j.startedAt=new Date().toISOString();j.leaseUntil=now+(heavy?15:5)*60000;j.attempt=crypto.randomUUID();await this.persist();
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
    if(!BROWSER_FALLBACK.includes(e.code)||!this.runner.collect||!connection.cookies?.length)return {error:{code:e.code}};
    // Without cookies (bookmarklet connection) there is no browser fallback: the client clicks the bookmark again.
   }
  }
  try{const result=await this.runner.collect(connection,job.range);return {result:{...result,viaBrowser:true,apiError:apiError?.code??null}};}
  catch(e){return {error:{code:e.code}};}
 }
 // Adds or refreshes socials found in the antidetect account. Existing socials
 // keep their schedule; new ones start on the server's default schedule.
 applyImport(j,result,error){
  const a=this.state.antidetect;
  if(error||!result){j.state='failed';j.error={code:error?.code||'import_failed'};if(a)a.lastImport={at:new Date().toISOString(),error:j.error.code};return;}
  const limit=this.state.socialLimit||1,skipped=[...result.skipped];let added=0,updated=0;
  for(const item of result.items){
   const old=this.state.connections[item.userId];
   if(!old&&Object.keys(this.state.connections).length>=limit){skipped.push({name:item.label,reason:'limit'});continue;}
   this.state.connections[item.userId]={...old,...item,token:item.token||old?.token||null,mode:'api',apiFailures:0,
    schedule:old?.schedule||{minutes:DEFAULT_SCHEDULE_MINUTES,nextAt:Date.now()},revision:crypto.randomUUID(),connectedAt:old?.connectedAt||new Date().toISOString()};
   old?updated++:added++;
  }
  j.state='done';
  if(a)a.lastImport={at:result.at,found:result.found,added,updated,skipped:skipped.slice(0,200)};
 }
 async finish(work,result,error){const j=this.state.jobs.find(x=>x.id===work.job.id);if(!j||j.state!=='running'||j.attempt!==work.job.attempt)return;
  if(j.kind==='import'){this.applyImport(j,result,error);delete j.leaseUntil;j.finishedAt=new Date().toISOString();await this.persist();return;}
  const c=this.state.connections[j.userId];
  if(!c||c.revision!==work.connection.revision)j.state='cancelled';
  else if(error){
   j.state=NEEDS_AUTH.includes(error.code)?'needs_auth':RATE_LIMIT.includes(error.code)?'rate_limited':'failed';
   j.error={code:diagnosticCode(error.code)};
   if(error.code==='capacity_busy'){j.state='queued';j.retryAt=Date.now()+10000;}
   if(j.state==='needs_auth')c.schedule=null;
   // Meta asked us to slow down: skip the next hour of scheduled runs.
   if(j.state==='rate_limited'&&c.schedule)c.schedule.nextAt=Math.max(c.schedule.nextAt,Date.now()+60*60000);
  }
  else if(j.action){const a=result?.actionResult;if(!a||a.campaignId!==j.action.campaignId){j.state='failed';j.error={code:'invalid_action_result'};}else{j.state=a.state;j.actionResult=a;j.observedAt=a.observedAt;if(result.storageState)c.storageState=result.storageState;
   // Успешное действие → ставим пересбор, чтобы архив (источник статуса/бюджета)
   // быстро подтянул новое состояние из кабинета (persist ниже назначит аларм).
   if(a.state==='done'){try{const r=COLLECT_RANGE();this.enqueue({userId:j.userId,since:r.since,until:r.until});}catch{}}}}
  else if(!result?.snapshot?.complete||result.snapshot.source!=='facebook-server'||result.snapshot.social?.user.id!==j.userId){j.state='failed';j.error={code:'invalid_snapshot'};}
  else{
   // History goes to the client's database; state keeps only a compact summary.
   this.state.results[j.userId]=this.archive?await this.archive.record(j.userId,result.snapshot,result.viaBrowser?'browser':'api',c.label):result.snapshot;j.state='done';j.observedAt=result.snapshot.observedAt;j.mode=result.viaBrowser?'browser':'api';
   // First successful collection for this social → queue a one-time "connected"
   // notification to the bot (with real accounts/БМ/pages counts). The DO sends
   // it outside the storage gate after the alarm finishes.
   this.state.pendingRefresh=true;
   if(!j.action){this.state.announced=this.state.announced||{};this.state.pendingAnnounce=this.state.pendingAnnounce||[];if(!this.state.announced[j.userId]){this.state.announced[j.userId]=true;this.state.pendingAnnounce.push(j.userId);}}
   if(result.storageState)c.storageState=result.storageState;
   if(typeof result.token==='string'&&/^EA[A-Za-z0-9_-]{18,4094}$/.test(result.token))c.token=result.token;
   if(!result.viaBrowser)c.apiFailures=0;
   // The API path was rejected but the browser worked: after 3 such runs use
   // the browser for a day, then try the cheap path again.
   else if(result.apiError===1&&++c.apiFailures>=3){c.mode='browser';c.apiRetryAt=Date.now()+24*60*60000;}
  }
  if(j.error){this.state.errors=(this.state.errors||[]).filter(e=>Date.parse(e.at)>Date.now()-90*864e5).slice(-199);this.state.errors.push(diagnostic(j,j.error));}
  delete j.leaseUntil;j.finishedAt=new Date().toISOString();await this.persist();
 }
}
