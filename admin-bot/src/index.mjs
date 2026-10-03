import {DurableObject} from 'cloudflare:workers';
import {adminRoute} from './http.mjs';
import {createAdminBot} from './bot.mjs';
import {secureEqual} from '../../platform/src/operations.mjs';
export class AdminInbox extends DurableObject {
 constructor(ctx,env){super(ctx,env);ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS updates(id INTEGER PRIMARY KEY,state TEXT,lease_until INTEGER)');}
 async fetch(request){
  if(!await secureEqual(request.headers.get('x-admin-internal'),this.env.ADMIN_WEBHOOK_SECRET))return new Response('',{status:401});
  const update=await request.json(),id=update.update_id;
  this.ctx.storage.sql.exec("DELETE FROM updates WHERE state='done' AND lease_until<?",Date.now()-30*864e5);
  const claimed=await this.ctx.blockConcurrencyWhile(async()=>this.ctx.storage.sql.exec("INSERT INTO updates(id,state,lease_until) VALUES(?,'processing',?) ON CONFLICT(id) DO UPDATE SET state='processing',lease_until=excluded.lease_until WHERE updates.state!='done' AND updates.lease_until<?",id,Date.now()+300000,Date.now()).rowsWritten);
  if(!claimed)return Response.json({ok:true,duplicate:true});
  const tg=async(method,payload)=>{const r=await fetch('https://api.telegram.org/bot'+this.env.ADMIN_BOT_TOKEN+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});const body=await r.json();if(!body.ok)throw new Error('telegram_failed');return body.result;};
  const api=async(actor,path,body)=>{
   if(!this.env.ADMIN_API_KEY||!this.env.PLATFORM)throw new Error('setup_required');
   const r=await this.env.PLATFORM.fetch(new Request('https://platform/internal/admin/'+path,{method:'POST',headers:{authorization:'Bearer '+this.env.ADMIN_API_KEY,'x-admin-actor':actor,'content-type':'application/json'},body:JSON.stringify(body)}));
   const value=await r.json();if(!r.ok){const e=new Error('operation_failed');e.code=value.error==='delivery_unknown'?'delivery_unknown':'operation_failed';throw e;}return value;
  };
  try{await createAdminBot({tg,api})(update);this.ctx.storage.sql.exec("UPDATE updates SET state='done',lease_until=? WHERE id=?",Date.now(),id);return Response.json({ok:true});}
  catch{this.ctx.storage.sql.exec("UPDATE updates SET state='failed',lease_until=0 WHERE id=?",id);return Response.json({error:'operation_failed'},{status:503});}
 }
}
export default {fetch:adminRoute};
