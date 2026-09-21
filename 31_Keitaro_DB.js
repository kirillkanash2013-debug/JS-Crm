/** Keitaro campaign-level DB. Grain: Date + FB Campaign ID (sub4). */

function getKeitaroHeaders_() {
  return ['Дата', 'Updated At', 'Agent', 'Campaign Name', 'FB Campaign ID',
    'Clicks', 'Inst', 'Reg', 'FTD', 'Revenue', 'Source', 'Offer ID', 'Offer', 'uEPC',
    'ID Source', 'Raw JSON'];
}

function refreshKeitaroToday_() {
  const date = getToday_();
  writeKeitaroTodayDb_(normalizeKeitaroReportRows_(getKeitaroReport_(date, date)), date);
}

function finalizeKeitaroYesterday_() {
  const date = getYesterday_();
  appendKeitaroHistory_(normalizeKeitaroReportRows_(getKeitaroReport_(date, date)), date);
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
    campaignId ? 'SUB4' : 'MISSING', JSON.stringify(row)];
}

function writeKeitaroTodayDb_(reportRows, date) {
  const timestamp = getCurrentTimestamp_();
  const rows = reportRows.map(function (row) { return mapKeitaroCampaignRow_(row, date, timestamp); });
  writeDbSheet_(SHEETS.DB_KEITARO_TODAY, getKeitaroHeaders_(), rows, {
    textColumns: [5, 12], numberColumns: [6, 7, 8, 9, 10, 14]
  });
}

function appendKeitaroHistory_(reportRows, date) {
  const sheet = getOrCreateSheet_(SHEETS.KEITARO_HISTORY);
  ensureHeaders_(sheet, getKeitaroHeaders_());
  const existing = buildExistingKeySet_(sheet, [1, 5, 4, 13]);
  const timestamp = getCurrentTimestamp_();
  const rows = reportRows.map(function (row) {
    return mapKeitaroCampaignRow_(row, date, timestamp);
  }).filter(function (row) {
    return !existing.has(String(row[0]) + '|' + String(row[4]) + '|' + String(row[3]) + '|' + String(row[12]));
  });
  appendRows_(sheet, rows, {textColumns: [5, 12], numberColumns: [6, 7, 8, 9, 10, 14]});
}

/** Test-only: seeds only today's temporary DB; the next refresh replaces it. */
function seedTestCampaignIds() {
  const kt = getOrCreateSheet_(SHEETS.DB_KEITARO_TODAY);
  const fb = getOrCreateSheet_(SHEETS.DB_CAMPAIGNS_TODAY);
  ensureHeaders_(kt, getKeitaroHeaders_());
  if (kt.getLastRow() < 2) throw new Error('Сначала обнови Keitaro Today');
  const fbByName = {};
  if (fb.getLastRow() > 1) {
    fb.getRange(2, 1, fb.getLastRow() - 1, 8).getValues().forEach(function (row) {
      const name = normalizeJoinName_(row[6]);
      if (name && row[5]) fbByName[name] = String(row[5]);
    });
  }
  const width = getKeitaroHeaders_().length;
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
