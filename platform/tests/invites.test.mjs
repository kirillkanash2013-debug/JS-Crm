import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createInvite, redeemInvite} from '../src/accounts.mjs';
import {findInviteCode, newInviteCode} from '../src/invites.mjs';
import {route} from '../src/index.mjs';
import {D1Store, MemoryStore} from '../src/store.mjs';
import {hashToken, newToken} from '../src/tokens.mjs';

const env = {MASTER_KEY: btoa('k'.repeat(32)), PUBLIC_URL: 'https://p.test', PLUGIN_URL: 'https://p.test/plugin', IMPORT_URL: 'https://p.test/import', BOT_USERNAME: 'jscontrol_bot',
  TELEGRAM_WEBHOOK_SECRET: 's'.repeat(20), ADMIN_CHAT_IDS: '100, 101', STARS_PRICE_START: '0'};

function harness() {
  const store = new MemoryStore(), sent = [];
  const tg = async (method, payload) => { if (method !== 'deleteMessage') sent.push({method, ...payload}); return {}; };
  let id = 0;
  const say = (chat, text, from = {username: 'u' + chat}) => route(new Request('https://p.test/telegram', {method: 'POST',
    headers: {'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET}, body: JSON.stringify({message: {message_id: ++id, chat: {id: chat}, from, text}})}), env, {store, tg});
  const last = () => sent.at(-1).text;
  return {store, sent, say, last};
}

test('code format: readable, tolerant input, no false matches inside tokens', () => {
  const code = newInviteCode();
  assert.match(code, /^JS-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(findInviteCode('/start ' + code.toLowerCase().replace(/-/g, '')), code);
  assert.equal(findInviteCode('/start ' + code), code);
  assert.equal(findInviteCode('xJS-ABCD-EFGH-JKMN'), null);
  for (let i = 0; i < 2000; i++) assert.equal(findInviteCode(newToken('integration')), null);
});

test('admin issues codes; each code creates exactly one account; one account per chat', async () => {
  const h = harness();
  await h.say(200, '/invite 30 Вася'); assert.match(h.last(), /пригласительный код/, 'non-admin cannot create codes');
  await h.say(100, '/invite 60 start Вася Пупкин');
  const reply = h.last();
  const code = reply.match(/JS-[A-Z2-9-]{14}/)[0];
  assert.match(reply, /для Вася Пупкин/); assert.match(reply, /Start, 60 дн/);
  assert.match(reply, new RegExp('t\\.me/jscontrol_bot\\?start=' + code));
  assert(!JSON.stringify([...h.store.invites.values()]).includes(code), 'only the hash is stored');

  await h.say(201, '/start ' + code);
  assert(h.sent.some(m => /Код активирован/.test(m.text || '')));
  assert(h.sent.some(m => /Поздравляем/.test(m.text || '') && /Start/.test(m.text || '')));
  assert(!h.sent.some(m => /jsi_[A-Za-z0-9_-]{20,}/.test(m.text || '')), 'token is not dumped into the chat');
  assert.match(h.last(), /Шаг 1 из 3/);
  const tenant = await h.store.tenant((await h.store.chat(201)).tenantId);
  assert.equal(tenant.socialLimit, 3); assert.equal(tenant.name, 'u201');

  await h.say(202, code); assert.match(h.last(), /уже использован/);
  assert.equal(await h.store.chat(202), null);

  await h.say(100, '/invite');
  const second = h.last().match(/JS-[A-Z2-9-]{14}/)[0];
  await h.say(201, second); assert.match(h.last(), /уже есть доступ/);
  await h.say(203, second); assert.match(h.last(), /Код активирован|Шаг 1/, 'the untouched code still works for someone else');

  await h.say(100, '/invite 30 Петя');
  const third = h.last().match(/JS-[A-Z2-9-]{14}/)[0], thirdId = h.last().match(/#(\w+)/)[1];
  await h.say(100, '/revoke ' + thirdId); assert.match(h.last(), /отозван/);
  await h.say(204, third); assert.match(h.last(), /отозван/);

  await h.say(100, '/invites');
  const list = h.last();
  assert.match(list, /Вася Пупкин · Start 60 дн\. · ✅ активирован/); assert.match(list, /Петя .*⛔ отозван/);
  assert(!list.includes(code));
  await h.say(100, '/invite 999'); assert.match(h.last(), /Формат/);
});

test('expired and unknown codes are rejected', async () => {
  const store = new MemoryStore();
  const {code} = await createInvite(store, {validDays: -1});
  assert.equal((await redeemInvite(store, code, {chatId: 1})).error, 'expired');
  assert.equal((await redeemInvite(store, newInviteCode(), {chatId: 1})).error, 'invalid');
});

test('D1: concurrent redemption of one code creates one account', async () => {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_init.sql', '0002_invites.sql']) db.exec(fs.readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const d1 = {prepare(sql) { let a = []; const st = {bind(...x) { a = x; return st; },
    async run() { const r = db.prepare(sql).run(...a); return {meta: {changes: r.changes}}; },
    async first() { return db.prepare(sql).get(...a) ?? null; }, async all() { return {results: db.prepare(sql).all(...a)}; }}; return st; }};
  const store = new D1Store(d1);
  const {code, id} = await createInvite(store, {note: 'Дима'});
  const results = await Promise.all([redeemInvite(store, code, {chatId: 1}), redeemInvite(store, code, {chatId: 2}), redeemInvite(store, code, {chatId: 3})]);
  assert.equal(results.filter(r => r.tenant).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tenants').get().n, 1);
  const [row] = await store.listInvites(10);
  assert.equal(row.id, id); assert(row.usedAt); assert.equal(row.note, 'Дима');
  assert.equal(await store.revokeInvite(id), false, 'used code cannot be revoked');
  assert.equal(await store.invite(await hashToken(code)).then(i => i.tenantId), results.find(r => r.tenant).tenant.id);
});
