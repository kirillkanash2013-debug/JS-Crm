import {accountId,period,apiSnapshot,nextPage} from "./core.mjs";
const batchTokens=new Set();
export function clearMetaTransport(){batchTokens.clear();}
export class MetaError extends Error {
  constructor(code,message) {super(message);this.code=code;}
}
export function redactMetaDetail(value,token=""){
  let text=typeof value==="string" ? value : "";
  if(token)text=text.split(token).join("[removed]");
  return text.replace(/https?:\/\/\S+/gi,"[url removed]")
    .replace(/\b(?:access_token|appsecret_proof|authorization|cookie)\s*[:=]\s*\S+/gi,"[credential removed]")
    .replace(/\bEA[A-Za-z0-9_-]{18,4094}\b/g,"[token removed]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,"[email removed]")
    .replace(/\b[A-Za-z0-9_|-]{20,}\b/g,"[identifier removed]")
    .replace(/\b\d{5,}\b/g,"[id removed]")
    .replace(/[\u0000-\u001f\u007f]/g," ").slice(0,350);
}
export function safeMetaFailure(error){
  return {
    code:typeof error.code==="number" && Number.isFinite(error.code) ? error.code : "unknown",
    stage:["identity","adaccounts"].includes(error.stage) ? error.stage : "unknown",
    httpStatus:Number.isInteger(error.httpStatus) ? error.httpStatus : null,
    subcode:Number.isInteger(error.subcode) ? error.subcode : null,
    transient:error.transient===true,
    reason:["unknown-api-error","unsupported-request","token-validation","permission","unclassified"].includes(error.reason) ? error.reason : "unclassified",
    detail:redactMetaDetail(error.detail)
  };
}
export async function graph(path, params, token, fetcher=fetch) {
  if(!token) throw new MetaError("auth","Введите разрешённый токен Meta API в расширении.");
  const u=new URL("https://graph.facebook.com/v25.0/"+path);
  for(const [k,v] of Object.entries(params || {})) u.searchParams.set(k, typeof v==="object" ? JSON.stringify(v) : String(v));
  return request(u.href,token,fetcher);
}
async function request(url,token,fetcher) {
  if(batchTokens.has(token))return batchRead(url,token,fetcher);
  const r=await fetcher(url,{method:"GET",headers:{Authorization:"Bearer "+token},credentials:"omit",redirect:"error",signal:AbortSignal.timeout(20000)});
  try{return await decodeResponse(r,token);}catch(error){
    // One read-only transport fallback for the exact observed rejection.
    // No fallback/retry for expired tokens, permissions or rate limits.
    if(fetcher.pageContext || error.code!==1 || error.transient || error.detail!=="Invalid request.")throw error;
    const result=await batchRead(url,token,fetcher);
    if(batchTokens.size>=2)batchTokens.clear();batchTokens.add(token);
    return result;
  }
}
async function batchRead(url,token,fetcher){
  const u=new URL(url);
  if(u.origin!=="https://graph.facebook.com" || !/^\/v25\.0\//.test(u.pathname) || u.searchParams.has("access_token"))throw new MetaError("transport","Небезопасный адрес Meta API.");
  const relative=u.pathname.slice("/v25.0/".length)+u.search;
  const body=new URLSearchParams({access_token:token,batch:JSON.stringify([{method:"GET",relative_url:relative}])});
  const response=await fetcher("https://graph.facebook.com/v25.0/",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:body.toString(),credentials:"omit",redirect:"error",signal:AbortSignal.timeout(20000)});
  const replies=await decodeResponse(response,token);
  if(!Array.isArray(replies) || replies.length!==1 || !Number.isInteger(replies[0]?.code) || typeof replies[0]?.body!=="string")throw new MetaError("response","Meta вернула некорректный пакетный ответ.");
  const item=replies[0];
  return decodeResponse({ok:item.code>=200 && item.code<300,status:item.code,json:async()=>JSON.parse(item.body)},token);
}
async function decodeResponse(r,token){
  let body;
  try {body=await r.json();} catch {const error=new MetaError("response","Meta вернула ответ, который невозможно прочитать.");error.httpStatus=r.status;error.transient=r.status===429||r.status>=500;throw error;}
  if(!r.ok || body.error) {
    const code=Number(body.error?.code || 0);
    const message=code===190 ? "Токен Meta недействителен или истёк." :
      [4,17,32,613].includes(code) ? "Meta ограничила частоту запросов. Автообновление остановлено." :
      [10,200,294].includes(code) ? "У токена нет нужного доступа к этому кабинету." : "Ошибка Meta API (код "+code+").";
    const error=new MetaError(code,message);
    error.httpStatus=r.status;
    error.subcode=Number.isInteger(body.error?.error_subcode) ? body.error.error_subcode : null;
    error.transient=body.error?.is_transient===true||r.status===429||r.status>=500;
    error.detail=redactMetaDetail(body.error?.message,token);
    // Classify locally; never retain or export Meta's raw error text.
    const raw=String(body.error?.message || "").toLowerCase();
    error.reason=raw.includes("unknown error") ? "unknown-api-error" :
      raw.includes("unsupported get request") || raw.includes("unknown path") ? "unsupported-request" :
      raw.includes("validating access token") ? "token-validation" :
      raw.includes("permission") ? "permission" : "unclassified";
    throw error;
  }
  return body;
}
export async function pages(path,params,token,fetcher=fetch) {
  const base=new URL("https://graph.facebook.com/v25.0/"+path).href;
  let body=await graph(path,params,token,fetcher), all=[],visited=new Set();
  for(let page=0;page<100;page++) {
    if(!Array.isArray(body.data)) throw new MetaError("shape","API не вернул список.");
    all.push(...body.data);
    if(all.length>20000) throw new MetaError("limit","Слишком большой отчёт. Сократите период.");
    if(!body.paging?.next) return all;
    const next=nextPage(body.paging.next,base);
    if(visited.has(next)) throw new MetaError("paging","Повтор страницы API.");
    visited.add(next);
    body=await request(next,token,fetcher);
  }
  throw new MetaError("limit","Не удалось получить все страницы API. Частичные данные не сохранены.");
}
export async function syncMeta(id,range,token,progress=()=>{},fetcher=fetch) {
  id=accountId(id);range=period(range.since,range.until);
  await progress("Проверяю кабинет…");
  const account=await graph("act_"+id,{fields:"account_id,name,currency,timezone_name,account_status"},token,fetcher);
  if(accountId(account.account_id)!==id) throw new MetaError("account","Получен другой кабинет.");
  await progress("Получаю кампании…");
  const campaigns=await pages("act_"+id+"/campaigns",{fields:"id,name,account_id,status,effective_status,daily_budget,lifetime_budget",limit:100},token,fetcher);
  await progress("Получаю spend по дням…");
  const insights=await pages("act_"+id+"/insights",{fields:"account_id,campaign_id,campaign_name,spend,account_currency,date_start,date_stop",level:"campaign",time_range:range,time_increment:1,limit:100},token,fetcher);
  return apiSnapshot(account,campaigns,insights,range,new Date().toISOString());
}

export async function discoverSocial(token,expectedUserId,progress=()=>{},fetcher=fetch) {
  await progress("Проверяю Facebook-соц…");
  let user;
  try{user=await graph("me",{fields:"id,name"},token,fetcher);}catch(e){e.stage="identity";throw e;}
  if(!/^\d{3,30}$/.test(String(user.id || ""))) throw new MetaError("identity","Meta не вернула FB user ID.");
  if(expectedUserId && String(user.id)!==String(expectedUserId)) throw new MetaError("identity","Доступ относится к другому FB-пользователю. Подключение остановлено.");
  await progress("Получаю список доступных кабинетов…");
  let accounts;
  try{accounts=await pages(String(user.id)+"/adaccounts",{fields:"account_id,name,currency,timezone_name,account_status,business{id,name}",limit:100},token,fetcher);}catch(e){e.stage="adaccounts";throw e;}
  const seen=new Set(),businesses=new Map();
  const clean=accounts.map(a=>{
    const id=accountId(a.account_id);
    if(seen.has(id))throw new MetaError("duplicate","Повтор кабинета в ответе Meta.");seen.add(id);
    const bm=a.business?.id ? {id:String(a.business.id),name:String(a.business.name || "")} : null;
    if(bm)businesses.set(bm.id,bm);
    return {id,name:String(a.name || ""),currency:String(a.currency || ""),timezone:a.timezone_name || null,statusRaw:a.account_status ?? null,business:bm};
  });
  // Fan pages the user manages — best effort: a plain Ads Manager token often
  // lacks the pages scope, so a failure just means an empty list, never a stop.
  let fanPages=[];
  try{const list=await pages(String(user.id)+"/accounts",{fields:"id,name",limit:100},token,fetcher);
    const pseen=new Set();fanPages=list.filter(p=>p?.id&&!pseen.has(String(p.id))&&pseen.add(String(p.id))).map(p=>({id:String(p.id),name:String(p.name||"")}));
  }catch(e){}
  return {schemaVersion:1,user:{id:String(user.id),name:String(user.name || "")},accounts:clean,businesses:[...businesses.values()],fanPages,
    discoveredAt:new Date().toISOString(),accountsComplete:true,businessesComplete:false,
    scope:"Кабинеты, доступные через этот токен; БМ — только связанные с найденными кабинетами."};
}
