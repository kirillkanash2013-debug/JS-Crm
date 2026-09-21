/** TODAY offer performance. Source is the current Keitaro snapshot only. */

function rebuildOffersToday() {
  const source = getOrCreateSheet_(SHEETS.DB_KEITARO_TODAY);
  const headers = ['GEO', 'Offer ID', 'Offer', 'Inst', 'Reg', 'Dep', 'Revenue', 'uEPC'];
  const groups = {};
  const errors = [];

  if (source.getLastRow() > 1) {
    const width = getKeitaroHeaders_().length;
    const rows = source.getRange(2, 1, source.getLastRow() - 1, width).getValues();
    rows.forEach(function (row) {
      const campaign = String(row[3] || '');
      const offerId = String(row[11] || '').trim();
      const offer = String(row[12] || '').trim();
      // New traffic normally carries GEO in the campaign name. Older traffic
      // may still contain a literal {sub3}, so the offer name is the safe
      // secondary source for the operational offer dashboard.
      const geo = parseGeoFromCampaign_(campaign) || parseGeoFromCampaign_(offer);
      if (!geo || !offer) {
        errors.push([
          getCurrentTimestamp_(), 'OFFERS_TODAY', !geo ? 'UNKNOWN_GEO' : 'UNKNOWN_OFFER',
          String(row[4] || ''), campaign, offer, '', 'OPEN'
        ]);
        return;
      }
      const key = geo + '|' + (offerId || offer);
      const item = groups[key] || {geo: geo, offerId: offerId, offer: offer, inst: 0, reg: 0, dep: 0, revenue: 0};
      item.inst += num_(row[6]);
      item.reg += num_(row[7]);
      item.dep += num_(row[8]);
      item.revenue += num_(row[9]);
      groups[key] = item;
    });
  }

  const result = Object.keys(groups).map(function (key) {
    const item = groups[key];
    return [item.geo, item.offerId, item.offer, item.inst, item.reg, item.dep, item.revenue,
      safeDiv_(item.revenue, item.inst)];
  }).sort(function (a, b) {
    return String(a[0]).localeCompare(String(b[0])) || num_(b[7]) - num_(a[7]);
  });

  writeDbSheet_(SHEETS.OFFERS_TODAY, headers, result, {
    textColumns: [2], numberColumns: [4, 5, 6, 7, 8]
  });
  writeParsingErrors_(errors);
  return result;
}

function parseGeoFromCampaign_(campaignName) {
  const normalized = String(campaignName || '').trim().toUpperCase();
  if (!normalized) return '';
  const tokens = normalized.split(/[\s|_\-]+/).filter(Boolean);
  const pattern = new RegExp(CONFIG.GEO_TOKEN_PATTERN);
  for (let i = 0; i < tokens.length; i++) {
    if (pattern.test(tokens[i])) return tokens[i];
  }
  return '';
}

function writeParsingErrors_(rows) {
  const headers = ['Detected At', 'Module', 'Error Type', 'Campaign ID',
    'Campaign Name', 'Original Value', 'Correction', 'Status'];
  const sheet = getOrCreateSheet_(SHEETS.ERRORS);
  let preserved = [];
  if (sheet.getLastRow() > 1 && sheet.getLastColumn() >= headers.length) {
    preserved = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
      .filter(function (row) { return String(row[1] || '') !== 'OFFERS_TODAY'; });
  }
  writeDbSheet_(SHEETS.ERRORS, headers, preserved.concat(rows || []), {textColumns: [4]});
}

function appendCrmError_(module, type, entityId, entityName, message, correction) {
  const headers = ['Detected At', 'Module', 'Error Type', 'Campaign ID',
    'Campaign Name', 'Original Value', 'Correction', 'Status'];
  const sheet = getOrCreateSheet_(SHEETS.ERRORS);
  if (sheet.getLastRow() === 0) ensureHeaders_(sheet, headers);
  appendRows_(sheet, [[getCurrentTimestamp_(), module, type, entityId, entityName,
    message, correction || '', 'OPEN']], {textColumns: [4]});
}

/** Read-only helper for the future Telegram /offers command. */
function getOffersToday(geo) {
  const sheet = getOrCreateSheet_(SHEETS.OFFERS_TODAY);
  if (sheet.getLastRow() < 2) return [];
  const filterGeo = String(geo || '').trim().toUpperCase();
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues()
    .filter(function (row) { return !filterGeo || String(row[0]).toUpperCase() === filterGeo; });
}
