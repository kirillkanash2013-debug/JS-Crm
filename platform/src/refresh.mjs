import {openSecret} from './secrets.mjs';
// Wake even a legacy collector whose pre-Phase-1 expiry cleared its last alarm.
// Payment remains idempotent; a failed wake can be retried with the same payment.
export async function resumeCollection(store,env,tenantId){
 if(!env.MASTER_KEY||(!env.COLLECTOR&&!env.COLLECTOR_URL))return;
 const t=await store.tenant(tenantId);if(!t?.integrationTokenEnc)return;
 const token=await openSecret(env.MASTER_KEY,tenantId,t.integrationTokenEnc);
 const url=String(env.COLLECTOR_URL||'https://collector.internal').replace(/\/+$/,'')+'/v1/subscription/resume';
 const init={method:'POST',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'};
 const r=env.COLLECTOR?await env.COLLECTOR.fetch(url,init):await fetch(url,init);
 if(!r.ok)throw new Error('scheduler_resume_failed');
}
