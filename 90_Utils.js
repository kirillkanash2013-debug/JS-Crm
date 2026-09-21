/**
 * Общие служебные функции.
 */

function getRequiredScriptProperty_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value || !String(value).trim()) {
    throw new Error('Не найден Script Property: ' + name);
  }
  return String(value).trim();
}

function parseJsonResponseOrThrow_(response, label) {
  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(label + ' -> HTTP ' + code);
  }

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(label + ' -> invalid JSON');
  }
}

function buildQueryString_(params) {
  const parts = [];

  Object.keys(params || {}).forEach(function (key) {
    const value = params[key];

    if (value === undefined || value === null || value === '') return;

    if (Array.isArray(value)) {
      value.forEach(function (item) {
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(item));
      });
    } else {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    }
  });

  return parts.join('&');
}

function getOrCreateSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);

  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function writeDbSheet_(name, headers, rows, options) {
  options = options || {};
  const sheet = getOrCreateSheet_(name);

  sheet.clearContents();

  if (headers && headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  if (rows && rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  applyColumnFormats_(sheet, options);
}

function appendRows_(sheet, rows, options) {
  if (!rows || !rows.length) return;

  const start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
  applyColumnFormats_(sheet, options || {});
}

function ensureHeaders_(sheet, headers) {
  if (sheet.getLastRow() > 0) {
    const actual = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getValues()[0];
    if (actual.length !== headers.length || actual.some(function (v, i) { return v !== headers[i]; })) {
      throw new Error('Schema mismatch: ' + sheet.getName() + '. Migration required; existing data preserved.');
    }
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

function applyColumnFormats_(sheet, options) {
  (options.textColumns || []).forEach(function (column) {
    sheet.getRange(1, column, Math.max(sheet.getMaxRows(), 1), 1).setNumberFormat('@');
  });

  (options.numberColumns || []).forEach(function (column) {
    sheet.getRange(1, column, Math.max(sheet.getMaxRows(), 1), 1).setNumberFormat('0.00');
  });
}

function buildExistingKeySet_(sheet, columns) {
  const result = new Set();
  if (sheet.getLastRow() < 2) return result;

  const width = sheet.getLastColumn();
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();

  values.forEach(function (row) {
    const key = columns.map(function (column) {
      return String(row[column - 1] || '');
    }).join('|');

    result.add(key);
  });

  return result;
}

function getToday_() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function getYesterday_() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function getSixMonthsAgo_() {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function getCurrentTimestamp_() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

function filterSheetRowsByDate_(sheetName, date) {
  const sheet = getOrCreateSheet_(sheetName);
  if (sheet.getLastRow() < 2) return [];

  return sheet.getRange(
    2,
    1,
    sheet.getLastRow() - 1,
    sheet.getLastColumn()
  ).getValues().filter(function (row) {
    return String(row[0] || '') === String(date);
  });
}

function sumColumnByHeader_(sheetName, header) {
  const sheet = getOrCreateSheet_(sheetName);
  if (sheet.getLastRow() < 2) return 0;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = headers.indexOf(header);
  if (idx < 0) return 0;

  return sheet.getRange(2, idx + 1, sheet.getLastRow() - 1, 1)
    .getValues()
    .reduce(function (sum, row) {
      return sum + num_(row[0]);
    }, 0);
}

function num_(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeDiv_(a, b) {
  a = num_(a);
  b = num_(b);
  return b > 0 ? a / b : 0;
}

function round2_(value) {
  return Math.round((num_(value) + Number.EPSILON) * 100) / 100;
}

function pick_(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    if (obj && obj[keys[i]] !== undefined && obj[keys[i]] !== null) {
      return obj[keys[i]];
    }
  }
  return '';
}

function getObjectKeys_(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
}

function withRunLock_(name, fn) {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    throw new Error('Другой запуск уже выполняется: ' + name);
  }

  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function logInfo_(source, message) {
  Logger.log('[' + source + '] ' + message);

  try {
    const sheet = getOrCreateSheet_(SHEETS.LOG);
    ensureHeaders_(sheet, ['Timestamp', 'Source', 'Message']);
    sheet.appendRow([getCurrentTimestamp_(), source, message]);
  } catch (e) {
    Logger.log('LOG sheet error: ' + e.message);
  }
}

function paintStatusColumn_(sheet, column) {
  if (sheet.getLastRow() < 2) return;

  const range = sheet.getRange(2, column, sheet.getLastRow() - 1, 1);
  const backgrounds = range.getValues().map(function (row) {
    return [getStatusColor_(String(row[0] || '').toUpperCase())];
  });

  range.setBackgrounds(backgrounds);
}

function getStatusColor_(status) {
  if (['ACTIVE', 'OK', 'COMPLETED'].includes(status)) return '#d9ead3';
  if (['SELFIE', 'CHECKPOINT'].includes(status)) return '#f9cb9c';
  if (status === 'POLICY') return '#f4cccc';
  if (['DISABLED', 'BLOCKED', 'CLOSED'].includes(status)) return '#ea9999';
  if (status.includes('PENDING') || status.includes('REVIEW') || status === 'UNSETTLED') return '#fff2cc';
  if (['ERROR', 'UNKNOWN'].includes(status)) return '#d9d9d9';
  return '#ffffff';
}

function escapeHtml_(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Dolphin entity helpers
 */

function getSocialId_(social) {
  return String(social.fb_id || social.id || '');
}

function getSocialStatus_(social) {
  if (!social) return 'UNKNOWN';

  const text = [
    social.status,
    social.error_type,
    social.error_message,
    social.stats_sync_status,
    social.checkpoint_type,
    social.reason
  ].join(' ').toUpperCase();

  if (
    text.includes('SELFIE') ||
    text.includes('CHECKPOINT') ||
    text.includes('FACIAL') ||
    text.includes('FACE VERIFICATION')
  ) return 'SELFIE';

  if (Number(social.activity_block) === 1) return 'BLOCKED';
  if (text.includes('DISABLED')) return 'DISABLED';
  if (social.error_message) return 'ERROR';

  if (String(social.stats_sync_status || '').toUpperCase() === 'COMPLETED') {
    return 'OK';
  }

  return 'UNKNOWN';
}

function getBusinessId_(bm) {
  return String(bm.business_id || bm.id || '');
}

function getBusinessName_(bm) {
  return String(bm.name || bm.business_name || getBusinessId_(bm));
}

function getBusinessStatus_(bm) {
  if (!bm) return 'UNKNOWN';

  const text = [
    bm.status,
    bm.business_status,
    bm.account_status,
    bm.state,
    bm.error_type,
    bm.error_message,
    bm.reason
  ].join(' ').toUpperCase();

  if (text.includes('POLICY')) return 'POLICY';
  if (text.includes('DISABLED') || text.includes('BLOCKED')) return 'DISABLED';
  if (text.includes('ACTIVE')) return 'ACTIVE';
  if (bm.disabled === true) return 'DISABLED';
  if (bm.error_message) return 'ERROR';

  return 'UNKNOWN';
}

function getCabAccountId_(cab) {
  return String(cab.ad_account_id || cab.account_id || cab.id || '');
}

function getCabName_(cab) {
  return String(cab.name || cab.ad_account_name || getCabAccountId_(cab));
}

function getCabStatus_(cab) {
  if (!cab) return 'UNKNOWN';

  if (typeof cab.status === 'string' && cab.status) return cab.status.toUpperCase();
  if (typeof cab.account_status === 'string' && cab.account_status) return cab.account_status.toUpperCase();

  const raw = Number(cab.account_status || cab.status || 0);
  const map = {
    1: 'ACTIVE',
    2: 'DISABLED',
    3: 'UNSETTLED',
    7: 'PENDING_RISK_REVIEW',
    8: 'PENDING_SETTLEMENT',
    9: 'IN_GRACE_PERIOD',
    100: 'PENDING_CLOSURE',
    101: 'CLOSED'
  };

  return map[raw] || 'UNKNOWN';
}

function getCabSixMonthSpend_(cab) {
  const candidates = [
    cab && cab.stats && cab.stats.spend,
    cab && cab.statsTotal && cab.statsTotal.spend,
    cab && cab.statistics && cab.statistics.spend,
    cab && cab.spend
  ];

  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i] === undefined || candidates[i] === null || candidates[i] === '') continue;
    const n = Number(candidates[i]);
    if (Number.isFinite(n)) return n;
  }

  return 0;
}

function getCampaignSpend_(campaign) {
  return Number(campaign && campaign.stats && campaign.stats.spend) || 0;
}

function buildCabMap_(cabs) {
  const result = {};
  cabs.forEach(function (cab) {
    const id = getCabAccountId_(cab);
    if (id) result[id] = cab;
  });
  return result;
}

function getSocialMetaFromCab_(cab, socials) {
  let account = null;

  if (cab && Array.isArray(cab.accounts) && cab.accounts.length) {
    account = cab.accounts[0];
  } else if (cab && cab.account) {
    account = cab.account;
  }

  if (account) {
    const internalId = String(account.id || '');
    const fbId = String(account.fb_id || '');

    for (let i = 0; i < socials.length; i++) {
      const social = socials[i];

      if (
        (internalId && String(social.id || '') === internalId) ||
        (fbId && String(social.fb_id || '') === fbId)
      ) {
        return {
          id: getSocialId_(social),
          name: String(social.name || account.name || ''),
          status: getSocialStatus_(social)
        };
      }
    }

    return {
      id: String(account.fb_id || account.id || ''),
      name: String(account.name || ''),
      status: getSocialStatus_(account)
    };
  }

  if (socials.length === 1) {
    return {
      id: getSocialId_(socials[0]),
      name: String(socials[0].name || ''),
      status: getSocialStatus_(socials[0])
    };
  }

  return { id: '', name: '', status: 'UNKNOWN' };
}
