import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {checkKeitaroNode} from '../keitaro.mjs';
const resolve=async()=>[{address:'91.223.123.254',family:4}];
function fake(status,body,inspect=()=>{}) {
 return (url,options,cb)=>{
  inspect(url,options);
  const req=new EventEmitter();
  req.setTimeout=()=>{}; req.destroy=()=>{req.emit('error',new Error());req.emit('close');};
  req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;cb(res);res.emit('data',Buffer.from(body));res.emit('end');req.emit('close');});
  return req;
 };
}
test('IP request sends correct endpoint and pins DNS',async()=>{
 const r=await checkKeitaroNode('http://91.223.123.254','test-key',{resolve,request:fake(200,'[{"id":1}]',(url,o)=>{
  assert.equal(url.href,'http://91.223.123.254/admin_api/v1/campaigns');assert.equal(o.headers['Api-Key'],'test-key');
  o.lookup('anything',{},(_e,ip)=>assert.equal(ip,'91.223.123.254'));
 })});
 assert.deepEqual(r,{result:'ok',status:200,campaigns:1});
});
for(const [status,body,result] of [[401,'{}','bad_key'],[403,'{"error":"denied"}','forbidden'],[302,'','unreachable'],[200,'<html>login</html>','unreachable'],[500,'secret-key','unreachable']])
 test('classifies '+status+' without returning raw body',async()=>{
  const r=await checkKeitaroNode('http://91.223.123.254','secret-key',{resolve,request:fake(status,body)});
  assert.equal(r.result,result);assert.ok(!JSON.stringify(r).includes('secret-key'));
 });
test('rejects private DNS and URL credentials before transport',async()=>{
 for(const origin of ['http://user:password@91.223.123.254','file:///etc/passwd','http://91.223.123.254/a']){
  assert.equal((await checkKeitaroNode(origin,'key',{resolve,request:()=>assert.fail()})).result,'unreachable');
 }
 assert.equal((await checkKeitaroNode('http://127.0.0.1','key',{resolve:async()=>[{address:'127.0.0.1',family:4}],request:()=>assert.fail()})).reason,'private_address');
});
test('accepts wrapped campaign list',async()=>assert.equal((await checkKeitaroNode('http://91.223.123.254','key',{resolve,request:fake(200,'{"data":[]}')})).result,'ok'));
