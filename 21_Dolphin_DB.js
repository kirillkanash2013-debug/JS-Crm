/**
 * Запись Dolphin/Meta данных в Google Sheets.
 */

function writeCurrentDolphinDatabases_(context) {
  ensureAgentsFromSocials_(context.socials);
  writeSocialsDb_(context.socials, context.updatedAt);
  writeBmsDb_(context.businesses, context.socials, context.updatedAt);
  writeCabsDb_(context.cabs, context.socials, context.updatedAt);
  updateStructureHistoryFromCurrentDb_();
}

function refreshFbToday_(context) {
  const campaigns = getCampaigns_(getToday_());
  writeFbCampaignsTodayDb_(campaigns, context);
}

function finalizeFacebookYesterday_(context) {
  const date = getYesterday_();
  const campaigns = getCampaigns_(date);
  appendFbHistory_(campaigns, context, date);
}

function writeSocialsDb_(socials, updatedAt) {
  const headers = [
    'Social ID',
    'Dolphin Social UUID',
    'Соц',
    'Status',
    'Last Sync',
    'Error',
    'Updated At'
  ];

  const rows = socials.map(function (social) {
    return [
      getSocialId_(social),
      String(social.id || ''),
      String(social.name || social.fb_name || ''),
      getSocialStatus_(social),
      String(social.last_sync_date || ''),
      String(social.error_message || ''),
      updatedAt
    ];
  });

  writeDbSheet_(SHEETS.DB_SOCIALS, headers, rows, {
    textColumns: [1, 2]
  });
}

function writeBmsDb_(businesses, socials, updatedAt) {
  const headers = [
    'BM ID',
    'BM Name',
    'Social ID',
    'Status',
    'Updated At'
  ];

  const rows = businesses.map(function (bm) {
    const account = Array.isArray(bm.accounts) && bm.accounts.length ? bm.accounts[0] : null;
    const socialId = account ? String(account.fb_id || account.id || '') : '';

    return [
      getBusinessId_(bm),
      getBusinessName_(bm),
      socialId,
      getBusinessStatus_(bm),
      updatedAt
    ];
  });

  writeDbSheet_(SHEETS.DB_BMS, headers, rows, {
    textColumns: [1, 3]
  });
}

function writeCabsDb_(cabs, socials, updatedAt) {
  const headers = [
    'Account ID',
    'Cabinet',
    'Social ID',
    'Соц',
    'Social Status',
    'BM ID',
    'BM Name',
    'BM Status',
    'Cab Status',
    'Spend 6M',
    'Policy Spend Frozen',
    'Last Sync',
    'Updated At',
    'FIRST_SEEN_DATE',
    'START_BASELINE_SPEND',
    'OUR_LIFETIME_SPEND',
    'MISSING_SINCE',
    'Note'
  ];

  const previous = readCabSnapshot_();
  const oldFrozenSpend = readFrozenPolicySpend_();
  const rows = [];
  const currentIds = new Set();

  cabs.forEach(function (cab) {
    const accountId = getCabAccountId_(cab);
    if (!accountId) return;
    currentIds.add(accountId);

    const social = getSocialMetaFromCab_(cab, socials);
    const cabStatus = getCabStatus_(cab);
    const sixMonthSpend = getCabSixMonthSpend_(cab);
    const old = previous[accountId] || {};
    const firstSeen = old.FIRST_SEEN_DATE || updatedAt;
    const baseline = hasValue_(old.START_BASELINE_SPEND)
      ? num_(old.START_BASELINE_SPEND)
      : sixMonthSpend;
    const fallbackSpend = historicalSpendSinceFirstSeen_(accountId, firstSeen);
    const ourLifetimeSpend = calculateOurLifetimeSpend_(sixMonthSpend, baseline, fallbackSpend);

    let frozen = oldFrozenSpend[accountId] || '';
    if (!frozen && cabStatus === 'POLICY' && sixMonthSpend > 0) {
      frozen = sixMonthSpend;
    }

    rows.push([
      accountId,
      getCabName_(cab),
      social.id,
      social.name,
      social.status,
      String(cab._resolved_bm_id || ''),
      String(cab._resolved_bm_name || ''),
      String(cab._resolved_bm_status || 'UNKNOWN'),
      cabStatus,
      sixMonthSpend,
      frozen,
      String(cab.last_sync_date || ''),
      updatedAt,
      firstSeen,
      baseline,
      ourLifetimeSpend,
      '',
      ''
    ]);
  });

  // An account disappearing from Dolphin must not erase its last known state.
  // Keep it visible, mark NO_ACCESS and archive the transition once.
  Object.keys(previous).forEach(function (accountId) {
    if (currentIds.has(accountId)) return;
    const old = previous[accountId];
    const missingSince = old.MISSING_SINCE || updatedAt;
    const missing = headers.map(function (header) { return old[header] === undefined ? '' : old[header]; });
    missing[8] = 'NO_ACCESS';
    missing[12] = updatedAt;
    missing[16] = missingSince;
    missing[17] = 'Missing from current Dolphin snapshot; last known spend preserved.';
    rows.push(missing);

    if (String(old['Cab Status'] || '') !== 'NO_ACCESS') {
      recordMissingAccount_(headers, missing, old['Cab Status'], updatedAt);
    }
  });

  writeDbSheet_(SHEETS.DB_CABS, headers, rows, {
    textColumns: [1, 3, 6],
    numberColumns: [10, 11, 15, 16]
  });
}

function readCabSnapshot_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.DB_CABS);
  const result = {};
  if (!sheet || sheet.getLastRow() < 2) return result;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().forEach(function (row) {
    const item = {};
    headers.forEach(function (header, index) { item[String(header)] = row[index]; });
    const accountId = String(item['Account ID'] || '');
    if (accountId) result[accountId] = item;
  });
  return result;
}

function hasValue_(value) {
  return value !== '' && value !== null && value !== undefined;
}

function calculateOurLifetimeSpend_(currentCumulative, baseline, historicalFallback) {
  const current = Number(currentCumulative);
  const start = Number(baseline);
  if (Number.isFinite(current) && Number.isFinite(start) && current >= start) {
    return round2_(current - start);
  }
  return round2_(historicalFallback);
}

function historicalSpendSinceFirstSeen_(accountId, firstSeen) {
  const firstDate = String(firstSeen || '').slice(0, 10);
  let total = 0;
  [SHEETS.FB_HISTORY, SHEETS.DB_CAMPAIGNS_TODAY].forEach(function (sheetName) {
    const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) return;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const dateIndex = headers.indexOf('Дата');
    const accountIndex = headers.indexOf('Account ID');
    const spendIndex = headers.indexOf('Spend');
    if (dateIndex < 0 || accountIndex < 0 || spendIndex < 0) return;
    sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().forEach(function (row) {
      const date = String(row[dateIndex] || '').slice(0, 10);
      if (String(row[accountIndex] || '') === String(accountId) && (!firstDate || date >= firstDate)) {
        total += num_(row[spendIndex]);
      }
    });
  });
  return total;
}

function recordMissingAccount_(headers, row, oldStatus, detectedAt) {
  const suffix = String(detectedAt || getCurrentTimestamp_()).slice(0, 7).replace('-', '_');
  const events = getOrCreateSheet_('[ACCOUNT_EVENTS_' + suffix + ']');
  const eventHeaders = ['Event At', 'Entity Type', 'Entity ID', 'Event', 'Old Status', 'New Status', 'Spend Day', 'OUR_LIFETIME_SPEND', 'Note'];
  ensureHeaders_(events, eventHeaders);
  appendRows_(events, [[
    detectedAt, 'ACCOUNT', row[0], 'MISSING_FROM_SOURCE', oldStatus || '', 'NO_ACCESS',
    historicalSpendSinceFirstSeen_(row[0], String(row[13] || '')), row[15], row[17]
  ]], {textColumns: [3]});

  const history = getOrCreateSheet_('[ACCOUNTS_HISTORY_' + suffix + ']');
  ensureHeaders_(history, headers);
  appendRows_(history, [row], {textColumns: [1, 3, 6], numberColumns: [10, 11, 15, 16]});

  appendCrmError_('ACCOUNTS', 'ACCOUNT_MISSING', String(row[0] || ''), String(row[1] || ''),
    'Account disappeared; last known spend preserved.', 'Check Dolphin/BM access');
}

function writeFbCampaignsTodayDb_(campaigns, context) {
  const headers = [
    'Дата',
    'Updated At',
    'Social ID',
    'Соц',
    'Account ID',
    'Campaign ID',
    'Campaign',
    'Spend'
  ];

  const cabMap = buildCabMap_(context.cabs);
  const rows = [];

  campaigns.forEach(function (campaign) {
    const spend = getCampaignSpend_(campaign);
    if (spend <= 0) return;

    const accountId = String(campaign.account_id || '');
    const cab = cabMap[accountId] || campaign.cab || {};
    const social = getSocialMetaFromCab_(cab, context.socials);

    rows.push([
      getToday_(),
      context.updatedAt,
      social.id,
      social.name,
      accountId,
      String(campaign.campaign_id || campaign.id || ''),
      String(campaign.name || ''),
      spend
    ]);
  });

  writeDbSheet_(SHEETS.DB_CAMPAIGNS_TODAY, headers, rows, {
    textColumns: [3, 5, 6],
    numberColumns: [8]
  });
}

function appendFbHistory_(campaigns, context, date) {
  const headers = [
    'Дата',
    'Finalized At',
    'Social ID',
    'Соц',
    'Account ID',
    'Campaign ID',
    'Campaign',
    'Spend'
  ];

  const sheet = getOrCreateSheet_(SHEETS.FB_HISTORY);
  ensureHeaders_(sheet, headers);

  const existing = buildExistingKeySet_(sheet, [1, 5, 6]);
  const cabMap = buildCabMap_(context.cabs);
  const finalizedAt = getCurrentTimestamp_();
  const rows = [];

  campaigns.forEach(function (campaign) {
    const spend = getCampaignSpend_(campaign);
    if (spend <= 0) return;

    const campaignId = String(campaign.campaign_id || campaign.id || '');
    const accountId = String(campaign.account_id || '');
    const key = date + '|' + accountId + '|' + campaignId;
    if (existing.has(key)) return;
    const cab = cabMap[accountId] || campaign.cab || {};
    const social = getSocialMetaFromCab_(cab, context.socials);

    rows.push([
      date,
      finalizedAt,
      social.id,
      social.name,
      accountId,
      campaignId,
      String(campaign.name || ''),
      spend
    ]);
  });

  appendRows_(sheet, rows, {
    textColumns: [3, 5, 6],
    numberColumns: [8]
  });
}

function readFrozenPolicySpend_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.DB_CABS);
  const result = {};
  if (!sheet || sheet.getLastRow() < 2) return result;

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();
  values.forEach(function (row) {
    const accountId = String(row[0] || '');
    const spend = Number(row[10] || 0);
    if (accountId && Number.isFinite(spend) && spend > 0) {
      result[accountId] = spend;
    }
  });

  return result;
}
