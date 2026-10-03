import {test} from 'node:test';
import assert from 'node:assert/strict';
import {containerKeitaro} from '../src/keitaro.mjs';
test('private bridge receives origin and key; logs contain no credentials',async()=>{
 const old=console.log,logs=[];console.log=x=>logs.push(x);
 try{
  const fn=containerKeitaro({KEITARO_BRIDGE:{check:async(o,k)=>{assert.equal(o,'http://91.223.123.254');assert.equal(k,'secret-key');return {result:'ok',status:200,campaigns:5};}}});
  assert.equal(await fn('http://91.223.123.254','secret-key'),'ok');
  assert.ok(!logs.join('').includes('secret-key'));assert.ok(!logs.join('').includes('91.223'));
 }finally{console.log=old;}
});
test('bridge failure fails closed',async()=>assert.equal(await containerKeitaro({KEITARO_BRIDGE:{check:async()=>{throw new Error('secret');}}})('http://91.223.123.254','key'),'unreachable'));
