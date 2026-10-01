// Client-facing helpers: plain-language texts and summaries for the main screen.
// No browser APIs here, so everything is covered by node tests.
export const DEFAULT_SERVER="https://js-control-collector-claude.kirill-kanash2013.workers.dev";
export const SCHEDULE_MINUTES=15;
export const ADS_MANAGER_URL="https://adsmanager.facebook.com/adsmanager/manage/campaigns";
export const META_ORIGINS=["https://graph.facebook.com/*","https://adsmanager.facebook.com/*","https://business.facebook.com/*","https://www.facebook.com/*"];
export const ADS_TAB_PATTERNS=["https://adsmanager.facebook.com/*","https://business.facebook.com/adsmanager*","https://www.facebook.com/adsmanager*"];
// Owner key (js_srv_) or a client integration token (jsi_) from the bot.
export const isServerKey=key=>/^(js_srv|jsi)_[A-Za-z0-9_-]{43}$/.test(String(key||"").trim());

const HTTP_TEXT={
  401:"Ключ доступа не подходит. Проверьте ключ или запросите новый.",
  403:"Ключ доступа не подходит. Проверьте ключ или запросите новый.",
  402:"Подписка закончилась. Продлите её в боте JS Control.",
  409:"Достигнут лимит соцов по тарифу. Отключите ненужный соц или смените тариф.",
  413:"Слишком много данных для передачи. Обратитесь в поддержку.",
  429:"Слишком много запросов. Подождите минуту и повторите.",
  503:"Сервер ещё не готов к работе. Обратитесь в поддержку."
};
export function serverErrorText(status){
  if(HTTP_TEXT[status])return HTTP_TEXT[status];
  if(status>=500)return "Сервер временно недоступен. Повторите через несколько минут.";
  if(status===400)return "Сервер не принял запрос. Переподключите соц.";
  return "Сервер вернул ошибку "+status+".";
}

// Picks the tab to connect: the active Ads Manager tab first, then any Ads Manager tab.
export function pickAdsTab(tabs,isAds){
  const ads=(tabs||[]).filter(t=>t?.id && isAds(t.url));
  return ads.find(t=>t.active) || ads.sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0))[0] || null;
}

const JOB_TEXT={queued:"в очереди",running:"идёт сбор",done:"успешно",failed:"ошибка",needs_auth:"нужно переподключить соц",cancelled:"отменён",unverified:"не подтверждён",rate_limited:"Facebook попросил паузу, повтор через час"};
export const jobText=state=>JOB_TEXT[state] || state || "—";

export function spendByCurrency(reports){
  const sums={};
  for(const r of Object.values(reports||{})){
    const cur=r?.account?.currency;if(!cur)continue;
    sums[cur]=(sums[cur]||0)+(r.metrics||[]).reduce((n,m)=>n+(Number(m.spend)||0),0);
  }
  return Object.entries(sums).map(([cur,sum])=>sum.toFixed(2)+" "+cur).join(" · ");
}

// Turns the raw /v1/status answer into what a client needs to see.
export function summarizeServer(status,userId){
  const id=String(userId||"");
  const connection=(status?.connections||[]).find(c=>c.userId===id) || null;
  const jobs=(status?.jobs||[]).filter(j=>j.userId===id && !j.action);
  const active=jobs.find(j=>["queued","running"].includes(j.state)) || null;
  const last=[...jobs].reverse().find(j=>!["queued","running"].includes(j.state)) || null;
  const result=status?.results?.[id] || null;
  const verified=!!(result && result.complete && result.source==="facebook-server");
  const count=key=>Object.values(result?.structures||{}).reduce((n,s)=>n+(s?.[key]?.length||0),0);
  return {
    connected:!!connection,
    scheduleMinutes:connection?.schedule?.minutes || 0,
    nextAt:connection?.schedule?.nextAt || null,
    active,last,
    needsAuth:last?.state==="needs_auth" && !active,
    result:verified ? {observedAt:result.observedAt,accounts:result.social?.accounts?.length||0,campaigns:count("campaigns"),adsets:count("adsets"),ads:count("ads"),spend:spendByCurrency(result.reports)} : null
  };
}

// One-line health of the server connection for the status card.
export function serverHeadline(summary){
  if(!summary.connected)return {tone:"warn",text:"Соц не передан на сервер"};
  if(summary.active)return {tone:"busy",text:summary.active.state==="running" ? "Идёт сбор данных…" : "Сбор поставлен в очередь…"};
  if(summary.needsAuth)return {tone:"error",text:"Сессия Facebook истекла — переподключите соц"};
  if(summary.last?.state==="failed")return {tone:"error",text:"Последний сбор завершился ошибкой"};
  if(summary.result)return {tone:"ok",text:summary.scheduleMinutes ? "Работает: данные обновляются каждые "+summary.scheduleMinutes+" мин" : "Подключено, автообновление выключено"};
  return {tone:"busy",text:"Подключено, ждём первый сбор"};
}
