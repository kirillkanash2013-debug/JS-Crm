import {license,accountId,adsUrl,period,validatePageSnapshot} from "./core.mjs";
import {captureVisible} from "./collector.mjs";
import {syncMeta} from "./meta.mjs";
const init=Promise.all([
  chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"}),
  chrome.storage.session.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"})
]);
let busy=false;
async function read(){await init;return chrome.storage.local.get(["license","binding","snapshot","status","auto","range"]);}
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
async function command(m){
  switch(m.type){
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
      await chrome.alarms.clear("sync");await chrome.storage.local.remove(["binding","snapshot","range"]);
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
chrome.alarms.onAlarm.addListener(a=>{if(a.name==="sync") void run("api").catch(()=>{});});
chrome.runtime.onStartup.addListener(()=>{
  void (async()=>{await init;await chrome.alarms.clear("sync");await chrome.storage.local.set({auto:false});await status("Браузер запущен. Токен API нужно подключить заново.");})().catch(()=>{});
});
