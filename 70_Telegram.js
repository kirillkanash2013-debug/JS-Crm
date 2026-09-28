/**
 * Telegram operational panel. Secrets are stored only in Script Properties.
 */

function isTelegramConfigured_() {
  const p = PropertiesService.getScriptProperties();
  return Boolean(p.getProperty(SCRIPT_PROPERTIES.TELEGRAM_BOT_TOKEN) &&
    p.getProperty(SCRIPT_PROPERTIES.TELEGRAM_CHAT_ID));
}

function telegramApi_(method, payload) {
  const token = getRequiredScriptProperty_(SCRIPT_PROPERTIES.TELEGRAM_BOT_TOKEN);
  const response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  });
  return parseJsonResponseOrThrow_(response, 'Telegram ' + method);
}

function telegramMenu_() {
  return {keyboard: [
    [{text: '📊 Сегодня'}, {text: '🎯 Офферы'}],
    [{text: '📣 Кампании'}, {text: '🔀 Потоки'}],
    [{text: '🔄 Обновить'}, {text: '❓ Помощь'}]
  ], resize_keyboard: true, is_persistent: true};
}

function telegramSend_(chatId, text, markup) {
  const payload = {chat_id: String(chatId), text: text, parse_mode: 'HTML'};
  if (markup) payload.reply_markup = markup;
  return telegramApi_('sendMessage', payload);
}

function telegramEdit_(chatId, messageId, text) {
  if (!messageId) return telegramSend_(chatId, text, telegramMenu_());
  return telegramApi_('editMessageText', {
    chat_id: String(chatId),
    message_id: Number(messageId),
    text: text,
    parse_mode: 'HTML'
  });
}

function processTelegramUpdates_() {
  if (!isTelegramConfigured_()) return;
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty('TELEGRAM_WEBHOOK_URL')) return;
  const allowedChatId = String(p.getProperty(SCRIPT_PROPERTIES.TELEGRAM_CHAT_ID));
  const offset = Number(p.getProperty('TELEGRAM_UPDATE_OFFSET') || 0);
  const response = telegramApi_('getUpdates', {
    offset: offset, limit: 20, timeout: 0,
    allowed_updates: ['message', 'callback_query']
  });
  const updates = response && Array.isArray(response.result) ? response.result : [];

  updates.forEach(function (update) {
    p.setProperty('TELEGRAM_UPDATE_OFFSET', String(Number(update.update_id) + 1));
    const chatId = telegramUpdateChatId_(update);
    if (!chatId || String(chatId) !== allowedChatId) return;
    try {
      if (update.callback_query) {
        telegramApi_('answerCallbackQuery', {callback_query_id: update.callback_query.id});
        telegramCommand_(chatId, String(update.callback_query.data || ''));
      } else {
        telegramCommand_(chatId, String(update.message && update.message.text || ''));
      }
    } catch (e) {
      telegramSend_(chatId, '⚠️ ' + escapeHtml_(e.message), telegramMenu_());
      logError_('Telegram', e);
    }
  });
}

function doPost(e) {
  const p = PropertiesService.getScriptProperties();
  const secret = String(p.getProperty('TELEGRAM_WEBHOOK_SECRET') || '');
  if (!secret || !e || !e.parameter || String(e.parameter.secret || '') !== secret) {
    return ContentService.createTextOutput('forbidden');
  }
  try {
    const update = JSON.parse(e.postData && e.postData.contents || '{}');
    const updateId = String(update.update_id === undefined ? '' : update.update_id);
    if (updateId && p.getProperty('TELEGRAM_LAST_WEBHOOK_UPDATE_ID') === updateId) {
      return ContentService.createTextOutput('duplicate');
    }
    if (updateId) p.setProperty('TELEGRAM_LAST_WEBHOOK_UPDATE_ID', updateId);
    const chatId = telegramUpdateChatId_(update);
    const allowed = String(p.getProperty(SCRIPT_PROPERTIES.TELEGRAM_CHAT_ID) || '');
    if (chatId && String(chatId) === allowed) {
      if (update.callback_query) {
        telegramApi_('answerCallbackQuery', {callback_query_id: update.callback_query.id});
        telegramCommand_(chatId, String(update.callback_query.data || ''));
      } else {
        telegramCommand_(chatId, String(update.message && update.message.text || ''));
      }
    }
  } catch (error) {
    logError_('Telegram webhook', error);
  }
  return ContentService.createTextOutput('ok');
}

function ensureTelegramWebhook_() {
  if (!isTelegramConfigured_()) return false;
  const p = PropertiesService.getScriptProperties();
  let secret = String(p.getProperty('TELEGRAM_WEBHOOK_SECRET') || '');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    p.setProperty('TELEGRAM_WEBHOOK_SECRET', secret);
  }
  const deploymentId = String(CONFIG.TELEGRAM_WEBAPP_DEPLOYMENT_ID || '').trim();
  const baseUrl = deploymentId
    ? 'https://script.google.com/macros/s/' + deploymentId + '/exec'
    : ScriptApp.getService().getUrl();
  if (!baseUrl) return false;
  const url = baseUrl + '?secret=' + encodeURIComponent(secret);
  if (p.getProperty('TELEGRAM_WEBHOOK_URL') === url) return true;
  const result = telegramApi_('setWebhook', {
    url: url,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false
  });
  if (!result || result.ok !== true) throw new Error('Telegram webhook installation failed');
  p.setProperty('TELEGRAM_WEBHOOK_URL', url);
  logInfo_('Telegram', 'Webhook installed');
  return true;
}

function telegramUpdateChatId_(update) {
  if (update.message && update.message.chat) return String(update.message.chat.id);
  if (update.callback_query && update.callback_query.message) {
    return String(update.callback_query.message.chat.id);
  }
  return '';
}

function telegramCommand_(chatId, command) {
  const value = String(command || '').trim();
  if (value === '/start' || value === '/help' || value === '❓ Помощь') {
    telegramSend_(chatId,
      '<b>JS CRM — оперативный пульт</b>\n\n' +
      'Статистика, офферы, кампании и потоки доступны через кнопки ниже.\n' +
      'Изменение процентов включим после проверки схемы потоков Keitaro.',
      telegramMenu_());
    return;
  }
  if (value === '/today' || value === '📊 Сегодня') {
    telegramSend_(chatId, telegramToday_(), telegramMenu_());
    return;
  }
  if (value === '/offers' || value === '🎯 Офферы') {
    telegramSend_(chatId, telegramOffers_(), telegramMenu_());
    return;
  }
  if (value === '/campaigns' || value === '/flows' ||
      value === '📣 Кампании' || value === '🔀 Потоки') {
    telegramCampaignButtons_(chatId);
    return;
  }
  if (value.indexOf('flow:') === 0) {
    telegramFlowDetails_(chatId, value.substring(5));
    return;
  }
  if (/^\/flows\s+\d+$/i.test(value)) {
    telegramFlowDetails_(chatId, value.split(/\s+/)[1]);
    return;
  }
  if (value === '/refresh' || value === '🔄 Обновить') {
    queueTelegramRefresh_(chatId);
    return;
  }
  telegramSend_(chatId, 'Используй кнопки меню.', telegramMenu_());
}

function queueTelegramRefresh_(chatId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const p = PropertiesService.getScriptProperties();
    if (p.getProperty('TELEGRAM_REFRESH_QUEUED') === 'true') {
      const queuedAt = Number(p.getProperty('TELEGRAM_REFRESH_QUEUED_AT') || 0);
      if (queuedAt && Date.now() - queuedAt < 20 * 60 * 1000) {
        telegramSend_(chatId, '⏳ Обновление уже выполняется.', telegramMenu_());
        return false;
      }
      // Recover automatically if a previous Apps Script execution timed out.
      p.deleteProperty('TELEGRAM_REFRESH_QUEUED');
      p.deleteProperty('TELEGRAM_REFRESH_CHAT_ID');
      p.deleteProperty('TELEGRAM_REFRESH_MESSAGE_ID');
      p.deleteProperty('TELEGRAM_REFRESH_QUEUED_AT');
    }
    const status = telegramSend_(chatId, '⏳ <b>Получаю Dolphin…</b>');
    const messageId = status && status.result ? status.result.message_id : '';
    p.setProperties({
      TELEGRAM_REFRESH_QUEUED: 'true',
      TELEGRAM_REFRESH_CHAT_ID: String(chatId),
      TELEGRAM_REFRESH_MESSAGE_ID: String(messageId || ''),
      TELEGRAM_REFRESH_QUEUED_AT: String(Date.now())
    });
    ScriptApp.newTrigger('runQueuedTelegramRefresh_').timeBased().after(1000).create();
    return true;
  } finally {
    lock.releaseLock();
  }
}

function runQueuedTelegramRefresh_() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty('TELEGRAM_REFRESH_QUEUED') !== 'true') return;
  const chatId = String(p.getProperty('TELEGRAM_REFRESH_CHAT_ID') ||
    p.getProperty(SCRIPT_PROPERTIES.TELEGRAM_CHAT_ID) || '');
  const messageId = String(p.getProperty('TELEGRAM_REFRESH_MESSAGE_ID') || '');
  try {
    withRunLock_('telegramRefresh', function () {
      assertTargetSpreadsheet_();
      logInfo_('telegramRefresh', 'START');
      updateFbToday();
      if (chatId) telegramEdit_(chatId, messageId,
        '✅ Dolphin получен\n⏳ <b>Получаю Keitaro…</b>');
      updateKeitaroToday();
      if (chatId) telegramEdit_(chatId, messageId,
        '✅ Dolphin получен\n✅ Keitaro получен\n⏳ <b>Собираю таблицы…</b>');
      rebuildTodayDashboard();
      if (chatId) telegramEdit_(chatId, messageId,
        '✅ Dolphin получен\n✅ Keitaro получен\n✅ Таблицы собраны\n⏳ <b>Последний штрих…</b>');
      logInfo_('telegramRefresh', 'DONE');
    });
    if (chatId) telegramEdit_(chatId, messageId,
      '<b>✅ Всё готово</b>\n\n' + telegramToday_());
  } catch (error) {
    if (chatId) telegramEdit_(chatId, messageId,
      '⚠️ <b>Обновление не завершено</b>\n' + escapeHtml_(error.message));
    logError_('Telegram queued refresh', error);
  } finally {
    p.deleteProperty('TELEGRAM_REFRESH_QUEUED');
    p.deleteProperty('TELEGRAM_REFRESH_CHAT_ID');
    p.deleteProperty('TELEGRAM_REFRESH_MESSAGE_ID');
    p.deleteProperty('TELEGRAM_REFRESH_QUEUED_AT');
  }
}

function telegramToday_() {
  const sheet = getOrCreateSheet_(SHEETS.ALL_TODAY);
  if (sheet.getLastRow() < 2) return '<b>📊 Сегодня</b>\nДанных пока нет.';
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rows = filterLatestTodaySnapshotRows_(headers,
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues());
  const h = headers.map(function (x) { return String(x || '').trim().toLowerCase(); });
  function col(name) { return h.indexOf(name); }
  const c = {spend: col('spend'), inst: col('inst'), reg: col('reg'),
    dep: col('ftd'), revenue: col('revenue'), time: col('время')};
  const t = rows.reduce(function (a, row) {
    ['spend', 'inst', 'reg', 'dep', 'revenue'].forEach(function (key) {
      if (c[key] >= 0) a[key] += num_(row[c[key]]);
    });
    return a;
  }, {spend: 0, inst: 0, reg: 0, dep: 0, revenue: 0});

  // Spend belongs to Meta/FB, but the conversion funnel belongs to Keitaro.
  // ALL Today intentionally contains only rows joined to an FB campaign. Using
  // it for Revenue loses delayed conversions and legacy traffic whose sub4 is
  // blank or still contains an unexpanded macro such as {sub_id_4}.
  const keitaroTotals = getTelegramKeitaroTodayTotals_();
  if (keitaroTotals.hasData) {
    t.inst = keitaroTotals.inst;
    t.reg = keitaroTotals.reg;
    t.dep = keitaroTotals.dep;
    t.revenue = keitaroTotals.revenue;
  }
  const roi = t.spend > 0 ? (t.revenue - t.spend) / t.spend * 100 : 0;
  const time = rows.length && c.time >= 0 ? formatTelegramTime_(rows[0][c.time]) : '';
  return ['<b>📊 Сегодня' + (time ? ' · ' + escapeHtml_(time) : '') + '</b>', '',
    'Spend: <b>$' + t.spend.toFixed(2) + '</b>',
    'Inst: <b>' + Math.round(t.inst) + '</b>',
    'Reg: <b>' + Math.round(t.reg) + '</b>',
    'Dep: <b>' + Math.round(t.dep) + '</b>',
    'Revenue: <b>$' + t.revenue.toFixed(2) + '</b>',
    'ROI: <b>' + Math.round(roi) + '%</b>'].join('\n');
}

function formatTelegramTime_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, CONFIG.TIMEZONE, 'HH:mm');
  }
  return String(value).replace(/^.*?(\d{1,2}:\d{2})(?::\d{2})?.*$/, '$1');
}

function getTelegramKeitaroTodayTotals_() {
  const sheet = getOrCreateSheet_(SHEETS.DB_KEITARO_TODAY);
  if (sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) {
    return {hasData: false, inst: 0, reg: 0, dep: 0, revenue: 0};
  }
  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  return aggregateTelegramKeitaroTotals_(values[0], values.slice(1));
}

function aggregateTelegramKeitaroTotals_(headers, rows) {
  const normalized = (headers || []).map(function (value) {
    return String(value || '').trim().toLowerCase();
  });
  function indexOfAny_(names) {
    for (let i = 0; i < names.length; i++) {
      const index = normalized.indexOf(names[i]);
      if (index >= 0) return index;
    }
    return -1;
  }
  const columns = {
    inst: indexOfAny_(['inst']),
    reg: indexOfAny_(['reg']),
    dep: indexOfAny_(['ftd', 'dep']),
    revenue: indexOfAny_(['revenue'])
  };
  const hasRequiredColumns = Object.keys(columns).every(function (key) {
    return columns[key] >= 0;
  });
  if (!hasRequiredColumns || !(rows || []).length) {
    return {hasData: false, inst: 0, reg: 0, dep: 0, revenue: 0};
  }
  return (rows || []).reduce(function (totals, row) {
    totals.inst += num_(row[columns.inst]);
    totals.reg += num_(row[columns.reg]);
    totals.dep += num_(row[columns.dep]);
    totals.revenue += num_(row[columns.revenue]);
    return totals;
  }, {hasData: true, inst: 0, reg: 0, dep: 0, revenue: 0});
}

function telegramOffers_() {
  const sheet = getOrCreateSheet_(SHEETS.OFFERS_TODAY);
  if (sheet.getLastRow() < 2) return '<b>🎯 Офферы</b>\nДанных пока нет.';
  const count = Math.min(sheet.getLastRow() - 1, 20);
  const rows = sheet.getRange(2, 1, count, 8).getValues();
  const out = ['<b>🎯 Офферы сегодня</b>', ''];
  rows.forEach(function (r) {
    out.push('<b>' + escapeHtml_(String(r[0] || '')) + ' · ' +
      escapeHtml_(String(r[2] || r[1] || '')) + '</b>');
    out.push('Inst ' + Math.round(num_(r[3])) + ' · Reg ' + Math.round(num_(r[4])) +
      ' · Dep ' + Math.round(num_(r[5])) + ' · Revenue $' + num_(r[6]).toFixed(2));
  });
  return out.join('\n');
}

function telegramCampaignButtons_(chatId) {
  const campaigns = getKeitaroCampaigns_().filter(function (c) {
    const state = String(pick_(c, ['state', 'status']) || '').toUpperCase();
    return state !== 'DISABLED' && state !== 'ARCHIVED';
  }).slice(0, 40);
  if (!campaigns.length) {
    telegramSend_(chatId, 'Активные кампании Keitaro не найдены.', telegramMenu_());
    return;
  }
  const buttons = campaigns.map(function (c) {
    const id = String(pick_(c, ['id', 'campaign_id']) || '');
    const name = String(pick_(c, ['name', 'title']) || id);
    return [{text: name.substring(0, 55), callback_data: 'flow:' + id}];
  });
  telegramSend_(chatId, '<b>Выбери кампанию:</b>', {inline_keyboard: buttons});
}

function telegramFlowDetails_(chatId, campaignId) {
  const streams = getCampaignFlowView_(campaignId);
  const out = ['<b>🔀 Потоки кампании #' + escapeHtml_(campaignId) + '</b>', ''];
  if (!streams.length) out.push('Потоки не найдены.');
  streams.forEach(function (s) {
    out.push('<b>' + escapeHtml_(s.name) + '</b> · ' +
      escapeHtml_(s.status) + ' · ID ' + escapeHtml_(s.id));
    if (!s.offers.length) out.push('Офферы в ответе API не обнаружены');
    s.offers.forEach(function (o) {
      out.push('• ' + escapeHtml_(o.name || ('Offer #' + o.id)) +
        (o.weight ? ' — ' + o.weight + '%' : ''));
    });
    out.push('');
  });
  telegramSend_(chatId, out.join('\n'), telegramMenu_());
}

function sendDailyTelegramReport_() {
  const chatId = getRequiredScriptProperty_(SCRIPT_PROPERTIES.TELEGRAM_CHAT_ID);
  telegramSend_(chatId, buildDailyTelegramReport_());
}

function buildDailyTelegramReport_() {
  const date = getYesterday_();
  const rows = filterSheetRowsByDate_(SHEETS.ALL, date);
  const totals = rows.reduce(function (a, r) {
    a.spend += num_(r[17] !== undefined ? r[17] : r[5]);
    a.inst += num_(r[7] !== undefined ? r[7] : r[6]);
    a.reg += num_(r[9] !== undefined ? r[9] : r[7]);
    a.dep += num_(r[11] !== undefined ? r[11] : r[8]);
    a.revenue += num_(r[18] !== undefined ? r[18] : r[9]);
    return a;
  }, {spend: 0, inst: 0, reg: 0, dep: 0, revenue: 0});
  const roi = totals.spend > 0 ? (totals.revenue - totals.spend) / totals.spend * 100 : 0;
  return ['<b>Отчёт за ' + escapeHtml_(date) + '</b>', '',
    'Spend: $' + totals.spend.toFixed(2), 'Inst: ' + Math.round(totals.inst),
    'Reg: ' + Math.round(totals.reg), 'Dep: ' + Math.round(totals.dep),
    'Revenue: $' + totals.revenue.toFixed(2), 'ROI: ' + Math.round(roi) + '%'].join('\n');
}
