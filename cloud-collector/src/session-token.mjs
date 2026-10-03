// Fresh access token from a logged-in session without a browser: load the
// Ads Manager page through the profile's proxy with its cookies and find the
// token in the inline boot scripts (what the bookmark/FBacc read in a page).
import {httpsGet} from './proxy-fetch.mjs';
import {cookieHeader} from './proxy-fetch.mjs';

const PAGE = '/adsmanager/manage/campaigns';
const dec = new TextDecoder();

export function tokensFromHtml(html) {
  const tokens = [];
  const add = t => { if (/^EA[A-Za-z0-9_-]{18,4094}$/.test(t) && !tokens.includes(t) && tokens.length < 3) tokens.push(t); };
  const direct = html.match(/__accessToken\s*=\s*["'](EA[A-Za-z0-9_-]+)["']/);
  if (direct) add(direct[1]);
  for (const m of html.matchAll(/["'](?:accessToken|access_token)["']\s*:\s*["'](EA[A-Za-z0-9_-]{18,4094})["']/g)) add(m[1]);
  for (const m of html.matchAll(/["'](EA[A-Za-z0-9]{20,4094})["']/g)) add(m[1]);
  const user = html.match(/"USER_ID"\s*:\s*"(\d{3,30})"/);
  return {userId: user ? user[1] : null, tokens};
}

// Returns {userId, tokens} or throws {code:'needs_auth'} when the cookies are dead.
export async function tokenFromSession(connection, {connect}) {
  let host = 'adsmanager.facebook.com', path = PAGE;
  for (let hop = 0; hop < 3; hop++) {
    const r = await httpsGet(host, path, {connect, proxy: connection.proxy, signal: AbortSignal.timeout(30000), headers: {
      'User-Agent': connection.userAgent, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9',
      Cookie: cookieHeader(connection.storageState?.cookies || connection.cookies)}});
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      const next = new URL(r.headers.get('location'), 'https://' + host);
      if (/login|checkpoint/.test(next.pathname)) throw Object.assign(new Error('Session requires login'), {code: 'needs_auth'});
      host = next.hostname; path = next.pathname + next.search;
      continue;
    }
    if (r.status !== 200) throw Object.assign(new Error('Ads Manager HTTP ' + r.status), {code: 'session_page'});
    const found = tokensFromHtml(dec.decode(r.body));
    if (!found.tokens.length) throw Object.assign(new Error('No token on the page'), {code: 'session_page'});
    return found;
  }
  throw Object.assign(new Error('Too many redirects'), {code: 'session_page'});
}
