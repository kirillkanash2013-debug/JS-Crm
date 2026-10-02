import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {Vault,hash} from '../vault.mjs';
import {start} from '../index.mjs';
import {validateConnection} from '../service.mjs';
const session={userId:'100123456',token:'EA'+'x'.repeat(30),userAgent:'Test browser user agent',cookies:[{name:'c_user',value:'100123456',domain:'.facebook.com',path:'/'},{name:'xs',value:'session-secret',domain:'.facebook.com',path:'/'}]};
const fixture=(id='100123456')=>({snapshot:{source:'simulation',complete:true,observedAt:new Date().toISOString(),social:{user:{id},accounts:[{id:'123456'}]},reports:{},structures:{'123456':{campaigns:[{id:'987654'}],adsets:[],ads:[]}}}});
test('server queue runs after HTTP client disconnects; encrypted restart, schedules and tenant isolation',async()=>{
 const dir=await mkdtemp(tmpdir()+'/js-server-'),key=randomBytes(32).toString('base64'),apiKey='js_srv_'+randomBytes(32).toString('base64url');
 const vault=await new Vault(dir,key).open();vault.data.tenants.one={id:'one',keyHash:hash(apiKey),connections:{},jobs:[],results:{}};vault.data.tenants.two={id:'two',keyHash:hash('other'),connections:{},jobs:[],results:{}};
 let calls=0,app=await start({vault,port:0,collector:async c=>{calls++;return fixture(c.userId);}});
 let origin='http://127.0.0.1:'+app.server.address().port;
 const request=async(path,method='GET',body)=>{const r=await fetch(origin+path,{method,headers:{Authorization:'Bearer '+apiKey,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
 try{
  assert.equal((await fetch(origin+'/v1/status')).status,401);
  assert.equal((await request('/v1/connections','POST',session)).status,201);
  const j=(await request('/v1/jobs','POST',{userId:session.userId,since:'2026-10-01',until:'2026-10-01'})).body;
  // HTTP connection is finished. Only the server's persisted queue remains.
  await app.service.tick();assert.equal(calls,1);assert.equal((await request('/v1/status')).body.jobs[0].state,'done');
  assert.equal(Object.keys(vault.data.tenants.two.results).length,0);
  const bytes=await readFile(dir+'/vault.bin');assert(!bytes.includes(Buffer.from(session.token)));assert(!bytes.includes(Buffer.from('session-secret')));
  await app.close();const restored=await new Vault(dir,key).open();app=await start({vault:restored,port:0,collector:async c=>{calls++;return fixture(c.userId);}});origin='http://127.0.0.1:'+app.server.address().port;
  assert.equal((await request('/v1/status')).body.jobs[0].id,j.id);
  assert.equal((await request('/v1/schedule','POST',{userId:session.userId,minutes:15})).status,200);
  restored.data.tenants.one.connections[session.userId].schedule.nextAt=0;await app.service.tick();assert.equal(calls,2);
  const view=JSON.stringify((await request('/v1/status')).body);assert(!view.includes(session.token));assert(!view.includes('session-secret'));assert(!view.includes(apiKey));
  await request('/v1/connections','DELETE',{userId:session.userId});assert.equal((await request('/v1/status')).body.connections.length,0);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
test('proxy with embedded credentials and no port is accepted (same as collection)',()=>{
 // user:pass@host и отсутствие порта — сбор это принимает (publicProxy), значит
 // и действия должны: креды выносятся в отдельные поля, порт проставляется.
 const c=validateConnection({...session,proxy:{server:'socks5://u%40x:p%3Aw@proxy.example.com'}});
 assert.equal(c.proxy.server,'socks5://proxy.example.com:1080');
 assert.equal(c.proxy.username,'u@x');assert.equal(c.proxy.password,'p:w');
 const h=validateConnection({...session,proxy:{server:'http://1.2.3.4:8080',username:'a',password:'b'}});
 assert.equal(h.proxy.server,'http://1.2.3.4:8080');assert.equal(h.proxy.username,'a');
 assert.throws(()=>validateConnection({...session,proxy:{server:'ftp://1.2.3.4:21'}}));
});
test('reject cross-account cookies, external domains; simulator cannot accept real session',async()=>{
 assert.throws(()=>validateConnection({...session,userId:'999999'}));assert.throws(()=>validateConnection({...session,cookies:[...session.cookies,{name:'x',value:'y',domain:'.example.com',path:'/'}]}));
 const dir=await mkdtemp(tmpdir()+'/js-server-'),vault=await new Vault(dir,randomBytes(32).toString('base64')).open();
 const {Service}=await import('../service.mjs');const s=new Service(vault,async()=>fixture(),{simulation:true});await assert.rejects(s.connect({connections:{}},session));await rm(dir,{recursive:true,force:true});
});
test('expired session pauses schedule and never replaces previous good snapshot; restart recovers running job',async()=>{
 const dir=await mkdtemp(tmpdir()+'/js-server-'),vault=await new Vault(dir,randomBytes(32).toString('base64')).open(),{Service}=await import('../service.mjs');
 const t={id:'one',keyHash:hash('key'),connections:{},jobs:[],results:{}};vault.data.tenants.one=t;
 const s=new Service(vault,async()=>{throw Object.assign(new Error('secret MUST NOT leak'),{code:190});});await s.connect(t,session);t.results[session.userId]={complete:true,marker:'prior'};t.connections[session.userId].schedule={minutes:15,nextAt:Date.now()+99999};
 await s.enqueue(t,{userId:session.userId,since:'2026-10-01',until:'2026-10-01'});t.jobs[0].state='running';await s.recover();assert.equal(t.jobs[0].state,'queued');await s.tick();assert.equal(t.jobs[0].state,'needs_auth');assert.equal(t.results[session.userId].marker,'prior');assert.equal(t.connections[session.userId].schedule,null);assert(!JSON.stringify(s.status(t)).includes('MUST NOT leak'));await rm(dir,{recursive:true,force:true});
});
test('proxy DNS cannot route collector to loopback or private network',async()=>{
 const {publicProxy,publicIPv4}=await import('../proxy.mjs');for(const ip of ['127.0.0.1','10.2.3.4','172.16.2.3','192.168.1.1','169.254.169.254','100.64.0.1','::1'])assert.equal(publicIPv4(ip),false);assert.equal(publicIPv4('8.8.8.8'),true);await assert.rejects(publicProxy({server:'http://127.0.0.1:8080'}));
});
