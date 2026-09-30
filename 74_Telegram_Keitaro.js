/**
 * Keitaro drill-down for Telegram: Кампании → Потоки → Офферы (с %).
 *
 * Tap-driven: campaigns and flows are buttons (one tap to drill). Offer split is
 * edited for the whole flow at once — the user sends "1-20 2-80" (offer number →
 * percent), which must sum to 100, then confirms. Viewing is live; writing the
 * new split to Keitaro is a real traffic change, so it stays stubbed until the
 * stream-update endpoint is confirmed on a safe campaign.
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

/** Buttons for list items (1..count) in rows of 4, callback prefix+index. */
function keitaroItemButtons_(count, prefix) {
  const rows = [];
  let row = [];
  for (let i = 0; i < count; i++) {
    row.push({text: String(i + 1), callback_data: prefix + i});
    if (row.length === 4) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  return rows;
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
    .sort(function (a, b) { return b.inst - a.inst; }).slice(0, 30);
  const header = TELEGRAM_ICON_KEITARO + ' <b>Кейтаро · ' +
    escapeHtml_(formatTelegramDate_(getToday_())) + '</b>\nВыбери кампанию (I - R - D):';
  const cards = list.map(function (c, i) {
    return '<b>' + (i + 1) + '.</b> ' + escapeHtml_(telegramTrim_(c.name, 30)) +
      '\n' + Math.round(c.inst) + ' - ' + Math.round(c.reg) + ' - ' + Math.round(c.dep);
  });
  const text = header + '\n\n' + (cards.length ? cards.join('\n\n') : 'Кампаний с трафиком сегодня нет.');
  const rows = keitaroItemButtons_(list.length, 'kt:c:');
  rows.push([{text: '🏠 Меню', callback_data: 'kt:menu'}]);
  return {text: text, keyboard: {inline_keyboard: rows},
    list: list.map(function (c) { return {id: c.id, name: c.name}; })};
}

function keitaroFlowsView_(campaign) {
  const streams = getCampaignFlowView_(campaign.id);
  const header = '🔀 <b>' + escapeHtml_(telegramTrim_(campaign.name, 34)) + '</b> · потоки\nВыбери поток:';
  const cards = streams.map(function (s, i) {
    const active = String(s.status || '').toUpperCase() === 'ACTIVE';
    return '<b>' + (i + 1) + '.</b> ' + (active ? '🟢' : '🔴') + ' ' +
      escapeHtml_(telegramTrim_(s.name, 30)) + ' · офферов ' + (s.offers ? s.offers.length : 0);
  });
  const text = header + '\n\n' + (cards.length ? cards.join('\n\n') : 'Потоков не найдено.');
  const rows = keitaroItemButtons_(streams.length, 'kt:f:');
  rows.push([{text: '⬅️ Назад', callback_data: 'kt:back'}, {text: '🏠 Меню', callback_data: 'kt:menu'}]);
  return {text: text, keyboard: {inline_keyboard: rows},
    list: streams.map(function (s) { return {id: s.id, name: s.name}; })};
}

function keitaroOffersView_(campaign, flow) {
  const streams = getCampaignFlowView_(campaign.id);
  let s = null;
  streams.forEach(function (x) { if (String(x.id) === String(flow.id)) s = x; });
  const offers = (s && s.offers) || [];
  const header = '🎯 <b>' + escapeHtml_(telegramTrim_(flow.name, 34)) + '</b> · офферы';
  const cards = offers.map(function (o, i) {
    return '<b>' + (i + 1) + '.</b> <code>' + escapeHtml_(String(o.id || '—')) + '</code> ' +
      escapeHtml_(telegramTrim_(o.name || ('Offer #' + o.id), 30)) +
      ' — <b>' + Math.round(num_(o.weight)) + '%</b>';
  });
  const text = header + '\n\n' + (cards.length ? cards.join('\n') : 'Офферов в потоке нет.');
  const rows = [];
  if (offers.length) rows.push([{text: '✏️ Изменить %', callback_data: 'kt:pct'}]);
  rows.push([{text: '⬅️ Назад', callback_data: 'kt:back'}, {text: '🏠 Меню', callback_data: 'kt:menu'}]);
  return {text: text, keyboard: {inline_keyboard: rows},
    list: offers.map(function (o) { return {id: String(o.id || ''), name: o.name, weight: num_(o.weight)}; })};
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
  if (action === 'pct') { keitaroAskPercent_(chatId, state); return; }

  const parts = action.split(':');
  if (parts[0] === 'c') return keitaroPickCampaign_(chatId, state, Number(parts[1]));
  if (parts[0] === 'f') return keitaroPickFlow_(chatId, state, Number(parts[1]));
}

function keitaroPickCampaign_(chatId, state, index) {
  const list = state.list || [];
  if (!(index >= 0 && index < list.length)) return;
  state.campaign = {id: list[index].id, name: list[index].name};
  state.level = 'flows'; state.pending = null;
  keitaroRerender_(chatId, state); keitaroSaveNav_(chatId, state);
}

function keitaroPickFlow_(chatId, state, index) {
  const list = state.list || [];
  if (!state.campaign || !(index >= 0 && index < list.length)) return;
  state.flow = {id: list[index].id, name: list[index].name};
  state.level = 'offers'; state.pending = null;
  keitaroRerender_(chatId, state); keitaroSaveNav_(chatId, state);
}

function keitaroBack_(chatId, state) {
  state.pending = null;
  if (state.level === 'offers') { state.level = 'flows'; state.flow = null; }
  else if (state.level === 'flows') { state.level = 'campaigns'; state.campaign = null; }
  else { keitaroClearNav_(chatId); telegramSend_(chatId, '🏠 Главное меню', telegramMenu_()); return; }
  keitaroRerender_(chatId, state);
  keitaroSaveNav_(chatId, state);
}

function keitaroAskPercent_(chatId, state) {
  const list = state.list || [];
  if (state.level !== 'offers' || !list.length) { telegramSend_(chatId, 'Проценты меняются на уровне офферов.'); return; }
  const current = list.map(function (o, i) {
    return (i + 1) + ' → ' + Math.round(num_(o.weight)) + '%';
  }).join(', ');
  state.pending = {action: 'pct'};
  const sent = telegramSend_(chatId,
    '✍️ Отправь новые проценты по офферам в формате <b>номер-процент</b> через пробел.\n' +
    'Например: <code>1-20 2-80</code>\nСумма должна быть 100. Сейчас: ' + current);
  state.promptMessageId = sent && sent.result ? sent.result.message_id : null;
  keitaroSaveNav_(chatId, state);
}

/* ===================== Typed input ===================== */

function keitaroHandlePendingInput_(chatId, text) {
  const state = keitaroLoadNav_(chatId);
  const p = state && state.pending;
  if (!p) return false;
  const list = state.list || [];

  if (p.action === 'pct') {
    const pairs = {};
    const re = /(\d+)\s*-\s*(\d+)/g;
    let m;
    while ((m = re.exec(String(text))) !== null) { pairs[Number(m[1])] = Number(m[2]); }
    const keys = Object.keys(pairs).map(Number);
    if (!keys.length) { telegramSend_(chatId, '⚠️ Формат: 1-20 2-80 (номер-процент через пробел).'); return true; }
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] < 1 || keys[i] > list.length) { telegramSend_(chatId, '⚠️ Есть номер вне диапазона 1..' + list.length + '.'); return true; }
    }
    if (keys.length !== list.length) {
      telegramSend_(chatId, '⚠️ Укажи проценты для всех ' + list.length + ' офферов.'); return true;
    }
    const sum = keys.reduce(function (s, k) { return s + pairs[k]; }, 0);
    if (sum !== 100) { telegramSend_(chatId, '⚠️ Сумма процентов = ' + sum + ', нужно 100.'); return true; }
    telegramDelete_(chatId, state.promptMessageId); state.promptMessageId = null;
    const targets = keys.sort(function (a, b) { return a - b; }).map(function (k) {
      return {id: list[k - 1].id, name: list[k - 1].name, from: Math.round(num_(list[k - 1].weight)), to: pairs[k]};
    });
    state.pending = {action: 'apply', targets: targets};
    const summary = targets.map(function (t) {
      return '• ' + escapeHtml_(telegramTrim_(t.name, 24)) + ': ' + t.from + '% → <b>' + t.to + '%</b>';
    }).join('\n');
    const sent = telegramSend_(chatId, 'Применить распределение?\n' + summary, manageConfirmKeyboard_());
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
 * Writes the new offer split to Keitaro (live traffic change). Stubbed until the
 * stream-update endpoint is verified and enabled on a safe campaign.
 */
function keitaroApplyPercent_(state, pending) {
  if (!getCrmEnv_().devEndpoint) throw new Error('Управление доступно только в песочнице');
  return {ok: false,
    message: 'запись процентов в Keitaro ещё не подключена (нужен эндпоинт обновления потока и проверка на безопасной кампании). Ничего не изменено.'};
}
