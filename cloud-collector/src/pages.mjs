// Public pages of the collector: bookmark install and social connect.
// Same origin as the API, so the page calls /v1/* without CORS.
import {adsPowerBookmarkletHref, bookmarkletHref} from './bookmarklet.mjs';

// Accepts "http://user:pass@host:port", "socks5://host:port" or Dolphin-style
// "host:port:login:password" (type chosen in the form). Kept self-contained:
// it is also serialized into the connect page script.
export function parseProxyInput(text, type) {
  var v = String(text || '').trim();
  if (!v) return null;
  if (/^(https?|socks5):\/\//i.test(v)) {
    var u = new URL(v.replace(/^https:/i, 'http:'));
    return {server: u.protocol + '//' + u.hostname + ':' + u.port, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password)};
  }
  var p = v.split(':');
  if (p.length !== 2 && p.length !== 4) throw new Error('Формат прокси: host:port:логин:пароль или http://логин:пароль@host:port');
  return {server: (type === 'socks5' ? 'socks5://' : 'http://') + p[0] + ':' + p[1], username: p[2] || '', password: p[3] || ''};
}

const css = `:root{--bg:#0c111b;--card:#141d2c;--line:#29364b;--text:#edf2fa;--muted:#aab8cc;--accent:#8fff8a;--err:#ff8b86}
@media (prefers-color-scheme:light){:root{--bg:#f5f7fb;--card:#fff;--line:#dde3ee;--text:#111827;--muted:#556275;--accent:#1a8f3a;--err:#c0392b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif}main{max-width:560px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 6px}p,.hint{color:var(--muted)}.hint{font-size:13px}section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:16px 0}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}input,select,textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
textarea{min-height:80px;font:12px monospace}.row{display:flex;gap:8px}.row select{width:120px}.check{display:flex;gap:8px;align-items:flex-start;color:var(--text)}.check input{width:auto;margin-top:4px}
button{border:0;border-radius:8px;padding:12px 16px;background:var(--accent);color:#0c111b;font:600 15px system-ui;cursor:pointer;width:100%;margin-top:14px}button:disabled{opacity:.5}
.bm{display:inline-block;padding:12px 18px;border-radius:10px;background:var(--accent);color:#0c111b;font-weight:700;text-decoration:none;cursor:grab}
.status{margin-top:12px;font-size:14px}.status.err{color:var(--err)}.status.ok{color:var(--accent)}ol{padding-left:20px;color:var(--muted)}code{word-break:break-all}`;

const page = (title, body, script = '') => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title><style>${css}</style></head><body><main>${body}</main>${script}</body></html>`;

export const PAGE_HEADERS = {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'"};

// Fastest, fully server-side connection: the client pastes the integration
// token and the antidetect API token; the server reads every profile, proxy
// and cookie and connects all Facebook socials. Nothing runs on the client.
export function importPage() {
  return page('JS Control — быстрое подключение', `<h1>Быстрое подключение профилей</h1>
<p>Подключите антидетект-браузер один раз — JS Control сам возьмёт все профили, их прокси и cookies и начнёт собирать статистику. Устанавливать ничего не нужно.</p>
<section>
<label for="key">Токен из бота JS Control</label><input id="key" type="password" autocomplete="off" placeholder="jsi_…">
<label for="type">Антидетект-браузер</label><select id="type"><option value="dolphin-anty">Dolphin Anty</option></select>
<label for="token">API-токен антидетекта</label><input id="token" type="password" autocomplete="off" placeholder="Dolphin Anty → Настройки → API">
<p class="hint">Токен берётся в антидетекте и даёт доступ только к списку профилей, их прокси и cookies. Включите облачную синхронизацию профилей, иначе cookies не отдаются.</p>
<button id="go" disabled>Подключить и импортировать профили</button><div id="status" class="status" role="status"></div>
<div id="result"></div></section>
<p class="hint">Профиль = соц: название соца в отчётах совпадает с названием профиля. Прокси и cookies берутся из профиля. Повторный импорт раз в сутки подхватывает новые профили автоматически.</p>`, '<script src="/import.js"></script>');
}

export function importScript() {
  return `(function(){'use strict';
var $=function(id){return document.getElementById(id);};
var show=function(t,cls){var s=$('status');s.textContent=t;s.className='status '+(cls||'');};
try{$('key').value=localStorage.getItem('jsc_key')||'';}catch(e){}
var sync=function(){$('go').disabled=!(/^(jsi|js_srv)_[A-Za-z0-9_-]{43}$/.test($('key').value.trim())&&$('token').value.trim());};
$('key').oninput=sync;$('token').oninput=sync;sync();
var ERR={401:'Токен JS Control не подошёл. Возьмите его в боте.',402:'Подписка закончилась. Продлите её в боте.',
  antidetect_auth:'Антидетект не принял API-токен. Проверьте токен.',antidetect_type:'Этот антидетект пока не поддерживается.',
  antidetect_unavailable:'Не удалось связаться с антидетектом. Попробуйте позже.',antidetect_token:'Вставьте API-токен антидетекта.'};
var api=function(path,body,key,method){return fetch(path,{method:method||'POST',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok)throw new Error(ERR[j.error]||('Ошибка '+r.status));return j;});});};
var REASONS={no_proxy:'без прокси',no_cookies:'нет cookies (включите синхронизацию)',no_facebook:'нет входа в Facebook',logged_out:'сессия Facebook истекла',proxy:'прокси не отвечает',limit:'превышен лимит тарифа',other_user:'другой аккаунт',no_token:'берётся через браузер'};
$('go').onclick=function(){
  var key=$('key').value.trim();try{localStorage.setItem('jsc_key',key);}catch(e){}
  $('go').disabled=true;show('Читаю профили антидетекта…');$('result').textContent='';
  api('/v1/antidetect',{type:$('type').value,token:$('token').value.trim()},key)
   .then(function(r){show('Антидетект подключён: профилей '+r.profiles+'. Импортирую соцы (это может занять пару минут)…');return poll(key,0);})
   .catch(function(e){show(e.message,'err');$('go').disabled=false;});
};
function poll(key,n){return api('/v1/status',null,key,'GET').then(function(s){
  var imp=s.antidetect&&s.antidetect.lastImport;
  if(imp){report(s,imp);$('go').disabled=false;return;}
  if(n>40){show('Импорт выполняется в фоне. Обновите страницу позже, чтобы увидеть результат.','');$('go').disabled=false;return;}
  show('Импортирую соцы… ('+(n+1)+')');return new Promise(function(r){setTimeout(r,5000);}).then(function(){return poll(key,n+1);});
});}
function report(s,imp){
  var ok=(s.connections||[]).length;
  show('Готово! Подключено соцов: '+ok+'. Новых: '+(imp.added||0)+', обновлено: '+(imp.updated||0)+'. Данные обновляются каждые 15 минут.','ok');
  var sk=imp.skipped||[];if(!sk.length)return;
  var by={};sk.forEach(function(x){by[x.reason]=(by[x.reason]||0)+1;});
  var parts=[];for(var k in by)parts.push((REASONS[k]||k)+': '+by[k]);
  $('result').innerHTML='<p class="hint">Пропущены профили — '+parts.join(', ')+'.</p>';
}
})();`;
}

export function bookmarkletPage(origin) {
  return page('JS Control — закладка', `<h1>Закладка JS Control</h1><p>Вместо расширения — одна кнопка на панели закладок. Работает в Chrome и антидетект-браузерах (Dolphin Anty, AdsPower, Octo и др.).</p>
<section><ol><li>Включите панель закладок: <b>Ctrl+Shift+B</b> (Mac: <b>⌘+Shift+B</b>).</li><li>Перетащите эту кнопку на панель закладок:</li></ol>
<p style="text-align:center"><a class="bm" href="${bookmarkletHref(origin).replace(/"/g, '&quot;')}">JS Control</a></p>
<ol start="3"><li>Откройте Ads Manager нужного соца, дождитесь загрузки кампаний и нажмите закладку.</li><li>Откроется страница подключения: вставьте токен из бота, укажите прокси соца и подтвердите.</li></ol>
<p class="hint">Закладка только читает ID соца и токен доступа на открытой странице и передаёт их на страницу подключения. Пароли и cookies она не читает.</p></section>
<section><h2>AdsPower</h2><p>Для профилей AdsPower используйте эту кнопку — она дополнительно попробует взять прокси профиля из локального API AdsPower, чтобы не вводить его вручную.</p>
<p style="text-align:center"><a class="bm" href="${adsPowerBookmarkletHref(origin).replace(/"/g, '&quot;')}">JS Control · AdsPower</a></p>
<p class="hint">AdsPower должен быть запущен. Новые версии Chrome спрашивают разрешение на доступ к локальной сети (Local Network Access) — разрешите его, иначе прокси впишите вручную на странице подключения.</p></section>`);
}

export function connectPage() {
  return page('JS Control — подключение соца', `<h1>Подключение соца</h1>
<section id="noSession" hidden><p>Откройте Ads Manager нужного соца и нажмите закладку <b>JS Control</b>. <a href="/bookmarklet">Как установить закладку</a></p></section>
<section id="form" hidden>
<p>Соц: <b id="who"></b></p>
<label for="key">Токен из бота JS Control</label><input id="key" type="password" autocomplete="off" placeholder="jsi_…">
<p class="hint">Токен привязывает этот соц к вашему оплаченному аккаунту. Возьмите его в боте: 📊 Подключить соц.</p>
<label for="proxy">Прокси соца (тот же, что в профиле браузера)</label>
<div class="row"><select id="ptype"><option value="http">HTTP</option><option value="socks5">SOCKS5</option></select><input id="proxy" autocomplete="off" placeholder="host:port:логин:пароль"></div>
<p class="hint" id="proxyNote">Через этот прокси сервер будет обновлять данные каждые 15 минут — Facebook видит привычный IP.</p>
<details><summary class="hint">Cookies из антидетекта (необязательно)</summary><p class="hint">Экспорт cookies профиля в формате JSON. С ними сервер сам восстановит доступ, если токен истечёт; без них — просто нажмите закладку ещё раз.</p><textarea id="cookies" placeholder='[{"name":"c_user",...}]'></textarea></details>
<label class="check"><input id="consent" type="checkbox"> Разрешаю передать токен${'' /* cookies optional */}, User-Agent, прокси и (если указаны) cookies серверу JS Control для сбора статистики.</label>
<button id="go" disabled>Подключить и запустить сбор</button><div id="status" class="status" role="status"></div></section>`, '<script src="/connect.js"></script>');
}

export function connectScript() {
  return `(function(){'use strict';
var parseProxyInput=${parseProxyInput.toString()};
var $=function(id){return document.getElementById(id);};
var session=null;
try{var m=location.hash.match(/s=([A-Za-z0-9_-]+)/);if(m){var b=m[1].replace(/-/g,'+').replace(/_/g,'/');session=JSON.parse(decodeURIComponent(escape(atob(b+'==='.slice((b.length+3)%4)))));}}catch(e){session=null;}
history.replaceState(null,'',location.pathname);
if(!session||!session.userId||!session.tokens||!session.tokens.length){$('noSession').hidden=false;return;}
$('form').hidden=false;$('who').textContent=(session.name||'Facebook')+' · '+session.userId;
try{$('key').value=localStorage.getItem('jsc_key')||'';}catch(e){}
// Proxy auto-detected by the AdsPower bookmark: prefill the field and mark it.
if(session.proxy&&session.proxy.server){try{
  var pu=new URL(session.proxy.server);$('ptype').value=pu.protocol==='socks5:'?'socks5':'http';
  $('proxy').value=pu.hostname+':'+pu.port+(session.proxy.username?':'+session.proxy.username+(session.proxy.password?':'+session.proxy.password:''):'');
  $('proxyNote').textContent='Прокси получен из профиля '+(session.source==='adspower'?'AdsPower':'антидетекта')+' автоматически. Проверьте и при необходимости поправьте.';
}catch(e){}}
var sync=function(){$('go').disabled=!$('consent').checked;};$('consent').onchange=sync;
var show=function(t,cls){var s=$('status');s.textContent=t;s.className='status '+(cls||'');};
var ERR={401:'Токен не подошёл. Возьмите токен в боте JS Control.',402:'Подписка закончилась. Продлите её в боте.',409:'Достигнут лимит соцов по тарифу.',
  proxy_failed:'Не удалось подключиться через прокси. Проверьте адрес, порт, логин и пароль.',token_invalid:'Facebook не принял доступ. Обновите Ads Manager и нажмите закладку ещё раз.',
  wrong_user:'Доступ относится к другому соцу. Нажмите закладку в Ads Manager нужного соца.',cookies_owner:'Cookies относятся к другому соцу.',validation_failed:'Не удалось проверить соц. Повторите позже.'};
var api=function(path,body,key){return fetch(path,{method:'POST',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok)throw new Error(ERR[j.error]||ERR[r.status]||('Ошибка '+r.status));return j;});});};
$('go').onclick=function(){
  var key=$('key').value.trim(),proxy,cookies;
  if(!/^(jsi|js_srv)_[A-Za-z0-9_-]{43}$/.test(key)){show('Вставьте токен из бота (jsi_…).','err');return;}
  try{proxy=parseProxyInput($('proxy').value,$('ptype').value);}catch(e){show(e.message,'err');return;}
  if(!proxy&&!confirm('Без прокси Facebook увидит IP сервера. Подключить всё равно?'))return;
  try{cookies=$('cookies').value.trim()?JSON.parse($('cookies').value):undefined;}catch(e){show('Cookies должны быть в формате JSON.','err');return;}
  try{localStorage.setItem('jsc_key',key);}catch(e){}
  var d=new Date(),today=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
  $('go').disabled=true;show('Проверяю соц через прокси…');
  api('/v1/connections',{userId:session.userId,token:session.tokens[0],tokenCandidates:session.tokens,userAgent:session.ua,proxy:proxy||undefined,cookies:cookies},key)
   .then(function(){show('Запускаю первый сбор…');return api('/v1/jobs',{userId:session.userId,since:today,until:today},key);})
   .then(function(){return api('/v1/schedule',{userId:session.userId,minutes:15},key);})
   .then(function(){$('proxy').value='';$('cookies').value='';show('Готово! Соц подключён, данные обновляются каждые 15 минут. Страницу можно закрыть.','ok');})
   .catch(function(e){show(e.message,'err');$('go').disabled=false;});
};
})();`;
}
