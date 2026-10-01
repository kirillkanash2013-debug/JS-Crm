import {DurableObject} from 'cloudflare:workers';
import {Container,getContainer} from '@cloudflare/containers';
import {EncryptedStore} from './crypto-store.mjs';
import {Control,initialState,reply} from './control.mjs';
const paths=new Map([['/v1/status','GET'],['/v1/connections','POST,DELETE'],['/v1/jobs','POST'],['/v1/schedule','POST']]);
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
    const c=getContainer(env.BROWSER,'primary');const r=await c.fetch(new Request('http://localhost'+path,{method:'POST',headers:{Authorization:'Bearer '+env.INTERNAL_KEY,'content-type':'application/json'},body:JSON.stringify(body)}));const value=await r.json();
    if(!r.ok)throw Object.assign(new Error('Collector failed'),{code:value.code});return value;
   };
   this.control=new Control(await this.vault.load()||initialState(),s=>this.vault.save(s),time=>time?ctx.storage.setAlarm(time):ctx.storage.deleteAlarm(),{validate:b=>call('/validate',b),collect:(c,range)=>call('/collect',{connection:c,range}),smoke:()=>call('/smoke',{})});
  });
 }
 async fetch(request){
  // Even internal DO calls require the gateway's secret. No public forwarding to Chromium.
  if(!await equal(request.headers.get('x-control-internal'),this.env.INTERNAL_KEY))return reply(401,{error:'unauthorized'});
  if(new URL(request.url).pathname==='/internal/smoke'){try{const result=await this.control.runner.smoke();await this.ctx.blockConcurrencyWhile(async()=>{this.control.state.platformCheck=result;await this.control.persist();});return reply(200,result);}catch{return reply(503,{error:'browser_unavailable'});}}
  try{return await this.ctx.blockConcurrencyWhile(async()=>{
   const url=new URL(request.url),b=request.method==='GET'?undefined:await request.json();return this.control.request(url.pathname,request.method,b);
  });}catch{return reply(400,{error:'invalid_request'});}
 }
 async alarm(){let work=await this.ctx.blockConcurrencyWhile(()=>this.control.prepare());if(!work)return;let result,error;
  try{result=await this.control.runner.collect(work.connection,work.job.range);}catch(e){error={code:e.code};}
  await this.ctx.blockConcurrencyWhile(()=>this.control.finish(work,result,error));
 }
}
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(request.method==='GET'&&url.pathname==='/health')return reply(200,{ok:true,service:'js-control-collector',platform:'cloudflare-containers',mode:'live',ownerConfigured:/^js_srv_[A-Za-z0-9_-]{43}$/.test(env.JS_CONTROL_OWNER_KEY||'')});
  if(request.method==='POST'&&url.pathname==='/internal/smoke'){if(!env.DEPLOY_SMOKE_KEY||!env.INTERNAL_KEY||!env.VAULT_KEY||!await equal(request.headers.get('authorization'),'Bearer '+env.DEPLOY_SMOKE_KEY))return reply(401,{error:'unauthorized'});try{return await env.CONTROL.getByName('owner').fetch(new Request('http://internal/internal/smoke',{method:'POST',headers:{'x-control-internal':env.INTERNAL_KEY}}));}catch{return reply(503,{error:'browser_unavailable'});}}
  if(!paths.get(url.pathname)?.split(',').includes(request.method))return reply(404,{error:'not_found'});
  if(!/^js_srv_[A-Za-z0-9_-]{43}$/.test(env.JS_CONTROL_OWNER_KEY||'')||!env.VAULT_KEY||!env.INTERNAL_KEY)return reply(503,{error:'setup_required'});
  if(!await equal(request.headers.get('authorization'),'Bearer '+env.JS_CONTROL_OWNER_KEY))return reply(401,{error:'unauthorized'});
  if(request.method!=='GET'){
   if(!request.headers.get('content-type')?.startsWith('application/json'))return reply(415,{error:'json_required'});
   const reader=request.body?.getReader();let size=0,chunks=[];if(!reader)return reply(400,{error:'invalid_request'});
   for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>256000){await reader.cancel();return reply(413,{error:'too_large'});}chunks.push(value);}
   const bytes=new Uint8Array(size);let i=0;for(const c of chunks){bytes.set(c,i);i+=c.length;}request=new Request(request.url,{method:request.method,headers:request.headers,body:bytes});
  }
  const headers=new Headers(request.headers);headers.delete('authorization');headers.set('x-control-internal',env.INTERNAL_KEY);
  try{return await env.CONTROL.getByName('owner').fetch(new Request(request,{headers}));}catch{return reply(503,{error:'collector_unavailable'});}
 }
};
