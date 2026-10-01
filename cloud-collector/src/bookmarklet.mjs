// "Like FBacc": no extension to install or publish. The client keeps a bookmark;
// in Ads Manager it reads the session (user id, access token, User-Agent) from
// the page and opens the JS Control connect page, passing data in the URL
// fragment (never sent to any server log). Nothing valuable runs on the client.
import {VERSION} from './version.mjs';

// The function must stay self-contained: it is serialized into the bookmark.
export function captureSession(origin, ver) {
  var u = location.hostname;
  if (!/(^|\.)facebook\.com$/.test(u) || !/adsmanager|business/.test(location.href)) { alert('Откройте Ads Manager нужного соца и нажмите закладку ещё раз.'); return; }
  var userId = '', name = '', tokens = [];
  var add = function (t) { if (typeof t === 'string' && /^EA[A-Za-z0-9_-]{18,4094}$/.test(t) && tokens.indexOf(t) < 0 && tokens.length < 3) tokens.push(t); };
  try { var cur = window.require('CurrentUserInitialData'); userId = String(cur.USER_ID || ''); name = String(cur.NAME || ''); } catch (e) {}
  try { add(window.__accessToken); } catch (e) {}
  ['AdsAPIConfig', 'AdsPEGlobal'].forEach(function (m) { try { var c = window.require(m); add(c && (c.accessToken || c.access_token)); } catch (e) {} });
  var scripts = document.querySelectorAll('script:not([src])');
  for (var i = 0; i < scripts.length && tokens.length < 3; i++) {
    var s = scripts[i].textContent || '';
    if (s.length > 1000000) continue;
    if (!userId) { var m = s.match(/"USER_ID"\s*:\s*"(\d{3,30})"/); if (m) userId = m[1]; }
    var re = /["'](EA[A-Za-z0-9]{20,4094})["']/g, x;
    while ((x = re.exec(s)) && tokens.length < 3) add(x[1]);
  }
  if (!/^\d{3,30}$/.test(userId) || !tokens.length) { alert('Не удалось найти доступ. Дождитесь полной загрузки Ads Manager (список кампаний) и нажмите закладку ещё раз.'); return; }
  var data = JSON.stringify({v: 1, build: ver || '', userId: userId, name: name.slice(0, 150), tokens: tokens, ua: navigator.userAgent});
  var b64 = btoa(unescape(encodeURIComponent(data))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  var url = origin + '/connect#s=' + b64;
  jsControlOpen(url);
}

// Antidetect profiles often block both popups and navigation away from the
// page, so (like FBacc) show an on-page button; a real click opens reliably.
// Defined as its own export only so the bookmark builder can inline it into
// each capture function's source (see buildBookmarklet below).
export function jsControlOpen(url) {
  try { var w = window.open(url, '_blank'); if (w) return; } catch (e) {}
  try { var old = document.getElementById('jsctrl-ov'); if (old) old.remove(); } catch (e) {}
  var d = document.createElement('div');
  d.id = 'jsctrl-ov';
  d.style.cssText = 'position:fixed;z-index:2147483647;top:14px;left:50%;transform:translateX(-50%);background:#0c111b;color:#edf2fa;border:1px solid #8fff8a;border-radius:12px;padding:12px 14px;font:14px system-ui;box-shadow:0 8px 30px rgba(0,0,0,.45);max-width:92%';
  var a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Открыть подключение JS Control';
  a.style.cssText = 'display:inline-block;background:#8fff8a;color:#0c111b;font-weight:700;text-decoration:none;padding:10px 14px;border-radius:8px';
  a.onclick = function () { setTimeout(function () { try { d.remove(); } catch (e) {} }, 200); };
  var x = document.createElement('span');
  x.textContent = '✕'; x.style.cssText = 'cursor:pointer;margin-left:14px;color:#aab8cc';
  x.onclick = function () { d.remove(); };
  d.appendChild(a); d.appendChild(x); document.body.appendChild(d);
}

// AdsPower variant: besides the token, it tries the AdsPower local API
// (http://local.adspower.net:50325) to read the open profile's proxy, so the
// connect page is pre-filled and server-side collection needs no manual proxy.
// Reaching localhost from an https page may be blocked (mixed content / Private
// Network Access); on failure the proxy is just left for manual entry. Must stay
// self-contained: serialized into the bookmark.
export function captureAdsPower(origin, ver) {
  var u = location.hostname;
  if (!/(^|\.)facebook\.com$/.test(u) || !/adsmanager|business/.test(location.href)) { alert('Откройте Ads Manager нужного профиля AdsPower и нажмите закладку ещё раз.'); return; }
  var userId = '', name = '', tokens = [];
  var add = function (t) { if (typeof t === 'string' && /^EA[A-Za-z0-9_-]{18,4094}$/.test(t) && tokens.indexOf(t) < 0 && tokens.length < 3) tokens.push(t); };
  try { var cur = window.require('CurrentUserInitialData'); userId = String(cur.USER_ID || ''); name = String(cur.NAME || ''); } catch (e) {}
  try { add(window.__accessToken); } catch (e) {}
  ['AdsAPIConfig', 'AdsPEGlobal'].forEach(function (m) { try { var c = window.require(m); add(c && (c.accessToken || c.access_token)); } catch (e) {} });
  var scripts = document.querySelectorAll('script:not([src])');
  for (var i = 0; i < scripts.length && tokens.length < 3; i++) {
    var s = scripts[i].textContent || '';
    if (s.length > 1000000) continue;
    if (!userId) { var m = s.match(/"USER_ID"\s*:\s*"(\d{3,30})"/); if (m) userId = m[1]; }
    var re = /["'](EA[A-Za-z0-9]{20,4094})["']/g, x;
    while ((x = re.exec(s)) && tokens.length < 3) add(x[1]);
  }
  if (!/^\d{3,30}$/.test(userId) || !tokens.length) { alert('Не удалось найти доступ. Дождитесь полной загрузки Ads Manager и нажмите закладку ещё раз.'); return; }
  var open = function (proxy) {
    var data = JSON.stringify({v: 1, build: ver || '', userId: userId, name: name.slice(0, 150), tokens: tokens, ua: navigator.userAgent, proxy: proxy || null, source: 'adspower'});
    var b64 = btoa(unescape(encodeURIComponent(data))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    var url = origin + '/connect#s=' + b64;
    jsControlOpen(url);
  };
  var tryApi = function (base, next) {
    try {
      fetch(base + '/api/v1/user/list?page_size=100', {signal: AbortSignal.timeout(4000)})
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var list = (j && j.data && j.data.list) || [];
          var hit = list.filter(function (p) { return [p.username, p.remark, p.name].join(' ').indexOf(userId) >= 0; });
          var pick = hit.length === 1 ? hit[0] : list.length === 1 ? list[0] : null;
          var c = pick && pick.user_proxy_config, proxy = null;
          if (c && c.proxy_host && c.proxy_port && (c.proxy_soft || c.proxy_type) && String(c.proxy_type).toLowerCase() !== 'no_proxy') {
            var t = /socks/.test(String(c.proxy_type).toLowerCase()) ? 'socks5' : 'http';
            proxy = {server: t + '://' + c.proxy_host + ':' + c.proxy_port, username: c.proxy_user || '', password: c.proxy_password || ''};
          }
          open(proxy);
        })
        .catch(function () { next(); });
    } catch (e) { next(); }
  };
  tryApi('http://local.adspower.net:50325', function () { tryApi('http://127.0.0.1:50325', function () { open(null); }); });
}

// Inlines jsControlOpen so the serialized bookmark is self-contained.
function buildBookmarklet(fn, origin) {
  return 'javascript:' + encodeURIComponent('(function(){var fn=' + fn.toString() + ';var jsControlOpen=' + jsControlOpen.toString() + ';fn(' + JSON.stringify(origin) + ',' + JSON.stringify(VERSION) + ');})();void 0');
}

export function bookmarkletHref(origin) {
  return buildBookmarklet(captureSession, origin);
}

export function adsPowerBookmarkletHref(origin) {
  return buildBookmarklet(captureAdsPower, origin);
}
