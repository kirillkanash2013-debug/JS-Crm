import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateKeitaro, buildNow} from '../src/today.mjs';

const day = '2026-09-30';
const report = [
  {sub_id_4: '100', campaign: 'KG_A', offer: 'Zazino', campaign_unique_clicks: 10, clicks: 14},
  {sub_id_4: '200', campaign: 'KG_B', offer: 'Boost', campaign_unique_clicks: 5, clicks: 6}
];
const conversions = [
  {sub_id_4: '100', status: 'lead', click_datetime: '2026-09-30 09:00:00'},
  {sub_id_4: '100', status: 'lead', click_datetime: '2026-09-30 09:05:00'},
  {sub_id_4: '100', status: 'lead', click_datetime: '2026-09-30 09:06:00'},
  {sub_id_4: '100', status: 'sale', revenue: 50, click_datetime: '2026-09-30 10:00:00'},   // fresh
  {status: 'sale', revenue: 420, click_datetime: '2026-09-29 22:00:00'}   // долёт
];

test('aggregateKeitaro joins by sub_id and splits долёт', () => {
  const {byCampaign, totals} = aggregateKeitaro({report, conversions}, {subIndex: 4, day});
  assert.equal(totals.inst, 15);
  assert.equal(totals.reg, 3);
  assert.equal(totals.dep, 1);
  assert.equal(totals.rev, 50);
  assert.equal(totals.doletDep, 1);
  assert.equal(totals.doletRev, 420);
  assert.equal(byCampaign['100'].inst, 10);
  assert.equal(byCampaign['100'].rev, 50);
  assert.equal(byCampaign['200'].inst, 5);
});

test('aggregateKeitaro honours a non-default sub_id index', () => {
  const rows = [{sub_id_2: '777', status: 'sale', revenue: 10, click_datetime: '2026-09-30 10:00'}];
  const {byCampaign} = aggregateKeitaro({report: [], conversions: rows}, {subIndex: 2, day});
  assert.equal(byCampaign['777'].rev, 10);
});

test('buildNow renders the «Сейчас» top block and campaign lines', () => {
  const keitaro = aggregateKeitaro({report, conversions}, {subIndex: 4, day});
  const campaigns = [{campaignId: '100', name: 'KG_A', effectiveStatus: 'ACTIVE', dailyBudget: 15400, spend: 15}];
  const text = buildNow({day, times: {fb: '19:47', keitaro: '19:47'}, campaigns, keitaro, subIndex: 4});
  assert.match(text, /📊 Сейчас · 30\.09\.2026/);
  assert.match(text, /JS Control 19:47 · Keitaro 19:47/);
  assert.match(text, /Spend <b>\$15\.00<\/b>/);
  assert.match(text, /Inst <b>15<\/b> · Reg <b>3<\/b>/);
  assert.match(text, /Dep <b>1<\/b> \+1 долёт/);
  assert.match(text, /Rev <b>\$50\.00<\/b> → <b>\$470\.00<\/b>/);
  assert.match(text, /Profit <b>\$35\.00<\/b> → <b>\$455\.00<\/b>/); // rev-spend, прогноз revAll-spend
  assert.match(text, /Ⓜ️ <b>Кампании сейчас:<\/b>/);
  assert.match(text, /💰154\$ 💸15\$ 🤑50\$/);
});

test('buildNow renders the 🎯 offers block grouped by GEO with EPC', () => {
  const rep = [{sub_id_4: '100', campaign: 'KG_Red26', offer: 'Zazino KG', campaign_unique_clicks: 10}];
  const conv = [
    {sub_id_4: '100', offer: 'Zazino KG', status: 'lead', click_datetime: '2026-09-30 09:00'},
    {sub_id_4: '100', offer: 'Zazino KG', status: 'sale', revenue: 50, click_datetime: '2026-09-30 10:00'}
  ];
  const keitaro = aggregateKeitaro({report: rep, conversions: conv}, {subIndex: 4, day});
  const campaigns = [{campaignId: '100', name: 'KG_Red26', effectiveStatus: 'ACTIVE', dailyBudget: 0, spend: 10}];
  const text = buildNow({day, campaigns, keitaro, subIndex: 4});
  assert.match(text, /🎯 <b>KG<\/b>/);
  // inst 10 - reg 1 - dep 1 · EPC = 50/10 = 5.00
  assert.match(text, /Zazino KG · 10 - 1 - 1 · \$5\.00/);
});

test('buildNow without Keitaro долёт omits the arrow', () => {
  const keitaro = aggregateKeitaro({report, conversions: []}, {subIndex: 4, day});
  const text = buildNow({day, campaigns: [{campaignId: '100', spend: 5}], keitaro});
  assert.match(text, /Rev <b>\$0\.00<\/b>\n/);
  assert.doesNotMatch(text, /→/);
});
