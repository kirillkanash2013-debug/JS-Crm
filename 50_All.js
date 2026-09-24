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

function rebuildGeoAnalysis_() {
  const headers = [
    'Период', 'Дата', 'GEO', 'Agent', 'Spend', 'Inst', 'Reg', 'FTD', 'Revenue',
    'CPI', 'CPR', 'CPD', 'ROI', 'Кампаний'
  ];
  const sources = [
    {sheet: getOrCreateSheet_(SHEETS.ALL_TODAY), period: 'Сегодня'},
    {sheet: getOrCreateSheet_(SHEETS.ALL), period: 'История'}
  ];
  const grouped = {};

  sources.forEach(function (source) {
    if (source.sheet.getLastRow() < 2) return;
    const sourceHeaders = source.sheet.getRange(1, 1, 1, source.sheet.getLastColumn()).getValues()[0];
    const columns = getGeoSourceColumns_(sourceHeaders);
    const values = source.sheet.getRange(
      2, 1, source.sheet.getLastRow() - 1, source.sheet.getLastColumn()
    ).getValues();
    values.forEach(function (row) {
      const date = row[columns.date];
      if (!date) return;
      const agent = String(row[columns.agent] || 'НЕ ОПРЕДЕЛЕН');
      const campaign = String(row[columns.campaign] || '');
      const geo = String(columns.geo >= 0 ? row[columns.geo] || '' : '') ||
        parseGeoFromCampaign_(campaign) || 'UNKNOWN';
      const metrics = {
        spend: num_(row[columns.spend]),
        inst: num_(row[columns.inst]),
        reg: num_(row[columns.reg]),
        ftd: num_(row[columns.ftd]),
        revenue: num_(row[columns.revenue]),
        campaign: campaign
      };
      addGeoAggregate_(grouped, source.period, date, geo, 'ALL', metrics);
      addGeoAggregate_(grouped, source.period, date, geo, agent, metrics);
    });
  });

  const rows = Object.keys(grouped).map(function (key) {
    const x = grouped[key];
    return [
      x.period, x.date, x.geo, x.agent, x.spend, x.inst, x.reg, x.ftd, x.revenue,
      safeDiv_(x.spend, x.inst), safeDiv_(x.spend, x.reg), safeDiv_(x.spend, x.ftd),
      x.spend > 0 ? ((x.revenue - x.spend) / x.spend) * 100 : 0,
      x.campaigns.size
    ];
  }).sort(function (a, b) {
    return [String(a[1]), a[2], a[3]].join('|').localeCompare([String(b[1]), b[2], b[3]].join('|'));
  });

  const target = getOrCreateSheet_(SHEETS.GEO_ANALYSIS);
  writeDbSheet_(SHEETS.GEO_ANALYSIS, headers, rows, {
    numberColumns: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
  });
  target.setFrozenRows(1);
}

function getGeoSourceColumns_(headers) {
  const normalized = headers.map(function (x) { return String(x || '').trim().toLowerCase(); });
  function find(names, required) {
    for (let i = 0; i < names.length; i++) {
      const index = normalized.indexOf(String(names[i]).toLowerCase());
      if (index >= 0) return index;
    }
    if (required) throw new Error('Не найдена колонка для GEO-анализа: ' + names.join(' / '));
    return -1;
  }
  return {
    date: find(['Дата', 'Date'], true),
    agent: find(['Agent', 'Агент'], true),
    campaign: find(['Campaign', 'Кампания', 'Campaign Name'], true),
    geo: find(['GEO', 'Geo'], false),
    spend: find(['Spend', 'Спенд'], true),
    inst: find(['Inst', 'I'], true),
    reg: find(['Reg', 'R'], true),
    ftd: find(['FTD', 'D'], true),
    revenue: find(['Revenue', 'Доход'], true)
  };
}

function addGeoAggregate_(grouped, period, date, geo, agent, metrics) {
  const key = [period, String(date), geo, agent].join('|');
  if (!grouped[key]) {
    grouped[key] = {
      period: period, date: date, geo: geo, agent: agent,
      spend: 0, inst: 0, reg: 0, ftd: 0, revenue: 0, campaigns: new Set()
    };
  }
  const x = grouped[key];
  x.spend += num_(metrics.spend);
  x.inst += num_(metrics.inst);
  x.reg += num_(metrics.reg);
  x.ftd += num_(metrics.ftd);
  x.revenue += num_(metrics.revenue);
  if (metrics.campaign) x.campaigns.add(String(metrics.campaign));
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
