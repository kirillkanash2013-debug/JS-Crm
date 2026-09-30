import {accountId,period,apiSnapshot,nextPage} from "./core.mjs";
export class MetaError extends Error {
  constructor(code,message) {super(message);this.code=code;}
}
export async function graph(path, params, token, fetcher=fetch) {
  if(!token) throw new MetaError("auth","Введите разрешённый токен Meta API в расширении.");
  const u=new URL("https://graph.facebook.com/v25.0/"+path);
  for(const [k,v] of Object.entries(params || {})) u.searchParams.set(k, typeof v==="object" ? JSON.stringify(v) : String(v));
  return request(u.href,token,fetcher);
}
async function request(url,token,fetcher) {
  const r=await fetcher(url,{method:"GET",headers:{Authorization:"Bearer "+token},credentials:"omit",redirect:"error",signal:AbortSignal.timeout(20000)});
  let body;
  try {body=await r.json();} catch {throw new MetaError("response","Meta вернула ответ, который невозможно прочитать.");}
  if(!r.ok || body.error) {
    const code=Number(body.error?.code || 0);
    const message=code===190 ? "Токен Meta недействителен или истёк." :
      [4,17,32,613].includes(code) ? "Meta ограничила частоту запросов. Автообновление остановлено." :
      [10,200,294].includes(code) ? "У токена нет нужного доступа к этому кабинету." : "Ошибка Meta API (код "+code+").";
    throw new MetaError(code,message);
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
