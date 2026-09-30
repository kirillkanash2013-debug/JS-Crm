/**
 * Meta management drill-down for Telegram: Кампании → Адсеты → Объявления.
 *
 * Phase 1 (this file): read-only browsing with numbered lists and inline
 * buttons. "Осмотреть" replaces the browsing message in place; each level keeps
 * Назад / Меню. A "!" mark flags a unit that looks on but is not delivering
 * (rejected ads / errors). Writes (Бюджет, Вкл/Выкл) are stubbed until the
 * Dolphin write API and a safe test target are confirmed.
 */

function manageNavKey_(chatId) {
  return 'TELEGRAM_NAV_' + String(chatId);
}

function manageLoadNav_(chatId) {
  try {
    return JSON.parse(PropertiesService.getScriptProperties()
      .getProperty(manageNavKey_(chatId)) || '{}');
  } catch (_) {
    return {};
  }
}

function manageSaveNav_(chatId, state) {
  PropertiesService.getScriptProperties()
    .setProperty(manageNavKey_(chatId), JSON.stringify(state));
}

function manageClearNav_(chatId) {
  PropertiesService.getScriptProperties().deleteProperty(manageNavKey_(chatId));
}

/** Edits a message in place, keeping an inline keyboard; used for drill-down. */
function telegramEditInline_(chatId, messageId, text, inlineKeyboard) {
  return telegramApi_('editMessageText', {
    chat_id: String(chatId),
    message_id: Number(messageId),
    text: text,
    parse_mode: 'HTML',
    reply_markup: inlineKeyboard || {inline_keyboard: []}
  });
}

/** Edits the current browsing message if we have one, else sends a new one. */
function manageRender_(chatId, state, text, keyboard) {
  if (state.messageId) {
    try {
      telegramEditInline_(chatId, state.messageId, text, keyboard);
      return;
    } catch (_) {}
  }
  const sent = telegramSend_(chatId, text, keyboard);
  if (sent && sent.result) state.messageId = sent.result.message_id;
}

function manageKeyboard_(level, options) {
  const opts = options || {};
  const rows = [[{text: '🔍 Осмотреть', callback_data: 'mng:ins'}]];
  const actions = [{text: '🔀 Вкл/Выкл', callback_data: 'mng:onoff'}];
  if (opts.budgetHere) actions.unshift({text: '💰 Бюджет', callback_data: 'mng:bud'});
  if (level === 'ads') rows[0] = [];
  rows.push(actions);
  const nav = [];
  if (level !== 'campaigns') nav.push({text: '⬅️ Назад', callback_data: 'mng:back'});
  nav.push({text: '🏠 Меню', callback_data: 'mng:menu'});
  rows.push(nav);
  return {inline_keyboard: rows.filter(function (r) { return r.length; })};
}

/** 🟢/🔴 plus a "!" / "⚠️" mark when a unit is on but not delivering. */
function manageUnitLine_(index, active, mark, name, tail) {
  return index + '. ' + (active ? '🟢' : '🔴') + mark + ' ' +
    escapeHtml_(telegramTrim_(name, 38)) + (tail ? '\n     ' + tail : '');
}

function manageAdUnitMark_(unit) {
  const es = String(unit.effective_status || '').toUpperCase();
  if (unit.disapprove_reason || es.indexOf('DISAPPROV') >= 0 ||
      es.indexOf('REJECT') >= 0 || es === 'WITH_ISSUES') return '❗';
  if (es.indexOf('PENDING') >= 0 || es.indexOf('REVIEW') >= 0 ||
      es.indexOf('IN_PROCESS') >= 0) return '⚠️';
  return '';
}

/* ================= Campaigns ================= */

function manageOpenCampaigns_(chatId) {
  const built = manageRenderCampaigns_();
  const state = {level: 'campaigns', list: built.list, messageId: null,
    campaign: null, adset: null, pending: null};
  const sent = telegramSend_(chatId, built.text, manageKeyboard_('campaigns', {}));
  if (sent && sent.result) state.messageId = sent.result.message_id;
  manageSaveNav_(chatId, state);
}

function manageRenderCampaigns_() {
  const cs = readTodayCampaignState_();
  const list = cs.list.slice().sort(function (a, b) { return b.spend - a.spend; }).slice(0, 50);
  const lines = [TELEGRAM_ICON_META + ' <b>Компании · ' +
    escapeHtml_(formatTelegramDate_(getToday_())) + '</b>', ''];
  list.forEach(function (c, i) {
    const mark = adHealthMark_(c.activeAds, c.errorAds, c.warningAds);
    const budget = c.budget > 0 ? ' · CBO ' + num_(c.budget).toFixed(0) + '$' : '';
    lines.push(manageUnitLine_(i + 1, c.status === 'ACTIVE', mark, c.name,
      '💸' + Math.round(c.spend) + '$' + budget));
  });
  if (!list.length) lines.push('Запущенных кампаний сейчас нет.');
  return {text: lines.join('\n'),
    list: list.map(function (c) {
      return {id: c.id, name: c.name, cbo: c.budget > 0, budget: c.budget};
    })};
}

/* ================= Adsets ================= */

function manageRenderAdsets_(campaign) {
  const adsets = getCampaignAdsets_(campaign.id);
  const lines = ['📂 <b>' + escapeHtml_(telegramTrim_(campaign.name, 40)) + '</b> · адсеты', ''];
  const list = adsets.map(function (a) {
    return {
      id: String(a.adset_id || a.id || ''),
      name: String(a.name || ''),
      active: String(a.effective_status || a.status || '').toUpperCase() === 'ACTIVE',
      mark: adHealthMark_(a.active_status_ads_count, a.error_status_ads_count, a.warning_status_ads_count),
      spend: getCampaignSpend_(a),
      budget: getCampaignDailyBudget_(a)
    };
  });
  list.forEach(function (a, i) {
    const budget = a.budget > 0 ? ' · ' + num_(a.budget).toFixed(0) + '$' : '';
    lines.push(manageUnitLine_(i + 1, a.active, a.mark, a.name,
      '💸' + Math.round(a.spend) + '$' + budget));
  });
  if (!list.length) lines.push('Адсетов не найдено.');
  return {text: lines.join('\n'), list: list, adsetBudget: list.some(function (a) { return a.budget > 0; })};
}

/* ================= Ads ================= */

function manageRenderAds_(adset) {
  const ads = getAdsetAds_(adset.id);
  const lines = ['🖼 <b>' + escapeHtml_(telegramTrim_(adset.name, 40)) + '</b> · объявления', ''];
  const list = ads.map(function (a) {
    return {
      id: String(a.ad_id || a.id || ''),
      name: String(a.name || ''),
      active: String(a.effective_status || a.status || '').toUpperCase() === 'ACTIVE',
      mark: manageAdUnitMark_(a),
      reason: String(a.disapprove_reason || a.disapprove_comment || '').trim()
    };
  });
  list.forEach(function (a, i) {
    lines.push(manageUnitLine_(i + 1, a.active, a.mark, a.name,
      a.reason ? '⛔ ' + escapeHtml_(telegramTrim_(a.reason, 60)) : ''));
  });
  if (!list.length) lines.push('Объявлений не найдено.');
  return {text: lines.join('\n'), list: list};
}

/* ================= Callbacks & input ================= */

function manageCallback_(chatId, action, context) {
  const state = manageLoadNav_(chatId);
  if (context && context.messageId && !state.messageId) state.messageId = context.messageId;

  if (action === 'menu') {
    manageClearNav_(chatId);
    telegramSend_(chatId, '🏠 Главное меню', telegramMenu_());
    return;
  }
  if (action === 'ins') {
    state.pending = {action: 'inspect'};
    manageSaveNav_(chatId, state);
    const what = state.level === 'campaigns' ? 'кампании'
      : state.level === 'adsets' ? 'адсета' : '';
    if (!what) { telegramSend_(chatId, 'Здесь проваливаться некуда.'); return; }
    manageRepromptCurrent_(chatId, state, '✍️ Введите номер ' + what + ':');
    return;
  }
  if (action === 'back') {
    manageGoBack_(chatId, state);
    return;
  }
  if (action === 'bud' || action === 'onoff') {
    telegramSend_(chatId,
      '⚙️ Управление (бюджет, вкл/выкл) подключим после разблокировки записи в Meta.');
    return;
  }
}

/** Re-render current level and append a prompt line (keeps the list visible). */
function manageRepromptCurrent_(chatId, state, prompt) {
  const built = manageBuildCurrent_(state);
  if (!built) return;
  state.list = built.list;
  manageRender_(chatId, state, built.text + '\n\n' + prompt, built.keyboard);
  manageSaveNav_(chatId, state);
}

function manageBuildCurrent_(state) {
  if (state.level === 'campaigns') {
    const b = manageRenderCampaigns_();
    return {text: b.text, list: b.list, keyboard: manageKeyboard_('campaigns', {})};
  }
  if (state.level === 'adsets' && state.campaign) {
    const b = manageRenderAdsets_(state.campaign);
    return {text: b.text, list: b.list,
      keyboard: manageKeyboard_('adsets', {budgetHere: !state.campaign.cbo && b.adsetBudget})};
  }
  if (state.level === 'ads' && state.adset) {
    const b = manageRenderAds_(state.adset);
    return {text: b.text, list: b.list, keyboard: manageKeyboard_('ads', {})};
  }
  return null;
}

function manageGoBack_(chatId, state) {
  if (state.level === 'ads') {
    state.level = 'adsets';
    state.adset = null;
    state.pending = null;
    const built = manageBuildCurrent_(state);
    state.list = built.list;
    manageRender_(chatId, state, built.text, built.keyboard);
    manageSaveNav_(chatId, state);
    return;
  }
  if (state.level === 'adsets') {
    state.level = 'campaigns';
    state.campaign = null;
    state.pending = null;
    const built = manageBuildCurrent_(state);
    state.list = built.list;
    manageRender_(chatId, state, built.text, built.keyboard);
    manageSaveNav_(chatId, state);
    return;
  }
  manageClearNav_(chatId);
  telegramSend_(chatId, '🏠 Главное меню', telegramMenu_());
}

/** Returns true when a typed number was consumed as drill-down input. */
function manageHandlePendingInput_(chatId, text) {
  const state = manageLoadNav_(chatId);
  if (!state || !state.pending || state.pending.action !== 'inspect') return false;
  const num = Number(String(text).trim());
  const list = state.list || [];
  if (!Number.isInteger(num) || num < 1 || num > list.length) {
    telegramSend_(chatId, '⚠️ Нужен номер от 1 до ' + list.length + '.');
    return true;
  }
  const chosen = list[num - 1];
  state.pending = null;

  if (state.level === 'campaigns') {
    state.campaign = {id: chosen.id, name: chosen.name, cbo: Boolean(chosen.cbo)};
    state.level = 'adsets';
  } else if (state.level === 'adsets') {
    state.adset = {id: chosen.id, name: chosen.name};
    state.level = 'ads';
  } else {
    return true;
  }
  const built = manageBuildCurrent_(state);
  state.list = built.list;
  manageRender_(chatId, state, built.text, built.keyboard);
  manageSaveNav_(chatId, state);
  return true;
}
