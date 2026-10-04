import {eventDay,projectDailyFacts} from './history-projection.mjs';
// Source facts are independent of ingestion day and mutable attribution.
const text = v => v == null || String(v).trim() === '' ? null : String(v).trim();
const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : value ?? null);
export async function digest(value) {
 const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)));
 return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export function attribution(campaignId,known) {
 return {campaign_id:campaignId,state:campaignId ? known.has(campaignId) ? 'matched':'unmatched':'unattributed'};
}
export async function normalizeConversions(rows,{subIndex,ingestedAt}) {
 if(!Number.isInteger(subIndex)||subIndex<1||subIndex>30)throw new Error('invalid_sub_index');
 const events=[];
 for(const r of rows) {
  const sourceId=text(r.conversion_id),status=text(r.status)?.toLowerCase()||null;
  const clickId=text(r.sub_id),firstClickAt=text(r.first_click_at??r.click_datetime),conversionAt=text(r.conversion_at??r.postback_datetime);
  // Ingestion time, attribution and payout never enter fallback identity.
  // Insufficient identity is retained in raw evidence but cannot become a countable fact.
  if(!sourceId&&(!clickId||!conversionAt||!status))throw new Error('keitaro_event_identity_unavailable');
  const eventKey=sourceId?'id:'+sourceId:'key:'+await digest({clickId,conversionAt,status,offer:text(r.offer_id??r.offer)});
  const amount=text(r.revenue??r.payout),currency=text(r.revenue!=null?(r.currency??r.revenue_currency):(r.currency??r.payout_currency));
  events.push({event_key:eventKey,source_id:sourceId,campaign_id:text(r['sub_id_'+subIndex]),ingested_at:ingestedAt,
   fact:{status,kind:status==='lead'?'registration':status==='sale'?'ftd':'conversion',click_id:clickId,
    first_click_at:firstClickAt,registration_at:text(r.registration_at)??(status==='lead'?conversionAt:null),
    postback_datetime:text(r.postback_datetime),sale_datetime:text(r.sale_datetime),ftd_at:text(r.ftd_at??r.sale_datetime)??(status==='sale'?conversionAt:null),conversion_at:conversionAt,
    amount:amount!==null&&Number.isFinite(Number(amount))?amount:null,currency,source_payout:{amount:text(r.payout),currency:text(r.payout_currency)},transaction_id:text(r.tid),
    country:text(r.country??r.country_code),payout_source:text(r.payout_source??r.revenue_source),offer_id:text(r.offer_id),offer:text(r.offer),keitaro_campaign_id:text(r.campaign_id)}});
 }
 return events;
}
export const d1History = {
 async recordKeitaroEvidence(tenantId,{source,evidenceId,ingestedAt,context,enc}) {
  await this.db.prepare('INSERT OR IGNORE INTO keitaro_evidence VALUES(?,?,?,?,?,?)').bind(tenantId,source,evidenceId,ingestedAt,JSON.stringify(context),enc).run();
 },
 async ingestKeitaroEvents(tenantId,{source,evidenceId,events,knownCampaignIds,ingestedAt,observedAt=ingestedAt,observationId=evidenceId}) {
  for(let i=0;i<knownCampaignIds.length;i+=50)await this.db.batch(knownCampaignIds.slice(i,i+50).map(id=>this.db.prepare('INSERT OR IGNORE INTO keitaro_known_campaigns VALUES(?,?,?)').bind(tenantId,String(id),observedAt)));
  // Transactions and bind counts are bounded. Overlapping windows never increment counters.
  for(let i=0;i<events.length;i+=20){
   const statements=[];
   for(const e of events.slice(i,i+20)){
    statements.push(this.db.prepare('INSERT INTO keitaro_events(tenant_id,source,event_key,source_id,evidence_id,ingested_at,fact,observed_at,event_day) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,source,event_key) DO UPDATE SET evidence_id=excluded.evidence_id,fact=excluded.fact,observed_at=excluded.observed_at,event_day=excluded.event_day WHERE (excluded.observed_at>=keitaro_events.observed_at OR keitaro_events.observed_at IS NULL) AND NOT EXISTS(SELECT 1 FROM keitaro_observation_history WHERE tenant_id=? AND source=? AND event_key=? AND observation_id=?)').bind(tenantId,source,e.event_key,e.source_id,evidenceId,e.ingested_at,JSON.stringify(e.fact),observedAt,eventDay(e.fact),tenantId,source,e.event_key,observationId));
    statements.push(this.db.prepare("INSERT INTO keitaro_attribution SELECT ?,?,?,?,CASE WHEN ? IS NULL THEN 'unattributed' WHEN EXISTS(SELECT 1 FROM keitaro_known_campaigns WHERE tenant_id=? AND campaign_id=?) THEN 'matched' ELSE 'unmatched' END,? ON CONFLICT(tenant_id,source,event_key) DO UPDATE SET campaign_id=excluded.campaign_id,state=excluded.state,updated_at=MAX(excluded.updated_at,keitaro_attribution.updated_at) WHERE excluded.campaign_id IS NOT NULL AND EXISTS(SELECT 1 FROM keitaro_events WHERE tenant_id=? AND source=? AND event_key=? AND observed_at=?) AND NOT EXISTS(SELECT 1 FROM keitaro_observation_history WHERE tenant_id=? AND source=? AND event_key=? AND observation_id=?)").bind(tenantId,source,e.event_key,e.campaign_id,e.campaign_id,tenantId,e.campaign_id,observedAt,tenantId,source,e.event_key,observedAt,tenantId,source,e.event_key,observationId));
    statements.push(this.db.prepare('INSERT OR IGNORE INTO keitaro_event_observations VALUES(?,?,?,?,?,?)').bind(tenantId,source,e.event_key,evidenceId,observedAt,JSON.stringify(e.fact)));
    statements.push(this.db.prepare('INSERT OR IGNORE INTO keitaro_observation_history VALUES(?,?,?,?,?,?,?,?)').bind(tenantId,source,e.event_key,observationId,evidenceId,observedAt,JSON.stringify(e.fact),e.campaign_id));
   }
   await this.db.batch(statements);
  }
  await this.db.prepare("UPDATE keitaro_attribution SET state='matched',updated_at=MAX(updated_at,?) WHERE tenant_id=? AND source=? AND state='unmatched' AND campaign_id IN(SELECT campaign_id FROM keitaro_known_campaigns WHERE tenant_id=?)").bind(observedAt,tenantId,source,tenantId).run();
 },
 async historicalKeitaroEvents(tenantId,source,range={}) {
  const where=range.from&&range.to?' AND (e.event_day BETWEEN ? AND ? OR e.event_day IS NULL)':'';
  const args=range.from&&range.to?[tenantId,source,range.from,range.to]:[tenantId,source];
  const r=await this.db.prepare('SELECT e.*,a.campaign_id,a.state FROM keitaro_events e JOIN keitaro_attribution a USING(tenant_id,source,event_key) WHERE e.tenant_id=? AND e.source=?'+where+' ORDER BY e.event_key LIMIT 50001').bind(...args).all();
  if((r.results||[]).length>50000)throw new Error('historical_projection_limit');
  return (r.results||[]).map(r=>({...r,fact:JSON.parse(r.fact)}));
 },
 async historicalDailyFacts(tenantId,source,range) {return projectDailyFacts(await this.historicalKeitaroEvents(tenantId,source,range),range);},
 async historicalObservations(tenantId,source,eventKey) {
  const r=await this.db.prepare('SELECT * FROM keitaro_observation_history WHERE tenant_id=? AND source=? AND event_key=? ORDER BY observed_at,observation_id LIMIT 1001').bind(tenantId,source,eventKey).all();
  if((r.results||[]).length>1000)throw new Error('observation_history_limit');
  return (r.results||[]).map(r=>({...r,fact:JSON.parse(r.fact)}));
 },
 async claimKeitaroHistory(tenantId,source,owner,nowMs) {
  const r=await this.db.prepare('INSERT INTO keitaro_history_state(tenant_id,source,lease_owner,lease_until) VALUES(?,?,?,?) ON CONFLICT(tenant_id,source) DO UPDATE SET lease_owner=excluded.lease_owner,lease_until=excluded.lease_until WHERE keitaro_history_state.lease_until<? AND (keitaro_history_state.last_success_at IS NULL OR keitaro_history_state.last_success_at<?)').bind(tenantId,source,owner,nowMs+60000,nowMs,new Date(nowMs-15*60000).toISOString()).run();return r.meta?.changes===1;
 },
 async keitaroHistoryState(tenantId,source) {return this.db.prepare('SELECT * FROM keitaro_history_state WHERE tenant_id=? AND source=?').bind(tenantId,source).first();},
 async completeKeitaroHistoryWindow(tenantId,source,owner,{cursorDay,window,completedAt},nowMs) {
  const r=await this.db.prepare("UPDATE keitaro_history_state SET cursor_day=?,last_window=?,last_result='complete',last_error=NULL,last_success_at=? WHERE tenant_id=? AND source=? AND lease_owner=? AND lease_until>?").bind(cursorDay,JSON.stringify(window),completedAt,tenantId,source,owner,nowMs).run();return r.meta?.changes===1;
 },
 async releaseKeitaroHistory(tenantId,source,owner,error=null) {
  await this.db.prepare("UPDATE keitaro_history_state SET lease_owner=NULL,lease_until=0,last_result=CASE WHEN ? IS NULL THEN last_result ELSE 'incomplete' END,last_error=? WHERE tenant_id=? AND source=? AND lease_owner=?").bind(error,error,tenantId,source,owner).run();
 },
 async saveKeitaroCapabilities(tenantId,source,owner,profile,checkedAt,nowMs) {
  const r=await this.db.prepare('UPDATE keitaro_history_state SET capabilities=?,capabilities_checked_at=? WHERE tenant_id=? AND source=? AND lease_owner=? AND lease_until>?').bind(JSON.stringify(profile),checkedAt,tenantId,source,owner,nowMs).run();return r.meta?.changes===1;
 },
 async publishedSnapshot(tenantId,cycleId) {return this.db.prepare('SELECT enc,completed_at AS completedAt,source_times FROM stats_snapshot_history WHERE tenant_id=? AND cycle_id=?').bind(tenantId,cycleId).first();}
};
export const memoryHistory = {
 async recordKeitaroEvidence(tenantId,b) {this.evidence??=new Map();const k=JSON.stringify([tenantId,b.source,b.evidenceId]);if(!this.evidence.has(k))this.evidence.set(k,structuredClone(b));},
 async ingestKeitaroEvents(tenantId,b) {
  this.events??=new Map();this.knownCampaigns??=new Map();this.observations??=new Map();
  const known=this.knownCampaigns.get(tenantId)||new Set();b.knownCampaignIds.forEach(id=>known.add(String(id)));this.knownCampaigns.set(tenantId,known);
  const observedAt=b.observedAt||b.ingestedAt,observationId=b.observationId||b.evidenceId;
  for(const e of b.events){
   const k=JSON.stringify([tenantId,b.source,e.event_key]),old=this.events.get(k),ok=JSON.stringify([tenantId,b.source,e.event_key,observationId]);
   if(this.observations.has(ok))continue;
   if(!old)this.events.set(k,{tenant_id:tenantId,source:b.source,...structuredClone(e),evidence_id:b.evidenceId,observed_at:observedAt,event_day:eventDay(e.fact),updated_at:observedAt,...attribution(e.campaign_id,known)});
   else if(observedAt>=old.observed_at){old.fact=structuredClone(e.fact);old.evidence_id=b.evidenceId;old.observed_at=observedAt;old.event_day=eventDay(e.fact);if(e.campaign_id){Object.assign(old,attribution(e.campaign_id,known));old.updated_at=observedAt;}}
   else if(observedAt===old.observed_at&&e.campaign_id){Object.assign(old,attribution(e.campaign_id,known));old.updated_at=observedAt;}
   if(!this.observations.has(ok))this.observations.set(ok,{tenant_id:tenantId,source:b.source,event_key:e.event_key,observation_id:observationId,evidence_id:b.evidenceId,observed_at:observedAt,fact:structuredClone(e.fact),campaign_id:e.campaign_id});
  }
  for(const e of this.events.values())if(e.tenant_id===tenantId&&e.source===b.source&&e.state==='unmatched'&&known.has(e.campaign_id))e.state='matched';
 },
 async historicalKeitaroEvents(tenantId,source,range={}) {return structuredClone([...this.events?.values()||[]].filter(e=>e.tenant_id===tenantId&&e.source===source&&(!range.from||!range.to||!e.event_day||e.event_day>=range.from&&e.event_day<=range.to)));},
 async historicalDailyFacts(tenantId,source,range) {return projectDailyFacts(await this.historicalKeitaroEvents(tenantId,source,range),range);},
 async historicalObservations(tenantId,source,eventKey) {return structuredClone([...this.observations?.values()||[]].filter(e=>e.tenant_id===tenantId&&e.source===source&&e.event_key===eventKey));},
 async claimKeitaroHistory(tenantId,source,owner,nowMs) {
  this.historyStates??=new Map();const k=JSON.stringify([tenantId,source]),s=this.historyStates.get(k)||{};
  if(s.lease_until>=nowMs||s.last_success_at&&Date.parse(s.last_success_at)>=nowMs-15*60000)return false;
  this.historyStates.set(k,{...s,lease_owner:owner,lease_until:nowMs+60000});return true;
 },
 async keitaroHistoryState(tenantId,source) {return structuredClone(this.historyStates?.get(JSON.stringify([tenantId,source]))||null);},
 async completeKeitaroHistoryWindow(tenantId,source,owner,{cursorDay,window,completedAt},nowMs) {
  const s=this.historyStates?.get(JSON.stringify([tenantId,source]));if(s?.lease_owner!==owner||s.lease_until<=nowMs)return false;Object.assign(s,{cursor_day:cursorDay,last_window:JSON.stringify(window),last_success_at:completedAt,last_result:'complete',last_error:null});return true;
 },
 async releaseKeitaroHistory(tenantId,source,owner,error=null) {const s=this.historyStates?.get(JSON.stringify([tenantId,source]));if(s?.lease_owner===owner)Object.assign(s,{lease_owner:null,lease_until:0,...error?{last_result:'incomplete',last_error:error}:{}});},
 async saveKeitaroCapabilities(tenantId,source,owner,profile,checkedAt,nowMs) {const s=this.historyStates?.get(JSON.stringify([tenantId,source]));if(s?.lease_owner!==owner||s.lease_until<=nowMs)return false;Object.assign(s,{capabilities:JSON.stringify(profile),capabilities_checked_at:checkedAt});return true;},
 async publishedSnapshot(tenantId,cycleId) {return structuredClone(this.snapshotHistory?.get(JSON.stringify([tenantId,cycleId]))||null);}
};
