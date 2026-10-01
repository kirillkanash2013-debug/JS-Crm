import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {collect} from '../collector.mjs';
const browserRequired=process.env.REQUIRE_BROWSER==='1';
test('real server Chromium reads fixture identity, structure and spend without extension',async t=>{
 let browser;try{browser=await chromium.launch({headless:true});}catch(e){if(browserRequired)throw e;t.skip('Chromium download unavailable in this workspace');return;}
 const launch=async options=>{
  assert.equal(options.headless,true);
  const original=browser.newContext.bind(browser);
  browser.newContext=async opts=>{
   const context=await original(opts);
   await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.hostname==='adsmanager.facebook.com')return route.fulfill({contentType:'text/html',body:'<script>window.require=()=>({USER_ID:"100123456"});</script>'});
    if(u.hostname!=='graph.facebook.com')return route.abort();
    assert.equal(route.request().method(),'GET');assert.equal(u.searchParams.get('access_token'),'EA'+'x'.repeat(30));
    const campaign={id:'987654',account_id:'123456',name:'Fixture campaign',status:'ACTIVE',effective_status:'ACTIVE',daily_budget:'1000'};
    const account={account_id:'123456',name:'Fixture account',currency:'USD',timezone_name:'UTC',account_status:1};
    let body;
    if(u.pathname.endsWith('/me'))body={id:'100123456',name:'Fixture owner'};
    else if(u.pathname.endsWith('/adaccounts'))body={data:[account]};
    else if(u.pathname.endsWith('/campaigns'))body={data:[campaign]};
    else if(u.pathname.endsWith('/adsets'))body={data:[{id:'876543',account_id:'123456',campaign_id:'987654',name:'Fixture adset',status:'ACTIVE'}]};
    else if(u.pathname.endsWith('/ads'))body={data:[{id:'765432',account_id:'123456',campaign_id:'987654',adset_id:'876543',name:'Fixture ad',status:'ACTIVE'}]};
    else if(u.pathname.endsWith('/insights'))body={data:[{account_id:'123456',campaign_id:'987654',campaign_name:'Fixture campaign',account_currency:'USD',spend:'12.34',date_start:'2026-10-01',date_stop:'2026-10-01'}]};
    else if(u.pathname.endsWith('/act_123456'))body=account;
    else throw new Error('Unexpected fixture endpoint');
    return route.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'https://adsmanager.facebook.com','access-control-allow-credentials':'true'},body:JSON.stringify(body)});
   });return context;
  };return browser;
 };
 try{
  const result=await collect({userId:'100123456',token:'EA'+'x'.repeat(30),userAgent:'Mozilla/5.0 fixture',cookies:[{name:'c_user',value:'100123456',domain:'.facebook.com',path:'/',httpOnly:true,secure:true,sameSite:'None'}]},{since:'2026-10-01',until:'2026-10-01'},{chromium:{launch}});
  assert.equal(result.snapshot.complete,true);assert.equal(result.snapshot.structures['123456'].ads.length,1);assert.equal(result.snapshot.reports['123456'].metrics[0].spend,12.34);assert(!JSON.stringify(result.snapshot).includes('EA'+'x'.repeat(30)));
 }finally{await browser.close();}
});
