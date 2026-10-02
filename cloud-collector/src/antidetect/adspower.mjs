// AdsPower helpers. AdsPower has only a LOCAL API (http://local.adspower.net:50325
// or http://127.0.0.1:50325), reachable only from the client machine, so the
// server cannot import profiles. Instead the bookmark, running in the open
// profile window, reads the proxy from the local API and hands it to us together
// with the token taken from the page. These parsers are pure and unit-tested;
// the actual fetch is inlined into the bookmark (adsPowerSnippet below).
const SOCKS = new Set(['socks5', 'socks5h', 'socks']);

export function parseAdsPowerProxy(cfg) {
  if (!cfg) return null;
  const kind = String(cfg.proxy_soft || cfg.proxy_type || '').toLowerCase();
  if (!kind || kind === 'no_proxy' || kind === 'noproxy') return null;
  const host = String(cfg.proxy_host || '').trim();
  const port = String(cfg.proxy_port || '').trim();
  if (!host || !/^\d{2,5}$/.test(port)) return null;
  const type = SOCKS.has(String(cfg.proxy_type || '').toLowerCase()) ? 'socks5' : 'http';
  const proxy = {server: type + '://' + host + ':' + port};
  if (cfg.proxy_user) proxy.username = String(cfg.proxy_user);
  if (cfg.proxy_password) proxy.password = String(cfg.proxy_password);
  return proxy;
}

// Picks the proxy for the signed-in social from an AdsPower /user/list reply.
// AdsPower does not tell the page which profile it is, so we match on the
// profile whose saved Facebook user id equals the one read from the page;
// failing that, a single profile in the account is unambiguous.
export function adsPowerProfileProxy(listData, userId) {
  const list = Array.isArray(listData?.list) ? listData.list : Array.isArray(listData) ? listData : [];
  const byUser = list.filter(p => {
    const hay = [p.username, p.remark, p.name, ...(Array.isArray(p.fbcc_platform) ? p.fbcc_platform : [])].join(' ');
    return userId && hay.includes(String(userId));
  });
  const pick = byUser.length === 1 ? byUser[0] : list.length === 1 ? list[0] : null;
  return pick ? parseAdsPowerProxy(pick.user_proxy_config) : null;
}
