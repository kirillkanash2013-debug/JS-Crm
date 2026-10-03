// Administrative API: metadata only. No credentials, campaign names or raw reports.
export async function secureEqual(a,b){if(!a||!b)return false;const enc=new TextEncoder();const [x,y]=await Promise.all([a,b].map(v=>crypto.subtle.digest('SHA-256',enc.encode(v))));let n=0;const p=new Uint8Array(x),q=new Uint8Array(y);for(let i=0;i<p.length;i++)n|=p[i]^q[i];return n===0;}
export class OperationsStore {
 constructor(db){this.db=db;}
 async clients(cursor=''){return (await this.db.prepare('SELECT id,name,plan,status,paid_until AS paidUntil,social_limit AS socialLimit FROM tenants WHERE id>? ORDER BY id LIMIT 21').bind(cursor).all()).results||[];}
 async client(id){return this.db.prepare('SELECT t.id,t.name,t.plan,t.status,t.paid_until AS paidUntil,t.social_limit AS socialLimit,(SELECT count(*) FROM socials WHERE tenant_id=t.id) AS socials FROM tenants t WHERE t.id=?').bind(id).first();}
 async draft(actor,tenant,body){
  const id=crypto.randomUUID();await this.db.prepare('INSERT INTO admin_drafts(id,actor,tenant_id,body,expires_at) VALUES(?,?,?,?,?)').bind(id,actor,tenant,body,Date.now()+600000).run();return {id,tenant,body};
 }
 async consume(id,actor){const row=await this.db.prepare("SELECT * FROM admin_drafts WHERE id=? AND actor=? AND state='pending' AND expires_at>?").bind(id,actor,Date.now()).first();if(!row)return null;
  const r=await this.db.prepare("UPDATE admin_drafts SET state='sending' WHERE id=? AND actor=? AND state='pending'").bind(id,actor).run();return r.meta?.changes===1?row:null;
 }
 async cancel(id,actor){const r=await this.db.prepare("UPDATE admin_drafts SET state='cancelled' WHERE id=? AND actor=? AND state='pending'").bind(id,actor).run();return r.meta?.changes===1;}
 async history(actor){return (await this.db.prepare('SELECT id,kind,tenant_id AS tenantId,created_at AS createdAt,state FROM operations_audit WHERE actor=? ORDER BY created_at DESC LIMIT 20').bind(actor).all()).results||[];}
 async queueBroadcast(d){
  await this.db.batch([
   this.db.prepare("INSERT OR IGNORE INTO admin_deliveries(id,draft_id,tenant_id,chat_id,updated_at) SELECT ?||':'||t.id,?,t.id,c.chat_id,? FROM tenants t JOIN chats c ON c.tenant_id=t.id AND c.chat_id=t.owner_chat_id LEFT JOIN settings s ON s.tenant_id=t.id WHERE t.status='active' AND COALESCE(s.service_messages,1)=1").bind(d.id,d.id,new Date().toISOString()),
   this.db.prepare("UPDATE admin_drafts SET state='queued' WHERE id=?").bind(d.id)
  ]);
 }
 async deliveries(id,actor){const d=await this.db.prepare('SELECT state FROM admin_drafts WHERE id=? AND actor=?').bind(id,actor).first();if(!d)return null;return {state:d.state,counts:(await this.db.prepare('SELECT state,count(*) AS count FROM admin_deliveries WHERE draft_id=? GROUP BY state').bind(id).all()).results||[]};}
 async audit(id,actor,tenant,state){await this.db.prepare('INSERT INTO operations_audit(id,actor,kind,tenant_id,created_at,state) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').bind(id,actor,'support_message',tenant,new Date().toISOString(),state).run();await this.db.prepare('UPDATE admin_drafts SET state=? WHERE id=?').bind(state,id).run();}
}
export async function operationsRoute(request,env,{store,tg,ops=new OperationsStore(env.DB)}={}){
 const url=new URL(request.url);if(!url.pathname.startsWith('/internal/admin/'))return null;
 const json=(status,body)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
 if(!env.ADMIN_API_KEY||!await secureEqual(request.headers.get('authorization'),'Bearer '+env.ADMIN_API_KEY))return json(401,{error:'unauthorized'});
 const actor=request.headers.get('x-admin-actor');
 if(!actor||!String(env.ADMIN_CHAT_IDS||'').split(',').map(s=>s.trim()).includes(actor))return json(403,{error:'forbidden'});
 if(request.method!=='POST')return json(405,{error:'method_not_allowed'});
 const raw=await request.text();if(raw.length>12000)return json(413,{error:'too_large'});let b;try{b=JSON.parse(raw||'{}');}catch{return json(400,{error:'invalid_json'});}
 const action=url.pathname.slice('/internal/admin/'.length);
 if(action==='clients'){const list=await ops.clients(String(b.cursor||''));return json(200,{clients:list.slice(0,20),nextCursor:list.length>20?list[19].id:null});}
 if(action==='client'){const c=await ops.client(String(b.tenantId||''));return c?json(200,c):json(404,{error:'not_found'});}
 if(action==='load'){
  if(!env.COLLECTOR||!env.COLLECTOR_OPERATIONS_KEY)return json(503,{error:'monitoring_not_configured'});
  const r=await env.COLLECTOR.fetch(new Request('https://collector/internal/metrics',{method:'POST',headers:{authorization:'Bearer '+env.COLLECTOR_OPERATIONS_KEY,'content-type':'application/json'},body:JSON.stringify({tenant:b.tenantId||null})}));
  return json(r.status,await r.json());
 }
 if(action==='history')return json(200,{events:await ops.history(actor)});
 if(action==='message/cancel')return json(200,{cancelled:await ops.cancel(String(b.id||''),actor)});
 if(action==='message/status'){const status=await ops.deliveries(String(b.id||''),actor);return status?json(200,status):json(404,{error:'not_found'});}
 if(action==='message/preview'){
  const tenant=String(b.tenantId||''),body=String(b.text||'').trim();
  if(!body||body.length>3000||(tenant!=='*'&&!await ops.client(tenant)))return json(400,{error:'invalid_message'});
  if(tenant!=='*'&&!await store.chatForTenant(tenant))return json(409,{error:'client_not_connected'});
  return json(200,await ops.draft(actor,tenant,body));
 }
 if(action==='message/confirm'){
  const d=await ops.consume(String(b.id||''),actor);if(!d)return json(409,{error:'draft_used_or_expired'});
  await ops.audit(d.id,actor,d.tenant_id,'sending');
  if(d.tenant_id==='*'){await ops.queueBroadcast(d);await ops.audit(d.id,actor,'*','queued');return json(200,{state:'queued',id:d.id});}
  const chatId=await store.chatForTenant(d.tenant_id);
  if(!chatId){await ops.audit(d.id,actor,d.tenant_id,'failed');return json(409,{error:'client_not_connected'});}
  try{await tg('sendMessage',{chat_id:chatId,text:'Команда JS Control\n\n'+d.body});await ops.audit(d.id,actor,d.tenant_id,'sent');return json(200,{state:'sent'});}
  catch{await ops.audit(d.id,actor,d.tenant_id,'unknown');return json(502,{error:'delivery_unknown',message:'Проверьте доставку перед новой отправкой.'});}
 }
 return json(404,{error:'not_found'});
}

// Bounded durable broadcast outbox. An uncertain send is never blindly retried.
export async function operationsTick(env,tg){
 const db=env.DB,now=new Date().toISOString();
 await db.prepare("UPDATE admin_deliveries SET state='unknown' WHERE state='sending' AND updated_at<?").bind(new Date(Date.now()-10*60000).toISOString()).run();
 const list=(await db.prepare("SELECT q.id,q.draft_id,q.tenant_id,q.chat_id,d.body FROM admin_deliveries q JOIN admin_drafts d ON d.id=q.draft_id WHERE q.state='pending' ORDER BY q.updated_at,q.id LIMIT 10").all()).results||[];
 for(const d of list){
  const claimed=await db.prepare("UPDATE admin_deliveries SET state='sending',updated_at=? WHERE id=? AND state='pending'").bind(now,d.id).run();if(claimed.meta?.changes!==1)continue;
  // Recheck opt-out at delivery, not just when the draft was confirmed.
  const prefs=await db.prepare('SELECT service_messages FROM settings WHERE tenant_id=?').bind(d.tenant_id).first();let state='skipped';
  if(prefs?.service_messages!==0){try{await tg('sendMessage',{chat_id:d.chat_id,text:'Команда JS Control\n\n'+d.body});state='sent';}catch{state='unknown';}}
  await db.prepare('UPDATE admin_deliveries SET state=?,updated_at=? WHERE id=?').bind(state,new Date().toISOString(),d.id).run();
 }
 await db.prepare("UPDATE admin_drafts SET state='completed' WHERE state='queued' AND NOT EXISTS(SELECT 1 FROM admin_deliveries q WHERE q.draft_id=admin_drafts.id AND q.state IN ('pending','sending'))").run();
}
