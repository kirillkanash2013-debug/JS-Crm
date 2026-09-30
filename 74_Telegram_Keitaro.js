/**
 * Keitaro drill-down for Telegram: Кампании → Потоки → Офферы (с %).
 *
 * Same tap/number pattern as the Meta panel: numbered stat list + action
 * buttons, prompts in a separate message, list edited in place. Viewing is
 * live; changing an offer's percent is a real Keitaro write, so it goes through
 * a confirm step and stays stubbed until explicitly enabled on a safe target.
 */

function keitaroNavKey_(chatId) { return 'TELEGRAM_KT_NAV_' + String(chatId); }

function keitaroLoadNav_(chatId) {
  try {
    return JSON.parse(PropertiesService.getScriptProperties()
      .getProperty(keitaroNavKey_(chatId)) || '{}');
  } catch (_) { return {}; }
}

function keitaroSaveNav_(chatId, state) {
  PropertiesService.getScriptProperties()
    .setProperty(keitaroNavKey_(chatId), JSON.stringify(state));
}

function keitaroClearNav_(chatId) {
  PropertiesService.getScriptProperties().deleteProperty(keitaroNavKey_(chatId));
}

function keitaroRender_(chatId, state, text, keyboard) {
  if (state.messageId) {
    try { telegramEditInline_(chatId, state.messageId, text, keyboard); return; } catch (_) {}
  }
  const sent = telegramSend_(chatId, text, keyboard);
  if (sent && sent.result) state.messageId = sent.result.message_id;
}

/* ===================== Keyboards ===================== */

function keitaroKeyboard_(level) {
  if (level === 'campaigns') {
    return {inline_keyboard: [
      [{text: '🔍 Осмотреть', callback_data: 'kt:ins'}],
      [{text: '🏠 Меню', callback_data: 'kt:menu'}]
    ]};
  }
  if (level === 'flows') {
    return {inline_keyboard: [
      [{text: '🔍 Осмотреть', callback_data: 'kt:ins'}],
      [{text: '⬅️ Назад', callback_data: 'kt:back'}, {text: '🏠 Меню', callback_data: 'kt:menu'}]
    ]};
  }
  // offers
  return {inline_keyboard: [
    [{text: '✏️ Изменить %', callback_data: 'kt:pct'}],
    [{text: '⬅️ Назад', callback_data: 'kt:back'}, {text: '🏠 Меню', callback_data: 'kt:menu'}]
  ]};
}

/* ===================== Views ===================== */

function keitaroCampaignsView_() {
  const sheet = getOrCreateSheet_(SHEETS.DB_KEITARO_TODAY);
  const by = {};
  if (sheet.getLastRow() > 1) {
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, getKeitaroHeaders_().length).getValues();
    rows.forEach(function (row) {
      const id = String(row[16] || '');
      if (!/^\d+$/.test(id)) return;
      const c = by[id] || (by[id] = {id: id, name: String(row[17] || id), inst: 0, reg: 0, dep: 0});
      c.inst += num_(row[6]); c.reg += num_(row[7]); c.dep += num_(row[8]);
    });
  }
  const list = Object.keys(by).map(function (k) { return by[k]; })
    .filter(function (c) { return c.inst > 0 || c.reg > 0 || c.dep > 0; })
    .sort(function (a, b) { return b.inst - a.inst; }).slice(0, 40);
  const header = TELEGRAM_ICON_KEITARO + ' <b>Кейтаро · ' +
    escapeHtml_(formatTelegramDate_(getToday_())) + '</b>';
  const cards = list.map(function (c, i) {
    return '<b>' + (i + 1) + '.</b> ' + escapeHtml_(telegramTrim_(c.name, 30)) +
      '\n' + Math.round(c.inst) + ' - ' + Math.round(c.reg) + ' - ' + Math.round(c.dep);
  });
  const text = header + '\n\n' + (cards.length ? cards.join('\n\n') : 'Кампаний с трафиком сегодня нет.');
  return {text: text, keyboard: keitaroKeyboard_('campaigns'),
    list: list.map(function (c) { return {id: c.id, name: c.name}; })};
}

function keitaroFlowsView_(campaign) {
  const streams = getCampaignFlowView_(campaign.id);
  const header = '🔀 <b>' + escapeHtml_(telegramTrim_(campaign.name, 34)) + '</b> · потоки';
  const cards = streams.map(function (s, i) {
    const active = String(s.status || '').toUpperCase() === 'ACTIVE';
    return '<b>' + (i + 1) + '.</b> ' + (active ? '🟢' : '🔴') + ' ' +
      escapeHtml_(telegramTrim_(s.name, 30)) + ' · офферов ' + (s.offers ? s.offers.length : 0);
  });
  const text = header + '\n\n' + (cards.length ? cards.join('\n\n') : 'Потоков не найдено.');
  return {text: text, keyboard: keitaroKeyboard_('flows'),
    list: streams.map(function (s) { return {id: s.id, name: s.name}; })};
}

function keitaroOffersView_(campaign, flow) {
  const streams = getCampaignFlowView_(campaign.id);
  let s = null;
  streams.forEach(function (x) { if (String(x.id) === String(flow.id)) s = x; });
  const header = '🎯 <b>' + escapeHtml_(telegramTrim_(flow.name, 34)) + '</b> · офферы';
  const offers = (s && s.offers) || [];
  const cards = offers.map(function (o, i) {
    return '<b>' + (i + 1) + '.</b> ' + escapeHtml_(telegramTrim_(o.name || ('Offer #' + o.id), 34)) +
      ' — <b>' + Math.round(num_(o.weight)) + '%</b>';
  });
  const text = header + '\n\n' + (cards.length ? cards.join('\n') : 'Офферов в потоке нет.');
  return {text: text, keyboard: keitaroKeyboard_('offers'),
    list: offers.map(function (o) { return {id: o.id, name: o.name, weight: num_(o.weight)}; })};
}

/* ===================== Entry & rebuild ===================== */

function keitaroOpen_(chatId) {
  const view = keitaroCampaignsView_();
  const state = {level: 'campaigns', messageId: null, list: view.list,
    campaign: null, flow: null, pending: null, promptMessageId: null};
  const sent = telegramSend_(chatId, view.text, view.keyboard);
  if (sent && sent.result) state.messageId = sent.result.message_id;
  keitaroSaveNav_(chatId, state);
}

function keitaroCurrentView_(state) {
  if (state.level === 'campaigns') return keitaroCampaignsView_();
  if (state.level === 'flows' && state.campaign) return keitaroFlowsView_(state.campaign);
  if (state.level === 'offers' && state.campaign && state.flow) return keitaroOffersView_(state.campaign, state.flow);
  return null;
}

function keitaroRerender_(chatId, state) {
  const view = keitaroCurrentView_(state);
  if (!view) return;
  state.list = view.list;
  keitaroRender_(chatId, state, view.text, view.keyboard);
}

/* ===================== Callbacks ===================== */

function keitaroCallback_(chatId, action, context) {
  const state = keitaroLoadNav_(chatId);
  if (context && context.messageId && !state.messageId) state.messageId = context.messageId;

  if (action === 'menu') { keitaroClearNav_(chatId); telegramSend_(chatId, '🏠 Главное меню', telegramMenu_()); return; }
  if (action === 'back') { keitaroBack_(chatId, state); return; }
  if (action === 'confirm') { keitaroConfirm_(chatId, state); return; }
  if (action === 'cancel') { keitaroCancel_(chatId, state); return; }
  if (action === 'ins') {
    const word = state.level === 'campaigns' ? 'кампании' : 'потока';
    keitaroPrompt_(chatId, state, {action: 'inspect'}, 'Введите номер ' + word + ':');
    return;
  }
  if (action === 'pct') { keitaroStartPercent_(chatId, state); return; }
}

function keitaroPrompt_(chatId, state, pending, text) {
  state.pending = pending;
  const sent = telegramSend_(chatId, '✍️ ' + text);
  state.promptMessageId = sent && sent.result ? sent.result.message_id : null;
  keitaroSaveNav_(chatId, state);
}

function keitaroStartPercent_(chatId, state) {
  if (state.level !== 'offers' || !(state.list || []).length) {
    telegramSend_(chatId, 'Проценты меняются на уровне офферов потока.'); return;
  }
  keitaroPrompt_(chatId, state, {action: 'pct', step: 'pick'},
    'Введите номер оффера, у которого меняем %:');
}

function keitaroBack_(chatId, state) {
  state.pending = null;
  if (state.level === 'offers') { state.level = 'flows'; state.flow = null; }
  else if (state.level === 'flows') { state.level = 'campaigns'; state.campaign = null; }
  else { keitaroClearNav_(chatId); telegramSend_(chatId, '🏠 Главное меню', telegramMenu_()); return; }
  keitaroRerender_(chatId, state);
  keitaroSaveNav_(chatId, state);
}

/* ===================== Typed input ===================== */

function keitaroHandlePendingInput_(chatId, text) {
  const state = keitaroLoadNav_(chatId);
  const p = state && state.pending;
  if (!p) return false;
  const list = state.list || [];

  if (p.action === 'inspect') {
    const n = Number(String(text).trim());
    if (!Number.isInteger(n) || n < 1 || n > list.length) {
      telegramSend_(chatId, '⚠️ Нужен номер от 1 до ' + list.length + '.'); return true;
    }
    telegramDelete_(chatId, state.promptMessageId); state.promptMessageId = null; state.pending = null;
    const chosen = list[n - 1];
    if (state.level === 'campaigns') { state.campaign = {id: chosen.id, name: chosen.name}; state.level = 'flows'; }
    else if (state.level === 'flows') { state.flow = {id: chosen.id, name: chosen.name}; state.level = 'offers'; }
    else { return true; }
    keitaroRerender_(chatId, state); keitaroSaveNav_(chatId, state); return true;
  }

  if (p.action === 'pct' && p.step === 'pick') {
    const n = Number(String(text).trim());
    if (!Number.isInteger(n) || n < 1 || n > list.length) {
      telegramSend_(chatId, '⚠️ Нужен номер от 1 до ' + list.length + '.'); return true;
    }
    telegramDelete_(chatId, state.promptMessageId);
    const chosen = list[n - 1];
    state.pending = {action: 'pct', step: 'value', id: chosen.id, name: chosen.name, current: num_(chosen.weight)};
    const sent = telegramSend_(chatId, '✍️ Новый % для <b>' + escapeHtml_(chosen.name) +
      '</b> (сейчас ' + Math.round(num_(chosen.weight)) + '%):');
    state.promptMessageId = sent && sent.result ? sent.result.message_id : null;
    keitaroSaveNav_(chatId, state); return true;
  }

  if (p.action === 'pct' && p.step === 'value') {
    const value = Number(String(text).replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      telegramSend_(chatId, '⚠️ Введите % числом от 0 до 100.'); return true;
    }
    telegramDelete_(chatId, state.promptMessageId); state.promptMessageId = null;
    state.pending = {action: 'apply', id: p.id, name: p.name, current: p.current, value: value};
    const sent = telegramSend_(chatId, 'Сменить % оффера <b>' + escapeHtml_(p.name) + '</b>: ' +
      Math.round(p.current) + '% → <b>' + Math.round(value) + '%</b>?', manageConfirmKeyboard_());
    state.promptMessageId = sent && sent.result ? sent.result.message_id : null;
    keitaroSaveNav_(chatId, state); return true;
  }
  return false;
}

/* ===================== Confirm & apply ===================== */

function keitaroCancel_(chatId, state) {
  telegramDelete_(chatId, state.promptMessageId); state.promptMessageId = null; state.pending = null;
  keitaroSaveNav_(chatId, state);
  telegramSend_(chatId, '❌ Отменено.');
}

function keitaroConfirm_(chatId, state) {
  const p = state.pending;
  telegramDelete_(chatId, state.promptMessageId); state.promptMessageId = null;
  if (!p || p.action !== 'apply') { state.pending = null; keitaroSaveNav_(chatId, state); return; }
  const status = telegramSend_(chatId, '⏳ Отправляю в Keitaro…');
  const statusId = status && status.result ? status.result.message_id : null;
  let result;
  try { result = keitaroApplyPercent_(state, p); }
  catch (error) { result = {ok: false, message: String(error && error.message || error)}; }
  const text = result.ok ? '✅ ' + escapeHtml_(result.message || 'Готово.')
    : '⚠️ Не удалось: ' + escapeHtml_(result.message || 'ошибка');
  if (statusId) { try { telegramEditInline_(chatId, statusId, text, null); } catch (_) { telegramSend_(chatId, text); } }
  else telegramSend_(chatId, text);
  state.pending = null;
  keitaroRerender_(chatId, state);
  keitaroSaveNav_(chatId, state);
}

/**
 * Writes an offer's percent back to Keitaro. Live traffic change, so it stays
 * stubbed until explicitly enabled on a safe target.
 */
function keitaroApplyPercent_(state, pending) {
  if (!getCrmEnv_().devEndpoint) throw new Error('Управление доступно только в песочнице');
  return {ok: false,
    message: 'запись процентов в Keitaro ещё не подключена (нужно подтверждение и проверка на безопасной кампании). Ничего не изменено.'};
}
