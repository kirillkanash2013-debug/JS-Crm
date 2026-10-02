// Telegram bot for clients: bind a chat with the integration token (or buy
// with Telegram Stars), fill basic settings, get the plugin and the dashboard.
import {PLANS, applyPayment, authenticate, createInvite, isActive, redeemInvite, rotateDashboardToken, rotateIntegrationToken} from './accounts.mjs';
import {findInviteCode} from './invites.mjs';
import {checkKeitaro, keitaroOrigin} from './keitaro.mjs';
import {openSecret, sealSecret} from './secrets.mjs';
import {findToken} from './tokens.mjs';

const MENU = {keyboard: [[{text: '📊 Статистика'}, {text: '📣 Кампании'}], [{text: '🧩 Подключить соц'}, {text: '💳 Подписка'}], [{text: '⚙️ Настройки'}]], resize_keyboard: true};
const INVITE_ERRORS = {
  invalid: '❌ Код не найден. Проверьте, что скопировали его полностью.',
  used: '❌ Этот код уже использован. Каждый код работает только один раз.',
  revoked: '❌ Этот код отозван.',
  expired: '❌ Срок действия кода истёк. Попросите новый.'
};
const TIMEZONES = ['Europe/Minsk', 'Europe/Moscow', 'Europe/Kyiv', 'Asia/Almaty', 'Asia/Tbilisi', 'UTC'];
const planName = id => PLANS[id]?.name || id;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const validTimezone = tz => { try { new Intl.DateTimeFormat('ru', {timeZone: tz}); return true; } catch { return false; } };

export function createBot({store, tg, env, keitaro = checkKeitaro}) {
  const send = (chatId, text, markup) => tg('sendMessage', {chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? {reply_markup: markup} : {})});
  const forget = (chatId, messageId) => tg('deleteMessage', {chat_id: chatId, message_id: messageId}).catch(() => {});
  const starsEnabled = () => Number(env.STARS_PRICE_START) > 0;
  const buyButtons = () => ({inline_keyboard: Object.entries(PLANS).filter(([id]) => Number(env['STARS_PRICE_' + id.toUpperCase()]) > 0)
    .map(([id, p]) => [{text: '💳 ' + p.name + ' — ' + env['STARS_PRICE_' + id.toUpperCase()] + ' ⭐ / 30 дней', callback_data: 'buy:' + id}])});


  const isAdmin = chatId => String(env.ADMIN_CHAT_IDS || '').split(',').map(x => x.trim()).filter(Boolean).includes(String(chatId));

  // Owner commands: /invite [дней] [тариф] [для кого], /invites, /revoke <id>.
  async function adminCommand(chatId, text) {
    const [cmd, ...args] = text.split(/\s+/);
    if (cmd === '/reset') { await store.unbindChat(chatId); return send(chatId, '♻️ Чат отвязан. Отправьте /start (увидите экран нового клиента), затем /testtoken — и пройдите путь заново.'); }
    if (cmd === '/invite') {
      let days = 30, plan = 'team';
      const note = [];
      for (const a of args) {
        if (/^\d+$/.test(a) && days === 30 && !note.length) days = Number(a);
        else if (PLANS[a.toLowerCase()] && !note.length) plan = a.toLowerCase();
        else note.push(a);
      }
      let invite;
      try { invite = await createInvite(store, {plan, days, note: note.join(' ')}); }
      catch { return send(chatId, 'Формат: <code>/invite 30 team Вася</code> — дней 1–365, тариф: ' + Object.keys(PLANS).join(', ')); }
      const link = env.BOT_USERNAME ? '\nСсылка: https://t.me/' + env.BOT_USERNAME + '?start=' + invite.code : '';
      return send(chatId, '🎁 Код #' + invite.id + (note.length ? ' для ' + esc(note.join(' ')) : '') + ': ' + planName(plan) + ', ' + days + ' дн.\n<code>' + invite.code + '</code>' + link +
        '\n\nОдноразовый: создаёт один аккаунт. Активировать в течение 14 дней.');
    }
    if (cmd === '/invites') {
      const list = await store.listInvites(30);
      if (!list.length) return send(chatId, 'Кодов пока нет. Создать: <code>/invite 30 Вася</code>');
      return send(chatId, '🎁 <b>Коды</b>\n' + list.map(i => '#' + i.id + ' · ' + esc(i.note || '—') + ' · ' + planName(i.plan) + ' ' + i.days + ' дн. · ' +
        (i.usedAt ? '✅ активирован ' + i.usedAt.slice(0, 10) : i.revokedAt ? '⛔ отозван' : i.expiresAt < new Date().toISOString().slice(0, 10) ? '⌛ просрочен' : '🕓 ждёт до ' + i.expiresAt)).join('\n'));
    }
    if (cmd === '/revoke') {
      return send(chatId, args[0] && await store.revokeInvite(args[0]) ? 'Код #' + esc(args[0]) + ' отозван.' : 'Не нашёл неиспользованный код с таким номером. Список: /invites');
    }
    // Test helpers (owner only): simulate a purchase and drive the collector.
    if (cmd === '/testtoken') {
      const plan = PLANS[(args[0] || '').toLowerCase()] ? args[0].toLowerCase() : 'team';
      const r = await applyPayment(store, {paymentId: 'test:' + crypto.randomUUID(), provider: 'test', plan, name: 'ТЕСТ ' + new Date().toISOString().slice(0, 10), masterKey: env.MASTER_KEY});
      return send(chatId, '🧪 Оплата сымитирована. Тариф ' + planName(plan) + ' до ' + r.tenant.paidUntil +
        '.\n\nТокен для подключения (вставьте на странице подключения соца):\n<code>' + r.integrationToken + '</code>\n\n' +
        'Подключить соц: ' + env.IMPORT_URL.replace('/import', '/bookmarklet') + '\nПроверить сбор: <code>/teststatus ' + r.integrationToken + '</code>');
    }
    if (cmd === '/teststatus' || cmd === '/testcollect' || cmd === '/testreport') {
      const token = args[0];
      if (!/^jsi_[A-Za-z0-9_-]{43}$/.test(token || '')) return send(chatId, 'Укажите токен: <code>' + cmd + ' jsi_…</code> (получить: /testtoken)');
      const call = (path, opts) => fetch(env.COLLECTOR_URL + path, {headers: {Authorization: 'Bearer ' + token, ...(opts?.body ? {'Content-Type': 'application/json'} : {})}, ...opts})
        .then(async r => ({ok: r.ok, status: r.status, body: await r.json().catch(() => ({}))}));
      if (cmd === '/teststatus') {
        const r = await call('/v1/status');
        if (!r.ok) return send(chatId, '❌ ' + (r.body.error || r.status));
        const socials = (r.body.connections || []).map(c => '• ' + (c.label || c.userId) + ' — ' + (c.collectMode || 'api')).join('\n') || 'соцов нет';
        return send(chatId, '🧪 <b>Статус сбора</b>\n' + socials + '\n\nЗапустить сбор сейчас: <code>/testcollect ' + token + '</code>\nОтчёт: <code>/testreport ' + token + '</code>');
      }
      if (cmd === '/testcollect') {
        const st = await call('/v1/status');
        const ids = (st.body?.connections || []).map(c => c.userId);
        if (!ids.length) return send(chatId, 'Нет подключённых соцов. Сначала подключите соц на странице.');
        const today = new Date().toISOString().slice(0, 10);
        for (const userId of ids) await call('/v1/jobs', {method: 'POST', body: JSON.stringify({userId, since: today, until: today})});
        return send(chatId, '🧪 Запустил сбор для ' + ids.length + ' соц(ов). Через минуту: <code>/testreport ' + token + '</code>');
      }
      const today = new Date().toISOString().slice(0, 10);
      const r = await call('/v1/report?since=' + today + '&until=' + today);
      if (!r.ok) return send(chatId, '❌ ' + (r.body.error || r.status));
      const totals = Object.entries(r.body.totals || {}).map(([c, v]) => v + ' ' + c).join(' · ') || 'нет данных';
      return send(chatId, '🧪 <b>Отчёт за сегодня</b>\nСтрок: ' + (r.body.rows || []).length + '\nSpend: ' + totals);
    }
  }

  async function welcome(chatId) {
    await send(chatId, '👋 <b>JS Control</b>\n\nОтправьте сюда <b>пригласительный код</b> (<code>JS-XXXX-XXXX-XXXX</code>) или <b>токен интеграции</b> (<code>jsi_…</code>).' +
      (starsEnabled() ? '\n\nЕщё нет подписки? Оплатите прямо здесь:' : ''), starsEnabled() ? buyButtons() : undefined);
  }

  async function askKeitaroUrl(chatId) {
    await store.setChat(chatId, (await store.chat(chatId)).tenantId, 'keitaro_url');
    await send(chatId, '⚙️ <b>Шаг 1 из 3 — Keitaro</b>\n\nОтправьте адрес вашего трекера, например <code>https://tracker.example.com</code>.',
      {inline_keyboard: [[{text: 'У меня нет Keitaro', callback_data: 'skip:keitaro'}]]});
  }

  async function askTimezone(chatId, tenantId) {
    await store.setChat(chatId, tenantId, 'timezone');
    const rows = [];
    for (let i = 0; i < TIMEZONES.length; i += 2) rows.push(TIMEZONES.slice(i, i + 2).map(tz => ({text: tz, callback_data: 'tz:' + tz})));
    await send(chatId, '🕒 <b>Шаг 3 из 3 — часовой пояс</b>\n\nВ нём считаются «сегодня» и «вчера» в отчётах. Выберите или напишите свой, например <code>Asia/Dubai</code>.', {inline_keyboard: rows});
  }

  // Which Keitaro sub_id carries the Facebook campaign id — the join key for
  // matching spend (FB) to revenue (Keitaro). Asked only when Keitaro is on.
  async function askKeitaroSub(chatId, tenantId) {
    await store.setChat(chatId, tenantId, 'keitaro_sub');
    const rows = [[1, 2, 3], [4, 5, 6]].map(g => g.map(n => ({text: 'sub_id_' + n, callback_data: 'ksub:' + n})));
    await send(chatId, '🔗 <b>Keitaro: где id кампании Facebook?</b>\n\nВ каком параметре <code>sub_id</code> вашего трекера лежит ID кампании Facebook? По нему свяжем расход (FB) и доход (Keitaro). Обычно это <code>sub_id_4</code>.', {inline_keyboard: rows});
  }

  async function dashboardLink(tenantId) {
    return env.PUBLIC_URL + '/d/' + await rotateDashboardToken(store, tenantId);
  }

  // Calls the collector as this tenant, using the sealed integration token —
  // no cross-worker secret. Returns {ok,status,body} or null if not set up.
  async function collectorCall(tenantId, path, body) {
    if (!env.COLLECTOR_URL || !env.MASTER_KEY) return null;
    const t = await store.tenant(tenantId);
    if (!t?.integrationTokenEnc) return null;
    let token;
    try { token = await openSecret(env.MASTER_KEY, tenantId, t.integrationTokenEnc); } catch { return null; }
    try {
      const r = await fetch(env.COLLECTOR_URL + path, {method: body ? 'POST' : 'GET', headers: {Authorization: 'Bearer ' + token, ...(body ? {'Content-Type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
      return {ok: r.ok, status: r.status, body: await r.json().catch(() => ({}))};
    } catch { return null; }
  }

  // Step-by-step connection instructions + the antidetect extension as a file.
  async function sendPluginKit(chatId) {
    await send(chatId, '🧩 <b>Как подключить Facebook — по шагам</b>\n\n' +
      '1️⃣ Скачайте расширение (файл ниже) и распакуйте в отдельную папку.\n' +
      '2️⃣ В антидетекте (AdsPower / Dolphin): раздел «Расширения» → добавить локальное → укажите эту папку → включите для нужного профиля.\n' +
      '3️⃣ Откройте профиль и зайдите в <b>Ads Manager</b> нужного соца.\n' +
      '4️⃣ Нажмите иконку расширения <b>JS Control</b>, вставьте ваш токен интеграции (если потеряли — команда /token) и нажмите «Подключить этот профиль».\n\n' +
      '✅ Дальше сервер собирает данные сам — браузер можно закрыть. Статистику смотрите в «📊 Статистика».\n\n' +
      'Либо подключить все профили сразу по API-токену антидетекта: ' + env.IMPORT_URL);
    try { await tg('sendDocument', {chat_id: chatId, document: env.COLLECTOR_URL + '/extension.zip', caption: 'Расширение JS Control для антидетекта'}); } catch {}
  }

  async function showStats(chatId, tenantId) {
    const st = await collectorCall(tenantId, '/v1/status');
    const conns = (st && st.body && st.body.connections) || [];
    if (!conns.length) return send(chatId, '📊 Пока нет подключённых соцов или данных. Подключите соц — кнопка «🧩 Подключить соц».', MENU);
    const today = new Date().toISOString().slice(0, 10);
    const rep = await collectorCall(tenantId, '/v1/report?since=' + today + '&until=' + today);
    const totals = Object.entries((rep && rep.body && rep.body.totals) || {}).map(([c, v]) => v + ' ' + c).join(' · ') || 'нет данных';
    const lines = conns.map(c => '• ' + esc(c.label || c.userId) + ' — ' + esc(c.collectMode || 'api'));
    await send(chatId, '📊 <b>Статистика за сегодня</b>\nСоцев: ' + conns.length + '\nРасход: ' + esc(totals) + '\n\n' + lines.join('\n'), MENU);
  }

  const campIcon = s => s === 'ACTIVE' ? '🟢' : s === 'PAUSED' ? '⏸' : '⚪';

  async function campaignsEntry(chatId, tenantId) {
    const st = await collectorCall(tenantId, '/v1/status');
    const conns = (st && st.body && st.body.connections) || [];
    if (!conns.length) return send(chatId, '📣 Нет подключённых соцов. Подключите соц — «🧩 Подключить соц».', MENU);
    if (conns.length === 1) return showCampaigns(chatId, tenantId, conns[0].userId);
    return send(chatId, '📣 <b>Кампании</b>\nВыберите соц:', {inline_keyboard: conns.map(c => [{text: c.label || c.userId, callback_data: 'soc:' + c.userId}])});
  }

  async function showCampaigns(chatId, tenantId, userId) {
    const r = await collectorCall(tenantId, '/v1/campaigns?userId=' + encodeURIComponent(userId));
    const camps = (r && r.body && r.body.campaigns) || [];
    if (!camps.length) return send(chatId, '📣 Кампаний пока нет (ещё не собрались). Загляните позже.', MENU);
    return send(chatId, '📣 <b>Кампании</b> (' + camps.length + '). Нажмите на кампанию:',
      {inline_keyboard: camps.slice(0, 40).map(c => [{text: campIcon(c.status) + ' ' + String(c.name || c.campaignId).slice(0, 40), callback_data: 'cmp:' + userId + ':' + c.campaignId}])});
  }

  async function showCampaign(chatId, tenantId, userId, cid) {
    const r = await collectorCall(tenantId, '/v1/campaigns?userId=' + encodeURIComponent(userId));
    const c = ((r && r.body && r.body.campaigns) || []).find(x => x.campaignId === cid);
    if (!c) return send(chatId, 'Кампания не найдена. Обновите список: «📣 Кампании».', MENU);
    const budget = c.dailyBudget ? (Number(c.dailyBudget) / 100).toFixed(2) + ' ' + (c.currency || '') : '—';
    const toggle = c.status === 'ACTIVE' ? {text: '⏸ Пауза', callback_data: 'act:' + userId + ':' + cid + ':pause'} : {text: '▶️ Включить', callback_data: 'act:' + userId + ':' + cid + ':on'};
    await send(chatId, '📣 <b>' + esc(c.name || cid) + '</b>\nСтатус: ' + campIcon(c.status) + ' ' + esc(c.status || '—') +
      '\nДневной бюджет: ' + esc(budget) + '\nРасход сегодня: ' + esc((c.spend || 0) + ' ' + (c.currency || '')),
      {inline_keyboard: [[toggle], [{text: '💰 Бюджет', callback_data: 'budg:' + userId + ':' + cid}, {text: '🔄 Обновить', callback_data: 'cmp:' + userId + ':' + cid}]]});
  }

  async function runAction(chatId, tenantId, body, label) {
    const r = await collectorCall(tenantId, '/v1/actions', body);
    if (!r) return send(chatId, '❌ Не удалось отправить команду. Попробуйте позже.', MENU);
    if (r.status === 409) return send(chatId, '⏳ Сейчас выполняется другая операция. Повторите через минуту.', MENU);
    if (!r.ok) return send(chatId, '❌ ' + esc((r.body && (r.body.error || r.body.detail)) || r.status), MENU);
    return send(chatId, '⏳ ' + label + ' — применяю, это займёт ~минуту.', {inline_keyboard: [[{text: '🔄 Проверить результат', callback_data: 'chk:' + (r.body && r.body.id)}]]});
  }

  async function checkJob(chatId, tenantId, jobId) {
    const r = await collectorCall(tenantId, '/v1/status');
    const job = ((r && r.body && r.body.jobs) || []).find(j => j.id === jobId);
    if (!job) return send(chatId, 'Задача не найдена (возможно, устарела). Проверьте статус в «📣 Кампании».', MENU);
    if (['queued', 'running'].includes(job.state)) return send(chatId, '⏳ Ещё выполняется — нажмите «Проверить» ещё раз через момент.', {inline_keyboard: [[{text: '🔄 Проверить результат', callback_data: 'chk:' + jobId}]]});
    if (job.state === 'needs_auth') return send(chatId, '❌ Facebook требует вход заново — переподключите соц через расширение.', MENU);
    if (job.state !== 'done') return send(chatId, '❌ Не удалось применить (' + esc((job.error && job.error.code) || job.state) + ').', MENU);
    const after = (job.actionResult && job.actionResult.after) || {};
    const budget = after.daily_budget ? (Number(after.daily_budget) / 100).toFixed(2) : null;
    return send(chatId, '✅ Готово. Статус: ' + esc(after.status || '—') + (budget ? ', дневной бюджет: ' + esc(budget) : ''), MENU);
  }

  async function finish(chatId, tenantId, tz) {
    await store.saveSettings(tenantId, {timezone: tz, currency: 'USD', onboardedAt: new Date().toISOString()});
    await store.setChat(chatId, tenantId, 'ready');
    await send(chatId, '✅ <b>Всё настроено!</b> Осталось подключить Facebook — инструкция ниже. После первого сбора данные появятся в «📊 Статистика».', MENU);
    await sendPluginKit(chatId);
  }

  function pluginText() {
    return '1) Установите расширение JS Control в ваш антидетект-браузер (AdsPower, Dolphin и др.):\n' + env.PLUGIN_URL +
      '\nСкачайте, загрузите в браузер, откройте профиль и Ads Manager нужного соца, вставьте в расширении ваш токен интеграции и нажмите «Подключить этот профиль».\n\n' +
      '2) Либо полностью автоматически — вставьте API-токен антидетекта (Dolphin Anty), и все профили подтянутся сами:\n' + env.IMPORT_URL;
  }

  async function subscription(chatId, tenant) {
    const status = isActive(tenant) ? '🟢 активна до ' + tenant.paidUntil : '🔴 истекла ' + tenant.paidUntil;
    await send(chatId, '💳 <b>Подписка ' + esc(planName(tenant.plan)) + '</b>\n' + status + '\nСоцов в тарифе: ' + tenant.socialLimit,
      starsEnabled() ? {inline_keyboard: [[{text: 'Продлить на 30 дней', callback_data: 'buy:' + tenant.plan}]]} : undefined);
  }

  async function bind(chatId, tenant) {
    const s = await store.settings(tenant.id);
    await store.setChat(chatId, tenant.id, s.onboardedAt ? 'ready' : 'keitaro_url');
    await send(chatId, '🔓 Подписка <b>' + esc(planName(tenant.plan)) + '</b> активна до ' + tenant.paidUntil + '.' +
      (s.onboardedAt ? '' : '\nЗаполним базовые настройки — это займёт минуту.'), s.onboardedAt ? MENU : undefined);
    if (!s.onboardedAt) await askKeitaroUrl(chatId);
  }

  async function onPaid(chatId, message) {
    const pay = message.successful_payment;
    const plan = String(pay.invoice_payload || '').replace(/^plan:/, '');
    const chat = await store.chat(chatId);
    const result = await applyPayment(store, {paymentId: 'tg:' + pay.telegram_payment_charge_id, provider: 'telegram-stars', plan,
      name: message.from?.username || message.from?.first_name, tenantId: chat?.tenantId || undefined, amount: pay.total_amount, currency: pay.currency, masterKey: env.MASTER_KEY});
    if (result.duplicate) return;
    if (result.integrationToken) {
      await send(chatId, '🎉 Оплата получена!\n\nВаш токен интеграции (нужен для входа в плагин, сохраните его):\n<code>' + result.integrationToken + '</code>');
      return bind(chatId, result.tenant);
    }
    await send(chatId, '🎉 Подписка продлена до ' + result.tenant.paidUntil + '.', MENU);
  }

  async function onMessage(message) {
    const chatId = message.chat.id, text = String(message.text || '').trim();
    if (message.successful_payment) return onPaid(chatId, message);
    const chat = await store.chat(chatId);

    if (isAdmin(chatId) && /^\/(invite|invites|revoke|reset|testtoken|teststatus|testcollect|testreport)\b/.test(text)) return adminCommand(chatId, text);

    const code = findInviteCode(text);
    if (code) {
      await forget(chatId, message.message_id);
      if (chat?.tenantId && await store.tenant(chat.tenantId)) return send(chatId, 'У этого Telegram-аккаунта уже есть доступ к JS Control. Код не использован — его можно передать другому человеку.', MENU);
      const result = await redeemInvite(store, code, {chatId, name: message.from?.username || message.from?.first_name, masterKey: env.MASTER_KEY});
      if (result.error) return send(chatId, INVITE_ERRORS[result.error]);
      await send(chatId, '🎁 Код активирован! Доступ: <b>' + esc(planName(result.tenant.plan)) + '</b> до ' + result.tenant.paidUntil +
        '.\n\nВаш токен интеграции (нужен для входа в плагин, сохраните его):\n<code>' + result.integrationToken + '</code>');
      return bind(chatId, result.tenant);
    }

    const token = findToken(text, 'integration');
    if (token) {
      await forget(chatId, message.message_id); // the token must not stay in the chat history
      const {tenant, error} = await authenticate(store, token, 'integration');
      if (error === 'invalid') return send(chatId, '❌ Токен не найден. Проверьте, что скопировали его полностью.');
      // The user handed us the plaintext token — seal it so the dashboard can
      // read this tenant's data from the collector (covers tokens issued earlier).
      if (env.MASTER_KEY) await store.setIntegrationTokenEnc(tenant.id, await sealSecret(env.MASTER_KEY, tenant.id, token));
      if (error === 'expired') { await store.setChat(chatId, tenant.id, 'ready'); return subscription(chatId, tenant); }
      return bind(chatId, tenant);
    }
    if (!chat?.tenantId) return welcome(chatId);

    const tenant = await store.tenant(chat.tenantId);
    if (!isActive(tenant)) return subscription(chatId, tenant);

    if (chat.state === 'keitaro_url') {
      const origin = keitaroOrigin(text);
      if (!origin) return send(chatId, 'Не похоже на адрес. Пример: <code>https://tracker.example.com</code>');
      await store.saveSettings(tenant.id, {keitaroUrl: origin});
      await store.setChat(chatId, tenant.id, 'keitaro_key');
      return send(chatId, '🔑 <b>Шаг 2 из 3 — API-ключ Keitaro</b>\n\nKeitaro → Профиль → API-ключи → создайте ключ и отправьте его сюда. Сообщение с ключом будет сразу удалено из чата.',
        {inline_keyboard: [[{text: 'Пропустить Keitaro', callback_data: 'skip:keitaro'}]]});
    }
    if (chat.state === 'keitaro_key') {
      await forget(chatId, message.message_id);
      const s = await store.settings(tenant.id);
      const result = await keitaro(s.keitaroUrl, text);
      const skipBtn = {inline_keyboard: [[{text: 'Пропустить Keitaro', callback_data: 'skip:keitaro'}]]};
      if (result === 'bad_key') return send(chatId, '❌ Keitaro не принял ключ. Проверьте ключ и отправьте ещё раз — или пропустите, его можно подключить позже.', skipBtn);
      if (result === 'forbidden') return send(chatId, '❌ Сервер отказал в доступе к API (403). Причиной могут быть права пользователя или ограничения сервера. Проверка выполнена через облачный сервер, включая адреса по IP. Проверьте доступ к кампаниям через API с администратором трекера — либо пропустите и подключите позже.', skipBtn);
      if (result === 'unreachable') return send(chatId, '❌ Не удалось связаться с ' + esc(s.keitaroUrl) + '. Проверьте адрес (/settings) или доступность трекера — или пропустите.', skipBtn);
      await store.saveSettings(tenant.id, {keitaroKeyEnc: await sealSecret(env.MASTER_KEY, tenant.id, text)});
      await send(chatId, '✅ Keitaro подключён.');
      return askKeitaroSub(chatId, tenant.id);
    }
    if (chat.state === 'keitaro_sub') {
      const m = String(text).match(/(?:sub_id_)?([1-6])\b/i);
      if (!m) return send(chatId, 'Укажите номер саба 1–6 — например <code>sub_id_4</code> или просто <code>4</code>.');
      await store.saveSettings(tenant.id, {keitaroSub: 'sub_id_' + m[1]});
      return askTimezone(chatId, tenant.id);
    }
    if (chat.state === 'timezone') {
      if (!validTimezone(text)) return send(chatId, 'Не знаю такой пояс. Пример: <code>Europe/Minsk</code>');
      return finish(chatId, tenant.id, text);
    }
    if (chat.state && chat.state.startsWith('budget:')) {
      const [, userId, cid] = chat.state.split(':');
      const dollars = Number(String(text).replace(',', '.').replace(/[^\d.]/g, ''));
      if (!(dollars > 0)) return send(chatId, 'Введите сумму дневного бюджета в валюте кабинета, например <code>15</code> или <code>15.50</code>.');
      await store.setChat(chatId, tenant.id, 'ready');
      return runAction(chatId, tenant.id, {userId, campaignId: cid, dailyBudget: Math.round(dollars * 100)}, 'Бюджет ' + dollars);
    }

    if (text === '📊 Статистика' || text === '/stats') return showStats(chatId, tenant.id);
    if (text === '📣 Кампании' || text === '/campaigns') return campaignsEntry(chatId, tenant.id);
    if (text === '/dashboard') return send(chatId, '📊 Веб-ссылка (необязательно, всё есть в «📊 Статистика»):\n' + await dashboardLink(tenant.id) + '\n\nПредыдущая ссылка больше не работает.', MENU);
    if (text === '🧩 Подключить соц' || text === '/plugin') return sendPluginKit(chatId);
    if (text === '⚙️ Настройки' || text === '/settings') return askKeitaroUrl(chatId);
    if (text === '💳 Подписка' || text === '/subscription') return subscription(chatId, tenant);
    if (text === '/token') {
      const fresh = await rotateIntegrationToken(store, tenant.id, env.MASTER_KEY);
      return send(chatId, '🔁 Новый токен интеграции:\n<code>' + fresh + '</code>\n\nСтарый больше не действует — войдите в плагин заново.', MENU);
    }
    return send(chatId, 'Выберите действие в меню.', MENU);
  }

  async function onCallback(q) {
    const chatId = q.message.chat.id, data = String(q.data || '');
    await tg('answerCallbackQuery', {callback_query_id: q.id}).catch(() => {});
    if (data.startsWith('buy:') && PLANS[data.slice(4)] && starsEnabled()) {
      const plan = data.slice(4), price = Number(env['STARS_PRICE_' + plan.toUpperCase()]);
      if (!(price > 0)) return;
      return tg('sendInvoice', {chat_id: chatId, title: 'JS Control ' + PLANS[plan].name, description: '30 дней, до ' + PLANS[plan].socialLimit + ' соцов',
        payload: 'plan:' + plan, currency: 'XTR', prices: [{label: '30 дней', amount: price}]});
    }
    const chat = await store.chat(chatId);
    if (!chat?.tenantId) return welcome(chatId);
    if (data === 'skip:keitaro') { await store.saveSettings(chat.tenantId, {keitaroUrl: null, keitaroKeyEnc: null}); return askTimezone(chatId, chat.tenantId); }
    if (data.startsWith('ksub:') && /^[1-6]$/.test(data.slice(5)) && chat.state === 'keitaro_sub') { await store.saveSettings(chat.tenantId, {keitaroSub: 'sub_id_' + data.slice(5)}); return askTimezone(chatId, chat.tenantId); }
    if (data.startsWith('tz:') && chat.state === 'timezone' && validTimezone(data.slice(3))) return finish(chatId, chat.tenantId, data.slice(3));
    if (data.startsWith('soc:')) return showCampaigns(chatId, chat.tenantId, data.slice(4));
    if (data.startsWith('cmp:')) { const [, userId, cid] = data.split(':'); return showCampaign(chatId, chat.tenantId, userId, cid); }
    if (data.startsWith('act:')) { const [, userId, cid, op] = data.split(':'); return runAction(chatId, chat.tenantId, {userId, campaignId: cid, status: op === 'pause' ? 'PAUSED' : 'ACTIVE'}, op === 'pause' ? 'Пауза' : 'Включение'); }
    if (data.startsWith('budg:')) { const [, userId, cid] = data.split(':'); await store.setChat(chatId, chat.tenantId, 'budget:' + userId + ':' + cid); return send(chatId, '💰 Введите новый дневной бюджет (в валюте кабинета), например <code>15</code>:'); }
    if (data.startsWith('chk:')) return checkJob(chatId, chat.tenantId, data.slice(4));
  }

  return async function handleUpdate(update) {
    if (update.pre_checkout_query) {
      const plan = String(update.pre_checkout_query.invoice_payload || '').replace(/^plan:/, '');
      return tg('answerPreCheckoutQuery', PLANS[plan] ? {pre_checkout_query_id: update.pre_checkout_query.id, ok: true}
        : {pre_checkout_query_id: update.pre_checkout_query.id, ok: false, error_message: 'Тариф не найден'});
    }
    if (update.callback_query) return onCallback(update.callback_query);
    if (update.message) return onMessage(update.message);
  };
}
