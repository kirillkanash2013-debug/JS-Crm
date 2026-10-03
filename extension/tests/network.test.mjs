import test from "node:test";
import assert from "node:assert/strict";
import {requestCredential} from "../network.mjs";
test("request extraction is limited to the selected tab, origin, API and time window",()=>{
  const token="EA"+"a".repeat(30),capture={tabId:7,origin:"https://adsmanager.facebook.com",expiresAt:1000};
  const details={tabId:7,initiator:capture.origin,url:"https://graph.facebook.com/v25.0/act_123?access_token="+token};
  assert.equal(requestCredential(details,capture,100).token,token);
  for(const changed of [{tabId:8},{initiator:"https://www.facebook.com"},{url:"https://graph.facebook.com.evil.example/?access_token="+token},{initiator:undefined}])
    assert.equal(requestCredential({...details,...changed},capture,100),null);
  assert.equal(requestCredential(details,capture,1000),null);
  assert.equal(requestCredential(details,null,100),null);
  const clean={...details,url:"https://graph.facebook.com/v25.0/act_123",requestBody:{formData:{access_token:[token],password:["ignored"]}}};
  assert.deepEqual(requestCredential(clean,capture,100),{token});
  assert.deepEqual(requestCredential({...clean,requestBody:{raw:[{bytes:new TextEncoder().encode(token)}]}},capture,100),{token:null});
});
