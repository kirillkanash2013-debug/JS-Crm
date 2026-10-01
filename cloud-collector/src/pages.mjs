// Public pages of the collector: bookmark install and social connect.
// Same origin as the API, so the page calls /v1/* without CORS.
import {adsPowerBookmarkletHref, bookmarkletHref, consoleSnippet} from './bookmarklet.mjs';
import {VERSION} from './version.mjs';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
button{border:0;border-radius:8px;padding:12px 16px;background:var(--accent);color:#0c111b;font:600 15px system-ui;cursor:pointer;width:100%;margin-top:14px}button:disabled{opacity:.5}button.secondary{background:transparent;color:var(--muted);border:1px solid var(--line)}
.tableScroll{overflow:auto;margin-top:10px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600}
.ver{color:var(--muted);font-size:11px;text-align:center;margin-top:18px;opacity:.7}
.bm{display:inline-block;padding:12px 18px;border-radius:10px;background:var(--accent);color:#0c111b;font-weight:700;text-decoration:none;cursor:grab}
.status{margin-top:12px;font-size:14px}.status.err{color:var(--err)}.status.ok{color:var(--accent)}ol{padding-left:20px;color:var(--muted)}code{word-break:break-all}`;

const page = (title, body, script = '') => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title><style>${css}</style></head><body><main>${body}<p class="ver">JS Control v${VERSION}</p></main>${script}</body></html>`;

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

// Simple check page: paste the key, see connected socials and today's spend.
// No bot needed — proves collection ran even with the browser closed.
export function statusPage() {
  return page('JS Control — проверка сбора', `<h1>Проверка сбора</h1>
<section>
<label for="key">Токен JS Control (jsi_… или js_srv_…)</label><input id="key" type="password" autocomplete="off" placeholder="js_srv_… или jsi_…">
<button id="go" disabled>Показать</button>
<button id="collect" class="secondary" hidden>Запустить сбор сейчас</button>
<div id="status" class="status" role="status"></div>
<div id="out"></div></section>
<p class="hint">Данные берутся с сервера. Если spend за сегодня появился после того, как вы закрыли браузер — сбор идёт автономно.</p>`, '<script src="/status.js"></script>');
}

export function statusScript() {
  return `(function(){'use strict';
var $=function(id){return document.getElementById(id);};
var key='';try{$('key').value=localStorage.getItem('jsc_key')||'';}catch(e){}
var show=function(t,cls){var s=$('status');s.textContent=t;s.className='status '+(cls||'');};
var ERR={401:'Токен не подошёл.',402:'Подписка закончилась.',404:'Сбор ещё не настроен для этого токена.'};
function api(path,method,body){return fetch(path,{method:method||'GET',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok)throw new Error(ERR[r.status]||j.error||('Ошибка '+r.status));return j;});});}
$('key').oninput=function(){$('go').disabled=!/^(jsi|js_srv)_[A-Za-z0-9_-]{43}$/.test($('key').value.trim());};$('key').oninput();
var today=function(){var d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);};
function render(){
  show('Загружаю…');
  Promise.all([api('/v1/status'),api('/v1/report?since='+today()+'&until='+today()).catch(function(){return {rows:[],totals:{}};})]).then(function(res){
    var st=res[0],rep=res[1],conns=st.connections||[];
    $('collect').hidden=!conns.length;
    var rows=conns.map(function(c){
      var last=c.schedule?'каждые '+c.schedule.minutes+' мин':'разово';
      return '<tr><td>'+(c.label||c.userId)+'</td><td>'+(c.collectMode||'api')+'</td><td>'+last+'</td></tr>';
    }).join('');
    var totals=Object.keys(rep.totals||{}).map(function(k){return rep.totals[k]+' '+k;}).join(' · ')||'нет данных';
    $('out').innerHTML='<p class="hint">Соцов: '+conns.length+'. Spend за сегодня: <b>'+totals+'</b> ('+(rep.rows||[]).length+' строк).</p>'+
      (rows?'<div class="tableScroll"><table><thead><tr><th>Соц</th><th>Режим</th><th>Обновление</th></tr></thead><tbody>'+rows+'</tbody></table></div>':'');
    show('Обновлено '+new Date().toLocaleTimeString(),'ok');
  }).catch(function(e){show(e.message,'err');});
}
$('go').onclick=function(){key=$('key').value.trim();try{localStorage.setItem('jsc_key',key);}catch(e){}render();};
$('collect').onclick=function(){
  show('Запускаю сбор…');
  api('/v1/status').then(function(st){
    var ids=(st.connections||[]).map(function(c){return c.userId;});
    return Promise.all(ids.map(function(u){return api('/v1/jobs','POST',{userId:u,since:today(),until:today()});}));
  }).then(function(){show('Сбор запущен. Обновите через минуту.','ok');}).catch(function(e){show(e.message,'err');});
};
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
<p class="hint">AdsPower должен быть запущен. Новые версии Chrome спрашивают разрешение на доступ к локальной сети (Local Network Access) — разрешите его, иначе прокси впишите вручную на странице подключения.</p></section>
<section><h2>Если закладка не срабатывает — через консоль</h2>
<p>В профиле на вкладке Ads Manager нажмите <b>F12</b> → вкладка <b>Console</b>. Если браузер просит — напечатайте вручную <code>allow pasting</code> и Enter. Затем вставьте этот код и нажмите Enter:</p>
<textarea id="snippet" readonly style="min-height:120px;font:11px monospace">${esc(consoleSnippet(origin))}</textarea>
<p class="hint">Это наш собственный код: он читает токен на открытой странице и показывает зелёную кнопку «Открыть подключение». Если что-то не так — консоль покажет ошибку (пришлите её скрин).</p></section>`);
}

export function connectPage() {
  return page('JS Control — подключение соца', `<h1>Подключение соца</h1>
<section id="step1">
<label for="key">Шаг 1. Токен из бота JS Control</label><input id="key" type="password" autocomplete="off" placeholder="jsi_… или js_srv_…">
<p class="hint">Токен привязывает этот соц к вашему оплаченному аккаунту.</p>
<button id="verify">Проверить токен</button><div id="status1" class="status" role="status"></div></section>
<section id="step2" hidden>
<p>Аккаунт: <b id="account"></b><span id="who2"></span></p>
<label for="label">Название профиля (как в антидетекте)</label><input id="label" autocomplete="off" placeholder="например, Farm-12">
<label for="token">Шаг 2. Токен доступа Facebook (EAA…)</label><input id="token" type="password" autocomplete="off" placeholder="EAAB…">
<p class="hint">Если подключаете закладкой — поле уже заполнено. Иначе вставьте токен, полученный нашим способом (см. инструкцию).</p>
<label for="uid">ID соца (если не вставляете cookies)</label><input id="uid" autocomplete="off" inputmode="numeric" placeholder="например, 100200300…">
<p class="hint">Числовой ID берётся из cookies автоматически. Если cookies не вставляете — впишите ID вручную (его тоже показывает наш способ).</p>
<label for="proxy">Прокси соца (тот же, что в профиле браузера)</label>
<div class="row"><select id="ptype"><option value="http">HTTP</option><option value="socks5">SOCKS5</option></select><input id="proxy" autocomplete="off" placeholder="host:port:логин:пароль"></div>
<p class="hint" id="proxyNote">Через этот прокси сервер будет обновлять данные каждые 15 минут — Facebook видит привычный IP.</p>
<label for="cookies">Cookies профиля (JSON)</label>
<p class="hint">Экспортируйте cookies профиля в AdsPower (профиль → экспорт cookies) и вставьте сюда. Из них берётся ID соца; с ними сервер сам обновляет доступ при закрытом браузере.</p>
<textarea id="cookies" placeholder='[{"name":"c_user","value":"100...","domain":".facebook.com"}, ...]'></textarea>
<label class="check"><input id="consent" type="checkbox"> Разрешаю передать токен, User-Agent, прокси и cookies серверу JS Control для сбора статистики.</label>
<button id="go" disabled>Подключить и запустить сбор</button>
<button id="back" class="secondary">Назад</button><div id="status" class="status" role="status"></div></section>`, '<script src="/connect.js"></script>');
}

export function connectScript() {
  return `(function(){'use strict';
var parseProxyInput=${parseProxyInput.toString()};
var $=function(id){return document.getElementById(id);};
var session=null,key='';
try{var m=location.hash.match(/s=([A-Za-z0-9_-]+)/);if(m){var b=m[1].replace(/-/g,'+').replace(/_/g,'/');session=JSON.parse(decodeURIComponent(escape(atob(b+'==='.slice((b.length+3)%4)))));}}catch(e){session=null;}
history.replaceState(null,'',location.pathname);
try{$('key').value=localStorage.getItem('jsc_key')||'';}catch(e){}
// From the bookmark: prefill token, name and (AdsPower) proxy. Without it, all
// fields are filled by hand (token from FBAcc, cookies from AdsPower export).
if(session&&session.tokens&&session.tokens.length)$('token').value=session.tokens[0];
if(session&&session.name)$('label').value=session.name;
if(session&&session.proxy&&session.proxy.server){try{
  var pu=new URL(session.proxy.server);$('ptype').value=pu.protocol==='socks5:'?'socks5':'http';
  $('proxy').value=pu.hostname+':'+pu.port+(session.proxy.username?':'+session.proxy.username+(session.proxy.password?':'+session.proxy.password:''):'');
  $('proxyNote').textContent='Прокси получен из профиля '+(session.source==='adspower'?'AdsPower':'антидетекта')+' автоматически. Проверьте и при необходимости поправьте.';
}catch(e){}}
var show=function(id,t,cls){var s=$(id);s.textContent=t;s.className='status '+(cls||'');};
// c_user in the cookies export identifies the social; no bookmark needed.
var userIdFromCookies=function(list){try{for(var i=0;i<list.length;i++){if(list[i].name==='c_user'&&/facebook\\.com$/.test(String(list[i].domain||''))&&/^\\d{3,30}$/.test(String(list[i].value||'')))return String(list[i].value);}}catch(e){}return '';};
var ERR={401:'Токен не подошёл. Возьмите токен в боте JS Control.',402:'Подписка закончилась. Продлите её в боте.',409:'Достигнут лимит соцов по тарифу.',
  proxy_failed:'Не удалось подключиться через прокси. Проверьте адрес, порт, логин и пароль.',token_invalid:'Facebook не принял доступ. Обновите Ads Manager и нажмите закладку ещё раз.',
  wrong_user:'Доступ относится к другому соцу. Нажмите закладку в Ads Manager нужного соца.',cookies_owner:'Cookies относятся к другому соцу.',validation_failed:'Не удалось проверить соц. Повторите позже.'};
var api=function(path,body,method){return fetch(path,{method:method||'POST',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok)throw new Error(ERR[j.error]||ERR[r.status]||('Ошибка '+r.status));return j;});});};
// Step 1: verify the token, show the account, go to step 2.
$('verify').onclick=function(){
  key=$('key').value.trim();
  if(!/^(jsi|js_srv)_[A-Za-z0-9_-]{43}$/.test(key)){show('status1','Вставьте токен из бота (jsi_…).','err');return;}
  $('verify').disabled=true;show('status1','Проверяю токен…');
  api('/v1/me',null,'GET').then(function(j){
    try{localStorage.setItem('jsc_key',key);}catch(e){}
    $('account').textContent=(j.account&&j.account.name||'аккаунт')+(j.account&&j.account.plan?' · '+j.account.plan:'');
    $('who2').textContent=session&&session.userId?' · соц '+session.userId:'';
    $('step1').hidden=true;$('step2').hidden=false;
  }).catch(function(e){show('status1',e.message,'err');$('verify').disabled=false;});
};
$('back').onclick=function(){$('step2').hidden=true;$('step1').hidden=false;$('verify').disabled=false;};
var sync=function(){$('go').disabled=!$('consent').checked;};$('consent').onchange=sync;
// Step 2: send proxy + cookies, connect and schedule.
$('go').onclick=function(){
  var token=$('token').value.trim(),proxy,cookies;
  if(!/^EA[A-Za-z0-9_-]{18,4094}$/.test(token)){show('status','Вставьте токен доступа Facebook (начинается с EAA). Его показывает FBAcc.','err');return;}
  try{proxy=parseProxyInput($('proxy').value,$('ptype').value);}catch(e){show('status',e.message,'err');return;}
  if(!proxy&&!confirm('Без прокси Facebook увидит IP сервера. Подключить всё равно?'))return;
  try{cookies=$('cookies').value.trim()?JSON.parse($('cookies').value):undefined;}catch(e){show('status','Cookies должны быть в формате JSON (экспорт из AdsPower).','err');return;}
  // userId: from the bookmark, else the cookies c_user, else the typed field.
  var userId=session&&session.userId?session.userId:(cookies?userIdFromCookies(cookies):'');
  if(!userId)userId=$('uid').value.trim();
  if(!/^\\d{3,30}$/.test(userId)){show('status','Не удалось определить ID соца. Впишите «ID соца» или вставьте cookies профиля (в них есть c_user).','err');return;}
  var ua=session&&session.ua?session.ua:navigator.userAgent;
  var d=new Date(),today=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
  $('go').disabled=true;show('status','Проверяю соц через прокси…');
  api('/v1/connections',{userId:userId,token:token,tokenCandidates:(session&&session.tokens||[token]),userAgent:ua,label:$('label').value.trim()||undefined,proxy:proxy||undefined,cookies:cookies})
   .then(function(){show('status','Запускаю первый сбор…');return api('/v1/jobs',{userId:userId,since:today,until:today});})
   .then(function(){return api('/v1/schedule',{userId:userId,minutes:15});})
   .then(function(){$('token').value='';$('proxy').value='';$('cookies').value='';show('status','Готово! Соц подключён, данные обновляются каждые 15 минут. Страницу можно закрыть.','ok');})
   .catch(function(e){show('status',e.message,'err');$('go').disabled=false;});
};
})();`;
}
