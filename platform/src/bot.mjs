// Telegram bot for clients: bind a chat with the integration token (or buy
// with Telegram Stars), fill basic settings, get the plugin and the dashboard.
import {PLANS, applyPayment, authenticate, isActive, rotateDashboardToken, rotateIntegrationToken} from './accounts.mjs';
import {checkKeitaro, keitaroOrigin} from './keitaro.mjs';
import {sealSecret} from './secrets.mjs';
import {findToken} from './tokens.mjs';

const MENU = {keyboard: [[{text: '📊 Дашборд'}, {text: '🧩 Плагин'}], [{text: '⚙️ Настройки'}, {text: '💳 Подписка'}]], resize_keyboard: true};
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

  async function welcome(chatId) {
    await send(chatId, '👋 <b>JS Control</b>\n\nОтправьте сюда <b>токен интеграции</b>, который вы получили после оплаты (начинается с <code>jsi_</code>).' +
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

  async function dashboardLink(tenantId) {
    return env.PUBLIC_URL + '/d/' + await rotateDashboardToken(store, tenantId);
  }

  async function finish(chatId, tenantId, tz) {
    await store.saveSettings(tenantId, {timezone: tz, currency: 'USD', onboardedAt: new Date().toISOString()});
    await store.setChat(chatId, tenantId, 'ready');
    await send(chatId, '✅ <b>Настройки сохранены</b>\n\nОсталось подключить Facebook:\n' + pluginText() +
      '\n\n📊 Ваш дашборд: ' + await dashboardLink(tenantId) + '\nДанные появятся после первого сбора (обычно несколько минут).', MENU);
  }

  function pluginText() {
    return '1. Установите плагин JS Control: ' + env.PLUGIN_URL +
      '\n2. Откройте плагин и войдите <b>тем же токеном интеграции</b>.\n3. Откройте Ads Manager нужного соца и нажмите «Подключить соц».';
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
      name: message.from?.username || message.from?.first_name, tenantId: chat?.tenantId || undefined, amount: pay.total_amount, currency: pay.currency});
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

    const token = findToken(text, 'integration');
    if (token) {
      await forget(chatId, message.message_id); // the token must not stay in the chat history
      const {tenant, error} = await authenticate(store, token, 'integration');
      if (error === 'invalid') return send(chatId, '❌ Токен не найден. Проверьте, что скопировали его полностью.');
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
      return send(chatId, '🔑 <b>Шаг 2 из 3 — API-ключ Keitaro</b>\n\nKeitaro → Профиль → API-ключи → создайте ключ и отправьте его сюда. Сообщение с ключом будет сразу удалено из чата.');
    }
    if (chat.state === 'keitaro_key') {
      await forget(chatId, message.message_id);
      const s = await store.settings(tenant.id);
      const result = await keitaro(s.keitaroUrl, text);
      if (result === 'bad_key') return send(chatId, '❌ Keitaro не принял ключ. Проверьте ключ и отправьте ещё раз.');
      if (result === 'unreachable') return send(chatId, '❌ Не удалось связаться с ' + esc(s.keitaroUrl) + '. Проверьте адрес (/settings) или доступность трекера.');
      await store.saveSettings(tenant.id, {keitaroKeyEnc: await sealSecret(env.MASTER_KEY, tenant.id, text)});
      await send(chatId, '✅ Keitaro подключён.');
      return askTimezone(chatId, tenant.id);
    }
    if (chat.state === 'timezone') {
      if (!validTimezone(text)) return send(chatId, 'Не знаю такой пояс. Пример: <code>Europe/Minsk</code>');
      return finish(chatId, tenant.id, text);
    }

    if (text === '📊 Дашборд' || text === '/dashboard') return send(chatId, '📊 Ссылка на дашборд:\n' + await dashboardLink(tenant.id) + '\n\nПредыдущая ссылка больше не работает.', MENU);
    if (text === '🧩 Плагин' || text === '/plugin') return send(chatId, '🧩 <b>Плагин</b>\n' + pluginText(), MENU);
    if (text === '⚙️ Настройки' || text === '/settings') return askKeitaroUrl(chatId);
    if (text === '💳 Подписка' || text === '/subscription') return subscription(chatId, tenant);
    if (text === '/token') {
      const fresh = await rotateIntegrationToken(store, tenant.id);
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
    if (data.startsWith('tz:') && chat.state === 'timezone' && validTimezone(data.slice(3))) return finish(chatId, chat.tenantId, data.slice(3));
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
