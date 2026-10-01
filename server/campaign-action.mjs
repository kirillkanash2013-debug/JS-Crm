// One explicitly authorized test campaign; no general write gateway.
export const TEST_CAMPAIGN='120250610273720552';
export function validateAction(a){if(a?.campaignId!==TEST_CAMPAIGN||a?.status!=='ACTIVE')throw new Error('Unsupported action');return {campaignId:TEST_CAMPAIGN,status:'ACTIVE'};}
export async function activateCampaign(connection,action,{chromium}={}){
 validateAction(action);if(!chromium)({chromium}=await import('playwright'));
 const browser=await chromium.launch({headless:true,proxy:connection.proxy||undefined});
 const deadline=setTimeout(()=>void browser.close().catch(()=>{}),180000);
 try{
  const context=await browser.newContext({userAgent:connection.userAgent,storageState:connection.storageState||{cookies:connection.cookies,origins:[]}});
  const page=await context.newPage();await page.goto('https://adsmanager.facebook.com/adsmanager/',{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(id=>{try{return String(globalThis.require('CurrentUserInitialData').USER_ID)===id;}catch{return false;}},connection.userId,{timeout:30000});
  const result=await page.evaluate(async({userId,token,campaignId})=>{
   if(String(globalThis.require('CurrentUserInitialData').USER_ID)!==userId)throw new Error('Identity mismatch');
   const call=(method,fields)=>new Promise((resolve,reject)=>{const x=new XMLHttpRequest(),url=new URL('https://graph.facebook.com/v25.0/'+campaignId);const body=new URLSearchParams({access_token:token,...fields});if(method==='GET')url.search=body.toString();x.open(method,url.href,true);x.withCredentials=true;x.responseType='json';x.timeout=20000;if(method==='POST')x.setRequestHeader('Content-Type','application/x-www-form-urlencoded');x.onload=()=>resolve({httpStatus:x.status,body:x.response});x.onerror=()=>reject(new Error('network'));x.ontimeout=()=>reject(new Error('timeout'));x.send(method==='POST'?body.toString():null);});
   const clean=r=>({httpStatus:r.httpStatus,code:r.body?.error?.code,subcode:r.body?.error?.error_subcode});
   const before=await call('GET',{fields:'id,name,account_id,status,effective_status'});
   if(before.body?.id!==campaignId||before.body?.error)return {state:'failed',stage:'read_before',error:clean(before)};
   if(!['PAUSED','ACTIVE'].includes(before.body.status))return {state:'failed',stage:'unsupported_status',before:before.body};
   let write;if(before.body.status!=='ACTIVE'){write=await call('POST',{status:'ACTIVE'});if(write.body?.success!==true)return {state:'failed',stage:'write',before:before.body,error:clean(write)};}
   const after=await call('GET',{fields:'id,name,account_id,status,effective_status'});
   return {state:after.body?.id===campaignId&&after.body?.status==='ACTIVE'?'done':'unverified',before:before.body,after:after.body?.error?undefined:after.body,error:after.body?.error?clean(after):undefined,changed:!!write};
  },{userId:connection.userId,token:connection.token,campaignId:action.campaignId});
  return {actionResult:{...result,campaignId:action.campaignId,requestedStatus:'ACTIVE',observedAt:new Date().toISOString()},storageState:await context.storageState()};
 }finally{clearTimeout(deadline);await browser.close();}
}
