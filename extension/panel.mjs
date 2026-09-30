import {DEMO_KEY} from "./core.mjs";
const $=id=>document.getElementById(id);
let state={}, pending=false;
function message(t,error=false){$("status").textContent=t;document.querySelector("footer").classList.toggle("error",error);}
async function ask(type,data={}){
  const r=await chrome.runtime.sendMessage({type,...data});
  if(!r?.ok) throw new Error(r?.error || "Нет ответа от расширения. Откройте его снова.");
  return r.data;
}
function dateLocal(){const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);}
function cell(row,value){const td=document.createElement("td");td.textContent=value ?? "—";row.append(td);}
function render(s){
  state=s;$("activation").hidden=!!s.license;$("workspace").hidden=!s.license;
  $("account").textContent=s.binding?.accountId || "Не подключён";
  $("updated").textContent=s.snapshot ? new Date(s.snapshot.observedAt).toLocaleString() : "—";
  $("auto").checked=!!s.auto;
  $("since").value=s.range?.since || $("since").value || dateLocal();
  $("until").value=s.range?.until || $("until").value || dateLocal();
  $("visible").disabled=!s.binding || pending;$("api").disabled=!s.binding || !s.hasMetaToken || pending;
  $("export").disabled=!s.snapshot || pending;$("disconnect").disabled=!s.binding || pending;
  const snap=s.snapshot;
  $("campaigns").replaceChildren();$("rawTables").replaceChildren();$("totals").textContent="";
  $("raw").hidden=!snap?.visibleTables?.length;
  if(!snap){$("coverage").textContent="Нет снимка. Подключите кабинет и выполните сбор.";}
  else {
    $("coverage").textContent=snap.complete ? "API · "+snap.period.since+" — "+snap.period.until+" · "+(snap.account.timezone || "часовой пояс неизвестен")+" · "+snap.campaigns.length+" кампаний" :
      "Страница · "+snap.diagnostics.visibleRowCount+" загруженных строк · неполные данные, период не подтверждён";
    const spend=new Map();
    for(const m of snap.metrics) spend.set(m.campaignId,(spend.get(m.campaignId)||0)+m.spend);
    for(const c of snap.campaigns.slice(0,500)) {
      const tr=document.createElement("tr");cell(tr,c.id);cell(tr,c.name);cell(tr,c.status);
      cell(tr,spend.has(c.id) ? spend.get(c.id).toFixed(2)+" "+snap.account.currency : "—");
      $("campaigns").append(tr);
    }
    if(snap.complete) $("totals").textContent="Spend: "+snap.metrics.reduce((n,m)=>n+m.spend,0).toFixed(2)+" "+snap.account.currency;
    for(const t of snap.visibleTables || []) {
      const table=document.createElement("table"),head=document.createElement("tr");
      for(const h of t.headers) cell(head,h);table.append(head);
      for(const cells of t.rows){const tr=document.createElement("tr");for(const v of cells) cell(tr,v);table.append(tr);}
      $("rawTables").append(table);
    }
  }
  if(s.status) message(s.status.text,s.status.error);
}
async function refresh(){render(await ask("STATE"));}
async function task(fn){
  if(pending)return;pending=true;
  document.querySelectorAll("button").forEach(b=>b.disabled=true);
  message("Выполняю…");
  try{await fn();await refresh();}catch(e){await refresh().catch(()=>{});message(e.message,true);}
  finally{pending=false;document.querySelectorAll("button").forEach(b=>b.disabled=false);render({...state,status:{text:$("status").textContent,error:document.querySelector("footer").classList.contains("error")}});}
}
$("demo").onclick=()=>{$("key").value=DEMO_KEY;};
$("activateForm").onsubmit=e=>{e.preventDefault();void task(async()=>{await ask("ACTIVATE",{key:$("key").value});$("key").value="";});};
$("connect").onclick=()=>void task(async()=>{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id)throw new Error("Не найдена активная вкладка.");
  await ask("CONNECT",{tabId:tab.id,since:$("since").value || dateLocal(),until:$("until").value || dateLocal()});
});
$("visible").onclick=()=>void task(()=>ask("SYNC",{mode:"visible"}));
$("saveToken").onclick=async()=>{
  // permissions.request must start inside a user gesture, before other awaits.
  const granted=await chrome.permissions.request({origins:["https://graph.facebook.com/*"]});
  if(!granted){message("Доступ к Meta API не разрешён.",true);return;}
  void task(async()=>{await ask("TOKEN",{token:$("token").value.trim()});$("token").value="";});
};
$("api").onclick=()=>void task(async()=>{
  await ask("RANGE",{since:$("since").value,until:$("until").value});
  await ask("SYNC",{mode:"api"});
});
$("auto").onchange=()=>void task(()=>ask("AUTO",{enabled:$("auto").checked}));
$("disconnect").onclick=()=>void task(()=>ask("DISCONNECT"));
$("export").onclick=()=>{
  if(!state.snapshot)return;
  const blob=new Blob([JSON.stringify(state.snapshot,null,2)],{type:"application/json"});
  const u=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=u;a.download="js-control-"+state.snapshot.account.id+"-"+state.snapshot.observedAt.slice(0,10)+".json";a.click();
  setTimeout(()=>URL.revokeObjectURL(u),1000);
};
chrome.storage.onChanged.addListener((changes,area)=>{if(area==="local") void refresh().catch(()=>{});});
void refresh().catch(e=>message(e.message,true));
