import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPayment, authenticate} from '../src/accounts.mjs';
import {collectorStatus, route} from '../src/index.mjs';
import {createBot} from '../src/bot.mjs';
import {dashboardPage, dashboardSummary} from '../src/dashboard.mjs';
import {MemoryStore} from '../src/store.mjs';
import {openSecret} from '../src/secrets.mjs';
import {hashToken} from '../src/tokens.mjs';

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const env = {MASTER_KEY, PUBLIC_URL: 'https://p.test', PLUGIN_URL: 'https://p.test/plugin', IMPORT_URL: 'https://p.test/import', COLLECTOR_URL: 'https://c.test', BOT_USERNAME: 'jscontrol_bot',
  TELEGRAM_WEBHOOK_SECRET: 'tg-secret-123', BILLING_WEBHOOK_SECRET: 'bill-secret',WEB_PRICE_START:'49', STARS_PRICE_START: '500', STARS_PRICE_TEAM: '0', STARS_PRICE_AGENCY: '0'};

function harness(keitaro = 'ok') {
  const store = new MemoryStore(), sent = [], deleted = [];
  let msgId = 0;
  const tg = async (method, payload) => {
    if (method === 'deleteMessage') deleted.push(payload.message_id);
    else sent.push({method, ...payload});
    return method === 'sendMessage' ? {message_id: ++msgId} : {};
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
  assert.equal(first.integrationToken,undefined);assert.equal(first.botLink,undefined);
  const again = await (await h.call('/billing/webhook', {method: 'POST', headers: {'x-signature': await sign(body)}, body})).json();
  assert.equal(again.duplicate, true); assert.equal(again.integrationToken, undefined); assert.equal(again.tenantId, first.tenantId);
  assert.equal(h.store.tokens.size,1);
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
    await h.say('4'); assert.match(h.last(), /Шаг 3 из 3/);
  } finally { globalThis.fetch = realFetch; }
  assert.equal((await h.store.settings(tenantId)).keitaroSub, 'sub_id_4');
  assert(h.deleted.includes(6) && h.deleted.includes(7), 'key messages are deleted');
  const s = await h.store.settings(tenantId);
  assert.notEqual(s.keitaroKeyEnc, 'good-key');
  assert.equal(await openSecret(MASTER_KEY, tenantId, s.keitaroKeyEnc), 'good-key');

  await h.tap('tz:Europe/Minsk');
  assert(h.sent.some(m => /Всё настроено/.test(m.text || '')), 'onboarding finished');
  assert(h.sent.some(m => /Как подключить/.test(m.text || '')), 'step-by-step instructions sent');
  assert(h.sent.some(m => m.method === 'sendDocument' && /\/extension\.zip(\?|$)/.test(m.document || '')), 'extension archive sent');

  await h.say('/dashboard');
  const link = h.last().match(/https:\/\/p\.test\/d\/(jsd_[A-Za-z0-9_-]+)/);
  assert(link, 'dashboard link available via /dashboard');
  const page = await h.call('/d/' + link[1]);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Agency &lt;b&gt;X&lt;\/b&gt;/); assert.match(html, /Europe\/Minsk/);
  const summary = await (await h.call('/api/d/' + link[1])).json();
  assert.deepEqual(summary.steps.map(x => x.done), [true, true, true, false]);

  await h.say('/dashboard');
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
  await h.update({pre_checkout_query: {id: 'pc', invoice_payload:invoice.payload,currency:'XTR',total_amount:500,from:{id:2}}});
  assert.equal(h.sent.at(-1).ok, true);
  const paid = {message_id: 50, chat: {id: 2}, from: {username: 'buyer'}, successful_payment: {invoice_payload: invoice.payload, telegram_payment_charge_id: 'ch1', total_amount: 500, currency: 'XTR'}};
  await h.update({message: paid});
  assert(h.sent.some(m => /Поздравляем/.test(m.text || '')), 'congratulation after payment, no raw token dump');
  assert(!h.sent.some(m => /jsi_[A-Za-z0-9_-]{20,}/.test(m.text || '')), 'token is not dumped into the chat');
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

test('bot «Статистика» pulls socials and today spend from the collector', async () => {
  const h = harness();
  const {integrationToken: token} = await applyPayment(h.store, {paymentId: 'pstat', provider: 'test', plan: 'team', masterKey: MASTER_KEY});
  await h.say('/start ' + token);
  await h.store.setChat(1, (await h.store.chat(1)).tenantId, 'ready');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    assert.match(opts.headers.Authorization, /^Bearer jsi_/);
    if (url.endsWith('/v1/status')) return Response.json({connections: [{userId: '100', label: 'Алина', collectMode: 'api'}]});
    if (url.includes('/v1/campaigns')) return Response.json({campaigns: [{campaignId: '100', name: 'KG_A', effectiveStatus: 'ACTIVE', dailyBudget: 15400, spend: 82.29}]});
    return Response.json({totals: {}, rows: []});
  };
  try { await h.say('📊 Статистика'); } finally { globalThis.fetch = realFetch; }
  // Keitaro not configured → «Сейчас» with FB spend only, plus a hint to add Keitaro.
  assert.match(h.last(), /📊 Сейчас/);
  assert.match(h.last(), /Spend <b>\$82\.29<\/b>/);
  assert.match(h.last(), /KG_A/);
  assert.match(h.last(), /Подключите Keitaro/);
});

test('agents: deleting a social removes it from the bot and tells the collector', async () => {
  const h = harness();
  const {integrationToken: token} = await applyPayment(h.store, {paymentId: 'pdel', provider: 'test', plan: 'team', masterKey: MASTER_KEY});
  await h.say('/start ' + token);
  const tid = (await h.store.chat(1)).tenantId;
  await h.store.setChat(1, tid, 'ready');
  await h.store.addSocial(tid, '100', 'Профиль-100');
  let deleted = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === 'DELETE' && String(url).includes('/v1/connections')) { deleted = true; return Response.json({ok: true}); }
    return Response.json({});
  };
  try { await h.tap('ag:dpo:100'); } finally { globalThis.fetch = realFetch; }
  assert(deleted, 'collector DELETE /v1/connections called');
  assert.equal(await h.store.social(tid, '100'), null, 'social removed from store');
  // After deletion the «Агенты» screen is re-rendered (edited) without that profile.
  assert(h.sent.some(m => m.method === 'editMessageText' && /👥/.test(m.text || '')), 'agents screen refreshed');
});

test('push: collector announces a connected social to the tenant chat', async () => {
  const store = new MemoryStore(), sent = []; let mid = 0;
  const tg = async (m, p) => { sent.push({method: m, ...p}); return m === 'sendMessage' ? {message_id: ++mid} : {}; };
  const {tenant} = await applyPayment(store, {paymentId: 'pn', provider: 'test', plan: 'team', masterKey: MASTER_KEY});
  await store.setChat(42, tenant.id, 'ready');
  const bot = createBot({store, tg, env});
  await bot.notifySocialConnected(tenant.id, {userId: '900', label: 'Профиль-900'});
  const msg = sent.find(m => /Видим профиль/.test(m.text || ''));
  assert(msg, 'connected card sent to the chat');
  assert.match(msg.text, /Профиль-900/);
  assert.ok(msg.chat_id, 'addressed to a chat');
  assert(await store.social(tenant.id, '900'), 'social recorded in the store');
  // After the first collection the SAME card is edited with the counts.
  await bot.notifySocialCollected(tenant.id, {userId: '900', label: 'Профиль-900', fbName: 'Алина Гущина', rk: 3, rkPersonal: 2, bm: 1, fp: 2});
  const upd = sent.find(m => m.method === 'editMessageText' && /Соц: <b>Алина Гущина<\/b>/.test(m.text || ''));
  assert(upd, 'card edited to loaded state');
  assert.match(upd.text, /ID соц: <code>900<\/code>/);
  assert.match(upd.text, /РК: <b>3<\/b> <i>\(\+2 личных\)<\/i>/);
  assert.match(upd.text, /БМ: <b>1<\/b>/);
  assert.match(upd.text, /ФП: <b>2<\/b>/);
  // Unknown tenant → no crash, no message.
  const before = sent.length;
  await bot.notifySocialConnected('nope', {userId: '901', label: 'X'});
  assert.equal(sent.length, before);
});

test('a menu button escapes an input state instead of being parsed as its value', async () => {
  const h = harness();
  const {integrationToken: token} = await applyPayment(h.store, {paymentId: 'pesc', provider: 'test', plan: 'team', masterKey: MASTER_KEY});
  await h.say('/start ' + token);
  // Stuck mid-settings waiting for a Keitaro URL.
  await h.store.setChat(1, (await h.store.chat(1)).tenantId, 'keitaro_url');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/v1/status')) return Response.json({connections: [{userId: '100', label: 'A'}]});
    if (url.includes('/v1/campaigns')) return Response.json({campaigns: [{campaignId: '100', name: 'C', spend: 1}]});
    return Response.json({});
  };
  try { await h.say('📊 Статистика'); } finally { globalThis.fetch = realFetch; }
  assert.match(h.last(), /📊 Сейчас/);
  assert.doesNotMatch(h.last(), /Не похоже на адрес/);
  // State was reset, so the next plain text is no longer eaten as a URL.
  assert.equal((await h.store.chat(1)).state, 'ready');
});

test('agents: a new social is detected, prompted, and assigned to a new agent', async () => {
  const h = harness();
  const {integrationToken: token} = await applyPayment(h.store, {paymentId: 'pa', provider: 'test', plan: 'team', masterKey: MASTER_KEY});
  await h.say('/start ' + token);
  const tenantId = (await h.store.chat(1)).tenantId;
  await h.store.setChat(1, tenantId, 'ready');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/v1/status')) return Response.json({connections: [{userId: '100', label: 'Алина', collectMode: 'api'}]});
    return Response.json({totals: {}, rows: []});
  };
  try {
    await h.say('👥 Агенты');
    assert(h.sent.some(m => /Видим профиль «Алина»/.test(m.text || '')), 'new social card shown');
    await h.tap('assign:100:new'); assert.match(h.last(), /имя нового агента/);
    await h.say('Иван'); assert.match(h.last(), /назначен/i);
    await h.say('👥 Агенты'); assert.match(h.last(), /Иван/); assert.match(h.last(), /Без агента<\/b> — профилей: 0/);
  } finally { globalThis.fetch = realFetch; }
});

test('«👤 Профиль» hub: subscription + sub-screens edited in place', async () => {
  const h = harness();
  const {integrationToken: token} = await applyPayment(h.store, {paymentId: 'pp', provider: 'test', plan: 'team', name: 'Кирилл', masterKey: MASTER_KEY});
  await h.say('/start ' + token);
  await h.store.setChat(1, (await h.store.chat(1)).tenantId, 'ready');
  await h.say('👤 Профиль');
  assert.match(h.last(), /👤 <b>Профиль<\/b>/);
  assert.match(h.last(), /Кирилл/);
  assert.match(h.last(), /Осталось дней:/);
  await h.tap('pr:key'); assert.match(h.last(), /Ключ интеграции/);
  await h.tap('pr:notify'); assert.match(h.last(), /Уведомления/);
  await h.tap('pr:notify:on'); assert.equal((await h.store.settings((await h.store.chat(1)).tenantId)).notifyOnUpdate, 1);
  await h.tap('pr:freq'); assert.match(h.last(), /Частота обновления/);
  await h.tap('pr:freq:30'); assert.equal((await h.store.settings((await h.store.chat(1)).tenantId)).refreshMinutes, 30);
});

test('«🔑 Ключ» shows the current token without rotating it', async () => {
  const h = harness();
  const {integrationToken: token} = await applyPayment(h.store, {paymentId: 'pk', provider: 'test', plan: 'team', masterKey: MASTER_KEY});
  await h.say('/start ' + token);
  await h.store.setChat(1, (await h.store.chat(1)).tenantId, 'ready');
  await h.say('🔑 Ключ');
  assert(h.last().includes(token), 'shows the same key, not a new one');
});

test('bot campaigns board: active-only numbered list, budget + toggle by text, pending→result', async () => {
  const h = harness();
  const {integrationToken: token} = await applyPayment(h.store, {paymentId: 'pc3', provider: 'test', plan: 'team', masterKey: MASTER_KEY});
  await h.say('/start ' + token);
  await h.store.setChat(1, (await h.store.chat(1)).tenantId, 'ready');
  const realFetch = globalThis.fetch;
  let posted = [], jobs = [];
  globalThis.fetch = async (url, opts) => {
    if (url.includes('/v1/campaigns')) return Response.json({campaigns: [
      {campaignId: '555111', name: 'Alpha', status: 'ACTIVE', effectiveStatus: 'ACTIVE', dailyBudget: '2000', currency: 'USD', spend: 12.5},
      {campaignId: '555222', name: 'Bravo', status: 'ACTIVE', effectiveStatus: 'ACTIVE', dailyBudget: '1000', currency: 'USD', spend: 3},
      {campaignId: '555333', name: 'Charlie', status: 'PAUSED', effectiveStatus: 'PAUSED', dailyBudget: '1000', currency: 'USD', spend: 0}]});
    if (url.endsWith('/v1/actions')) { posted.push(JSON.parse(opts.body)); return new Response(JSON.stringify({id: 'job-1', state: 'queued'}), {status: 202, headers: {'content-type': 'application/json'}}); }
    if (url.endsWith('/v1/status')) return Response.json({connections: [{userId: '100', label: 'Алина'}], jobs});
    return Response.json({});
  };
  try {
    await h.say('📣 Кампании');
    // Only working campaigns on the board (Alpha, Bravo); the paused/0-spend Charlie is hidden.
    assert.match(h.last(), /<b>1\.<\/b>/); assert.match(h.last(), /Alpha/); assert.match(h.last(), /Bravo/);
    assert.doesNotMatch(h.last(), /Charlie/);
    assert.match(h.last(), /💰20\$ 💸13\$/);
    // Budget flow: multiple pairs "1-50 2-30" → two /v1/actions (board numbering).
    await h.tap('cbud:100'); assert.match(h.last(), /1-234 2-423/);
    await h.say('1-50 2-30');
    assert.deepEqual(posted.map(p => [p.campaignId, p.dailyBudget]), [['555111', 5000], ['555222', 3000]]);
    // Pending: queued job → status at the BOTTOM + only «Обновить»; stays until terminal.
    jobs = [{id: 'job-1', userId: '100', action: {campaignId: '555111', dailyBudget: 5000}, state: 'queued', createdAt: '2026-10-02T00:00:00Z'}];
    await h.tap('cref:100');
    assert.match(h.last(), /Обновления отправлены/);
    assert.match(h.last(), /Alpha[\s\S]*Обновления отправлены/); // status sits below the cards
    // One-at-a-time: a new submit while pending is refused.
    await h.tap('cbud:100'); await h.say('1-99'); assert.match(h.last(), /Дождитесь/);
    const nowIso = new Date().toISOString();
    // Job failed → the real Facebook reason is shown (not a bare "failed").
    jobs = [{id: 'job-1', userId: '100', action: {campaignId: '555111', dailyBudget: 5000}, state: 'failed', createdAt: '2026-10-02T00:00:00Z', finishedAt: nowIso, actionResult: {state: 'failed', stage: 'write', campaignId: '555111', error: {message: 'Бюджет задаётся на уровне группы объявлений'}}}];
    await h.tap('cref:100'); assert.match(h.last(), /Бюджет задаётся на уровне группы объявлений/);
    // Job done → green line + buttons return; changed budget shows fresh (read-after-write).
    jobs = [{id: 'job-1', userId: '100', action: {campaignId: '555111', dailyBudget: 5000}, state: 'done', createdAt: '2026-10-02T00:00:00Z', finishedAt: nowIso, actionResult: {campaignId: '555111', after: {status: 'ACTIVE', daily_budget: '5000'}}}];
    await h.tap('cref:100'); assert.match(h.last(), /✅ <b>Всё прошло успешно/); assert.match(h.last(), /💰50\$/);
    // A stale finished job (old) is NOT shown on a plain «Кампании» open.
    jobs = [{id: 'job-1', userId: '100', action: {campaignId: '555111', dailyBudget: 5000}, state: 'failed', createdAt: '2026-10-02T00:00:00Z', finishedAt: '2026-10-02T00:00:00Z', error: {code: 'failed'}}];
    await h.say('📣 Кампании'); assert.doesNotMatch(h.last(), /failed|не удалось/);
    // Toggle flow: Вкл/Выкл prompts like budget (space-separated, board numbering).
    posted = []; jobs = [];
    await h.tap('ctog:100'); assert.match(h.last(), /1 2 3/); assert.doesNotMatch(h.last(), /Charlie/);
    await h.say('2'); // #2 on the board = Bravo (ACTIVE → PAUSED)
    assert.deepEqual(posted.at(-1), {userId: '100', campaignId: '555222', status: 'PAUSED'});
  } finally { globalThis.fetch = realFetch; }
});

test('toggle uses the live (overlaid) status, not the stale archive', async () => {
  const h = harness();
  const {integrationToken: token} = await applyPayment(h.store, {paymentId: 'pc4', provider: 'test', plan: 'team', masterKey: MASTER_KEY});
  await h.say('/start ' + token);
  await h.store.setChat(1, (await h.store.chat(1)).tenantId, 'ready');
  const realFetch = globalThis.fetch;
  let posted = [];
  // Archive still says PAUSED, but a recent successful ACTIVATE overlays to ACTIVE
  // — the user sees 🟢 and expects the toggle to PAUSE it (not activate again).
  const jobs = [{id: 'j1', userId: '100', action: {campaignId: '555111', status: 'ACTIVE'}, state: 'done', createdAt: '2026-10-02T10:00:00Z', finishedAt: new Date().toISOString(), observedAt: new Date().toISOString(), actionResult: {campaignId: '555111', after: {status: 'ACTIVE', daily_budget: '2000'}}}];
  globalThis.fetch = async (url, opts) => {
    if (url.includes('/v1/campaigns')) return Response.json({campaigns: [{campaignId: '555111', name: 'Alpha', status: 'PAUSED', effectiveStatus: 'PAUSED', dailyBudget: '2000', currency: 'USD', spend: 5}]});
    if (url.endsWith('/v1/actions')) { posted.push(JSON.parse(opts.body)); return new Response(JSON.stringify({id: 'x', state: 'queued'}), {status: 202, headers: {'content-type': 'application/json'}}); }
    if (url.endsWith('/v1/status')) return Response.json({connections: [{userId: '100', label: 'A'}], jobs});
    return Response.json({});
  };
  try {
    await h.say('📣 Кампании');
    await h.tap('ctog:100'); await h.say('1');
    assert.deepEqual(posted.at(-1), {userId: '100', campaignId: '555111', status: 'PAUSED'});
  } finally { globalThis.fetch = realFetch; }
});

test('stats «Обновить»: triggers a collection at most once per 15 min', async () => {
  const h = harness();
  const {integrationToken: token} = await applyPayment(h.store, {paymentId: 'psr', provider: 'test', plan: 'team', masterKey: MASTER_KEY});
  await h.say('/start ' + token);
  await h.store.setChat(1, (await h.store.chat(1)).tenantId, 'ready');
  const realFetch = globalThis.fetch;
  let jobs = 0, collectedAt = new Date(Date.now() - 60 * 60000).toISOString(); // 1h ago → stale
  globalThis.fetch = async (url, opts) => {
    if (url.endsWith('/v1/status')) return Response.json({connections: [{userId: '100', label: 'A', collectedAt}]});
    if (url.includes('/v1/campaigns')) return Response.json({campaigns: []});
    if (url.endsWith('/v1/jobs')) { jobs++; return new Response(JSON.stringify({id: 'j', state: 'queued'}), {status: 202, headers: {'content-type': 'application/json'}}); }
    return Response.json({});
  };
  try {
    await h.tap('stats:refresh'); // stale → one collection
    assert.equal(jobs, 1); assert.match(h.last(), /Запрос принят/);
    collectedAt = new Date().toISOString(); // now fresh
    await h.tap('stats:refresh'); // within 15 min → no new collection
    assert.equal(jobs, 1); assert.match(h.last(), /свежие/);
  } finally { globalThis.fetch = realFetch; }
});

test('dashboard renders collector spend and marks the social step done', () => {
  const summary = dashboardSummary({name: 'A', plan: 'team', paidUntil: '2026-10-31'}, {onboardedAt: 'x', timezone: 'UTC'},
    {socials: 1, observedAt: '2026-10-01T10:00:00Z', connections: [{label: 'Алина', mode: 'api'}], totals: {USD: 82.29}, rows: 3});
  assert.equal(summary.steps.find(s => s.title.startsWith('Соц')).done, true);
  const html = dashboardPage(summary);
  assert.match(html, /82\.29 USD/);
  assert.match(html, /Алина/);
});
