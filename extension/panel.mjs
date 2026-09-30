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
    cell(tr,r ? String(r.campaigns.length) : "—");
    cell(tr,r ? r.metrics.reduce((n,m)=>n+m.spend,0).toFixed(2)+" "+r.account.currency : "—");
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
  $("sync").disabled=pending||running||!s.social||!s.hasMetaToken;
  $("cancel").disabled=pending||!running;$("export").disabled=pending||!s.social;
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
  const granted=await chrome.permissions.request({origins:["https://graph.facebook.com/*"]});
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
$("cancel").onclick=()=>void task(()=>ask("CANCEL_SOCIAL"));
$("disconnect").onclick=()=>void task(()=>ask("DISCONNECT"));
$("export").onclick=()=>{
  if(!state.social)return;
  const payload={schemaVersion:2,social:state.social,reports:state.reports || {},job:state.job || null,diagnostics:state.sessionDiagnostics || null};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="js-control-social-"+state.social.user.id+"-"+today()+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
chrome.storage.onChanged.addListener((c,area)=>{if(area==="local")void refresh().catch(()=>{});});
void refresh().catch(e=>message(e.message,true));
