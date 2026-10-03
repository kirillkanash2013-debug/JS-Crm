import test from 'node:test';
import assert from 'node:assert/strict';
const mockEnvironment=()=>{
 const before={...process.env},fetcher=globalThis.fetch;
 Object.assign(process.env,{CLOUDFLARE_API_TOKEN:'test-cf',CLOUDFLARE_ACCOUNT_ID:'test-account',BOT_TOKEN:'test-client',ADMIN_BOT_TOKEN:'test-admin',TELEGRAM_BOT_TOKEN:'test-client'});
 return ()=>{for(const k of Object.keys(process.env))if(!(k in before))delete process.env[k];Object.assign(process.env,before);globalThis.fetch=fetcher;};
};
test('platform deployment fails closed on secret inventory errors without replacing encryption keys',async()=>{
 const restore=mockEnvironment(),calls=[];
 try{
  globalThis.fetch=async(url,init)=>{calls.push(init.method);return Response.json({success:false},{status:403});};
  await assert.rejects(import('../bootstrap-secrets.mjs?inventory-test'),/rejected request/);
  assert.deepEqual(calls,['GET']);
 }finally{restore();}
});
test('platform redeployment preserves encryption and billing keys and uses a stable webhook secret',async()=>{
 const restore=mockEnvironment(),writes=[],hooks=[];
 try{
  globalThis.fetch=async(url,init)=>{
   if(String(url).includes('api.telegram.org')){hooks.push(JSON.parse(init.body));return Response.json({ok:true});}
   if(init.method==='PUT')writes.push(JSON.parse(init.body));
   return Response.json({success:true,result:init.method==='GET'?[{name:'MASTER_KEY'},{name:'BILLING_WEBHOOK_SECRET'}]:{}});
  };
  await import('../bootstrap-secrets.mjs?preserve-test-1');await import('../bootstrap-secrets.mjs?preserve-test-2');
  assert(!writes.some(w=>w.name==='MASTER_KEY'||w.name==='BILLING_WEBHOOK_SECRET'));
  assert.equal(hooks[0].secret_token,hooks[1].secret_token);assert.equal(hooks[0].drop_pending_updates,false);
 }finally{restore();}
});
