import test from "node:test";
import assert from "node:assert/strict";
import {pageGraphRead,pageFetcher} from "../page-transport.mjs";
const token="EA"+"a".repeat(30);
function setup(){
 globalThis.location={href:"https://adsmanager.facebook.com/adsmanager/manage"};
 globalThis.require=()=>({USER_ID:"999"});
}
test("page transport uses credentialed read-only XHR in the validated account context",async()=>{
 setup();let captured;
 globalThis.XMLHttpRequest=class {
  open(method,url,async){captured={method,url,async};}
  send(){assert.equal(this.withCredentials,true);assert.equal(this.timeout,20000);this.status=200;this.response={id:"999"};this.onload();}
 };
 const r=await pageGraphRead("https://graph.facebook.com/v25.0/me?fields=id",token,"999");
 assert.deepEqual(r,{status:200,body:{id:"999"}});assert.equal(captured.method,"GET");
 assert.equal(new URL(captured.url).searchParams.get("access_token"),token);
 assert(!JSON.stringify(r).includes(token));
});
test("page transport rejects logout, account switch, foreign URLs, writes and unapproved params before network",async()=>{
 setup();let requests=0;globalThis.XMLHttpRequest=class{constructor(){requests++;}};
 for(const url of ["https://evil.test/v25.0/me","https://graph.facebook.com/v25.0/act_123/users","https://graph.facebook.com/v25.0/me?method=delete","https://graph.facebook.com/v25.0/me?access_token=other"])
  await assert.rejects(pageGraphRead(url,token,"999"));
 await assert.rejects(pageGraphRead("https://graph.facebook.com/v25.0/me",token,"888"));
 globalThis.location.href="https://www.facebook.com/messages";
 await assert.rejects(pageGraphRead("https://graph.facebook.com/v25.0/me",token,"999"));
 assert.equal(requests,0);
});
test("bridge refuses POST and does not expose credentials in returned response",async()=>{
 let calls=0;
 globalThis.chrome={scripting:{executeScript:async o=>{calls++;assert.equal(o.world,"MAIN");assert.equal(o.target.tabId,7);assert.equal(o.args[2],"999");return [{result:{status:200,body:{id:"999"}}}];}}};
 const f=pageFetcher(7,"999");await assert.rejects(f("https://graph.facebook.com/v25.0/",{method:"POST"}));
 const r=await f("https://graph.facebook.com/v25.0/me",{method:"GET",headers:{Authorization:"Bearer "+token}});
 assert.equal(calls,1);assert.equal(r.ok,true);assert.deepEqual(await r.json(),{id:"999"});
});
