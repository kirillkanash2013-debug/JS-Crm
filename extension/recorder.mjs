const HOSTS=["graph.facebook.com","adsmanager.facebook.com","business.facebook.com","www.facebook.com"];
const KEYS=new Set(["input","data","variables","campaign_id","campaign_ids","adset_id","adset_ids","ad_id","ad_ids","account_id","ad_account_id","status","effective_status","daily_budget","lifetime_budget","budget","budget_amount","name","objective","fields","level","time_range","time_increment","limit","after","before"]);
const SECRET=/token|cookie|authorization|password|secret|fb_dtsg|jazoest|session/i;
function shape(value,out,depth=0){
 if(depth>6 || !value || typeof value!=="object")return;
 for(const [key,item] of Object.entries(value).slice(0,100)){
  if(SECRET.test(key))continue;
  if(KEYS.has(key)){
   out.fields.add(key);
   if(["status","effective_status"].includes(key) && ["ACTIVE","PAUSED","ARCHIVED","DELETED"].includes(item))out.changes[key]=item;
   if(["daily_budget","lifetime_budget","budget_amount"].includes(key) && /^\d{1,12}$/.test(String(item)))out.changes[key]=String(item);
  }
  if(item && typeof item==="object")shape(item,out,depth+1);
 }
}
export function traceRequest(details,recorder,now=Date.now()){
 if(!recorder?.active || recorder.expiresAt<=now || details.tabId!==recorder.tabId)return null;
 let u;try{u=new URL(details.url);}catch{return null;}
 if(u.protocol!=="https:" || !HOSTS.includes(u.hostname))return null;
 if(details.initiator){try{if(!HOSTS.includes(new URL(details.initiator).hostname))return null;}catch{return null;}}
 let path;
 if(u.hostname==="graph.facebook.com"){
  if(!/^\/(?:v\d+\.\d+\/)?(?:me|\d+|act_\d+)(?:\/(?:adaccounts|campaigns|adsets|ads|insights|businesses))?\/?$/.test(u.pathname))return null;
  path=u.pathname.replace(/act_\d+/g,"act_:id").replace(/\/\d+(?=\/|$)/g,"/:id");
 }else{
  if(!/^\/(?:api\/graphql|graphql|ajax\/ads\/[^?]*)(?:\/)?$/.test(u.pathname))return null;
  path=u.pathname.startsWith("/ajax/ads/") ? "/ajax/ads/:operation" : u.pathname;
 }
 const values={};for(const [k,v] of u.searchParams)if(["doc_id","fb_api_req_friendly_name","variables",...KEYS].includes(k))values[k]=v;
 const body=details.requestBody;
 let bodyFormat="none";
 if(body?.formData){bodyFormat="form";for(const [k,v] of Object.entries(body.formData))if(["doc_id","fb_api_req_friendly_name","variables",...KEYS].includes(k))values[k]=v[0];}
 else if(body?.raw){
  bodyFormat="unreadable";
  try{
   const chunks=body.raw.filter(x=>x.bytes).map(x=>new Uint8Array(x.bytes));const size=chunks.reduce((n,x)=>n+x.length,0);
   if(size>0 && size<=262144){const bytes=new Uint8Array(size);let i=0;for(const c of chunks){bytes.set(c,i);i+=c.length;}
    const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    if(text.trim().startsWith("{")){const obj=JSON.parse(text);bodyFormat="json";for(const [k,v] of Object.entries(obj))if(["doc_id","fb_api_req_friendly_name","variables",...KEYS].includes(k))values[k]=v;}
    else {bodyFormat="form";for(const [k,v] of new URLSearchParams(text))if(["doc_id","fb_api_req_friendly_name","variables",...KEYS].includes(k))values[k]=v;}
   }
  }catch{}
 }
 const out={fields:new Set(),changes:{}};shape(values,out);
 try{shape(typeof values.variables==="string" ? JSON.parse(values.variables) : values.variables,out);}catch{}
 // Deliberately allow only operation names from known Facebook families.
 const name=values.fb_api_req_friendly_name;
 const operation=typeof name==="string" && /^(?:Ads|Biz|Business|Comet|useAds|useBiz)[A-Za-z0-9_]{1,140}$/.test(name) && !SECRET.test(name) ? name : null;
 return {requestId:String(details.requestId),at:new Date(details.timeStamp || now).toISOString(),host:u.hostname,path,method:["GET","POST","OPTIONS"].includes(details.method)?details.method:"OTHER",operation,docId:/^\d{1,30}$/.test(String(values.doc_id || ""))?String(values.doc_id):null,fields:[...out.fields].sort(),changes:out.changes,bodyFormat,status:null,durationMs:null};
}
export function installRecorder(chrome){
 let queue=Promise.resolve();
 const enqueue=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
 const urls=HOSTS.map(h=>"https://"+h+"/*");
 chrome.webRequest?.onBeforeRequest.addListener(d=>enqueue(async()=>{
  const {trace}=await chrome.storage.local.get("trace");const row=traceRequest(d,trace);
  if(!row)return;
  if(trace.rows.length>=300){await chrome.storage.local.set({trace:{...trace,active:false,stopReason:"limit"}});return;}
  await chrome.storage.local.set({trace:{...trace,rows:[...trace.rows,row]}});
 }),{urls},["requestBody"]);
 const complete=d=>enqueue(async()=>{
  const {trace}=await chrome.storage.local.get("trace");if(!trace || trace.tabId!==d.tabId)return;
  const index=trace.rows.findIndex(r=>r.requestId===String(d.requestId));if(index<0)return;
  const rows=trace.rows.slice(),row=rows[index];
  rows[index]={...row,status:Number.isInteger(d.statusCode)?d.statusCode:null,durationMs:Math.max(0,Math.round(d.timeStamp-Date.parse(row.at))),failed:!!d.error};
  await chrome.storage.local.set({trace:{...trace,rows}});
 });
 chrome.webRequest?.onCompleted?.addListener(complete,{urls});
 chrome.webRequest?.onErrorOccurred?.addListener(complete,{urls});
 return {
  start:tabId=>enqueue(async()=>{const trace={active:true,tabId,startedAt:new Date().toISOString(),expiresAt:Date.now()+900000,rows:[]};await chrome.storage.local.set({trace});await chrome.alarms.create("trace-expiry",{delayInMinutes:15});return trace;}),
  stop:(reason="manual")=>enqueue(async()=>{const {trace}=await chrome.storage.local.get("trace");if(trace)await chrome.storage.local.set({trace:{...trace,active:false,stopReason:reason}});await chrome.alarms.clear("trace-expiry");}),
  clear:()=>enqueue(async()=>{await chrome.storage.local.remove("trace");await chrome.alarms.clear("trace-expiry");})
 };
}
