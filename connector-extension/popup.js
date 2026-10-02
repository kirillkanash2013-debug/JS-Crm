"use strict";
const COLLECTOR = "https://js-control-collector-claude.kirill-kanash2013.workers.dev";
const $ = (id) => document.getElementById(id);
const show = (t, cls) => { const s = $("status"); s.textContent = t; s.className = cls || ""; };

// Restore the key.
chrome.storage.local.get("key").then((o) => { if (o.key) $("key").value = o.key; });

// Runs in the Ads Manager page (MAIN world) and returns the FB user id + token,
// exactly what FBacc/Dolphin read from the loaded page. No cookies here.
function readSession() {
  var userId = "", name = "", tokens = [];
  var add = function (t) { if (typeof t === "string" && /^EA[A-Za-z0-9_-]{18,4094}$/.test(t) && tokens.indexOf(t) < 0 && tokens.length < 3) tokens.push(t); };
  try { var cur = window.require("CurrentUserInitialData"); userId = String(cur.USER_ID || ""); name = String(cur.NAME || ""); } catch (e) {}
  try { add(window.__accessToken); } catch (e) {}
  ["AdsAPIConfig", "AdsPEGlobal"].forEach(function (m) { try { var c = window.require(m); add(c && (c.accessToken || c.access_token)); } catch (e) {} });
  var scripts = document.querySelectorAll("script:not([src])");
  for (var i = 0; i < scripts.length && tokens.length < 3; i++) {
    var s = scripts[i].textContent || "";
    if (s.length > 1000000) continue;
    if (!userId) { var mm = s.match(/"USER_ID"\s*:\s*"(\d{3,30})"/); if (mm) userId = mm[1]; }
    var re = /["'](EA[A-Za-z0-9]{20,4094})["']/g, x;
    while ((x = re.exec(s)) && tokens.length < 3) add(x[1]);
  }
  return { userId: userId, name: name.slice(0, 150), tokens: tokens, ua: navigator.userAgent };
}

function parseProxy(cfg) {
  if (!cfg || !cfg.proxy_host || !cfg.proxy_port) return null;
  var kind = String(cfg.proxy_type || "").toLowerCase();
  if (!kind || kind === "no_proxy") return null;
  var type = /socks/.test(kind) ? "socks5" : "http";
  var p = { server: type + "://" + cfg.proxy_host + ":" + cfg.proxy_port };
  if (cfg.proxy_user) p.username = cfg.proxy_user;
  if (cfg.proxy_password) p.password = cfg.proxy_password;
  return p;
}

// AdsPower local API (reachable from an extension with host permission).
// Returns the matched profile's proxy AND its name in the antidetect — the name
// the client gave the profile, which is what they want to see as the soc's label
// (not the Facebook account's display name).
async function adsPowerProfile(userId) {
  for (const base of ["http://local.adspower.net:50325", "http://127.0.0.1:50325"]) {
    try {
      const r = await fetch(base + "/api/v1/user/list?page_size=100", { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      const list = (j && j.data && j.data.list) || [];
      const hit = list.filter((p) => [p.username, p.remark, p.name].join(" ").indexOf(userId) >= 0);
      const pick = hit.length === 1 ? hit[0] : list.length === 1 ? list[0] : null;
      if (pick) return { proxy: parseProxy(pick.user_proxy_config), name: (pick.name || pick.remark || pick.username || "").slice(0, 150) || null };
    } catch (e) {}
  }
  return { proxy: null, name: null };
}

// Human text for whatever interval the SERVER returned — nothing about the
// schedule is decided or stored here; the plugin only reflects the server.
function intervalText(s) {
  var m = s && s.minutes;
  if (!m) return " автоматически";
  if (m % 60 === 0) { var h = m / 60; return h === 1 ? " раз в час" : " раз в " + h + " ч"; }
  return " каждые " + m + " мин";
}

async function cookies() {
  try {
    const all = await chrome.cookies.getAll({ domain: "facebook.com" });
    return all.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, expires: c.expirationDate || -1 }));
  } catch (e) { return []; }
}

async function api(path, key, body) {
  const r = await fetch(COLLECTOR + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + key, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const map = { 401: "Ключ не подошёл.", 402: "Подписка закончилась.", 409: "Лимит соцов по тарифу.", proxy_failed: "Прокси не отвечает.", token_invalid: "Facebook не принял токен — обновите Ads Manager.", wrong_user: "Открыт другой соц.", validation_failed: "Не удалось проверить соц." };
    throw new Error((map[j.error] || map[r.status] || "Ошибка " + r.status) + (j.detail ? "\n(" + j.detail + ")" : ""));
  }
  return j;
}

$("go").onclick = async () => {
  const key = $("key").value.trim();
  if (!/^(jsi|js_srv)_[A-Za-z0-9_-]{43}$/.test(key)) return show("Вставьте ключ доступа (jsi_… или js_srv_…).", "err");
  await chrome.storage.local.set({ key });
  $("go").disabled = true;
  let proxyInfo = "";
  try {
    show("Проверяю ключ…");
    await api("/v1/me", key);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/(adsmanager|business|www)\.facebook\.com\//.test(tab.url || "")) throw new Error("Откройте в этом профиле вкладку Ads Manager нужного соца.");
    show("Читаю токен со страницы…");
    const [{ result: session }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: readSession });
    if (!session || !/^\d{3,30}$/.test(session.userId) || !session.tokens.length) throw new Error("Не нашёл токен. Дождитесь полной загрузки списка кампаний и нажмите снова.");
    show("Беру cookies и прокси профиля…");
    const ck = await cookies();
    const profile = $("noproxy").checked ? { proxy: null, name: null } : await adsPowerProfile(session.userId);
    const proxy = profile.proxy;
    // Label the soc by the antidetect profile name; fall back to the FB account
    // name only if the profile name couldn't be read (e.g. AdsPower not running).
    const label = profile.name || session.name || undefined;
    proxyInfo = $("noproxy").checked ? "\nБез прокси (тест): Facebook видит IP сервера." : proxy ? "\nПрокси: " + proxy.server + " (логин: " + (proxy.username ? "есть" : "нет") + ")" : "\nПрокси профиля не найден (AdsPower запущен?).";
    show("Подключаю соц на сервере…" + proxyInfo);
    // Only credentials go up. The server sets the schedule and starts the
    // first collection itself; all settings live on the server, not here.
    const res = await api("/v1/connections", key, { userId: session.userId, token: session.tokens[0], tokenCandidates: session.tokens, userAgent: session.ua, label: label, proxy: proxy || undefined, cookies: ck.length ? ck : undefined });
    show("✓ Готово! Соц «" + (label || session.userId) + "» подключён." + (proxy ? "" : "\nПрокси профиля не найден — проверьте, что AdsPower запущен, иначе Facebook увидит IP сервера.") + "\nСервер запустил сбор и обновляет данные" + intervalText(res && res.schedule) + ". Браузер можно закрыть.", "ok");
  } catch (e) {
    show((e.message || String(e)) + proxyInfo, "err");
  } finally {
    $("go").disabled = false;
  }
};
