/**
 * Запись Keitaro в DB-листы.
 */

function refreshKeitaroToday_() {
  const date = getToday_();
  const raw = getKeitaroReport_(date, date);
  const rows = normalizeKeitaroReportRows_(raw);
  writeKeitaroTodayDb_(rows, date);
}

function finalizeKeitaroYesterday_() {
  const date = getYesterday_();
  const raw = getKeitaroReport_(date, date);
  const rows = normalizeKeitaroReportRows_(raw);
  appendKeitaroHistory_(rows, date);
}

function writeKeitaroTodayDb_(reportRows, date) {
  const headers = [
    'Дата',
    'Updated At',
    'Owner',
    'Ad Name',
    'Campaign Name',
    'FB Campaign ID',
    'Ad Set ID',
    'Ad Set Name',
    'Clicks',
    'Unique Clicks',
    'Conversions',
    'Sales',
    'Revenue',
    'Raw JSON'
  ];

  const now = getCurrentTimestamp_();

  const rows = reportRows.map(function (row) {
    return [
      date,
      now,
      pick_(row, ['sub_id_1', 'sub1']),
      pick_(row, ['sub_id_2', 'sub2']),
      pick_(row, ['sub_id_3', 'sub3']),
      String(pick_(row, ['sub_id_4', 'sub4']) || ''),
      String(pick_(row, ['sub_id_5', 'sub5']) || ''),
      pick_(row, ['sub_id_6', 'sub6']),
      num_(pick_(row, ['clicks'])),
      num_(pick_(row, ['campaign_unique_clicks', 'unique_clicks'])),
      num_(pick_(row, ['conversions'])),
      num_(pick_(row, ['sales'])),
      num_(pick_(row, ['sale_revenue', 'revenue'])),
      JSON.stringify(row)
    ];
  });

  writeDbSheet_(SHEETS.DB_KEITARO_TODAY, headers, rows, {
    textColumns: [6, 7],
    numberColumns: [9, 10, 11, 12, 13]
  });
}

function appendKeitaroHistory_(reportRows, date) {
  const headers = [
    'Дата',
    'Finalized At',
    'Owner',
    'Ad Name',
    'Campaign Name',
    'FB Campaign ID',
    'Ad Set ID',
    'Ad Set Name',
    'Clicks',
    'Unique Clicks',
    'Conversions',
    'Sales',
    'Revenue',
    'Raw JSON'
  ];

  const sheet = getOrCreateSheet_(SHEETS.KEITARO_HISTORY);
  ensureHeaders_(sheet, headers);

  const existing = buildExistingKeySet_(sheet, [1, 6, 5]);
  const now = getCurrentTimestamp_();
  const rows = [];

  reportRows.forEach(function (row) {
    const campaignId = String(pick_(row, ['sub_id_4', 'sub4']) || '');
    const campaignName = String(pick_(row, ['sub_id_3', 'sub3']) || '');
    const key = date + '|' + campaignId + '|' + campaignName;

    if (existing.has(key)) return;

    rows.push([
      date,
      now,
      pick_(row, ['sub_id_1', 'sub1']),
      pick_(row, ['sub_id_2', 'sub2']),
      campaignName,
      campaignId,
      String(pick_(row, ['sub_id_5', 'sub5']) || ''),
      pick_(row, ['sub_id_6', 'sub6']),
      num_(pick_(row, ['clicks'])),
      num_(pick_(row, ['campaign_unique_clicks', 'unique_clicks'])),
      num_(pick_(row, ['conversions'])),
      num_(pick_(row, ['sales'])),
      num_(pick_(row, ['sale_revenue', 'revenue'])),
      JSON.stringify(row)
    ]);
  });

  appendRows_(sheet, rows, {
    textColumns: [6, 7],
    numberColumns: [9, 10, 11, 12, 13]
  });
}

/**
 * Диагностика API Keitaro.
 * Запусти вручную, если report/build не совпадёт с версией Keitaro.
 */
function testKeitaroConnection() {
  const campaigns = getKeitaroCampaigns_();

  const headers = [
    'Keitaro Campaign ID',
    'Name',
    'Alias',
    'State',
    'Group ID',
    'Traffic Source ID',
    'Raw JSON'
  ];

  const rows = campaigns.map(function (c) {
    return [
      String(c.id || ''),
      c.name || '',
      c.alias || '',
      c.state || '',
      String(c.group_id || ''),
      String(c.traffic_source_id || c.source_id || ''),
      JSON.stringify(c)
    ];
  });

  writeDbSheet_('[DB_Keitaro_Test]', headers, rows, {
    textColumns: [1, 5, 6]
  });

  logInfo_('testKeitaroConnection', 'Campaigns: ' + rows.length);
}
