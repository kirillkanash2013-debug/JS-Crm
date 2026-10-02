import {serverCommand,serverOrigin,savedServer} from "./server-link.mjs";
import {DEFAULT_SERVER,SCHEDULE_MINUTES,isServerKey,summarizeServer} from "./client.mjs";
import {syncStructure} from "./structure.mjs";
import {installRecorder} from "./recorder.mjs";
import {pageFetcher} from "./page-transport.mjs";
import {license,accountId,adsUrl,period,validatePageSnapshot} from "./core.mjs";
import {captureVisible} from "./collector.mjs";
import {syncMeta,discoverSocial,graph,safeMetaFailure,clearMetaTransport} from "./meta.mjs";
import {inspectAdsSession} from "./session.mjs";
import {requestCredential} from "./network.mjs";
const init=Promise.all([
  chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"}),
  chrome.storage.session.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"})
]);
const recorder=installRecorder(chrome);
let busy=false;
let captureQueue=Promise.resolve();
chrome.webRequest?.onBeforeRequest.addListener(details=>{
  captureQueue=captureQueue.then(async()=>{
    await init;
    const {networkCapture}=await chrome.storage.session.get("networkCapture");
    const credential=requestCredential(details,networkCapture);
    if(!credential)return;
    const next={...networkCapture,requests:networkCapture.requests+1};
    if(credential.token && !next.candidates.some(c=>c.token===credential.token) && next.candidates.length<2)
      next.candidates=[...next.candidates,{token:credential.token,source:"selected-tab-api-request"}];
    await chrome.storage.session.set({networkCapture:next});
    const s=await read();
    await chrome.storage.local.set({sessionDiagnostics:{...s.sessionDiagnostics,network:{state:next.candidates.length ? "ready" : "waiting",requests:next.requests,candidateCount:next.candidates.length}}});
    if(next.candidates.length)await status("Доступ обнаружен в запросе Ads Manager. Нажмите «Подключить соц» ещё раз для проверки.");
  }).catch(()=>{});
},{urls:["https://graph.facebook.com/*"]},["requestBody"]);
async function read(){await init;return chrome.storage.local.get(["license","binding","snapshot","status","auto","range","social","reports","job","sessionDiagnostics","trace","structures"]);}
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
      const {metaToken,socialTabId}=await chrome.storage.session.get(["metaToken","socialTabId"]);
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

async function connectSocial(tabId,range,suppliedToken) {
  range=period(range.since,range.until);
  if(suppliedToken!==undefined && (typeof suppliedToken!=="string" || !/^EA[A-Za-z0-9_-]{18,4094}$/.test(suppliedToken)))throw new Error("Вставьте токен доступа Facebook. Демонстрационный ключ JS Control здесь не подходит.");
  await licensed();
  const tab=await chrome.tabs.get(tabId);
  if(!adsUrl(tab.url))throw new Error("Откройте Ads Manager в профиле подключаемого соца.");
  await status("Проверяю открытую FB-сессию…");
  const result=await chrome.scripting.executeScript({target:{tabId},world:"MAIN",func:inspectAdsSession});
  const found=result[0]?.result;
  if(!found)throw new Error("Не удалось прочитать контекст Ads Manager.");
  if(!/^\d{3,30}$/.test(found.userId || ""))throw new Error("Не найден ID авторизованного соца. Подождите загрузки Ads Manager и повторите.");
  if(suppliedToken!==undefined){
    found.candidates=[{token:suppliedToken,source:"local-token-import"}];
    found.diagnostics={...found.diagnostics,method:"local-token-import",candidateCount:1};
  }
  await captureQueue;
  const {networkCapture}=await chrome.storage.session.get("networkCapture");
  if(suppliedToken===undefined && networkCapture?.tabId===tabId && networkCapture.userId===found.userId && networkCapture.expiresAt>Date.now())
    found.candidates=[...(found.candidates || []),...networkCapture.candidates].slice(0,2);
  await chrome.storage.local.set({sessionDiagnostics:found.diagnostics});
  if(!found.candidates?.length){
    if(networkCapture?.tabId===tabId && networkCapture.userId===found.userId && networkCapture.expiresAt>Date.now()){
      await chrome.storage.local.set({sessionDiagnostics:{...found.diagnostics,network:{state:"waiting",requests:networkCapture.requests,candidateCount:0}}});
      await status("В запросах пока нет доступа. Запросов Meta API: "+networkCapture.requests+". Перезагрузите эту вкладку Ads Manager и повторите подключение.");
      return {pending:true};
    }
    await chrome.storage.session.set({networkCapture:{tabId,userId:found.userId,origin:new URL(tab.url).origin,expiresAt:Date.now()+300000,requests:0,candidates:[]}});
    await chrome.alarms.create("capture-expiry",{delayInMinutes:5});
    await chrome.storage.local.set({sessionDiagnostics:{...found.diagnostics,network:{state:"waiting",requests:0,candidateCount:0}}});
    await status("Наблюдение включено на 5 минут. Закройте окно расширения, перезагрузите эту вкладку Ads Manager, затем снова нажмите «Подключить соц».");
    return {pending:true};
  }
  const old=await read();
  if(old.social && old.social.user.id!==found.userId)throw new Error("В профиле другой FB-соц. Сначала отключите прежний соц.");
  let lastError;
  for(const candidate of found.candidates.slice(0,2)){
    try {
      const social=await discoverSocial(candidate.token,found.userId,t=>status(t),pageFetcher(tabId,found.userId));
      if(social.accounts.length>100)throw new Error("В прототипе поддерживается до 100 кабинетов на соц.");
      await chrome.storage.session.set({metaToken:candidate.token,socialTabId:tabId});
      await chrome.storage.session.remove("networkCapture");await chrome.alarms.clear("capture-expiry");
      await chrome.storage.local.set({social,range,sessionDiagnostics:{...found.diagnostics,validated:true,source:candidate.source,transport:"adsmanager-page-xhr"},reports:old.social ? old.reports || {} : {}});
      await status("Соц подключён: "+social.accounts.length+" доступных кабинетов. Вкладки кабинетов привязывать не нужно.");
      return social;
    }catch(e){
      lastError=e;
      const failure=safeMetaFailure(e);
      await chrome.storage.local.set({sessionDiagnostics:{...found.diagnostics,failure}});
      await status((failure.stage==="identity" ? "Проверка владельца токена" : failure.stage==="adaccounts" ? "Получение списка кабинетов" : "Подключение")+": "+e.message,true);
      if(e.code!=="auth" && e.code!==190)break; // No retries on rate-limit/identity/permission errors.
    }
  }
  if(lastError){const stage=lastError.stage==="identity" ? "Проверка владельца токена" : lastError.stage==="adaccounts" ? "Получение списка кабинетов" : "Подключение";throw new Error(stage+": "+lastError.message);}
  throw new Error("Не удалось проверить доступ к соцy.");
}
async function startWholeSync(mode="statistics"){
  const s=await licensed();
  if(!s.social)throw new Error("Сначала подключите соц.");
  if(s.job?.state==="running")throw new Error("Сбор всего соца уже выполняется.");
  const {metaToken,socialTabId}=await chrome.storage.session.get(["metaToken","socialTabId"]);
  if(!metaToken)throw new Error("Локальный доступ истёк. Подключите соц из Ads Manager заново.");
  period(s.range.since,s.range.until);
  const user=await graph("me",{fields:"id"},metaToken,pageFetcher(socialTabId,s.social.user.id));
  if(String(user.id)!==s.social.user.id)throw new Error("Доступ относится к другому соцу.");
  const job={id:crypto.randomUUID(),mode,state:s.social.accounts.length ? "running" : "done",userId:s.social.user.id,
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
  const {metaToken,socialTabId}=await chrome.storage.session.get(["metaToken","socialTabId"]);
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
      snapshot=job.mode==="structure" ? await syncStructure(id,metaToken,t=>status(t),pageFetcher(socialTabId,job.userId)) : await syncMeta(id,job.range,metaToken,t=>status((job.index+1)+"/"+job.ids.length+" · "+t),pageFetcher(socialTabId,job.userId));
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
    if(snapshot){const key=job.mode==="structure" ? "structures" : "reports";await chrome.storage.local.set({[key]:{...(fresh[key] || {}),[id]:snapshot}});}
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


async function disconnectLocal(){
  await recorder.clear();
  clearMetaTransport();
  await captureQueue;await chrome.storage.session.remove("networkCapture");await chrome.alarms.clear("capture-expiry");
  await chrome.alarms.clear("sync");await chrome.alarms.clear("whole");await chrome.storage.local.remove(["binding","snapshot","range","social","reports","job","sessionDiagnostics","trace","structures"]);
  await chrome.storage.session.remove(["metaToken","socialTabId"]);await chrome.storage.local.set({auto:false});
}
function localToday(){const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);}
// One key for the client: a personal server key (background collection) or the demo key (local only).
async function activate(m){
  const key=String(m.key||"").trim();
  if(!isServerKey(key)){await chrome.storage.local.set({license:license(key)});await status("Ключ принят. Откройте Ads Manager и подключите соц.");return {mode:"demo"};}
  const origin=serverOrigin(m.origin || DEFAULT_SERVER);
  const health=await serverCommand({type:"SERVER_STATUS",origin,key});
  if(health.mode!=="live")throw new Error("Сервер работает в тестовом режиме и не принимает реальные соцы.");
  await chrome.storage.local.set({server:{origin,key},license:{mode:"server",plan:"JS Control",socialLimit:1,accountLimit:null,expiresAt:null}});
  await status("Ключ принят. Откройте Ads Manager и подключите соц.");
  return {mode:"server"};
}
async function waitForTab(tabId,ms){
  const end=Date.now()+ms;
  while(Date.now()<end){const t=await chrome.tabs.get(tabId);if(t.status==="complete")return;await new Promise(r=>setTimeout(r,500));}
}
async function waitForCapture(ms){
  const end=Date.now()+ms;
  while(Date.now()<end){await captureQueue;const {networkCapture}=await chrome.storage.session.get("networkCapture");if(networkCapture?.candidates?.length)return true;await new Promise(r=>setTimeout(r,500));}
  return false;
}
// Whole client flow behind one button: local check, automatic Ads Manager reload
// when the access is not visible yet, transfer to the server, first collection and schedule.
async function clientConnect(m){
  if(busy)throw new Error("Подождите окончания сбора.");
  const server=await savedServer();
  if(server && m.consent!==true)throw new Error("Подтвердите передачу сессии серверу JS Control.");
  const range={since:localToday(),until:localToday()};
  let social=await connectSocial(m.tabId,range);
  if(social?.pending){
    await status("Обновляю вкладку Ads Manager, чтобы получить доступ…");
    await chrome.tabs.reload(m.tabId);
    await new Promise(r=>setTimeout(r,1000));
    await waitForTab(m.tabId,45000);
    await status("Жду загрузки данных Ads Manager…");
    await waitForCapture(20000);
    social=await connectSocial(m.tabId,range);
    if(social?.pending)throw new Error("Не удалось получить доступ из Ads Manager. Дождитесь полной загрузки страницы со списком кампаний и нажмите «Подключить» ещё раз.");
  }
  if(!server){await startWholeSync();return {mode:"local"};}
  await status("Передаю подключение на сервер…");
  await serverCommand({type:"SERVER_CONNECT",consent:true,proxy:m.proxy});
  await status("Запускаю первый сбор на сервере…");
  await serverCommand({type:"SERVER_JOB",userId:social.user.id,since:range.since,until:range.until});
  await serverCommand({type:"SERVER_SCHEDULE",userId:social.user.id,minutes:SCHEDULE_MINUTES});
  await status("Готово! Сбор запущен. Данные будут обновляться каждые "+SCHEDULE_MINUTES+" мин, браузер можно закрыть.");
  return {mode:"server"};
}
async function clientRefresh(){
  const s=await licensed();if(!s.social)throw new Error("Сначала подключите соц.");
  if(!await savedServer()){await chrome.storage.local.set({range:{since:localToday(),until:localToday()}});return startWholeSync();}
  const job=await serverCommand({type:"SERVER_JOB",userId:s.social.user.id,since:localToday(),until:localToday()});
  await status("Сбор на сервере запущен.");return job;
}
async function clientStatus(){
  const s=await read();if(!s.social || !await savedServer())return null;
  return summarizeServer(await serverCommand({type:"SERVER_STATUS"}),s.social.user.id);
}
async function clientDisconnect(){
  const s=await read();
  // Keep the local social on failure so the client can retry the server removal.
  if(s.social && await savedServer()){
    try{await serverCommand({type:"SERVER_REMOVE",userId:s.social.user.id});}
    catch(e){throw new Error("Не удалось удалить соц с сервера: "+e.message);}
  }
  await disconnectLocal();
  await status("Соц отключён, данные удалены.");return true;
}
async function command(m){
  switch(m.type){
    case "SERVER_ACTION":case "SERVER_CONNECT":case "SERVER_STATUS":case "SERVER_JOB":case "SERVER_SCHEDULE":case "SERVER_REMOVE":return serverCommand(m);
    case "TRACE_START":{await licensed();const tab=await chrome.tabs.get(m.tabId);if(!adsUrl(tab.url))throw new Error("Откройте вкладку Ads Manager.");await recorder.start(tab.id);await status("Запись включена на 15 минут. Работайте в этой вкладке Ads Manager.");return true;}
    case "TRACE_STOP":{await recorder.stop();await status("Запись остановлена. Экспортируйте запись запросов.");return true;}
    case "TRACE_CLEAR":{await recorder.clear();return true;}
    case "CONNECT_SOCIAL":{if(busy)throw new Error("Подождите окончания сбора.");return connectSocial(m.tabId,{since:m.since,until:m.until});}
    case "CONNECT_SOCIAL_TOKEN":{if(busy)throw new Error("Подождите окончания сбора.");return connectSocial(m.tabId,{since:m.since,until:m.until},m.token || "");}
    case "SYNC_SOCIAL":return startWholeSync();
    case "SYNC_STRUCTURE":return startWholeSync("structure");
    case "CANCEL_SOCIAL":{const s=await read();if(s.job)await chrome.storage.local.set({job:{...s.job,state:"cancelled"}});await chrome.alarms.clear("whole");await status("Сбор остановлен.");return true;}
    case "STATE":{const s=await read();const {metaToken,socialTabId}=await chrome.storage.session.get(["metaToken","socialTabId"]);const server=await savedServer();return {...s,hasMetaToken:!!metaToken,busy,server:server ? {origin:server.origin} : null};}
    case "ACTIVATE":return activate(m);
    case "CONNECT":{
      await licensed();
      const tab=await chrome.tabs.get(m.tabId);
      if(!adsUrl(tab.url)) throw new Error("Откройте вкладку Meta Ads Manager и нажмите значок расширения в ней.");
      const u=new URL(tab.url),id=accountId(u.searchParams.get("act"));
      const old=await read();
      if(old.binding && old.binding.accountId!==id) {
        await chrome.storage.local.remove("snapshot");await chrome.storage.session.remove(["metaToken","socialTabId"]);
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
      const s=await licensed();const {metaToken,socialTabId}=await chrome.storage.session.get(["metaToken","socialTabId"]);
      if(m.enabled && (!s.binding || !metaToken || !s.snapshot?.complete || s.snapshot.account.id!==s.binding.accountId)) throw new Error("Сначала выполните успешный сбор через API.");
      if(m.enabled) await chrome.alarms.create("sync",{periodInMinutes:60});else await chrome.alarms.clear("sync");
      await chrome.storage.local.set({auto:!!m.enabled});return true;
    }
    case "DISCONNECT":{await disconnectLocal();await status("Кабинет отключён; локальные данные удалены.");return true;}
    case "CLIENT_CONNECT":return clientConnect(m);
    case "CLIENT_REFRESH":return clientRefresh();
    case "CLIENT_STATUS":return clientStatus();
    case "CLIENT_DISCONNECT":return clientDisconnect();
    case "SIGN_OUT":{await clientDisconnect();await chrome.storage.local.remove(["license","server"]);await status("Ключ удалён из расширения.");return true;}
    default:throw new Error("Неизвестная команда.");
  }
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL("panel.html")) return false;
  command(m).then(data=>reply({ok:true,data})).catch(e=>reply({ok:false,error:e.message || "Ошибка."}));
  return true;
});
chrome.alarms.onAlarm.addListener(a=>{
  if(a.name==="trace-expiry")void recorder.stop("expired").catch(()=>{});
  if(a.name==="capture-expiry")void (async()=>{await captureQueue;await chrome.storage.session.remove("networkCapture");const s=await read();if(s.sessionDiagnostics?.network?.state==="waiting"){await chrome.storage.local.set({sessionDiagnostics:{...s.sessionDiagnostics,network:{...s.sessionDiagnostics.network,state:"expired"}}});await status("Наблюдение завершено. Доступ не найден в запросах. Откройте диагностику подключения.",true);}})().catch(()=>{});
  if(a.name==="whole")void processWhole().catch(()=>{});if(a.name==="sync") void run("api").catch(()=>{});
});
chrome.runtime.onStartup.addListener(()=>{
  void (async()=>{await init;await recorder.stop("browser-restart");await chrome.alarms.clear("sync");await chrome.storage.local.set({auto:false});const s=await read();if(s.job?.state==="running")await chrome.storage.local.set({job:{...s.job,state:"needs_auth",leaseUntil:0}});await chrome.alarms.clear("whole");await status("Браузер запущен. Подключите соц для восстановления локального доступа.");})().catch(()=>{});
});
