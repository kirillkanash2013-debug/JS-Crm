// Validation of a social connection sent by the bookmarklet page or the extension.
// Cookies are optional (a bookmarklet cannot read HttpOnly cookies); with them
// the server can restore a dead token through the browser fallback.
import {parseProxy} from './proxy-fetch.mjs';

const FB_DOMAIN = /^\.?([a-z0-9-]+\.)*facebook\.com$/;

export function cleanCookies(list, userId) {
  if (list == null || (Array.isArray(list) && !list.length)) return [];
  if (!Array.isArray(list) || list.length > 200) throw Object.assign(new Error('Invalid cookies'), {code: 'cookies'});
  const cookies = list.filter(c => FB_DOMAIN.test(String(c?.domain || ''))).map(c => {
    if (typeof c.name !== 'string' || !c.name || c.name.length > 200 || typeof c.value !== 'string' || c.value.length > 10000) throw Object.assign(new Error('Invalid cookies'), {code: 'cookies'});
    const sameSite = {no_restriction: 'None', unspecified: 'Lax', lax: 'Lax', strict: 'Strict', None: 'None', Lax: 'Lax', Strict: 'Strict'}[c.sameSite] || 'Lax';
    const expires = Number(c.expires ?? c.expirationDate);
    return {name: c.name, value: c.value, domain: c.domain, path: typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/', httpOnly: !!c.httpOnly, secure: c.secure !== false, sameSite, expires: Number.isFinite(expires) ? expires : -1};
  });
  if (!cookies.some(c => c.name === 'c_user' && c.value === userId)) throw Object.assign(new Error('Cookies belong to another account'), {code: 'cookies_owner'});
  return cookies;
}

export function cleanConnection(b) {
  const userId = String(b?.userId || '');
  const tokens = [b?.token, ...(Array.isArray(b?.tokenCandidates) ? b.tokenCandidates : [])].filter(t => typeof t === 'string' && /^EA[A-Za-z0-9_-]{18,4094}$/.test(t));
  if (!/^\d{3,30}$/.test(userId) || !tokens.length) throw Object.assign(new Error('Invalid connection'), {code: 'invalid'});
  const userAgent = String(b.userAgent || '');
  if (userAgent.length < 10 || userAgent.length > 1024) throw Object.assign(new Error('Invalid user agent'), {code: 'invalid'});
  let proxy;
  if (b.proxy?.server) {
    const p = parseProxy(b.proxy); // throws on bad / private proxies
    proxy = {server: (p.type === 'http' ? 'http://' : 'socks5://') + (p.host.includes(':') ? '[' + p.host + ']' : p.host) + ':' + p.port};
    for (const k of ['username', 'password']) if (b.proxy[k]) {
      if (typeof b.proxy[k] !== 'string' || b.proxy[k].length > 1024) throw Object.assign(new Error('Invalid proxy'), {code: 'proxy'});
      proxy[k] = b.proxy[k];
    }
  }
  return {userId, token: tokens[0], tokenCandidates: [...new Set(tokens)].slice(0, 3), userAgent, proxy, cookies: cleanCookies(b.cookies, userId)};
}
