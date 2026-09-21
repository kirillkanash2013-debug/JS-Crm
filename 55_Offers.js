/** TODAY offer performance. Source is the current Keitaro snapshot only. */

function rebuildOffersToday() {
  const source = getOrCreateSheet_(SHEETS.DB_KEITARO_TODAY);
  const headers = ['GEO', 'Offer', 'Inst', 'Reg', 'Dep', 'Revenue', 'uEPC'];
  const groups = {};
  const errors = [];

  if (source.getLastRow() > 1) {
    const width = getKeitaroHeaders_().length;
    const rows = source.getRange(2, 1, source.getLastRow() - 1, width).getValues();
    rows.forEach(function (row) {
      const campaign = String(row[3] || '');
      const geo = parseGeoFromCampaign_(campaign);
      const offer = String(row[11] || '').trim();
      if (!geo || !offer) {
        errors.push([
          getCurrentTimestamp_(), 'OFFERS_TODAY', !geo ? 'UNKNOWN_GEO' : 'UNKNOWN_OFFER',
          String(row[4] || ''), campaign, offer, '', 'OPEN'
        ]);
        return;
      }
      const key = geo + '|' + offer;
      const item = groups[key] || {geo: geo, offer: offer, inst: 0, reg: 0, dep: 0, revenue: 0};
      item.inst += num_(row[6]);
      item.reg += num_(row[7]);
      item.dep += num_(row[8]);
      item.revenue += num_(row[9]);
      groups[key] = item;
    });
  }

  const result = Object.keys(groups).map(function (key) {
    const item = groups[key];
    return [item.geo, item.offer, item.inst, item.reg, item.dep, item.revenue,
      safeDiv_(item.revenue, item.inst)];
  }).sort(function (a, b) {
    return String(a[0]).localeCompare(String(b[0])) || num_(b[6]) - num_(a[6]);
  });

  writeDbSheet_(SHEETS.OFFERS_TODAY, headers, result, {
    numberColumns: [3, 4, 5, 6, 7]
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
  writeDbSheet_(SHEETS.ERRORS, headers, rows || [], {textColumns: [4]});
}

/** Read-only helper for the future Telegram /offers command. */
function getOffersToday(geo) {
  const sheet = getOrCreateSheet_(SHEETS.OFFERS_TODAY);
  if (sheet.getLastRow() < 2) return [];
  const filterGeo = String(geo || '').trim().toUpperCase();
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues()
    .filter(function (row) { return !filterGeo || String(row[0]).toUpperCase() === filterGeo; });
}
