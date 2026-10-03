import {diagnosticCode} from './diagnostics.mjs';
// Persistent global admission. One active job per tenant; FIFO across tenants.
// Expired permits are recovered after crashes. Never contains provider credentials.
export class Admission {
  constructor(state={},clock=Date.now){this.state={leases:{},waiting:{},usage:{},...state};this.clock=clock;}
  acquire(pool,tenant,capacity=8){
    const now=this.clock();
    for(const [id,l] of Object.entries(this.state.leases))if(l.until<=now)delete this.state.leases[id];
    for(const [id,w] of Object.entries(this.state.waiting))if(w.seen<now-120000)delete this.state.waiting[id];
    const key=pool+':'+tenant;
    this.state.waiting[key]={pool,tenant,at:this.state.waiting[key]?.at??now,seen:now};
    const live=Object.values(this.state.leases).filter(l=>l.pool===pool);
    const queue=Object.entries(this.state.waiting).filter(([,w])=>w.pool===pool&&!live.some(l=>l.tenant===w.tenant)).sort((a,b)=>a[1].at-b[1].at);
    if(live.length>=capacity||live.some(l=>l.tenant===tenant)||queue[0]?.[0]!==key)return null;
    delete this.state.waiting[key];const id=crypto.randomUUID();
    const slot=Array.from({length:capacity},(_,i)=>i).find(i=>!live.some(l=>l.slot===i));
    this.state.leases[id]={pool,tenant,slot,at:now,until:now+20*60000};return id;
  }
  release(id,ok=true,code=null,record=true){const l=this.state.leases[id];if(!l)return;delete this.state.leases[id];if(!record)return;
    const day=new Date(this.clock()).toISOString().slice(0,10),key=day+':'+l.tenant;
    const u=this.state.usage[key]??={tenant:l.tenant,day,jobs:0,containerCalls:0,failed:0,jobMs:0,containerMs:0};
    const ms=Math.max(0,this.clock()-l.at);
    if(l.pool==='jobs'){u.jobs++;u.jobMs+=ms;u.maxJobMs=Math.max(u.maxJobMs||0,ms);}else if(l.pool==='containers'){u.containerCalls++;u.containerMs+=ms;}else{u.reports=(u.reports||0)+1;}
    if(!ok){u.failed++;u.errors??={};const c=diagnosticCode(code);u.errors[c]=(u.errors[c]||0)+1;}
    for(const [k,v] of Object.entries(this.state.usage))if(v.day<new Date(this.clock()-90*864e5).toISOString().slice(0,10))delete this.state.usage[k];
  }
  summary(tenant=null){const now=this.clock(),live=Object.values(this.state.leases).filter(l=>l.until>now&&(!tenant||l.tenant===tenant));
    const waiting=Object.values(this.state.waiting).filter(w=>w.seen>=now-120000&&(!tenant||w.tenant===tenant));
    return {activeJobs:live.filter(l=>l.pool==='jobs').length,activeContainerCalls:live.filter(l=>l.pool==='containers').length,
      activeReports:live.filter(l=>l.pool==='reports').length,oldestWaitMs:Math.max(0,...waiting.map(w=>now-w.at)),
      waiting:waiting.length,
      usage:Object.values(this.state.usage).filter(u=>(!tenant||u.tenant===tenant)&&u.day>=new Date(now-90*864e5).toISOString().slice(0,10))};
  }
}
