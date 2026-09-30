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
