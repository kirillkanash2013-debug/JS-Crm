import {randomBytes} from 'node:crypto';
const token=process.env.CLOUDFLARE_API_TOKEN,account=process.env.CLOUDFLARE_ACCOUNT_ID;if(!token||!account)throw new Error('Missing Cloudflare deployment credentials');
const endpoint='https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/scripts/js-control-collector-claude/secrets';
const request=async(method,body)=>{const r=await fetch(endpoint,{method,headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await r.json();if(!r.ok||!result.success)throw new Error('Cloudflare secrets API rejected request: HTTP '+r.status);return result.result;};
const current=await request('GET'),names=new Set(current.map(x=>x.name));
for(const name of ['VAULT_KEY','INTERNAL_KEY'])if(!names.has(name)){await request('PUT',{name,type:'secret_text',text:randomBytes(32).toString('base64')});console.log('Configured '+name);}else console.log('Preserved '+name);
console.log(names.has('JS_CONTROL_OWNER_KEY')?'Owner key already configured':'Owner key must be added through Cloudflare dashboard; no public signup is enabled.');

// Rotate only the deployment smoke credential, never the session encryption key.
const smokeKey=randomBytes(32).toString('base64');
await request('PUT',{name:'DEPLOY_SMOKE_KEY',type:'secret_text',text:smokeKey});
let verified=false;
for(let attempt=0;attempt<12;attempt++){
 try{
  const r=await fetch('https://js-control-collector-claude.kirill-kanash2013.workers.dev/internal/smoke',{method:'POST',headers:{Authorization:'Bearer '+smokeKey},signal:AbortSignal.timeout(60000)});
  const s=await r.json();if(r.ok&&s.ok===true&&s.source==='cloudflare-browser-smoke'&&s.facebookVerified===false){console.log('Cloudflare Chromium smoke passed:',JSON.stringify(s));verified=true;break;}
  console.log('Waiting for browser container, HTTP '+r.status);
 }catch{console.log('Waiting for browser container');}
 await new Promise(r=>setTimeout(r,10000));
}
if(!verified)throw new Error('Cloudflare Chromium smoke did not pass');
