/**
 * Контроль целостности данных.
 */

function runTodayControl_() {
  const checks = [];

  checks.push(checkSpendReconciliation_(SHEETS.DB_CAMPAIGNS_TODAY, SHEETS.ALL_TODAY));
  checks.push(checkDuplicateCampaigns_(SHEETS.DB_CAMPAIGNS_TODAY));
  checks.push(checkUnknownAgents_());
  checks.push(checkMissingKeitaroJoins_());

  writeControl_(checks);
}

function runDailyControl_() {
  const checks = [];

  checks.push(checkSpendReconciliation_(SHEETS.FB_HISTORY, SHEETS.ALL));
  checks.push(checkDuplicateCampaigns_(SHEETS.FB_HISTORY));
  checks.push(checkUnknownAgents_());

  writeControl_(checks);
}

function checkSpendReconciliation_(fbSheetName, allSheetName) {
  const fbSpend = sumColumnByHeader_(fbSheetName, 'Spend');
  const allSpend = sumColumnByHeader_(allSheetName, 'Spend');
  const diff = round2_(fbSpend - allSpend);

  return [
    getCurrentTimestamp_(),
    'Spend reconciliation',
    diff === 0 ? 'OK' : 'ERROR',
    fbSpend,
    allSpend,
    diff,
    ''
  ];
}

function checkDuplicateCampaigns_(sheetName) {
  const sheet = getOrCreateSheet_(sheetName);
  if (sheet.getLastRow() < 2) {
    return [getCurrentTimestamp_(), 'Duplicate Campaign IDs', 'OK', 0, 0, 0, ''];
  }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const dateIdx = headers.indexOf('Дата');
  const accountIdx = headers.indexOf('Account ID');
  const campaignIdx = headers.indexOf('Campaign ID');
  if (dateIdx < 0 || accountIdx < 0 || campaignIdx < 0) {
    return [getCurrentTimestamp_(), 'Duplicate Campaign IDs', 'WARN', '', '', '', 'Campaign ID header not found'];
  }

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const ids = values.filter(function (row) {
    return String(row[campaignIdx] || '') !== '';
  }).map(function (row) {
    return [row[dateIdx], row[accountIdx], row[campaignIdx]].map(String).join('|');
  });
  const seen = new Set();
  let duplicates = 0;

  ids.forEach(function (id) {
    if (!id) return;
    if (seen.has(id)) duplicates++;
    else seen.add(id);
  });

  return [
    getCurrentTimestamp_(),
    'Duplicate Campaign IDs',
    duplicates === 0 ? 'OK' : 'ERROR',
    ids.length,
    seen.size,
    duplicates,
    ''
  ];
}

function checkUnknownAgents_() {
  const map = getAgentMap_();
  const unknown = Object.keys(map).filter(function (id) {
    return !map[id] || map[id] === 'НЕ ОПРЕДЕЛЕН';
  });

  return [
    getCurrentTimestamp_(),
    'Unknown agents',
    unknown.length === 0 ? 'OK' : 'WARN',
    unknown.length,
    '',
    '',
    unknown.join(', ')
  ];
}

function checkMissingKeitaroJoins_() {
  const sheet = getOrCreateSheet_(SHEETS.ALL_TODAY);
  if (sheet.getLastRow() < 2) {
    return [getCurrentTimestamp_(), 'Missing Keitaro joins', 'OK', 0, '', '', ''];
  }

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 15).getValues();
  const missing = values.filter(function (row) {
    return !String(row[14] || '');
  });

  return [
    getCurrentTimestamp_(),
    'Missing Keitaro joins',
    missing.length === 0 ? 'OK' : 'WARN',
    missing.length,
    '',
    '',
    ''
  ];
}

function writeControl_(checks) {
  const headers = [
    'Timestamp',
    'Check',
    'Status',
    'Value 1',
    'Value 2',
    'Difference',
    'Details'
  ];

  writeDbSheet_(SHEETS.CONTROL, headers, checks, {});
}
