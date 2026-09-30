/**
 * Meta management panel for Telegram: Кампании → Адсеты → Объявления.
 *
 * Tap-driven: every list item is a button, so navigation is one tap and only a
 * budget amount is ever typed. One browsing message is edited in place as you
 * drill in and back out; changes (budget, on/off) happen in a separate message
 * with a confirm step so the structure stays visible behind them.
 *
 * Phase 1: browsing + the confirm flow are live; the actual Meta write is
 * stubbed until the Dolphin write API and a safe test target are confirmed.
 */

function manageNavKey_(chatId) { return 'TELEGRAM_NAV_' + String(chatId); }

function manageLoadNav_(chatId) {
  try {
    return JSON.parse(PropertiesService.getScriptProperties()
      .getProperty(manageNavKey_(chatId)) || '{}');
  } catch (_) { return {}; }
}

function manageSaveNav_(chatId, state) {
  PropertiesService.getScriptProperties()
    .setProperty(manageNavKey_(chatId), JSON.stringify(state));
}

function manageClearNav_(chatId) {
  PropertiesService.getScriptProperties().deleteProperty(manageNavKey_(chatId));
}

function telegramDelete_(chatId, messageId) {
  if (!messageId) return;
  try {
    telegramApi_('deleteMessage', {chat_id: String(chatId), message_id: Number(messageId)});
  } catch (_) {}
}

function telegramEditInline_(chatId, messageId, text, inlineKeyboard) {
  return telegramApi_('editMessageText', {
    chat_id: String(chatId), message_id: Number(messageId),
    text: text, parse_mode: 'HTML',
    reply_markup: inlineKeyboard || {inline_keyboard: []}
  });
}

/** Edits the browsing message if we have one, else sends a new one and stores its id. */
function manageRender_(chatId, state, text, keyboard) {
  if (state.messageId) {
    try { telegramEditInline_(chatId, state.messageId, text, keyboard); return; } catch (_) {}
  }
  const sent = telegramSend_(chatId, text, keyboard);
  if (sent && sent.result) state.messageId = sent.result.message_id;
}

function manageDot_(active) { return active ? '🟢' : '🔴'; }

/* ===================== Entry ===================== */

function manageOpenCampaigns_(chatId) {
  const state = {level: 'campaigns', messageId: null};
  const view = manageCampaignsView_();
  const sent = telegramSend_(chatId, view.text, view.keyboard);
  if (sent && sent.result) state.messageId = sent.result.message_id;
  state.campaignsList = view.list;
  manageSaveNav_(chatId, state);
}

/* ===================== Views ===================== */

function manageCampaignsView_() {
  const cs = readTodayCampaignState_();
  const list = cs.list.slice().sort(function (a, b) { return b.spend - a.spend; }).slice(0, 40);
  const rows = list.map(function (c, i) {
    const mark = adHealthMark_(c.activeAds, c.errorAds, c.warningAds);
    return [{text: (i + 1) + '. ' + manageDot_(c.status === 'ACTIVE') + mark + ' ' +
      telegramTrim_(c.name || c.id, 30), callback_data: 'mng:c:' + i}];
  });
  rows.push([{text: '🏠 Меню', callback_data: 'mng:menu'}]);
  const text = TELEGRAM_ICON_META + ' <b>Компании · ' +
    escapeHtml_(formatTelegramDate_(getToday_())) + '</b>\n' +
    (list.length ? 'Выбери кампанию:' : 'Запущенных кампаний сейчас нет.');
  return {text: text, keyboard: {inline_keyboard: rows},
    list: list.map(function (c) {
      return {id: c.id, name: c.name, cbo: c.budget > 0};
    })};
}

function manageCampaignCardView_(campaignId) {
  const cs = readTodayCampaignState_();
  let c = null;
  cs.list.forEach(function (x) { if (x.id === campaignId) c = x; });
  if (!c) return null;
  const kt = readTodayKeitaroByCampaign_().byId[campaignId] || {inst: 0, reg: 0, dep: 0, rev: 0};
  const on = c.status === 'ACTIVE';
  const mark = adHealthMark_(c.activeAds, c.errorAds, c.warningAds);
  const lines = [manageDot_(on) + mark + ' <b>' + escapeHtml_(c.name) + '</b>',
    '💰' + num_(c.budget).toFixed(0) + '$ 💸' + Math.round(c.spend) + '$ 🤑' + Math.round(kt.rev) + '$',
    manageFunnelLine_(kt, c.spend),
    'Объявления: ' + Math.round(c.activeAds) + ' актив · ' +
      Math.round(c.errorAds) + ' ошибка · ' + Math.round(c.warningAds) + ' предупр.'];
  const budgetRow = [];
  if (c.budget > 0) budgetRow.push({text: '💰 Бюджет', callback_data: 'mng:budget'});
  budgetRow.push({text: on ? '🔴 Выключить' : '🟢 Включить', callback_data: 'mng:toggle'});
  const keyboard = {inline_keyboard: [
    [{text: '📂 Адсеты', callback_data: 'mng:adsets'}],
    budgetRow,
    [{text: '⬅️ Назад', callback_data: 'mng:back'}, {text: '🏠 Меню', callback_data: 'mng:menu'}]
  ]};
  return {text: lines.join('\n'), keyboard: keyboard,
    campaign: {id: c.id, name: c.name, cbo: c.budget > 0, budget: c.budget, on: on}};
}

function manageFunnelLine_(m, spend) {
  function unit(count) {
    const per = count > 0 && spend > 0 ? '/' + safeDiv_(spend, count).toFixed(2) + '$' : '';
    return Math.round(count) + per;
  }
  const roi = spend > 0 ? Math.round((m.rev - spend) / spend * 100) + '%' : '—';
  return unit(m.inst) + ' - ' + unit(m.reg) + ' - ' + unit(m.dep) + ' (' + roi + ')';
}

function manageAdsetsView_(campaign) {
  const adsets = getCampaignAdsets_(campaign.id);
  const rows = adsets.map(function (a, i) {
    const active = String(a.effective_status || a.status || '').toUpperCase() === 'ACTIVE';
    const mark = adHealthMark_(a.active_status_ads_count, a.error_status_ads_count, a.warning_status_ads_count);
    return [{text: (i + 1) + '. ' + manageDot_(active) + mark + ' ' +
      telegramTrim_(a.name || a.adset_id, 28), callback_data: 'mng:a:' + i}];
  });
  rows.push([{text: '⬅️ Назад', callback_data: 'mng:back'}, {text: '🏠 Меню', callback_data: 'mng:menu'}]);
  const text = '📂 <b>' + escapeHtml_(telegramTrim_(campaign.name, 40)) + '</b> · адсеты\n' +
    (adsets.length ? 'Выбери адсет:' : 'Адсетов не найдено.');
  return {text: text, keyboard: {inline_keyboard: rows},
    list: adsets.map(function (a) {
      return {id: String(a.adset_id || a.id || ''), name: String(a.name || ''),
        budget: getCampaignDailyBudget_(a)};
    })};
}

function manageAdsetCardView_(campaign, adsetId) {
  const adsets = getCampaignAdsets_(campaign.id);
  let a = null;
  adsets.forEach(function (x) { if (String(x.adset_id || x.id || '') === adsetId) a = x; });
  if (!a) return null;
  const active = String(a.effective_status || a.status || '').toUpperCase() === 'ACTIVE';
  const mark = adHealthMark_(a.active_status_ads_count, a.error_status_ads_count, a.warning_status_ads_count);
  const budget = getCampaignDailyBudget_(a);
  const lines = [manageDot_(active) + mark + ' <b>' + escapeHtml_(a.name || adsetId) + '</b>',
    'Статус: ' + escapeHtml_(String(a.effective_status || a.status || '—')),
    '💸' + Math.round(getCampaignSpend_(a)) + '$' + (budget > 0 ? ' · 💰' + num_(budget).toFixed(0) + '$' : ''),
    'Объявления: ' + Math.round(num_(a.active_status_ads_count)) + ' актив · ' +
      Math.round(num_(a.error_status_ads_count)) + ' ошибка · ' +
      Math.round(num_(a.warning_status_ads_count)) + ' предупр.'];
  const actionRow = [];
  if (budget > 0) actionRow.push({text: '💰 Бюджет', callback_data: 'mng:budget'});
  actionRow.push({text: active ? '🔴 Выключить' : '🟢 Включить', callback_data: 'mng:toggle'});
  const keyboard = {inline_keyboard: [
    [{text: '🖼 Объявления', callback_data: 'mng:ads'}],
    actionRow,
    [{text: '⬅️ Назад', callback_data: 'mng:back'}, {text: '🏠 Меню', callback_data: 'mng:menu'}]
  ]};
  return {text: lines.join('\n'), keyboard: keyboard,
    adset: {id: adsetId, name: String(a.name || ''), budget: budget, on: active}};
}

function manageAdsView_(adset) {
  const ads = getAdsetAds_(adset.id);
  const rows = ads.map(function (a, i) {
    const active = String(a.effective_status || a.status || '').toUpperCase() === 'ACTIVE';
    return [{text: (i + 1) + '. ' + manageDot_(active) + manageAdUnitMark_(a) + ' ' +
      telegramTrim_(a.name || a.ad_id, 28), callback_data: 'mng:d:' + i}];
  });
  rows.push([{text: '⬅️ Назад', callback_data: 'mng:back'}, {text: '🏠 Меню', callback_data: 'mng:menu'}]);
  const text = '🖼 <b>' + escapeHtml_(telegramTrim_(adset.name, 40)) + '</b> · объявления\n' +
    (ads.length ? 'Выбери объявление:' : 'Объявлений не найдено.');
  return {text: text, keyboard: {inline_keyboard: rows},
    list: ads.map(function (a) { return {id: String(a.ad_id || a.id || ''), name: String(a.name || '')}; })};
}

function manageAdCardView_(adset, adId) {
  const ads = getAdsetAds_(adset.id);
  let a = null;
  ads.forEach(function (x) { if (String(x.ad_id || x.id || '') === adId) a = x; });
  if (!a) return null;
  const active = String(a.effective_status || a.status || '').toUpperCase() === 'ACTIVE';
  const lines = [manageDot_(active) + manageAdUnitMark_(a) + ' <b>' + escapeHtml_(a.name || adId) + '</b>',
    'Статус: ' + escapeHtml_(String(a.effective_status || a.status || '—'))];
  const reason = String(a.disapprove_reason || a.disapprove_comment || '').trim();
  if (reason) lines.push('⛔ ' + escapeHtml_(telegramTrim_(reason, 120)));
  const keyboard = {inline_keyboard: [
    [{text: active ? '🔴 Выключить' : '🟢 Включить', callback_data: 'mng:toggle'}],
    [{text: '⬅️ Назад', callback_data: 'mng:back'}, {text: '🏠 Меню', callback_data: 'mng:menu'}]
  ]};
  return {text: lines.join('\n'), keyboard: keyboard, ad: {id: adId, name: String(a.name || ''), on: active}};
}

function manageAdUnitMark_(unit) {
  const es = String(unit.effective_status || '').toUpperCase();
  if (unit.disapprove_reason || es.indexOf('DISAPPROV') >= 0 ||
      es.indexOf('REJECT') >= 0 || es === 'WITH_ISSUES') return '❗';
  if (es.indexOf('PENDING') >= 0 || es.indexOf('REVIEW') >= 0 || es.indexOf('IN_PROCESS') >= 0) return '⚠️';
  return '';
}

/* ===================== Callbacks ===================== */

function manageCallback_(chatId, action, context) {
  const state = manageLoadNav_(chatId);
  if (context && context.messageId && !state.messageId) state.messageId = context.messageId;

  if (action === 'menu') {
    manageClearNav_(chatId);
    telegramSend_(chatId, '🏠 Главное меню', telegramMenu_());
    return;
  }
  if (action === 'back') { manageBack_(chatId, state); return; }
  if (action === 'confirm') { manageConfirm_(chatId, state); return; }
  if (action === 'cancel') { manageCancel_(chatId, state); return; }
  if (action === 'budget') { manageAskBudget_(chatId, state); return; }
  if (action === 'toggle') { manageAskToggle_(chatId, state); return; }

  // Navigation into a list item: c:i / a:i / d:i
  const parts = action.split(':');
  if (parts[0] === 'c') return manageOpenCampaignCard_(chatId, state, Number(parts[1]));
  if (parts[0] === 'a') return manageOpenAdsetCard_(chatId, state, Number(parts[1]));
  if (parts[0] === 'd') return manageOpenAdCard_(chatId, state, Number(parts[1]));
  if (action === 'adsets') return manageOpenAdsets_(chatId, state);
  if (action === 'ads') return manageOpenAds_(chatId, state);
}

function manageOpenCampaignCard_(chatId, state, index) {
  const list = state.campaignsList || [];
  if (!(index >= 0 && index < list.length)) return;
  const view = manageCampaignCardView_(list[index].id);
  if (!view) { telegramSend_(chatId, 'Кампания больше не доступна, обнови список.'); return; }
  state.level = 'campaign';
  state.campaign = view.campaign;
  manageRender_(chatId, state, view.text, view.keyboard);
  manageSaveNav_(chatId, state);
}

function manageOpenAdsets_(chatId, state) {
  if (!state.campaign) return;
  const view = manageAdsetsView_(state.campaign);
  state.level = 'adsets';
  state.adsetsList = view.list;
  manageRender_(chatId, state, view.text, view.keyboard);
  manageSaveNav_(chatId, state);
}

function manageOpenAdsetCard_(chatId, state, index) {
  const list = state.adsetsList || [];
  if (!state.campaign || !(index >= 0 && index < list.length)) return;
  const view = manageAdsetCardView_(state.campaign, list[index].id);
  if (!view) { telegramSend_(chatId, 'Адсет больше не доступен, обнови список.'); return; }
  state.level = 'adset';
  state.adset = view.adset;
  manageRender_(chatId, state, view.text, view.keyboard);
  manageSaveNav_(chatId, state);
}

function manageOpenAds_(chatId, state) {
  if (!state.adset) return;
  const view = manageAdsView_(state.adset);
  state.level = 'ads';
  state.adsList = view.list;
  manageRender_(chatId, state, view.text, view.keyboard);
  manageSaveNav_(chatId, state);
}

function manageOpenAdCard_(chatId, state, index) {
  const list = state.adsList || [];
  if (!state.adset || !(index >= 0 && index < list.length)) return;
  const view = manageAdCardView_(state.adset, list[index].id);
  if (!view) { telegramSend_(chatId, 'Объявление больше не доступно, обнови список.'); return; }
  state.level = 'ad';
  state.ad = view.ad;
  manageRender_(chatId, state, view.text, view.keyboard);
  manageSaveNav_(chatId, state);
}

function manageBack_(chatId, state) {
  const go = {campaign: 'campaigns', adsets: 'campaign', adset: 'adsets', ads: 'adset', ad: 'ads'};
  const target = go[state.level] || 'menu';
  if (target === 'campaigns') {
    const view = manageCampaignsView_();
    state.level = 'campaigns'; state.campaignsList = view.list;
    manageRender_(chatId, state, view.text, view.keyboard);
  } else if (target === 'campaign' && state.campaign) {
    const view = manageCampaignCardView_(state.campaign.id);
    state.level = 'campaign';
    manageRender_(chatId, state, view.text, view.keyboard);
  } else if (target === 'adsets' && state.campaign) {
    const view = manageAdsetsView_(state.campaign);
    state.level = 'adsets'; state.adsetsList = view.list;
    manageRender_(chatId, state, view.text, view.keyboard);
  } else if (target === 'adset' && state.adset) {
    const view = manageAdsetCardView_(state.campaign, state.adset.id);
    state.level = 'adset';
    manageRender_(chatId, state, view.text, view.keyboard);
  } else {
    manageClearNav_(chatId);
    telegramSend_(chatId, '🏠 Главное меню', telegramMenu_());
    return;
  }
  manageSaveNav_(chatId, state);
}

/* ===================== Changes (budget / on-off) ===================== */

function manageCurrentUnit_(state) {
  if (state.level === 'campaign' && state.campaign) {
    return {kind: 'campaign', id: state.campaign.id, name: state.campaign.name,
      on: state.campaign.on, budget: state.campaign.budget};
  }
  if (state.level === 'adset' && state.adset) {
    return {kind: 'adset', id: state.adset.id, name: state.adset.name,
      on: state.adset.on, budget: state.adset.budget};
  }
  if (state.level === 'ad' && state.ad) {
    return {kind: 'ad', id: state.ad.id, name: state.ad.name, on: state.ad.on};
  }
  return null;
}

function manageAskBudget_(chatId, state) {
  const unit = manageCurrentUnit_(state);
  if (!unit || unit.kind === 'ad') { telegramSend_(chatId, 'Здесь бюджет не меняется.'); return; }
  state.pending = {type: 'budget', kind: unit.kind, id: unit.id, name: unit.name, current: unit.budget};
  const sent = telegramSend_(chatId, '✍️ Введите новый дневной бюджет в $ для <b>' +
    escapeHtml_(unit.name) + '</b> (сейчас ' + num_(unit.budget).toFixed(0) + '$):');
  state.promptMessageId = sent && sent.result ? sent.result.message_id : null;
  manageSaveNav_(chatId, state);
}

function manageAskToggle_(chatId, state) {
  const unit = manageCurrentUnit_(state);
  if (!unit) { telegramSend_(chatId, 'Нечего переключать.'); return; }
  const turnOn = !unit.on;
  state.pending = {type: 'toggle', kind: unit.kind, id: unit.id, name: unit.name, turnOn: turnOn};
  const sent = telegramSend_(chatId, (turnOn ? '🟢 Включить' : '🔴 Выключить') + ' <b>' +
    escapeHtml_(unit.name) + '</b>?', manageConfirmKeyboard_());
  state.promptMessageId = sent && sent.result ? sent.result.message_id : null;
  manageSaveNav_(chatId, state);
}

function manageConfirmKeyboard_() {
  return {inline_keyboard: [[
    {text: '✅ Подтвердить', callback_data: 'mng:confirm'},
    {text: '❌ Отменить', callback_data: 'mng:cancel'}
  ]]};
}

/** Returns true when a typed budget value was consumed. */
function manageHandlePendingInput_(chatId, text) {
  const state = manageLoadNav_(chatId);
  if (!state || !state.pending || state.pending.type !== 'budget') return false;
  const value = Number(String(text).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(value) || value <= 0) {
    telegramSend_(chatId, '⚠️ Введите бюджет числом, например 25.');
    return true;
  }
  telegramDelete_(chatId, state.promptMessageId);
  state.promptMessageId = null;
  state.pending.value = value;
  const sent = telegramSend_(chatId, 'Сменить дневной бюджет <b>' + escapeHtml_(state.pending.name) +
    '</b>: ' + num_(state.pending.current).toFixed(0) + '$ → <b>' + value.toFixed(0) + '$</b>?',
    manageConfirmKeyboard_());
  state.promptMessageId = sent && sent.result ? sent.result.message_id : null;
  manageSaveNav_(chatId, state);
  return true;
}

function manageCancel_(chatId, state) {
  telegramDelete_(chatId, state.promptMessageId);
  state.promptMessageId = null;
  state.pending = null;
  manageSaveNav_(chatId, state);
  telegramSend_(chatId, '❌ Отменено.');
}

function manageConfirm_(chatId, state) {
  const pending = state.pending;
  telegramDelete_(chatId, state.promptMessageId);
  state.promptMessageId = null;
  if (!pending) { manageSaveNav_(chatId, state); return; }

  const status = telegramSend_(chatId, '⏳ Отправляю запрос в Meta…');
  const statusId = status && status.result ? status.result.message_id : null;
  let result;
  try {
    result = manageApplyChange_(pending);
  } catch (error) {
    result = {ok: false, message: String(error && error.message || error)};
  }
  const text = result.ok
    ? '✅ ' + escapeHtml_(result.message || 'Готово.')
    : '⚠️ Не удалось: ' + escapeHtml_(result.message || 'ошибка') +
      (result.retryable ? '\nПопробуй ещё раз позже.' : '');
  if (statusId) { try { telegramEditInline_(chatId, statusId, text, null); } catch (_) { telegramSend_(chatId, text); } }
  else telegramSend_(chatId, text);

  state.pending = null;
  manageSaveNav_(chatId, state);
}

/**
 * Applies a confirmed change. Phase 2 will call the Dolphin write API here;
 * until it is confirmed, nothing is sent to Meta and the user is told so.
 */
function manageApplyChange_(pending) {
  if (!getCrmEnv_().devEndpoint) throw new Error('Управление доступно только в песочнице');
  return {ok: false, retryable: false,
    message: 'запись в Meta ещё не подключена (нужен доступ к Dolphin write API). Ничего не изменено.'};
}
