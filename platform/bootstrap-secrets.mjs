// Fail closed on a failed secret inventory: it must never look like a new app.
import {randomBytes,createHmac} from 'node:crypto';
const {CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:account,BOT_TOKEN:bot}=process.env;
if(!token||!account||!bot)throw new Error('Missing platform deployment credentials');
const endpoint='https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/scripts/js-control-platform/secrets';
async function request(method,body){
 const r=await fetch(endpoint,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
 const value=await r.json();if(!r.ok||!value.success)throw new Error('Cloudflare secrets API rejected request (HTTP '+r.status+')');return value.result;
}
const names=new Set((await request('GET')).map(s=>s.name));
for(const name of ['MASTER_KEY','BILLING_WEBHOOK_SECRET']){
 if(names.has(name)){console.log('Preserved '+name);continue;}
 await request('PUT',{name,type:'secret_text',text:randomBytes(32).toString('base64')});console.log('Configured '+name);
}
await request('PUT',{name:'TELEGRAM_BOT_TOKEN',type:'secret_text',text:bot});
const secret=createHmac('sha256',bot).update('js-control-client-webhook-v1').digest('hex');
await request('PUT',{name:'TELEGRAM_WEBHOOK_SECRET',type:'secret_text',text:secret});
const r=await fetch('https://api.telegram.org/bot'+bot+'/setWebhook',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://js-control-platform.kirill-kanash2013.workers.dev/telegram',secret_token:secret,drop_pending_updates:false,allowed_updates:['message','callback_query','pre_checkout_query']}),signal:AbortSignal.timeout(20000)});
const value=await r.json();if(!r.ok||!value.ok)throw new Error('Telegram rejected platform webhook setup');
console.log('Platform webhook configured; existing encryption key preserved.');
