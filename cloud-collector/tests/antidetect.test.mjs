import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {dolphinAnty, proxyFromDolphin} from '../src/antidetect/dolphin.mjs';
import {matchProfile} from '../src/antidetect/index.mjs';
import {importProfiles} from '../src/importer.mjs';
import {tokensFromHtml} from '../src/session-token.mjs';
import {importPage, importScript, PAGE_HEADERS} from '../src/pages.mjs';
import {Control, initialState} from '../src/control.mjs';

test('Dolphin Anty adapter: Bearer auth, paging, proxy by reference, cookies 400 → null', async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push(url + ' ' + init.headers.Authorization);
    if (url.includes('/browser_profiles?') && url.includes('page=1'))
      return {ok: true, status: 200, json: async () => ({data: [
        {id: 1, name: 'Профиль A', useragent: {value: 'UA-A'}, proxy: {type: 'http', host: '1.1.1.1', port: 8000, login: 'u', password: 'p'}},
        {id: 2, name: 'Профиль B', useragent: {value: 'UA-B'}, proxy: {id: 77}}], last_page: 2})};
    if (url.includes('/browser_profiles?') && url.includes('page=2'))
      return {ok: true, status: 200, json: async () => ({data: [{id: 3, name: 'C', proxy: null}], last_page: 2})};
    if (url.includes('/proxy/77')) return {ok: true, status: 200, json: async () => ({data: {type: 'socks5', host: '2.2.2.2', port: 1080, login: 'x', password: 'y'}})};
    if (url.includes('/cookies/export')) return {ok: false, status: 400, json: async () => ({})};
    throw new Error('unexpected ' + url);
  };
  const c = dolphinAnty('tok123', fetcher);
  const profiles = await c.profiles();
  assert.deepEqual(profiles, [
    {id: '1', name: 'Профиль A', userAgent: 'UA-A', proxy: {server: 'http://1.1.1.1:8000', username: 'u', password: 'p'}},
    {id: '2', name: 'Профиль B', userAgent: 'UA-B', proxy: {server: 'socks5://2.2.2.2:1080', username: 'x', password: 'y'}},
    {id: '3', name: 'C', userAgent: null, proxy: null}]);
  assert(seen[0].endsWith('Bearer tok123'));
  assert.equal(await c.cookies('1'), null);
  assert.equal(proxyFromDolphin({host: '1.1.1.1', port: 8000, type: 'bad'}), null);
});

test('adapter maps auth errors to a stable code', async () => {
  const c = dolphinAnty('bad', async () => ({ok: false, status: 401, json: async () => ({})}));
  await assert.rejects(c.profiles(), e => e.code === 'antidetect_auth');
});

test('token extraction from Ads Manager HTML and profile match by User-Agent', () => {
  const html = '<script>window.__accessToken="EAAB' + 'q'.repeat(40) + '";var x={"USER_ID":"100200300"};</script><script>{"accessToken":"EAAC' + 'w'.repeat(30) + '"}</script>';
  const r = tokensFromHtml(html);
  assert.equal(r.userId, '100200300');
  assert.deepEqual(r.tokens, ['EAAB' + 'q'.repeat(40), 'EAAC' + 'w'.repeat(30)]);
  const profiles = [{id: '1', userAgent: 'UA-A'}, {id: '2', userAgent: 'UA-B'}];
  assert.equal(matchProfile(profiles, 'UA-B').id, '2');
  assert.equal(matchProfile(profiles, 'UA-Z'), null);
  assert.equal(matchProfile([{userAgent: 'U'}, {userAgent: 'U'}], 'U'), null);
});

test('importProfiles over a fake socket: cookies → user, token from Ads Manager page, skips with reasons', async () => {
  const token = 'EAAB' + 'q'.repeat(40);
  const client = {
    profiles: async () => [
      {id: '1', name: 'Соц 1', userAgent: 'UA1', proxy: {server: 'http://1.1.1.1:8000'}},
      {id: '2', name: 'Без прокси', userAgent: 'UA2', proxy: null},
      {id: '3', name: 'Разлогинен', userAgent: 'UA3', proxy: {server: 'http://3.3.3.3:8000'}},
      {id: '4', name: 'Не Facebook', userAgent: 'UA4', proxy: {server: 'http://4.4.4.4:8000'}}],
    cookies: async id => id === '4' ? [{name: 'sid', value: '1', domain: '.google.com'}]
      : [{name: 'c_user', value: '10' + id, domain: '.facebook.com'}, {name: 'xs', value: 's', domain: '.facebook.com'}]
  };
  // Fake cloudflare:sockets. The Ads Manager page carries the token; profile 3's
  // session is logged out (redirect to /login); /me confirms the owner.
  const connect = fakeConnect(req => {
    const user = req.proxyHost === '3.3.3.3' ? null : req.cookie.match(/c_user=(\d+)/)?.[1];
    if (req.path.startsWith('/adsmanager')) {
      if (!user) return {status: 302, headers: {location: 'https://www.facebook.com/login/'}, body: ''};
      return {status: 200, headers: {}, body: '<script>window.__accessToken="' + token + '";{"USER_ID":"' + user + '"}</script>'};
    }
    if (req.path.startsWith('/v25.0/me')) return {status: 200, headers: {}, body: JSON.stringify({id: user})};
    return {status: 404, headers: {}, body: '{}'};
  });
  const result = await importProfiles(client, {connect, browserAvailable: false});
  assert.equal(result.found, 4);
  assert.deepEqual(result.items.map(i => i.userId + ':' + i.label + ':' + (i.token ? 'token' : 'none')), ['101:Соц 1:token']);
  assert.deepEqual(Object.fromEntries(result.skipped.map(s => [s.name, s.reason])),
    {'Без прокси': 'no_proxy', 'Разлогинен': 'logged_out', 'Не Facebook': 'no_facebook'});
});

// Minimal cloudflare:sockets stub: HTTP CONNECT tunnel, TLS no-op, one request/response.
function fakeConnect(handler) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  return ({hostname, port}, {secureTransport}) => {
    let proxyHost = null, stage = secureTransport === 'starttls' ? 'connect' : 'request';
    const chunks = []; let notify;
    const push = s => { chunks.push(enc.encode(s)); if (notify) { notify(); notify = null; } };
    const reader = () => ({read: () => chunks.length ? Promise.resolve({value: chunks.shift(), done: false})
      : new Promise(r => { notify = () => r({value: chunks.shift(), done: false}); }), releaseLock() {}, cancel() {}});
    const sock = {
      opened: Promise.resolve(),
      readable: {getReader: reader},
      writable: {getWriter: () => ({write(bytes) {
        const text = dec.decode(bytes);
        if (stage === 'connect') { const m = text.match(/^CONNECT ([^:]+):/); proxyHost = hostname; if (m) {} push('HTTP/1.1 200 OK\r\n\r\n'); stage = 'request'; return Promise.resolve(); }
        const line = text.match(/^GET (\S+) HTTP/), host = text.match(/Host: (\S+)/), cookie = (text.match(/Cookie: (.*)/) || [])[1] || '';
        const r = handler({path: line[1], host: host[1], cookie, proxyHost: proxyHost || host[1]});
        const head = 'HTTP/1.1 ' + r.status + ' X\r\n' + Object.entries(r.headers).map(([k, v]) => k + ': ' + v).join('\r\n') + (Object.keys(r.headers).length ? '\r\n' : '') + 'Content-Length: ' + enc.encode(r.body).length + '\r\nConnection: close\r\n\r\n';
        push(head + r.body);
        return Promise.resolve();
      }, releaseLock() {}})},
      startTls: () => sock, close() {}
    };
    return sock;
  };
}

test('collector antidetect flow: connect account, import job adds socials, reconnect bookmark gets proxy', async () => {
  const profiles = [{id: '1', name: 'Соц 1', userAgent: 'UA1', proxy: {server: 'http://1.1.1.1:8000'}}];
  const runner = {
    antidetectProfiles: async () => profiles,
    importProfiles: async () => ({at: new Date().toISOString(), found: 1, items: [{userId: '101', label: 'Соц 1', userAgent: 'UA1', proxy: {server: 'http://1.1.1.1:8000'}, cookies: [{name: 'c_user'}], token: 'EA' + 'a'.repeat(30), profileId: '1'}], skipped: [{name: 'X', reason: 'no_cookies'}]}),
    matchProfile: async (cfg, ua) => profiles.find(p => p.userAgent === ua) || null,
    validateApi: async b => ({userId: b.userId, token: b.token || 'EA' + 'z'.repeat(30), userAgent: b.userAgent, proxy: b.proxy, cookies: []})
  };
  const c = new Control(initialState(), async () => {}, async () => {}, runner);
  const bad = await c.request('/v1/antidetect', 'POST', {type: 'dolphin-anty', token: ''}, 10);
  assert.equal(bad.status, 422);
  const ok = await c.request('/v1/antidetect', 'POST', {type: 'dolphin-anty', token: 'api-tok'}, 10);
  assert.equal(ok.status, 201); assert.deepEqual(await ok.json(), {profiles: 1});

  const w = await c.prepare();
  assert.equal(w.job.kind, 'import');
  const {result, error} = await c.execute(w); await c.finish(w, result, error);
  const status = c.status();
  assert.equal(status.connections.length, 1);
  assert.equal(status.connections[0].label, 'Соц 1'); assert.equal(status.connections[0].source, 'antidetect');
  assert.equal(status.antidetect.lastImport.added, 1);
  assert.equal(status.antidetect.lastImport.skipped[0].reason, 'no_cookies');
  assert(status.connections[0].schedule, 'imported social is scheduled');

  // A bookmark reconnect without a proxy picks up the profile's proxy by User-Agent.
  const re = await c.request('/v1/connections', 'POST', {userId: '202', token: 'EA' + 'b'.repeat(30), userAgent: 'UA1', cookies: []}, 10);
  assert.equal(re.status, 201);
  assert.deepEqual(c.state.connections['202'].proxy, {server: 'http://1.1.1.1:8000'});
  assert.equal(c.state.connections['202'].label, 'Соц 1');

  await c.request('/v1/antidetect', 'DELETE', {}, 10);
  assert.equal(c.status().antidetect, null);
});

test('import page is server-rendered, strict CSP, valid script', () => {
  assert(!/<script>/.test(importPage()));
  assert.match(importPage(), /API-токен антидетекта/);
  assert(PAGE_HEADERS['content-security-policy'].includes("script-src 'self'"));
  new vm.Script(importScript());
});
