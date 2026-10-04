import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {D1Store,MemoryStore} from '../src/store.mjs';
import {normalizeConversions} from '../src/history.mjs';
import {aggregateKeitaro} from '../src/today.mjs';
function setup(){
 const db=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())db.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const api={prepare(sql){let a=[];const s={bind(...args){a=args;return s;},async run(){return {meta:{changes:db.prepare(sql).run(...a).changes}};},async first(){return db.prepare(sql).get(...a)||null;},async all(){return {results:db.prepare(sql).all(...a)};}};return s;},async batch(ss){db.exec('BEGIN');try{for(const s of ss)await s.run();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}};return {db,store:new D1Store(api)};
}
const row={conversion_id:'c1',sub_id:'click',sub_id_7:'777',status:'sale',click_datetime:'2026-09-29 23:00:00',postback_datetime:'2026-10-01 01:00:00',revenue:'45.10',currency:'EUR',country:'KG'};
const at='2026-10-04T00:00:00Z';
for(const mode of ['D1','memory'])test(mode+': duplicate ingestion, late events, re-attribution and tenant/source isolation',async()=>{
 const store=mode==='D1'?setup().store:new MemoryStore();
 await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});
 const ingest=async(rows,known=[],source='https://k.test')=>{
  const events=await normalizeConversions(rows,{subIndex:7,ingestedAt:at});
  await store.recordKeitaroEvidence('t',{source,evidenceId:'ev',ingestedAt:at,context:{subIndex:7},enc:'encrypted'});
  await store.ingestKeitaroEvents('t',{source,evidenceId:'ev',events,knownCampaignIds:known,ingestedAt:at});
  return store.historicalKeitaroEvents('t',source);
 };
 let events=await ingest([row,row]);assert.equal(events.length,1);assert.equal(events[0].state,'unmatched');assert.equal(events[0].fact.ftd_at,row.postback_datetime);assert.equal(events[0].fact.first_click_at,row.click_datetime);assert.equal(events[0].fact.amount,'45.10');assert.equal(events[0].fact.currency,'EUR');assert.equal(events[0].fact.country,'KG');
 events=await ingest([],['777']);assert.equal(events.length,1);assert.equal(events[0].state,'matched');assert.equal(events[0].fact.amount,'45.10');
 events=await ingest([{...row,conversion_id:'late',postback_datetime:'2026-09-30 02:00:00',sub_id_7:null}]);assert.equal(events.length,2);assert.equal(events.find(e=>e.source_id==='late').state,'unattributed');
 events=await ingest([{...row,conversion_id:'late'}],['777']);assert.equal(events.length,2);assert.equal(events.find(e=>e.source_id==='late').state,'matched');
 assert.equal((await ingest([row],[],'https://other.test')).length,1);
 assert.equal((await store.historicalKeitaroEvents('other','https://k.test')).length,0);
});
test('fallback identity ignores payout and attribution; unknown money stays null; insufficient identity fails',async()=>{
 const original={...row,conversion_id:null,revenue:null,currency:null};
 const [a]=await normalizeConversions([original],{subIndex:7,ingestedAt:at});
 const [b]=await normalizeConversions([{...original,sub_id_7:'888',revenue:100}],{subIndex:7,ingestedAt:'later'});
 assert.equal(a.event_key,b.event_key);assert.equal(a.fact.amount,null);assert.equal(a.fact.currency,null);
 const [zero]=await normalizeConversions([{...original,revenue:0}],{subIndex:7,ingestedAt:at});assert.equal(zero.fact.amount,'0');
 await assert.rejects(normalizeConversions([{status:'sale'}],{subIndex:7,ingestedAt:at}),/identity_unavailable/);
 const [reg]=await normalizeConversions([{...row,status:'lead'}],{subIndex:7,ingestedAt:at});assert.equal(reg.fact.registration_at,row.postback_datetime);assert.equal(reg.fact.ftd_at,null);
});
test('day rollover is not долёт; absent campaign ID is долёт; unmatched retains campaign ID',()=>{
 const agg=aggregateKeitaro({conversions:[row,{...row,sub_id_7:null}]},{subIndex:7,day:'2026-10-04'});
 assert.equal(agg.totals.dep,1);assert.equal(agg.totals.doletDep,1);assert.equal(agg.byCampaign['777'].rev,45.1);
});
test('D1 immutable snapshots retain old payload; failure rolls back pointer, receipt and history',async()=>{
 const {db,store}=setup();await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});await store.claimStatsCycle('t','o');
 const p={owner:'o',enc:'structured-encrypted-1',completedAt:at,sourceTimes:{social:'gen'}};
 await store.commitStatsPublication('t',{...p,cycle_id:'one'});
 await store.commitStatsPublication('t',{...p,enc:'structured-encrypted-2',cycle_id:'two'});
 assert.equal((await store.publishedSnapshot('t','one')).enc,p.enc);assert.equal((await store.statsSnapshot('t')).enc,'structured-encrypted-2');
 await store.commitStatsPublication('t',{...p,enc:'replay',cycle_id:'one'});assert.equal((await store.publishedSnapshot('t','one')).enc,p.enc);
 assert.throws(()=>db.exec("UPDATE stats_snapshot_history SET enc='bad'"),/immutable/);assert.throws(()=>db.exec('DELETE FROM stats_snapshot_history'),/immutable/);
 db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON stats_snapshot_history BEGIN SELECT RAISE(ABORT,'history failure'); END");
 await assert.rejects(store.commitStatsPublication('t',{...p,cycle_id:'three'}),/history failure/);assert.equal(await store.publicationReceipt('t','three'),null);assert.equal(await store.publishedSnapshot('t','three'),null);assert.equal((await store.statsSnapshot('t')).enc,'structured-encrypted-2');
});

test('same stable conversion ID updates current knowledge while preserving source observations',async()=>{
 const {db,store}=setup();await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});
 for(const [i,revenue] of ['45.10','90.00'].entries()){
  const evidenceId='e'+i,events=await normalizeConversions([{...row,revenue}],{subIndex:7,ingestedAt:at});
  await store.recordKeitaroEvidence('t',{source:'k',evidenceId,ingestedAt:at,context:{},enc:'enc'});
  await store.ingestKeitaroEvents('t',{source:'k',evidenceId,events,knownCampaignIds:i?[]:['777'],ingestedAt:at});
 }
 const events=await store.historicalKeitaroEvents('t','k');assert.equal(events.length,1);assert.equal(events[0].fact.amount,'90.00');assert.equal(events[0].state,'matched');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM keitaro_event_observations').get().n,2);
});
