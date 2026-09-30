import test from "node:test";
import assert from "node:assert/strict";
import {DEMO_KEY} from "../core.mjs";
test("worker enforces activation, detects account, keeps last snapshot on failure, clears secrets on disconnect",async()=>{
  let listener,alarm,tab={id:7,url:"https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=123"};
  const local={},session={};
  const area=obj=>({setAccessLevel:async()=>{},get:async(keys)=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in obj).map(k=>[k,obj[k]])),
    set:async(items)=>Object.assign(obj,items),remove:async(keys)=>{for(const k of Array.isArray(keys)?keys:[keys])delete obj[k];}});
  globalThis.chrome={storage:{local:area(local),session:area(session)},runtime:{id:"extension-id",getURL:p=>"chrome-extension://extension-id/"+p,
    onMessage:{addListener:f=>listener=f},onStartup:{addListener:()=>{}}},
    tabs:{get:async()=>tab},scripting:{executeScript:async()=>[{result:{accountId:"123",tables:[],visibleRowCount:0}}]},
    permissions:{contains:async()=>true},alarms:{clear:async()=>{alarm=null;},create:async()=>{alarm=true;},onAlarm:{addListener:()=>{}}}};
  await import("../worker.mjs");
  const sender={id:"extension-id",url:"chrome-extension://extension-id/panel.html"};
  const cmd=m=>new Promise(resolve=>listener(m,sender,resolve));
  assert.equal(listener({type:"STATE"},{id:"extension-id",url:"https://evil.test"},()=>{}),false);
  assert.equal((await cmd({type:"CONNECT",tabId:7,since:"2026-09-30",until:"2026-09-30"})).ok,false);
  assert.equal((await cmd({type:"ACTIVATE",key:DEMO_KEY})).ok,true);
  assert.equal((await cmd({type:"CONNECT",tabId:7,since:"2026-09-30",until:"2026-09-30"})).ok,true);
  assert.equal((await cmd({type:"SYNC",mode:"visible"})).ok,true);
  const saved=local.snapshot;
  assert.equal(saved.complete,false);
  assert.equal((await cmd({type:"AUTO",enabled:true})).ok,false);
  assert.equal((await cmd({type:"TOKEN",token:"x".repeat(25)})).ok,true);
  const s=(await cmd({type:"STATE"})).data;
  assert.equal(s.hasMetaToken,true);assert.equal(s.metaToken,undefined);
  assert(!JSON.stringify(local).includes("x".repeat(25)));
  chrome.scripting.executeScript=async()=>[{result:{accountId:"999"}}];
  assert.equal((await cmd({type:"SYNC",mode:"visible"})).ok,false);
  assert.strictEqual(local.snapshot,saved);
  await cmd({type:"DISCONNECT"});assert.equal(local.snapshot,undefined);assert.equal(session.metaToken,undefined);assert.equal(alarm,null);
});
