// Telegram bot for clients: bind a chat with the integration token (or buy
// with Telegram Stars), fill basic settings, get the plugin and the dashboard.
import {PLANS, applyPayment, authenticate, createInvite, isActive, redeemInvite, rotateDashboardToken, rotateIntegrationToken} from './accounts.mjs';
import {findInviteCode} from './invites.mjs';
import {checkKeitaro, keitaroOrigin, keitaroReport} from './keitaro.mjs';
import {openSecret, sealSecret} from './secrets.mjs';
import {aggregateKeitaro, buildNow} from './today.mjs';
import {findToken} from './tokens.mjs';

const MENU = {keyboard: [[{text: '📊 Статистика'}, {text: '📣 Кампании'}], [{text: '👥 Агенты'}, {text: '🧩 Подключить соц'}], [{text: '👤 Профиль'}]], resize_keyboard: true};

// Emoji legend — shown in «Профиль → Инструкции» and once after onboarding.
const LEGEND = '🔣 <b>Обозначения в статистике</b>\n\n' +
  'Состояние кампании: 🟢 включена · ⚪ включена, без расхода · 🔴 выключена\n' +
  '⚠️ есть ошибки в объявлениях\n\n' +
  '💰 дневной бюджет · 💸 расход · 🤑 доход\n' +
  'Строка кампании: <code>inst/CPI − reg/CPR − dep/CPA (ROI%)</code>\n\n' +
  'Dep «+N долёт» — продажи сегодня по клику за прошлый день; учтены в прогнозе Rev/ROI (стрелка →)\n\n' +
  '🎯 Офферы по GEO: <code>оффер · inst − reg − dep · $EPC</code>; EPC — доход на уник. клик\n\n' +
  'В карточке соца: РК — кабинеты в БМ · БМ — бизнес-менеджеры · ФП — фан-пейджи';
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
  // Edit a message in place (one evolving screen, no chat spam). Falls back to a
  // fresh message if the edit fails (e.g. message too old or unchanged).
  const edit = async (chatId, messageId, text, markup) => {
    try { await tg('editMessageText', {chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup || {inline_keyboard: []}}); }
    catch { await send(chatId, text, markup); }
  };
  const forget = (chatId, messageId) => tg('deleteMessage', {chat_id: chatId, message_id: messageId}).catch(() => {});
  const starsEnabled = () => Number(env.STARS_PRICE_START) > 0;
  const buyButtons = () => ({inline_keyboard: Object.entries(PLANS).filter(([id]) => Number(env['STARS_PRICE_' + id.toUpperCase()]) > 0)
    .map(([id, p]) => [{text: '💳 ' + p.name + ' — ' + env['STARS_PRICE_' + id.toUpperCase()] + ' ⭐ / 30 дней', callback_data: 'buy:' + id}])});


  const isAdmin = chatId => String(env.ADMIN_CHAT_IDS || '').split(',').map(x => x.trim()).filter(Boolean).includes(String(chatId));

  // Owner commands: /invite [дней] [тариф] [для кого], /invites, /revoke <id>.
  async function adminCommand(chatId, text) {
    const [cmd, ...args] = text.split(/\s+/);
    if (cmd === '/reset') { await store.unbindChat(chatId); return send(chatId, '♻️ Чат отвязан. Отправьте /start (увидите экран нового клиента), затем /testtoken — и пройдите путь заново.'); }
    if (cmd === '/diag') {
      const chat = await store.chat(chatId);
      const t = chat?.tenantId ? await store.tenant(chat.tenantId) : null;
      // Decrypt the sealed token the bot would use, so we can see its prefix and
      // call the collector exactly as collectorCall does — reporting the RAW
      // status AND body.error, which tells route-404 (not_found) from auth
      // (unauthorized/subscription_expired) apart. /v1/me is probed too: it
      // echoes the account even on some errors, isolating token vs routing.
      let tok = null;
      if (t?.integrationTokenEnc && env.MASTER_KEY) { try { tok = await openSecret(env.MASTER_KEY, chat.tenantId, t.integrationTokenEnc); } catch {} }
      const st = chat?.tenantId ? await collectorCall(chat.tenantId, '/v1/status') : null;
      const me = chat?.tenantId ? await collectorCall(chat.tenantId, '/v1/me') : null;
      const conns = (st && st.body && st.body.connections) || [];
      return send(chatId, '🔧 <b>Диагностика</b>' +
        '\nchat.tenantId: <code>' + (chat?.tenantId || 'нет') + '</code>' +
        '\nCOLLECTOR_URL: <code>' + esc(env.COLLECTOR_URL || 'нет') + '</code>' +
        '\nservice binding COLLECTOR: ' + (env.COLLECTOR ? 'да' : 'нет') +
        '\nsealed token: ' + (!!t?.integrationTokenEnc) + (tok ? ' (<code>' + esc(tok.slice(0, 8)) + '…</code>, ' + tok.length + ' симв.)' : '') +
        '\n/v1/status: ' + (st ? (st.status + ' ' + esc(st.body?.error || 'ok') + ', соцов: ' + conns.length) : 'нет ответа') +
        '\n/v1/me: ' + (me ? (me.status + ' ' + esc(me.body?.error || (me.body?.account?.name || 'ok'))) : 'нет ответа') +
        (conns.length ? '\n' + conns.map(c => '• ' + esc(c.label || c.userId)).join('\n') : ''));
    }
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
      await send(chatId, '🧪 Оплата сымитирована.');
      return bind(chatId, r.tenant);
    }
    if (cmd === '/teststatus' || cmd === '/testcollect' || cmd === '/testreport') {
      const token = args[0];
      if (!/^jsi_[A-Za-z0-9_-]{43}$/.test(token || '')) return send(chatId, 'Укажите токен: <code>' + cmd + ' jsi_…</code> (получить: /testtoken)');
      const call = (path, opts) => collectorFetch(path, {headers: {Authorization: 'Bearer ' + token, ...(opts?.body ? {'Content-Type': 'application/json'} : {})}, ...opts})
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
    await send(chatId, '🔗 <b>Keitaro: где id кампании Facebook?</b>\n\nВ каком <code>sub_id</code> вашего трекера лежит ID кампании Facebook? Напишите просто номер — например <code>4</code> (это <code>sub_id_4</code>, чаще всего так). По нему свяжем расход (FB) и доход (Keitaro).');
  }

  // Settings overview with inline actions — never traps the user in a text-input
  // step; each button opens one specific step, and any menu button leaves it.
  async function showSettings(chatId, tenantId) {
    const s = await store.settings(tenantId);
    await send(chatId, '⚙️ <b>Настройки</b>\n\n' +
      'Keitaro: ' + (s.keitaroUrl ? esc(s.keitaroUrl) : '<i>не подключён</i>') + '\n' +
      'sub_id с id кампании FB: ' + (s.keitaroSub ? '<code>' + esc(s.keitaroSub) + '</code>' : '<i>не задан</i>') + '\n' +
      'Часовой пояс: ' + (s.timezone ? '<code>' + esc(s.timezone) + '</code>' : '<i>не задан</i>'),
      {inline_keyboard: [
        [{text: s.keitaroUrl ? '🔄 Изменить Keitaro' : '➕ Подключить Keitaro', callback_data: 'set:keitaro'}],
        [{text: '🔗 sub_id кампании FB', callback_data: 'set:sub'}],
        [{text: '🕒 Часовой пояс', callback_data: 'set:tz'}]
      ]});
  }

  async function dashboardLink(tenantId) {
    return env.PUBLIC_URL + '/d/' + await rotateDashboardToken(store, tenantId);
  }

  // Calls the collector as this tenant, using the sealed integration token —
  // no cross-worker secret. Returns {ok,status,body} or null if not set up.
  // Join the collector base and a path safely: a stray trailing slash on
  // COLLECTOR_URL would otherwise make `.../`+`/v1/status` → pathname
  // `//v1/status`, which the collector doesn't know and answers 404.
  function collectorUrl(path) { return String(env.COLLECTOR_URL || '').replace(/\/+$/, '') + path; }
  // Reach the collector through the service binding when it's available (reliable
  // worker-to-worker, no public edge in between), else over the public URL.
  function collectorFetch(path, init) { const url = collectorUrl(path); return env.COLLECTOR ? env.COLLECTOR.fetch(url, init) : fetch(url, init); }
  async function collectorCall(tenantId, path, body, method) {
    if ((!env.COLLECTOR && !env.COLLECTOR_URL) || !env.MASTER_KEY) return null;
    const t = await store.tenant(tenantId);
    if (!t?.integrationTokenEnc) return null;
    let token;
    try { token = await openSecret(env.MASTER_KEY, tenantId, t.integrationTokenEnc); } catch { return null; }
    try {
      const r = await collectorFetch(path, {method: method || (body ? 'POST' : 'GET'), headers: {Authorization: 'Bearer ' + token, ...(body ? {'Content-Type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
      return {ok: r.ok, status: r.status, body: await r.json().catch(() => ({}))};
    } catch { return null; }
  }

  // Step-by-step connection instructions + the antidetect extension as a file.
  // Everything needed to connect an ad account, in one place: step-by-step
  // instructions, the access key, and the extension archive as a file.
  async function sendPluginKit(chatId, tenantId) {
    let token = null;
    if (tenantId) {
      const t = await store.tenant(tenantId);
      if (t && t.integrationTokenEnc && env.MASTER_KEY) { try { token = await openSecret(env.MASTER_KEY, tenantId, t.integrationTokenEnc); } catch {} }
      if (!token) token = await rotateIntegrationToken(store, tenantId, env.MASTER_KEY);
    }
    // Read the live extension version so the message shows it and the download
    // URL is cache-busted: Telegram caches a sent document by its URL, so a new
    // build at the same URL would keep handing out the old file.
    let ver = '';
    try { const h = await collectorFetch('/health'); const j = await h.json(); ver = String(j.extensionVersion || ''); } catch {}
    await send(chatId, '🧩 <b>Как подключить рекламный кабинет — по шагам</b>' + (ver ? ' (плагин v' + esc(ver) + ')' : '') + '\n\n' +
      '1️⃣ Скачайте расширение (файл ниже) и распакуйте в отдельную папку. Если уже стоит старая версия — удалите её в антидетекте и поставьте этот архив.\n' +
      '2️⃣ В антидетекте (AdsPower / Dolphin): раздел «Расширения» → добавить локальное → укажите эту папку → включите для нужного профиля.\n' +
      '3️⃣ Откройте профиль и зайдите в <b>Ads Manager</b> нужного соца.\n' +
      '4️⃣ Нажмите иконку расширения <b>JS Control</b>, вставьте ключ (ниже) и нажмите «Подключить этот профиль».\n\n' +
      (token ? '🔑 <b>Ваш ключ доступа:</b>\n<code>' + token + '</code>\n\n' : '') +
      '✅ Дальше сервер собирает данные сам — браузер можно закрыть. Статистику смотрите в «📊 Статистика».\n\n' +
      'Либо подключить все профили сразу по API-токену антидетекта: ' + env.IMPORT_URL);
    const docUrl = collectorUrl('/extension.zip' + (ver ? '?v=' + encodeURIComponent(ver) : '?t=' + Date.now()));
    try { await tg('sendDocument', {chat_id: chatId, document: docUrl, caption: 'Расширение JS Control' + (ver ? ' v' + ver : '') + ' для антидетекта'}); } catch {}
  }

  // Builds the «Сейчас» report text (FB spend ↔ Keitaro revenue/ROI). Returns
  // null if no socials are connected. Shared by «📊 Статистика» and the optional
  // push-on-update notification.
  async function statsReportText(tenantId) {
    const st = await collectorCall(tenantId, '/v1/status');
    const conns = (st && st.body && st.body.connections) || [];
    if (!conns.length) return null;
    const s = await store.settings(tenantId);
    const tz = s.timezone || 'UTC';
    const day = new Date().toLocaleDateString('en-CA', {timeZone: tz});
    const nowHHMM = new Date().toLocaleTimeString('ru-RU', {timeZone: tz, hour: '2-digit', minute: '2-digit'});
    const fbAt = conns.map(c => c.collectedAt).filter(Boolean).sort().pop();
    const fbTime = fbAt ? new Date(fbAt).toLocaleTimeString('ru-RU', {timeZone: tz, hour: '2-digit', minute: '2-digit'}) : '—';
    const campaigns = [];
    for (const c of conns) {
      const r = await collectorCall(tenantId, '/v1/campaigns?userId=' + encodeURIComponent(c.userId));
      for (const cmp of (r && r.body && r.body.campaigns) || []) campaigns.push(cmp);
    }
    let keitaro = null, note = '';
    const origin = s.keitaroUrl ? keitaroOrigin(s.keitaroUrl) : null;
    let key = null;
    if (s.keitaroKeyEnc && env.MASTER_KEY) { try { key = await openSecret(env.MASTER_KEY, tenantId, s.keitaroKeyEnc); } catch {} }
    const subIndex = Number(String(s.keitaroSub || '').match(/\d+/)?.[0]) || 4;
    if (origin && key && env.KEITARO_BRIDGE) {
      const res = await keitaroReport(env)(origin, key, {from: day, to: day, timezone: tz, subIndex});
      if (res && res.result === 'ok') keitaro = aggregateKeitaro(res, {subIndex, day});
      else note = '\n\n⚠️ Keitaro недоступен (' + esc(res?.result || 'нет ответа') + ') — доход не посчитан.';
    } else if (!origin || !key) {
      note = '\n\n💡 Подключите Keitaro в «👤 Профиль → Инструкции» — тогда увидите доход, прибыль и ROI.';
    }
    return buildNow({day, times: {fb: fbTime, keitaro: keitaro ? nowHHMM : '—'}, campaigns, keitaro, subIndex}) + note;
  }

  async function showStats(chatId, tenantId) {
    await notifyNewSocials(chatId, tenantId);
    const text = await statsReportText(tenantId);
    if (!text) return send(chatId, '📊 Пока нет подключённых соцов или данных. Подключите соц — кнопка «🧩 Подключить соц».', MENU);
    await send(chatId, text, MENU);
  }

  // --- Agents: assign each connected social to a buyer for spend accounting ---
  async function syncSocials(tenantId) {
    const st = await collectorCall(tenantId, '/v1/status');
    const conns = (st && st.body && st.body.connections) || [];
    const fresh = [];
    for (const c of conns) {
      const existing = await store.social(tenantId, c.userId);
      if (!existing) { await store.addSocial(tenantId, c.userId, c.label || String(c.userId)); fresh.push({userId: String(c.userId), label: c.label || String(c.userId), accounts: c.accounts, businesses: c.businesses, pages: c.pages, collectedAt: c.collectedAt}); }
      else if (c.label && c.label !== existing.label) await store.setSocialLabel(tenantId, c.userId, c.label);
    }
    return fresh;
  }

  async function agentButtons(tenantId, userId) {
    const agents = await store.listAgents(tenantId);
    const rows = agents.map(a => [{text: '👤 ' + a.name, callback_data: 'assign:' + userId + ':' + a.id}]);
    rows.push([{text: '➕ Новый агент', callback_data: 'assign:' + userId + ':new'}]);
    return {inline_keyboard: rows};
  }

  // The progressive "profile connected" card, rendered from the DB so it can be
  // edited in place at any stage: 🔄 collecting (ask for an agent) → ✅ loaded
  // with РК/БМ/ФП and the agent. Agent buttons stay until one is chosen.
  async function socialCard(tenantId, userId) {
    const s = await store.social(tenantId, userId);
    if (!s) return {text: 'Профиль не найден.'};
    const agentName = s.agentId ? ((await store.listAgents(tenantId)).find(a => a.id === s.agentId) || {}).name || 'агент' : null;
    const loaded = s.collectedAt != null;
    let text;
    if (!loaded) {
      text = '🔄 Видим профиль «' + esc(s.label || s.userId) + '» (как в антидетеке).\nСобираем данные по кабинетам…';
    } else {
      // «РК» = кабинеты в БМ (с них запускают); личные РК соца не в счёте.
      text = '✅ <b>«' + esc(s.label || s.userId) + '»</b>\n' +
        'Соц: <b>' + esc(s.fbName || '—') + '</b>\n' +
        'ID соц: <code>' + esc(s.userId) + '</code>\n' +
        'РК: <b>' + (s.rk ?? 0) + '</b>' + (s.rkPersonal ? ' <i>(+' + s.rkPersonal + ' личных)</i>' : '') + '\n' +
        'БМ: <b>' + (s.bm ?? 0) + '</b>\n' +
        'ФП: <b>' + (s.fp ?? 0) + '</b>\n' +
        'Агент: <b>' + (agentName ? esc(agentName) : 'не назначен') + '</b>';
    }
    if (s.agentId && !loaded) text += '\nАгент: <b>' + esc(agentName) + '</b>';
    if (!s.agentId) text += '\n\nУкажите агента, к кому отнести профиль:';
    return {text, markup: s.agentId ? undefined : await agentButtons(tenantId, userId)};
  }

  // Sends the card and remembers its message id, so it can be edited later.
  async function sendSocialCard(chatId, tenantId, userId) {
    const card = await socialCard(tenantId, userId);
    const msg = await send(chatId, card.text, card.markup);
    if (msg && msg.message_id) await store.setSocialNotifyMsg(tenantId, userId, msg.message_id);
  }

  async function promptAssign(chatId, tenantId, s) { await sendSocialCard(chatId, tenantId, s.userId); }

  // Detects newly connected socials and prompts to assign each. Works whether
  // the client added one or many — each new social is prompted once; all
  // unassigned ones also stay listed under «👥 Агенты».
  async function notifyNewSocials(chatId, tenantId) {
    for (const s of await syncSocials(tenantId)) await promptAssign(chatId, tenantId, s);
  }

  // Main «Агенты» screen: each agent numbered, with its profiles listed under it,
  // then the unassigned ones. Returned as {text, markup} so it can be sent once
  // and then edited in place for every sub-action (no chat spam).
  async function agentsView(tenantId) {
    const agents = await store.listAgents(tenantId), socials = await store.listSocials(tenantId);
    const byAgent = {}; for (const s of socials) { const k = s.agentId || '_'; (byAgent[k] = byAgent[k] || []).push(s); }
    let text = '👥 <b>Агенты</b>\n';
    if (!agents.length) text += '\n<i>Агентов пока нет — добавьте кнопкой ниже.</i>';
    agents.forEach((a, i) => {
      const list = byAgent[a.id] || [];
      text += '\n<b>' + (i + 1) + '. ' + esc(a.name) + '</b> — профилей: ' + list.length +
        (list.length ? '\n' + list.map(s => '   • ' + esc(s.label || s.userId)).join('\n') : '');
    });
    const un = byAgent['_'] || [];
    text += '\n\n<b>Без агента</b> — профилей: ' + un.length +
      (un.length ? '\n' + un.map(s => '   • ' + esc(s.label || s.userId)).join('\n') : '');
    const markup = {inline_keyboard: [
      [{text: '➕ Агент', callback_data: 'ag:add'}],
      [{text: '🗑 Удалить агента', callback_data: 'ag:dalist'}, {text: '🗑 Удалить профиль', callback_data: 'ag:dplist'}],
      [{text: '🔄 Обновить', callback_data: 'ag:main'}]
    ]};
    return {text, markup};
  }

  async function delAgentView(tenantId) {
    const agents = await store.listAgents(tenantId);
    const rows = agents.map((a, i) => [{text: (i + 1) + '. ' + (a.name || a.id), callback_data: 'ag:da:' + a.id}]);
    rows.push([{text: '↩️ Назад', callback_data: 'ag:main'}]);
    return {text: '🗑 <b>Удалить агента</b>\nЕго профили станут «без агента» (сами профили не удаляются).' + (agents.length ? '\n\nВыберите номер:' : '\n\n<i>Агентов нет.</i>'), markup: {inline_keyboard: rows}};
  }

  async function delSocView(tenantId) {
    const socials = await store.listSocials(tenantId), agents = await store.listAgents(tenantId);
    const an = {}; for (const a of agents) an[a.id] = a.name;
    const rows = socials.slice(0, 30).map((s, i) => [{text: (i + 1) + '. ' + (s.label || s.userId) + ' — ' + (s.agentId ? (an[s.agentId] || 'агент') : 'без агента'), callback_data: 'ag:dp:' + s.userId}]);
    rows.push([{text: '↩️ Назад', callback_data: 'ag:main'}]);
    return {text: '🗑 <b>Удалить профиль</b>\nСбор по нему остановится, собранные данные удалятся.' + (socials.length ? '\n\nВыберите номер:' : '\n\n<i>Профилей нет.</i>'), markup: {inline_keyboard: rows}};
  }

  async function showAgents(chatId, tenantId) {
    await notifyNewSocials(chatId, tenantId);
    const v = await agentsView(tenantId);
    await send(chatId, v.text, v.markup);
  }

  // Shows the current access key (decrypted from the sealed copy) without
  // rotating it — the client needs it handy to paste into the extension.
  async function showKey(chatId, tenantId) {
    const t = await store.tenant(tenantId);
    let token = null;
    if (t && t.integrationTokenEnc && env.MASTER_KEY) { try { token = await openSecret(env.MASTER_KEY, tenantId, t.integrationTokenEnc); } catch {} }
    if (!token) token = await rotateIntegrationToken(store, tenantId, env.MASTER_KEY);
    await send(chatId, '🔑 <b>Ваш ключ доступа</b> — вставьте в расширение JS Control:\n<code>' + token + '</code>\n\nНикому не передавайте. Перевыпустить (старый перестанет работать): /token.', MENU);
  }

  const campIcon = s => s === 'ACTIVE' ? '🟢' : '🔴';

  async function campaignsEntry(chatId, tenantId) {
    await notifyNewSocials(chatId, tenantId);
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
    await sendPluginKit(chatId, tenantId);
    // First-run: show the legend and nudge to open today's report.
    await send(chatId, LEGEND + '\n\nКак подключите хотя бы один соц — жмите «📊 Статистика», чтобы увидеть отчёт за сегодня.', MENU);
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

  // --- «👤 Профиль»: единый экран (подписка/ключ/инструкции/настройки) ---
  const back = cb => ({inline_keyboard: [[{text: '↩️ Назад', callback_data: cb}]]});
  const daysLeft = until => { if (!until) return 0; return Math.max(0, Math.ceil((Date.parse(until) - Date.now()) / 86400000)); };
  async function currentKey(tenantId) {
    const t = await store.tenant(tenantId);
    if (t && t.integrationTokenEnc && env.MASTER_KEY) { try { return await openSecret(env.MASTER_KEY, tenantId, t.integrationTokenEnc); } catch {} }
    return rotateIntegrationToken(store, tenantId, env.MASTER_KEY);
  }
  async function profileView(tenant) {
    const text = '👤 <b>Профиль</b>\nПользователь: <b>' + esc(tenant.name || '—') + '</b>\n\n' +
      '💳 Подписка: <b>Стандарт</b>\nДействует до: <b>' + esc(tenant.paidUntil || '—') + '</b>\nОсталось дней: <b>' + daysLeft(tenant.paidUntil) + '</b>';
    return {text, markup: {inline_keyboard: [
      [{text: '🔑 Ключ интеграции', callback_data: 'pr:key'}],
      [{text: '📘 Инструкции', callback_data: 'pr:instr'}],
      [{text: '🔀 Сменить тариф', callback_data: 'pr:plan'}],
      [{text: '🔔 Уведомления', callback_data: 'pr:notify'}],
      [{text: '🔗 sub_id кампании Keitaro', callback_data: 'pr:sub'}],
      [{text: '⏱ Частота обновления', callback_data: 'pr:freq'}]
    ]}};
  }
  async function showProfile(chatId, tenantId) {
    const v = await profileView(await store.tenant(tenantId));
    await send(chatId, v.text, v.markup);
  }
  async function notifyView(tenantId) {
    const s = await store.settings(tenantId), on = !!s.notifyOnUpdate;
    return {text: '🔔 <b>Уведомления</b>\n\nПрисылать свежий отчёт «Сейчас» в бот при каждом обновлении данных: <b>' + (on ? 'включено' : 'выключено') + '</b>.',
      markup: {inline_keyboard: [[{text: on ? '🔕 Выключить' : '🔔 Включить', callback_data: 'pr:notify:' + (on ? 'off' : 'on')}], [{text: '↩️ Назад', callback_data: 'pr:main'}]]}};
  }
  async function freqView(tenantId) {
    const s = await store.settings(tenantId), cur = s.refreshMinutes || 60;
    const b = m => ({text: (cur === m ? '✅ ' : '') + m + ' мин', callback_data: 'pr:freq:' + m});
    return {text: '⏱ <b>Частота обновления</b>\n\nКак часто тянуть данные из Keitaro и рекламных кабинетов. Сейчас: <b>' + cur + ' мин</b>.',
      markup: {inline_keyboard: [[b(30), b(60), b(120)], [{text: '↩️ Назад', callback_data: 'pr:main'}]]}};
  }
  // Apply the chosen refresh frequency to every connected social on the collector.
  async function applyFrequency(tenantId, minutes) {
    const st = await collectorCall(tenantId, '/v1/status');
    for (const c of (st && st.body && st.body.connections) || []) await collectorCall(tenantId, '/v1/schedule', {userId: c.userId, minutes});
  }

  async function bind(chatId, tenant) {
    const s = await store.settings(tenant.id);
    await store.setChat(chatId, tenant.id, s.onboardedAt ? 'ready' : 'keitaro_url');
    if (s.onboardedAt) return send(chatId, '✅ С возвращением! Тариф <b>' + esc(planName(tenant.plan)) + '</b>, активен до ' + tenant.paidUntil + '.', MENU);
    await send(chatId, '🎉 <b>Поздравляем, доступ открыт!</b>\nТариф <b>' + esc(planName(tenant.plan)) + '</b> до ' + tenant.paidUntil +
      '.\n\nНастроим за 3 простых шага:\n1️⃣ Keitaro (можно пропустить)\n2️⃣ Часовой пояс\n3️⃣ Подключение рекламных кабинетов\n\nВаш ключ доступа всегда под рукой — кнопка «🔑 Ключ».');
    await askKeitaroUrl(chatId);
  }

  async function onPaid(chatId, message) {
    const pay = message.successful_payment;
    const plan = String(pay.invoice_payload || '').replace(/^plan:/, '');
    const chat = await store.chat(chatId);
    const result = await applyPayment(store, {paymentId: 'tg:' + pay.telegram_payment_charge_id, provider: 'telegram-stars', plan,
      name: message.from?.username || message.from?.first_name, tenantId: chat?.tenantId || undefined, amount: pay.total_amount, currency: pay.currency, masterKey: env.MASTER_KEY});
    if (result.duplicate) return;
    if (result.integrationToken) return bind(chatId, result.tenant);
    await send(chatId, '🎉 Подписка продлена до ' + result.tenant.paidUntil + '.', MENU);
  }

  async function onMessage(message) {
    const chatId = message.chat.id, text = String(message.text || '').trim();
    if (message.successful_payment) return onPaid(chatId, message);
    const chat = await store.chat(chatId);

    if (isAdmin(chatId) && /^\/(invite|invites|revoke|reset|diag|testtoken|teststatus|testcollect|testreport)\b/.test(text)) return adminCommand(chatId, text);

    const code = findInviteCode(text);
    if (code) {
      await forget(chatId, message.message_id);
      if (chat?.tenantId && await store.tenant(chat.tenantId)) return send(chatId, 'У этого Telegram-аккаунта уже есть доступ к JS Control. Код не использован — его можно передать другому человеку.', MENU);
      const result = await redeemInvite(store, code, {chatId, name: message.from?.username || message.from?.first_name, masterKey: env.MASTER_KEY});
      if (result.error) return send(chatId, INVITE_ERRORS[result.error]);
      await send(chatId, '🎁 Код активирован!');
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

    // Key is retrievable at any point, even mid-onboarding.
    if (text === '🔑 Ключ' || text === '/key') return showKey(chatId, tenant.id);

    // A main-menu button or command always works, even mid-input: it leaves the
    // half-finished step (settings/budget/new agent) instead of the button text
    // being parsed as that step's value. Without this the user gets stuck.
    const menuHit = ['📊 Статистика', '📣 Кампании', '👥 Агенты', '🧩 Подключить соц', '👤 Профиль', '💳 Подписка', '⚙️ Настройки', '🔑 Ключ'].includes(text)
      || /^\/(start|stats|campaigns|agents|plugin|connect|subscription|settings|profile|key|dashboard|token)\b/.test(text);
    if (menuHit && chat.state && chat.state !== 'ready') await store.setChat(chatId, tenant.id, 'ready');

    if (!menuHit && chat.state === 'keitaro_url') {
      const origin = keitaroOrigin(text);
      if (!origin) return send(chatId, 'Не похоже на адрес. Пример: <code>https://tracker.example.com</code>');
      await store.saveSettings(tenant.id, {keitaroUrl: origin});
      await store.setChat(chatId, tenant.id, 'keitaro_key');
      return send(chatId, '🔑 <b>Шаг 2 из 3 — API-ключ Keitaro</b>\n\nKeitaro → Профиль → API-ключи → создайте ключ и отправьте его сюда. Сообщение с ключом будет сразу удалено из чата.',
        {inline_keyboard: [[{text: 'Пропустить Keitaro', callback_data: 'skip:keitaro'}]]});
    }
    if (!menuHit && chat.state === 'keitaro_key') {
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
    if (!menuHit && chat.state === 'keitaro_sub') {
      const m = String(text).match(/(?:sub_id_)?([1-6])\b/i);
      if (!m) return send(chatId, 'Укажите номер саба 1–6 — например <code>sub_id_4</code> или просто <code>4</code>.');
      await store.saveSettings(tenant.id, {keitaroSub: 'sub_id_' + m[1]});
      return askTimezone(chatId, tenant.id);
    }
    // Changing sub_id from «Профиль» (not onboarding): save and return to profile.
    if (!menuHit && chat.state === 'profile_sub') {
      const m = String(text).match(/(?:sub_id_)?([1-6])\b/i);
      if (!m) return send(chatId, 'Укажите номер саба 1–6 — например <code>4</code>.');
      await store.saveSettings(tenant.id, {keitaroSub: 'sub_id_' + m[1]});
      await store.setChat(chatId, tenant.id, 'ready');
      await send(chatId, '✅ sub_id кампании Keitaro: <b>sub_id_' + m[1] + '</b>.');
      return showProfile(chatId, tenant.id);
    }
    if (!menuHit && chat.state === 'timezone') {
      if (!validTimezone(text)) return send(chatId, 'Не знаю такой пояс. Пример: <code>Europe/Minsk</code>');
      return finish(chatId, tenant.id, text);
    }
    if (!menuHit && chat.state && chat.state.startsWith('budget:')) {
      const [, userId, cid] = chat.state.split(':');
      const dollars = Number(String(text).replace(',', '.').replace(/[^\d.]/g, ''));
      if (!(dollars > 0)) return send(chatId, 'Введите сумму дневного бюджета в валюте кабинета, например <code>15</code> или <code>15.50</code>.');
      await store.setChat(chatId, tenant.id, 'ready');
      return runAction(chatId, tenant.id, {userId, campaignId: cid, dailyBudget: Math.round(dollars * 100)}, 'Бюджет ' + dollars);
    }
    if (!menuHit && chat.state && chat.state.startsWith('newagent')) {
      const name = String(text).trim().slice(0, 40);
      if (!name || /^\//.test(name)) return send(chatId, 'Введите имя агента, например <code>Иван</code>.');
      // Reuse an agent with the same name instead of making a duplicate.
      let agent = (await store.listAgents(tenant.id)).find(a => (a.name || '').toLowerCase() === name.toLowerCase());
      if (!agent) agent = await store.createAgent(tenant.id, name);
      await store.setChat(chatId, tenant.id, 'ready');
      const userId = chat.state.split(':')[1];
      if (userId) {
        await store.assignSocial(tenant.id, userId, agent.id);
        // Update the profile card in place (it lives in an earlier message).
        const s = await store.social(tenant.id, userId);
        if (s && s.notifyMsgId) { const card = await socialCard(tenant.id, userId); await edit(chatId, s.notifyMsgId, card.text, card.markup); }
        return send(chatId, '✅ Готово: агент «' + esc(agent.name) + '» назначен.', MENU);
      }
      await send(chatId, '✅ Агент «' + esc(agent.name) + '» добавлен.');
      return showAgents(chatId, tenant.id);
    }

    if (text === '📊 Статистика' || text === '/stats') return showStats(chatId, tenant.id);
    if (text === '📣 Кампании' || text === '/campaigns') return campaignsEntry(chatId, tenant.id);
    if (text === '🔑 Ключ' || text === '/key') return showKey(chatId, tenant.id);
    if (text === '👥 Агенты' || text === '/agents') return showAgents(chatId, tenant.id);
    if (text === '/dashboard') return send(chatId, '📊 Веб-ссылка (необязательно, всё есть в «📊 Статистика»):\n' + await dashboardLink(tenant.id) + '\n\nПредыдущая ссылка больше не работает.', MENU);
    if (text === '🧩 Подключить соц' || text === '/plugin') return sendPluginKit(chatId, tenant.id);
    // Профиль объединяет подписку, ключ, инструкции и настройки.
    if (text === '👤 Профиль' || text === '/profile' || text === '⚙️ Настройки' || text === '/settings' || text === '💳 Подписка' || text === '/subscription') return showProfile(chatId, tenant.id);
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
    // «Профиль» — всё в одном сообщении, переходы редактируют его.
    const mid = q.message.message_id;
    if (data === 'pr:main') { const v = await profileView(await store.tenant(chat.tenantId)); return edit(chatId, mid, v.text, v.markup); }
    if (data === 'pr:key') { const k = await currentKey(chat.tenantId); return edit(chatId, mid, '🔑 <b>Ключ интеграции</b>\nВставьте в расширение JS Control:\n<code>' + k + '</code>\n\nНикому не передавайте. Перевыпуск: /token.', back('pr:main')); }
    if (data === 'pr:instr') return edit(chatId, mid, '📘 <b>Инструкции</b>\nВыберите раздел:', {inline_keyboard: [
      [{text: '⚙️ Подключение Keitaro', callback_data: 'pr:i:keitaro'}],
      [{text: '🧩 Подключение FB-аккаунтов', callback_data: 'pr:i:fb'}],
      [{text: '🔣 Обозначения в статистике', callback_data: 'pr:i:legend'}],
      [{text: '↩️ Назад', callback_data: 'pr:main'}]]});
    if (data === 'pr:i:keitaro') return edit(chatId, mid, '⚙️ <b>Подключение Keitaro</b>\n\n1. В Keitaro создайте API-ключ: Профиль → API.\n2. В онбординге бот спрашивает адрес трекера, API-ключ и номер <b>sub_id</b>, в котором лежит ID кампании Facebook (связка расхода и дохода).\n3. Поменять sub_id позже можно здесь же в «Профиле».\n\nБез Keitaro бот покажет только расход FB, без дохода и ROI.', back('pr:instr'));
    if (data === 'pr:i:fb') return edit(chatId, mid, '🧩 <b>Подключение FB-аккаунтов</b>\n\n1. Скачайте расширение JS Control (кнопка ниже) и добавьте в антидетект (AdsPower/Dolphin).\n2. Откройте профиль → Ads Manager нужного соца.\n3. В расширении вставьте ключ интеграции и нажмите «Подключить этот профиль».\n4. Через ~минуту соц появится с карточкой РК/БМ/ФП — закрепите за агентом.', {inline_keyboard: [[{text: '📥 Скачать плагин и ключ', callback_data: 'pr:plugin'}], [{text: '↩️ Назад', callback_data: 'pr:instr'}]]});
    if (data === 'pr:i:legend') return edit(chatId, mid, LEGEND, back('pr:instr'));
    if (data === 'pr:plugin') return sendPluginKit(chatId, chat.tenantId);
    if (data === 'pr:plan') return edit(chatId, mid, '🔀 <b>Смена тарифа</b>\n\nВ разработке. Сейчас доступен тариф <b>Стандарт</b>.', back('pr:main'));
    if (data === 'pr:notify') { const v = await notifyView(chat.tenantId); return edit(chatId, mid, v.text, v.markup); }
    if (data === 'pr:notify:on' || data === 'pr:notify:off') { await store.saveSettings(chat.tenantId, {notifyOnUpdate: data.endsWith(':on') ? 1 : 0}); const v = await notifyView(chat.tenantId); return edit(chatId, mid, v.text, v.markup); }
    if (data === 'pr:sub') { await store.setChat(chatId, chat.tenantId, 'profile_sub'); return send(chatId, '🔗 Введите номер <b>sub_id</b> (1–6), в котором лежит ID кампании Facebook — например <code>4</code>:'); }
    if (data === 'pr:freq') { const v = await freqView(chat.tenantId); return edit(chatId, mid, v.text, v.markup); }
    if (data.startsWith('pr:freq:')) { const m = Number(data.slice(8)); if ([30, 60, 120].includes(m)) { await store.saveSettings(chat.tenantId, {refreshMinutes: m}); try { await applyFrequency(chat.tenantId, m); } catch {} } const v = await freqView(chat.tenantId); return edit(chatId, mid, v.text, v.markup); }
    if (data.startsWith('tz:') && chat.state === 'timezone' && validTimezone(data.slice(3))) return finish(chatId, chat.tenantId, data.slice(3));
    if (data.startsWith('soc:')) return showCampaigns(chatId, chat.tenantId, data.slice(4));
    if (data.startsWith('cmp:')) { const [, userId, cid] = data.split(':'); return showCampaign(chatId, chat.tenantId, userId, cid); }
    if (data.startsWith('act:')) { const [, userId, cid, op] = data.split(':'); return runAction(chatId, chat.tenantId, {userId, campaignId: cid, status: op === 'pause' ? 'PAUSED' : 'ACTIVE'}, op === 'pause' ? 'Пауза' : 'Включение'); }
    if (data.startsWith('budg:')) { const [, userId, cid] = data.split(':'); await store.setChat(chatId, chat.tenantId, 'budget:' + userId + ':' + cid); return send(chatId, '💰 Введите новый дневной бюджет (в валюте кабинета), например <code>15</code>:'); }
    if (data.startsWith('chk:')) return checkJob(chatId, chat.tenantId, data.slice(4));
    if (data.startsWith('assign:')) {
      const [, userId, agentId] = data.split(':');
      if (agentId === 'new') { await store.setChat(chatId, chat.tenantId, 'newagent:' + userId); return send(chatId, '➕ Введите имя нового агента:'); }
      const a = (await store.listAgents(chat.tenantId)).find(x => x.id === agentId);
      if (!a) { const card = await socialCard(chat.tenantId, userId); return edit(chatId, q.message.message_id, card.text, card.markup); }
      await store.assignSocial(chat.tenantId, userId, agentId);
      // Edit the same card in place — no extra "assigned" message.
      const card = await socialCard(chat.tenantId, userId);
      return edit(chatId, q.message.message_id, card.text, card.markup);
    }
    if (data.startsWith('pick:')) { const userId = data.slice(5); const s = await store.social(chat.tenantId, userId); return send(chatId, '📌 Закрепить соц «' + esc((s && s.label) || userId) + '» за агентом:', await agentButtons(chat.tenantId, userId)); }
    // «Агенты» screen — one evolving message, edited in place for every action.
    if (data === 'ag:main') { const v = await agentsView(chat.tenantId); return edit(chatId, q.message.message_id, v.text, v.markup); }
    if (data === 'ag:dalist') { const v = await delAgentView(chat.tenantId); return edit(chatId, q.message.message_id, v.text, v.markup); }
    if (data === 'ag:dplist') { const v = await delSocView(chat.tenantId); return edit(chatId, q.message.message_id, v.text, v.markup); }
    if (data === 'ag:add') { await store.setChat(chatId, chat.tenantId, 'newagent'); return send(chatId, '➕ Введите имя нового агента:'); }
    if (data.startsWith('ag:da:')) {
      const id = data.slice(6); const a = (await store.listAgents(chat.tenantId)).find(x => x.id === id);
      if (!a) { const v = await delAgentView(chat.tenantId); return edit(chatId, q.message.message_id, v.text, v.markup); }
      return edit(chatId, q.message.message_id, '🗑 Удалить агента «' + esc(a.name) + '»?\nЕго профили станут «без агента».',
        {inline_keyboard: [[{text: '✅ Да, удалить', callback_data: 'ag:dao:' + id}, {text: '↩️ Назад', callback_data: 'ag:dalist'}]]});
    }
    if (data.startsWith('ag:dao:')) { await store.deleteAgent(chat.tenantId, data.slice(7)); const v = await agentsView(chat.tenantId); return edit(chatId, q.message.message_id, v.text, v.markup); }
    if (data.startsWith('ag:dp:')) {
      const userId = data.slice(6); const s = await store.social(chat.tenantId, userId);
      return edit(chatId, q.message.message_id, '🗑 Удалить профиль «' + esc((s && s.label) || userId) + '»?\nСбор остановится, данные удалятся.',
        {inline_keyboard: [[{text: '✅ Да, удалить', callback_data: 'ag:dpo:' + userId}, {text: '↩️ Назад', callback_data: 'ag:dplist'}]]});
    }
    if (data.startsWith('ag:dpo:')) {
      const userId = data.slice(7);
      await collectorCall(chat.tenantId, '/v1/connections', {userId}, 'DELETE');
      await store.deleteSocial(chat.tenantId, userId);
      const v = await agentsView(chat.tenantId); return edit(chatId, q.message.message_id, v.text, v.markup);
    }
    if (data === 'newagent') { await store.setChat(chatId, chat.tenantId, 'newagent:'); return send(chatId, '➕ Введите имя нового агента:'); }
  }

  const handleUpdate = async function handleUpdate(update) {
    if (update.pre_checkout_query) {
      const plan = String(update.pre_checkout_query.invoice_payload || '').replace(/^plan:/, '');
      return tg('answerPreCheckoutQuery', PLANS[plan] ? {pre_checkout_query_id: update.pre_checkout_query.id, ok: true}
        : {pre_checkout_query_id: update.pre_checkout_query.id, ok: false, error_message: 'Тариф не найден'});
    }
    if (update.callback_query) return onCallback(update.callback_query);
    if (update.message) return onMessage(update.message);
  };

  // Push from the collector: a social was connected in the plugin. Notifies the
  // tenant's chat right away (not only when they next open a bot screen).
  // Ensures the social exists in the store with the latest label; returns chatId.
  async function upsertSocial(tenantId, social) {
    const chatId = await store.chatForTenant(tenantId);
    if (!chatId || !social?.userId) return null;
    const existing = await store.social(tenantId, social.userId);
    if (!existing) await store.addSocial(tenantId, social.userId, social.label || String(social.userId));
    else if (social.label && social.label !== existing.label) await store.setSocialLabel(tenantId, social.userId, social.label);
    return chatId;
  }

  // Push 1 (on connect): show the card immediately in "🔄 collecting" state so
  // the client can assign an agent right away instead of waiting.
  handleUpdate.notifySocialConnected = async (tenantId, social) => {
    const chatId = await upsertSocial(tenantId, social);
    if (!chatId) return;
    await sendSocialCard(chatId, tenantId, social.userId);
  };

  // Push 2 (after first collection): store the counts and rewrite the SAME card
  // in place to "✅ loaded" with РК/БМ/ФП and the agent.
  handleUpdate.notifySocialCollected = async (tenantId, social) => {
    const chatId = await upsertSocial(tenantId, social);
    if (!chatId) return;
    await store.setSocialStats(tenantId, social.userId, {rk: social.rk ?? null, rkPersonal: social.rkPersonal ?? null, bm: social.bm ?? null, fp: social.fp ?? null, fbName: social.fbName ?? null, collectedAt: social.collectedAt || new Date().toISOString()});
    const s = await store.social(tenantId, social.userId), card = await socialCard(tenantId, social.userId);
    if (s?.notifyMsgId) await edit(chatId, s.notifyMsgId, card.text, card.markup);
    else await sendSocialCard(chatId, tenantId, social.userId);
  };

  // Push 3 (optional, per «Профиль → Уведомления»): send the fresh «Сейчас»
  // report after a data refresh. Called by the collector once per refresh cycle.
  handleUpdate.notifyStatsRefresh = async (tenantId) => {
    const s = await store.settings(tenantId);
    if (!s.notifyOnUpdate) return;
    const chatId = await store.chatForTenant(tenantId);
    if (!chatId) return;
    const text = await statsReportText(tenantId);
    if (text) await send(chatId, '🔄 <b>Данные обновлены</b>\n\n' + text, MENU);
  };
  return handleUpdate;
}
