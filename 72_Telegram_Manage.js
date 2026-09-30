/**
 * Meta management panel for Telegram: Кампании → Адсеты → Объявления.
 *
 * Each level shows a numbered stat list (so you can decide) with a small fixed
 * set of action buttons — this scales to many campaigns. "Осмотреть" / "Бюджет"
 * / "Вкл-Выкл" ask for a number in a SEPARATE message; the list message stays
 * put and is edited in place as you drill in and back out. Changes go through a
 * confirm step; the actual Meta write is stubbed until the Dolphin write API
 * and a safe test target are confirmed.
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

/** Edits the browsing (list) message in place, or sends it the first time. */
function manageRender_(chatId, state, text, keyboard) {
  if (state.messageId) {
    try { telegramEditInline_(chatId, state.messageId, text, keyboard); return; } catch (_) {}
  }
  const sent = telegramSend_(chatId, text, keyboard);
  if (sent && sent.result) state.messageId = sent.result.message_id;
}

function manageDot_(active) { return active ? '🟢' : '🔴'; }

function manageRoi_(rev, spend) {
  return spend > 0 ? Math.round((num_(rev) - spend) / spend * 100) + '%' : '—';
}

function manageFunnel_(m, spend) {
  function unit(c) { return Math.round(c) + (c > 0 && spend > 0 ? '/' + safeDiv_(spend, c).toFixed(2) + '$' : ''); }
  return unit(m.inst) + ' - ' + unit(m.reg) + ' - ' + unit(m.dep) + ' (' + manageRoi_(m.rev, spend) + ')';
}

/** Shared "Сейчас"-style 3-line card used at every level. */
function manageCard_(index, active, mark, name, budget, spend, m) {
  return '<b>' + index + '.</b> ' + manageDot_(active) + mark + ' ' +
    escapeHtml_(telegramTrim_(name, 26)) +
    '\n💰' + num_(budget).toFixed(0) + '$ 💸' + Math.round(spend) + '$ 🤑' + Math.round(m.rev) + '$' +
    '\n' + manageFunnel_(m, spend);
}

/* ===================== Keyboards ===================== */

function manageActionKeyboard_(level, opts) {
  const o = opts || {};
  if (level === 'campaigns') {
    return {inline_keyboard: [
      [{text: '🔍 Осмотреть', callback_data: 'mng:ins'}],
      [{text: '💰 Бюджет', callback_data: 'mng:bud'}, {text: '🔀 Вкл/Выкл', callback_data: 'mng:onoff'}],
      [{text: '🏠 Меню', callback_data: 'mng:menu'}]
    ]};
  }
  if (level === 'adsets') {
    const actions = [];
    if (o.adsetBudget) actions.push({text: '💰 Бюджет', callback_data: 'mng:bud'});
    actions.push({text: '🔀 Вкл/Выкл', callback_data: 'mng:onoff'});
    return {inline_keyboard: [
      [{text: '🔍 Осмотреть', callback_data: 'mng:ins'}],
      actions,
      [{text: '⬅️ Назад', callback_data: 'mng:back'}, {text: '🏠 Меню', callback_data: 'mng:menu'}]
    ]};
  }
  // ads
  return {inline_keyboard: [
    [{text: '🔀 Вкл/Выкл', callback_data: 'mng:onoff'}],
    [{text: '⬅️ Назад', callback_data: 'mng:back'}, {text: '🏠 Меню', callback_data: 'mng:menu'}]
  ]};
}

/* ===================== Views ===================== */

function manageCampaignsView_() {
  const cs = readTodayCampaignState_();
  const kt = readTodayKeitaroByCampaign_().byId;
  const list = cs.list.slice().sort(function (a, b) { return b.spend - a.spend; }).slice(0, 40);
  const lines = [TELEGRAM_ICON_META + ' <b>Компании · ' +
    escapeHtml_(formatTelegramDate_(getToday_())) + '</b>', ''];
  list.forEach(function (c, i) {
    const m = kt[c.id] || {inst: 0, reg: 0, dep: 0, rev: 0};
    const mark = adHealthMark_(c.activeAds, c.errorAds, c.warningAds);
    lines.push(manageCard_(i + 1, c.status === 'ACTIVE', mark, c.name || c.id, c.budget, c.spend, m));
  });
  if (!list.length) lines.push('Запущенных кампаний сейчас нет.');
  return {text: lines.join('\n'), keyboard: manageActionKeyboard_('campaigns', {}),
    list: list.map(function (c) { return {id: c.id, name: c.name, cbo: c.budget > 0, budget: c.budget}; })};
}

function manageAdsetsView_(campaign) {
  const adsets = getCampaignAdsets_(campaign.id);
  const lines = ['📂 <b>' + escapeHtml_(telegramTrim_(campaign.name, 34)) + '</b> · адсеты', ''];
  let anyBudget = false;
  const list = adsets.map(function (a) {
    const budget = getCampaignDailyBudget_(a);
    if (budget > 0) anyBudget = true;
    const stats = a.statsTotal || a.stats || {};
    return {id: String(a.adset_id || a.id || ''), name: String(a.name || ''), budget: budget,
      active: String(a.effective_status || a.status || '').toUpperCase() === 'ACTIVE',
      mark: adHealthMark_(a.active_status_ads_count, a.error_status_ads_count, a.warning_status_ads_count),
      spend: getCampaignSpend_(a),
      m: {inst: num_(stats.clicks_tracker_keitaro), reg: num_(stats.registrations_tracker_keitaro),
        dep: num_(stats.deposits_tracker_keitaro), rev: num_(stats.revenue || stats.rev)}};
  });
  list.forEach(function (a, i) {
    lines.push(manageCard_(i + 1, a.active, a.mark, a.name, a.budget, a.spend, a.m));
  });
  if (!list.length) lines.push('Адсетов не найдено.');
  return {text: lines.join('\n'), keyboard: manageActionKeyboard_('adsets', {adsetBudget: anyBudget}),
    list: list.map(function (a) { return {id: a.id, name: a.name, budget: a.budget, on: a.active}; })};
}

function manageAdsView_(adset) {
  const ads = getAdsetAds_(adset.id);
  const lines = ['🖼 <b>' + escapeHtml_(telegramTrim_(adset.name, 34)) + '</b> · объявления', ''];
  const list = ads.map(function (a) {
    return {id: String(a.ad_id || a.id || ''), name: String(a.name || ''),
      active: String(a.effective_status || a.status || '').toUpperCase() === 'ACTIVE',
      mark: manageAdUnitMark_(a),
      reason: String(a.disapprove_reason || a.disapprove_comment || '').trim()};
  });
  list.forEach(function (a, i) {
    lines.push('<b>' + (i + 1) + '.</b> ' + manageDot_(a.active) + a.mark + ' ' +
      escapeHtml_(telegramTrim_(a.name, 28)) +
      (a.reason ? '\n     ⛔ ' + escapeHtml_(telegramTrim_(a.reason, 70)) : ''));
  });
  if (!list.length) lines.push('Объявлений не найдено.');
  return {text: lines.join('\n'), keyboard: manageActionKeyboard_('ads', {}),
    list: list.map(function (a) { return {id: a.id, name: a.name, on: a.active}; })};
}

function manageAdUnitMark_(unit) {
  // A single ad has no "partial": rejected/down → ⚠️.
  const es = String(unit.effective_status || '').toUpperCase();
  if (unit.disapprove_reason || es.indexOf('DISAPPROV') >= 0 ||
      es.indexOf('REJECT') >= 0 || es === 'WITH_ISSUES') return '⚠️';
  return '';
}

/* ===================== Entry & rebuild ===================== */

function manageOpenCampaigns_(chatId) {
  const view = manageCampaignsView_();
  const state = {level: 'campaigns', messageId: null, list: view.list,
    campaign: null, adset: null, pending: null, promptMessageId: null};
  const sent = telegramSend_(chatId, view.text, view.keyboard);
  if (sent && sent.result) state.messageId = sent.result.message_id;
  manageSaveNav_(chatId, state);
}

/** Builds the view for the current level and refreshes state.list. */
function manageCurrentView_(state) {
  if (state.level === 'campaigns') return manageCampaignsView_();
  if (state.level === 'adsets' && state.campaign) return manageAdsetsView_(state.campaign);
  if (state.level === 'ads' && state.adset) return manageAdsView_(state.adset);
  return null;
}

function manageRerender_(chatId, state) {
  const view = manageCurrentView_(state);
  if (!view) return;
  state.list = view.list;
  manageRender_(chatId, state, view.text, view.keyboard);
}

/* ===================== Callbacks ===================== */

function manageCallback_(chatId, action, context) {
  const state = manageLoadNav_(chatId);
  if (context && context.messageId && !state.messageId) state.messageId = context.messageId;

  if (action === 'menu') { manageClearNav_(chatId); telegramSend_(chatId, '🏠 Главное меню', telegramMenu_()); return; }
  if (action === 'back') { manageBack_(chatId, state); return; }
  if (action === 'confirm') { manageConfirm_(chatId, state); return; }
  if (action === 'cancel') { manageCancel_(chatId, state); return; }
  if (action === 'ins') { managePrompt_(chatId, state, {action: 'inspect'}, 'Введите номер ' + manageLevelWord_(state) + ':'); return; }
  if (action === 'bud') { manageStartBudget_(chatId, state); return; }
  if (action === 'onoff') { manageStartToggle_(chatId, state); return; }
}

function manageLevelWord_(state) {
  return state.level === 'campaigns' ? 'кампании' : state.level === 'adsets' ? 'адсета' : 'объявления';
}

function managePrompt_(chatId, state, pending, promptText) {
  state.pending = pending;
  const sent = telegramSend_(chatId, '✍️ ' + promptText);
  state.promptMessageId = sent && sent.result ? sent.result.message_id : null;
  manageSaveNav_(chatId, state);
}

function manageStartBudget_(chatId, state) {
  if (state.level === 'ads') { telegramSend_(chatId, 'У объявления нет бюджета.'); return; }
  managePrompt_(chatId, state, {action: 'budget', step: 'pick'},
    'Введите номер ' + manageLevelWord_(state) + ' для смены бюджета:');
}

function manageStartToggle_(chatId, state) {
  managePrompt_(chatId, state, {action: 'toggle', step: 'pick'},
    'Введите номер ' + manageLevelWord_(state) +
    ' для вкл/выкл (можно несколько через пробел, напр. 1 3 5):');
}

function manageBack_(chatId, state) {
  state.pending = null;
  if (state.level === 'ads') { state.level = 'adsets'; state.adset = null; }
  else if (state.level === 'adsets') { state.level = 'campaigns'; state.campaign = null; }
  else { manageClearNav_(chatId); telegramSend_(chatId, '🏠 Главное меню', telegramMenu_()); return; }
  manageRerender_(chatId, state);
  manageSaveNav_(chatId, state);
}

/* ===================== Typed input ===================== */

function manageParseNumbers_(text, max) {
  const nums = String(text).trim().split(/\s+/).map(function (t) { return Number(t); });
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i];
    if (!Number.isInteger(n) || n < 1 || n > max) return null;
    if (out.indexOf(n) < 0) out.push(n);
  }
  return out.length ? out : null;
}

/** Returns true when a typed message was consumed by an open management prompt. */
function manageHandlePendingInput_(chatId, text) {
  const state = manageLoadNav_(chatId);
  const p = state && state.pending;
  if (!p) return false;
  const list = state.list || [];

  if (p.action === 'inspect') {
    const nums = manageParseNumbers_(text, list.length);
    if (!nums || nums.length !== 1) { telegramSend_(chatId, '⚠️ Нужен один номер от 1 до ' + list.length + '.'); return true; }
    telegramDelete_(chatId, state.promptMessageId); state.promptMessageId = null; state.pending = null;
    const chosen = list[nums[0] - 1];
    if (state.level === 'campaigns') { state.campaign = {id: chosen.id, name: chosen.name, cbo: chosen.cbo}; state.level = 'adsets'; }
    else if (state.level === 'adsets') { state.adset = {id: chosen.id, name: chosen.name}; state.level = 'ads'; }
    else { return true; }
    manageRerender_(chatId, state); manageSaveNav_(chatId, state); return true;
  }

  if (p.action === 'budget' && p.step === 'pick') {
    const nums = manageParseNumbers_(text, list.length);
    if (!nums || nums.length !== 1) { telegramSend_(chatId, '⚠️ Нужен один номер от 1 до ' + list.length + '.'); return true; }
    const chosen = list[nums[0] - 1];
    if (state.level === 'campaigns' && !chosen.cbo) {
      telegramDelete_(chatId, state.promptMessageId); state.promptMessageId = null; state.pending = null;
      manageSaveNav_(chatId, state);
      telegramSend_(chatId, 'У этой кампании бюджет на адсете — зайди в неё (Осмотреть) и меняй бюджет там.');
      return true;
    }
    telegramDelete_(chatId, state.promptMessageId);
    state.pending = {action: 'budget', step: 'value', id: chosen.id, name: chosen.name,
      kind: state.level === 'campaigns' ? 'campaign' : 'adset', current: num_(chosen.budget)};
    const sent = telegramSend_(chatId, '✍️ Введите новый дневной бюджет в $ для <b>' +
      escapeHtml_(chosen.name) + '</b> (сейчас ' + num_(chosen.budget).toFixed(0) + '$):');
    state.promptMessageId = sent && sent.result ? sent.result.message_id : null;
    manageSaveNav_(chatId, state); return true;
  }

  if (p.action === 'budget' && p.step === 'value') {
    const value = Number(String(text).replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(value) || value <= 0) { telegramSend_(chatId, '⚠️ Введите бюджет числом, напр. 25.'); return true; }
    telegramDelete_(chatId, state.promptMessageId); state.promptMessageId = null;
    state.pending = {action: 'apply', type: 'budget', kind: p.kind, id: p.id, name: p.name, current: p.current, value: value};
    const sent = telegramSend_(chatId, 'Сменить дневной бюджет <b>' + escapeHtml_(p.name) + '</b>: ' +
      num_(p.current).toFixed(0) + '$ → <b>' + value.toFixed(0) + '$</b>?', manageConfirmKeyboard_());
    state.promptMessageId = sent && sent.result ? sent.result.message_id : null;
    manageSaveNav_(chatId, state); return true;
  }

  if (p.action === 'toggle' && p.step === 'pick') {
    const nums = manageParseNumbers_(text, list.length);
    if (!nums) { telegramSend_(chatId, '⚠️ Номера от 1 до ' + list.length + ' через пробел.'); return true; }
    telegramDelete_(chatId, state.promptMessageId); state.promptMessageId = null;
    const targets = nums.map(function (n) {
      const u = list[n - 1];
      return {id: u.id, name: u.name, turnOn: !u.on};
    });
    state.pending = {action: 'apply', type: 'toggle', kind: state.level === 'campaigns' ? 'campaign' : state.level === 'adsets' ? 'adset' : 'ad', targets: targets};
    const desc = targets.map(function (t) { return (t.turnOn ? '🟢 ' : '🔴 ') + escapeHtml_(telegramTrim_(t.name, 24)); }).join('\n');
    const sent = telegramSend_(chatId, 'Применить?\n' + desc, manageConfirmKeyboard_());
    state.promptMessageId = sent && sent.result ? sent.result.message_id : null;
    manageSaveNav_(chatId, state); return true;
  }
  return false;
}

/* ===================== Confirm & apply ===================== */

function manageConfirmKeyboard_() {
  return {inline_keyboard: [[
    {text: '✅ Подтвердить', callback_data: 'mng:confirm'},
    {text: '❌ Отменить', callback_data: 'mng:cancel'}
  ]]};
}

function manageCancel_(chatId, state) {
  telegramDelete_(chatId, state.promptMessageId); state.promptMessageId = null; state.pending = null;
  manageSaveNav_(chatId, state);
  telegramSend_(chatId, '❌ Отменено.');
}

function manageConfirm_(chatId, state) {
  const p = state.pending;
  telegramDelete_(chatId, state.promptMessageId); state.promptMessageId = null;
  if (!p || p.action !== 'apply') { state.pending = null; manageSaveNav_(chatId, state); return; }

  const status = telegramSend_(chatId, '⏳ Отправляю запрос в Meta…');
  const statusId = status && status.result ? status.result.message_id : null;
  let result;
  try { result = manageApplyChange_(p); }
  catch (error) { result = {ok: false, message: String(error && error.message || error)}; }
  const text = result.ok ? '✅ ' + escapeHtml_(result.message || 'Готово.')
    : '⚠️ Не удалось: ' + escapeHtml_(result.message || 'ошибка') +
      (result.retryable ? '\nПопробуй ещё раз позже.' : '');
  if (statusId) { try { telegramEditInline_(chatId, statusId, text, null); } catch (_) { telegramSend_(chatId, text); } }
  else telegramSend_(chatId, text);

  state.pending = null;
  // Refresh the list so the change (once writes are live) shows immediately.
  manageRerender_(chatId, state);
  manageSaveNav_(chatId, state);
}

/**
 * Applies a confirmed change. Phase 2 will call the Dolphin write API here;
 * until it is confirmed nothing is sent to Meta and the user is told so.
 */
function manageApplyChange_(pending) {
  if (!getCrmEnv_().devEndpoint) throw new Error('Управление доступно только в песочнице');
  return {ok: false, retryable: false,
    message: 'запись в Meta ещё не подключена (нужен доступ к Dolphin write API). Ничего не изменено.'};
}
