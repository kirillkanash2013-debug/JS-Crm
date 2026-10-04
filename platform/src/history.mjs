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
  const amount=text(r.revenue??r.payout);
  events.push({event_key:eventKey,source_id:sourceId,campaign_id:text(r['sub_id_'+subIndex]),ingested_at:ingestedAt,
   fact:{status,kind:status==='lead'?'registration':status==='sale'?'ftd':'conversion',click_id:clickId,
    first_click_at:firstClickAt,registration_at:text(r.registration_at)??(status==='lead'?conversionAt:null),
    ftd_at:text(r.ftd_at)??(status==='sale'?conversionAt:null),conversion_at:conversionAt,
    amount:amount!==null&&Number.isFinite(Number(amount))?amount:null,currency:text(r.currency??r.revenue_currency??r.payout_currency),
    country:text(r.country??r.country_code),payout_source:text(r.payout_source??r.revenue_source),offer_id:text(r.offer_id),offer:text(r.offer),keitaro_campaign_id:text(r.campaign_id)}});
 }
 return events;
}
export const d1History = {
 async recordKeitaroEvidence(tenantId,{source,evidenceId,ingestedAt,context,enc}) {
  await this.db.prepare('INSERT OR IGNORE INTO keitaro_evidence VALUES(?,?,?,?,?,?)').bind(tenantId,source,evidenceId,ingestedAt,JSON.stringify(context),enc).run();
 },
 async ingestKeitaroEvents(tenantId,{source,evidenceId,events,knownCampaignIds,ingestedAt}) {
  const known=new Set(knownCampaignIds.map(String));
  // Bounded transactions: a report can exceed D1's statement limit. Retrying is safe.
  for(let i=0;i<events.length;i+=25) {
   const statements=[];
   for(const e of events.slice(i,i+25)) {
    const a=attribution(e.campaign_id,known);
    statements.push(this.db.prepare('INSERT INTO keitaro_events VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,source,event_key) DO UPDATE SET evidence_id=excluded.evidence_id,fact=excluded.fact').bind(tenantId,source,e.event_key,e.source_id,evidenceId,e.ingested_at,JSON.stringify(e.fact)));
    statements.push(this.db.prepare("INSERT INTO keitaro_attribution VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,source,event_key) DO UPDATE SET campaign_id=excluded.campaign_id,state=CASE WHEN keitaro_attribution.campaign_id=excluded.campaign_id AND keitaro_attribution.state='matched' THEN 'matched' ELSE excluded.state END,updated_at=excluded.updated_at WHERE excluded.campaign_id IS NOT NULL").bind(tenantId,source,e.event_key,a.campaign_id,a.state,ingestedAt));
    statements.push(this.db.prepare('INSERT OR IGNORE INTO keitaro_event_observations VALUES(?,?,?,?,?,?)').bind(tenantId,source,e.event_key,evidenceId,ingestedAt,JSON.stringify(e.fact)));
   }
   await this.db.batch(statements);
  }
  // A later Meta generation can match old events even when absent from today's log.
  for(const id of known)await this.db.prepare("UPDATE keitaro_attribution SET state='matched',updated_at=? WHERE tenant_id=? AND source=? AND campaign_id=? AND state='unmatched'").bind(ingestedAt,tenantId,source,id).run();
 },
 async historicalKeitaroEvents(tenantId,source) {
  const r=await this.db.prepare('SELECT e.*,a.campaign_id,a.state FROM keitaro_events e JOIN keitaro_attribution a USING(tenant_id,source,event_key) WHERE e.tenant_id=? AND e.source=? ORDER BY e.event_key').bind(tenantId,source).all();
  return (r.results||[]).map(r=>({...r,fact:JSON.parse(r.fact)}));
 },
 async publishedSnapshot(tenantId,cycleId) {return this.db.prepare('SELECT enc,completed_at AS completedAt,source_times FROM stats_snapshot_history WHERE tenant_id=? AND cycle_id=?').bind(tenantId,cycleId).first();}
};
export const memoryHistory = {
 async recordKeitaroEvidence(tenantId,b) {this.evidence??=new Map();const k=JSON.stringify([tenantId,b.source,b.evidenceId]);if(!this.evidence.has(k))this.evidence.set(k,structuredClone(b));},
 async ingestKeitaroEvents(tenantId,b) {
  this.events??=new Map();const known=new Set(b.knownCampaignIds.map(String));
  for(const e of b.events){const k=JSON.stringify([tenantId,b.source,e.event_key]),old=this.events.get(k);if(!old)this.events.set(k,{tenant_id:tenantId,source:b.source,...structuredClone(e),...attribution(e.campaign_id,known)});else {old.fact=structuredClone(e.fact);if(e.campaign_id){const a=attribution(e.campaign_id,known);if(old.campaign_id===e.campaign_id&&old.state==='matched')a.state='matched';Object.assign(old,a);}}}
  for(const e of this.events.values())if(e.tenant_id===tenantId&&e.source===b.source&&e.state==='unmatched'&&known.has(e.campaign_id))e.state='matched';
 },
 async historicalKeitaroEvents(tenantId,source) {return structuredClone([...this.events?.values()||[]].filter(e=>e.tenant_id===tenantId&&e.source===source));},
 async publishedSnapshot(tenantId,cycleId) {return structuredClone(this.snapshotHistory?.get(JSON.stringify([tenantId,cycleId]))||null);}
};
