// Graph API reads through the social's proxy, in Node (reliable SOCKS5 + TLS,
// including SOCKS5 with login — which Chromium cannot do). Used by the cheap
// API collection when a proxy is set; the Cloudflare Worker socket path only
// handles the no-proxy case.
import https from 'node:https';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {SocksProxyAgent} from 'socks-proxy-agent';

const GRAPH = 'graph.facebook.com';

function agentFor(proxy) {
  if (!proxy?.server) return undefined;
  const u = new URL(proxy.server);
  const auth = proxy.username ? encodeURIComponent(proxy.username) + ':' + encodeURIComponent(proxy.password || '') + '@' : '';
  const protocol=u.protocol==='socks5:'?'socks5h:':u.protocol;
  const url = protocol + '//' + auth + u.host;
  return u.protocol.startsWith('socks') ? new SocksProxyAgent(url, {timeout: 20000}) : new HttpsProxyAgent(url, {timeout: 20000});
}

const FB_DOMAIN = /(^|\.)facebook\.com$/;
export function cookieHeader(cookies) {
  return (cookies || []).filter(c => FB_DOMAIN.test(String(c.domain || '')) && /^[^\s;=]+$/.test(c.name || '') && !/[\r\n;]/.test(c.value || ''))
    .map(c => c.name + '=' + c.value).join('; ');
}

function once(agent, u, headers, signal) {
  return new Promise((resolve, reject) => {
    const req = https.request(u, {method: 'GET', agent, headers, timeout: 20000, signal}, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => { size += c.length; if (size > 16 * 1024 * 1024) { req.destroy(); reject(err('too_large', 'response too large')); } else chunks.push(c); });
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(text)}); });
    });
    req.on('timeout', () => { req.destroy(); reject(err('proxy', 'Истекло время ожидания прокси')); });
    req.on('error', e => reject(err('proxy', proxyReason(e))));
    req.end();
  });
}

function proxyReason(e) {
  const m = String(e && e.message || e);
  if (/auth|credential|407/i.test(m)) return 'Прокси отклонил логин или пароль';
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socks/i.test(m)) return 'Прокси не принимает подключение (возможно, привязан к вашему IP)';
  if (/certificate|TLS|SSL|handshake/i.test(m)) return 'TLS через прокси не установился: ' + m;
  return 'Не удалось подключиться через прокси: ' + m;
}
function err(code, detail) { return Object.assign(new Error(detail), {code, detail}); }

// Graph API call (GET or POST) through the social's proxy, in Node — so campaign
// WRITES (status / daily budget) go through SOCKS5-with-login too, which Chromium
// refuses («Browser does not support socks5 proxy authentication»). Returns
// {httpStatus, body}. nodeGraphFetcher above stays read-only on purpose; this is
// the write-capable sibling used only by campaign actions.
export function nodeGraphRequest(connection) {
  const agent = agentFor(connection.proxy);
  const deadline=Date.now()+4*60000;
  const cookies = cookieHeader(connection.storageState?.cookies || connection.cookies);
  return (method, path, params = {}) => new Promise((resolve, reject) => {
    if(Date.now()>=deadline)return reject(err('timeout','Истекло время выполнения запроса'));
    const u = new URL('https://' + GRAPH + '/v25.0/' + path);
    const form = new URLSearchParams({access_token: connection.token, ...params}).toString();
    if (method === 'GET') u.search = form;
    const headers = {'User-Agent': connection.userAgent, Accept: '*/*', ...(cookies ? {Cookie: cookies} : {}), Origin: 'https://adsmanager.facebook.com', Referer: 'https://adsmanager.facebook.com/'};
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const req = https.request(u, {method, agent, headers, timeout: 20000, signal:AbortSignal.timeout(Math.max(1,Math.min(30000,deadline-Date.now())))}, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > 8 * 1024 * 1024) { req.destroy(); reject(err('too_large', 'response too large')); } else chunks.push(c); });
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let body = {}; try { body = JSON.parse(text); } catch {} resolve({httpStatus: res.statusCode, body}); });
    });
    req.on('timeout', () => { req.destroy(); reject(err('proxy', 'Истекло время ожидания прокси')); });
    req.on('error', e => reject(err('proxy', proxyReason(e))));
    req.end(method === 'POST' ? form : undefined);
  });
}

// fetch-compatible adapter for extension/meta.mjs and structure.mjs.
export function nodeGraphFetcher(connection) {
  const agent = agentFor(connection.proxy);
  const deadline=Date.now()+4*60000;
  const cookies = cookieHeader(connection.storageState?.cookies || connection.cookies);
  const fetcher = async (url, options = {}) => {
    if(Date.now()>=deadline)throw err('timeout','Истекло время сбора');
    const signals=[AbortSignal.timeout(Math.max(1,Math.min(30000,deadline-Date.now())))];
    if(options.signal)signals.push(options.signal);
    const u = new URL(url);
    if (u.hostname !== GRAPH || (options.method || 'GET') !== 'GET') throw err('transport', 'Only Graph API reads are allowed');
    const auth = options.headers?.Authorization || '';
    if (auth.startsWith('Bearer ')) u.searchParams.set('access_token', auth.slice(7));
    return once(agent, u, {'User-Agent': connection.userAgent, Accept: '*/*', ...(cookies ? {Cookie: cookies} : {}), Origin: 'https://adsmanager.facebook.com', Referer: 'https://adsmanager.facebook.com/'},AbortSignal.any(signals));
  };
  fetcher.pageContext = true; // no batch fallback; requests carry the session
  return fetcher;
}
