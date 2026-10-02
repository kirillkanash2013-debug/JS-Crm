import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkKeitaroSocket,publicIP} from '../src/keitaro-socket.mjs';
test('public IP validation',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','100.64.1.1','192.168.1.1','999.1.1.1','localhost'])assert.equal(publicIP(ip),false);
 assert.equal(publicIP('91.223.123.254'),true);
});
for(const [status,body,result] of [[401,'{}','bad_key'],[200,'[]','ok'],[403,'secret-key','forbidden'],[302,'','unreachable']])
 test('socket response '+status,async()=>{
  let closed=false,wire='';
  const connect=(addr,opts)=>{
   assert.equal(addr.hostname,'91.223.123.254');assert.equal(addr.port,80);assert.equal(opts.secureTransport,'off');
   return {opened:Promise.resolve(),writable:new WritableStream({write:v=>{wire=new TextDecoder().decode(v);}}),readable:new ReadableStream({start:s=>{s.enqueue(new TextEncoder().encode('HTTP/1.1 '+status+' OK\r\nContent-Length: '+body.length+'\r\n\r\n'+body));s.close();}}),close:async()=>{closed=true;}};
  };
  const r=await checkKeitaroSocket('http://91.223.123.254','secret-key',connect);
  assert.equal(r.result,result);assert.equal(closed,true);assert.match(wire,/Api-Key: secret-key/);assert.ok(!JSON.stringify(r).includes('secret-key'));
 });
test('reject key header injection before socket',async()=>assert.equal((await checkKeitaroSocket('http://91.223.123.254','x\r\ny',()=>assert.fail())).result,'bad_key'));
