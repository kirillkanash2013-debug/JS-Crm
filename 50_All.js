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
    numberColumns: [6, 10, 11, 12, 13],
    integerColumns: [7, 8, 9],
    percentColumns: [14]
  });
}

function rebuildGeoAnalysis_() {
  const headers = [
    'Период', 'Дата', 'GEO', 'Agent', 'Offer ID', 'Оффер', 'Лендинг',
    'Spend', 'Inst', 'Reg', 'FTD', 'Revenue', 'CPI', 'CPR', 'CPD', 'ROI'
  ];
  const sources = [
    {all: getOrCreateSheet_(SHEETS.ALL_TODAY), keitaro: getOrCreateSheet_(SHEETS.DB_KEITARO_TODAY), period: 'Сегодня'},
    {all: getOrCreateSheet_(SHEETS.ALL), keitaro: getOrCreateSheet_(SHEETS.KEITARO_HISTORY), period: 'История'}
  ];
  let rows = [];
  sources.forEach(function (source) {
    rows = rows.concat(buildGeoOfferRows_(source.all, source.keitaro, source.period));
  });
  rows.sort(function (a, b) {
    return [String(a[1]), a[2], a[3], a[5], a[6]].join('|')
      .localeCompare([String(b[1]), b[2], b[3], b[5], b[6]].join('|'));
  });

  const target = getOrCreateSheet_(SHEETS.GEO_ANALYSIS);
  writeDbSheet_(SHEETS.GEO_ANALYSIS, headers, rows, {
    textColumns: [5],
    numberColumns: [8, 12, 13, 14, 15],
    integerColumns: [9, 10, 11],
    percentColumns: [16]
  });
  target.setFrozenRows(1);
}

function buildGeoOfferRows_(allSheet, keitaroSheet, period) {
  if (allSheet.getLastRow() < 2 || keitaroSheet.getLastRow() < 2) return [];
  const allWidth = allSheet.getLastColumn();
  const allHeaders = allSheet.getRange(1, 1, 1, allWidth).getValues()[0];
  const columns = getGeoSourceColumns_(allHeaders);
  const campaignIdColumn = allHeaders.map(function (x) { return String(x || '').trim().toLowerCase(); })
    .indexOf('campaign id');
  const allRows = allSheet.getRange(2, 1, allSheet.getLastRow() - 1, allWidth).getValues();
  const ktRows = keitaroSheet.getRange(2, 1, keitaroSheet.getLastRow() - 1, getKeitaroHeaders_().length).getValues();
  const campaignIndex = {};
  const spendGroups = {};

  allRows.forEach(function (row) {
    const date = normalizeDateKey_(row[columns.date]);
    const agent = String(row[columns.agent] || 'НЕ ОПРЕДЕЛЕН');
    const campaignId = campaignIdColumn >= 0 ? String(row[campaignIdColumn] || '') : '';
    const campaign = String(row[columns.campaign] || '');
    const geo = String(columns.geo >= 0 ? row[columns.geo] || '' : '') ||
      parseGeoFromCampaign_(campaign) || 'UNKNOWN';
    const info = {date: date, agent: agent, geo: geo};
    if (campaignId) campaignIndex['id|' + campaignId] = info;
    if (campaign) campaignIndex['name|' + normalizeJoinName_(campaign)] = info;
    const key = [date, geo, agent].join('|');
    spendGroups[key] = num_(spendGroups[key]) + num_(row[columns.spend]);
  });

  const offers = {};
  ktRows.forEach(function (row) {
    const campaignId = String(row[4] || '');
    const campaign = String(row[3] || '');
    const info = (isValidCampaignId_(campaignId) && campaignIndex['id|' + campaignId]) ||
      campaignIndex['name|' + normalizeJoinName_(campaign)];
    if (!info) return;
    const offerId = String(row[11] || '');
    const fullOffer = String(row[12] || '').trim();
    if (!fullOffer) return;
    const parts = splitOfferAndLanding_(fullOffer);
    const spendKey = [info.date, info.geo, info.agent].join('|');
    const key = [spendKey, offerId || fullOffer, parts.landing].join('|');
    if (!offers[key]) {
      offers[key] = {period: period, date: info.date, geo: info.geo, agent: info.agent,
        offerId: offerId, offer: parts.offer, landing: parts.landing,
        spendKey: spendKey, inst: 0, reg: 0, ftd: 0, revenue: 0};
    }
    offers[key].inst += num_(row[6]);
    offers[key].reg += num_(row[7]);
    offers[key].ftd += num_(row[8]);
    offers[key].revenue += num_(row[9]);
  });

  const totalInst = {};
  Object.keys(offers).forEach(function (key) {
    const x = offers[key];
    totalInst[x.spendKey] = num_(totalInst[x.spendKey]) + x.inst;
  });

  return Object.keys(offers).map(function (key) {
    const x = offers[key];
    const geoSpend = num_(spendGroups[x.spendKey]);
    const spend = totalInst[x.spendKey] > 0 ? geoSpend * x.inst / totalInst[x.spendKey] : 0;
    if (spend <= 0) return null;
    return [
      x.period, x.date, x.geo, x.agent, x.offerId, x.offer, x.landing,
      spend, x.inst, x.reg, x.ftd, x.revenue,
      safeDiv_(spend, x.inst), safeDiv_(spend, x.reg), safeDiv_(spend, x.ftd),
      ((x.revenue - spend) / spend) * 100
    ];
  }).filter(Boolean);
}

function splitOfferAndLanding_(value) {
  const parts = String(value || '').split('|').map(function (part) { return part.trim(); });
  return {offer: parts.shift() || '', landing: parts.join(' | ')};
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

  const baseRows = buildAllRowsFromArrays_(fbRows, ktRows, false).filter(function (row) {
    return num_(row[5]) > 0;
  });
  const rows = buildAllHistoryRows_(baseRows, ktRows);

  const sheet = getOrCreateSheet_(SHEETS.ALL);
  const headers = getAllHistoryHeaders_();
  ensureHeadersRemovingTrailing_(sheet, headers, ['Campaign Status Raw', 'Campaign Status']);
  replaceRowsByDate_(sheet, headers, date, rows, {
    textColumns: [2, 3],
    numberColumns: [9, 11, 13, 18, 19, 20],
    integerColumns: [8, 10, 12],
    ratioColumns: [14, 15, 16, 21]
  });

  writeDbSheet_(SHEETS.ALL_YESTERDAY, headers, rows, {
    textColumns: [2, 3],
    numberColumns: [9, 11, 13, 18, 19, 20],
    integerColumns: [8, 10, 12],
    ratioColumns: [14, 15, 16, 21]
  });
  rebuildSpendAgent_();
}

function getAllHistoryHeaders_() {
  return [
    'Дата', 'Аккаунт', 'Кампания', 'GEO', 'Аудитория', 'Крео', 'Дата крео',
    'I', 'CPI', 'R', 'CPR', 'D', 'CPD', 'I→R', 'R→D', 'I→D',
    'Тип записи', 'Спенд', 'Доход', 'Профит', 'ROI', 'Источник трафика', 'Агент'
  ];
}

function getAllTodayHeaders_() {
  return getAllBaseHeaders_().concat(['Campaign Status Raw', 'Campaign Status']);
}

function getAllBaseHeaders_() {
  return ['Дата', 'Agent', 'Account ID', 'Campaign ID', 'Campaign', 'Spend',
    'Inst', 'Reg', 'FTD', 'Revenue', 'CPI', 'CPR', 'CPD', 'ROI', 'Join Type'];
}

// Backward-compatible name used by readiness checks: ALL is closed history.
function getAllHeaders_() {
  return getAllHistoryHeaders_();
}

function buildAllHistoryRows_(baseRows, ktRows) {
  const sourcesById = {};
  const sourcesByName = {};
  (ktRows || []).forEach(function (row) {
    const id = String(row[4] || '');
    const name = normalizeJoinName_(row[3]);
    const source = String(row[10] || '');
    if (source && isValidCampaignId_(id)) sourcesById[id] = source;
    if (source && name) sourcesByName[name] = source;
  });
  return baseRows.map(function (row) {
    const campaign = String(row[4] || '');
    const inst = num_(row[6]);
    const reg = num_(row[7]);
    const ftd = num_(row[8]);
    const spend = num_(row[5]);
    const revenue = num_(row[9]);
    return [
      row[0], row[2], campaign, parseGeoFromCampaign_(campaign), 'All',
      parseCreativeFromCampaign_(campaign), '', inst, safeDiv_(spend, inst),
      reg, safeDiv_(spend, reg), ftd, safeDiv_(spend, ftd),
      safeDiv_(reg, inst), safeDiv_(ftd, reg), safeDiv_(ftd, inst),
      'Основной', spend, revenue, revenue - spend,
      spend > 0 ? (revenue - spend) / spend : 0,
      sourcesById[String(row[3] || '')] || sourcesByName[normalizeJoinName_(campaign)] || '',
      row[1]
    ];
  });
}

function parseCreativeFromCampaign_(campaign) {
  const parts = String(campaign || '').split(/[_\s]+/).filter(Boolean);
  if (parts.length < 2) return String(campaign || '');
  return parts.slice(1, Math.min(parts.length, 3)).join('_');
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

/** Monthly spend comparison: CRM is formula-driven; Table remains manual. */
function rebuildSpendAgent_() {
  const sheet = getOrCreateSheet_(SHEETS.SPEND_AGENT);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  let startColumn = 1;

  for (let column = 1; column <= Math.max(sheet.getLastColumn(), 1); column += 8) {
    const value = sheet.getRange(1, column).getValue();
    if (Object.prototype.toString.call(value) === '[object Date]' &&
        value.getFullYear() === monthStart.getFullYear() &&
        value.getMonth() === monthStart.getMonth()) {
      startColumn = column;
      break;
    }
    if (value) startColumn = column + 8;
  }

  const firstLetter = columnToLetter_(startColumn);
  const headers = [
    ['Месяц', 'Farm', '', 'Fun', '', '2B', ''],
    ['', 'Farm', 'Farm', 'Fun', 'Fun', '2B', '2B'],
    ['Дата', 'CRM', 'Table', 'CRM', 'Table', 'CRM', 'Table']
  ];
  sheet.getRange(1, startColumn, 3, 7).setValues(headers);
  sheet.getRange(1, startColumn).setValue(monthStart).setNumberFormat('mmmm yyyy');

  const dates = [];
  const formulas = [];
  for (let day = 1; day <= 31; day++) {
    const date = new Date(monthStart.getFullYear(), monthStart.getMonth(), day);
    const valid = date.getMonth() === monthStart.getMonth();
    dates.push([valid ? date : '']);
    const row = day + 3;
    const dateCell = '$' + firstLetter + row;
    formulas.push(CONFIG.STRUCTURE_AGENTS.reduce(function (cells, agent, index) {
      const agentColumn = columnToLetter_(startColumn + 1 + index * 2);
      cells.push('=IF(' + dateCell + '="";"";SUMIFS(ALL!$R:$R;ALL!$A:$A;' +
        dateCell + ';ALL!$W:$W;' + agentColumn + '$2))');
      cells.push(null);
      return cells;
    }, []));
  }
  sheet.getRange(4, startColumn, 31, 1).setValues(dates).setNumberFormat('dd.mm.yyyy');
  formulas.forEach(function (row, index) {
    row.forEach(function (formula, offset) {
      if (formula) sheet.getRange(index + 4, startColumn + 1 + offset).setFormula(formula);
    });
  });

  sheet.getRange(35, startColumn).setValue('Итого');
  for (let offset = 1; offset < 7; offset++) {
    const letter = columnToLetter_(startColumn + offset);
    sheet.getRange(35, startColumn + offset).setFormula('=SUM(' + letter + '4:' + letter + '34)');
  }
  sheet.getRange(1, startColumn, 35, 7).setVerticalAlignment('middle');
  sheet.getRange(1, startColumn, 3, 7).setFontWeight('bold').setBackground('#d9eaf7');
  sheet.getRange(35, startColumn, 1, 7).setFontWeight('bold').setBackground('#d9ead3');
  sheet.getRange(4, startColumn + 1, 32, 6).setNumberFormat('0.00');
  sheet.setFrozenRows(3);
  sheet.autoResizeColumns(startColumn, 7);
}

function columnToLetter_(column) {
  let result = '';
  while (column > 0) {
    column--;
    result = String.fromCharCode(65 + (column % 26)) + result;
    column = Math.floor(column / 26);
  }
  return result;
}
