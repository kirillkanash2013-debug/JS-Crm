import {discoverSocial,syncMeta} from '../extension/meta.mjs';
import {syncStructure} from '../extension/structure.mjs';
import {pageGraphRead} from '../extension/page-transport.mjs';
export async function collect(connection,range,{chromium,timeoutMs=15*60*1000}={}){
 if(!chromium)({chromium}=await import('playwright'));
 const browser=await chromium.launch({headless:true,proxy:connection.proxy||undefined});
 const deadline=setTimeout(()=>void browser.close().catch(()=>{}),timeoutMs);
 try{
  const context=await browser.newContext({userAgent:connection.userAgent,storageState:connection.storageState||{cookies:connection.cookies,origins:[]}});
  const page=await context.newPage();
  await page.goto('https://adsmanager.facebook.com/adsmanager/',{waitUntil:'domcontentloaded',timeout:60000});
  try{await page.waitForFunction(id=>{try{return String(globalThis.require('CurrentUserInitialData').USER_ID)===id;}catch{return false;}},connection.userId,{timeout:30000});}catch{throw Object.assign(new Error('Session requires reconnection'),{code:'needs_auth'});}
  const fetcher=async(url,options)=>{
   if(options.method!=='GET')throw new Error('Read only');
   const token=options.headers.Authorization.slice(7);
   const read=Function('arg','return ('+pageGraphRead.toString()+')(arg.url,arg.token,arg.userId)');
   const r=await page.evaluate(read,{url,token,userId:connection.userId});
   return {ok:r.status>=200&&r.status<300,status:r.status,json:async()=>r.body};
  };fetcher.pageContext=true;
  const social=await discoverSocial(connection.token,connection.userId,()=>{},fetcher);
  const reports={},structures={};
  for(const a of social.accounts){reports[a.id]=await syncMeta(a.id,range,connection.token,()=>{},fetcher);structures[a.id]=await syncStructure(a.id,connection.token,()=>{},fetcher);}
  const storageState=await context.storageState();
  return {snapshot:{schemaVersion:1,source:'facebook-server',complete:true,observedAt:new Date().toISOString(),social,reports,structures},storageState};
 }finally{clearTimeout(deadline);await browser.close();}
}
