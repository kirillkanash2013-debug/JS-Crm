import {DEMO_KEY} from "./core.mjs";
const $=id=>document.getElementById(id);
let state={},pending=false;
function message(t,error=false){$("status").textContent=t;document.querySelector("footer").classList.toggle("error",error);}
async function ask(type,data={}){
  const r=await chrome.runtime.sendMessage({type,...data});
  if(!r?.ok)throw new Error(r?.error || "Нет ответа от расширения.");
  return r.data;
}
function today(){const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);}
function cell(row,value){const td=document.createElement("td");td.textContent=value;row.append(td);}
function render(s){
  state=s;$("activation").hidden=!!s.license;$("workspace").hidden=!s.license;
  $("social").textContent=s.social ? (s.social.user.name || "Facebook")+" · "+s.social.user.id : "Не подключён";
  $("count").textContent=s.social ? s.social.accounts.length+" / "+s.social.businesses.length : "—";
  $("updated").textContent=s.social ? new Date(s.social.discoveredAt).toLocaleString() : "—";
  if(!$("since").value)$("since").value=s.range?.since || today();
  if(!$("until").value)$("until").value=s.range?.until || today();
  $("accounts").replaceChildren();
  for(const a of s.social?.accounts || []){
    const r=s.reports?.[a.id],tr=document.createElement("tr");
    cell(tr,(a.name || "Кабинет")+" · "+a.id);cell(tr,a.business?.name || a.business?.id || "—");
    cell(tr,r ? String(r.campaigns.length) : s.structures?.[a.id]?.campaigns.length ?? "—");
    cell(tr,r ? r.metrics.reduce((n,m)=>n+m.spend,0).toFixed(2)+" "+r.account.currency : "—");
    cell(tr,s.structures?.[a.id] ? s.structures[a.id].adsets.length+" / "+s.structures[a.id].ads.length : "—");
    cell(tr,r ? r.period.since+" — "+r.period.until+" · "+new Date(r.observedAt).toLocaleTimeString() : "Не собран");
    $("accounts").append(tr);
  }
  $("coverage").textContent=s.social ? s.social.scope : "Список появится после успешного подключения.";
  const j=s.job;
  $("job").textContent=j ? "Сбор: "+j.index+"/"+j.ids.length+" · "+j.state+(j.errors.length ? " · ошибок: "+j.errors.length : "") : "";
  $("diagnostics").textContent=JSON.stringify({session:s.sessionDiagnostics || null,errors:j?.errors || []},null,2);
  const running=j?.state==="running";
  document.querySelectorAll("button").forEach(b=>b.disabled=pending);
  $("connect").disabled=pending||running;$("disconnect").disabled=pending||running;
  $("connectToken").disabled=pending||running;
  $("structure").disabled=pending||running||!s.social||!s.hasMetaToken;
  $("sync").disabled=pending||running||!s.social||!s.hasMetaToken;
  $("cancel").disabled=pending||!running;$("export").disabled=pending||!s.social;
  $("structureRows").replaceChildren();
  let total=0,shown=0;
  for(const [id,structure] of Object.entries(s.structures || {})){
    for(const [kind,rows] of [["Кампания",structure.campaigns],["Группа",structure.adsets],["Объявление",structure.ads]]){
      total+=rows.length;for(const row of rows){if(shown>=100)continue;const tr=document.createElement("tr");cell(tr,kind+": "+row.name);cell(tr,row.id);cell(tr,row.adsetId || row.campaignId || id);cell(tr,row.effectiveStatus || row.status || "—");$("structureRows").append(tr);shown++;}
    }
  }
  $("structureCount").textContent=total ? "Объектов: "+total+". Показано: "+shown+". Все объекты доступны в экспорте JSON." : "Нажмите «Собрать структуру».";
  const trace=s.trace;
  $("traceState").textContent=trace ? (trace.active && trace.expiresAt>Date.now() ? "Запись идёт" : "Запись остановлена")+" · запросов: "+trace.rows.length+" / 300 · без названия: "+trace.rows.filter(r=>!r.operation).length+" · кандидатов мутаций: "+trace.rows.filter(r=>r.kind==="mutation-candidate").length+" · неизвестных адресов: "+trace.rows.filter(r=>r.knownRoute===false).length : "Запись не запускалась";
  $("traceRows").replaceChildren();
  for(const row of (trace?.rows || []).slice(-20)){const tr=document.createElement("tr");cell(tr,new Date(row.at).toLocaleTimeString());cell(tr,row.method+" "+(row.operation || row.path));cell(tr,row.failed ? "Ошибка сети" : row.status ?? "…");$("traceRows").append(tr);}
  $("traceStart").disabled=pending||!!(trace?.active && trace.expiresAt>Date.now());
  $("traceStop").disabled=pending||!trace?.active;$("traceExport").disabled=pending||!trace?.rows.length;
  if(s.status)message(s.status.text,s.status.error);
}
async function refresh(){render(await ask("STATE"));}
async function task(fn){
  if(pending)return;pending=true;render(state);message("Выполняю…");
  try{await fn();await refresh();}catch(e){await refresh().catch(()=>{});message(e.message,true);}
  finally{pending=false;render({...state,status:{text:$("status").textContent,error:document.querySelector("footer").classList.contains("error")}});}
}
$("demo").onclick=()=>{$("key").value=DEMO_KEY;};
$("activateForm").onsubmit=e=>{e.preventDefault();void task(async()=>{await ask("ACTIVATE",{key:$("key").value});$("key").value="";});};
$("connect").onclick=async()=>{
  const granted=await chrome.permissions.request({origins:["https://graph.facebook.com/*","https://adsmanager.facebook.com/*","https://business.facebook.com/*","https://www.facebook.com/*"]});
  if(!granted){message("Без разрешения на Meta API список кабинетов получить нельзя.",true);return;}
  void task(async()=>{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error("Не найдена активная вкладка.");
    await ask("CONNECT_SOCIAL",{tabId:tab.id,since:$("since").value,until:$("until").value});
  });
};
$("sync").onclick=()=>void task(async()=>{
  await ask("RANGE",{since:$("since").value,until:$("until").value});
  await ask("SYNC_SOCIAL");
});
$("tokenForm").onsubmit=async event=>{
  event.preventDefault();
  const token=$("metaToken").value.trim();$("metaToken").value="";
  const granted=await chrome.permissions.request({origins:["https://graph.facebook.com/*"]});
  if(!granted){message("Разрешите доступ к Meta API для проверки токена.",true);return;}
  void task(async()=>{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error("Откройте Ads Manager нужного соца.");
    await ask("CONNECT_SOCIAL_TOKEN",{tabId:tab.id,token,since:$("since").value,until:$("until").value});
  });
};
$("cancel").onclick=()=>void task(()=>ask("CANCEL_SOCIAL"));
$("disconnect").onclick=()=>void task(()=>ask("DISCONNECT"));
$("export").onclick=()=>{
  if(!state.social)return;
  const payload={schemaVersion:2,social:state.social,reports:state.reports || {},structures:state.structures || {},job:state.job || null,diagnostics:state.sessionDiagnostics || null};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="js-control-social-"+state.social.user.id+"-"+today()+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
chrome.storage.onChanged.addListener((c,area)=>{if(area==="local")void refresh().catch(()=>{});});
void refresh().catch(e=>message(e.message,true));

$("traceStart").onclick=async()=>{
 const granted=await chrome.permissions.request({origins:["https://*.facebook.com/*"]});
 if(!granted){message("Для записи разрешите доступ к сайтам Facebook.",true);return;}
 void task(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id)throw new Error("Откройте Ads Manager.");await ask("TRACE_START",{tabId:tab.id});});
};
$("traceStop").onclick=()=>void task(()=>ask("TRACE_STOP"));
$("traceClear").onclick=()=>void task(()=>ask("TRACE_CLEAR"));
$("traceExport").onclick=()=>{
 if(!state.trace)return;const {tabId,...trace}=state.trace;
 const blob=new Blob([JSON.stringify({schemaVersion:2,extensionVersion:"0.5.1",trace},null,2)],{type:"application/json"});
 const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="js-control-requests-"+today()+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};

$("structure").onclick=()=>void task(()=>ask("SYNC_STRUCTURE"));

async function cloud(type,extra={}){
 let origin;try{origin=new URL($("serverOrigin").value).origin;if(!origin.startsWith("https://"))throw new Error();}catch{message("Введите корректный HTTPS-адрес сервера.",true);return;}
 const granted=await chrome.permissions.request({permissions:type==="SERVER_CONNECT"?["cookies"]:[],origins:[origin+"/*",...(type==="SERVER_CONNECT"?["https://*.facebook.com/*"]:[])]});
 if(!granted){message("Разрешение не предоставлено.",true);return;}
 void task(async()=>{
  const result=await ask(type,{origin:$("serverOrigin").value,key:$("serverKey").value,userId:state.social?.user.id,since:$("since").value,until:$("until").value,consent:$("serverConsent").checked,proxy:$("proxyServer").value?{server:$("proxyServer").value,username:$("proxyUser").value,password:$("proxyPassword").value}:undefined,...extra});
  $("proxyPassword").value="";
  $("serverResult").textContent=JSON.stringify(type==="SERVER_STATUS"?{mode:result.mode,connections:result.connections,jobs:result.jobs,results:Object.fromEntries(Object.entries(result.results||{}).map(([id,r])=>[id,{source:r.source,complete:r.complete,observedAt:r.observedAt,accounts:r.social?.accounts.length,campaigns:Object.values(r.structures||{}).reduce((n,s)=>n+s.campaigns.length,0),adsets:Object.values(r.structures||{}).reduce((n,s)=>n+s.adsets.length,0),ads:Object.values(r.structures||{}).reduce((n,s)=>n+s.ads.length,0)}]))}:result,null,2);
 });
}
$("serverConnect").onclick=()=>void cloud("SERVER_CONNECT");
$("serverJob").onclick=()=>void cloud("SERVER_JOB");
$("serverStatus").onclick=()=>void cloud("SERVER_STATUS");
$("serverSchedule").onclick=()=>void cloud("SERVER_SCHEDULE",{minutes:15});
$("serverStopSchedule").onclick=()=>void cloud("SERVER_SCHEDULE",{minutes:0});
$("serverRemove").onclick=()=>void cloud("SERVER_REMOVE");

$("serverGenerateKey").onclick=()=>{
 const bytes=crypto.getRandomValues(new Uint8Array(32));
 $("serverKey").value="js_srv_"+btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
 $("serverResult").textContent="Ключ создан локально. Сохраните его у себя и добавьте в Cloudflare → js-control-collector-claude → Settings → Variables and Secrets как Secret с именем JS_CONTROL_OWNER_KEY. Сам ключ не отправляется в чат и не сохраняется в экспорт.";
};
