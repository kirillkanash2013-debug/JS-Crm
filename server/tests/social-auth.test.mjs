import test from 'node:test';
import assert from 'node:assert/strict';
import {collect} from '../collector.mjs';
function chromium(url,identity){return {launch:async()=>({close:async()=>{},newContext:async()=>({newPage:async()=>({goto:async()=>{},waitForFunction:async()=>{throw new Error('timeout');},url:()=>url,evaluate:async()=>identity})})})};}
for(const [path,id,code] of [['/adsmanager/',null,'temporary_provider_failure'],['/checkpoint/',null,'checkpoint'],['/login/',null,'expired_session'],['/adsmanager/','999','identity']]){
 test('browser validation '+path+' / '+id+' is classified as '+code,async()=>{
  await assert.rejects(collect({userId:'101',cookies:[]},{since:'2026-10-01',until:'2026-10-02'},{chromium:chromium('https://www.facebook.com'+path,id)}),e=>e.code===code);
 });
}

import {collectionError} from '../../shared/collection-errors.mjs';
test('container transport preserves rate limits, challenge and transient flags without leaking raw errors',()=>{
 for(const code of [17,613,'checkpoint','selfie','verification_required','proxy','temporary_provider_failure']){
  const error=collectionError({code,message:'secret-token-and-proxy'});assert.equal(error.code,code);assert(!JSON.stringify(error).includes('secret-token'));
 }
 assert.equal(collectionError({code:999,httpStatus:503}).transient,true);
 assert.equal(collectionError({code:190}).transient,false);
 assert.equal(collectionError({name:'TimeoutError'}).code,'timeout');
});
