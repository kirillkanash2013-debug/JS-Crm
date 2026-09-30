import test from "node:test";
import assert from "node:assert/strict";
import {pages,syncMeta,graph,discoverSocial,safeMetaFailure} from "../meta.mjs";
const response=(body,status=200)=>({ok:status===200,json:async()=>body});
test("paginated API fetch uses bearer header, never URL credentials",async()=>{
  const requests=[];
  const data=await pages("act_123/campaigns",{limit:100},"secret-token",async(url,opts)=>{
    requests.push({url,opts});
    return response(requests.length===1 ? {data:[{id:"456"}],paging:{next:"https://graph.facebook.com/v25.0/act_123/campaigns?after=next&access_token=should-not-leak"}} : {data:[{id:"789"}]});
  });
  assert.equal(data.length,2);assert.equal(requests[1].opts.headers.Authorization,"Bearer secret-token");
  assert(!requests.some(x=>x.url.includes("token")));
  assert(requests.every(x=>x.opts.redirect==="error" && x.opts.credentials==="omit"));
});
test("API failure redacts Meta message and tokens",async()=>{
  await assert.rejects(graph("act_123",{},"secret",async()=>response({error:{code:190,message:"secret user data"}},400)),e=>!e.message.includes("secret") && e.code===190);
});
test("repeating cursor and unsafe pagination are rejected",async()=>{
  const next="https://graph.facebook.com/v25.0/act_123/campaigns?after=a";
  await assert.rejects(pages("act_123/campaigns",{},"t",async()=>response({data:[],paging:{next}})),/Повтор страницы/);
  await assert.rejects(pages("act_123/campaigns",{},"t",async()=>response({data:[],paging:{next:"https://evil.test/"}})),/небезопасный/);
});
test("full sync joins all campaigns including no-spend and insight-only records",async()=>{
  const fetcher=async(url)=>{
    const u=new URL(url);
    if(u.pathname.endsWith("/campaigns"))return response({data:[{id:"456",name:"New",account_id:"123",status:"ACTIVE"}]});
    if(u.pathname.endsWith("/insights"))return response({data:[{campaign_id:"789",campaign_name:"Old",account_id:"123",spend:"5.01",account_currency:"USD",date_start:"2026-09-30",date_stop:"2026-09-30"}]});
    return response({account_id:"123",currency:"USD",timezone_name:"Asia/Bishkek"});
  };
  const s=await syncMeta("123",{since:"2026-09-30",until:"2026-09-30"},"token",()=>{},fetcher);
  assert.equal(s.campaigns.length,2);assert.equal(s.metrics.length,1);assert.equal(s.campaigns[1].status,"UNKNOWN");
});

test("social discovery validates identity and discovers several accounts without tab binding",async()=>{
  const {discoverSocial}=await import("../meta.mjs");
  const fetcher=async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith("/adaccounts"))return response({data:[
      {account_id:"123",name:"A",currency:"USD",business:{id:"777",name:"BM"}},
      {account_id:"456",name:"B",currency:"EUR",business:{id:"777",name:"BM"}}
    ]});
    return response({id:"999",name:"Owner"});
  };
  const s=await discoverSocial("local-token","999",()=>{},fetcher);
  assert.equal(s.accounts.length,2);assert.equal(s.businesses.length,1);assert.equal(s.accountsComplete,true);
  assert.equal(s.businessesComplete,false);
  await assert.rejects(discoverSocial("local-token","888",()=>{},fetcher),/другому FB/);
});

test("connection failures identify the API stage without retaining raw error data",async()=>{
  for(const stage of ["identity","adaccounts"]){
    const fetcher=async url=>{
      if(stage==="adaccounts" && new URL(url).pathname.endsWith("/me"))return response({id:"999"});
      return {status:400,ok:false,json:async()=>({error:{code:1,error_subcode:99,is_transient:true,message:"An unknown error occurred secret-token",fbtrace_id:"private-trace"}})};
    };
    await assert.rejects(discoverSocial("secret-token","999",()=>{},fetcher),e=>{
      assert.deepEqual(safeMetaFailure(e),{code:1,stage,httpStatus:400,subcode:99,transient:true,reason:"unknown-api-error"});
      assert(!JSON.stringify(e).includes("secret-token"));
      assert(!JSON.stringify(e).includes("private-trace"));return true;
    });
  }
  assert.equal(safeMetaFailure({code:"secret",stage:"secret",reason:"secret",message:"secret"}).code,"unknown");
});
