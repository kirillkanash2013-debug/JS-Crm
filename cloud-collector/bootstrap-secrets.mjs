import {randomBytes} from 'node:crypto';
const token=process.env.CLOUDFLARE_API_TOKEN,account=process.env.CLOUDFLARE_ACCOUNT_ID;if(!token||!account)throw new Error('Missing Cloudflare deployment credentials');
const endpoint='https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/scripts/js-control-collector-claude/secrets';
const request=async(method,body)=>{const r=await fetch(endpoint,{method,headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await r.json();if(!r.ok||!result.success)throw new Error('Cloudflare secrets API rejected request: HTTP '+r.status);return result.result;};
const current=await request('GET'),names=new Set(current.map(x=>x.name));
for(const name of ['VAULT_KEY','INTERNAL_KEY'])if(!names.has(name)){await request('PUT',{name,type:'secret_text',text:randomBytes(32).toString('base64')});console.log('Configured '+name);}else console.log('Preserved '+name);
console.log(names.has('JS_CONTROL_OWNER_KEY')?'Owner key already configured':'Owner key must be added through Cloudflare dashboard; no public signup is enabled.');
