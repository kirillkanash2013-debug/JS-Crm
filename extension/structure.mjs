import {graph,pages} from "./meta.mjs";
const numeric=v=>typeof v==="string" && /^\d{3,30}$/.test(v);
export function validateStructure(account,campaigns,adsets,ads){
 const id=String(account.account_id || "");if(!numeric(id))throw new Error("Не найден ID кабинета структуры.");
 const clean=(rows,kind)=>{
  const seen=new Set();return rows.map(row=>{
   const rid=String(row.id || "");if(!numeric(rid)||seen.has(rid)||String(row.account_id)!==id)throw new Error("Неверная принадлежность или повтор ID в структуре: "+kind);
   seen.add(rid);const result={id:rid,accountId:id,name:String(row.name || "").slice(0,300),status:String(row.status || "").slice(0,40),effectiveStatus:String(row.effective_status || "").slice(0,40)};
   for(const [source,target] of [["campaign_id","campaignId"],["adset_id","adsetId"]])if(row[source]!==undefined){if(!numeric(String(row[source])))throw new Error("Неверный родитель объекта.");result[target]=String(row[source]);}
   for(const source of ["daily_budget","lifetime_budget"])if(row[source]!==undefined){const budget=String(row[source]);if(!/^\d{1,16}$/.test(budget))throw new Error("Неверный бюджет Meta.");result[source]=budget;}
   return result;
  });
 };
 const c=clean(campaigns,"campaigns"),s=clean(adsets,"adsets"),a=clean(ads,"ads"),cm=new Map(c.map(x=>[x.id,x])),sm=new Map(s.map(x=>[x.id,x]));
 for(const row of s)if(!cm.has(row.campaignId))throw new Error("Группа не связана с найденной кампанией.");
 for(const row of a)if(!sm.has(row.adsetId)||!cm.has(row.campaignId)||sm.get(row.adsetId).campaignId!==row.campaignId)throw new Error("Объявление не связано с найденной группой и кампанией.");
 return {schemaVersion:1,complete:true,observedAt:new Date().toISOString(),account:{id,name:String(account.name || "").slice(0,300),currency:String(account.currency || "").slice(0,3)},campaigns:c,adsets:s,ads:a};
}
export async function syncStructure(id,token,progress,fetcher){
 const account=await graph("act_"+id,{fields:"account_id,name,currency"},token,fetcher);
 if(String(account.account_id)!==id)throw new Error("Структура относится к другому кабинету.");
 const read=async(edge,fields)=>{await progress("Структура: "+edge);return pages("act_"+id+"/"+edge,{fields,limit:100},token,fetcher);};
 const campaigns=await read("campaigns","id,name,account_id,status,effective_status,daily_budget,lifetime_budget");
 const adsets=await read("adsets","id,name,account_id,campaign_id,status,effective_status,daily_budget,lifetime_budget");
 const ads=await read("ads","id,name,account_id,campaign_id,adset_id,status,effective_status");
 return validateStructure(account,campaigns,adsets,ads);
}
