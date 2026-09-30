import test from "node:test";
import assert from "node:assert/strict";
import {DEMO_KEY} from "../core.mjs";
test("social connector collects two accounts, keeps auth private and stops on rate-limit",async()=>{
  let listener,alarmListener,networkListener;
  const local={},session={},alarms=new Map(),token="EA"+"a".repeat(30),calls=[];
  const area=obj=>({setAccessLevel:async()=>{},get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in obj).map(k=>[k,obj[k]])),
    set:async data=>Object.assign(obj,data),remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete obj[k];}});
  globalThis.chrome={webRequest:{onBeforeRequest:{addListener:(fn,filter,extras)=>{if(filter.urls.length>1)return;networkListener=fn;assert.deepEqual(filter,{urls:["https://graph.facebook.com/*"]});assert.deepEqual(extras,["requestBody"]);}}},storage:{local:area(local),session:area(session)},
    runtime:{id:"social-test",getURL:p=>"chrome-extension://social-test/"+p,onMessage:{addListener:f=>listener=f},onStartup:{addListener:()=>{}}},
    tabs:{get:async()=>({id:7,url:"https://adsmanager.facebook.com/adsmanager/manage?act=123"})},
    scripting:{executeScript:async options=>{assert.equal(options.world,"MAIN");if(options.func.name==="pageGraphRead"){assert.equal(options.target.tabId,7);assert.equal(options.args[2],"999");const r=await globalThis.fetch(options.args[0],{headers:{Authorization:"Bearer "+options.args[1]}});return [{result:{status:r.ok?200:400,body:await r.json()}}];}return [{result:{userId:"999",candidates:[],diagnostics:{candidateCount:1}}}];}},
    permissions:{contains:async()=>true},alarms:{create:async(name,opts)=>alarms.set(name,opts),clear:async name=>alarms.delete(name),onAlarm:{addListener:f=>alarmListener=f}}};
  globalThis.fetch=async(url,options)=>{
    assert.equal(options.headers.Authorization,"Bearer "+token);assert(!url.includes(token));calls.push(url);
    const p=new URL(url).pathname;
    let data;
    if(p.endsWith("/me"))data={id:"999",name:"Owner"};
    else if(p.endsWith("/adaccounts"))data={data:[{account_id:"123",name:"A",currency:"USD"},{account_id:"456",name:"B",currency:"EUR"}]};
    else {
      const id=p.includes("act_123") ? "123" : "456",currency=id==="123" ? "USD" : "EUR";
      if(p.endsWith("/campaigns"))data={data:[{id:id==="123" ? "888" : "777",name:"Campaign",account_id:id,status:"ACTIVE"}]};
      else if(p.endsWith("/insights"))data={data:[{account_id:id,campaign_id:id==="123" ? "888" : "777",spend:"5.01",account_currency:currency,date_start:"2026-09-30",date_stop:"2026-09-30"}]};
      else data={account_id:id,name:"Account",currency,timezone_name:"Asia/Bishkek"};
    }
    return {ok:true,json:async()=>data};
  };
  await import("../worker.mjs?social");
  const sender={id:"social-test",url:"chrome-extension://social-test/panel.html"};
  const command=m=>new Promise(resolve=>listener(m,sender,resolve));
  await command({type:"ACTIVATE",key:DEMO_KEY});
  const invalid=await command({type:"CONNECT_SOCIAL_TOKEN",tabId:7,token:DEMO_KEY,since:"2026-09-30",until:"2026-09-30"});
  assert.equal(invalid.ok,false);assert.equal(session.metaToken,undefined);
  const normalFetch=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,json:async()=>({id:"888",name:"Other"})});
  const mismatched=await command({type:"CONNECT_SOCIAL_TOKEN",tabId:7,token,since:"2026-09-30",until:"2026-09-30"});
  assert.equal(mismatched.ok,false);assert.equal(local.social,undefined);assert.equal(session.metaToken,undefined);
  globalThis.fetch=normalFetch;
  const imported=await command({type:"CONNECT_SOCIAL_TOKEN",tabId:7,token,since:"2026-09-30",until:"2026-09-30"});
  assert.equal(imported.ok,true);assert.equal(local.social.accounts.length,2);
  assert.equal(local.sessionDiagnostics.source,"local-token-import");
  assert(!JSON.stringify((await command({type:"STATE"})).data).includes(token));
  await command({type:"DISCONNECT"});assert.equal(session.metaToken,undefined);
  const armed=await command({type:"CONNECT_SOCIAL",tabId:7,since:"2026-09-30",until:"2026-09-30"});
  assert.equal(armed.data.pending,true);assert.equal(local.social,undefined);
  const request={tabId:7,initiator:"https://adsmanager.facebook.com",url:"https://graph.facebook.com/v25.0/act_123?access_token="+token};
  networkListener({...request,tabId:8});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(session.networkCapture.candidates.length,0);
  networkListener(request);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(session.networkCapture.candidates.length,1);
  assert(!JSON.stringify(local).includes(token));
  assert(!JSON.stringify((await command({type:"STATE"})).data).includes(token));
  const connected=await command({type:"CONNECT_SOCIAL",tabId:7,since:"2026-09-30",until:"2026-09-30"});
  assert.equal(connected.ok,true);assert.equal(local.social.accounts.length,2);assert.equal(local.binding,undefined);
  assert.equal(session.networkCapture,undefined);assert(!alarms.has("capture-expiry"));assert.equal(session.metaToken,token);assert(!JSON.stringify(local).includes(token));
  assert.equal((await command({type:"SYNC_SOCIAL"})).ok,true);
  for(let i=0;i<100 && local.job.state==="running";i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(local.job.state,"done");assert.equal(local.job.index,2);
  assert.equal(local.reports["123"].account.currency,"USD");assert.equal(local.reports["456"].account.currency,"EUR");
  assert(!alarms.has("whole"));assert.equal((await command({type:"STATE"})).data.metaToken,undefined);
  const previous=local.reports["123"];
  globalThis.fetch=async()=>({ok:false,json:async()=>({error:{code:4,message:"private token "+token}})});
  local.job={id:"stopped-test",state:"running",userId:"999",ids:["123","456"],index:0,range:{since:"2026-09-30",until:"2026-09-30"},errors:[],leaseUntil:0};
  alarmListener({name:"whole"});
  for(let i=0;i<100 && local.job.state==="running";i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(local.job.state,"stopped");assert.strictEqual(local.reports["123"],previous);
  assert(!JSON.stringify(local).includes(token));
});
