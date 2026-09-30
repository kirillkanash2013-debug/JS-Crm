import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const files = fs.readFileSync('.claspignore','utf8').split('\n').filter(x=>x.startsWith('!') && x.endsWith('.js')).map(x=>x.slice(1));
const names = new Set();
for (const file of files) {
  const source = fs.readFileSync(file,'utf8');
  new vm.Script(source,{filename:file});
  for (const match of source.matchAll(/^function\s+(\w+)\s*\(/gm)) {
    assert(!names.has(match[1]), `Duplicate deployed function: ${match[1]}`);
    names.add(match[1]);
  }
}
for (const file of fs.readdirSync('.').filter(x=>x.endsWith('.js'))) {
  const source = fs.readFileSync(file,'utf8');
  assert(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(source), `Embedded JWT in ${file}`);
}
assert.equal(JSON.parse(fs.readFileSync('.clasp.json')).scriptId,'1eZEdgudWM6s5bbXAXLQfmdOvv_CO-uhRd52UCRCpiGpzvg3nF3iXH3pd');
assert.equal(JSON.parse(fs.readFileSync('appsscript.json')).timeZone,'Europe/Minsk');
assert.equal(typeof names.has === 'function' && names.has('refreshKeitaroFlowCache_'),true,'Keitaro flow cache module must be deployed');
const ctx = vm.createContext({});
vm.runInContext(files.map(f=>fs.readFileSync(f,'utf8')).join('\n'),ctx);
let writes=0;
const legacy={getLastRow:()=>1032,getLastColumn:()=>23,getName:()=> 'ALL',getRange:()=>({getValues:()=>[Array(23).fill('legacy')],setValues:()=>writes++})};
assert.throws(()=>ctx.ensureHeaders_(legacy,['Date','Spend']),/Schema mismatch/);
assert.equal(writes,0);
ctx.ScriptApp={getScriptId:()=> '1eZEdgudWM6s5bbXAXLQfmdOvv_CO-uhRd52UCRCpiGpzvg3nF3iXH3pd'};
assert.equal(ctx.getCrmEnv_().name,'prod');
assert.equal(ctx.getStorageIds_().FB,'1K1jWjsjWAHni1G4ctU1n39hccPNfTvfqcPgYKsT20Yc');
assert.equal(ctx.getCrmEnv_().devEndpoint,false);
ctx.SpreadsheetApp={getActiveSpreadsheet:()=>({getId:()=> '1OybSL2WmQAsibfvNqmvy9A0rTXCQJ02ghbX2NeFxfYM',getSheetByName:()=>legacy})};
assert.throws(()=>ctx.assertCrmReady_(),/migration required/);
assert.equal(writes,0);
assert.throws(()=>ctx.parseJsonResponseOrThrow_({getResponseCode:()=>401,getContentText:()=> 'secret must never be logged'},'API'),e=>!e.message.includes('secret'));
const kt=ctx.mapKeitaroCampaignRow_({sub_id_1:'Kirill',sub_id_3:'Campaign',sub_id_4:'123',offer:{id:6013,name:'Pinco TJ'},clicks:100,campaign_unique_clicks:40,conversions:20,sales:5,sale_revenue:250},'2026-09-21','now');
assert.equal(kt[4],'123');
assert.deepEqual(Array.from(kt.slice(5,10)),[100,40,20,5,250]);
assert.equal(kt[11],'6013');
assert.equal(kt[12],'Pinco TJ');
assert.equal(kt[13],6.25);
assert.equal(kt[14],'SUB4');
assert.equal(kt[16],'');
let capturedKeitaroRows;
ctx.getCurrentTimestamp_=()=> 'now';
ctx.writeDbSheet_=(_name,_headers,rows)=>{capturedKeitaroRows=rows;};
ctx.writeKeitaroTodayDb_([
  {campaign_id:10690,campaign:'KT Campaign',offer:'Pinco TJ',campaign_unique_clicks:1}
], '2026-09-27', [{id:10690,status:'active'}], [
  {offer_id:6013,offer:'Pinco TJ'}
]);
assert.equal(capturedKeitaroRows[0][11],'6013');
const conversion=ctx.mapKeitaroConversionRow_({conversion_id:'c-1',sub_id:'click-1',campaign_id:10690,campaign:'KT Campaign',offer_id:6013,offer:'Pinco TJ',sub_id_1:'Kirill',sub_id_2:'ad',sub_id_3:'FB campaign',sub_id_4:'238001',sub_id_5:'adset-1',sub_id_6:'set',revenue:50,status:'sale',postback_datetime:'2026-09-22 12:00:00'},'2026-09-22','now');
assert.equal(conversion.length,28);
assert.equal(conversion[2],'c-1');
assert.equal(conversion[4],'10690');
assert.equal(conversion[6],'238001');
assert.equal(conversion[12],'6013');
assert.equal(conversion[18],50);
assert.equal(conversion[19],'sale');
assert.equal(conversion[24],'2026-09-22 12:00:00');
assert(ctx.getKeitaroConversionHeaders_().includes('Postback At'));
assert.equal(ctx.parseGeoFromCampaign_('KG+AZ+TJ Kirill | Apps Heroes iOS'),'KG+AZ+TJ');
assert.equal(ctx.parseGeoFromCampaign_('PWA UZ Kirill'),'UZ');
assert.equal(ctx.parseGeoFromCampaign_("[Riddick's Partners] Boostwin AZ | Wheel 2 | Azamat"),'AZ');
const geoGroups={};
ctx.addGeoAggregate_(geoGroups,'Сегодня','2026-09-24','KG','Farm',{
  spend:100,inst:20,reg:10,ftd:2,revenue:150,campaign:'KG Test'
});
assert.equal(geoGroups['Сегодня|2026-09-24|KG|Farm'].spend,100);
assert.equal(geoGroups['Сегодня|2026-09-24|KG|Farm'].campaigns.size,1);
assert.equal(ctx.calculateOurLifetimeSpend_(125,100,7),25);
assert.equal(ctx.calculateOurLifetimeSpend_(90,100,7),7);
assert.equal(ctx.calculateOurLifetimeSpend_(105,100,30),30);
assert.equal(ctx.getCampaignRawStatus_({status:'paused'}),'PAUSED');
assert.equal(ctx.getCampaignStatus_({status:'ACTIVE'}),'ACTIVE');
assert.equal(ctx.getCampaignStatus_({status:'PAUSED'}),'DISABLED');
assert.equal(ctx.getCampaignStatus_({effective_status:'TOKEN_ERROR'}),'ERROR');
assert.equal(ctx.getCampaignStatus_({}),'UNKNOWN');
assert.equal(ctx.getCampaignSpend_({statsTotal:{spend:'12.5'}}),12.5);
assert.equal(ctx.getCampaignAccountId_({ad_account_id:123}),'123');
assert.equal(ctx.isValidCampaignId_('123456'),true);
assert.equal(ctx.isValidCampaignId_('{sub_id_4}'),false);
const telegramTotals=ctx.aggregateTelegramKeitaroTotals_(
  ['Дата','Inst','Reg','FTD','Revenue'],
  [['2026-09-28',10,4,1,50],['2026-09-28',0,1,1,45]]
);
assert.deepEqual(JSON.parse(JSON.stringify(telegramTotals)),{
  hasData:true,inst:10,reg:5,dep:2,revenue:95
});
let telegramCampaignRows = [
  ['Keitaro Campaign ID','Keitaro Campaign','Keitaro Campaign Status'],
  ['10690','Campaign B','ACTIVE'],
  ['10538','Campaign A','ACTIVE'],
  ['10538','Campaign A','ACTIVE'],
  ['10000','Old','DISABLED']
];
ctx.getOrCreateSheet_=()=>({
  getLastRow:()=>telegramCampaignRows.length,
  getLastColumn:()=>telegramCampaignRows[0].length,
  getRange:()=>({getValues:()=>telegramCampaignRows})
});
assert.deepEqual(JSON.parse(JSON.stringify(ctx.getTelegramCachedCampaigns_())),[
  {id:'10538',name:'Campaign A',status:'ACTIVE'},
  {id:'10690',name:'Campaign B',status:'ACTIVE'}
]);
assert.equal(Array.from(ctx.getAllHistoryHeaders_()).includes('Campaign Status'),false);
assert.equal(Array.from(ctx.getAllTodayHeaders_()).includes('Campaign Status'),true);
const staleCandidates={};
ctx.addCabCandidate_(staleCandidates,{account_id:'act_1',bms:[{id:'old_bm'}]},'','','',{old_bm:{name:'Old',status:'ACTIVE'}},false);
assert.equal(staleCandidates.act_1[0].cab._resolved_bm_id,'');
const currentCandidates={};
ctx.addCabCandidate_(currentCandidates,{account_id:'act_1'},'new_bm','New','ACTIVE',{new_bm:{name:'New',status:'ACTIVE'}},true);
assert.equal(currentCandidates.act_1[0].cab._resolved_bm_id,'new_bm');
// Sandbox: separate spreadsheet, polling bot, dev endpoint; prod never serves dev requests.
ctx.ScriptApp={getScriptId:()=> '1zBbm3wUrgFJyag0wj25ckY-p-lygkdpOMWCjV8uaH0GQLaOMoS12D6RP'};
assert.equal(ctx.getCrmEnv_().name,'claude');
assert.equal(ctx.getStorageIds_().CRM,'1KOYIS9vT1VN9zs9eCKj32IK9iYlBWS_QJHVB8xSUSEs');
assert(Object.values(ctx.getStorageIds_()).every(id=>id!=='1OybSL2WmQAsibfvNqmvy9A0rTXCQJ02ghbX2NeFxfYM'),'Sandbox must not touch prod storage');
assert.equal(ctx.getCrmEnv_().telegramWorkerUrl,'');
const devProps={CRM_CLAUDE_DEV_SECRET:'s'.repeat(64)};
ctx.PropertiesService={getScriptProperties:()=>({getProperty:k=>devProps[k]||null})};
ctx.ContentService={MimeType:{JSON:'json'},createTextOutput:t=>({text:t,setMimeType(){return this;}})};
const devCall=(secret,body)=>ctx.handleDevRequest_({parameter:{dev:'1'},postData:{contents:JSON.stringify(Object.assign({secret},body))}}).text;
assert.equal(devCall('wrong',{action:'ping'}),'forbidden');
assert.equal(JSON.parse(devCall(devProps.CRM_CLAUDE_DEV_SECRET,{action:'ping'})).result.env,'claude');
assert.match(JSON.parse(devCall(devProps.CRM_CLAUDE_DEV_SECRET,{action:'run',fn:'installTriggers'})).error,/not allowlisted/);
ctx.ScriptApp={getScriptId:()=> '1eZEdgudWM6s5bbXAXLQfmdOvv_CO-uhRd52UCRCpiGpzvg3nF3iXH3pd'};
assert.equal(devCall(devProps.CRM_CLAUDE_DEV_SECRET,{action:'ping'}),'forbidden');
ctx.ScriptApp={getScriptId:()=> 'unknown'};
assert.throws(()=>ctx.getCrmEnv_(),/Unknown CRM environment/);
console.log(`PASS: ${files.length} modules; unique entry points; target, secret scan, history protection, error redaction`);
