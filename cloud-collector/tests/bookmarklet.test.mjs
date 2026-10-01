import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {bookmarkletHref} from '../src/bookmarklet.mjs';
import {cleanConnection} from '../src/connection.mjs';
import {bookmarkletPage, connectPage, connectScript, parseProxyInput} from '../src/pages.mjs';
import {VERSION} from '../src/version.mjs';

function runBookmark(page) {
  const opened = [], alerts = [];
  const scripts = page.scripts.map(textContent => ({textContent}));
  // Minimal DOM: the bookmarklet injects an <a> with the connect URL; capture its href.
  const node = () => ({style: {}, appendChild() {}, remove() {}, set onclick(v) {}, set textContent(v) {}, set href(v) { if (String(v).includes('/connect#s=')) opened.push(v); }});
  const doc = {querySelectorAll: () => scripts, getElementById: () => null, createElement: () => node(), body: {appendChild() {}}, documentElement: {appendChild() {}}};
  const ctx = {location: {hostname: page.host, href: page.href}, document: doc,
    navigator: {userAgent: 'Mozilla/5.0 Test'}, alert: m => alerts.push(m), btoa: s => Buffer.from(s, 'binary').toString('base64'),
    unescape, encodeURIComponent, JSON, String, Number, setTimeout: () => {}};
  ctx.window = {require: page.require, __accessToken: page.token, open: () => null};
  vm.runInNewContext(decodeURIComponent(bookmarkletHref('https://c.example').slice('javascript:'.length)), ctx);
  return {opened, alerts};
}
const decode = url => JSON.parse(Buffer.from(url.split('#s=')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

test('bookmark reads user, name and tokens in Ads Manager and opens the connect page', () => {
  const token = 'EAAB' + 'q'.repeat(40);
  const {opened} = runBookmark({host: 'adsmanager.facebook.com', href: 'https://adsmanager.facebook.com/adsmanager/manage', token,
    require: m => m === 'CurrentUserInitialData' ? {USER_ID: '61550001', NAME: 'Иван'} : null,
    scripts: ['var x="EAAG' + 'w'.repeat(30) + '"']});
  assert.equal(opened.length, 1); assert(opened[0].startsWith('https://c.example/connect#s='));
  assert.deepEqual(decode(opened[0]), {v: 1, build: VERSION, userId: '61550001', name: 'Иван', tokens: [token, 'EAAG' + 'w'.repeat(30)], ua: 'Mozilla/5.0 Test'});
});

test('bookmark refuses other sites and pages without access', () => {
  assert.equal(runBookmark({host: 'evil.example', href: 'https://evil.example/adsmanager', scripts: []}).opened.length, 0);
  const r = runBookmark({host: 'adsmanager.facebook.com', href: 'https://adsmanager.facebook.com/adsmanager', require: () => { throw new Error(); }, scripts: []});
  assert.equal(r.opened.length, 0); assert.match(r.alerts[0], /Не удалось найти доступ/);
});

test('proxy input formats and connection validation', () => {
  assert.deepEqual(parseProxyInput('1.2.3.4:8000:user:pa:ss'.replace(':pa:ss', ':pass'), 'http'), {server: 'http://1.2.3.4:8000', username: 'user', password: 'pass'});
  assert.deepEqual(parseProxyInput('socks5://u:p%40ss@5.6.7.8:1080'), {server: 'socks5://5.6.7.8:1080', username: 'u', password: 'p@ss'});
  assert.deepEqual(parseProxyInput('5.6.7.8:1080', 'socks5'), {server: 'socks5://5.6.7.8:1080', username: '', password: ''});
  assert.equal(parseProxyInput('  '), null);
  assert.throws(() => parseProxyInput('a:b:c'), /Формат прокси/);
  const ok = cleanConnection({userId: '100', token: 'EA' + 'a'.repeat(30), tokenCandidates: ['EA' + 'b'.repeat(30), 'bad'], userAgent: 'Mozilla/5.0 X', proxy: {server: 'http://1.2.3.4:8000', username: 'u', password: 'p'}});
  assert.deepEqual(ok.tokenCandidates, ['EA' + 'a'.repeat(30), 'EA' + 'b'.repeat(30)]); assert.deepEqual(ok.cookies, []);
  assert.throws(() => cleanConnection({userId: '100', token: 'EA' + 'a'.repeat(30), userAgent: 'Mozilla/5.0 X', cookies: [{name: 'c_user', value: '999', domain: '.facebook.com'}]}), /another account/);
  assert.throws(() => cleanConnection({userId: '100', token: 'EA' + 'a'.repeat(30), userAgent: 'Mozilla/5.0 X', proxy: {server: 'http://10.0.0.1:8080'}}), /Private/);
  const withCookies = cleanConnection({userId: '100', token: 'EA' + 'a'.repeat(30), userAgent: 'Mozilla/5.0 X',
    cookies: [{name: 'c_user', value: '100', domain: '.facebook.com', sameSite: 'no_restriction', expirationDate: 2e9}, {name: 'x', value: 'y', domain: '.google.com'}]});
  assert.deepEqual(withCookies.cookies.map(c => c.name + ':' + c.sameSite), ['c_user:None']);
});

test('pages: bookmark link, strict CSP-friendly connect page, valid script', () => {
  assert.match(bookmarkletPage('https://c.example'), /href="javascript:/);
  assert(!/<script>/.test(connectPage()), 'no inline script');
  new vm.Script(connectScript());
});
