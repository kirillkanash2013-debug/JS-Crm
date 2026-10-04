import {digest,normalizeConversions} from './history.mjs';
import {sealSecret} from './secrets.mjs';
const shift=(day,n)=>{const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
export function historyWindows(day,cursorDay) {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||shift(day,0)!==day)throw new Error('invalid_history_day');
 const recentFrom=shift(day,-6),floor=shift(day,-179);
 const cursor=cursorDay&&cursorDay>=floor&&cursorDay<recentFrom?cursorDay:shift(recentFrom,-1);
 const backfillFrom=cursor>shift(floor,6)?shift(cursor,-6):floor;
 // Consecutive archive windows share one day. At the floor, restart the bounded sweep.
 const nextCursor=backfillFrom===floor?shift(recentFrom,-1):backfillFrom;
 return [{kind:'lookback',from:recentFrom,to:day,cursorDay:cursor},{kind:'backfill',from:backfillFrom,to:cursor,cursorDay:nextCursor}];
}
export async function persistSourceConversions({store,tenantId,source,response,context,masterKey,knownCampaignIds,observedAt,observationId=crypto.randomUUID(),guard=()=>{}}) {
 guard();
 const ingestedAt=new Date().toISOString(),evidenceId=await digest({response,context});
 await store.recordKeitaroEvidence(tenantId,{source,evidenceId,ingestedAt,context,enc:await sealSecret(masterKey,tenantId,JSON.stringify(response))});
 const events=await normalizeConversions(response.conversions||[],{subIndex:context.subIndex,ingestedAt});
 await store.ingestKeitaroEvents(tenantId,{source,evidenceId,events,knownCampaignIds,ingestedAt,observedAt:observedAt||ingestedAt,observationId,guard});
 return {events,evidenceId,ingestedAt};
}
// Independent post-publication work. Partial batches checkpoint only persisted rows.
export async function runHistoricalIngestion({store,tenantId,source,day,timezone,subIndex,masterKey,knownCampaignIds,fetchReport,clock=Date.now}) {
 const owner=crypto.randomUUID(),started=clock(),deadline=started+25000;
 if(!await store.claimKeitaroHistory(tenantId,source,owner,started))return {result:'busy_or_cooldown'};
 let error=null;
 try {
  let state=await store.keitaroHistoryState(tenantId,source);
  // Pinned ranges survive day rollover and reload; never replace an unfinished archive.
  let pending=state.continuation?JSON.parse(state.continuation):historyWindows(day,state.cursor_day).map(w=>({...w,timezone,subIndex,offset:0,anchor:null}));
  // A changed join/timezone needs a fresh read of the same ranges, not a cursor skip.
  pending=pending.map(w=>w.subIndex!==subIndex||w.timezone!==timezone?{...w,subIndex,timezone,offset:0,anchor:null}:w);
  if(!await store.checkpointKeitaroHistory(tenantId,source,owner,pending,clock()))throw new Error('history_lease_lost');
  let profile=state.capabilities?JSON.parse(state.capabilities):null;
  if(!profile||profile.subIndex!==subIndex||!state.capabilities_checked_at||state.capabilities_checked_at.slice(0,10)!==day){
   const observedAt=new Date(clock()).toISOString();
   const probe=await fetchReport({probe:true,day,timezone,subIndex,budgetMs:Math.min(5000,deadline-clock())});
   profile={...probe,subIndex};
   if(!await store.saveKeitaroCapabilities(tenantId,source,owner,profile,observedAt,clock()))throw new Error('history_lease_lost');
  }
  const extraColumns=Object.entries(profile?.columns||{}).filter(([field,status])=>status==='accepted'&&['sale_datetime','country_code','currency','revenue_currency','payout_currency','tid'].includes(field)).map(([field])=>field);
  const completed=[];
  // At most two bounded batches per invocation. Incomplete windows resume next refresh.
  for(let batch=0;batch<2&&pending.length;batch++){
   const window=pending[0],remaining=deadline-clock();if(remaining<=5000)throw new Error('history_deadline');
   const observedAt=new Date(clock()).toISOString(),context={from:window.from,to:window.to,timezone:window.timezone,subIndex:window.subIndex,kind:window.kind,startOffset:window.offset};
   const response=await fetchReport({...context,conversionsOnly:true,resume:true,anchor:window.anchor,pageLimit:250,maxPages:4,budgetMs:Math.min(10000,remaining-5000),extraColumns});
   if(response?.complete===true&&response.result!=='ok'||!['ok','incomplete'].includes(response?.result)||!Array.isArray(response.conversions))throw new Error('history_source_incomplete');
   if(response.reason==='checkpoint_boundary_changed'){
    pending[0]={...window,offset:0,anchor:null};
    if(!await store.checkpointKeitaroHistory(tenantId,source,owner,pending,clock()))throw new Error('history_lease_lost');
    throw new Error('history_boundary_changed');
   }
   const nextOffset=response.nextOffset??(response.complete===true?window.offset+response.conversions.length:null);
   if(!Number.isSafeInteger(nextOffset)||nextOffset!==window.offset+response.conversions.length||nextOffset<window.offset||response.conversions.length>1000||nextOffset>0&&response.complete!==true&&typeof response.anchor!=='string')throw new Error('history_invalid_checkpoint');
   // Interrupted persistence may replay a batch, but its source identities never increment counters.
   await persistSourceConversions({store,tenantId,source,response,context,masterKey,knownCampaignIds,observedAt,observationId:owner+':'+batch,guard:()=>{if(clock()>=deadline)throw new Error('history_deadline');}});
   if(clock()>=deadline)throw new Error('history_deadline');
   if(response.complete!==true){
    pending[0]={...window,offset:nextOffset,anchor:response.anchor??window.anchor};
    if(!await store.checkpointKeitaroHistory(tenantId,source,owner,pending,clock()))throw new Error('history_lease_lost');
    throw new Error(response.reason==='report_deadline'?'history_deadline':'history_source_incomplete');
   }
   pending=pending.slice(1);
   if(!await store.completeKeitaroHistoryWindow(tenantId,source,owner,{cursorDay:window.kind==='backfill'?window.cursorDay:null,window:context,continuation:pending.length?pending:null,completedAt:new Date(clock()).toISOString()},clock()))throw new Error('history_lease_lost');
   completed.push(context);
  }
  return {result:'complete',windows:completed};
 }catch(e){
  error=['history_deadline','history_lease_lost','history_source_incomplete','history_boundary_changed','history_invalid_checkpoint','keitaro_event_identity_unavailable'].includes(e.message)?e.message:'history_ingestion_failed';
  return {result:'incomplete',reason:error};
 }finally{await store.releaseKeitaroHistory(tenantId,source,owner,error);}
}
