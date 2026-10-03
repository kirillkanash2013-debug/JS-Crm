import test from 'node:test';
import assert from 'node:assert/strict';
import {createBot} from '../src/bot.mjs';
import {MemoryStore} from '../src/store.mjs';
import {applyPayment} from '../src/accounts.mjs';
import {sealSecret,openSecret} from '../src/secrets.mjs';

const MASTER_KEY=btoa('x'.repeat(32));
test('durable pairs: menus never fetch Keitaro; failed or partial FB/Keitaro keeps the previous pair',async()=>{
 const store=new MemoryStore(),events=[],sent=[];
 const {tenant}=await applyPayment(store,{paymentId:'paired',provider:'test',plan:'team',masterKey:MASTER_KEY});
 await store.setChat(1,tenant.id,'ready');
 await store.saveSettings(tenant.id,{timezone:'UTC',keitaroUrl:'https://k.test',keitaroKeyEnc:await sealSecret(MASTER_KEY,tenant.id,'api-key'),keitaroSub:'4',statsMsgId:'7'});
 let at='2026-10-03T09:00:00Z',secondAt=at,failFB=false,failKT=false,changed=false,jobs=[],spend=10;
 const env={MASTER_KEY,COLLECTOR_URL:'https://c.test',KEITARO_BRIDGE:{report:async()=>{events.push('keitaro');if(changed)at='2026-10-03T10:05:00Z';return failKT?{result:'unreachable'}:{result:'ok',report:[],conversions:[]};}}};
 const tg=async(method,p)=>{sent.push({method,...p});return {message_id:7};};
 const bot=()=>createBot({store,tg,env});
 const real=globalThis.fetch;
 globalThis.fetch=async url=>{
  if(url.endsWith('/v1/status'))return Response.json({connections:[{userId:'a',collectedAt:at},{userId:'b',collectedAt:secondAt}],jobs});
  if(url.includes('/v1/campaigns')){events.push('facebook');return Response.json({campaigns:[{campaignId:'1',name:'KG_Test',spend}]},{status:failFB?503:200});}
  return Response.json({});
 };
 const menu=()=>bot()({message:{chat:{id:1},text:'📊 Статистика'}});
 const read=async()=>JSON.parse(await openSecret(MASTER_KEY,tenant.id,(await store.statsSnapshot(tenant.id)).enc));
 try {
  await menu();assert.equal(events.length,0,'first menu never fetches Keitaro');
  await bot().notifyStatsRefresh(tenant.id);
  assert.deepEqual(events,['facebook','facebook','keitaro'],'Facebook responses finish before Keitaro');
  assert(sent.some(m => /Facebook собран. Получаем Keitaro/.test(m.text||'')),'Keitaro phase is published');
  const first=await read();assert.match(first.text,/Сейчас · \d{2}\.\d{2}\.\d{4} · \d{2}:\d{2}/);
  assert(!JSON.stringify(await store.statsSnapshot(tenant.id)).includes('KG_Test'),'snapshot encrypted');
  events.length=0;await menu();await bot().notifyStatsRefresh(tenant.id);assert.equal(events.length,0,'new bot instance reads same durable pair');
  at='2026-10-03T10:00:00Z';await bot().notifyStatsRefresh(tenant.id);assert.equal(events.length,0,'partial social refresh cannot fetch Keitaro');
  secondAt=at;failFB=true;await assert.rejects(bot().notifyStatsRefresh(tenant.id),/facebook_data_unavailable/);assert(!events.includes('keitaro'));assert.equal((await read()).text,first.text);
  assert(sent.at(-1).text.indexOf('Spend') < sent.at(-1).text.indexOf('Обновление не завершено'),'failure status appears below the report');
  failFB=false;failKT=true;await assert.rejects(bot().notifyStatsRefresh(tenant.id),/keitaro_cycle_failed/);assert.equal((await read()).text,first.text);
  failKT=false;changed=true;await assert.rejects(bot().notifyStatsRefresh(tenant.id),/facebook_cycle_changed/);assert.equal((await read()).text,first.text);
  changed=false;secondAt=at;spend=20;await bot().notifyStatsRefresh(tenant.id);assert.match((await read()).text,/Spend <b>\$40\.00/);
  events.length=0;jobs=[{userId:'a',state:'failed',finishedAt:'2026-10-03T11:00:00Z'}];at=secondAt='2026-10-03T10:30:00Z';await bot().notifyStatsRefresh(tenant.id);assert.equal(events.length,0,'failed FB cannot fetch Keitaro');
  jobs=[{state:'queued'}];await assert.rejects(bot().notifyStatsRefresh(tenant.id),/facebook_cycle_pending/);assert.equal(events.length,0);
  await menu();assert.match(sent.at(-1).text,/\$40\.00/,'old complete pair remains visible');
 } finally{globalThis.fetch=real;}
});

test('manual cooldown uses the newest social and its footer shows when refresh becomes available',async()=>{
 const store=new MemoryStore(),sent=[];let calls=0;
 const {tenant}=await applyPayment(store,{paymentId:'cooldown',provider:'test',plan:'team',masterKey:MASTER_KEY});
 await store.setChat(1,tenant.id,'ready');await store.saveSettings(tenant.id,{timezone:'UTC',refreshMinutes:30});
 const bot=createBot({store,tg:async(m,p)=>{sent.push(p);return{};},env:{MASTER_KEY,COLLECTOR_URL:'https://c.test'}});
 const real=globalThis.fetch;
 globalThis.fetch=async url=>{
  if(url.endsWith('/v1/jobs')){calls++;return Response.json({});}
  return Response.json({connections:[{userId:'a',collectedAt:new Date(Date.now()-60*60000).toISOString()},{userId:'b',collectedAt:new Date(Date.now()-5*60000).toISOString()}],jobs:[]});
 };
 try{await bot({callback_query:{id:'1',data:'stats:refresh',message:{message_id:9,chat:{id:1}}}});
 assert.equal(calls,0);assert.match(sent.at(-1).text,/Ручное обновление доступно в \d{2}:\d{2}/);assert.match(sent.at(-1).text,/Плановый сбор: каждые 30 мин/);
 }finally{globalThis.fetch=real;}
});
