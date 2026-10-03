// Dolphin Anty cloud API (https://dolphin-anty-api.com, Bearer API token from
// Dolphin Anty → API). Cookies come from the sync API and only for profiles
// with cloud sync enabled (not available on the free plan).
const API = 'https://dolphin-anty-api.com';
const SYNC = 'https://darkwing.dolphin-anty-api.com/api/v1';
const MAX_PAGES = 40; // 2000 profiles

export function proxyFromDolphin(p) {
  if (!p?.host || !p?.port || !['http', 'https', 'socks5'].includes(String(p.type || '').toLowerCase())) return null;
  const type = String(p.type).toLowerCase() === 'socks5' ? 'socks5' : 'http';
  return {server: type + '://' + p.host + ':' + p.port, username: p.login || '', password: p.password || ''};
}

export function dolphinAnty(token, fetcher = fetch) {
  const call = async (url, init = {}) => {
    const r = await fetcher(url, {...init, headers: {Authorization: 'Bearer ' + token, Accept: 'application/json', ...(init.body ? {'Content-Type': 'application/json'} : {}), ...init.headers}, signal: AbortSignal.timeout(20000)});
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Dolphin Anty rejected the token'), {code: 'antidetect_auth'});
    if (!r.ok) throw Object.assign(new Error('Dolphin Anty HTTP ' + r.status), {code: 'antidetect_http', status: r.status});
    return r.json();
  };
  const proxies = new Map();
  return {
    async profiles() {
      const out = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const json = await call(API + '/browser_profiles?limit=50&page=' + page);
        const list = Array.isArray(json.data) ? json.data : [];
        for (const p of list) {
          let proxy = proxyFromDolphin(p.proxy);
          // The list may carry only a proxy reference; the saved proxy has the credentials.
          if (!proxy && p.proxy?.id) {
            if (!proxies.has(p.proxy.id)) proxies.set(p.proxy.id, await call(API + '/proxy/' + p.proxy.id).then(j => proxyFromDolphin(j.data || j)).catch(() => null));
            proxy = proxies.get(p.proxy.id);
          }
          out.push({id: String(p.id), name: String(p.name || 'Профиль ' + p.id).slice(0, 150), userAgent: p.useragent?.value || null, proxy});
        }
        const last = Number(json.last_page ?? json.meta?.last_page ?? 0);
        if (!list.length || (last && page >= last)) break;
      }
      return out;
    },
    // Returns null when the profile has no cloud sync (Dolphin answers 400).
    async cookies(profileId) {
      try {
        const json = await call(SYNC + '/cookies/export', {method: 'POST', body: JSON.stringify({browserProfileId: Number(profileId) || profileId})});
        const list = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : Array.isArray(json.cookies) ? json.cookies : null;
        return list;
      } catch (e) {
        if (e.status === 400 || e.status === 404) return null;
        throw e;
      }
    }
  };
}
