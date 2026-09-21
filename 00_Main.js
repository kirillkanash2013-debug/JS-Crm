/**
 * Главные сценарии запуска.
 * Здесь только оркестрация — без API-логики и тяжёлых вычислений.
 */

function manualRefresh() {
  hourlyRefresh();
}

function hourlyRefresh() {
  withRunLock_('hourlyRefresh', function () {
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
