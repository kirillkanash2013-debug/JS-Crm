import test from 'node:test';
import assert from 'node:assert/strict';
import {createBot} from '../src/bot.mjs';
import {MemoryStore} from '../src/store.mjs';
import {applyPayment} from '../src/accounts.mjs';
import {sealSecret} from '../src/secrets.mjs';
import {keitaroTimezone} from '../src/keitaro.mjs';
const MASTER_KEY=btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
async function setup(timezoneResult) {
 const store=new MemoryStore(),sent=[];
 const {tenant}=await applyPayment(store,{paymentId:crypto.randomUUID(),provider:'test',plan:'team'});
 await store.setChat(1,tenant.id,'keitaro_sub');
 await store.saveSettings(tenant.id,{keitaroUrl:'http://91.223.123.254',keitaroKeyEnc:await sealSecret(MASTER_KEY,tenant.id,'key')});
 const env={MASTER_KEY,PUBLIC_URL:'https://p.test',PLUGIN_URL:'https://p.test/plugin',COLLECTOR_URL:'',KEITARO_BRIDGE:{timezone:async()=>timezoneResult}};
 const bot=createBot({store,env,tg:async(method,payload)=>{sent.push({method,...payload});return {message_id:1};}});
 return {store,tenant,sent,bot,say:text=>bot({message:{chat:{id:1},text}})};
}
test('onboarding reads per-client Keitaro profile timezone and skips manual selection',async()=>{
 const h=await setup({result:'ok',timezone:'Asia/Almaty'});
 await h.say('4');
 assert.equal((await h.store.settings(h.tenant.id)).timezone,'Asia/Almaty');
 assert.equal((await h.store.chat(1)).state,'ready');
 assert.ok(h.sent.some(x=>/00:00/.test(x.text||'')));
 assert.ok(!h.sent.some(x=>x.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data?.startsWith('tz:'))));
});
test('unavailable or invalid profile asks for same timezone as Keitaro without assuming UTC',async()=>{
 for(const r of [{result:'forbidden'},{result:'ok',timezone:'invalid'}]){
  const h=await setup(r);await h.say('4');
  assert.equal((await h.store.settings(h.tenant.id)).timezone,undefined);
  assert.equal((await h.store.chat(1)).state,'timezone');
  assert.match(h.sent.at(-1).text,/Keitaro.*не отдал/);
  await h.say('Europe/Warsaw');
  assert.equal((await h.store.settings(h.tenant.id)).timezone,'Europe/Warsaw');
 }
});
test('existing client can change timezone from profile without restarting onboarding',async()=>{
 const h=await setup({result:'forbidden'});
 await h.store.saveSettings(h.tenant.id,{timezone:'Europe/Minsk',onboardedAt:'2026-10-01'});
 await h.store.setChat(1,h.tenant.id,'ready');
 await h.bot({callback_query:{id:'q',data:'pr:tz',message:{message_id:10,chat:{id:1}}}});
 assert.equal((await h.store.settings(h.tenant.id)).timezone,'Europe/Minsk');
 await h.say('Asia/Dubai');
 assert.equal((await h.store.settings(h.tenant.id)).timezone,'Asia/Dubai');
 assert.equal((await h.store.chat(1)).state,'ready');
 assert.ok(!h.sent.some(x=>/Всё настроено/.test(x.text||'')));
});
test('bridge timezone is validated, never returns a raw profile or key',async()=>{
 const read=keitaroTimezone({KEITARO_BRIDGE:{timezone:async()=>({result:'ok',timezone:'bad',key:'secret'})}});
 assert.equal(await read('https://tracker.test','secret'),null);
});
