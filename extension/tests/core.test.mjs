import test from "node:test";
import assert from "node:assert/strict";
import {DEMO_KEY,license,accountId,adsUrl,period,decimal,apiSnapshot,validatePageSnapshot,nextPage} from "../core.mjs";
test("demo activation does not imply Meta authentication",()=>{
  assert.equal(license(DEMO_KEY).mode,"demo");assert.equal(license(DEMO_KEY).accountLimit,1);
  assert.throws(()=>license("js_live_bad"));assert.throws(()=>accountId("1<script>"));
  assert.equal(accountId("act_123456"),"123456");
});
test("only Ads Manager HTTPS origins are accepted",()=>{
  assert.equal(adsUrl("https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=123"),true);
  assert.equal(adsUrl("https://business.facebook.com/adsmanager/manage?act=123"),true);
  for(const u of ["https://facebook.com.evil.test/adsmanager","http://adsmanager.facebook.com","https://www.facebook.com/messages","https://business.facebook.com/settings"]) assert.equal(adsUrl(u),false);
});
test("dates reject invalid values, reversed and oversized ranges",()=>{
  assert.deepEqual(period("2026-09-01","2026-09-30"),{since:"2026-09-01",until:"2026-09-30"});
  for(const ds of [["2026-02-30","2026-03-01"],["2026-09-30","2026-09-01"],["2026-08-01","2026-09-30"]]) assert.throws(()=>period(...ds));
});
test("spend parser preserves zero and rejects ambiguous formatted values",()=>{
  assert.equal(decimal("0"),0);assert.equal(decimal("12.34"),12.34);
  for(const v of ["$1,234.56","1.234,56","NaN","",null,{},-1]) assert.equal(decimal(v),null);
});
const a={account_id:"123",name:"Test",currency:"USD",timezone_name:"Asia/Bishkek"};
const c=[{id:"456",name:"Campaign",account_id:"123",status:"PAUSED",effective_status:"PAUSED",daily_budget:"10000"}];
const metric={campaign_id:"456",campaign_name:"Campaign",account_id:"123",spend:"12.34",account_currency:"USD",date_start:"2026-09-30",date_stop:"2026-09-30"};
const range=period("2026-09-30","2026-09-30");
test("API snapshot keeps Meta IDs, status, budget units, dates and currency",()=>{
  const s=apiSnapshot(a,c,[metric],range,"now");
  assert.equal(s.complete,true);assert.equal(s.campaigns[0].dailyBudgetRaw,"10000");
  assert.equal(s.metrics[0].spend,12.34);assert.equal(s.account.timezone,"Asia/Bishkek");
});
test("API report rejects cross-account, currency/date mismatch and duplicates",()=>{
  for(const m of [{...metric,account_id:"999"},{...metric,account_currency:"EUR"},{...metric,date_start:"2026-09-29"}])
    assert.throws(()=>apiSnapshot(a,c,[m],range,"now"));
  assert.throws(()=>apiSnapshot(a,c,[metric,metric],range,"now"));
  assert.throws(()=>apiSnapshot(a,[{...c[0],account_id:"999"}],[],range,"now"));
});
test("visible rows never turn partial page into a complete financial report",()=>{
  const s=validatePageSnapshot({accountId:"123",tables:[{headers:["Campaign ID","Campaign","Amount spent"],rows:[["456","Hello","$123.00"]]}],visibleRowCount:1},"123","now");
  assert.equal(s.complete,false);assert.equal(s.period,null);assert.deepEqual(s.metrics,[]);
  assert.equal(s.campaigns[0].id,"456");assert.equal(s.campaigns[0].status,"UNKNOWN");
  assert.equal(s.account.currency,null);assert.equal(s.diagnostics.sessionVerified,false);
  assert.throws(()=>validatePageSnapshot({accountId:"999"},"123","now"));
  assert.deepEqual(validatePageSnapshot({accountId:"123",tables:[{headers:["Ad set ID","Name"],rows:[["456","Hello"]]}]},"123","now").campaigns,[]);
});
test("pagination strips tokens and rejects redirects to external origins or other resources",()=>{
  const base="https://graph.facebook.com/v25.0/act_123/insights";
  assert(!nextPage(base+"?after=foo&access_token=secret&appsecret_proof=secret",base).includes("secret"));
  for(const u of ["https://evil.test/v25.0/act_123/insights","https://graph.facebook.com/v25.0/act_999/insights","http://graph.facebook.com/v25.0/act_123/insights"]) assert.throws(()=>nextPage(u,base));
});
