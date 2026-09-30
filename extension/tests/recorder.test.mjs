import test from "node:test";
import assert from "node:assert/strict";
import {traceRequest,installRecorder} from "../recorder.mjs";
const config={active:true,tabId:7,expiresAt:Date.now()+900000};
const request={tabId:7,requestId:"1",url:"https://www.facebook.com/api/graphql/",method:"POST",initiator:"https://adsmanager.facebook.com",timeStamp:Date.now()};
test("trace retains operation and budget/status shapes, excludes credentials and personal values",()=>{
 const secret="EA"+"a".repeat(40);
 const row=traceRequest({...request,requestBody:{formData:{doc_id:["123456789"],fb_api_req_friendly_name:["AdsCampaignUpdateMutation"],fb_dtsg:[secret],variables:[JSON.stringify({input:{campaign_id:"987654321",daily_budget:"11000",status:"PAUSED",name:"Private campaign",access_token:secret,email:"private@example.test",custom_secret:{daily_budget:"999"}}})]}}},config);
 assert.equal(row.operation,"AdsCampaignUpdateMutation");assert.equal(row.docId,"123456789");assert.deepEqual(row.changes,{daily_budget:"11000",status:"PAUSED"});
 const json=JSON.stringify(row);for(const sensitive of [secret,"987654321","Private campaign","private@example.test","999"])assert(!json.includes(sensitive));
});
test("raw JSON/form and Graph URLs are reduced to safe metadata",()=>{
 const bytes=new TextEncoder().encode('variables='+encodeURIComponent(JSON.stringify({input:{lifetime_budget:20000,status:"ACTIVE"}}))+'&access_token=secret');
 const row=traceRequest({...request,requestBody:{raw:[{bytes:bytes.buffer}]}},config);
 assert.deepEqual(row.changes,{lifetime_budget:"20000",status:"ACTIVE"});assert(!JSON.stringify(row).includes("secret"));
 const graph=traceRequest({...request,url:"https://graph.facebook.com/v25.0/act_123456789/campaigns?access_token=SECRET&fields=name",method:"GET"},config);
 assert.equal(graph.path,"/v25.0/act_:id/campaigns");assert(!JSON.stringify(graph).includes("123456789"));assert(!JSON.stringify(graph).includes("SECRET"));
});
test("trace excludes unrelated tabs/sites/routes, inactive and expired sessions",()=>{
 for(const d of [{...request,tabId:8},{...request,url:"https://evil.test/api/graphql/"},{...request,initiator:"https://evil.test"},{...request,url:"https://www.facebook.com/messages/private"}])assert.equal(traceRequest(d,config),null);
 assert.equal(traceRequest(request,{...config,active:false}),null);assert.equal(traceRequest(request,{...config,expiresAt:0}),null);
});
test("recorder survives popup closure, serializes completion, stops and clears",async()=>{
 const local={};let before,complete;const alarms=new Map();
 const chrome={storage:{local:{get:async()=>({...local}),set:async v=>Object.assign(local,v),remove:async k=>delete local[k]}},alarms:{create:async k=>alarms.set(k,true),clear:async k=>alarms.delete(k)},webRequest:{onBeforeRequest:{addListener:f=>before=f},onCompleted:{addListener:f=>complete=f},onErrorOccurred:{addListener:()=>{}}}};
 const recorder=installRecorder(chrome);await recorder.start(7);
 before(request);complete({...request,statusCode:200,timeStamp:request.timeStamp+55});await recorder.stop();
 assert.equal(local.trace.rows.length,1);assert.equal(local.trace.rows[0].status,200);assert.equal(local.trace.rows[0].durationMs,55);assert.equal(local.trace.active,false);
 before({...request,requestId:"2"});await recorder.stop();assert.equal(local.trace.rows.length,1);
 await recorder.clear();assert.equal(local.trace,undefined);assert(!alarms.has("trace-expiry"));
});
test("recorder recognizes non-Ads operation names and camel-case/nested encoded mutations",()=>{
 const variables={input:JSON.stringify({dailyBudget:{amount:"11000"},configuredStatus:"PAUSED",isEnabled:false,access_token:"EA"+"z".repeat(30)})};
 const row=traceRequest({...request,requestBody:{formData:{fb_api_req_friendly_name:["FBMarketingCampaignUpdateMutation"],variables:[JSON.stringify(variables)]}}},config);
 assert.equal(row.kind,"mutation-candidate");assert.equal(row.operation,"FBMarketingCampaignUpdateMutation");
 assert.equal(row.changes.amount,"11000");assert.equal(row.changes.configured_status,"PAUSED");assert.equal(row.changes.is_enabled,false);
 assert(row.changeCandidates.some(c=>c.path==="variables.input.dailyBudget.amount"));assert(!JSON.stringify(row).includes("zzzzzz"));
});
test("batch root requests expose safe method and relative query changes without URL credentials",()=>{
 const batch=JSON.stringify([{method:"POST",relative_url:"123456789?daily_budget=22000&access_token=PRIVATE&name=CampaignPrivate"}]);
 const row=traceRequest({...request,url:"https://graph.facebook.com/v25.0/",requestBody:{formData:{batch:[batch],access_token:["PRIVATE"]}}},config);
 assert.equal(row.changes.daily_budget,"22000");assert.deepEqual(row.batchMethods,["POST"]);
 for(const value of ["PRIVATE","123456789","CampaignPrivate"])assert(!JSON.stringify(row).includes(value));
});
test("unknown keys retain only shape and bounded payloads omit sensitive subtrees",()=>{
 const vars={updates:[{newDailyBudget:10000,customField:"PrivateValue"}],session_secret:{daily_budget:999},email:"private@example.test"};
 const row=traceRequest({...request,requestBody:{formData:{operationName:["RelayUpdate"],variables:[JSON.stringify(vars)]}}},config);
 assert.equal(row.operation,"RelayUpdate");assert(row.shape.some(s=>s.path.endsWith("customField") && s.type==="string"));
 for(const value of ["PrivateValue","private@example.test","session_secret","999"])assert(!JSON.stringify(row).includes(value));
});
