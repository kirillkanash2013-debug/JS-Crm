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
    'Updated At'
  ];

  const oldFrozenSpend = readFrozenPolicySpend_();
  const rows = [];

  cabs.forEach(function (cab) {
    const accountId = getCabAccountId_(cab);
    if (!accountId) return;

    const social = getSocialMetaFromCab_(cab, socials);
    const cabStatus = getCabStatus_(cab);
    const sixMonthSpend = getCabSixMonthSpend_(cab);

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
      updatedAt
    ]);
  });

  writeDbSheet_(SHEETS.DB_CABS, headers, rows, {
    textColumns: [1, 3, 6],
    numberColumns: [10, 11]
  });
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
