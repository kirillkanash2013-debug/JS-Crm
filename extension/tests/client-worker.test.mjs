import test from "node:test";
import assert from "node:assert/strict";
import {DEFAULT_SERVER} from "../client.mjs";
test("client flow: server key login, one-button connect with auto reload, server hand-off, safe disconnect",async()=>{
  let listener,networkListener,reloads=0,serverDown=false;
  const local={},session={},token="EA"+"b".repeat(30),key="js_srv_"+"k".repeat(43),server=[];
  const area=obj=>({setAccessLevel:async()=>{},get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in obj).map(k=>[k,obj[k]])),
    set:async data=>Object.assign(obj,data),remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete obj[k];}});
  const tab={id:7,status:"complete",url:"https://adsmanager.facebook.com/adsmanager/manage?act=123"};
  globalThis.chrome={webRequest:{onBeforeRequest:{addListener:(fn,filter)=>{if(filter.urls.includes("https://graph.facebook.com/*"))networkListener=fn;}}},
    storage:{local:area(local),session:area(session)},
    runtime:{id:"client-test",getURL:p=>"chrome-extension://client-test/"+p,onMessage:{addListener:f=>listener=f},onStartup:{addListener:()=>{}}},
    tabs:{get:async()=>tab,reload:async id=>{assert.equal(id,7);reloads++;setTimeout(()=>networkListener({tabId:7,initiator:"https://adsmanager.facebook.com",url:"https://graph.facebook.com/v25.0/act_123?access_token="+token}),50);}},
    scripting:{executeScript:async o=>{
      if(o.func.name==="pageGraphRead"){const r=await globalThis.fetch(o.args[0],{headers:{Authorization:"Bearer "+o.args[1]}});return [{result:{status:200,body:await r.json()}}];}
      if(o.func.name==="inspectAdsSession")return [{result:{userId:"999",candidates:[],diagnostics:{}}}];
      return [{result:{id:"999",ua:"Mozilla/5.0 test"}}];
    }},
    cookies:{getAllCookieStores:async()=>[{id:"0",tabIds:[7]}],getAll:async()=>[{name:"c_user",value:"999",domain:".facebook.com",path:"/",sameSite:"lax"},{name:"xs",value:"s",domain:".facebook.com",path:"/",sameSite:"no_restriction"}]},
    permissions:{contains:async()=>true},alarms:{create:async()=>{},clear:async()=>{},onAlarm:{addListener:()=>{}}}};
  globalThis.fetch=async(url,options={})=>{
    if(url.startsWith(DEFAULT_SERVER)){
      const path=new URL(url).pathname,body=options.body ? JSON.parse(options.body) : null;
      server.push({path,method:options.method,body});
      if(options.headers.Authorization!=="Bearer "+key)return {ok:false,status:401,json:async()=>({})};
      if(serverDown)return {ok:false,status:503,json:async()=>({})};
      return {ok:true,status:200,json:async()=>path==="/v1/status" ? {mode:"live",connections:[],jobs:[],results:{}} : {ok:true}};
    }
    const p=new URL(url).pathname;
    const data=p.endsWith("/me") ? {id:"999",name:"Owner"} : {data:[{account_id:"123",name:"A",currency:"USD"}]};
    return {ok:true,json:async()=>data};
  };
  await import("../worker.mjs?client");
  const sender={id:"client-test",url:"chrome-extension://client-test/panel.html"};
  const command=m=>new Promise(resolve=>listener(m,sender,resolve));
  const wrong=await command({type:"ACTIVATE",key:"js_srv_"+"x".repeat(43)});
  assert.equal(wrong.ok,false);assert.match(wrong.error,/Ключ доступа не подходит/);assert.equal(local.license,undefined);
  assert.equal((await command({type:"ACTIVATE",key:" "+key+" "})).ok,true);
  assert.equal(local.license.mode,"server");assert.deepEqual(local.server,{origin:DEFAULT_SERVER,key});
  const state=(await command({type:"STATE"})).data;
  assert.deepEqual(state.server,{origin:DEFAULT_SERVER});assert(!JSON.stringify(state).includes(key));
  assert.match((await command({type:"CLIENT_CONNECT",tabId:7})).error,/Подтвердите/);
  assert.equal(local.social,undefined);assert.equal(reloads,0);
  server.length=0;
  const done=await command({type:"CLIENT_CONNECT",tabId:7,consent:true});
  assert.equal(done.ok,true,done.error);assert.equal(done.data.mode,"server");assert.equal(reloads,1);
  assert.deepEqual(server.map(r=>r.method+" "+r.path),["GET /v1/status","POST /v1/connections","POST /v1/jobs","POST /v1/schedule"]);
  assert.equal(server[1].body.token,token);assert.equal(server[3].body.minutes,15);
  assert(!JSON.stringify(local).includes(token));
  serverDown=true;
  const failed=await command({type:"CLIENT_DISCONNECT"});
  assert.equal(failed.ok,false);assert.match(failed.error,/Не удалось удалить соц с сервера/);assert.equal(local.social.user.id,"999");
  serverDown=false;
  assert.equal((await command({type:"CLIENT_DISCONNECT"})).ok,true);
  assert.equal(local.social,undefined);assert.equal(session.metaToken,undefined);assert.equal(server.at(-1).method,"DELETE");
  assert.equal((await command({type:"SIGN_OUT"})).ok,true);assert.equal(local.server,undefined);assert.equal(local.license,undefined);
});
