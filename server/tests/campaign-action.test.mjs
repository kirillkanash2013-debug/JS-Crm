import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAction, applyCampaignAction} from '../campaign-action.mjs';

const CID = '120250610273720552';

test('action validation: campaign id format, status, budget bounds', () => {
  for (const a of [
    {campaignId: '12', status: 'ACTIVE'},          // id too short
    {campaignId: 'abc', status: 'ACTIVE'},         // id not numeric
    {campaignId: CID, status: 'DELETED'},          // unsupported status
    {campaignId: CID},                             // neither status nor budget
    {campaignId: CID, dailyBudget: 50},            // below min
    {campaignId: CID, dailyBudget: 1.5},           // not integer
    {campaignId: CID, dailyBudget: 200000000},     // above max
    {}
  ]) assert.throws(() => validateAction(a), undefined, JSON.stringify(a));
  assert.deepEqual(validateAction({campaignId: CID, status: 'PAUSED'}), {campaignId: CID, status: 'PAUSED'});
  assert.deepEqual(validateAction({campaignId: CID, dailyBudget: 1000}), {campaignId: CID, dailyBudget: 1000});
  assert.deepEqual(validateAction({campaignId: CID, status: 'ACTIVE', dailyBudget: 500}), {campaignId: CID, status: 'ACTIVE', dailyBudget: 500});
});

test('campaign execution closes the browser when identity fails', async () => {
  let closed = false, evaluated = false;
  const browser = {close: async () => { closed = true; }, newContext: async () => ({newPage: async () => ({goto: async () => {}, waitForFunction: async () => { throw new Error('identity'); }, evaluate: async () => { evaluated = true; }})})};
  await assert.rejects(applyCampaignAction({userId: '123'}, {campaignId: CID, status: 'PAUSED'}, {chromium: {launch: async () => browser}}));
  assert.equal(closed, true);
  assert.equal(evaluated, false);
});
