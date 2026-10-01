export function serverOrigin(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('Введите HTTPS-адрес сервера без пути.');return u.origin;}
export async function serverCommand(m){
 const origin=serverOrigin(m.origin),key=String(m.key||'');if(!/^js_srv_[A-Za-z0-9_-]{43}$/.test(key))throw new Error('Нужен персональный ключ сервера, демо-ключ здесь не подходит.');
 if(!await chrome.permissions.contains({origins:[origin+'/*']}))throw new Error('Нет разрешения на сервер.');
 const request=async(path,method='GET',body)=>{
  const r=await fetch(origin+path,{method,headers:{Authorization:'Bearer '+key,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',credentials:'omit',signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new Error('Сервер отклонил запрос: HTTP '+r.status);return r.json();
 };
 if(m.type==='SERVER_STATUS')return request('/v1/status');
 if(m.type==='SERVER_JOB')return request('/v1/jobs','POST',{userId:m.userId,since:m.since,until:m.until});
 if(m.type==='SERVER_SCHEDULE')return request('/v1/schedule','POST',{userId:m.userId,minutes:m.minutes});
 if(m.type==='SERVER_REMOVE')return request('/v1/connections','DELETE',{userId:m.userId});
 if(m.type!=='SERVER_CONNECT'||m.consent!==true)throw new Error('Нужно согласие на передачу сессии серверу.');
 const health=await request('/v1/status');if(health.mode!=='live')throw new Error('Симулятор не принимает реальные сессии.');
 const {social}=await chrome.storage.local.get('social'),{metaToken,socialTabId}=await chrome.storage.session.get(['metaToken','socialTabId']);
 if(!social?.user?.id||!metaToken||!socialTabId)throw new Error('Сначала подключите соц в Ads Manager.');
 // Verify current browser owner immediately before transferring any credential.
 const tab=await chrome.tabs.get(socialTabId);if(!/^https:\/\/(adsmanager|business|www)\.facebook\.com\//.test(tab.url))throw new Error('Откройте вкладку Ads Manager.');
 const owner=await chrome.scripting.executeScript({target:{tabId:socialTabId},world:'MAIN',func:()=>{try{return {id:String(globalThis.require('CurrentUserInitialData').USER_ID),ua:navigator.userAgent};}catch{return null;}}});
 if(owner[0]?.result?.id!==social.user.id)throw new Error('Вкладка относится к другому соцy.');
 const stores=await chrome.cookies.getAllCookieStores(),store=stores.find(s=>s.tabIds.includes(socialTabId));
 if(!store||!/^https:\/\/(adsmanager|business|www)\.facebook\.com\//.test(tab.url))throw new Error('Не найдена сессия выбранной вкладки.');
 const raw=await chrome.cookies.getAll({domain:'facebook.com',storeId:store.id});
 if(!raw.some(c=>c.name==='c_user'&&c.value===social.user.id))throw new Error('Cookies относятся к другому соцy.');
 const cookies=raw.map(c=>({name:c.name,value:c.value,domain:c.domain,path:c.path,httpOnly:c.httpOnly,secure:c.secure,sameSite:{no_restriction:'None',lax:'Lax',strict:'Strict'}[c.sameSite]||'Lax',expires:c.expirationDate||-1}));
 return request('/v1/connections','POST',{userId:social.user.id,token:metaToken,userAgent:owner[0].result.ua,cookies,proxy:m.proxy});
}
