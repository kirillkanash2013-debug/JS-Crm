import test from "node:test";
import assert from "node:assert/strict";
import {validateStructure,syncStructure} from "../structure.mjs";
const account={account_id:"123",name:"A",currency:"USD"};
const campaigns=[{id:"111",account_id:"123",name:"Campaign",daily_budget:"5000"}];
const adsets=[{id:"222",account_id:"123",campaign_id:"111",name:"Adset"}];
const ads=[{id:"333",account_id:"123",campaign_id:"111",adset_id:"222",name:"Ad"}];
test("structure validates hierarchy and excludes arbitrary response fields",()=>{
 const result=validateStructure(account,campaigns,adsets,[{...ads[0],access_token:"PRIVATE",creative:{secret:"PRIVATE"}}]);
 assert.equal(result.complete,true);assert.equal(result.ads[0].adsetId,"222");assert.equal(result.campaigns[0].daily_budget,"5000");assert(!JSON.stringify(result).includes("PRIVATE"));
});
test("structure rejects cross-account, duplicate IDs and broken parents",()=>{
 assert.throws(()=>validateStructure(account,campaigns,adsets,[{...ads[0],account_id:"456"}]));
 assert.throws(()=>validateStructure(account,campaigns,[{...adsets[0],campaign_id:"999"}],ads));
 assert.throws(()=>validateStructure(account,campaigns,adsets,[{...ads[0],adset_id:"999"}]));
 assert.throws(()=>validateStructure(account,[...campaigns,...campaigns],adsets,ads));
});
test("structure fetch paginates all levels using the provided page transport",async()=>{
 const fetcher=async url=>{const u=new URL(url);let body;
 if(u.pathname.endsWith("/campaigns"))body={data:campaigns};
 else if(u.pathname.endsWith("/adsets"))body={data:adsets};
 else if(u.pathname.endsWith("/ads"))body={data:ads};else body=account;
 return {ok:true,status:200,json:async()=>body};};
 const result=await syncStructure("123","EA"+"a".repeat(30),async()=>{},fetcher);
 assert.equal(result.ads.length,1);assert.equal(result.adsets.length,1);
});
