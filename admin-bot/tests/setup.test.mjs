import test from 'node:test';
import assert from 'node:assert/strict';
test('partial shared key setup preserves existing keys and aborts before writing secrets',async()=>{
 const before={...process.env},oldFetch=globalThis.fetch,calls=[];
 try{
  Object.assign(process.env,{CLOUDFLARE_API_TOKEN:'test',CLOUDFLARE_ACCOUNT_ID:'test',ADMIN_BOT_TOKEN:'new-bot',TELEGRAM_BOT_TOKEN:'client-bot',ADMIN_BOT_URL:'https://example.test'});
  globalThis.fetch=async(url,init)=>{
   calls.push(init.method);
   if(String(url).includes('api.telegram.org'))return Response.json({ok:true,result:{id:123,is_bot:true}});
   return Response.json({success:true,result:String(url).includes('js-control-platform')?[{name:'ADMIN_API_KEY'}]:[]});
  };
  await assert.rejects(import('../scripts/setup.mjs?partial-test'),/Partial key setup/);assert(!calls.includes('PUT'));
 }finally{globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in before))delete process.env[k];Object.assign(process.env,before);}
});
