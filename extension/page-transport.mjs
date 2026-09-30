// Read-only Graph transport executed in the selected Ads Manager MAIN world.
export async function pageGraphRead(url,token,expectedUserId) {
  const here=new URL(location.href);
  if(here.protocol!=="https:" || !["adsmanager.facebook.com","business.facebook.com","www.facebook.com"].includes(here.hostname) || (here.hostname!=="adsmanager.facebook.com" && !/^\/adsmanager(?:\/|$)/.test(here.pathname)))throw new Error("Откройте подключённую вкладку Ads Manager.");
  let current;
  try{current=String(globalThis.require("CurrentUserInitialData").USER_ID);}catch{}
  if(!/^\d{3,30}$/.test(expectedUserId) || current!==expectedUserId)throw new Error("Вкладка относится к другому соцy или сессия завершена.");
  const u=new URL(url);
  if(u.origin!=="https://graph.facebook.com" || !/^\/v25\.0\/(?:me|\d{3,30}|act_\d{3,30})(?:\/(?:adaccounts|campaigns|adsets|ads|insights))?$/.test(u.pathname) || u.username || u.password)throw new Error("Недопустимый запрос Meta.");
  for(const key of u.searchParams.keys())if(!["fields","limit","after","before","level","time_range","time_increment","since","until","locale"].includes(key))throw new Error("Недопустимый параметр Meta.");
  if(!/^EA[A-Za-z0-9_-]{18,4094}$/.test(token))throw new Error("Нет локального доступа Facebook.");
  u.searchParams.set("access_token",token);
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open("GET",u.href,true);xhr.withCredentials=true;xhr.responseType="json";xhr.timeout=20000;
    xhr.onload=()=>resolve({status:xhr.status,body:xhr.response});
    xhr.onerror=()=>reject(new Error("Запрос из вкладки заблокирован или нет соединения."));
    xhr.ontimeout=()=>reject(new Error("Meta не ответила за 20 секунд."));xhr.send();
  });
}
export function pageFetcher(tabId,userId) {
  const fetcher=async(url,options)=>{
    if(options.method!=="GET")throw new Error("Поддерживается только чтение Meta.");
    const authorization=options.headers?.Authorization || "";
    const token=authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const result=await chrome.scripting.executeScript({target:{tabId},world:"MAIN",func:pageGraphRead,args:[url,token,userId]});
    const response=result[0]?.result;
    if(!response || !Number.isInteger(response.status))throw new Error("Не удалось получить ответ из вкладки Ads Manager.");
    return {ok:response.status>=200 && response.status<300,status:response.status,json:async()=>response.body};
  };
  fetcher.pageContext=true;
  return fetcher;
}
