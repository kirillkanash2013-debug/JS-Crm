/**
 * Только Keitaro Admin API.
 */

function getKeitaroApiKey_() {
  return getRequiredScriptProperty_(SCRIPT_PROPERTIES.KEITARO_KEY);
}

function keitaroGet_(path) {
  const url = CONFIG.KEITARO_API_BASE + '/' + String(path || '').replace(/^\/+/, '');

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Api-Key': getKeitaroApiKey_(),
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  });

  return parseJsonResponseOrThrow_(response, 'Keitaro GET ' + url);
}

function keitaroPost_(path, payload) {
  const url = CONFIG.KEITARO_API_BASE + '/' + String(path || '').replace(/^\/+/, '');

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Api-Key': getKeitaroApiKey_(),
      Accept: 'application/json'
    },
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  });

  return parseJsonResponseOrThrow_(response, 'Keitaro POST ' + url);
}

function getKeitaroCampaigns_() {
  const data = keitaroGet_('campaigns');
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.campaigns)) return data.campaigns;
  return [];
}

/**
 * Базовый отчёт.
 * Если твоя версия Keitaro использует немного другую схему payload —
 * меняем только эту функцию.
 *
 * Главный join для новых данных:
 * sub_id_4 == Facebook Campaign ID
 */
function getKeitaroReport_(dateFrom, dateTo) {
  const payload = {
    range: {
      from: dateFrom,
      to: dateTo,
      timezone: CONFIG.TIMEZONE
    },
    columns: ['campaign_id', 'campaign', 'sub_id_1', 'sub_id_3', 'sub_id_4', 'source', 'offer'],
    metrics: [
      'clicks',
      'campaign_unique_clicks',
      'conversions',
      'sales',
      'sale_revenue'
    ],
    grouping: ['campaign_id', 'campaign', 'sub_id_1', 'sub_id_3', 'sub_id_4', 'source', 'offer'],
    filters: []
  };

  // Для Keitaro обычно отчёты идут через report/build.
  // Если конкретная версия отдаст 404/422 — меняется только endpoint/payload здесь.
  return keitaroPost_('report/build', payload);
}

function normalizeKeitaroReportRows_(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.rows)) return raw.rows;
  if (raw && Array.isArray(raw.data)) return raw.data;
  if (raw && raw.data && Array.isArray(raw.data.rows)) return raw.data.rows;
  return [];
}

/** Full conversion log by postback date, with safe pagination. */
function getKeitaroConversions_(dateFrom, dateTo) {
  const pageSize = 5000;
  let offset = 0;
  let total = null;
  const result = [];

  do {
    const raw = keitaroPost_('conversions/log', {
      range: {from: dateFrom, to: dateTo, timezone: CONFIG.TIMEZONE},
      limit: pageSize,
      offset: offset,
      columns: [
        'conversion_id', 'sub_id', 'campaign_id', 'campaign',
        'offer_id', 'offer', 'affiliate_network', 'country_code', 'source', 'os',
        'revenue', 'status', 'original_status', 'previous_status', 'tid',
        'click_datetime', 'postback_datetime', 'sale_datetime', 'sale_period',
        'sub_id_1', 'sub_id_2', 'sub_id_3', 'sub_id_4', 'sub_id_5', 'sub_id_6'
      ],
      filters: [],
      sort: [
        {name: 'postback_datetime', order: 'ASC'},
        {name: 'conversion_id', order: 'ASC'}
      ]
    });
    const rows = normalizeKeitaroConversionRows_(raw);
    Array.prototype.push.apply(result, rows);
    total = raw && Number.isFinite(Number(raw.total)) ? Number(raw.total) : null;
    offset += rows.length;
    if (!rows.length || rows.length < pageSize) break;
  } while (total === null || offset < total);

  return result;
}

function normalizeKeitaroConversionRows_(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.rows)) return raw.rows;
  if (raw && Array.isArray(raw.data)) return raw.data;
  if (raw && raw.data && Array.isArray(raw.data.rows)) return raw.data.rows;
  return [];
}
