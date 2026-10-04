import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {D1Store,MemoryStore} from '../src/store.mjs';
import {normalizeConversions} from '../src/history.mjs';
import {aggregateKeitaro} from '../src/today.mjs';
function setup(through){
 const db=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')&&(!through||f<=through)).sort())db.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const api={prepare(sql){let a=[];const s={bind(...args){a=args;return s;},async run(){return {meta:{changes:db.prepare(sql).run(...a).changes}};},async first(){return db.prepare(sql).get(...a)||null;},async all(){return {results:db.prepare(sql).all(...a)};}};return s;},async batch(ss){db.exec('BEGIN');try{for(const s of ss)await s.run();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}};return {db,store:new D1Store(api)};
}
const row={conversion_id:'c1',sub_id:'click',sub_id_7:'777',status:'sale',click_datetime:'2026-09-29 23:00:00',postback_datetime:'2026-10-01 01:00:00',revenue:'45.10',currency:'EUR',country:'KG'};
const at='2026-10-04T00:00:00Z';
for(const mode of ['D1','memory'])test(mode+': duplicate ingestion, late events, re-attribution and tenant/source isolation',async()=>{
 const store=mode==='D1'?setup().store:new MemoryStore();
 await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});
 let iteration=0;
 const ingest=async(rows,known=[],source='https://k.test')=>{
  const evidenceId='ev'+iteration++;
  const events=await normalizeConversions(rows,{subIndex:7,ingestedAt:at});
  await store.recordKeitaroEvidence('t',{source,evidenceId,ingestedAt:at,context:{subIndex:7},enc:'encrypted'});
  await store.ingestKeitaroEvents('t',{source,evidenceId,events,knownCampaignIds:known,ingestedAt:at});
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

import {eventDay,projectDailyFacts} from '../src/history-projection.mjs';
import {historyWindows,runHistoricalIngestion,persistSourceConversions} from '../src/history-ingestion.mjs';
import {fetchKeitaroReport,probeKeitaroConversions} from '../../shared/keitaro-report.mjs';
const MASTER_KEY=btoa('h'.repeat(32));
for(const mode of ['D1','memory'])test(mode+': overlapping lookback/backfill discovers past events, corrections and out-of-window attribution',async()=>{
 const store=mode==='D1'?setup().store:new MemoryStore();await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});
 let ms=Date.parse(at),revision=0;const requests=[];
 const seed=await normalizeConversions([{...row,conversion_id:'ancient',postback_datetime:'2026-03-01 00:00:00'}],{subIndex:7,ingestedAt:at});
 await store.recordKeitaroEvidence('t',{source:'k',evidenceId:'seed',ingestedAt:at,context:{},enc:'encrypted'});
 await store.ingestKeitaroEvents('t',{source:'k',evidenceId:'seed',events:seed,knownCampaignIds:[],ingestedAt:at});
 const fetchReport=async opts=>{
  requests.push(opts);ms+=10;
  if(opts.probe)return {result:'ok',columns:{country_code:'accepted',currency:'unsupported'}};
  const r={...row,revenue:revision?'90.20':'45.10'};
  return {result:'ok',complete:true,report:[],conversions:opts.kind==='lookback'?[r,r]:[{...r,conversion_id:'archive',postback_datetime:'2026-09-21 01:00:00'}]};
 };
 const run=()=>runHistoricalIngestion({store,tenantId:'t',source:'k',day:'2026-10-04',timezone:'UTC',subIndex:7,masterKey:MASTER_KEY,knownCampaignIds:['777'],fetchReport,clock:()=>ms});
 assert.equal((await run()).result,'complete');
 let facts=await store.historicalDailyFacts('t','k',{from:'2026-09-01',to:'2026-10-04'});
 assert.equal(facts.days.find(d=>d.day==='2026-10-01').ftd,1);assert.equal(facts.days.find(d=>d.day==='2026-10-01').revenue.amount,'45.1');
 assert(!facts.days.some(d=>d.day==='2026-10-04'));
 assert.equal((await store.historicalKeitaroEvents('t','k')).find(e=>e.source_id==='ancient').state,'matched');
 assert.equal((await run()).result,'busy_or_cooldown');
 revision=1;ms+=16*60000;assert.equal((await run()).result,'complete');
 facts=await store.historicalDailyFacts('t','k',{from:'2026-09-01',to:'2026-10-04'});
 assert.equal(facts.days.find(d=>d.day==='2026-10-01').ftd,1);assert.equal(facts.days.find(d=>d.day==='2026-10-01').revenue.amount,'90.2');
 assert.equal(facts.days.find(d=>d.day==='2026-09-21').ftd,1);assert.equal(facts.days.find(d=>d.day==='2026-09-21').revenue.amount,'90.2');
 const observations=await store.historicalObservations('t','k','id:c1');assert.equal(observations.length,2);assert.equal(observations[0].fact.amount,'45.10');
 const state=await store.keitaroHistoryState('t','k');assert.equal(state.cursor_day,'2026-09-15');assert.equal(state.lease_owner,null);
 assert(requests.filter(r=>!r.probe).every(r=>r.conversionsOnly&&r.maxPages===4&&r.pageLimit===250&&r.budgetMs<=10000));
 assert.deepEqual(requests[1].extraColumns,['country_code']);
});
test('daily projection uses actual timestamps, separates currencies/states, exact decimals and unknown payouts',()=>{
 const f={kind:'ftd',ftd_at:'2026-09-30 23:59:59',conversion_at:'2026-10-04 00:00:00',amount:'0.1',currency:'EUR'};
 const e={campaign_id:'777',state:'matched',fact:f};
 const result=projectDailyFacts([e,{...e,fact:{...f,amount:'0.2'}},{...e,fact:{...f,amount:'7',currency:'USD'}},{...e,fact:{...f,amount:null,currency:null}},{...e,fact:{...f,ftd_at:null}},{...e,fact:{kind:'registration',registration_at:'2026-09-29 01:02:03',currency:null}}]);
 assert.equal(result.undated,1);assert.equal(result.days.find(d=>d.currency==='EUR').revenue.amount,'0.3');
 assert.equal(result.days.find(d=>d.currency==='USD').revenue.amount,'7');
 assert.equal(result.days.find(d=>d.day==='2026-09-30'&&d.currency===null).revenue.amount,null);
 assert.equal(result.days.find(d=>d.day==='2026-09-29').reg,1);
 assert(!result.days.some(d=>d.day==='2026-10-04'));
 assert.equal(eventDay({...f,ftd_at:'2026-02-30 10:00:00'}),null);
 assert.equal(eventDay({...f,ftd_at:'bad'}),null);
});
test('archive sweep is bounded, overlaps and wraps; failed window retries same cursor after reload',async()=>{
 const {store}=setup();await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});
 let ms=Date.parse(at),fail=true;const froms=[];
 const run=()=>runHistoricalIngestion({store,tenantId:'t',source:'k',day:'2026-10-04',timezone:'UTC',subIndex:7,masterKey:MASTER_KEY,knownCampaignIds:[],clock:()=>ms,fetchReport:async o=>{
  ms+=10;if(o.probe)return {result:'ok',columns:{}};froms.push([o.from,o.to]);
  if(o.kind==='backfill'&&fail)return {result:'incomplete',reason:'pagination_limit'};
  return {result:'ok',complete:true,report:[],conversions:[]};
 }});
 assert.equal((await run()).result,'incomplete');let state=await store.keitaroHistoryState('t','k');assert.equal(state.cursor_day,null);assert.equal(state.last_result,'incomplete');
 fail=false;ms+=16*60000;assert.equal((await run()).result,'complete');assert.deepEqual(froms[1],froms[2]);
 assert.equal((await store.keitaroHistoryState('t','k')).cursor_day,'2026-09-21');
 const wrap=historyWindows('2026-10-04','2026-04-08');assert.equal(wrap[1].from,'2026-04-08');assert.equal(wrap[1].cursorDay,'2026-09-27');
});
test('D1 lease fencing and immutable A→B→A observations; stale read cannot replace new knowledge',async()=>{
 const {store,db}=setup();await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});
 const put=async(amount,time,id)=>persistSourceConversions({store,tenantId:'t',source:'k',response:{conversions:[{...row,revenue:amount}]},context:{subIndex:7},masterKey:MASTER_KEY,knownCampaignIds:['777'],observedAt:time,observationId:id});
 await put('10',at,'A');await put('20','2026-10-04T00:01:00Z','B');await put('10','2026-10-04T00:02:00Z','C');await put('1','2026-10-03T00:00:00Z','stale');await put('999','2026-10-05T00:00:00Z','A');
 assert.equal((await store.historicalKeitaroEvents('t','k'))[0].fact.amount,'10');
 assert.equal((await store.historicalObservations('t','k','id:c1')).length,4);assert.equal(db.prepare('SELECT COUNT(*) n FROM keitaro_events').get().n,1);
 assert.throws(()=>db.exec("UPDATE keitaro_observation_history SET fact='{}'"),/immutable/);
 assert.throws(()=>db.exec('DELETE FROM keitaro_observation_history'),/immutable/);
 const ms=Date.parse(at);assert.equal(await store.claimKeitaroHistory('t','k','one',ms),true);assert.equal(await store.claimKeitaroHistory('t','k','two',ms),false);
 assert.equal(await store.claimKeitaroHistory('t','k','two',ms+60001),true);
 assert.equal(await store.completeKeitaroHistoryWindow('t','k','one',{cursorDay:'2026-09-01',window:{},completedAt:at},ms+60002),false);
 await store.releaseKeitaroHistory('t','k','one');assert.equal((await store.keitaroHistoryState('t','k')).lease_owner,'two');
});
test('source capability probe is read-only, handles unsupported currency and configured sub_id; historical pagination fails closed',async()=>{
 const calls=[];
 const probe=await probeKeitaroConversions(async(path,payload)=>{
  calls.push({path,payload});assert.equal(path,'/admin_api/v1/conversions/log');assert.equal(payload.limit,1);
  if(payload.columns.includes('currency'))return {result:'unreachable',status:406};
  return {result:'ok',json:{rows:[{conversion_id:'1',sub_id_7:'777',click_datetime:row.click_datetime,postback_datetime:row.postback_datetime,country_code:'KG'}]}};
 },{day:'2026-10-04',timezone:'UTC',subIndex:7});
 assert.equal(probe.columns.currency,'unsupported');assert.equal(probe.columns.country_code,'accepted');assert.equal(probe.observed.fields.sub_id_7.returned,true);
 assert(calls.every(c=>c.payload.columns.includes('sub_id_7')&&!c.payload.columns.includes('sub_id_4')));
 let count=0;const report=await fetchKeitaroReport(async(path,payload)=>{count++;assert.equal(path,'/admin_api/v1/conversions/log');return {result:'ok',json:{rows:Array.from({length:2},(_,i)=>({conversion_id:payload.offset+i})),total:10}};},{from:'2026-09-01',to:'2026-09-07',timezone:'UTC',subIndex:7,conversionsOnly:true,pageLimit:2,maxPages:2,budgetMs:100});
 assert.equal(report.result,'incomplete');assert.equal(report.reason,'pagination_limit');assert.equal(count,2);
 const timeout=await fetchKeitaroReport(()=>new Promise(()=>{}),{conversionsOnly:true,budgetMs:5});assert.equal(timeout.reason,'report_deadline');
});
test('revenue is never mislabeled with original payout currency; explicit sale event time survives later postback',async()=>{
 const [e]=await normalizeConversions([{...row,currency:null,payout_currency:'EUR',payout:'100',revenue:'110',sale_datetime:'2026-09-28 21:00:00',postback_datetime:'2026-10-04 00:00:00'}],{subIndex:7,ingestedAt:at});
 assert.equal(e.fact.currency,null);assert.equal(e.fact.amount,'110');assert.equal(e.fact.source_payout.currency,'EUR');assert.equal(eventDay(e.fact),'2026-09-28');
 assert.equal(eventDay({...e.fact,ftd_at:'2026-09-28 99:00:00'}),null);
});
test('0015 upgrades existing normalized facts and observations without destroying history',async()=>{
 const {db,store}=setup('0014_historical_facts.sql');await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});
 const fact=JSON.stringify({kind:'ftd',ftd_at:'2026-09-28 01:00:00',amount:'10',currency:'EUR'});
 db.prepare('INSERT INTO keitaro_events VALUES(?,?,?,?,?,?,?)').run('t','k','id:old','old','ev',at,fact);
 db.prepare('INSERT INTO keitaro_attribution VALUES(?,?,?,?,?,?)').run('t','k','id:old','777','matched',at);
 db.prepare('INSERT INTO keitaro_event_observations VALUES(?,?,?,?,?,?)').run('t','k','id:old','ev',at,fact);
 db.exec(fs.readFileSync(new URL('../migrations/0015_history_completeness.sql',import.meta.url),'utf8'));
 assert.equal((await store.historicalDailyFacts('t','k',{from:'2026-09-01',to:'2026-10-04'})).days[0].revenue.amount,'10');
 assert.equal((await store.historicalObservations('t','k','id:old')).length,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM keitaro_event_observations').get().n,1);
 assert.equal(db.prepare('SELECT campaign_id FROM keitaro_known_campaigns').get().campaign_id,'777');
});
test('historical pagination accepts a full final page when authoritative total is reached',async()=>{
 const response=await fetchKeitaroReport(async()=>({result:'ok',json:{total:2,rows:[{conversion_id:1},{conversion_id:2}]}}),{conversionsOnly:true,pageLimit:2,maxPages:1});assert.equal(response.complete,true);
});
for(const mode of ['D1','memory'])test(mode+': payout correction postback cannot move the original event day; explicit source event-time correction can',async()=>{
 const store=mode==='D1'?setup().store:new MemoryStore();await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});
 const put=async(r,time,id)=>persistSourceConversions({store,tenantId:'t',source:'k',response:{conversions:[r]},context:{subIndex:7},masterKey:MASTER_KEY,knownCampaignIds:['777'],observedAt:time,observationId:id});
 await put(row,at,'one');await put({...row,revenue:'90',postback_datetime:'2026-10-04 02:00:00'},'2026-10-04T01:00:00Z','two');
 let facts=await store.historicalDailyFacts('t','k',{from:'2026-09-01',to:'2026-10-04'});assert.equal(facts.days[0].day,'2026-10-01');assert.equal(facts.days[0].revenue.amount,'90');assert.equal(facts.days[0].ftd,1);
 const obs=await store.historicalObservations('t','k','id:c1');assert.equal(obs.find(o=>o.observation_id==='two').fact.postback_datetime,'2026-10-04 02:00:00');
 await put({...row,revenue:'100',sale_datetime:'2026-09-30 22:00:00'},'2026-10-04T02:00:00Z','three');
 facts=await store.historicalDailyFacts('t','k',{from:'2026-09-01',to:'2026-10-04'});assert.equal(facts.days.length,1);assert.equal(facts.days[0].day,'2026-09-30');assert.equal(facts.days[0].ftd,1);
});

for(const mode of ['D1','memory'])test(mode+': dense archive resumes durable offset across reload/day rollover without duplicate FTD/Revenue',async()=>{
 let store=mode==='D1'?setup().store:new MemoryStore();await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});
 let ms=Date.parse(at),day='2026-10-04';const calls=[];
 const rows=Array.from({length:2105},(_,i)=>({...row,conversion_id:String(i),revenue:'1',postback_datetime:'2026-09-23 01:00:00'}));
 const fetchReport=opts=>opts.probe?Promise.resolve({result:'ok',columns:{}}):fetchKeitaroReport(async(path,p)=>{
  calls.push({kind:opts.kind,offset:p.offset,from:p.range.from,to:p.range.to});
  const data=opts.kind==='backfill'?rows:[];return {result:'ok',json:{rows:data.slice(p.offset,p.offset+p.limit),total:data.length}};
 },opts);
 const run=()=>runHistoricalIngestion({store,tenantId:'t',source:'k',day,timezone:'UTC',subIndex:7,masterKey:MASTER_KEY,knownCampaignIds:[],fetchReport,clock:()=>ms});
 assert.equal((await run()).result,'incomplete');
 let state=await store.keitaroHistoryState('t','k');assert.equal(state.cursor_day??null,null);assert.equal(state.last_result,'incomplete');assert.equal(JSON.parse(state.continuation)[0].offset,1000);
 if(mode==='D1')store=new D1Store(store.db); // Same durable database, fresh Worker store.
 day='2026-10-05';ms+=60001;
 assert.equal((await run()).result,'incomplete');state=await store.keitaroHistoryState('t','k');assert.equal(JSON.parse(state.continuation)[0].offset,1999);assert.equal(state.cursor_day??null,null);
 ms+=1;assert.equal((await run()).result,'complete');state=await store.keitaroHistoryState('t','k');assert.equal(state.continuation,null);assert.equal(state.cursor_day,'2026-09-21');
 const archive=calls.filter(c=>c.kind==='backfill');assert.equal(archive[4].offset,999);assert.equal(archive[8].offset,1998);assert(archive.every(c=>c.from==='2026-09-21'&&c.to==='2026-09-27'));
 const facts=await store.historicalDailyFacts('t','k',{from:'2026-09-01',to:day});assert.equal(facts.days[0].ftd,2105);assert.equal(facts.days[0].revenue.amount,'2105');assert.equal(facts.days[0].day,'2026-09-23');
 assert.equal((await run()).result,'busy_or_cooldown');
});

test('bounded response deadline retains completed pages and continuation validates the boundary',async()=>{
 const data=Array.from({length:6},(_,i)=>({...row,conversion_id:String(i)}));
 const first=await fetchKeitaroReport(async(path,p)=>p.offset===0?{result:'ok',json:{rows:data.slice(0,2),total:6}}:new Promise(()=>{}),{conversionsOnly:true,resume:true,pageLimit:2,maxPages:4,budgetMs:10});
 assert.equal(first.reason,'report_deadline');assert.equal(first.complete,false);assert.equal(first.conversions.length,2);assert.equal(first.nextOffset,2);
 const offsets=[];const next=await fetchKeitaroReport(async(path,p)=>{offsets.push(p.offset);return {result:'ok',json:{rows:data.slice(p.offset,p.offset+p.limit),total:6}};},{conversionsOnly:true,resume:true,startOffset:first.nextOffset,anchor:first.anchor,pageLimit:2,maxPages:4});
 assert.equal(next.complete,true);assert.deepEqual(offsets,[1,3,5]);assert.deepEqual(next.conversions.map(r=>r.conversion_id),['2','3','4','5']);
 const drift=await fetchKeitaroReport(async()=>({result:'ok',json:{rows:[data[0],data[1]],total:6}}),{conversionsOnly:true,resume:true,startOffset:2,anchor:first.anchor,pageLimit:2,maxPages:1});assert.equal(drift.reason,'checkpoint_boundary_changed');assert.equal(drift.nextOffset,2);assert.deepEqual(drift.conversions,[]);
 const normal=await fetchKeitaroReport(async()=>({result:'ok',json:{rows:data.slice(0,2),total:6}}),{conversionsOnly:true,pageLimit:2,maxPages:1});assert.equal(normal.result,'incomplete');assert.equal(normal.conversions,undefined); // Publication remains fail-closed.
});

for(const mode of ['D1','memory'])test(mode+': interruption after facts before checkpoint and expired owner replay safely',async()=>{
 const store=mode==='D1'?setup().store:new MemoryStore();await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});
 let ms=Date.parse(at);const pending=[{kind:'backfill',from:'2026-09-21',to:'2026-09-27',cursorDay:'2026-09-21',timezone:'UTC',subIndex:7,offset:250,anchor:'saved-boundary'}];
 assert.equal(await store.claimKeitaroHistory('t','k','terminated',ms),true);await store.checkpointKeitaroHistory('t','k','terminated',pending,ms);
 await persistSourceConversions({store,tenantId:'t',source:'k',response:{conversions:[row]},context:{subIndex:7},masterKey:MASTER_KEY,knownCampaignIds:[],observedAt:at,observationId:'before-interruption'});
 const requests=[];const run=()=>runHistoricalIngestion({store,tenantId:'t',source:'k',day:'2026-10-04',timezone:'UTC',subIndex:7,masterKey:MASTER_KEY,knownCampaignIds:['777'],clock:()=>ms,fetchReport:async o=>{requests.push(o);return o.probe?{result:'ok',columns:{}}:{result:'ok',complete:true,nextOffset:251,conversions:[row]};}});
 assert.equal((await run()).result,'busy_or_cooldown');assert.equal((await store.keitaroHistoryState('t','k')).last_result,'incomplete');
 ms+=60001;assert.equal((await run()).result,'complete');assert.equal(requests.find(o=>!o.probe).startOffset,250);
 assert.equal(await store.checkpointKeitaroHistory('t','k','terminated',pending,ms),false);assert.equal(await store.completeKeitaroHistoryWindow('t','k','terminated',{cursorDay:'bad',window:{},completedAt:at},ms),false);await store.releaseKeitaroHistory('t','k','terminated','bad');
 const state=await store.keitaroHistoryState('t','k');assert.equal(state.continuation,null);assert.equal(state.cursor_day,'2026-09-21');assert.equal(state.last_result,'complete');
 const facts=await store.historicalDailyFacts('t','k',{from:'2026-09-01',to:'2026-10-04'});assert.equal(facts.days[0].ftd,1);assert.equal(facts.days[0].revenue.amount,'45.1');assert.equal(facts.days[0].attribution,'matched');
});

test('0016 populated additive upgrade preserves facts, snapshots and an incomplete source state',async()=>{
 const {db,store}=setup('0015_history_completeness.sql');
 await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});
 const fact=JSON.stringify({kind:'ftd',ftd_at:row.postback_datetime,amount:'45.10',currency:'EUR'});
 db.prepare('INSERT INTO keitaro_events(tenant_id,source,event_key,source_id,evidence_id,ingested_at,fact,observed_at,event_day) VALUES(?,?,?,?,?,?,?,?,?)').run('t','k','id:c1','c1','ev',at,fact,at,'2026-10-01');
 db.prepare('INSERT INTO keitaro_observation_history VALUES(?,?,?,?,?,?,?,?)').run('t','k','id:c1','obs','ev',at,fact,'777');
 db.prepare('INSERT INTO stats_snapshot_history(tenant_id,cycle_id,enc,completed_at,source_times) VALUES(?,?,?,?,?)').run('t','cycle','encrypted',at,'{}');
 db.exec("INSERT INTO keitaro_history_state(tenant_id,source,cursor_day,last_result,last_error) VALUES('t','k','2026-09-21','incomplete','history_deadline')");
 const tables=['keitaro_events','keitaro_observation_history','stats_snapshot_history'];const before=tables.map(t=>db.prepare('SELECT COUNT(*) n FROM '+t).get().n);
 db.exec(fs.readFileSync(new URL('../migrations/0016_history_continuation.sql',import.meta.url),'utf8'));
 const state=db.prepare('SELECT * FROM keitaro_history_state').get();assert.equal(state.cursor_day,'2026-09-21');assert.equal(state.last_result,'incomplete');assert.equal(state.continuation,null);assert.deepEqual(tables.map(t=>db.prepare('SELECT COUNT(*) n FROM '+t).get().n),before);
 assert.throws(()=>db.exec("UPDATE keitaro_history_state SET continuation='broken json'"),/CHECK/);
});

for(const mode of ['D1','memory'])test(mode+': deadline partial batch checkpoints facts; retry finishes rather than starting over',async()=>{
 const store=mode==='D1'?setup().store:new MemoryStore();await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});
 const rows=Array.from({length:300},(_,i)=>({...row,conversion_id:String(i),revenue:'1'}));let timeout=true,ms=Date.parse(at);const offsets=[];
 const run=()=>runHistoricalIngestion({store,tenantId:'t',source:'k',day:'2026-10-04',timezone:'UTC',subIndex:7,masterKey:MASTER_KEY,knownCampaignIds:[],clock:()=>ms,fetchReport:async opts=>{
  if(opts.probe)return {result:'ok',columns:{}};
  return fetchKeitaroReport(async(path,p)=>{offsets.push(p.offset);if(opts.kind==='backfill')return {result:'ok',json:{rows:[],total:0}};if(timeout&&p.offset>0)return new Promise(()=>{});return {result:'ok',json:{rows:rows.slice(p.offset,p.offset+p.limit),total:300}};},{...opts,budgetMs:timeout?20:10000});
 }});
 assert.deepEqual(await run(),{result:'incomplete',reason:'history_deadline'});
 const state=await store.keitaroHistoryState('t','k');assert.equal(JSON.parse(state.continuation)[0].offset,250);assert.equal(state.last_result,'incomplete');assert.equal(state.cursor_day??null,null);
 assert.equal((await store.historicalDailyFacts('t','k',{})).days[0].ftd,250);
 timeout=false;ms+=30;assert.equal((await run()).result,'complete');assert.equal(offsets[2],249);
 const facts=await store.historicalDailyFacts('t','k',{});assert.equal(facts.days[0].ftd,300);assert.equal(facts.days[0].revenue.amount,'300');
});

for(const mode of ['D1','memory'])test(mode+': persistence before failed checkpoint replays only pending batch and keeps one business event',async()=>{
 const store=mode==='D1'?setup().store:new MemoryStore();await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});
 let ms=Date.parse(at),fail=true;const checkpoint=store.checkpointKeitaroHistory.bind(store),offsets=[];
 store.checkpointKeitaroHistory=async(...args)=>{if(args[3][0]?.offset===1&&fail){fail=false;throw new Error('simulated_interruption');}return checkpoint(...args);};
 const run=()=>runHistoricalIngestion({store,tenantId:'t',source:'k',day:'2026-10-04',timezone:'UTC',subIndex:7,masterKey:MASTER_KEY,knownCampaignIds:[],clock:()=>ms,fetchReport:async o=>{
  if(o.probe)return {result:'ok',columns:{}};offsets.push(o.startOffset);
  return o.kind==='lookback'&&o.startOffset===0?{result:'incomplete',complete:false,reason:'pagination_limit',conversions:[row],nextOffset:1,anchor:'one'}:{result:'ok',complete:true,conversions:[],nextOffset:o.startOffset};
 }});
 assert.equal((await run()).result,'incomplete');assert.equal(JSON.parse((await store.keitaroHistoryState('t','k')).continuation)[0].offset,0);assert.equal((await store.historicalKeitaroEvents('t','k')).length,1);
 ms+=1;assert.equal((await run()).result,'incomplete');assert.equal(JSON.parse((await store.keitaroHistoryState('t','k')).continuation)[0].offset,1);
 ms+=1;assert.equal((await run()).result,'complete');assert.deepEqual(offsets,[0,0,1,0]);assert.equal((await store.historicalDailyFacts('t','k',{})).days[0].ftd,1);assert.equal((await store.historicalDailyFacts('t','k',{})).days[0].revenue.amount,'45.1');
});

for(const mode of ['D1','memory'])test(mode+': expired lease cannot overwrite or release successor continuation',async()=>{
 const store=mode==='D1'?setup().store:new MemoryStore();await store.createTenant({id:'t',name:'test',plan:'start',socialLimit:3,paidUntil:'2099-01-01'});
 const ms=Date.parse(at),one=[{offset:250}],two=[{offset:500}];
 await store.claimKeitaroHistory('t','k','one',ms);await store.checkpointKeitaroHistory('t','k','one',one,ms);
 assert.equal(await store.checkpointKeitaroHistory('t','k','one',two,ms+60001),false);
 assert.equal(await store.claimKeitaroHistory('t','k','two',ms+60001),true);await store.checkpointKeitaroHistory('t','k','two',two,ms+60002);
 assert.equal(await store.checkpointKeitaroHistory('t','k','one',one,ms+60002),false);await store.releaseKeitaroHistory('t','k','one','stale');
 const state=await store.keitaroHistoryState('t','k');assert.equal(state.lease_owner,'two');assert.equal(state.last_result,'incomplete');assert.deepEqual(JSON.parse(state.continuation),two);
});

test('historical transport exception retains completed pages, invalid continuation makes no provider call',async()=>{
 let calls=0;const response=await fetchKeitaroReport(async()=>{if(calls++)throw new Error('transport interrupted');return {result:'ok',json:{rows:[row],total:2}};},{conversionsOnly:true,resume:true,pageLimit:1,maxPages:2});
 assert.equal(response.reason,'source_request_failed');assert.equal(response.nextOffset,1);assert.deepEqual(response.conversions,[row]);
 for(const opts of [{startOffset:-1},{startOffset:1,anchor:null},{startOffset:1,anchor:'x',resume:false},{conversionsOnly:false,resume:true}]){
  const bad=await fetchKeitaroReport(async()=>{assert.fail('invalid checkpoint must not reach provider');},{conversionsOnly:true,resume:true,...opts});assert.equal(bad.reason,'invalid_report_checkpoint');
 }
});
