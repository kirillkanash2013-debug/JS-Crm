import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPayment, authenticate} from '../src/accounts.mjs';
import {collectorStatus, route} from '../src/index.mjs';
import {dashboardPage, dashboardSummary} from '../src/dashboard.mjs';
import {MemoryStore} from '../src/store.mjs';
import {openSecret} from '../src/secrets.mjs';
import {hashToken} from '../src/tokens.mjs';

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const env = {MASTER_KEY, PUBLIC_URL: 'https://p.test', PLUGIN_URL: 'https://p.test/plugin', IMPORT_URL: 'https://p.test/import', COLLECTOR_URL: 'https://c.test', BOT_USERNAME: 'jscontrol_bot',
  TELEGRAM_WEBHOOK_SECRET: 'tg-secret-123', BILLING_WEBHOOK_SECRET: 'bill-secret', STARS_PRICE_START: '500', STARS_PRICE_TEAM: '0', STARS_PRICE_AGENCY: '0'};

function harness(keitaro = 'ok') {
  const store = new MemoryStore(), sent = [], deleted = [];
  const tg = async (method, payload) => {
    if (method === 'deleteMessage') deleted.push(payload.message_id);
    else sent.push({method, ...payload});
    return {};
  };
  const call = (path, init = {}) => route(new Request('https://p.test' + path, init), env, {store, tg});
  const update = body => call('/telegram', {method: 'POST', headers: {'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET}, body: JSON.stringify(body)});
  let id = 0;
  const say = (text, chat = 1) => update({message: {message_id: ++id, chat: {id: chat}, text}});
  const tap = (data, chat = 1) => update({callback_query: {id: 'q' + (++id), data, message: {chat: {id: chat}}}});
  const last = () => sent.at(-1)?.text || '';
  return {store, sent, deleted, call, update, say, tap, last};
}

async function sign(body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.BILLING_WEBHOOK_SECRET), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('');
}

test('payment webhook issues one token per payment; only hashes are stored', async () => {
  const h = harness();
  const body = JSON.stringify({paymentId: 'order-1', plan: 'start', name: 'Team A', amount: 49, currency: 'USD'});
  assert.equal((await h.call('/billing/webhook', {method: 'POST', headers: {'x-signature': 'bad'}, body})).status, 401);
  const first = await (await h.call('/billing/webhook', {method: 'POST', headers: {'x-signature': await sign(body)}, body})).json();
  assert.match(first.integrationToken, /^jsi_/);
  assert.equal(first.botLink, 'https://t.me/jscontrol_bot?start=' + first.integrationToken);
  const again = await (await h.call('/billing/webhook', {method: 'POST', headers: {'x-signature': await sign(body)}, body})).json();
  assert.equal(again.duplicate, true); assert.equal(again.integrationToken, null); assert.equal(again.tenantId, first.tenantId);
  assert(!JSON.stringify([...h.store.tokens.keys()]).includes(first.integrationToken));
  assert(h.store.tokens.has(await hashToken(first.integrationToken)));
});

test('client journey: token → Keitaro → timezone → plugin and dashboard', async () => {
  const h = harness();
  const {integrationToken: token} = await applyPayment(h.store, {paymentId: 'p1', provider: 'test', plan: 'team', name: 'Agency <b>X</b>'});
  assert.equal((await h.update({message: {chat: {id: 1}, text: 'hi'}}).then(r => r.status)), 200);
  assert.equal((await h.call('/telegram', {method: 'POST', body: '{}'})).status, 401);

  await h.say('/start'); assert.match(h.last(), /токен интеграции/);
  await h.say('/start jsi_' + 'x'.repeat(43)); assert.match(h.last(), /Токен не найден/);
  await h.say('/start ' + token);
  assert(h.deleted.includes(3), 'token message is deleted');
  assert.match(h.last(), /Шаг 1 из 3/);
  await h.say('not a url'); assert.match(h.last(), /Не похоже на адрес/);
  await h.say('https://tracker.example.com/admin/'); assert.match(h.last(), /Шаг 2 из 3/);

  const tenantId = (await h.store.chat(1)).tenantId;
  assert.equal((await h.store.settings(tenantId)).keitaroUrl, 'https://tracker.example.com');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    assert.equal(url, 'https://tracker.example.com/admin_api/v1/campaigns');
    return opts.headers['Api-Key'] === 'good-key' ? Response.json([]) : new Response('', {status: 401});
  };
  try {
    await h.say('wrong-key'); assert.match(h.last(), /не принял ключ/);
    await h.say('good-key'); assert.match(h.last(), /sub_id/);
    await h.tap('ksub:4'); assert.match(h.last(), /Шаг 3 из 3/);
  } finally { globalThis.fetch = realFetch; }
  assert.equal((await h.store.settings(tenantId)).keitaroSub, 'sub_id_4');
  assert(h.deleted.includes(6) && h.deleted.includes(7), 'key messages are deleted');
  const s = await h.store.settings(tenantId);
  assert.notEqual(s.keitaroKeyEnc, 'good-key');
  assert.equal(await openSecret(MASTER_KEY, tenantId, s.keitaroKeyEnc), 'good-key');

  await h.tap('tz:Europe/Minsk');
  const done = h.last();
  assert.match(done, /Настройки сохранены/); assert.match(done, /p\.test\/plugin/); assert.match(done, /расширение/i);
  const link = done.match(/https:\/\/p\.test\/d\/(jsd_[A-Za-z0-9_-]+)/);
  assert(link, 'dashboard link sent');

  const page = await h.call('/d/' + link[1]);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Agency &lt;b&gt;X&lt;\/b&gt;/); assert.match(html, /Europe\/Minsk/);
  const summary = await (await h.call('/api/d/' + link[1])).json();
  assert.deepEqual(summary.steps.map(x => x.done), [true, true, true, false]);

  await h.say('📊 Дашборд');
  assert.equal((await h.call('/d/' + link[1])).status, 404, 'old dashboard link revoked');

  const login = await h.call('/v1/extension/login', {method: 'POST', body: JSON.stringify({token})});
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), {tenant: {name: 'Agency <b>X</b>', plan: 'team', socialLimit: 15, paidUntil: (await h.store.tenant(tenantId)).paidUntil}, onboarded: true, collector: {origin: 'https://c.test'}});

  await h.say('/token');
  const fresh = h.last().match(/jsi_[A-Za-z0-9_-]{43}/)[0];
  assert.equal((await h.call('/v1/extension/login', {method: 'POST', body: JSON.stringify({token})})).status, 401);
  assert.equal((await authenticate(h.store, fresh, 'integration')).error, null);
});

test('expired subscription blocks plugin, dashboard and bot actions', async () => {
  const h = harness();
  const {tenant, integrationToken: token} = await applyPayment(h.store, {paymentId: 'p2', provider: 'test', plan: 'start'});
  await h.say('/start ' + token);
  await h.store.extendTenant(tenant.id, '2020-01-01');
  assert.equal((await h.call('/v1/extension/login', {method: 'POST', body: JSON.stringify({token})})).status, 402);
  await h.say('https://tracker.example.com'); assert.match(h.last(), /истекла/);
  await applyPayment(h.store, {paymentId: 'p3', provider: 'test', plan: 'start', tenantId: tenant.id});
  assert.equal((await h.call('/v1/extension/login', {method: 'POST', body: JSON.stringify({token})})).status, 200);
});

test('Telegram Stars: invoice, pre-checkout, payment creates tenant and starts onboarding', async () => {
  const h = harness();
  await h.say('/start');
  assert.equal(h.sent.at(-1).reply_markup.inline_keyboard.length, 1, 'only plans with a price are offered');
  await h.tap('buy:start', 2);
  const invoice = h.sent.at(-1);
  assert.equal(invoice.method, 'sendInvoice'); assert.equal(invoice.currency, 'XTR'); assert.equal(invoice.prices[0].amount, 500);
  await h.update({pre_checkout_query: {id: 'pc', invoice_payload: 'plan:start'}});
  assert.equal(h.sent.at(-1).ok, true);
  const paid = {message_id: 50, chat: {id: 2}, from: {username: 'buyer'}, successful_payment: {invoice_payload: 'plan:start', telegram_payment_charge_id: 'ch1', total_amount: 500, currency: 'XTR'}};
  await h.update({message: paid});
  assert(h.sent.some(m => /токен интеграции/.test(m.text || '') && /jsi_/.test(m.text)));
  assert.match(h.last(), /Шаг 1 из 3/);
  const count = h.sent.length;
  await h.update({message: paid});
  assert.equal(h.sent.length, count, 'repeated payment update is ignored');
});

test('collectorStatus decrypts the sealed token and summarizes the collector', async () => {
  const store = new MemoryStore();
  const {tenant} = await applyPayment(store, {paymentId: 'pc', provider: 'test', plan: 'team', masterKey: MASTER_KEY});
  assert(await store.tenant(tenant.id).then(t => t.integrationTokenEnc), 'integration token is sealed on issue');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    assert.match(opts.headers.Authorization, /^Bearer jsi_/);
    assert(url.startsWith('https://c.test/v1/'));
    if (url.endsWith('/v1/status')) return Response.json({connections: [{userId: '100', label: 'Алина', collectMode: 'api'}], results: {'100': {observedAt: '2026-10-01T10:00:00Z'}}});
    return Response.json({totals: {USD: 82.29}, rows: [1, 2, 3]});
  };
  try {
    const c = await collectorStatus(env, store, tenant.id);
    assert.equal(c.socials, 1);
    assert.equal(c.totals.USD, 82.29);
    assert.equal(c.observedAt, '2026-10-01T10:00:00Z');
    assert.equal(c.connections[0].label, 'Алина');
  } finally { globalThis.fetch = realFetch; }
  // No sealed token → no call, no data.
  assert.equal(await collectorStatus(env, new MemoryStore(), 'missing'), null);
});

test('dashboard renders collector spend and marks the social step done', () => {
  const summary = dashboardSummary({name: 'A', plan: 'team', paidUntil: '2026-10-31'}, {onboardedAt: 'x', timezone: 'UTC'},
    {socials: 1, observedAt: '2026-10-01T10:00:00Z', connections: [{label: 'Алина', mode: 'api'}], totals: {USD: 82.29}, rows: 3});
  assert.equal(summary.steps.find(s => s.title.startsWith('Соц')).done, true);
  const html = dashboardPage(summary);
  assert.match(html, /82\.29 USD/);
  assert.match(html, /Алина/);
});
