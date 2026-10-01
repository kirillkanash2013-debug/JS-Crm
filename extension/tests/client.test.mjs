import test from "node:test";
import assert from "node:assert/strict";
import {adsUrl} from "../core.mjs";
import {isServerKey,pickAdsTab,serverErrorText,serverHeadline,spendByCurrency,summarizeServer} from "../client.mjs";
test("server key format and human error texts",()=>{
  assert(isServerKey("js_srv_"+"a".repeat(43)));assert(!isServerKey("js_demo_K7mQ2vN8xR4pT9cW6aY3"));
  assert.match(serverErrorText(401),/Ключ доступа не подходит/);assert.match(serverErrorText(502),/временно недоступен/);
  assert(!/HTTP/.test(serverErrorText(503)));
});
test("picks active Ads Manager tab, otherwise the most recent one",()=>{
  const tabs=[{id:1,url:"https://example.com",active:true},{id:2,url:"https://adsmanager.facebook.com/adsmanager/manage",lastAccessed:5},{id:3,url:"https://business.facebook.com/adsmanager/manage",lastAccessed:9},{id:4}];
  assert.equal(pickAdsTab(tabs,adsUrl).id,3);
  assert.equal(pickAdsTab([...tabs,{id:5,url:"https://adsmanager.facebook.com/x",active:true}],adsUrl).id,5);
  assert.equal(pickAdsTab([{id:1,url:"https://www.facebook.com/"}],adsUrl),null);
});
test("summarizes server status for one social without leaking other users or action jobs",()=>{
  const report=(cur,...spend)=>({account:{currency:cur},metrics:spend.map(s=>({spend:s}))});
  const status={mode:"live",connections:[{userId:"100",schedule:{minutes:15,nextAt:1}},{userId:"200"}],
    jobs:[{userId:"100",state:"done",finishedAt:"2026-10-01T10:00:00Z"},{userId:"100",state:"done",action:{}},{userId:"200",state:"running"}],
    results:{"100":{source:"facebook-server",complete:true,observedAt:"2026-10-01T10:00:00Z",social:{accounts:[1,2]},
      structures:{a:{campaigns:[1,2],adsets:[1],ads:[1,2,3]},b:{campaigns:[1],adsets:[],ads:[]}},
      reports:{a:report("USD",1.5,2),b:report("EUR",3),c:report("USD",0.5)}}}};
  const s=summarizeServer(status,"100");
  assert.equal(s.active,null);assert.equal(s.last.state,"done");assert.equal(s.scheduleMinutes,15);
  assert.deepEqual(s.result,{observedAt:"2026-10-01T10:00:00Z",accounts:2,campaigns:3,adsets:1,ads:3,spend:"4.00 USD · 3.00 EUR"});
  assert.match(serverHeadline(s).text,/каждые 15 мин/);
  assert.equal(serverHeadline(summarizeServer(status,"200")).tone,"busy");
  assert.equal(serverHeadline(summarizeServer(status,"300")).tone,"warn");
  const expired=summarizeServer({...status,jobs:[{userId:"100",state:"needs_auth"}]},"100");
  assert(expired.needsAuth);assert.equal(serverHeadline(expired).tone,"error");
  assert.equal(summarizeServer({...status,results:{"100":{...status.results["100"],source:"simulation"}}},"100").result,null);
  assert.equal(spendByCurrency({}),"");
});
