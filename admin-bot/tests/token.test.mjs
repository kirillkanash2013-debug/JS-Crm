import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyToken} from '../scripts/verify-token.mjs';
test('activation checks bot identity and refuses the client bot token',async()=>{
 const fetcher=async()=>Response.json({ok:true,result:{is_bot:true,username:'MyJsCrmBot'}});
 assert.equal(await verifyToken({token:'admin',clientToken:'client',username:'@MyJsCrmBot',fetcher}),'MyJsCrmBot');
 await assert.rejects(verifyToken({token:'client',clientToken:'client',fetcher}),/separate/);
 await assert.rejects(verifyToken({token:'admin',username:'OtherBot',fetcher}),/different bot/);
});
