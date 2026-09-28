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

function writeKeitaroTodayDb_(reportRows, date, campaigns, conversionRows) {
  const timestamp = getCurrentTimestamp_();
  const statuses = {};
  const offerIdsByName = {};
  (campaigns || []).forEach(function (campaign) {
    statuses[String(pick_(campaign, ['id', 'campaign_id']) || '')] =
      String(pick_(campaign, ['state', 'status']) || 'UNKNOWN').toUpperCase();
  });
  (conversionRows || []).forEach(function (conversion) {
    const offerId = String(pick_(conversion, ['offer_id']) ||
      getDimensionId_(pick_(conversion, ['offer'])) || '').trim();
    const offerName = normalizeJoinName_(getDimensionLabel_(
      pick_(conversion, ['offer', 'offer_name'])
    ));
    if (offerId && offerName && !offerIdsByName[offerName]) {
      offerIdsByName[offerName] = offerId;
    }
  });
  let rows = reportRows.map(function (row) {
    const mapped = mapKeitaroCampaignRow_(row, date, timestamp);
    if (!mapped[11]) {
      mapped[11] = offerIdsByName[normalizeJoinName_(mapped[12])] || '';
    }
    return mapped;
  });
  rows = applyConversionMetrics_(rows, conversionRows || [], date, timestamp);
  rows.forEach(function (mapped) {
    mapped.push(statuses[String(mapped[16])] || 'UNKNOWN');
  });
  writeDbSheet_(SHEETS.DB_KEITARO_TODAY, getKeitaroTodayHeaders_(), rows, {
    textColumns: [5, 12, 17], numberColumns: [6, 7, 8, 9, 10, 14]
  });
}

function appendKeitaroHistory_(reportRows, date, conversionRows) {
  const sheet = getOrCreateSheet_(SHEETS.KEITARO_HISTORY);
  ensureAdditiveHeaders_(sheet, getKeitaroHeaders_());
  const timestamp = getCurrentTimestamp_();
  let rows = reportRows.map(function (row) {
    return mapKeitaroCampaignRow_(row, date, timestamp);
  });
  rows = applyConversionMetrics_(rows, conversionRows || [], date, timestamp);
  replaceRowsByDate_(sheet, getKeitaroHeaders_(), date, rows,
    {textColumns: [5, 12, 17], numberColumns: [6, 7, 8, 9, 10, 14]});
}

/**
 * report/build is authoritative for clicks/unique clicks, while the conversion
 * log is authoritative for registrations, deposits and revenue. Keitaro can
 * omit the first Minsk hours from report/build even when timezone is supplied.
 */
function applyConversionMetrics_(mappedReportRows, conversionRows, date, timestamp) {
  const rows = (mappedReportRows || []).map(function (row) {
    const copy = row.slice();
    copy[7] = 0;
    copy[8] = 0;
    copy[9] = 0;
    return copy;
  });
  const groups = aggregateConversionMetrics_(conversionRows || []);

  Object.keys(groups).forEach(function (key) {
    const metric = groups[key];
    const candidates = rows.map(function (row, index) {
      return {row: row, index: index};
    }).filter(function (candidate) {
      const row = candidate.row;
      const sameCampaign = isValidCampaignId_(metric.campaignId)
        ? String(row[4] || '') === metric.campaignId
        : normalizeJoinName_(row[3]) === metric.campaignName;
      if (!sameCampaign || normalizeJoinName_(row[3]) !== metric.campaignName) return false;
      const rowOfferId = String(row[11] || '').trim();
      if (metric.offerId && rowOfferId) return metric.offerId === rowOfferId;
      return normalizeJoinName_(row[12]) === metric.offerName;
    });

    // When report/build splits the same offer by source, put conversions on the
    // largest matching traffic row. This preserves campaign totals without
    // duplicating a registration or deposit across report groups.
    candidates.sort(function (a, b) {
      return num_(b.row[6]) - num_(a.row[6]) || num_(b.row[5]) - num_(a.row[5]);
    });
    if (candidates.length) {
      const target = candidates[0].row;
      target[7] = num_(target[7]) + metric.reg;
      target[8] = num_(target[8]) + metric.ftd;
      target[9] = num_(target[9]) + metric.revenue;
      return;
    }

    // A conversion may exist even when report/build has no row (for example a
    // delayed deposit). Keep it as a zero-click synthetic row instead of losing it.
    rows.push([
      date, timestamp, metric.agent, metric.campaignLabel, metric.campaignId,
      0, 0, metric.reg, metric.ftd, metric.revenue, metric.source,
      metric.offerId, metric.offerLabel, 0,
      isValidCampaignId_(metric.campaignId) ? 'SUB4' : 'MISSING',
      JSON.stringify({source: 'conversion_log', conversion_ids: metric.conversionIds}),
      metric.keitaroCampaignId, metric.keitaroCampaign
    ]);
  });
  return rows;
}

function aggregateConversionMetrics_(conversionRows) {
  const groups = {};
  const seen = {};
  (conversionRows || []).forEach(function (row) {
    const conversionId = String(pick_(row, ['conversion_id', 'id']) || '').trim();
    const status = String(pick_(row, ['status']) || '').trim().toLowerCase();
    const fingerprint = conversionId || [
      pick_(row, ['sub_id', 'subid']), status,
      pick_(row, ['postback_datetime']), pick_(row, ['sale_datetime']),
      pick_(row, ['offer_id']), pick_(row, ['sub_id_4', 'sub4'])
    ].map(String).join('|');
    if (seen[fingerprint]) return;
    seen[fingerprint] = true;
    if (status !== 'lead' && status !== 'sale') return;

    const campaignId = String(pick_(row, ['sub_id_4', 'sub4']) || '').trim();
    const campaignLabel = String(pick_(row, ['sub_id_3', 'sub3']) || '').trim();
    const campaignName = normalizeJoinName_(campaignLabel);
    const offerId = String(pick_(row, ['offer_id']) || getDimensionId_(pick_(row, ['offer'])) || '').trim();
    const offerLabel = getDimensionLabel_(pick_(row, ['offer', 'offer_name']));
    const offerName = normalizeJoinName_(offerLabel);
    const key = [isValidCampaignId_(campaignId) ? campaignId : '', campaignName,
      offerId || offerName].join('|');
    if (!groups[key]) {
      groups[key] = {
        campaignId: campaignId, campaignName: campaignName, campaignLabel: campaignLabel,
        offerId: offerId, offerName: offerName, offerLabel: offerLabel,
        agent: pick_(row, ['sub_id_1', 'sub1']),
        source: getDimensionLabel_(pick_(row, ['source'])),
        keitaroCampaignId: String(pick_(row, ['campaign_id']) || getDimensionId_(pick_(row, ['campaign']))),
        keitaroCampaign: getDimensionLabel_(pick_(row, ['campaign', 'campaign_name'])),
        reg: 0, ftd: 0, revenue: 0, conversionIds: []
      };
    }
    const target = groups[key];
    if (status === 'lead') target.reg++;
    if (status === 'sale') {
      target.ftd++;
      target.revenue += num_(pick_(row, ['revenue']));
    }
    target.conversionIds.push(conversionId || fingerprint);
  });
  return groups;
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
