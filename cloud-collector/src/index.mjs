import {WorkerEntrypoint,DurableObject} from 'cloudflare:workers';
import {Container,getContainer} from '@cloudflare/containers';
import {EncryptedStore} from './crypto-store.mjs';
import {connect} from 'cloudflare:sockets';
import {checkKeitaroSocket,reportKeitaroSocket,publicIP} from './keitaro-socket.mjs';
import {Control,initialState,reply} from './control.mjs';
import {collectViaApi} from './api-collector.mjs';
import {graphFetcher} from './proxy-fetch.mjs';
import {resolveCaller} from './tenants.mjs';
import {VERSION} from './version.mjs';
import {SqlArchive} from './archive.mjs';
import {cleanConnection} from './connection.mjs';
import {PAGE_HEADERS,bookmarkletPage,connectPage,connectScript,importPage,importScript,statusPage,statusScript,extensionPage} from './pages.mjs';
import {EXTENSION_ZIP_BASE64,EXTENSION_VERSION} from './extension-asset.mjs';
import {antidetectClient,matchProfile} from './antidetect/index.mjs';
import {importProfiles} from './importer.mjs';
import {tokenFromSession} from './session-token.mjs';
import {graph} from '../../extension/meta.mjs';

// Connection check. With a proxy → the Node container (reliable SOCKS5+TLS,
// Workers can't do SOCKS5+login). Without a proxy → the Worker socket path,
// trying each token the page offered; browser fallback on request-form reject.
async function validateApi(b,{apiValidate,containerValidate}){
 const c=cleanConnection(b);
 if(c.proxy){const {tokenCandidates,...clean}=c;await apiValidate({...clean});return clean;}
 let lastError;
 for(const token of c.tokenCandidates){
  try{const me=await graph('me',{fields:'id'},token,graphFetcher({connect,connection:{...c,token}}));
   if(String(me.id)!==c.userId)throw Object.assign(new Error('Another user'),{code:'identity'});
   const {tokenCandidates,...clean}=c;return {...clean,token};}
  catch(e){lastError=e;if(e.code==='proxy'||e.code==='identity')break;}
 }
 if(lastError?.code===1&&c.cookies.length)return containerValidate(b);
 throw lastError;
}
const paths=new Map([['/v1/me','GET'],['/v1/status','GET'],['/v1/report','GET'],['/v1/changes','GET'],['/v1/campaigns','GET'],['/v1/connections','POST,DELETE'],['/v1/jobs','POST'],['/v1/schedule','POST'],['/v1/actions','POST'],['/v1/antidetect','GET,POST,DELETE']]);
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
    const c=getContainer(env.BROWSER,'browser:'+ctx.id.toString());const r=await c.fetch(new Request('http://localhost'+path,{method:'POST',headers:{Authorization:'Bearer '+env.INTERNAL_KEY,'content-type':'application/json'},body:JSON.stringify(body)}));
    // The container can return a non-JSON body when it is cold-starting or
    // crashed (e.g. a plain "Failed to ..." page). Surface that as a clean
    // error with a snippet, instead of leaking a raw JSON.parse SyntaxError.
    const text=await r.text();let value;
    try{value=text?JSON.parse(text):{};}catch{throw Object.assign(new Error('container_non_json'),{code:'container_unavailable',detail:'Коллектор ещё запускается, попробуйте ещё раз. ('+text.slice(0,120)+')'});}
    if(!r.ok)throw Object.assign(new Error(value.detail||'Collector failed'),{code:value.code,detail:value.detail});return value;
   };
   this.control=new Control(await this.vault.load()||initialState(),s=>this.vault.save(s),time=>time?ctx.storage.setAlarm(time):ctx.storage.deleteAlarm(),{validate:b=>call('/validate',b),validateApi:b=>validateApi(b,{apiValidate:x=>call('/api-validate',x),containerValidate:x=>call('/validate',x)}),collect:(c,range)=>call('/collect',{connection:c,range}),action:(c,action)=>call('/action',{connection:c,action}),smoke:()=>call('/smoke',{}),
    // Cheap path: with a proxy use the Node container (reliable SOCKS5+TLS);
    // without a proxy, Graph API straight from the Durable Object socket.
    collectApi:(c,range,previous)=>c.proxy?call('/api-collect',{connection:c,range,previous}):collectViaApi(c,range,{fetcher:graphFetcher({connect,connection:c}),previous}),
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
  // Remember which tenant owns this DO, so collection-finish notifications can
  // be addressed to the right bot chat (persisted whenever a request persists).
  const tid=request.headers.get('x-tenant-id');if(tid)this.control.state.tenantId=tid;
  try{return await this.ctx.blockConcurrencyWhile(async()=>{
   const url=new URL(request.url),b=request.method==='GET'?Object.fromEntries(url.searchParams):await request.json();const limit=Number(request.headers.get('x-social-limit'))||1;return this.control.request(url.pathname,request.method,b,limit);
  });}catch{return reply(400,{error:'invalid_request'});}
 }
 // Sends the queued "social connected" notifications (with real counts) to the
 // bot, once each, outside the storage gate. Failures stay queued for next time.
 async announcePending(){
  const pending=this.control.state.pendingAnnounce;
  if(!pending?.length||!this.env.PLATFORM||!this.control.state.tenantId)return;
  const tenantId=this.control.state.tenantId,done=[];
  for(const userId of [...pending]){
   try{
    const c=this.control.state.connections[userId],sum=this.control.archive?.socialSummary?.(userId)||{};
    await this.env.PLATFORM.socialCollected(tenantId,{userId,label:c?.label||null,fbName:sum.fbName??null,rk:sum.rkBm??sum.accounts??null,rkPersonal:sum.rkPersonal??null,bm:sum.businesses??null,fp:sum.pages??null,collectedAt:sum.lastAt||null});
    done.push(userId);
   }catch{}
  }
  if(done.length)await this.ctx.blockConcurrencyWhile(async()=>{this.control.state.pendingAnnounce=(this.control.state.pendingAnnounce||[]).filter(u=>!done.includes(u));await this.control.persist();});
 }
 // Takes every job that may run now (several cheap API jobs in parallel), runs
 // them outside the storage gate and records each result as soon as it ends.
 async alarm(){
  const works=[];
  for(let work;(work=await this.ctx.blockConcurrencyWhile(()=>this.control.prepare()));)works.push(work);
  const collected=works.some(w=>!w.job?.action&&w.job?.kind!=='import');
  await Promise.all(works.map(async work=>{const {result,error}=await this.control.execute(work);await this.ctx.blockConcurrencyWhile(()=>this.control.finish(work,result,error));}));
  await this.announcePending();
  // Once per refresh cycle, let the bot send the fresh report (if the client
  // turned that on). Fire-and-forget; the platform checks the setting.
  if(collected&&this.env.PLATFORM&&this.control.state.tenantId){try{await this.env.PLATFORM.statsRefreshed(this.control.state.tenantId);}catch{}}
 }
}
export default {
 async fetch(request,env,ctx){
  const url=new URL(request.url);
  // FBacc-style connection without an extension: bookmark + connect page.
  if(request.method==='GET'&&url.pathname==='/bookmarklet')return new Response(bookmarkletPage(url.origin),{headers:PAGE_HEADERS});
  if(request.method==='GET'&&url.pathname==='/connect')return new Response(connectPage(),{headers:PAGE_HEADERS});
  if(request.method==='GET'&&url.pathname==='/connect.js')return new Response(connectScript(),{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'}});
  // Fully server-side quick connect: paste one antidetect API token, import all profiles.
  if(request.method==='GET'&&url.pathname==='/import')return new Response(importPage(),{headers:PAGE_HEADERS});
  if(request.method==='GET'&&url.pathname==='/import.js')return new Response(importScript(),{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'}});
  // Download and install the connector extension into the antidetect browser.
  if(request.method==='GET'&&url.pathname==='/extension')return new Response(extensionPage(),{headers:PAGE_HEADERS});
  // Filename carries the version so the client never confuses an old download
  // with a new one. The bot adds ?v=<version> to bust Telegram's URL cache.
  if(request.method==='GET'&&url.pathname==='/extension.zip')return new Response(Uint8Array.from(atob(EXTENSION_ZIP_BASE64),c=>c.charCodeAt(0)),{headers:{'content-type':'application/zip','content-disposition':'attachment; filename="js-control-extension-'+EXTENSION_VERSION+'.zip"','cache-control':'no-store'}});
  // Simple check page (no bot): paste the key, see collection status and spend.
  if(request.method==='GET'&&url.pathname==='/status')return new Response(statusPage(),{headers:PAGE_HEADERS});
  if(request.method==='GET'&&url.pathname==='/status.js')return new Response(statusScript(),{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'}});
  if(request.method==='GET'&&url.pathname==='/health')return reply(200,{ok:true,service:'js-control-collector',version:VERSION,extensionVersion:EXTENSION_VERSION,platform:'cloudflare-containers',mode:'live',ownerConfigured:/^js_srv_[A-Za-z0-9_-]{43}$/.test(env.JS_CONTROL_OWNER_KEY||'')});
  if(request.method==='POST'&&url.pathname==='/internal/smoke'){if(!env.DEPLOY_SMOKE_KEY||!env.INTERNAL_KEY||!env.VAULT_KEY||!await equal(request.headers.get('authorization'),'Bearer '+env.DEPLOY_SMOKE_KEY))return reply(401,{error:'unauthorized'});try{return await env.CONTROL.getByName('owner').fetch(new Request('http://internal/internal/smoke',{method:'POST',headers:{'x-control-internal':env.INTERNAL_KEY}}));}catch{return reply(503,{error:'browser_unavailable'});}}
  if(request.method==='POST'&&url.pathname==='/internal/keitaro-probe'){
   if(!env.DEPLOY_SMOKE_KEY||!await equal(request.headers.get('authorization'),'Bearer '+env.DEPLOY_SMOKE_KEY))return reply(401,{error:'unauthorized'});
   try{return reply(200,await keitaroContainerCheck(env,'http://91.223.123.254',''));}catch{return reply(503,{error:'container_unavailable'});}
  }
  if(!paths.get(url.pathname)?.split(',').includes(request.method))return reply(404,{error:'not_found'});
  if(!env.VAULT_KEY||!env.INTERNAL_KEY)return reply(503,{error:'setup_required'});
  // Owner key → the owner's space; client integration token (jsi_) → that client's
  // own Durable Object, with the social limit of the client's plan.
  const caller=await resolveCaller(request.headers.get('authorization'),env,equal);
  // Step 1 of the connect page: verify the token and show the account, before cookies/proxy.
  if(url.pathname==='/v1/me')return caller.error?reply(caller.status,{error:caller.error,account:caller.account||null}):reply(200,{account:caller.account});
  if(caller.error)return reply(caller.status,{error:caller.error});
  if(request.method!=='GET'){
   if(!request.headers.get('content-type')?.startsWith('application/json'))return reply(415,{error:'json_required'});
   const reader=request.body?.getReader();let size=0,chunks=[];if(!reader)return reply(400,{error:'invalid_request'});
   for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>256000){await reader.cancel();return reply(413,{error:'too_large'});}chunks.push(value);}
   const bytes=new Uint8Array(size);let i=0;for(const c of chunks){bytes.set(c,i);i+=c.length;}request=new Request(request.url,{method:request.method,headers:request.headers,body:bytes});
  }
  const headers=new Headers(request.headers);headers.delete('authorization');headers.set('x-control-internal',env.INTERNAL_KEY);
  headers.set('x-social-limit',String(caller.socialLimit));
  // Tell the DO which tenant it serves, so it can address the bot after the
  // first collection (the "loaded" card is sent there, with real counts).
  if(caller.space.startsWith('tenant:'))headers.set('x-tenant-id',caller.space.slice('tenant:'.length));
  try{
   const resp=await env.CONTROL.getByName(caller.space).fetch(new Request(request,{headers}));
   // On connect: show the card immediately in "collecting" state (the DO sends
   // the "loaded" update later, after the first collection).
   if(env.PLATFORM&&request.method==='POST'&&url.pathname==='/v1/connections'&&resp.ok&&caller.space.startsWith('tenant:')){
    const tenantId=caller.space.slice('tenant:'.length);
    ctx?.waitUntil((async()=>{try{const d=await resp.clone().json();await env.PLATFORM.socialConnected(tenantId,{userId:d.userId,label:d.label??null});}catch{}})());
   }
   return resp;
  }catch{return reply(503,{error:'collector_unavailable'});}
 }
};

async function keitaroContainerCheck(env,origin,key) {
  try{if(publicIP(new URL(origin).hostname)){const r=await checkKeitaroSocket(origin,key,connect);if(r.result!=='unreachable')return r;}}catch{}
  if(!env.INTERNAL_KEY)return {result:'unreachable',reason:'setup_required'};
  try {
   const c=getContainer(env.BROWSER,'keitaro-api');
   const r=await c.fetch(new Request('http://localhost/keitaro-check',{
    method:'POST',headers:{Authorization:'Bearer '+env.INTERNAL_KEY,'content-type':'application/json'},body:JSON.stringify({origin,key})
   }));
   return r.ok?await r.json():{result:'unreachable',reason:'container'};
  }catch{return {result:'unreachable',reason:'container'};}
}
// Keitaro report over the IP-bypass transport (socket first, container fallback),
// mirroring keitaroContainerCheck. Returns raw report+conversion rows to the platform.
async function keitaroContainerReport(env,origin,key,opts){
  try{if(publicIP(new URL(origin).hostname)){const r=await reportKeitaroSocket(origin,key,opts,connect);if(r.result!=='unreachable')return r;}}catch{}
  if(!env.INTERNAL_KEY)return {result:'unreachable',reason:'setup_required'};
  try {
   const c=getContainer(env.BROWSER,'keitaro-api');
   const r=await c.fetch(new Request('http://localhost/keitaro-report',{
    method:'POST',headers:{Authorization:'Bearer '+env.INTERNAL_KEY,'content-type':'application/json'},body:JSON.stringify({origin,key,...opts})
   }));
   return r.ok?await r.json():{result:'unreachable',reason:'container'};
  }catch{return {result:'unreachable',reason:'container'};}
}
export class KeitaroBridge extends WorkerEntrypoint {
 async check(origin,key){return keitaroContainerCheck(this.env,origin,key);}
 async report(origin,key,opts){return keitaroContainerReport(this.env,origin,key,opts||{});}
}
