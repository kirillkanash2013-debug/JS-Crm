import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAction, applyCampaignAction, applyCampaignActionApi} from '../campaign-action.mjs';

const CID = '120250610273720552';

test('API action (no browser) pauses via proxied Graph calls and verifies read-back', async () => {
  const calls = [];
  // Fake proxied Graph transport: me → id; before ACTIVE; POST ok; after PAUSED.
  const request = async (method, path, params) => {
    calls.push([method, path, params]);
    if (path === 'me') return {httpStatus: 200, body: {id: '123'}};
    if (method === 'POST') return {httpStatus: 200, body: {success: true}};
    const status = calls.some(c => c[0] === 'POST') ? 'PAUSED' : 'ACTIVE';
    return {httpStatus: 200, body: {id: CID, name: 'C', status, effective_status: status, daily_budget: '2000'}};
  };
  const {actionResult} = await applyCampaignActionApi({userId: '123', token: 'EA' + 'x'.repeat(30)}, {campaignId: CID, status: 'PAUSED'}, {request});
  assert.equal(actionResult.state, 'done');
  assert.equal(actionResult.after.status, 'PAUSED');
  assert.equal(actionResult.changed, true);
  assert.deepEqual(calls.find(c => c[0] === 'POST'), ['POST', CID, {status: 'PAUSED'}]);
});

test('API action surfaces the Facebook write error', async () => {
  const request = async (method, path) => path === 'me' ? {httpStatus: 200, body: {id: '123'}}
    : method === 'POST' ? {httpStatus: 400, body: {error: {error_user_msg: 'Нельзя менять статус', code: 100}}}
    : {httpStatus: 200, body: {id: CID, status: 'ACTIVE', daily_budget: '2000'}};
  const {actionResult} = await applyCampaignActionApi({userId: '123', token: 'EA' + 'x'.repeat(30)}, {campaignId: CID, status: 'PAUSED'}, {request});
  assert.equal(actionResult.state, 'failed');
  assert.equal(actionResult.stage, 'write');
  assert.equal(actionResult.error.message, 'Нельзя менять статус');
});

test('API action rejects a token that is not this social', async () => {
  const request = async () => ({httpStatus: 200, body: {id: '999'}});
  await assert.rejects(applyCampaignActionApi({userId: '123', token: 'EA' + 'x'.repeat(30)}, {campaignId: CID, status: 'PAUSED'}, {request}), /Identity mismatch/);
});

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
