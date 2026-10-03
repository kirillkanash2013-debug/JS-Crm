import test from 'node:test';
import assert from 'node:assert/strict';
import {Admission} from '../src/admission.mjs';
import {fetchKeitaroReport} from '../../shared/keitaro-report.mjs';
import {diagnostic} from '../src/diagnostics.mjs';
test('100 simultaneous clients are bounded, FIFO, restart-safe and reclaim expired leases',()=>{
 let now=0;const g=new Admission({},()=>now),first=[];
 for(let i=0;i<100;i++){const p=g.acquire('jobs','t'+i,4);if(p)first.push(p);}
 assert.equal(first.length,4);assert.equal(g.summary().activeJobs,4);assert.equal(g.summary().waiting,96);
 const restarted=new Admission(structuredClone(g.state),()=>now);
 assert.equal(restarted.acquire('jobs','t99',4),null);
 restarted.release(first[0]);assert.equal(restarted.acquire('jobs','t99',4),null);
 assert(restarted.acquire('jobs','t4',4));
 now=21*60000;assert(restarted.acquire('jobs','t99',4));assert.equal(restarted.summary().activeJobs,1);
});
test('one tenant cannot monopolize permits; duplicate release does not double usage',()=>{
 const g=new Admission();const p=g.acquire('jobs','a',4);assert(p);assert.equal(g.acquire('jobs','a',4),null);
 g.release(p);g.release(p);assert.equal(g.summary('a').usage[0].jobs,1);
});
test('client metrics include only its own live permits and waiting jobs',()=>{
 const g=new Admission();g.acquire('jobs','a',1);g.acquire('jobs','b',1);
 assert.equal(g.summary().activeJobs,1);assert.equal(g.summary('b').activeJobs,0);
 assert.equal(g.summary('a').waiting,0);assert.equal(g.summary('b').waiting,1);
});
test('report loads over 10000 conversions and passes chosen sub index on every page',async()=>{
 const all=Array.from({length:10001},(_,id)=>({conversion_id:id,sub_id_2:'c',status:'sale',revenue:1}));
 const calls=[];const r=await fetchKeitaroReport(async(path,p)=>{calls.push(p);assert(p.columns.includes('sub_id_2'));return {result:'ok',json:{rows:path.endsWith('/build')?[]:all.slice(p.offset,p.offset+p.limit)}};},{subIndex:2});
 assert.equal(r.conversions.length,10001);assert.equal(r.complete,true);assert(calls.length>10);
});
test('repeating page and malformed response never become a financial success',async()=>{
 const repeated=await fetchKeitaroReport(async()=>({result:'ok',json:{rows:Array.from({length:1000},()=>({id:1}))}}));
 assert.equal(repeated.result,'incomplete');assert.equal((await fetchKeitaroReport(async()=>({result:'ok',json:{error:'secret'}}))).result,'incomplete');
});
test('error journal never retains raw exceptions',()=>{
 const d=diagnostic({id:'j',userId:'s'}, {code:'secret-token',message:'cookie=password https://secret'});
 assert.equal(d.code,'failed');assert(!JSON.stringify(d).includes('password'));
});
