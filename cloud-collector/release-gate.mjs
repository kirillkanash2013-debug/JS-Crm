// Reserved rollout hold. Does not change the operator's PAUSE_JOBS setting.
const {CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:account}=process.env;
const action=process.argv[2];
if(!token||!account||!['hold','release'].includes(action))throw new Error('Missing release credentials or invalid action');
const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/scripts/js-control-collector-claude/secrets',{method:'PUT',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({name:'RELEASE_HOLD',type:'secret_text',text:action==='hold'?'true':'false'}),signal:AbortSignal.timeout(20000)});
const value=await r.json();if(!r.ok||!value.success)throw new Error('Rollout hold update failed (HTTP '+r.status+')');
console.log(action==='hold'?'Collection held during rollout; failure keeps the hold in place.':'Rollout hold released.');
