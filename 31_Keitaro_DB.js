/** Keitaro campaign-level DB. Grain: Date + FB Campaign ID (sub4). */

function getKeitaroHeaders_() {
  return ['Дата', 'Updated At', 'Agent', 'Campaign Name', 'FB Campaign ID',
    'Clicks', 'Inst', 'Reg', 'FTD', 'Revenue', 'Source', 'Offer', 'uEPC',
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
  return [date, timestamp, pick_(row, ['sub_id_1', 'sub1']),
    pick_(row, ['sub_id_3', 'sub3']), campaignId,
    num_(pick_(row, ['clicks'])),
    inst,
    num_(pick_(row, ['conversions'])),
    num_(pick_(row, ['sales'])),
    revenue,
    getDimensionLabel_(pick_(row, ['source', 'traffic_source', 'affiliate_network'])),
    getDimensionLabel_(pick_(row, ['offer', 'offer_name'])),
    directUepc === '' || directUepc === null || directUepc === undefined
      ? safeDiv_(revenue, inst)
      : num_(directUepc),
    campaignId ? 'SUB4' : 'MISSING', JSON.stringify(row)];
}

function writeKeitaroTodayDb_(reportRows, date) {
  const timestamp = getCurrentTimestamp_();
  const rows = reportRows.map(function (row) { return mapKeitaroCampaignRow_(row, date, timestamp); });
  writeDbSheet_(SHEETS.DB_KEITARO_TODAY, getKeitaroHeaders_(), rows, {
    textColumns: [5], numberColumns: [6, 7, 8, 9, 10, 13]
  });
}

function appendKeitaroHistory_(reportRows, date) {
  const sheet = getOrCreateSheet_(SHEETS.KEITARO_HISTORY);
  ensureHeaders_(sheet, getKeitaroHeaders_());
  const existing = buildExistingKeySet_(sheet, [1, 5, 4, 12]);
  const timestamp = getCurrentTimestamp_();
  const rows = reportRows.map(function (row) {
    return mapKeitaroCampaignRow_(row, date, timestamp);
  }).filter(function (row) {
    return !existing.has(String(row[0]) + '|' + String(row[4]) + '|' + String(row[3]) + '|' + String(row[11]));
  });
  appendRows_(sheet, rows, {textColumns: [5], numberColumns: [6, 7, 8, 9, 10, 13]});
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
    row[13] = realId ? 'TEST_NAME_MATCH' : 'TEST_SEED';
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

function normalizeJoinName_(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
