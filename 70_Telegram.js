/**
 * Telegram operational panel. Secrets are stored only in Script Properties.
 */

// Section icons in one place. Keitaro and Meta have no Unicode brand emoji, so
// these are stand-ins; swap for custom emoji later if needed.
const TELEGRAM_ICON_KEITARO = '🎯';
const TELEGRAM_ICON_META = 'Ⓜ️';

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
    [{text: '📊 Сейчас'}, {text: '🎯 Офферы'}],
    [{text: TELEGRAM_ICON_META + ' Компании'}, {text: TELEGRAM_ICON_KEITARO + ' Кейтаро'}],
    [{text: '🔀 Потоки'}],
    [{text: '🔄 Обновить'}, {text: '❌ Отмена'}],
    [{text: '❓ Помощь'}]
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

function telegramAnswerCallbackSafe_(callbackId) {
  if (!callbackId) return false;
  try {
    telegramApi_('answerCallbackQuery', {callback_query_id: callbackId});
    return true;
  } catch (error) {
    // With one-minute polling Telegram may expire the callback acknowledgement
    // before Apps Script receives it. The command itself must still run.
    logInfo_('Telegram', 'Expired callback acknowledgement skipped');
    return false;
  }
}

function processTelegramUpdates_() {
  if (!isTelegramConfigured_()) return;
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty('TELEGRAM_DELIVERY_MODE') === 'POLLING' &&
      String(getCrmEnv_().telegramWorkerUrl || '').trim()) {
    try {
      if (ensureTelegramWebhook_()) return;
    } catch (error) {
      logError_('Telegram Worker activation', error);
    }
  }
  const verifiedAt = Number(p.getProperty('TELEGRAM_WEBHOOK_VERIFIED_AT') || 0);
  if (p.getProperty('TELEGRAM_DELIVERY_MODE') !== 'POLLING' &&
      p.getProperty('TELEGRAM_WEBHOOK_URL')) return;
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
        telegramAnswerCallbackSafe_(update.callback_query.id);
        telegramCommand_(chatId, String(update.callback_query.data || ''),
          {messageId: update.callback_query.message && update.callback_query.message.message_id});
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
  if (e && e.parameter && e.parameter.dev) return handleDevRequest_(e);
  const p = PropertiesService.getScriptProperties();
  const secret = String(p.getProperty('TELEGRAM_WEBHOOK_SECRET') || '');
  if (!secret || !e || !e.parameter || String(e.parameter.secret || '') !== secret) {
    return ContentService.createTextOutput('forbidden');
  }
  let chatId = '';
  try {
    const update = JSON.parse(e.postData && e.postData.contents || '{}');
    const updateId = String(update.update_id === undefined ? '' : update.update_id);
    chatId = telegramUpdateChatId_(update);
    const allowed = String(p.getProperty(SCRIPT_PROPERTIES.TELEGRAM_CHAT_ID) || '');
    if (chatId && String(chatId) === allowed) {
      if (updateId && p.getProperty('TELEGRAM_LAST_WEBHOOK_UPDATE_ID') === updateId) {
        return ContentService.createTextOutput('duplicate');
      }
      if (updateId) p.setProperty('TELEGRAM_LAST_WEBHOOK_UPDATE_ID', updateId);
      if (update.callback_query) {
        telegramAnswerCallbackSafe_(update.callback_query.id);
      }
      telegramCommand_(chatId, String(update.callback_query
        ? update.callback_query.data || ''
        : update.message && update.message.text || ''),
        update.callback_query
          ? {messageId: update.callback_query.message && update.callback_query.message.message_id}
          : null);
    }
  } catch (error) {
    logError_('Telegram webhook', error);
    if (chatId) {
      try {
        telegramSend_(chatId, '⚠️ Команда получена, но обработка завершилась ошибкой: ' +
          escapeHtml_(error.message), telegramMenu_());
      } catch (_) {}
    }
  }
  return ContentService.createTextOutput('ok');
}

function enqueueTelegramWebhookCommand_(item) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const p = PropertiesService.getScriptProperties();
    let queue = [];
    try { queue = JSON.parse(p.getProperty('TELEGRAM_WEBHOOK_QUEUE') || '[]'); } catch (_) {}
    if (item.id && (p.getProperty('TELEGRAM_LAST_WEBHOOK_UPDATE_ID') === item.id ||
        queue.some(function (queued) { return queued.id === item.id; }))) return;
    queue.push(item);
    // A Telegram retry storm must never overflow Script Properties.
    queue = queue.slice(-20);
    p.setProperty('TELEGRAM_WEBHOOK_QUEUE', JSON.stringify(queue));
    if (p.getProperty('TELEGRAM_WEBHOOK_WORKER_QUEUED') !== 'true') {
      p.setProperty('TELEGRAM_WEBHOOK_WORKER_QUEUED', 'true');
      ScriptApp.newTrigger('processTelegramWebhookQueue_').timeBased().after(1000).create();
    }
  } finally {
    lock.releaseLock();
  }
}

function processTelegramWebhookQueue_() {
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty('TELEGRAM_WEBHOOK_WORKER_QUEUED');
  for (let i = 0; i < 20; i++) {
    const lock = LockService.getScriptLock();
    lock.waitLock(5000);
    let item;
    try {
      let queue = [];
      try { queue = JSON.parse(p.getProperty('TELEGRAM_WEBHOOK_QUEUE') || '[]'); } catch (_) {}
      if (!queue.length) {
        p.deleteProperty('TELEGRAM_WEBHOOK_QUEUE');
        return;
      }
      item = queue.shift();
      if (queue.length) p.setProperty('TELEGRAM_WEBHOOK_QUEUE', JSON.stringify(queue));
      else p.deleteProperty('TELEGRAM_WEBHOOK_QUEUE');
      if (item.id) p.setProperty('TELEGRAM_LAST_WEBHOOK_UPDATE_ID', String(item.id));
    } finally {
      lock.releaseLock();
    }
    try {
      if (item.callbackId) telegramAnswerCallbackSafe_(item.callbackId);
      telegramCommand_(item.chatId, item.command);
    } catch (error) {
      telegramSend_(item.chatId, '⚠️ ' + escapeHtml_(error.message), telegramMenu_());
      logError_('Telegram queued command', error);
    }
  }
}

function ensureTelegramWebhook_() {
  if (!isTelegramConfigured_()) return false;
  const p = PropertiesService.getScriptProperties();
  const workerUrl = String(getCrmEnv_().telegramWorkerUrl || '').replace(/\/$/, '');
  // An environment without a webhook endpoint (the Claude sandbox) always polls.
  if (!workerUrl && !getCrmEnv_().telegramWebappDeploymentId) return false;
  if (p.getProperty('TELEGRAM_DELIVERY_MODE') === 'POLLING' && !workerUrl) return false;
  const currentInfoResponse = telegramApi_('getWebhookInfo', {});
  const currentInfo = currentInfoResponse && currentInfoResponse.result || {};
  if (/302\s+Found/i.test(String(currentInfo.last_error_message || ''))) {
    telegramApi_('deleteWebhook', {drop_pending_updates: false});
    p.setProperty('TELEGRAM_DELIVERY_MODE', 'POLLING');
    p.deleteProperty('TELEGRAM_WEBHOOK_URL');
    p.deleteProperty('TELEGRAM_WEBHOOK_VERIFIED_AT');
    logInfo_('Telegram', 'Apps Script webhook returned 302; switched to one-minute polling');
    return false;
  }
  let secret = String(p.getProperty('TELEGRAM_WEBHOOK_SECRET') || '');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    p.setProperty('TELEGRAM_WEBHOOK_SECRET', secret);
  }
  const deploymentId = String(getCrmEnv_().telegramWebappDeploymentId || '').trim();
  const baseUrl = deploymentId
    ? 'https://script.google.com/macros/s/' + deploymentId + '/exec'
    : ScriptApp.getService().getUrl();
  if (!baseUrl) return false;
  const url = workerUrl
    ? workerUrl + '/' + encodeURIComponent(secret)
    : baseUrl + '?secret=' + encodeURIComponent(secret);
  const verifiedAt = Number(p.getProperty('TELEGRAM_WEBHOOK_VERIFIED_AT') || 0);
  if (p.getProperty('TELEGRAM_WEBHOOK_URL') === url &&
      verifiedAt && Date.now() - verifiedAt < 24 * 60 * 60 * 1000) return true;
  const result = telegramApi_('setWebhook', {
    url: url,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false
  });
  if (!result || result.ok !== true) throw new Error('Telegram webhook installation failed');
  p.setProperty('TELEGRAM_WEBHOOK_URL', url);
  p.setProperty('TELEGRAM_WEBHOOK_VERIFIED_AT', String(Date.now()));
  p.setProperty('TELEGRAM_DELIVERY_MODE', 'WEBHOOK');
  logInfo_('Telegram', 'Webhook installed');
  const webhookInfo = telegramApi_('getWebhookInfo', {});
  const info = webhookInfo && webhookInfo.result || {};
  logInfo_('Telegram webhook status', JSON.stringify({
    pending: Number(info.pending_update_count || 0),
    lastErrorDate: info.last_error_date || '',
    lastErrorMessage: info.last_error_message || '',
    maxConnections: info.max_connections || '',
    endpoint: workerUrl ? 'CLOUDFLARE' : 'APPS_SCRIPT'
  }));
  return true;
}

/** Public recovery entry point used automatically after every deployment. */
function repairTelegramWebhook() {
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty('TELEGRAM_WEBHOOK_VERIFIED_AT');
  const installed = ensureTelegramWebhook_();
  const webhookInfo = telegramApi_('getWebhookInfo', {});
  const info = webhookInfo && webhookInfo.result || {};
  logInfo_('Telegram webhook diagnostic', JSON.stringify({
    installed: installed,
    urlConfigured: Boolean(info.url),
    pending: Number(info.pending_update_count || 0),
    lastErrorDate: info.last_error_date || '',
    lastErrorMessage: info.last_error_message || '',
    maxConnections: info.max_connections || ''
  }));
  processTelegramWebhookQueue_();
  return {installed: installed, checkedAt: new Date().toISOString()};
}

/** End-to-end deployment check: posts a synthetic command through the public webhook. */
function testTelegramWebhookRoundTrip() {
  const p = PropertiesService.getScriptProperties();
  const secret = getRequiredScriptProperty_('TELEGRAM_WEBHOOK_SECRET');
  const chatId = getRequiredScriptProperty_(SCRIPT_PROPERTIES.TELEGRAM_CHAT_ID);
  const workerUrl = String(getCrmEnv_().telegramWorkerUrl || '').replace(/\/$/, '');
  const deploymentId = String(getCrmEnv_().telegramWebappDeploymentId || '').trim();
  if (!workerUrl && !deploymentId) throw new Error('Telegram webhook endpoint is not configured');
  const testUrl = workerUrl
    ? workerUrl + '/' + encodeURIComponent(secret)
    : 'https://script.google.com/macros/s/' + deploymentId + '/exec?secret=' + encodeURIComponent(secret);
  const response = UrlFetchApp.fetch(testUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        update_id: -Date.now(),
        message: {chat: {id: String(chatId)}, text: '/health'}
      }),
      followRedirects: true,
      muteHttpExceptions: true
    });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('Telegram webhook round-trip HTTP ' + code);
  return {ok: true, status: code};
}

function runTelegramWorkerSmokeTestOnce_() {
  const p = PropertiesService.getScriptProperties();
  if (!getCrmEnv_().telegramWorkerUrl) return true;
  const version = 'cloudflare-v1';
  if (p.getProperty('TELEGRAM_WORKER_SMOKE_TESTED') === version) return true;
  const result = testTelegramWebhookRoundTrip();
  p.setProperty('TELEGRAM_WORKER_SMOKE_TESTED', version);
  logInfo_('Telegram Worker smoke test', JSON.stringify(result));
  return true;
}

function telegramUpdateChatId_(update) {
  if (update.message && update.message.chat) return String(update.message.chat.id);
  if (update.callback_query && update.callback_query.message) {
    return String(update.callback_query.message.chat.id);
  }
  return '';
}

function telegramCommand_(chatId, command, context) {
  const value = String(command || '').trim();
  // Management drill-down (campaigns → adsets → ads) owns its own callbacks,
  // and while it waits for a typed number/value it intercepts plain text.
  if (value.indexOf('mng:') === 0) {
    manageCallback_(chatId, value.substring(4), context || {});
    return;
  }
  if (value.indexOf('kt:') === 0) {
    keitaroCallback_(chatId, value.substring(3), context || {});
    return;
  }
  if (!/^[\/📊🎯🔀🔄❌❓Ⓜ️♾️📘]/.test(value) &&
      (manageHandlePendingInput_(chatId, value) || keitaroHandlePendingInput_(chatId, value))) {
    return;
  }
  if (value === '/health') {
    telegramSend_(chatId, '✅ Бот подключён. Команды принимаются мгновенно.', telegramMenu_());
    return;
  }
  if (value === '/start' || value === '/help' || value === '❓ Помощь') {
    telegramSend_(chatId,
      '<b>JS CRM — оперативный пульт</b>\n\n' +
      'Статистика, офферы, кампании и потоки доступны через кнопки ниже.\n' +
      'Изменение процентов включим после проверки схемы потоков Keitaro.',
      telegramMenu_());
    return;
  }
  if (value === '/today' || value === '/now' || value === '📊 Сейчас' || value === '📊 Сегодня') {
    telegramSend_(chatId, telegramToday_(), telegramMenu_());
    return;
  }
  if (value === '/keitaro' || value === TELEGRAM_ICON_KEITARO + ' Кейтаро') {
    keitaroOpen_(chatId);
    return;
  }
  if (value === '/offers' || value === '🎯 Офферы') {
    telegramSend_(chatId, telegramOffers_(), telegramMenu_());
    return;
  }
  if (value === '/campaigns' || value === TELEGRAM_ICON_META + ' Компании' ||
      value === '📣 Кампании') {
    manageOpenCampaigns_(chatId);
    return;
  }
  if (value === '/flows' || value === '🔀 Потоки') {
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
  if (value === '/cancel' || value === '❌ Отмена') {
    cancelTelegramRefresh_(chatId);
    return;
  }
  telegramSend_(chatId,
    'Сообщение принято, но это не команда CRM. Используй кнопки меню.', telegramMenu_());
}

function cancelTelegramRefresh_(chatId) {
  const p = PropertiesService.getScriptProperties();
  const wasQueued = p.getProperty('TELEGRAM_REFRESH_QUEUED') === 'true';
  p.deleteProperty('TELEGRAM_REFRESH_QUEUED');
  p.deleteProperty('TELEGRAM_REFRESH_CHAT_ID');
  p.deleteProperty('TELEGRAM_REFRESH_MESSAGE_ID');
  p.deleteProperty('TELEGRAM_REFRESH_QUEUED_AT');
  ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === 'runQueuedTelegramRefresh_';
  }).forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  telegramSend_(chatId, wasQueued
    ? '❌ Запланированное обновление отменено.'
    : 'ℹ️ Нет обновления, ожидающего запуска. Уже выполняющийся запрос остановить нельзя.',
    telegramMenu_());
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

/**
 * "Сейчас" — the operational snapshot.
 *
 * A deposit is counted as today's when its click happened today; a sale whose
 * click was on an earlier day is a "долёт" (delayed conversion), even if its
 * campaign also spends today. долёты are folded into the bracketed Rev/ROI so
 * both the fresh-traffic picture and the whole-day picture are visible.
 */
function telegramToday_() {
  const campaigns = readTodayCampaignState_();
  const keitaro = readTodayKeitaroByCampaign_();
  if (!campaigns.list.length && !keitaro.any) {
    return '<b>📊 Сейчас</b>\nДанных за текущие сутки пока нет.';
  }

  const spendIds = campaigns.spendIds;
  const base = {spend: 0, inst: 0, reg: 0, dep: 0, rev: 0};
  const dolet = {dep: 0, rev: 0};
  campaigns.list.forEach(function (c) { base.spend += c.spend; });
  // Clicks/registrations come from the campaign report (spend campaigns).
  Object.keys(keitaro.byId).forEach(function (id) {
    if (!spendIds[id]) return;
    const m = keitaro.byId[id];
    base.inst += m.inst; base.reg += m.reg;
  });
  // A fresh deposit = clicked today AND on a campaign that spends today.
  // Everything else (click on an earlier day, or a campaign with no spend) is долёт.
  const deposits = readTodayDepositsByClick_(spendIds);
  base.dep = deposits.today.dep; base.rev = deposits.today.rev;
  dolet.dep = deposits.dolet.dep; dolet.rev = deposits.dolet.rev;

  const roiBase = base.spend > 0 ? (base.rev - base.spend) / base.spend * 100 : 0;
  const revAll = base.rev + dolet.rev;
  const roiAll = base.spend > 0 ? (revAll - base.spend) / base.spend * 100 : 0;

  const out = ['<b>📊 Сейчас · ' + escapeHtml_(formatTelegramDate_(getToday_())) + '</b>',
    '<i>Dolphin ' + escapeHtml_(campaigns.time || '—') +
      ' · Keitaro ' + escapeHtml_(keitaro.time || '—') + '</i>', '',
    'Spend <b>$' + base.spend.toFixed(2) + '</b>',
    'Inst <b>' + Math.round(base.inst) + '</b> · Reg <b>' + Math.round(base.reg) + '</b>',
    'Dep <b>' + Math.round(base.dep) + '</b>' + (dolet.dep ? ' +' + Math.round(dolet.dep) + ' долёт' : ''),
    'Rev <b>$' + base.rev.toFixed(2) + '</b>' + (dolet.rev ? ' → <b>$' + revAll.toFixed(2) + '</b>' : ''),
    'ROI <b>' + Math.round(roiBase) + '%</b>' + (dolet.rev ? ' → <b>' + Math.round(roiAll) + '%</b>' : '')];

  const geoBlock = telegramNowGeoBlock_(campaigns.spendIds, campaigns.geoById);
  if (geoBlock.length) out.push('', geoBlock.join('\n'));

  const campBlock = telegramNowCampaignsBlock_(campaigns.list, keitaro.byId, deposits.byCampaign);
  if (campBlock.length) out.push('', TELEGRAM_ICON_META + ' <b>Кампании сейчас:</b>', campBlock.join('\n\n'));

  return out.join('\n');
}

/** Per-campaign spend, status and budget from today's FB DB. */
function readTodayCampaignState_() {
  const sheet = getOrCreateSheet_(SHEETS.DB_CAMPAIGNS_TODAY);
  const result = {list: [], spendIds: {}, geoById: {}, time: ''};
  if (sheet.getLastRow() < 2) return result;
  const width = Math.max(sheet.getLastColumn(), 15);
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  values.forEach(function (row) {
    const id = String(row[5] || '');
    const name = String(row[6] || '');
    const spend = num_(row[7]);
    const status = String(row[9] || 'UNKNOWN');
    const item = {id: id, name: name, spend: spend,
      statusRaw: String(row[8] || ''), status: status,
      budget: num_(row[10]), remaining: row[11], geo: parseGeoFromCampaign_(name),
      activeAds: num_(row[12]), errorAds: num_(row[13]), warningAds: num_(row[14])};
    const updated = String(row[1] || '');
    if (updated > result.time) result.time = updated;
    if (spend > 0) {
      result.list.push(item);
      if (id) {
        result.spendIds[id] = true;
        if (item.geo) result.geoById[id] = item.geo;
      }
    } else if (status === 'ACTIVE') {
      // Freshly launched, still waiting for spend.
      result.list.push(item);
    }
  });
  result.time = formatTelegramTime_(result.time);
  return result;
}

/**
 * Splits today's sale conversions into fresh (click today) and долёт (click on
 * an earlier day) using the conversion log's Click At column.
 */
function readTodayDepositsByClick_(spendIds) {
  const result = {today: {dep: 0, rev: 0}, dolet: {dep: 0, rev: 0}, byCampaign: {}};
  const sheet = getOrCreateSheet_(SHEETS.DB_KEITARO_CONVERSIONS_TODAY);
  if (sheet.getLastRow() < 2) return result;
  const headers = getKeitaroConversionHeaders_();
  const statusIdx = headers.indexOf('Status');
  const revIdx = headers.indexOf('Revenue');
  const clickIdx = headers.indexOf('Click At');
  const campaignIdx = headers.indexOf('FB Campaign ID');
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  const today = getToday_();
  const seen = {};
  rows.forEach(function (row) {
    if (String(row[statusIdx] || '').toLowerCase() !== 'sale') return;
    const key = String(row[2] || '');
    if (key && seen[key]) return;
    if (key) seen[key] = true;
    const id = String(row[campaignIdx] || '');
    const clickedToday = normalizeDateKey_(row[clickIdx]) === today;
    const fresh = clickedToday && Boolean(spendIds && spendIds[id]);
    const bucket = fresh ? result.today : result.dolet;
    bucket.dep += 1;
    bucket.rev += num_(row[revIdx]);
    const c = result.byCampaign[id] || (result.byCampaign[id] = {today: 0, dolet: 0});
    if (fresh) c.today += 1; else c.dolet += 1;
  });
  return result;
}

/** Keitaro today metrics aggregated per FB campaign id. */
function readTodayKeitaroByCampaign_() {
  const sheet = getOrCreateSheet_(SHEETS.DB_KEITARO_TODAY);
  const result = {byId: {}, any: false};
  if (sheet.getLastRow() < 2) return result;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, getKeitaroHeaders_().length).getValues();
  let time = '';
  rows.forEach(function (row) {
    result.any = true;
    if (String(row[1] || '') > time) time = String(row[1] || '');
    const id = String(row[4] || '');
    const m = result.byId[id] || (result.byId[id] = {inst: 0, reg: 0, dep: 0, rev: 0});
    m.inst += num_(row[6]);
    m.reg += num_(row[7]);
    m.dep += num_(row[8]);
    m.rev += num_(row[9]);
  });
  result.time = formatTelegramTime_(time);
  return result;
}

/**
 * Offers per GEO, built only from Keitaro traffic on campaigns that spent
 * today, so an offer that only received долёт traffic never appears here.
 * GEO comes from the FB campaign (its spend), not from the Keitaro row.
 */
function telegramNowGeoBlock_(spendIds, geoById) {
  const geos = {};
  const sheet = getOrCreateSheet_(SHEETS.DB_KEITARO_TODAY);
  if (sheet.getLastRow() >= 2) {
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, getKeitaroHeaders_().length).getValues();
    rows.forEach(function (row) {
      const id = String(row[4] || '');
      if (!spendIds[id]) return;
      const geo = geoById[id];
      if (!geo) return;
      const offer = String(row[12] || '').trim();
      if (!offer) return;
      const offerId = String(row[11] || '').trim();
      const key = offerId || offer;
      const bucket = geos[geo] || (geos[geo] = {});
      const o = bucket[key] || (bucket[key] = {offerId: offerId, offer: offer, inst: 0, reg: 0, dep: 0, rev: 0});
      o.inst += num_(row[6]); o.reg += num_(row[7]); o.dep += num_(row[8]); o.rev += num_(row[9]);
    });
  }
  const out = [];
  Object.keys(geos).sort().forEach(function (geo) {
    const offers = Object.keys(geos[geo]).map(function (k) { return geos[geo][k]; })
      // Same threshold as the offers dashboard: a single install is долёт noise.
      .filter(function (o) { return o.inst > 1; })
      .sort(function (a, b) { return b.inst - a.inst; });
    if (!offers.length) return;
    out.push(TELEGRAM_ICON_KEITARO + ' <b>' + escapeHtml_(geo) + '</b>');
    offers.forEach(function (o) {
      out.push((o.offerId ? '<code>' + escapeHtml_(o.offerId) + '</code> ' : '') +
        escapeHtml_(telegramOfferName_(o.offer)) +
        ' · ' + Math.round(o.inst) + ' - ' + Math.round(o.reg) + ' - ' + Math.round(o.dep) +
        ' · $' + safeDiv_(o.rev, o.inst).toFixed(2));
    });
  });
  return out;
}

/**
 * Offer label for one-line display. Offer naming differs per team, so the full
 * name is kept as-is and only shortened to fit one line.
 */
function telegramOfferName_(offer) {
  return telegramTrim_(offer, 40);
}

/** One systematic place to shorten long offer / campaign names for chat. */
function telegramTrim_(text, max) {
  const value = String(text || '').trim();
  const limit = max || 32;
  return value.length > limit ? value.slice(0, limit - 1).trim() + '…' : value;
}

/** Full "Компании" screen: every today campaign as a card, highest spend first. */
function telegramCampaignsScreen_() {
  const campaigns = readTodayCampaignState_();
  const keitaro = readTodayKeitaroByCampaign_();
  if (!campaigns.list.length) {
    return TELEGRAM_ICON_META + ' <b>Компании</b>\nЗапущенных кампаний сейчас нет.';
  }
  const deposits = readTodayDepositsByClick_(campaigns.spendIds);
  const sorted = campaigns.list.slice().sort(function (a, b) { return b.spend - a.spend; });
  const cards = telegramNowCampaignsBlock_(sorted, keitaro.byId, deposits.byCampaign);
  const header = TELEGRAM_ICON_META + ' <b>Компании · ' +
    escapeHtml_(formatTelegramDate_(getToday_())) + '</b>' +
    (campaigns.time ? '\n<i>Dolphin ' + escapeHtml_(campaigns.time) + '</i>' : '');
  return [header, '', cards.join('\n\n')].join('\n');
}

function telegramNowCampaignsBlock_(campaignList, keitaroById, depByCampaign) {
  const lines = [];
  campaignList.forEach(function (c) {
    const on = c.status === 'ACTIVE';
    // Show what we run and watch: anything active (working or waiting for
    // spend) is green; a campaign that spent but is now off (killed) is red.
    // Off campaigns with no spend are old junk and skipped.
    if (!on && c.spend <= 0) return;
    const m = keitaroById[c.id] || {inst: 0, reg: 0, dep: 0, rev: 0};
    const roi = c.spend > 0 ? Math.round((m.rev - c.spend) / c.spend * 100) + '%' : '—';
    // count / cost-per-unit for each funnel step.
    function unit(count, spend) {
      const per = count > 0 && spend > 0 ? '/' + safeDiv_(spend, count).toFixed(2) + '$' : '';
      return Math.round(count) + per;
    }
    const mark = adHealthMark_(c.activeAds, c.errorAds, c.warningAds);
    lines.push((on ? '🟢' : '🔴') + mark + ' ' + escapeHtml_(telegramTrim_(c.name || c.id, 40)) +
      '\n💰' + num_(c.budget).toFixed(0) + '$ 💸' + Math.round(c.spend) + '$ 🤑' + Math.round(m.rev) + '$' +
      '\n' + unit(m.inst, c.spend) + ' - ' + unit(m.reg, c.spend) + ' - ' + unit(m.dep, c.spend) +
      ' (' + roi + ')');
  });
  return lines.slice(0, 40);
}

function formatTelegramDate_(value) {
  const key = normalizeDateKey_(value);
  const parts = key.split('-');
  return parts.length === 3 ? parts[2] + '.' + parts[1] + '.' + parts[0] : key;
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
  const normalized = values[0].map(function (value) {
    return String(value || '').trim().toLowerCase();
  });
  const dateIndex = normalized.indexOf('дата');
  const updatedIndex = normalized.indexOf('updated at');
  const today = getToday_();
  const rows = values.slice(1).filter(function (row) {
    return dateIndex >= 0 && normalizeDateKey_(row[dateIndex]) === today;
  });
  const totals = aggregateTelegramKeitaroTotals_(values[0], rows);
  totals.updatedAt = rows.reduce(function (latest, row) {
    const value = updatedIndex >= 0 ? row[updatedIndex] : '';
    return String(value || '') > String(latest || '') ? value : latest;
  }, '');
  return totals;
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

/** Keitaro campaigns with their I - R - D for today. */
function telegramKeitaroScreen_() {
  const sheet = getOrCreateSheet_(SHEETS.DB_KEITARO_TODAY);
  if (sheet.getLastRow() < 2) return TELEGRAM_ICON_KEITARO + ' <b>Кейтаро</b>\nДанных пока нет.';
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, getKeitaroHeaders_().length).getValues();
  const byCampaign = {};
  rows.forEach(function (row) {
    const id = String(row[16] || '');
    const name = String(row[17] || id);
    const key = id || name;
    const c = byCampaign[key] || (byCampaign[key] = {name: name, inst: 0, reg: 0, dep: 0});
    c.inst += num_(row[6]); c.reg += num_(row[7]); c.dep += num_(row[8]);
  });
  const list = Object.keys(byCampaign).map(function (k) { return byCampaign[k]; })
    .filter(function (c) { return c.inst > 0 || c.reg > 0 || c.dep > 0; })
    .sort(function (a, b) { return b.inst - a.inst; });
  const lines = [TELEGRAM_ICON_KEITARO + ' <b>Кейтаро · ' +
    escapeHtml_(formatTelegramDate_(getToday_())) + '</b>', ''];
  list.forEach(function (c) {
    lines.push(escapeHtml_(telegramTrim_(c.name, 34)) +
      '\n' + Math.round(c.inst) + ' - ' + Math.round(c.reg) + ' - ' + Math.round(c.dep));
  });
  if (!list.length) lines.push('Кампаний с трафиком сегодня нет.');
  return lines.join('\n\n');
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
  const campaigns = getTelegramCachedCampaigns_().slice(0, 40);
  if (!campaigns.length) {
    telegramSend_(chatId, 'Активные кампании Keitaro не найдены.', telegramMenu_());
    return;
  }
  const buttons = campaigns.map(function (c) {
    const id = String(c.id || '');
    const name = String(c.name || id);
    return [{text: name.substring(0, 55), callback_data: 'flow:' + id}];
  });
  telegramSend_(chatId, '<b>Выбери кампанию:</b>', {inline_keyboard: buttons});
}

function getTelegramCachedCampaigns_() {
  const sheet = getOrCreateSheet_(SHEETS.DB_KEITARO_TODAY);
  if (sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const headers = values[0].map(function (value) {
    return String(value || '').trim().toLowerCase();
  });
  const idIndex = headers.indexOf('keitaro campaign id');
  const nameIndex = headers.indexOf('keitaro campaign');
  const statusIndex = headers.indexOf('keitaro campaign status');
  if (idIndex < 0) return [];
  const unique = {};
  values.slice(1).forEach(function (row) {
    const id = String(row[idIndex] || '').trim();
    const status = statusIndex >= 0 ? String(row[statusIndex] || '').toUpperCase() : '';
    if (!id || status === 'DISABLED' || status === 'ARCHIVED') return;
    unique[id] = {id: id, name: String(row[nameIndex] || id), status: status};
  });
  return Object.keys(unique).map(function (id) { return unique[id]; }).sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
}

function telegramFlowDetails_(chatId, campaignId) {
  const cached = getCachedCampaignFlowView_(campaignId);
  if (!cached) {
    telegramSend_(chatId,
      'ℹ️ Потоки этой кампании ещё не сохранены. Нажми «🔄 Обновить» — после получения Keitaro они появятся.',
      telegramMenu_());
    return;
  }
  const streams = cached.streams || [];
  const out = ['<b>🔀 Потоки кампании #' + escapeHtml_(campaignId) + '</b>', ''];
  if (cached.updatedAt) out.push('Данные на ' + escapeHtml_(formatTelegramTime_(cached.updatedAt)), '');
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
