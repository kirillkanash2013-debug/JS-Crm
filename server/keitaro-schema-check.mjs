// Read-only capability check. Credentials stay in environment, never stdout/files.
import {reportKeitaroNode} from './keitaro.mjs';
const origin=process.env.KEITARO_URL,key=process.env.KEITARO_API_KEY;
const day=process.env.KEITARO_PROBE_DAY,timezone=process.env.KEITARO_TIMEZONE,subIndex=Number(process.env.KEITARO_SUB_INDEX);
if(!origin||!key){console.log(JSON.stringify({result:'not_verified',reason:'credentials_unavailable',live_verified:false}));}
else if(!day||!timezone||!Number.isInteger(subIndex)||subIndex<1||subIndex>30){console.log(JSON.stringify({result:'not_verified',reason:'explicit_probe_context_required',live_verified:false}));process.exitCode=1;}
else {
 const result=await reportKeitaroNode(origin,key,{probe:true,day,timezone,subIndex,budgetMs:20000});
 console.log(JSON.stringify({...result,live_verified:result.result==='ok',checked_at:new Date().toISOString()}));
 if(result.result!=='ok')process.exitCode=1;
}
