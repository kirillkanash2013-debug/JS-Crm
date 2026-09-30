import {license,accountId,adsUrl,period,validatePageSnapshot} from "./core.mjs";
import {captureVisible} from "./collector.mjs";
import {syncMeta,discoverSocial,graph} from "./meta.mjs";
import {inspectAdsSession} from "./session.mjs";
const init=Promise.all([
  chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"}),
  chrome.storage.session.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"})
]);
let busy=false;
async function read(){await init;return chrome.storage.local.get(["license","binding","snapshot","status","auto","range","social","reports","job","sessionDiagnostics"]);}
async function status(text,error=false){await chrome.storage.local.set({status:{text,error,at:new Date().toISOString()}});}
async function licensed(){const s=await read();if(!s.license) throw new Error("Сначала активируйте демонстрационный ключ.");return s;}
async function run(mode){
  if(busy) throw new Error("Обновление уже выполняется.");
  const s=await licensed();if(!s.binding) throw new Error("Сначала подключите вкладку Ads Manager.");
  busy=true;
  try{
    await status("Собираю данные…");
    let snapshot;
    if(mode==="api"){
      const {metaToken}=await chrome.storage.session.get("metaToken");
      if(!await chrome.permissions.contains({origins:["https://graph.facebook.com/*"]})) throw new Error("Разрешите доступ к Meta API в настройках расширения.");
      snapshot=await syncMeta(s.binding.accountId,s.range,metaToken,(t)=>status(t));
    }else{
      const r=await chrome.scripting.executeScript({target:{tabId:s.binding.tabId},func:captureVisible});
      snapshot=validatePageSnapshot(r[0]?.result,s.binding.accountId,new Date().toISOString());
    }
    await chrome.storage.local.set({snapshot});
    await status(snapshot.complete ? "API: все страницы отчёта получены." : "Снимок страницы сохранён. Полнота не подтверждена.");
    return snapshot;
  }catch(e){
    if(mode==="api"){await chrome.alarms.clear("sync");await chrome.storage.local.set({auto:false});}
    await status(e instanceof Error ? e.message : "Не удалось обновить данные.",true);throw e;
  }finally{busy=false;}
}

async function connectSocial(tabId,range) {
  range=period(range.since,range.until);
  await licensed();
  const tab=await chrome.tabs.get(tabId);
  if(!adsUrl(tab.url))throw new Error("Откройте Ads Manager в профиле подключаемого соца.");
  await status("Проверяю открытую FB-сессию…");
  const result=await chrome.scripting.executeScript({target:{tabId},world:"MAIN",func:inspectAdsSession});
  const found=result[0]?.result;
  if(!found)throw new Error("Не удалось прочитать контекст Ads Manager.");
  await chrome.storage.local.set({sessionDiagnostics:found.diagnostics});
  if(!/^\d{3,30}$/.test(found.userId || ""))throw new Error("Не найден ID авторизованного соца. Подождите загрузки Ads Manager и повторите.");
  if(!found.candidates?.length)throw new Error("Ads Manager не предоставил локальный API-доступ. Автоматическое подключение пока не поддержано для этой сессии.");
  const old=await read();
  if(old.social && old.social.user.id!==found.userId)throw new Error("В профиле другой FB-соц. Сначала отключите прежний соц.");
  let lastError;
  for(const candidate of found.candidates.slice(0,2)){
    try {
      const social=await discoverSocial(candidate.token,found.userId,t=>status(t));
      if(social.accounts.length>100)throw new Error("В прототипе поддерживается до 100 кабинетов на соц.");
      await chrome.storage.session.set({metaToken:candidate.token});
      await chrome.storage.local.set({social,range,sessionDiagnostics:{...found.diagnostics,validated:true,source:candidate.source},reports:old.social ? old.reports || {} : {}});
      await status("Соц подключён: "+social.accounts.length+" доступных кабинетов. Вкладки кабинетов привязывать не нужно.");
      return social;
    }catch(e){
      lastError=e;
      if(e.code!=="auth" && e.code!==190)break; // No retries on rate-limit/identity/permission errors.
    }
  }
  throw lastError || new Error("Не удалось проверить доступ к соцy.");
}
async function startWholeSync(){
  const s=await licensed();
  if(!s.social)throw new Error("Сначала подключите соц.");
  if(s.job?.state==="running")throw new Error("Сбор всего соца уже выполняется.");
  const {metaToken}=await chrome.storage.session.get("metaToken");
  if(!metaToken)throw new Error("Локальный доступ истёк. Подключите соц из Ads Manager заново.");
  period(s.range.since,s.range.until);
  const user=await graph("me",{fields:"id"},metaToken);
  if(String(user.id)!==s.social.user.id)throw new Error("Доступ относится к другому соцу.");
  const job={id:crypto.randomUUID(),state:s.social.accounts.length ? "running" : "done",userId:s.social.user.id,
    ids:s.social.accounts.map(a=>a.id),index:0,range:s.range,startedAt:new Date().toISOString(),errors:[],leaseUntil:0};
  await chrome.storage.local.set({job});
  await status(job.ids.length ? "Сбор соца запущен: "+job.ids.length+" кабинетов." : "Доступных кабинетов нет.");
  if(job.ids.length){await chrome.alarms.create("whole",{delayInMinutes:0.5});void processWhole().catch(()=>{});}
  return job;
}
async function processWhole(){
  if(busy)return;
  let s=await read(),job=s.job;
  if(job?.state!=="running" || job.leaseUntil>Date.now())return;
  const {metaToken}=await chrome.storage.session.get("metaToken");
  if(!metaToken){await chrome.storage.local.set({job:{...job,state:"needs_auth"}});await status("Сбор остановлен: подключите соц заново.",true);return;}
  if(!s.social || s.social.user.id!==job.userId)return;
  busy=true;
  try{
    // Lease is persisted before network calls. A dormant/restarted worker
    // resumes the current account instead of losing the entire collection.
    job={...job,leaseUntil:Date.now()+45000};await chrome.storage.local.set({job});
    await chrome.alarms.create("whole",{delayInMinutes:1});
    const id=job.ids[job.index];
    let snapshot;
    try{
      snapshot=await syncMeta(id,job.range,metaToken,t=>status((job.index+1)+"/"+job.ids.length+" · "+t));
    }catch(e){
      if([190,4,17,32,613,"identity"].includes(e.code)){
        await chrome.storage.local.set({job:{...job,state:"stopped",leaseUntil:0,errors:[...job.errors,{accountId:id,message:e.message}]}});
        await chrome.alarms.clear("whole");await status("Сбор остановлен: "+e.message,true);return;
      }
      job.errors.push({accountId:id,message:e.message});
    }
    const fresh=await read();
    // Ignore results after disconnect/reconnect/cancellation.
    if(fresh.job?.id!==job.id || fresh.job.state!=="running")return;
    if(snapshot)await chrome.storage.local.set({reports:{...(fresh.reports || {}),[id]:snapshot}});
    job={...job,index:job.index+1,leaseUntil:0,state:job.index+1>=job.ids.length ? "done" : "running"};
    await chrome.storage.local.set({job});
    await status(job.state==="done" ? "Сбор соца завершён. Кабинетов: "+job.ids.length+", ошибок: "+job.errors.length+"." :
      "Собрано "+job.index+"/"+job.ids.length+" кабинетов.");
    if(job.state==="done")await chrome.alarms.clear("whole");
  }catch(e){await status("Сбор остановился: "+e.message,true);}
  finally{
    busy=false;
    const fresh=await read();
    if(fresh.job?.id===job.id && fresh.job.state==="running" && !fresh.job.leaseUntil)
      void processWhole().catch(()=>{});
  }
}

async function command(m){
  switch(m.type){
    case "CONNECT_SOCIAL":{if(busy)throw new Error("Подождите окончания сбора.");return connectSocial(m.tabId,{since:m.since,until:m.until});}
    case "SYNC_SOCIAL":return startWholeSync();
    case "CANCEL_SOCIAL":{const s=await read();if(s.job)await chrome.storage.local.set({job:{...s.job,state:"cancelled"}});await chrome.alarms.clear("whole");await status("Сбор остановлен.");return true;}
    case "STATE":{const s=await read();const {metaToken}=await chrome.storage.session.get("metaToken");return {...s,hasMetaToken:!!metaToken,busy};}
    case "ACTIVATE":{await chrome.storage.local.set({license:license(m.key)});await status("Демо активировано. Откройте Ads Manager.");return true;}
    case "CONNECT":{
      await licensed();
      const tab=await chrome.tabs.get(m.tabId);
      if(!adsUrl(tab.url)) throw new Error("Откройте вкладку Meta Ads Manager и нажмите значок расширения в ней.");
      const u=new URL(tab.url),id=accountId(u.searchParams.get("act"));
      const old=await read();
      if(old.binding && old.binding.accountId!==id) {
        await chrome.storage.local.remove("snapshot");await chrome.storage.session.remove("metaToken");
        await chrome.alarms.clear("sync");await chrome.storage.local.set({auto:false});
      }
      await chrome.storage.local.set({binding:{accountId:id,tabId:tab.id},range:period(m.since,m.until)});
      await status("Кабинет "+id+" выбран. Доступ к данным ещё не проверен.");
      return {accountId:id};
    }
    case "RANGE":{await licensed();await chrome.storage.local.set({range:period(m.since,m.until)});return true;}
    case "TOKEN":{
      await licensed();if(!/^[A-Za-z0-9_|-]{20,4096}$/.test(m.token || "")) throw new Error("Некорректный формат токена Meta.");
      await chrome.storage.session.set({metaToken:m.token});await status("Токен сохранён до закрытия браузера. Нажмите «Собрать через API».");return true;
    }
    case "SYNC":return run(m.mode === "api" ? "api" : "visible");
    case "AUTO":{
      const s=await licensed();const {metaToken}=await chrome.storage.session.get("metaToken");
      if(m.enabled && (!s.binding || !metaToken || !s.snapshot?.complete || s.snapshot.account.id!==s.binding.accountId)) throw new Error("Сначала выполните успешный сбор через API.");
      if(m.enabled) await chrome.alarms.create("sync",{periodInMinutes:60});else await chrome.alarms.clear("sync");
      await chrome.storage.local.set({auto:!!m.enabled});return true;
    }
    case "DISCONNECT":{
      await chrome.alarms.clear("sync");await chrome.alarms.clear("whole");await chrome.storage.local.remove(["binding","snapshot","range","social","reports","job","sessionDiagnostics"]);
      await chrome.storage.session.remove("metaToken");await chrome.storage.local.set({auto:false});
      await status("Кабинет отключён; локальные данные удалены.");return true;
    }
    default:throw new Error("Неизвестная команда.");
  }
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL("panel.html")) return false;
  command(m).then(data=>reply({ok:true,data})).catch(e=>reply({ok:false,error:e.message || "Ошибка."}));
  return true;
});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==="whole")void processWhole().catch(()=>{});if(a.name==="sync") void run("api").catch(()=>{});});
chrome.runtime.onStartup.addListener(()=>{
  void (async()=>{await init;await chrome.alarms.clear("sync");await chrome.storage.local.set({auto:false});const s=await read();if(s.job?.state==="running")await chrome.storage.local.set({job:{...s.job,state:"needs_auth",leaseUntil:0}});await chrome.alarms.clear("whole");await status("Браузер запущен. Подключите соц для восстановления локального доступа.");})().catch(()=>{});
});
