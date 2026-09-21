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
const ctx = vm.createContext({});
vm.runInContext(files.map(f=>fs.readFileSync(f,'utf8')).join('\n'),ctx);
let writes=0;
const legacy={getLastRow:()=>1032,getLastColumn:()=>23,getName:()=> 'ALL',getRange:()=>({getValues:()=>[Array(23).fill('legacy')],setValues:()=>writes++})};
assert.throws(()=>ctx.ensureHeaders_(legacy,['Date','Spend']),/Schema mismatch/);
assert.equal(writes,0);
ctx.SpreadsheetApp={getActiveSpreadsheet:()=>({getId:()=> '1OybSL2WmQAsibfvNqmvy9A0rTXCQJ02ghbX2NeFxfYM',getSheetByName:()=>legacy})};
assert.throws(()=>ctx.assertCrmReady_(),/migration required/);
assert.equal(writes,0);
assert.throws(()=>ctx.parseJsonResponseOrThrow_({getResponseCode:()=>401,getContentText:()=> 'secret must never be logged'},'API'),e=>!e.message.includes('secret'));
const kt=ctx.mapKeitaroCampaignRow_({sub_id_1:'Kirill',sub_id_3:'Campaign',sub_id_4:'123',clicks:100,campaign_unique_clicks:40,conversions:20,sales:5,sale_revenue:250},'2026-09-21','now');
assert.equal(kt[4],'123');
assert.deepEqual(Array.from(kt.slice(5,10)),[100,40,20,5,250]);
assert.equal(kt[12],6.25);
assert.equal(kt[13],'SUB4');
assert.equal(ctx.parseGeoFromCampaign_('KG+AZ+TJ Kirill | Apps Heroes iOS'),'KG+AZ+TJ');
assert.equal(ctx.parseGeoFromCampaign_('PWA UZ Kirill'),'UZ');
console.log(`PASS: ${files.length} modules; unique entry points; target, secret scan, history protection, error redaction`);
