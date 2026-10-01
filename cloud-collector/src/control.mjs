const API_PARALLEL=4;
const NEEDS_AUTH=['needs_auth','identity',190,102];
const RATE_LIMIT=[4,17,32,613,80004];
// Graph API rejected the cookie+token request (1) or the token died (190/102).
const BROWSER_FALLBACK=[1,190,102];
const validateAction=a=>{if(a?.campaignId!=='120250610273720552'||a?.status!=='ACTIVE')throw new Error('Unsupported action');return {campaignId:a.campaignId,status:a.status};};
import {period} from '../../extension/core.mjs';
export const reply=(status,body)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export function initialState(){return {connections:{},jobs:[],results:{}};}
export class Control {
 constructor(state,save,schedule,runner){this.state=state;this.save=save;this.schedule=schedule;this.runner=runner;}
 async persist(){await this.save(this.state);await this.plan();}
 async plan(){let next=Infinity;for(const j of this.state.jobs){if(j.state==='queued')next=Math.min(next,Date.now()+1000);if(j.state==='running')next=Math.min(next,j.leaseUntil);}for(const c of Object.values(this.state.connections))if(c.schedule)next=Math.min(next,c.schedule.nextAt);await this.schedule(Number.isFinite(next)?Math.max(Date.now()+1000,next):null);}
 status(){return {mode:'live',platformCheck:this.state.platformCheck||null,connections:Object.values(this.state.connections).map(c=>({userId:c.userId,connectedAt:c.connectedAt,schedule:c.schedule||null,collectMode:c.mode||'api'})),jobs:this.state.jobs,results:this.state.results};}
 enqueue(b){const userId=String(b.userId||'');if(!this.state.connections[userId])throw new Error('Connect first');const range=period(b.since,b.until);const existing=this.state.jobs.find(j=>j.userId===userId&&['queued','running'].includes(j.state));if(existing)return existing;
 const j={id:crypto.randomUUID(),userId,range,state:'queued',source:'facebook-server',createdAt:new Date().toISOString()};this.state.jobs=this.state.jobs.filter(x=>['queued','running'].includes(x.state)).concat(this.state.jobs.filter(x=>!['queued','running'].includes(x.state)).slice(-99));this.state.jobs.push(j);return j;}
 async request(path,method,b,limit=1){
  if(method==='GET'&&path==='/v1/status')return reply(200,this.status());
  if(method==='POST'&&path==='/v1/connections'){
   if(Object.keys(this.state.connections).length>=limit&&!this.state.connections[b?.userId])return reply(409,{error:'social_limit',limit});
   // Validation and public proxy DNS pinning are performed inside the Node container.
   const c=await this.runner.validate(b);this.state.connections[c.userId]={...c,mode:'api',apiFailures:0,revision:crypto.randomUUID(),connectedAt:new Date().toISOString()};await this.persist();return reply(201,{userId:c.userId,state:'unverified'});
  }
  if(method==='POST'&&path==='/v1/actions'){const action=validateAction(b);if(!this.state.connections[b.userId])throw new Error('Connect first');if(this.state.jobs.some(j=>['queued','running'].includes(j.state)))return reply(409,{error:'busy'});const j={id:crypto.randomUUID(),userId:b.userId,action,state:'queued',source:'facebook-server',createdAt:new Date().toISOString()};this.state.jobs.push(j);await this.persist();return reply(202,j);}
  if(method==='POST'&&path==='/v1/jobs'){const j=this.enqueue(b);await this.persist();return reply(202,j);}
  if(method==='POST'&&path==='/v1/schedule'){
   const c=this.state.connections[b.userId];if(!c||!Number.isInteger(b.minutes)||b.minutes<0||b.minutes>1440||(b.minutes>0&&b.minutes<15))throw new Error('Invalid schedule');
   c.schedule=b.minutes?{minutes:b.minutes,nextAt:Date.now()+b.minutes*60000}:null;await this.persist();return reply(200,{ok:true});
  }
  if(method==='DELETE'&&path==='/v1/connections'){
   delete this.state.connections[b.userId];delete this.state.results[b.userId];for(const j of this.state.jobs)if(j.userId===b.userId&&['queued','running'].includes(j.state))j.state='cancelled';await this.persist();return reply(200,{ok:true});
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
   if(c.schedule?.nextAt<=now){const date=new Date().toISOString().slice(0,10);this.enqueue({userId:c.userId,since:date,until:date});c.schedule.nextAt=now+c.schedule.minutes*60000;}
  }
  const running=this.state.jobs.filter(j=>j.state==='running');
  const exclusive=running.some(j=>j.action||this.state.connections[j.userId]?.mode==='browser');
  const j=this.state.jobs.find(x=>x.state==='queued'&&!running.some(r=>r.userId===x.userId));
  const c=j&&this.state.connections[j.userId];
  if(j&&!c){j.state='cancelled';await this.persist();return null;}
  const heavy=j&&(j.action||c.mode==='browser');
  if(!j||exclusive||running.length>=API_PARALLEL||(heavy&&running.length)){await this.persist();return null;}
  j.state='running';j.startedAt=new Date().toISOString();j.leaseUntil=now+(heavy?15:5)*60000;j.attempt=crypto.randomUUID();await this.persist();
  return {job:structuredClone(j),connection:structuredClone(c),previous:this.state.results[j.userId]?structuredClone(this.state.results[j.userId]):null};
 }
 // Runs one prepared job: API first, one browser attempt when the API path is
 // rejected or the token died (the browser run also fetches a fresh token).
 async execute(work){
  const {job,connection,previous}=work;
  if(job.action){try{return {result:await this.runner.action(connection,job.action)};}catch(e){return {error:{code:e.code}};}}
  let apiError=null;
  if(connection.mode!=='browser'&&this.runner.collectApi){
   try{return {result:await this.runner.collectApi(connection,job.range,previous)};}
   catch(e){apiError=e;if(!BROWSER_FALLBACK.includes(e.code)||!this.runner.collect)return {error:{code:e.code}};}
  }
  try{const result=await this.runner.collect(connection,job.range);return {result:{...result,viaBrowser:true,apiError:apiError?.code??null}};}
  catch(e){return {error:{code:e.code}};}
 }
 async finish(work,result,error){const j=this.state.jobs.find(x=>x.id===work.job.id);if(!j||j.state!=='running'||j.attempt!==work.job.attempt)return;const c=this.state.connections[j.userId];
  if(!c||c.revision!==work.connection.revision)j.state='cancelled';
  else if(error){
   j.state=NEEDS_AUTH.includes(error.code)?'needs_auth':RATE_LIMIT.includes(error.code)?'rate_limited':'failed';
   j.error={code:typeof error.code==='number'?error.code:error.code==='proxy'?'proxy':j.state};
   if(j.state==='needs_auth')c.schedule=null;
   // Meta asked us to slow down: skip the next hour of scheduled runs.
   if(j.state==='rate_limited'&&c.schedule)c.schedule.nextAt=Math.max(c.schedule.nextAt,Date.now()+60*60000);
  }
  else if(j.action){const a=result?.actionResult;if(!a||a.campaignId!==j.action.campaignId){j.state='failed';j.error={code:'invalid_action_result'};}else{j.state=a.state;j.actionResult=a;j.observedAt=a.observedAt;if(result.storageState)c.storageState=result.storageState;}}
  else if(!result?.snapshot?.complete||result.snapshot.source!=='facebook-server'||result.snapshot.social?.user.id!==j.userId){j.state='failed';j.error={code:'invalid_snapshot'};}
  else{
   this.state.results[j.userId]=result.snapshot;j.state='done';j.observedAt=result.snapshot.observedAt;j.mode=result.viaBrowser?'browser':'api';
   if(result.storageState)c.storageState=result.storageState;
   if(typeof result.token==='string'&&/^EA[A-Za-z0-9_-]{18,4094}$/.test(result.token))c.token=result.token;
   if(!result.viaBrowser)c.apiFailures=0;
   // The API path was rejected but the browser worked: after 3 such runs use
   // the browser for a day, then try the cheap path again.
   else if(result.apiError===1&&++c.apiFailures>=3){c.mode='browser';c.apiRetryAt=Date.now()+24*60*60000;}
  }
  delete j.leaseUntil;j.finishedAt=new Date().toISOString();await this.persist();
 }
}
