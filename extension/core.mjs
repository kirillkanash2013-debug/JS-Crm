export const DEMO_KEY = "js_demo_K7mQ2vN8xR4pT9cW6aY3";
export function license(key) {
  if (String(key || "").trim() !== DEMO_KEY) throw new Error("Ключ не распознан. Для прототипа используйте демонстрационный ключ.");
  return {mode:"demo",plan:"Prototype",socialLimit:1,accountLimit:null,expiresAt:null};
}
export function accountId(value) {
  const id = String(value || "").replace(/^act_/, "");
  if (!/^\d{3,30}$/.test(id)) throw new Error("Нужен числовой ID рекламного кабинета.");
  return id;
}
export function adsUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && (
      u.hostname === "adsmanager.facebook.com" ||
      (["business.facebook.com", "www.facebook.com"].includes(u.hostname) && /^\/adsmanager(?:\/|$)/.test(u.pathname))
    );
  } catch { return false; }
}
export function period(since, until) {
  for (const d of [since, until]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || new Date(d + "T00:00:00Z").toISOString().slice(0,10) !== d) throw new Error("Некорректная дата.");
  }
  const days = (Date.parse(until) - Date.parse(since)) / 86400000;
  if (days < 0 || days > 30) throw new Error("Выберите период от 1 до 31 дня.");
  return {since,until};
}
export function decimal(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (!/^\d+(?:\.\d+)?$/.test(String(value))) return null;
  const n=Number(value); return Number.isFinite(n) ? n : null;
}
export function apiSnapshot(account, campaigns, insights, range, now) {
  const id=accountId(account.account_id || account.id);
  if(!/^[A-Z]{3}$/.test(account.currency || "")) throw new Error("В API отсутствует валюта кабинета.");
  const map=new Map();
  for (const c of campaigns) {
    if (accountId(c.account_id) !== id || !/^\d{3,30}$/.test(String(c.id))) throw new Error("API вернул кампанию другого кабинета или неверный ID.");
    map.set(String(c.id), {id:String(c.id),name:String(c.name || ""),accountId:id,status:String(c.status || "UNKNOWN"),
      effectiveStatus:String(c.effective_status || "UNKNOWN"),dailyBudgetRaw:c.daily_budget ?? null,lifetimeBudgetRaw:c.lifetime_budget ?? null});
  }
  const metrics=[], seen=new Set();
  for (const i of insights) {
    if (accountId(i.account_id) !== id) throw new Error("Статистика другого кабинета.");
    period(i.date_start,i.date_stop);
    if(i.date_start < range.since || i.date_stop > range.until) throw new Error("Статистика за другой период.");
    const spend=decimal(i.spend);
    if(spend === null) throw new Error("Некорректный spend в API.");
    const cid=String(i.campaign_id);
    if(!/^\d{3,30}$/.test(cid) || i.account_currency !== account.currency) throw new Error("Неверный Campaign ID или валюта.");
    const key=cid+"|"+i.date_start+"|"+i.date_stop;
    if(seen.has(key)) throw new Error("API вернул дубликаты статистики.");
    seen.add(key);
    if(!map.has(cid)) map.set(cid,{id:cid,name:String(i.campaign_name || ""),accountId:id,status:"UNKNOWN",effectiveStatus:"UNKNOWN",dailyBudgetRaw:null,lifetimeBudgetRaw:null});
    metrics.push({campaignId:cid,since:i.date_start,until:i.date_stop,spend,currency:account.currency});
  }
  return {schemaVersion:1,source:"meta_api",observedAt:now,account:{id,name:account.name || "",currency:account.currency,
    timezone:account.timezone_name || null,statusRaw:account.account_status ?? null},period:range,complete:true,
    campaigns:[...map.values()],metrics,limits:{scope:"one_account",campaigns:"accessible_api_records"}};
}
export function validatePageSnapshot(raw, id, now) {
  if(!raw || raw.accountId !== id) throw new Error("Во вкладке выбран другой кабинет. Откройте нужный кабинет и подключите его снова.");
  return {schemaVersion:1,source:"ads_manager_visible",observedAt:now,account:{id,name:"",currency:null,timezone:null},
    period:null,complete:false,campaigns:visibleCampaigns(raw.tables || [],id),metrics:[],
    visibleTables:(raw.tables || []).slice(0,4).map(t=>({
      headers:(t.headers || []).slice(0,40).map(x=>String(x).slice(0,150)),
      rows:(t.rows || []).slice(0,200).map(r=>r.slice(0,40).map(x=>String(x).slice(0,500)))
    })),diagnostics:{title:String(raw.title || "").slice(0,150),visibleRowCount:raw.visibleRowCount || 0,
      sessionVerified:false,note:"Только загруженные строки страницы; период, валюта и полнота не подтверждены."}};
}
export function nextPage(value, base) {
  const u=new URL(value);
  const first=new URL(base);
  if(u.origin !== "https://graph.facebook.com" || u.pathname !== first.pathname || u.username || u.password || u.hash) throw new Error("API вернул небезопасный адрес пагинации.");
  u.searchParams.delete("access_token"); u.searchParams.delete("appsecret_proof");
  return u.href;
}

export function visibleCampaigns(tables,id) {
  const out=new Map();
  for(const t of tables) {
    const hs=(t.headers || []).map(h=>String(h).trim().toLowerCase());
    const ci=hs.findIndex(h=>/^(campaign id|id кампании|идентификатор кампании)$/.test(h));
    const ni=hs.findIndex(h=>/^(campaign|campaign name|кампания|название кампании)$/.test(h));
    if(ci<0 || ni<0) continue;
    for(const r of (t.rows || []).slice(0,200)) {
      const cid=String(r[ci] || "").trim();
      if(!/^\d{3,30}$/.test(cid)) continue;
      out.set(cid,{id:cid,name:String(r[ni] || "").slice(0,500),accountId:id,status:"UNKNOWN",effectiveStatus:"UNKNOWN",dailyBudgetRaw:null,lifetimeBudgetRaw:null});
    }
  }
  return [...out.values()];
}
