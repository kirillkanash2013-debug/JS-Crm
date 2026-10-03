import {secureEqual} from '../../platform/src/operations.mjs';
export async function adminRoute(request,env){
 const json=(status,body)=>Response.json(body,{status,headers:{'cache-control':'no-store'}}),path=new URL(request.url).pathname;
 if(request.method==='GET'&&path==='/health')return json(200,{ok:true,service:'js-control-admin',version:'1'});
 if(request.method!=='POST'||path!=='/telegram')return json(404,{error:'not_found'});
 if(!env.ADMIN_WEBHOOK_SECRET||!await secureEqual(request.headers.get('x-telegram-bot-api-secret-token'),env.ADMIN_WEBHOOK_SECRET))return json(401,{error:'unauthorized'});
 const raw=await request.text();if(raw.length>20000)return json(413,{error:'too_large'});let u;try{u=JSON.parse(raw);}catch{return json(400,{error:'invalid_json'});}
 const msg=u.message||u.callback_query?.message,actor=u.message?.from?.id||u.callback_query?.from?.id;
 if(msg?.chat?.type!=='private'||String(msg.chat.id)!==String(actor)||!String(env.ADMIN_CHAT_IDS||'').split(',').map(s=>s.trim()).includes(String(actor)))return json(403,{error:'forbidden'});
 if(!Number.isSafeInteger(u.update_id))return json(400,{error:'update_id_required'});
 return env.INBOX.getByName('inbox').fetch(new Request('http://internal/update',{method:'POST',headers:{'x-admin-internal':env.ADMIN_WEBHOOK_SECRET},body:JSON.stringify(u)}));
}
