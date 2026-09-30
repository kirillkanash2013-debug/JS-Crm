/**
 * Инструменты песочницы Claude. Работают только в окружении 'claude'.
 *
 * doPost(?dev=1) выполняет действие из белого списка и возвращает JSON,
 * чтобы изменения можно было проверить без редактора Apps Script.
 * Секрет передаётся в теле запроса, не в URL.
 */

const DEV_SECRET_PROPERTY = 'CRM_CLAUDE_DEV_SECRET';

// Only whole pipelines and read-only checks; nothing here writes to Dolphin
// or Keitaro beyond the Dolphin stats sync the pipeline already requests.
const DEV_RUNNABLE = Object.freeze([
  'testApiConnections',
  'testSourceMappings',
  'updateToday',
  'updateFbToday',
  'updateKeitaroToday',
  'refreshOffersToday',
  'rebuildTodayDashboard',
  'hourlyRefresh',
  'dailyFinalization',
  'finalizeKeitaroYesterdayData',
  'refreshStructureOnly',
  'testCampaignPipeline',
  'verifyInstallAndRecover',
  'installSandboxTriggers',
  'installBotOnlySchedule',
  'removeAllTriggers',
  'alignSpreadsheetTimeZone',
  'rebuildSpendAgent_',
  'refreshStructureFromDatabases_',
  'createSandboxStorage',
  'migrateLegacyStorage',
  'removeMigratedDashboardTabs'
]);
// budgetSample is a dev action (not in DEV_RUNNABLE).

// Non-secret switches the sandbox may flip remotely.
const DEV_FLAGS = Object.freeze(['CRM_PIPELINE_VERIFIED', 'TELEGRAM_DELIVERY_MODE']);

const DEV_REQUIRED_PROPERTIES = Object.freeze([
  SCRIPT_PROPERTIES.DOLPHIN_TOKEN,
  SCRIPT_PROPERTIES.KEITARO_KEY,
  SCRIPT_PROPERTIES.TELEGRAM_BOT_TOKEN,
  SCRIPT_PROPERTIES.TELEGRAM_CHAT_ID
]);

/**
 * Запустить один раз вручную из редактора: выдаёт разрешения Google
 * и печатает секрет служебного входа в журнал выполнения.
 */
function setupClaudeEnvironment() {
  if (getCrmEnv_().name !== 'claude') throw new Error('Only for the Claude sandbox');
  assertTargetSpreadsheet_();
  alignSpreadsheetTimeZone();
  const p = PropertiesService.getScriptProperties();
  let secret = p.getProperty(DEV_SECRET_PROPERTY);
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    p.setProperty(DEV_SECRET_PROPERTY, secret);
  }
  const missing = DEV_REQUIRED_PROPERTIES.filter(function (name) {
    return !String(p.getProperty(name) || '').trim();
  });
  console.log(DEV_SECRET_PROPERTY + '=' + secret);
  console.log(missing.length
    ? 'Не заданы Свойства скрипта: ' + missing.join(', ')
    : 'Все обязательные Свойства скрипта заданы');
  return {secretCreated: true, missingProperties: missing};
}

/**
 * Timestamps are written as Minsk-time strings; a spreadsheet in another zone
 * parses them with the wrong offset. A new spreadsheet takes the owner's zone.
 */
function alignSpreadsheetTimeZone() {
  const ss = SpreadsheetApp.openById(getStorageIds_().CRM);
  const before = ss.getSpreadsheetTimeZone();
  if (before !== CONFIG.TIMEZONE) ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);
  return {before: before, after: ss.getSpreadsheetTimeZone()};
}

/**
 * One-time: creates the sandbox's source databases as separate spreadsheets,
 * mirroring prod (CRM dashboard + FB, Keitaro, accounts, logs files).
 * Idempotent: the IDs are kept in a Script Property. SpreadsheetApp.create
 * needs no Drive scope; the files land in My Drive root until moved.
 */
function createSandboxStorage() {
  if (getCrmEnv_().name !== 'claude') throw new Error('Only for the Claude sandbox');
  const p = PropertiesService.getScriptProperties();
  const existing = p.getProperty('CRM_SANDBOX_STORAGE');
  if (existing) return JSON.parse(existing);
  const names = {
    FB: 'CRM Claude — FB (Dolphin)',
    KEITARO: 'CRM Claude — Keitaro',
    ACCOUNTS: 'CRM Claude — Аккаунты и структура',
    LOGS: 'CRM Claude — Логи'
  };
  const ids = {};
  Object.keys(names).forEach(function (key) {
    const ss = SpreadsheetApp.create(names[key]);
    ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);
    ids[key] = ss.getId();
  });
  p.setProperty('CRM_SANDBOX_STORAGE', JSON.stringify(ids));
  return ids;
}

/**
 * After migrateLegacyStorage: drops raw DB tabs from the dashboard spreadsheet
 * once the routed copy holds at least as many rows. Sandbox only.
 */
function removeMigratedDashboardTabs() {
  if (getCrmEnv_().name !== 'claude') throw new Error('Only for the Claude sandbox');
  const crmId = getStorageIds_().CRM;
  const dashboard = SpreadsheetApp.openById(crmId);
  const removed = [];
  const kept = [];
  dashboard.getSheets().forEach(function (sheet) {
    const name = sheet.getName();
    const target = getStorageSpreadsheetForSheet_(name);
    if (target.getId() === crmId) return;
    const copy = target.getSheetByName(name);
    if (copy && copy.getLastRow() >= sheet.getLastRow()) {
      dashboard.deleteSheet(sheet);
      removed.push(name);
    } else {
      kept.push(name);
    }
  });
  return {removed: removed, keptBecauseCopyMissing: kept};
}

/** Sandbox schedule: the normal CRM triggers plus one-minute Telegram polling. */
function installSandboxTriggers() {
  installTriggers();
  ensureTelegramPollingTrigger_();
  return listTriggers_();
}

/**
 * Bot-only schedule for the sandbox: removes every time-based trigger, then
 * installs just one-minute Telegram polling. No hourly refresh, so the bot
 * answers buttons quickly while spending the least trigger quota. Data is
 * refreshed by the "🔄 Обновить" button or the dev endpoint.
 */
function installBotOnlySchedule() {
  if (getCrmEnv_().name !== 'claude') throw new Error('Only for the Claude sandbox');
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  ensureTelegramPollingTrigger_();
  return listTriggers_();
}

/** Removes every time-based trigger in the sandbox (stops all quota use). */
function removeAllTriggers() {
  if (getCrmEnv_().name !== 'claude') throw new Error('Only for the Claude sandbox');
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  return listTriggers_();
}

function handleDevRequest_(e) {
  let request = {};
  try {
    request = JSON.parse(e.postData && e.postData.contents || '{}');
  } catch (_) {}
  const secret = String(PropertiesService.getScriptProperties()
    .getProperty(DEV_SECRET_PROPERTY) || '');
  if (!getCrmEnv_().devEndpoint || !secret || String(request.secret || '') !== secret) {
    return ContentService.createTextOutput('forbidden');
  }

  const startedAt = Date.now();
  let result;
  try {
    result = {ok: true, result: runDevAction_(request)};
  } catch (error) {
    result = {ok: false, error: String(error && error.message || error),
      stack: String(error && error.stack || '')};
  }
  result.action = String(request.action || '');
  result.ms = Date.now() - startedAt;
  recordDevRun_(request, result, startedAt);
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function runDevAction_(request) {
  const action = String(request.action || '');
  if (action === 'ping') {
    return {env: getCrmEnv_().name, scriptId: ScriptApp.getScriptId(),
      now: getCurrentTimestamp_()};
  }
  if (action === 'status') return getDevStatus_();
  if (action === 'run') return runDevFunction_(String(request.fn || ''));
  if (action === 'sheet') return readDevSheet_(request);
  if (action === 'telegram') return sendDevTelegramCommand_(String(request.text || ''));
  if (action === 'preview') return previewTelegramView_(String(request.view || ''));
  if (action === 'setFlag') return setDevFlag_(String(request.name || ''), request.value);
  if (action === 'clearSheet') return clearDevSheet_(String(request.name || ''));
  if (action === 'assignSocials') return assignDevSocials_(String(request.agent || ''));
  if (action === 'dolphinShape') return getDolphinShape_(String(request.entity || ''));
  if (action === 'budgetSample') return getCampaignBudgetSample_();
  if (action === 'statusSample') return getSpendingCampaignStatusSample_();
  if (action === 'offerTrace') return traceOffer_(String(request.q || ''));
  throw new Error('Unknown dev action: ' + action);
}

function runDevFunction_(name) {
  if (DEV_RUNNABLE.indexOf(name) < 0) throw new Error('Function is not allowlisted: ' + name);
  const fn = globalThis[name];
  if (typeof fn !== 'function') throw new Error('Function not found: ' + name);
  const value = fn();
  // Pipeline contexts can hold thousands of API records; return a bounded copy.
  const text = value === undefined ? '' : JSON.stringify(value);
  return text.length > 20000 ? {truncated: true, preview: text.slice(0, 20000)} :
    (text ? JSON.parse(text) : null);
}

function getDevStatus_() {
  const p = PropertiesService.getScriptProperties();
  const properties = {};
  DEV_REQUIRED_PROPERTIES.concat([DEV_SECRET_PROPERTY]).forEach(function (name) {
    properties[name] = Boolean(String(p.getProperty(name) || '').trim());
  });
  const flags = {};
  DEV_FLAGS.concat(['CRM_LAST_HOURLY_SLOT', 'TELEGRAM_WEBHOOK_URL']).forEach(function (name) {
    flags[name] = p.getProperty(name);
  });
  const sheets = SpreadsheetApp.openById(getStorageIds_().CRM).getSheets().map(function (sheet) {
    return {name: sheet.getName(), rows: sheet.getLastRow(), columns: sheet.getLastColumn()};
  });
  let devRuns = [];
  try { devRuns = JSON.parse(p.getProperty('CRM_DEV_RUNS') || '[]'); } catch (_) {}
  return {env: getCrmEnv_().name, properties: properties, flags: flags, devRuns: devRuns,
    triggers: listTriggers_(), sheets: sheets, now: getCurrentTimestamp_()};
}

// Google sometimes loses the web-app response after a redirect; this journal
// shows whether the request ran and how it ended.
function recordDevRun_(request, result, startedAt) {
  try {
    const p = PropertiesService.getScriptProperties();
    let runs = [];
    try { runs = JSON.parse(p.getProperty('CRM_DEV_RUNS') || '[]'); } catch (_) {}
    runs.push({at: new Date(startedAt).toISOString(), action: result.action,
      fn: String(request.fn || request.text || request.view || request.name || ''),
      ok: result.ok, ms: result.ms, error: result.error ? String(result.error).slice(0, 300) : ''});
    p.setProperty('CRM_DEV_RUNS', JSON.stringify(runs.slice(-15)));
  } catch (_) {}
}

function listTriggers_() {
  return ScriptApp.getProjectTriggers().map(function (trigger) {
    return {handler: trigger.getHandlerFunction(), type: String(trigger.getEventType())};
  });
}

function readDevSheet_(request) {
  const name = String(request.name || '');
  const sheet = getStorageSpreadsheetForSheet_(name).getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (!lastRow || !lastColumn) return {name: name, lastRow: 0, headers: [], rows: []};
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const limit = Math.min(Math.max(Number(request.limit) || 50, 1), 500);
  // A negative offset reads from the end, which is where fresh rows land.
  const dataRows = lastRow - 1;
  let offset = Number(request.offset) || 0;
  if (offset < 0) offset = Math.max(dataRows + offset, 0);
  offset = Math.min(offset, dataRows);
  const count = Math.min(limit, dataRows - offset);
  const rows = count > 0 ? sheet.getRange(2 + offset, 1, count, lastColumn).getValues() : [];
  return {name: name, lastRow: lastRow, offset: offset, headers: headers, rows: rows};
}

/** Sandbox-only: wipes a generated tab so the next pipeline run rebuilds it. */
function clearDevSheet_(name) {
  const sheet = getStorageSpreadsheetForSheet_(name).getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name);
  sheet.clear();
  return {cleared: name};
}

/**
 * Sandbox-only: puts every Dolphin social not yet on the "Соцы" tab under
 * one agent column. Existing manual assignments are kept.
 */
function assignDevSocials_(agent) {
  const agentIndex = CONFIG.STRUCTURE_AGENTS.indexOf(agent);
  if (agentIndex < 0) throw new Error('Unknown agent: ' + agent);
  const db = getStorageSpreadsheetForSheet_(SHEETS.DB_SOCIALS).getSheetByName(SHEETS.DB_SOCIALS);
  if (!db || db.getLastRow() < 2) throw new Error('DB_Socials is empty; run updateToday first');
  const names = db.getRange(2, 3, db.getLastRow() - 1, 1).getValues()
    .map(function (row) { return String(row[0] || '').trim(); }).filter(Boolean);

  ensureAgentsFromSocials_([]);
  const sheet = getOrCreateSheet_(SHEETS.SOCIALS);
  const width = CONFIG.STRUCTURE_AGENTS.length;
  const rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues() : [];
  const assigned = {};
  rows.forEach(function (row) {
    row.forEach(function (value) { assigned[normalizeJoinName_(value)] = true; });
  });
  const column = rows.map(function (row) { return row[agentIndex]; })
    .filter(function (value) { return String(value || '').trim(); });
  const added = names.filter(function (name) {
    const key = normalizeJoinName_(name);
    if (assigned[key]) return false;
    assigned[key] = true;
    return true;
  });
  const values = column.concat(added).map(function (name) { return [name]; });
  if (values.length) sheet.getRange(2, agentIndex + 1, values.length, 1).setValues(values);
  return {agent: agent, added: added, total: values.length};
}

/**
 * Field names only (two levels deep) of the first Dolphin record, to find
 * where a value lives. Values are never returned.
 */
/** Numbers only: budget/spend fields of up to 5 spending campaigns, to learn units. */
function getCampaignBudgetSample_() {
  const campaigns = getCampaigns_(getToday_());
  const sample = [];
  for (let i = 0; i < campaigns.length && sample.length < 5; i++) {
    const c = campaigns[i];
    if (getCampaignSpend_(c) <= 0) continue;
    sample.push({
      spend: getCampaignSpend_(c),
      daily_budget: c.daily_budget, lifetime_budget: c.lifetime_budget,
      budget_remaining: c.budget_remaining, currency: c.cab && c.cab.currency,
      objective: c.objective ? 'set' : ''
    });
  }
  return {count: campaigns.length, sample: sample};
}

/** Raw status values of campaigns that spent today, to fix status mapping. */
function getSpendingCampaignStatusSample_() {
  const campaigns = getCampaigns_(getToday_());
  const byStatus = {};
  let spending = 0;
  campaigns.forEach(function (c) {
    if (getCampaignSpend_(c) <= 0) return;
    spending++;
    const key = [getCampaignRawStatus_(c), String(c.status || ''),
      String(c.effective_status || ''), String(c.configured_status || '')].join(' | ');
    byStatus[key] = (byStatus[key] || 0) + 1;
  });
  return {spendingCampaigns: spending, rawStatusCombos: byStatus};
}

/**
 * For every Keitaro-today row whose offer name matches q: its FB campaign id,
 * inst/dep, and that campaign's spend today. Shows why an offer appears.
 */
function traceOffer_(q) {
  const query = q.toLowerCase();
  const camp = getOrCreateSheet_(SHEETS.DB_CAMPAIGNS_TODAY);
  const spendById = {};
  if (camp.getLastRow() > 1) {
    camp.getRange(2, 1, camp.getLastRow() - 1, 10).getValues().forEach(function (r) {
      const id = String(r[5] || '');
      if (id) spendById[id] = (spendById[id] || 0) + num_(r[7]);
    });
  }
  const kt = getOrCreateSheet_(SHEETS.DB_KEITARO_TODAY);
  const out = [];
  if (kt.getLastRow() > 1) {
    kt.getRange(2, 1, kt.getLastRow() - 1, getKeitaroHeaders_().length).getValues().forEach(function (r) {
      const offer = String(r[12] || '');
      if (query && offer.toLowerCase().indexOf(query) < 0) return;
      const id = String(r[4] || '');
      out.push({campaignId: id, campaign: String(r[3] || ''), offer: offer,
        inst: num_(r[6]), reg: num_(r[7]), dep: num_(r[8]),
        campaignSpendToday: spendById[id] === undefined ? null : spendById[id]});
    });
  }
  return {matches: out.length, rows: out.slice(0, 30)};
}

function getDolphinShape_(entity) {
  const today = getToday_();
  const loaders = {
    businesses: function () { return getBusinesses_(today); },
    cabs: function () { return getAllCabs_(today, today); },
    campaigns: function () { return getCampaigns_(today); }
  };
  if (!loaders[entity]) throw new Error('Unknown entity: ' + entity);
  const items = loaders[entity]();
  function shape(value) {
    if (Array.isArray(value)) return value.length ? ['[]', shape(value[0])] : '[]';
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).sort().forEach(function (key) {
        const child = value[key];
        out[key] = child && typeof child === 'object'
          ? (Array.isArray(child)
            ? ['[' + child.length + ']'].concat(child[0] && typeof child[0] === 'object'
              ? Object.keys(child[0]).sort() : [])
            : Object.keys(child).sort())
          : typeof child;
      });
      return out;
    }
    return typeof value;
  }
  return {entity: entity, count: items.length, shape: items.length ? shape(items[0]) : null};
}

function sendDevTelegramCommand_(text) {
  const chatId = getRequiredScriptProperty_(SCRIPT_PROPERTIES.TELEGRAM_CHAT_ID);
  telegramCommand_(chatId, text);
  return {sent: true, command: text};
}

function previewTelegramView_(view) {
  if (view === 'today') return telegramToday_();
  if (view === 'offers') return telegramOffers_();
  if (view === 'daily') return buildDailyTelegramReport_();
  throw new Error('Unknown view: ' + view);
}

function setDevFlag_(name, value) {
  if (DEV_FLAGS.indexOf(name) < 0) throw new Error('Flag is not allowlisted: ' + name);
  const p = PropertiesService.getScriptProperties();
  if (value === null || value === undefined || value === '') p.deleteProperty(name);
  else p.setProperty(name, String(value));
  return {name: name, value: p.getProperty(name)};
}
