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
  const first=await read();assert.match(first.text,/Сейчас · \d{2}\.\d{2}\.\d{4} · \d{2}:\d{2}/);
  assert(!JSON.stringify(await store.statsSnapshot(tenant.id)).includes('KG_Test'),'snapshot encrypted');
  events.length=0;await menu();await bot().notifyStatsRefresh(tenant.id);assert.equal(events.length,0,'new bot instance reads same durable pair');
  at='2026-10-03T10:00:00Z';await bot().notifyStatsRefresh(tenant.id);assert.equal(events.length,0,'partial social refresh cannot fetch Keitaro');
  secondAt=at;failFB=true;await assert.rejects(bot().notifyStatsRefresh(tenant.id),/facebook_data_unavailable/);assert(!events.includes('keitaro'));assert.equal((await read()).text,first.text);
  failFB=false;failKT=true;await assert.rejects(bot().notifyStatsRefresh(tenant.id),/keitaro_cycle_failed/);assert.equal((await read()).text,first.text);
  failKT=false;changed=true;await assert.rejects(bot().notifyStatsRefresh(tenant.id),/facebook_cycle_changed/);assert.equal((await read()).text,first.text);
  changed=false;secondAt=at;spend=20;await bot().notifyStatsRefresh(tenant.id);assert.match((await read()).text,/Spend <b>\$40\.00/);
  events.length=0;jobs=[{userId:'a',state:'failed',finishedAt:'2026-10-03T11:00:00Z'}];at=secondAt='2026-10-03T10:30:00Z';await bot().notifyStatsRefresh(tenant.id);assert.equal(events.length,0,'failed FB cannot fetch Keitaro');
  jobs=[{state:'queued'}];await assert.rejects(bot().notifyStatsRefresh(tenant.id),/facebook_cycle_pending/);assert.equal(events.length,0);
  await menu();assert.match(sent.at(-1).text,/\$40\.00/,'old complete pair remains visible');
 } finally{globalThis.fetch=real;}
});
