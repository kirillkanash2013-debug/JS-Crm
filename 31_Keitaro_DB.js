/** Keitaro campaign-level DB. Grain: Date + FB Campaign ID (sub4). */

function getKeitaroHeaders_() {
  return ['Дата', 'Updated At', 'Agent', 'Campaign Name', 'FB Campaign ID',
    'Clicks', 'Inst', 'Reg', 'FTD', 'Revenue', 'Source', 'Offer ID', 'Offer', 'uEPC',
    'ID Source', 'Raw JSON', 'Keitaro Campaign ID', 'Keitaro Campaign'];
}

function getKeitaroTodayHeaders_() {
  return getKeitaroHeaders_().concat(['Keitaro Campaign Status']);
}

function mapKeitaroCampaignRow_(row, date, timestamp) {
  const campaignId = String(pick_(row, ['sub_id_4', 'sub4']) || '');
  const inst = num_(pick_(row, ['campaign_unique_clicks', 'unique_clicks']));
  const revenue = num_(pick_(row, ['sale_revenue', 'revenue']));
  const directUepc = pick_(row, ['uepc', 'u_epc']);
  const offerValue = pick_(row, ['offer']);
  const offerId = String(pick_(row, ['offer_id', 'offerId']) || getDimensionId_(offerValue));
  return [date, timestamp, pick_(row, ['sub_id_1', 'sub1']),
    pick_(row, ['sub_id_3', 'sub3']), campaignId,
    num_(pick_(row, ['clicks'])),
    inst,
    num_(pick_(row, ['conversions'])),
    num_(pick_(row, ['sales'])),
    revenue,
    getDimensionLabel_(pick_(row, ['source', 'traffic_source', 'affiliate_network'])),
    offerId,
    getDimensionLabel_(offerValue || pick_(row, ['offer_name'])),
    directUepc === '' || directUepc === null || directUepc === undefined
      ? safeDiv_(revenue, inst)
      : num_(directUepc),
    isValidCampaignId_(campaignId) ? 'SUB4' : 'MISSING', JSON.stringify(row),
    String(pick_(row, ['campaign_id']) || getDimensionId_(pick_(row, ['campaign']))),
    getDimensionLabel_(pick_(row, ['campaign']))];
}

function getKeitaroConversionHeaders_() {
  return ['Дата', 'Updated At', 'Conversion ID', 'Keitaro SubID',
    'Keitaro Campaign ID', 'Keitaro Campaign', 'FB Campaign ID',
    'Agent', 'Ad Name', 'FB Campaign Name', 'Adset ID', 'Adset Name',
    'Offer ID', 'Offer', 'Affiliate Network', 'Country', 'Source', 'OS',
    'Revenue', 'Status', 'Original Status', 'Previous Status', 'TID',
    'Click At', 'Postback At', 'Sale At', 'Sale Period', 'Raw JSON'];
}

function mapKeitaroConversionRow_(row, date, timestamp) {
  return [date, timestamp,
    String(pick_(row, ['conversion_id', 'id']) || ''),
    String(pick_(row, ['sub_id', 'subid']) || ''),
    String(pick_(row, ['campaign_id']) || getDimensionId_(pick_(row, ['campaign']))),
    getDimensionLabel_(pick_(row, ['campaign', 'campaign_name'])),
    String(pick_(row, ['sub_id_4', 'sub4']) || ''),
    pick_(row, ['sub_id_1', 'sub1']), pick_(row, ['sub_id_2', 'sub2']),
    pick_(row, ['sub_id_3', 'sub3']), String(pick_(row, ['sub_id_5', 'sub5']) || ''),
    pick_(row, ['sub_id_6', 'sub6']),
    String(pick_(row, ['offer_id']) || getDimensionId_(pick_(row, ['offer']))),
    getDimensionLabel_(pick_(row, ['offer', 'offer_name'])),
    getDimensionLabel_(pick_(row, ['affiliate_network'])),
    getDimensionLabel_(pick_(row, ['country_code', 'country'])),
    getDimensionLabel_(pick_(row, ['source'])), getDimensionLabel_(pick_(row, ['os'])),
    num_(pick_(row, ['revenue'])), pick_(row, ['status']),
    pick_(row, ['original_status']), pick_(row, ['previous_status']),
    String(pick_(row, ['tid']) || ''), pick_(row, ['click_datetime']),
    pick_(row, ['postback_datetime']), pick_(row, ['sale_datetime']),
    pick_(row, ['sale_period']), JSON.stringify(row)];
}

function getKeitaroConversionFormatOptions_() {
  return {textColumns: [1, 2, 3, 4, 5, 7, 8, 10, 11, 13, 23, 24, 25, 26],
    numberColumns: [19]};
}

function writeKeitaroConversionsTodayDb_(conversionRows, date) {
  const timestamp = getCurrentTimestamp_();
  const rows = conversionRows.map(function (row) {
    return mapKeitaroConversionRow_(row, date, timestamp);
  });
  writeDbSheet_(SHEETS.DB_KEITARO_CONVERSIONS_TODAY,
    getKeitaroConversionHeaders_(), rows, getKeitaroConversionFormatOptions_());
}

function replaceKeitaroConversionsHistory_(conversionRows, date) {
  const timestamp = getCurrentTimestamp_();
  const rows = conversionRows.map(function (row) {
    return mapKeitaroConversionRow_(row, date, timestamp);
  });
  const sheet = getOrCreateSheet_(SHEETS.KEITARO_CONVERSIONS_HISTORY);
  replaceRowsByDate_(sheet, getKeitaroConversionHeaders_(), date, rows,
    getKeitaroConversionFormatOptions_());
}

function writeKeitaroTodayDb_(reportRows, date, campaigns) {
  const timestamp = getCurrentTimestamp_();
  const statuses = {};
  (campaigns || []).forEach(function (campaign) {
    statuses[String(pick_(campaign, ['id', 'campaign_id']) || '')] =
      String(pick_(campaign, ['state', 'status']) || 'UNKNOWN').toUpperCase();
  });
  const rows = reportRows.map(function (row) {
    const mapped = mapKeitaroCampaignRow_(row, date, timestamp);
    mapped.push(statuses[String(mapped[16])] || 'UNKNOWN');
    return mapped;
  });
  writeDbSheet_(SHEETS.DB_KEITARO_TODAY, getKeitaroTodayHeaders_(), rows, {
    textColumns: [5, 12, 17], numberColumns: [6, 7, 8, 9, 10, 14]
  });
}

function appendKeitaroHistory_(reportRows, date) {
  const sheet = getOrCreateSheet_(SHEETS.KEITARO_HISTORY);
  ensureAdditiveHeaders_(sheet, getKeitaroHeaders_());
  const timestamp = getCurrentTimestamp_();
  const rows = reportRows.map(function (row) {
    return mapKeitaroCampaignRow_(row, date, timestamp);
  });
  replaceRowsByDate_(sheet, getKeitaroHeaders_(), date, rows,
    {textColumns: [5, 12, 17], numberColumns: [6, 7, 8, 9, 10, 14]});
}

/** Test-only: seeds only today's temporary DB; the next refresh replaces it. */
function seedTestCampaignIds() {
  const kt = getOrCreateSheet_(SHEETS.DB_KEITARO_TODAY);
  const fb = getOrCreateSheet_(SHEETS.DB_CAMPAIGNS_TODAY);
  ensureHeaders_(kt, getKeitaroTodayHeaders_());
  if (kt.getLastRow() < 2) throw new Error('Сначала обнови Keitaro Today');
  const fbByName = {};
  if (fb.getLastRow() > 1) {
    fb.getRange(2, 1, fb.getLastRow() - 1, 8).getValues().forEach(function (row) {
      const name = normalizeJoinName_(row[6]);
      if (name && row[5]) fbByName[name] = String(row[5]);
    });
  }
  const width = getKeitaroTodayHeaders_().length;
  const values = kt.getRange(2, 1, kt.getLastRow() - 1, width).getValues();
  let seeded = 0;
  values.forEach(function (row, index) {
    const currentId = String(row[4] || '').trim();
    // Keitaro can return an unexpanded macro such as {Sub_id_4}. It is not a
    // real Campaign ID and must be replaced in this temporary test snapshot.
    if (currentId && !/^\{[^}]+\}$/.test(currentId)) return;
    const realId = fbByName[normalizeJoinName_(row[3])];
    row[4] = realId || ('TEST-KT-' + String(index + 1));
    row[14] = realId ? 'TEST_NAME_MATCH' : 'TEST_SEED';
    seeded++;
  });
  kt.getRange(2, 1, values.length, width).setValues(values);
  console.log(JSON.stringify({seeded: seeded, rows: values.length}));
  return {seeded: seeded, rows: values.length};
}

function getDimensionLabel_(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  return String(pick_(value, ['name', 'title', 'value', 'id']) || '');
}

function getDimensionId_(value) {
  if (!value || typeof value !== 'object') return '';
  return String(pick_(value, ['id', 'offer_id', 'value_id']) || '');
}

function normalizeJoinName_(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
