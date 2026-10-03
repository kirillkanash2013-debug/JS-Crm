/**
 * Главные сценарии запуска.
 * Здесь только оркестрация — без API-логики и тяжёлых вычислений.
 */

function manualRefresh() {
  return updateToday();
}


/** Public manual refresh. It never finalizes yesterday. */
function updateToday() {
  return withRunLock_('updateToday', function () {
    assertTargetSpreadsheet_();
    logInfo_('updateToday', 'START');
    const fbContext = updateFbToday();
    updateKeitaroToday();
    rebuildTodayDashboard();
    logInfo_('updateToday', 'DONE');
  });
}

function updateFbToday() {
  const context = refreshDolphinCurrentState_();
  refreshFbToday_(context);
  return context;
}

function updateKeitaroToday() {
  const date = getToday_();
  const reportRows = normalizeKeitaroReportRows_(getKeitaroReport_(date, date));
  const conversionRows = getKeitaroConversions_(date, date);
  const campaigns = getKeitaroCampaigns_();
  writeKeitaroTodayDb_(reportRows, date, campaigns, conversionRows);
  writeKeitaroConversionsTodayDb_(conversionRows, date);
  const flowCache = refreshKeitaroFlowCache_(campaigns);
  return {campaigns: reportRows.length, conversions: conversionRows.length,
    cachedFlows: flowCache.updated, flowErrors: flowCache.errors};
}

/** Public, Keitaro-only closed-day finalizer for safe manual recovery/testing. */
function finalizeKeitaroYesterdayData() {
  const date = getYesterday_();
  const reportRows = normalizeKeitaroReportRows_(getKeitaroReport_(date, date));
  const conversionRows = getKeitaroConversions_(date, date);
  appendKeitaroHistory_(reportRows, date, conversionRows);
  replaceKeitaroConversionsHistory_(conversionRows, date);
  return {date: date, campaigns: reportRows.length, conversions: conversionRows.length};
}

/** Fast Keitaro-only refresh for the operational offer dashboard. */
function refreshOffersToday() {
  return withRunLock_('refreshOffersToday', function () {
    assertTargetSpreadsheet_();
    updateKeitaroToday();
    const rows = rebuildOffersToday();
    console.log(JSON.stringify({offersToday: rows.length, checkedAt: new Date().toISOString()}));
    return rows.length;
  });
}

function updateAccountsToday(context) {
  const current = context || refreshDolphinCurrentState_();
  writeCurrentDolphinDatabases_(current);
  return current;
}

function rebuildTodayDashboard() {
  rebuildAllToday_();
  rebuildOffersToday();
  rebuildGeoAnalysis_();
  rebuildSpendAgent_();
  runTodayControl_();
}

function finalizeYesterday() {
  return dailyFinalization();
}

/** One-time safe copy of legacy raw tabs from CRM into source-specific files. */
function migrateLegacyStorage() {
  return withRunLock_('migrateLegacyStorage', function () {
    assertTargetSpreadsheet_();
    const central = SpreadsheetApp.openById(getStorageIds_().CRM);
    const names = [
      SHEETS.DB_CAMPAIGNS_TODAY, SHEETS.FB_HISTORY,
      SHEETS.DB_KEITARO_TODAY, SHEETS.KEITARO_HISTORY,
      SHEETS.DB_KEITARO_CONVERSIONS_TODAY, SHEETS.KEITARO_CONVERSIONS_HISTORY,
      SHEETS.DB_SOCIALS, SHEETS.DB_BMS, SHEETS.DB_CABS,
      SHEETS.DB_STRUCTURE_HISTORY, SHEETS.AGENTS, SHEETS.LOG
    ];
    const copied = [];

    names.forEach(function (name) {
      const source = central.getSheetByName(name);
      if (!source || source.getLastRow() < 1 || source.getLastColumn() < 1) return;
      const target = getOrCreateSheet_(name);
      const values = source.getRange(1, 1, source.getLastRow(), source.getLastColumn()).getValues();
      target.clearContents();
      target.getRange(1, 1, values.length, values[0].length).setValues(values);
      copied.push({sheet: name, rows: Math.max(values.length - 1, 0)});
    });

    logInfo_('migrateLegacyStorage', JSON.stringify(copied));
    console.log(JSON.stringify({copied: copied, checkedAt: new Date().toISOString()}));
    return copied;
  });
}

/** Safe smoke test: reads both APIs and never writes sheets or installs triggers. */
function testApiConnections() {
  const socials = getFbSocials_();
  const keitaroCampaigns = getKeitaroCampaigns_();
  const result = {
    dolphin: { ok: true, socials: Array.isArray(socials) ? socials.length : 0 },
    keitaro: { ok: true, campaigns: Array.isArray(keitaroCampaigns) ? keitaroCampaigns.length : 0 },
    checkedAt: new Date().toISOString()
  };
  console.log(JSON.stringify(result));
  return result;
}

/**
 * Read-only live schema check. It validates the endpoints used by the real
 * pipeline and logs only counts/field names, never tokens or full records.
 */
/**
 * Owner-authorized one-time bootstrap.
 * Verifies both live sources before enabling schedules, then recovers yesterday.
 */
function verifyInstallAndRecover() {
  const connections = testApiConnections();
  const mappings = testSourceMappings();

  if (!connections.dolphin.ok || connections.dolphin.socials < 1) {
    throw new Error('Dolphin verification failed: no socials returned');
  }
  if (!connections.keitaro.ok || connections.keitaro.campaigns < 1) {
    throw new Error('Keitaro verification failed: no campaigns returned');
  }
  if (!mappings.dolphin.socialFields.length || !mappings.keitaro.rowFields.length) {
    throw new Error('Live source mapping verification returned an empty schema');
  }

  PropertiesService.getScriptProperties().setProperty('CRM_PIPELINE_VERIFIED', 'true');
  installTriggers();
  dailyFinalization();

  return {
    verified: true,
    triggersInstalled: true,
    finalizedDate: getYesterday_(),
    checkedAt: new Date().toISOString()
  };
}

function testSourceMappings() {
  const today = getToday_();
  const socials = getFbSocials_();
  const businesses = getBusinesses_(today);
  const campaigns = getCampaigns_(today);
  const keitaroRaw = getKeitaroReport_(today, today);
  const keitaroRows = normalizeKeitaroReportRows_(keitaroRaw);

  const result = {
    date: today,
    dolphin: {
      socials: socials.length,
      businesses: businesses.length,
      campaigns: campaigns.length,
      socialFields: getObjectKeys_(socials[0]),
      businessFields: getObjectKeys_(businesses[0]),
      campaignFields: getObjectKeys_(campaigns[0])
    },
    keitaro: {
      rows: keitaroRows.length,
      rowFields: getObjectKeys_(keitaroRows[0])
    },
    checkedAt: new Date().toISOString()
  };

  console.log(JSON.stringify(result));
  return result;
}

/**
 * End-to-end test for today's campaign-level pipeline.
 * It never touches closed-day history or the legacy ALL sheet.
 */
function testCampaignPipeline() {
  return withRunLock_('testCampaignPipeline', function () {
    assertTargetSpreadsheet_();
    getRequiredScriptProperty_(SCRIPT_PROPERTIES.DOLPHIN_TOKEN);
    getRequiredScriptProperty_(SCRIPT_PROPERTIES.KEITARO_KEY);

    const fbContext = refreshDolphinCurrentState_();
    refreshFbToday_(fbContext);
    updateKeitaroToday();
    const seed = seedTestCampaignIds();
    rebuildAllToday_();
    rebuildOffersToday();
    rebuildGeoAnalysis_();
    rebuildSpendAgent_();
    runTodayControl_();

    const result = {
      fbCampaigns: countDataRows_(SHEETS.DB_CAMPAIGNS_TODAY),
      keitaroCampaigns: countDataRows_(SHEETS.DB_KEITARO_TODAY),
      allToday: countDataRows_(SHEETS.ALL_TODAY),
      offersToday: countDataRows_(SHEETS.OFFERS_TODAY),
      accountsToday: countDataRows_(SHEETS.DB_CABS),
      seededIds: seed.seeded,
      checkedAt: new Date().toISOString()
    };
    console.log(JSON.stringify(result));
    return result;
  });
}

function hourlyRefresh() {
  withRunLock_('hourlyRefresh', function () {
    // Today's pipeline must not depend on the schema of the closed-day ALL
    // history. The legacy ALL is migrated separately and remains read-only.
    assertTodayPipelineReady_();
    logInfo_('hourlyRefresh', 'START');

    // 1) Meta / Dolphin — сегодня
    const fbContext = refreshDolphinCurrentState_();
    refreshFbToday_(fbContext);

    // 2) Keitaro — сегодня
    updateKeitaroToday();

    // 3) Текущий ALL
    rebuildAllToday_();
    rebuildOffersToday();
    rebuildGeoAnalysis_();

    // 4) Быстрые проверки
    runTodayControl_();

    logInfo_('hourlyRefresh', 'DONE');
    ensureTopOfHourTrigger_();
  });
}

/**
 * Apps Script cannot guarantee execution at exactly :00.
 * This lightweight scheduler wakes every 5 minutes and performs one refresh
 * in the first ten minutes of each Minsk hour.
 */
function scheduledHourlyRefresh() {
  // The existing five-minute scheduler also services Telegram without another trigger.
  try {
    ensureTelegramWebhook_();
    processTelegramWebhookQueue_();
    processTelegramUpdates_();
    ensureTelegramPollingTrigger_();
  } catch (e) {
    logError_('Telegram polling', e);
  }

  const now = new Date();
  const minute = Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'm'));
  if (minute >= 10) return;

  const slot = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd-HH');
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('CRM_LAST_HOURLY_SLOT') === slot) return;

  hourlyRefresh();
  properties.setProperty('CRM_LAST_HOURLY_SLOT', slot);
}

function telegramPolling() {
  try {
    ensureTelegramWebhook_();
    runTelegramWorkerSmokeTestOnce_();
    processTelegramWebhookQueue_();
    processTelegramUpdates_();
  } catch (e) {
    logError_('Telegram polling', e);
  }
}

function ensureTelegramPollingTrigger_() {
  if (!isTelegramConfigured_()) return;
  const exists = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === 'telegramPolling';
  });
  if (!exists) {
    ScriptApp.newTrigger('telegramPolling').timeBased().everyMinutes(1).create();
    logInfo_('Telegram', 'One-minute polling trigger installed');
  }
}

function ensureTopOfHourTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  const hasScheduler = triggers.some(function (trigger) {
    return trigger.getHandlerFunction() === 'scheduledHourlyRefresh';
  });
  const legacy = triggers.filter(function (trigger) {
    return trigger.getHandlerFunction() === 'hourlyRefresh';
  });

  if (hasScheduler && legacy.length === 0) return;

  legacy.forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  if (!hasScheduler) {
    ScriptApp.newTrigger('scheduledHourlyRefresh')
      .timeBased()
      .everyMinutes(5)
      .create();
  }
  logInfo_('ensureTopOfHourTrigger', 'Hourly scheduler aligned to first 10 minutes');
}

function dailyFinalization() {
  withRunLock_('dailyFinalization', function () {
    assertCrmReady_();
    logInfo_('dailyFinalization', 'START');

    // Финально подтягиваем актуальную структуру и вчерашний FB.
    const fbContext = refreshDolphinCurrentState_();
    finalizeFacebookYesterday_(fbContext);

    // Финализируем Keitaro за вчера.
    finalizeKeitaroYesterdayData();

    // Фиксируем вчерашний ALL.
    finalizeAllYesterday_();
    rebuildGeoAnalysis_();

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
    refreshDolphinCurrentState_();
    refreshStructureFromDatabases_();
  });
}

function installTriggers() {
  assertTodayPipelineReady_();
  const handlers = new Set([
    'hourlyRefresh',
    'scheduledHourlyRefresh',
    'dailyFinalization'
  ]);

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (handlers.has(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('scheduledHourlyRefresh')
    .timeBased()
    .everyMinutes(5)
    .create();

  ScriptApp.newTrigger('dailyFinalization')
    .timeBased()
    .atHour(CONFIG.DAILY_HOUR)
    .everyDays(1)
    .inTimezone(CONFIG.TIMEZONE)
    .create();

  logInfo_('installTriggers', 'Triggers installed');
}

/** Readiness gate for live/today refreshes; it deliberately ignores ALL history. */
function assertTodayPipelineReady_() {
  assertTargetSpreadsheet_();
  getRequiredScriptProperty_(SCRIPT_PROPERTIES.DOLPHIN_TOKEN);
  getRequiredScriptProperty_(SCRIPT_PROPERTIES.KEITARO_KEY);
  if (PropertiesService.getScriptProperties().getProperty('CRM_PIPELINE_VERIFIED') !== 'true') {
    throw new Error('Live source mapping and pipeline verification required before scheduled runs');
  }
}

/** Read-only readiness gate: deployment never starts imports or installs triggers. */
function assertCrmReady_() {
  assertTargetSpreadsheet_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const all = ss.getSheetByName(SHEETS.ALL);
  if (all && all.getLastRow() > 0) {
    const headers = getAllHeaders_();
    const legacyWithStatuses = headers.concat(['Campaign Status Raw', 'Campaign Status']);
    const actual = all.getRange(1, 1, 1, all.getLastColumn()).getValues()[0];
    const matches = [headers, legacyWithStatuses].some(function (allowed) {
      return actual.length === allowed.length && actual.every(function (value, index) {
        return value === allowed[index];
      });
    });
    if (!matches) {
      throw new Error('CRM ALL migration required. Existing history has NOT been changed.');
    }
  }
  getRequiredScriptProperty_(SCRIPT_PROPERTIES.DOLPHIN_TOKEN);
  getRequiredScriptProperty_(SCRIPT_PROPERTIES.KEITARO_KEY);
  if (PropertiesService.getScriptProperties().getProperty('CRM_PIPELINE_VERIFIED') !== 'true') {
    throw new Error('Live source mapping and pipeline verification required before scheduled runs');
  }
}

function assertTargetSpreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss || ss.getId() !== getStorageIds_().CRM) {
    throw new Error('CRM target spreadsheet mismatch');
  }
}
