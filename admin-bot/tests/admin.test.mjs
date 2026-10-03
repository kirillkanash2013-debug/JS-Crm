import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdminBot} from '../src/bot.mjs';
import {adminRoute} from '../src/http.mjs';
test('admin gateway refuses groups, foreign users, invalid secret and missing update id',async()=>{
 let calls=0;const env={ADMIN_CHAT_IDS:'7',ADMIN_WEBHOOK_SECRET:'secret',INBOX:{getByName:()=>({fetch:async()=>{calls++;return Response.json({ok:true});}})}};
 const call=(u,key='secret')=>adminRoute(new Request('https://a/telegram',{method:'POST',headers:{'x-telegram-bot-api-secret-token':key},body:JSON.stringify(u)}),env);
 const valid={update_id:1,message:{from:{id:7},chat:{id:7,type:'private'},text:'/load'}};
 assert.equal((await call(valid,'bad')).status,401);assert.equal((await call({...valid,message:{...valid.message,from:{id:8}}})).status,403);
 assert.equal((await call({...valid,message:{...valid.message,chat:{id:7,type:'group'}}})).status,403);
 assert.equal((await call({...valid,update_id:undefined})).status,400);assert.equal((await call(valid)).status,200);assert.equal(calls,1);
});
test('personal messages and broadcasts require preview then exact confirmation',async()=>{
 const sent=[],calls=[];const bot=createAdminBot({tg:async(m,p)=>{sent.push({m,...p});},api:async(actor,path,b)=>{calls.push({actor,path,b});return path==='message/preview'?{id:'draft',body:b.text}:path==='message/confirm'?{state:'queued',id:'draft'}:{cancelled:true};}});
 await bot({message:{from:{id:7},text:'/message client-1 Привет'}});assert.equal(calls[0].path,'message/preview');assert(!calls.some(c=>c.path==='message/confirm'));
 await bot({callback_query:{id:'q',from:{id:7},data:'confirm:draft'}});assert.equal(calls.at(-1).path,'message/confirm');assert.equal(calls.at(-1).b.id,'draft');
 await bot({message:{from:{id:7},text:'/broadcast Обновление'}});assert.equal(calls.at(-1).b.tenantId,'*');
 await bot({callback_query:{id:'q2',from:{id:7},data:'cancel:draft'}});assert.equal(calls.at(-1).path,'message/cancel');
});
test('admin displays counters without claiming container milliseconds are CPU billing',async()=>{
 const sent=[];const bot=createAdminBot({tg:async(m,p)=>sent.push(p),api:async()=>({activeJobs:3,activeContainerCalls:2,waiting:9,usage:[{jobs:10,failed:1,jobMs:1000,containerCalls:5,containerMs:500}]})});
 await bot({message:{from:{id:7},text:'/load'}});assert(sent[0].text.includes('Активные задания: 3'));assert(sent[0].text.includes('не равно оплачиваемому CPU'));
});
test('empty monitoring shows zero counters and an explicit absence of measurements',async()=>{
 const sent=[];const bot=createAdminBot({tg:async(m,p)=>sent.push(p),api:async()=>({activeJobs:0,activeContainerCalls:0,activeReports:0,waiting:0,usage:[]})});
 await bot({message:{from:{id:7},text:'/load'}});
 assert(!/undefined|NaN/.test(sent[0].text));assert(sent[0].text.includes('Заданий: 0'));assert(sent[0].text.includes('нет измерений'));
});
test('readiness is authenticated and checks both dependencies without exposing client metadata',async()=>{
 const calls=[],env={ADMIN_CHAT_IDS:'7',ADMIN_WEBHOOK_SECRET:'wh',ADMIN_API_KEY:'api',PLATFORM:{fetch:async r=>{calls.push(new URL(r.url).pathname);return Response.json({clients:[{name:'private-client'}],usage:[]});}}};
 const call=(key='wh')=>adminRoute(new Request('https://admin/internal/ready',{method:'POST',headers:{'x-admin-internal':key}}),env);
 assert.equal((await call('wrong')).status,401);assert.equal(calls.length,0);
 const r=await call();assert.deepEqual(await r.json(),{ok:true});assert.equal(calls.length,2);
 env.PLATFORM.fetch=async()=>new Response('',{status:503});assert.equal((await call()).status,503);
});
