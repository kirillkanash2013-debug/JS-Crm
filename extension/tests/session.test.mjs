import test from "node:test";
import assert from "node:assert/strict";
import {inspectAdsSession} from "../session.mjs";
test("session probe uses explicit fields, keeps credentials separate from diagnostics, and rejects other pages",()=>{
  const token="EA"+"x".repeat(30);
  globalThis.location={href:"https://adsmanager.facebook.com/adsmanager/manage?act=123"};
  globalThis.document={querySelectorAll:()=>[{textContent:'{"accessToken":"'+token+'","USER_ID":"999"}'}]};
  globalThis.require=name=>name==="CurrentUserInitialData" ? {USER_ID:"999",NAME:"Owner"} : {accessToken:token};
  const s=inspectAdsSession();assert.equal(s.userId,"999");assert.equal(s.candidates.length,1);
  assert(!JSON.stringify(s.diagnostics).includes(token));
  globalThis.location.href="https://www.facebook.com/messages";
  assert.throws(inspectAdsSession);
  delete globalThis.require;
});

test("AdsAPIConfig works when AdsPEGlobal is absent",()=>{
  const token="EA"+"a".repeat(30);
  globalThis.location={href:"https://adsmanager.facebook.com/adsmanager/manage"};
  globalThis.document={querySelectorAll:()=>[]};
  globalThis.require=name=>{
    if(name==="CurrentUserInitialData")return {USER_ID:"999"};
    if(name==="AdsAPIConfig")return {access_token:token};
    throw new Error("module missing");
  };
  const result=inspectAdsSession();
  assert.equal(result.candidates[0].token,token);
  assert.equal(result.diagnostics.adsModuleAvailable,false);
  assert.equal(result.diagnostics.configModuleAvailable,true);
  assert(!JSON.stringify(result.diagnostics).includes(token));
  delete globalThis.require;
});
test("escaped fields and quoted EA candidates are recognized for owner validation",()=>{
  const token="EA"+"b".repeat(30);
  globalThis.location={href:"https://adsmanager.facebook.com/"};
  const config=JSON.stringify(JSON.stringify({access_token:token}));
  globalThis.document={querySelectorAll:()=>[{textContent:config},{textContent:JSON.stringify({other:"EA"+"c".repeat(30)})}]};
  const result=inspectAdsSession();
  assert.equal(result.candidates.length,2);
  assert.equal(result.candidates[0].token,token);
  assert(!JSON.stringify(result.diagnostics).includes(token));
});
