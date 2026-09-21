/**
 * Главные сценарии запуска.
 * Здесь только оркестрация — без API-логики и тяжёлых вычислений.
 */

function manualRefresh() {
  hourlyRefresh();
}

function hourlyRefresh() {
  withRunLock_('hourlyRefresh', function () {
    assertCrmReady_();
    logInfo_('hourlyRefresh', 'START');

    // 1) Meta / Dolphin — сегодня
    const fbContext = refreshDolphinCurrentState_();
    refreshFbToday_(fbContext);

    // 2) Keitaro — сегодня
    refreshKeitaroToday_();

    // 3) Текущий ALL
    rebuildAllToday_();

    // 4) Быстрые проверки
    runTodayControl_();

    logInfo_('hourlyRefresh', 'DONE');
  });
}

function dailyFinalization() {
  withRunLock_('dailyFinalization', function () {
    assertCrmReady_();
    logInfo_('dailyFinalization', 'START');

    // Финально подтягиваем актуальную структуру и вчерашний FB.
    const fbContext = refreshDolphinCurrentState_();
    finalizeFacebookYesterday_(fbContext);

    // Финализируем Keitaro за вчера.
    finalizeKeitaroYesterday_();

    // Фиксируем вчерашний ALL.
    finalizeAllYesterday_();

    // Структура и контроль.
    refreshStructureFromDatabases_();
    runDailyControl_();

    // Telegram включим после задания токена/chat_id.
    if (isTelegramConfigured_()) {
      sendDailyTelegramReport_();
    }

    logInfo_('dailyFinalization', 'DONE');
  });
}

function refreshStructureOnly() {
  withRunLock_('refreshStructureOnly', function () {
    const fbContext = refreshDolphinCurrentState_();
    writeCurrentDolphinDatabases_(fbContext);
    refreshStructureFromDatabases_();
  });
}

function installTriggers() {
  assertCrmReady_();
  const handlers = new Set([
    'hourlyRefresh',
    'dailyFinalization'
  ]);

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (handlers.has(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('hourlyRefresh')
    .timeBased()
    .everyHours(1)
    .create();

  ScriptApp.newTrigger('dailyFinalization')
    .timeBased()
    .atHour(CONFIG.DAILY_HOUR)
    .everyDays(1)
    .inTimezone(CONFIG.TIMEZONE)
    .create();

  logInfo_('installTriggers', 'Triggers installed');
}

/** Read-only readiness gate: deployment never starts imports or installs triggers. */
function assertCrmReady_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss || ss.getId() !== '1OybSL2WmQAsibfvNqmvy9A0rTXCQJ02ghbX2NeFxfYM') {
    throw new Error('CRM target spreadsheet mismatch');
  }
  const all = ss.getSheetByName(SHEETS.ALL);
  if (all && all.getLastRow() > 0) {
    const headers = getAllHeaders_();
    const actual = all.getRange(1, 1, 1, Math.max(all.getLastColumn(), headers.length)).getValues()[0];
    if (actual.length !== headers.length || actual.some(function (v, i) { return v !== headers[i]; })) {
      throw new Error('CRM ALL migration required. Existing history has NOT been changed.');
    }
  }
  getRequiredScriptProperty_(SCRIPT_PROPERTIES.DOLPHIN_TOKEN);
  getRequiredScriptProperty_(SCRIPT_PROPERTIES.KEITARO_KEY);
  if (PropertiesService.getScriptProperties().getProperty('CRM_PIPELINE_VERIFIED') !== 'true') {
    throw new Error('Live source mapping and pipeline verification required before scheduled runs');
  }
}
