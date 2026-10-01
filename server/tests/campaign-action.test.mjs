import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAction,activateCampaign,TEST_CAMPAIGN} from '../campaign-action.mjs';
test('write gateway rejects other entities and statuses',()=>{for(const a of [{campaignId:'123',status:'ACTIVE'},{campaignId:TEST_CAMPAIGN,status:'PAUSED'},{}])assert.throws(()=>validateAction(a));assert.deepEqual(validateAction({campaignId:TEST_CAMPAIGN,status:'ACTIVE'}),{campaignId:TEST_CAMPAIGN,status:'ACTIVE'});});
test('campaign execution closes browser when identity fails',async()=>{let closed=false,evaluated=false;const browser={close:async()=>{closed=true;},newContext:async()=>({newPage:async()=>({goto:async()=>{},waitForFunction:async()=>{throw new Error('identity');},evaluate:async()=>{evaluated=true;}})})};await assert.rejects(activateCampaign({userId:'123'}, {campaignId:TEST_CAMPAIGN,status:'ACTIVE'},{chromium:{launch:async()=>browser}}));assert.equal(closed,true);assert.equal(evaluated,false);});
