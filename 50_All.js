/**
 * ALL Сегодня и финальный ALL.
 *
 * Базовый join:
 *   новые данные -> FB Campaign ID == Keitaro sub4
 * fallback для старых данных -> Campaign Name
 */

function rebuildAllToday_() {
  const fbSheet = getOrCreateSheet_(SHEETS.DB_CAMPAIGNS_TODAY);
  const ktSheet = getOrCreateSheet_(SHEETS.DB_KEITARO_TODAY);

  const rows = buildAllRowsFromSheets_(fbSheet, ktSheet, true).filter(function (row) {
    return num_(row[5]) > 0;
  });

  writeDbSheet_(SHEETS.ALL_TODAY, getAllTodayHeaders_(), rows, {
    textColumns: [3, 4, 5],
    numberColumns: [6, 7, 8, 9, 10, 11, 12, 13]
  });
}

function finalizeAllYesterday_() {
  const date = getYesterday_();

  const fbRows = filterSheetRowsByDate_(SHEETS.FB_HISTORY, date);
  const ktRows = filterSheetRowsByDate_(SHEETS.KEITARO_HISTORY, date);

  const rows = buildAllRowsFromArrays_(fbRows, ktRows, false).filter(function (row) {
    return num_(row[5]) > 0;
  });

  const sheet = getOrCreateSheet_(SHEETS.ALL);
  const headers = getAllHistoryHeaders_();
  ensureHeadersRemovingTrailing_(sheet, headers, ['Campaign Status Raw', 'Campaign Status']);
  replaceRowsByDate_(sheet, headers, date, rows, {
    textColumns: [3, 4, 5],
    numberColumns: [6, 7, 8, 9, 10, 11, 12, 13]
  });
}

function getAllHistoryHeaders_() {
  return [
    'Дата',
    'Agent',
    'Account ID',
    'Campaign ID',
    'Campaign',
    'Spend',
    'Inst',
    'Reg',
    'FTD',
    'Revenue',
    'CPI',
    'CPR',
    'CPD',
    'ROI',
    'Join Type'
  ];
}

function getAllTodayHeaders_() {
  return getAllHistoryHeaders_().concat(['Campaign Status Raw', 'Campaign Status']);
}

// Backward-compatible name used by readiness checks: ALL is closed history.
function getAllHeaders_() {
  return getAllHistoryHeaders_();
}

function buildAllRowsFromSheets_(fbSheet, ktSheet, includeStatus) {
  const fbRows = fbSheet.getLastRow() > 1
    ? fbSheet.getRange(2, 1, fbSheet.getLastRow() - 1, fbSheet.getLastColumn()).getValues()
    : [];

  const ktRows = ktSheet.getLastRow() > 1
    ? ktSheet.getRange(2, 1, ktSheet.getLastRow() - 1, getKeitaroHeaders_().length).getValues()
    : [];

  return buildAllRowsFromArrays_(fbRows, ktRows, includeStatus);
}

function buildAllRowsFromArrays_(fbRows, ktRows, includeStatus) {
  // Keitaro: key by FB Campaign ID, fallback by campaign name.
  const byId = {};
  const byName = {};

  ktRows.forEach(function (row) {
    const campaignName = String(row[3] || '');
    const campaignId = String(row[4] || '');

    const metrics = {
      inst: num_(row[6]),
      reg: num_(row[7]),
      ftd: num_(row[8]),
      revenue: num_(row[9])
    };

    if (isValidCampaignId_(campaignId)) byId[campaignId] = mergeMetrics_(byId[campaignId], metrics);
    // Name fallback is only for legacy rows where Campaign ID was not sent.
    const normalizedName = normalizeJoinName_(campaignName);
    if (!isValidCampaignId_(campaignId) && normalizedName) {
      byName[normalizedName] = mergeMetrics_(byName[normalizedName], metrics);
    }
  });

  const agentMapByAccount = getAccountAgentMap_();

  return fbRows.map(function (row) {
    const date = row[0];
    const accountId = String(row[4] || '');
    const campaignId = String(row[5] || '');
    const campaignName = String(row[6] || '');
    const spend = num_(row[7]);
    const campaignStatusRaw = String(row[8] || '');
    const campaignStatus = String(row[9] || 'UNKNOWN');

    let metrics = campaignId && byId[campaignId] ? byId[campaignId] : null;
    let joinType = metrics ? 'Campaign ID' : '';

    const normalizedName = normalizeJoinName_(campaignName);
    if (!metrics && normalizedName && byName[normalizedName]) {
      metrics = byName[normalizedName];
      joinType = 'Campaign Name fallback';
    }

    metrics = metrics || { inst: 0, reg: 0, ftd: 0, revenue: 0 };

    const cpi = safeDiv_(spend, metrics.inst);
    const cpr = safeDiv_(spend, metrics.reg);
    const cpd = safeDiv_(spend, metrics.ftd);
    const roi = spend > 0 ? ((metrics.revenue - spend) / spend) * 100 : 0;

    const result = [
      date,
      agentMapByAccount[accountId] || '',
      accountId,
      campaignId,
      campaignName,
      spend,
      metrics.inst,
      metrics.reg,
      metrics.ftd,
      metrics.revenue,
      cpi,
      cpr,
      cpd,
      roi,
      joinType
    ];
    if (includeStatus) result.push(campaignStatusRaw, campaignStatus);
    return result;
  });
}

function isValidCampaignId_(value) {
  const id = String(value || '').trim();
  return Boolean(id) && !/^\{[^}]+\}$/.test(id);
}

function getAccountAgentMap_() {
  const result = {};
  const cabSheet = getOrCreateSheet_(SHEETS.DB_CABS);
  const agentMap = getAgentMap_();

  if (cabSheet.getLastRow() < 2) return result;

  cabSheet.getRange(2, 1, cabSheet.getLastRow() - 1, 3).getValues().forEach(function (row) {
    const accountId = String(row[0] || '');
    const socialId = String(row[2] || '');
    if (accountId) result[accountId] = agentMap[socialId] || 'НЕ ОПРЕДЕЛЕН';
  });

  return result;
}

function mergeMetrics_(a, b) {
  a = a || { inst: 0, reg: 0, ftd: 0, revenue: 0 };
  return {
    inst: num_(a.inst) + num_(b.inst),
    reg: num_(a.reg) + num_(b.reg),
    ftd: num_(a.ftd) + num_(b.ftd),
    revenue: num_(a.revenue) + num_(b.revenue)
  };
}
