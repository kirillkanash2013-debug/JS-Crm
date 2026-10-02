import {publicProxy} from './proxy.mjs';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {period} from '../extension/core.mjs';
import {hash} from './vault.mjs';
const fb=d=>typeof d==='string'&&/^\.?([a-z0-9-]+\.)*facebook\.com$/.test(d);
export function validateConnection(b){
 if(!b||!/^\d{3,30}$/.test(b.userId)||!/^EA[A-Za-z0-9_-]{18,4094}$/.test(b.token)||typeof b.userAgent!=='string'||b.userAgent.length<10||b.userAgent.length>1024)throw new Error('Invalid connection');
 if(!Array.isArray(b.cookies)||b.cookies.length>200)throw new Error('Invalid cookies');
 const cookies=b.cookies.map(c=>{
  if(!fb(c.domain)||typeof c.name!=='string'||c.name.length>200||typeof c.value!=='string'||c.value.length>10000||typeof c.path!=='string'||!c.path.startsWith('/'))throw new Error('Invalid cookies');
  return {name:c.name,value:c.value,domain:c.domain,path:c.path,httpOnly:!!c.httpOnly,secure:!!c.secure,sameSite:['Strict','Lax','None'].includes(c.sameSite)?c.sameSite:'Lax',expires:Number.isFinite(c.expires)?c.expires:-1};
 });
 if(!cookies.some(c=>c.name==='c_user'&&c.value===b.userId)||!cookies.some(c=>c.name==='xs'))throw new Error('Session cookies missing or another owner');
 let proxy;
 if(b.proxy?.server){const u=new URL(b.proxy.server);if(!['http:','socks5:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!u.port)throw new Error('Invalid proxy');proxy={server:u.origin==='null'?u.protocol+'//'+u.host:u.origin};for(const k of ['username','password'])if(b.proxy[k]){if(typeof b.proxy[k]!=='string'||b.proxy[k].length>1024)throw new Error('Invalid proxy');proxy[k]=b.proxy[k];}}
 return {userId:b.userId,token:b.token,userAgent:b.userAgent,cookies,proxy};
}
export class Service{
 constructor(vault,collector,{simulation=false}={}){this.vault=vault;this.collector=collector;this.simulation=simulation;this.running=false;this.stopping=false;}
 authenticate(key){if(typeof key!=='string'||key.length>200)return null;const digest=Buffer.from(hash(key));return Object.values(this.vault.data.tenants).find(t=>timingSafeEqual(Buffer.from(t.keyHash),digest));}
 async recover(){for(const t of Object.values(this.vault.data.tenants))for(const j of t.jobs)if(j.state==='running'){j.state='queued';j.recovered=true;}await this.vault.save();}
 async connect(t,b){if(this.simulation)throw new Error('Real sessions forbidden in simulation');const c=validateConnection(b);c.proxy=await publicProxy(c.proxy);t.connections[c.userId]={...c,revision:randomUUID(),connectedAt:new Date().toISOString()};await this.vault.save();return {userId:c.userId,state:'unverified'};}
 async enqueue(t,b){const userId=String(b.userId||'');if(!t.connections[userId])throw new Error('Connect first');const range=period(b.since,b.until);const existing=t.jobs.find(j=>j.userId===userId&&['queued','running'].includes(j.state));if(existing)return existing;
 const j={id:randomUUID(),userId,range,state:'queued',source:this.simulation?'simulation':'facebook-server',createdAt:new Date().toISOString()};t.jobs=t.jobs.filter(x=>['queued','running'].includes(x.state)).concat(t.jobs.filter(x=>!['queued','running'].includes(x.state)).slice(-99));t.jobs.push(j);await this.vault.save();return j;}
 async tick(){if(this.running||this.stopping)return;this.running=true;
 try{for(const t of Object.values(this.vault.data.tenants)){
  for(const c of Object.values(t.connections))if(c.schedule&&c.schedule.nextAt<=Date.now()){
   const date=new Date().toISOString().slice(0,10);await this.enqueue(t,{userId:c.userId,since:date,until:date});c.schedule.nextAt=Date.now()+c.schedule.minutes*60000;await this.vault.save();
  }
  const j=t.jobs.find(x=>x.state==='queued');if(!j)continue;const c=t.connections[j.userId];if(!c){j.state='cancelled';await this.vault.save();continue;}const revision=c.revision;
  j.state='running';j.startedAt=new Date().toISOString();await this.vault.save();
  try{const result=await this.collector(c,j.range);if(t.connections[j.userId]?.revision!==revision){j.state='cancelled';}else{t.results[j.userId]=result.snapshot;if(result.storageState)c.storageState=result.storageState;j.state='done';j.observedAt=result.snapshot.observedAt;}}
  catch(e){j.state=['needs_auth','identity',190,102].includes(e.code)?'needs_auth':'failed';if(j.state==='needs_auth')c.schedule=null;j.error={code:typeof e.code==='number'?e.code:j.state==='needs_auth'?'needs_auth':'collector_failed'};}
  j.finishedAt=new Date().toISOString();await this.vault.save();
 }}finally{this.running=false;}}
 status(t){return {mode:this.simulation?'simulation':'live',connections:Object.values(t.connections).map(c=>({userId:c.userId,connectedAt:c.connectedAt,schedule:c.schedule||null})),jobs:t.jobs,results:t.results};}
}
