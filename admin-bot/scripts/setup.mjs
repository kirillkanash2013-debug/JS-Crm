// Run only during an explicitly enabled deployment. Never print credentials.
import {randomBytes,createHmac} from 'node:crypto';
const {CLOUDFLARE_API_TOKEN:cf,CLOUDFLARE_ACCOUNT_ID:account,ADMIN_BOT_TOKEN:bot,TELEGRAM_BOT_TOKEN:clientBot}=process.env;
if(!cf||!account||!bot)throw new Error('Missing deployment credentials or ADMIN_BOT_TOKEN');
if(bot===clientBot)throw new Error('Administrative bot must have a separate BotFather token');
const url=process.env.ADMIN_BOT_URL||'https://js-control-admin.kirill-kanash2013.workers.dev';
const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.pathname!=='/'||parsed.search||parsed.hash||parsed.username||parsed.password)throw new Error('ADMIN_BOT_URL must be an HTTPS origin');
async function telegram(method,body){
 const r=await fetch('https://api.telegram.org/bot'+bot+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const value=await r.json();if(!r.ok||!value.ok)throw new Error('Telegram rejected '+method+'; check the administrative bot token');return value.result;
}
async function secrets(worker,method='GET',body){
 const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/scripts/'+worker+'/secrets',{method,headers:{authorization:'Bearer '+cf,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
 const value=await r.json();if(!r.ok||!value.success)throw new Error('Cloudflare secret operation failed for '+worker+' (HTTP '+r.status+')');return value.result;
}
const put=(worker,name,text)=>secrets(worker,'PUT',{name,type:'secret_text',text});
async function sharedKey(a,b){
 const [x,y]=await Promise.all([secrets(a[0]),secrets(b[0])]);
 const hasA=x.some(s=>s.name===a[1]),hasB=y.some(s=>s.name===b[1]);
 if(hasA!==hasB)throw new Error('Partial key setup: restore the same key on '+a.join('/')+' and '+b.join('/')+'; existing secrets were preserved');
 if(hasA){console.log('Preserved shared key '+a[1]);return;}
 const key=randomBytes(32).toString('hex');
 await put(...a,key);await put(...b,key);
 console.log('Configured shared key '+a[1]);
}
await telegram('getMe',{});
await sharedKey(['js-control-platform','ADMIN_API_KEY'],['js-control-admin','ADMIN_API_KEY']);
await sharedKey(['js-control-collector-claude','OPERATIONS_KEY'],['js-control-platform','COLLECTOR_OPERATIONS_KEY']);
// Stable for this bot token; unrelated to client encryption keys.
const webhookSecret=createHmac('sha256',bot).update('js-control-admin-webhook-v1').digest('hex');
await put('js-control-admin','ADMIN_BOT_TOKEN',bot);
await put('js-control-admin','ADMIN_WEBHOOK_SECRET',webhookSecret);
await telegram('setWebhook',{url:parsed.origin+'/telegram',secret_token:webhookSecret,allowed_updates:['message','callback_query'],drop_pending_updates:false});
console.log('Administrative bot webhook configured. Client encryption keys were preserved.');
