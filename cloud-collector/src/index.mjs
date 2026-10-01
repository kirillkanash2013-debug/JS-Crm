import {DurableObject} from 'cloudflare:workers';
import {Container,getContainer} from '@cloudflare/containers';
import {EncryptedStore} from './crypto-store.mjs';
import {connect} from 'cloudflare:sockets';
import {Control,initialState,reply} from './control.mjs';
import {collectViaApi} from './api-collector.mjs';
import {graphFetcher} from './proxy-fetch.mjs';
import {resolveCaller} from './tenants.mjs';
import {SqlArchive} from './archive.mjs';
import {cleanConnection} from './connection.mjs';
import {PAGE_HEADERS,bookmarkletPage,connectPage,connectScript,importPage,importScript} from './pages.mjs';
import {antidetectClient,matchProfile} from './antidetect/index.mjs';
import {importProfiles} from './importer.mjs';
import {tokenFromSession} from './session-token.mjs';
import {graph} from '../../extension/meta.mjs';

// New connection check without a browser: /me through the social's proxy
// with each token the page offered. Falls back to the browser container
// only when Graph rejects the request form (code 1) and cookies exist.
async function validateApi(b,containerValidate){
 const c=cleanConnection(b);let lastError;
 for(const token of c.tokenCandidates){
  try{const me=await graph('me',{fields:'id'},token,graphFetcher({connect,connection:{...c,token}}));
   if(String(me.id)!==c.userId)throw Object.assign(new Error('Another user'),{code:'identity'});
   const {tokenCandidates,...clean}=c;return {...clean,token};}
  catch(e){lastError=e;if(e.code==='proxy'||e.code==='identity')break;}
 }
 if(lastError?.code===1&&c.cookies.length)return containerValidate(b);
 throw lastError;
}
const paths=new Map([['/v1/status','GET'],['/v1/report','GET'],['/v1/changes','GET'],['/v1/connections','POST,DELETE'],['/v1/jobs','POST'],['/v1/schedule','POST'],['/v1/actions','POST'],['/v1/antidetect','GET,POST,DELETE']]);
async function digest(v){return new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)));}
async function equal(a,b){if(!a||!b)return false;const x=await digest(a),y=await digest(b);let n=0;for(let i=0;i<x.length;i++)n|=x[i]^y[i];return n===0;}
export class BrowserContainer extends Container {
 defaultPort=8080;
 sleepAfter='1m';
 envVars={INTERNAL_KEY:this.env.INTERNAL_KEY};
 async onActivityExpired(){
  try{const r=await this.containerFetch('http://localhost/health');const s=await r.json();if(s.busy){this.renewActivityTimeout();return;}}catch{}
  await this.stop();
 }
 onError(){throw new Error('Container unavailable');}
}
export class CollectorControl extends DurableObject {
 constructor(ctx,env){super(ctx,env);
  ctx.blockConcurrencyWhile(async()=>{
   this.vault=new EncryptedStore(ctx.storage,env.VAULT_KEY);
   const call=async(path,body)=>{
    const c=getContainer(env.BROWSER,'browser:'+ctx.id.toString());const r=await c.fetch(new Request('http://localhost'+path,{method:'POST',headers:{Authorization:'Bearer '+env.INTERNAL_KEY,'content-type':'application/json'},body:JSON.stringify(body)}));const value=await r.json();
    if(!r.ok)throw Object.assign(new Error('Collector failed'),{code:value.code});return value;
   };
   this.control=new Control(await this.vault.load()||initialState(),s=>this.vault.save(s),time=>time?ctx.storage.setAlarm(time):ctx.storage.deleteAlarm(),{validate:b=>call('/validate',b),validateApi:b=>validateApi(b,x=>call('/validate',x)),collect:(c,range)=>call('/collect',{connection:c,range}),action:(c,action)=>call('/action',{connection:c,action}),smoke:()=>call('/smoke',{}),
    // Cheap path: Graph API through the social's proxy, right here in the Durable Object.
    collectApi:(c,range,previous)=>collectViaApi(c,range,{fetcher:graphFetcher({connect,connection:c}),previous}),
    // Fresh token from the live cookies without a browser.
    refreshToken:async c=>(await tokenFromSession(c,{connect})).tokens[0],
    // Antidetect integration: the client pastes only an API token; profiles,
    // proxies and cookies are read here, never on the client's machine.
    antidetectProfiles:config=>antidetectClient(config).profiles(),
    importProfiles:config=>importProfiles(antidetectClient(config),{connect,browserAvailable:true}),
    matchProfile:async(config,userAgent)=>matchProfile(await antidetectClient(config).profiles(),userAgent)},
    // Client's own database (SQLite in this Durable Object) + raw archive in R2.
    new SqlArchive(ctx.storage.sql,env.ARCHIVE||null));
  });
 }
 async fetch(request){
  // Even internal DO calls require the gateway's secret. No public forwarding to Chromium.
  if(!await equal(request.headers.get('x-control-internal'),this.env.INTERNAL_KEY))return reply(401,{error:'unauthorized'});
  if(new URL(request.url).pathname==='/internal/smoke'){try{const result=await this.control.runner.smoke();await this.ctx.blockConcurrencyWhile(async()=>{this.control.state.platformCheck=result;await this.control.persist();});return reply(200,result);}catch{return reply(503,{error:'browser_unavailable'});}}
  try{return await this.ctx.blockConcurrencyWhile(async()=>{
   const url=new URL(request.url),b=request.method==='GET'?Object.fromEntries(url.searchParams):await request.json();const limit=Number(request.headers.get('x-social-limit'))||1;return this.control.request(url.pathname,request.method,b,limit);
  });}catch{return reply(400,{error:'invalid_request'});}
 }
 // Takes every job that may run now (several cheap API jobs in parallel), runs
 // them outside the storage gate and records each result as soon as it ends.
 async alarm(){
  const works=[];
  for(let work;(work=await this.ctx.blockConcurrencyWhile(()=>this.control.prepare()));)works.push(work);
  await Promise.all(works.map(async work=>{const {result,error}=await this.control.execute(work);await this.ctx.blockConcurrencyWhile(()=>this.control.finish(work,result,error));}));
 }
}
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  // FBacc-style connection without an extension: bookmark + connect page.
  if(request.method==='GET'&&url.pathname==='/bookmarklet')return new Response(bookmarkletPage(url.origin),{headers:PAGE_HEADERS});
  if(request.method==='GET'&&url.pathname==='/connect')return new Response(connectPage(),{headers:PAGE_HEADERS});
  if(request.method==='GET'&&url.pathname==='/connect.js')return new Response(connectScript(),{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'}});
  // Fully server-side quick connect: paste one antidetect API token, import all profiles.
  if(request.method==='GET'&&url.pathname==='/import')return new Response(importPage(),{headers:PAGE_HEADERS});
  if(request.method==='GET'&&url.pathname==='/import.js')return new Response(importScript(),{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'}});
  if(request.method==='GET'&&url.pathname==='/health')return reply(200,{ok:true,service:'js-control-collector',platform:'cloudflare-containers',mode:'live',ownerConfigured:/^js_srv_[A-Za-z0-9_-]{43}$/.test(env.JS_CONTROL_OWNER_KEY||'')});
  if(request.method==='POST'&&url.pathname==='/internal/smoke'){if(!env.DEPLOY_SMOKE_KEY||!env.INTERNAL_KEY||!env.VAULT_KEY||!await equal(request.headers.get('authorization'),'Bearer '+env.DEPLOY_SMOKE_KEY))return reply(401,{error:'unauthorized'});try{return await env.CONTROL.getByName('owner').fetch(new Request('http://internal/internal/smoke',{method:'POST',headers:{'x-control-internal':env.INTERNAL_KEY}}));}catch{return reply(503,{error:'browser_unavailable'});}}
  if(!paths.get(url.pathname)?.split(',').includes(request.method))return reply(404,{error:'not_found'});
  if(!env.VAULT_KEY||!env.INTERNAL_KEY)return reply(503,{error:'setup_required'});
  // Owner key → the owner's space; client integration token (jsi_) → that client's
  // own Durable Object, with the social limit of the client's plan.
  const caller=await resolveCaller(request.headers.get('authorization'),env,equal);
  if(caller.error)return reply(caller.status,{error:caller.error});
  if(request.method!=='GET'){
   if(!request.headers.get('content-type')?.startsWith('application/json'))return reply(415,{error:'json_required'});
   const reader=request.body?.getReader();let size=0,chunks=[];if(!reader)return reply(400,{error:'invalid_request'});
   for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>256000){await reader.cancel();return reply(413,{error:'too_large'});}chunks.push(value);}
   const bytes=new Uint8Array(size);let i=0;for(const c of chunks){bytes.set(c,i);i+=c.length;}request=new Request(request.url,{method:request.method,headers:request.headers,body:bytes});
  }
  const headers=new Headers(request.headers);headers.delete('authorization');headers.set('x-control-internal',env.INTERNAL_KEY);
  headers.set('x-social-limit',String(caller.socialLimit));
  try{return await env.CONTROL.getByName(caller.space).fetch(new Request(request,{headers}));}catch{return reply(503,{error:'collector_unavailable'});}
 }
};
