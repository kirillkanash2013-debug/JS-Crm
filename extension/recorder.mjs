const facebookHost=host=>host==="facebook.com" || host.endsWith(".facebook.com");
const PATH_WORDS=new Set(["api","graphql","graphqlbatch","ajax","ads","manage","creation","edit","update","publish","batch","campaigns","adsets","ads","insights","businesses","me"]);
function safePath(path){return path.split("/").map(p=>!p?"":PATH_WORDS.has(p)?p:/^v\d+\.\d+$/.test(p)?p:/^(?:act_)?\d+$/.test(p)?":id":":segment").join("/").slice(0,220);}
const SECRET=/token|cookie|authorization|password|secret|fb_dtsg|jazoest|session/i;
function safeKey(key){return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) && !SECRET.test(key) && !/^EA[A-Za-z0-9]{18,}$/.test(key);}
function operationName(value){
 return typeof value==="string" && /^[A-Za-z_][A-Za-z0-9_]{1,159}$/.test(value) && !SECRET.test(value) && !/^EA/.test(value) && !/\d{12}/.test(value) ? value : null;
}
function shape(value,out,depth=0,path="",budgetContext=false){
 if(depth>8 || out.nodes++>1500){out.truncated=true;return;}
 if(typeof value==="string" && value.length<=262144 && /^[\s]*[\[{]/.test(value)){
  try{shape(JSON.parse(value),out,depth+1,path,budgetContext);}catch{}return;
 }
 if(!value || typeof value!=="object")return;
 if(Array.isArray(value)){for(const item of value.slice(0,50))shape(item,out,depth+1,path+"[]",budgetContext);return;}
 for(const [key,item] of Object.entries(value).slice(0,150)){
  if(!safeKey(key))continue;
  const normalized=key.replace(/([a-z])([A-Z])/g,"$1_$2").toLowerCase();
  const next=(path ? path+"." : "")+key;
  if(out.fields.size<150)out.fields.add(key);else out.truncated=true;
  if(out.shapes.length<150)out.shapes.push({path:next.slice(0,220),type:item===null?"null":Array.isArray(item)?"array":typeof item});
  if(["fb_api_req_friendly_name","operation_name","operationname"].includes(normalized)){const name=operationName(item);if(name)out.operations.add(name);}
  if(normalized==="doc_id" && /^\d{1,30}$/.test(String(item)))out.docIds.add(String(item));
  if(normalized==="relative_url" && typeof item==="string" && item.length<=262144){try{const relative=new URL(item,"https://graph.facebook.com/");const parameters={};for(const [k,v] of relative.searchParams)if(safeKey(k))parameters[k]=v;shape(parameters,out,depth+1,next+".params",budgetContext);}catch{}}
  if(normalized==="method" && ["GET","POST","DELETE"].includes(item))out.batchMethods.add(item);
  let change;
  if(["status","effective_status","configured_status"].includes(normalized) && ["ACTIVE","PAUSED","ARCHIVED","DELETED"].includes(item))change=item;
  if(["is_enabled","is_active","enabled"].includes(normalized) && typeof item==="boolean")change=item;
  const budget=["daily_budget","lifetime_budget","budget_amount","budget_value","budget"].includes(normalized);
  if((budget || (budgetContext && ["amount","value"].includes(normalized))) && ["string","number"].includes(typeof item) && /^\d{1,12}(?:\.\d{1,4})?$/.test(String(item)))change=String(item);
  if(change!==undefined && out.changeCandidates.length<60){out.changes[normalized]=change;out.changeCandidates.push({path:next.slice(0,220),field:normalized,value:change});}
  if((item && typeof item==="object") || typeof item==="string")shape(item,out,depth+1,next,budgetContext||budget);
 }
}
export function traceRequest(details,recorder,now=Date.now()){
 if(!recorder?.active || recorder.expiresAt<=now || details.tabId!==recorder.tabId)return null;
 let u;try{u=new URL(details.url);}catch{return null;}
 if(u.protocol!=="https:" || !facebookHost(u.hostname))return null;
 if(details.initiator){try{if(!facebookHost(new URL(details.initiator).hostname))return null;}catch{return null;}}
 const knownRoute=u.hostname==="graph.facebook.com" || u.hostname==="adsmanager-graph.facebook.com" || /(?:graphql|\/ajax\/ads\/)/.test(u.pathname);
 // Unknown Facebook fetch/XHR/POST endpoints are retained as masked metadata.
 // This reveals routing blind spots without storing page URLs or arbitrary bodies.
 if(!knownRoute && !["xmlhttprequest","ping"].includes(details.type) && !["POST","PUT","PATCH","DELETE"].includes(details.method))return null;
 const path=safePath(u.pathname);
 const values={};for(const [k,v] of (knownRoute ? u.searchParams : []))if(safeKey(k))values[k]=v;
 const body=knownRoute ? details.requestBody : null;
 let bodyFormat="none";
 if(body?.formData){bodyFormat="form";for(const [k,v] of Object.entries(body.formData))if(safeKey(k))values[k]=v[0];}
 else if(body?.raw){
  bodyFormat="unreadable";
  try{
   const chunks=body.raw.filter(x=>x.bytes).map(x=>new Uint8Array(x.bytes));const size=chunks.reduce((n,x)=>n+x.length,0);
   if(size>0 && size<=262144){const bytes=new Uint8Array(size);let i=0;for(const c of chunks){bytes.set(c,i);i+=c.length;}
    const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    if(/^[\s]*[\[{]/.test(text)){const obj=JSON.parse(text);bodyFormat="json";if(Array.isArray(obj))values.requests=obj;else for(const [k,v] of Object.entries(obj))if(safeKey(k))values[k]=v;}
    else {bodyFormat="form";for(const [k,v] of new URLSearchParams(text))if(safeKey(k))values[k]=v;}
   }
  }catch{}
 }
 const out={fields:new Set(),changes:{},changeCandidates:[],shapes:[],operations:new Set(),docIds:new Set(),batchMethods:new Set(),nodes:0,truncated:false};shape(values,out);
 const operation=[...out.operations][0] || null;
 const kind=[...out.operations].some(n=>n.endsWith("Mutation")) ? "mutation-candidate" : operation?.endsWith("Query") ? "query" : "unknown";
 return {requestId:String(details.requestId),at:new Date(details.timeStamp || now).toISOString(),host:u.hostname,path,knownRoute,resourceType:["xmlhttprequest","ping","other","main_frame","sub_frame"].includes(details.type)?details.type:"other",method:["GET","POST","OPTIONS","PUT","PATCH","DELETE"].includes(details.method)?details.method:"OTHER",operation,operations:[...out.operations].slice(0,30),kind,batchMethods:[...out.batchMethods],docIds:[...out.docIds].slice(0,30),docId:/^\d{1,30}$/.test(String(values.doc_id || ""))?String(values.doc_id):null,fields:[...out.fields].sort(),changes:out.changes,changeCandidates:out.changeCandidates,shape:out.shapes,truncated:out.truncated,bodyFormat,status:null,durationMs:null};
}
export function installRecorder(chrome){
 let queue=Promise.resolve();
 const enqueue=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
 const urls=["https://*.facebook.com/*"];
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
