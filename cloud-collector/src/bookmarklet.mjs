// "Like FBacc": no extension to install or publish. The client keeps a bookmark;
// in Ads Manager it reads the session (user id, access token, User-Agent) from
// the page and opens the JS Control connect page, passing data in the URL
// fragment (never sent to any server log). Nothing valuable runs on the client.
// The function must stay self-contained: it is serialized into the bookmark.
export function captureSession(origin) {
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
  var data = JSON.stringify({v: 1, userId: userId, name: name.slice(0, 150), tokens: tokens, ua: navigator.userAgent});
  var b64 = btoa(unescape(encodeURIComponent(data))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  window.open(origin + '/connect#s=' + b64, '_blank');
}

export function bookmarkletHref(origin) {
  return 'javascript:' + encodeURIComponent('(' + captureSession.toString() + ')(' + JSON.stringify(origin) + ');void 0');
}
