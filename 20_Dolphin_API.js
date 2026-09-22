/**
 * Только Dolphin API.
 * Никакой записи в Google Sheets в этом файле.
 */

function getDolphinToken_() {
  return getRequiredScriptProperty_(SCRIPT_PROPERTIES.DOLPHIN_TOKEN);
}

function dolphinGet_(pathOrUrl) {
  const url = /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : CONFIG.DOLPHIN_API_BASE + pathOrUrl;

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + getDolphinToken_(),
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  });

  return parseJsonResponseOrThrow_(response, 'Dolphin GET ' + url);
}

function dolphinPost_(path, payload) {
  const url = CONFIG.DOLPHIN_API_BASE + path;

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + getDolphinToken_(),
      Accept: 'application/json'
    },
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  });

  return parseJsonResponseOrThrow_(response, 'Dolphin POST ' + url);
}

function getFbSocials_() {
  const json = dolphinGet_('/fb-accounts?currency=' + encodeURIComponent(CONFIG.CURRENCY));
  return json.data || [];
}

function triggerDolphinSync_(socialInternalIds) {
  if (!socialInternalIds.length) return;

  dolphinPost_('/fb-accounts/sync', {
    accountsIds: socialInternalIds,
    diff_days: null
  });
}

function waitForDolphinSync_(oldSyncMap, socialInternalIds) {
  if (!socialInternalIds.length) return [];

  for (let attempt = 1; attempt <= CONFIG.DOLPHIN_SYNC_MAX_ATTEMPTS; attempt++) {
    Utilities.sleep(CONFIG.DOLPHIN_SYNC_POLL_MS);

    const socials = getFbSocials_();
    let readyCount = 0;

    socials.forEach(function (social) {
      const id = String(social.id || '');
      if (!socialInternalIds.includes(id)) return;

      const changed = String(social.last_sync_date || '') !== String(oldSyncMap[id] || '');
      const completed = String(social.stats_sync_status || '').toUpperCase() === 'COMPLETED';

      if (changed && completed) readyCount++;
    });

    logInfo_('waitForDolphinSync_', readyCount + '/' + socialInternalIds.length);

    if (readyCount === socialInternalIds.length) return socials;
  }

  throw new Error('Dolphin не успел обновить все соцы');
}

function getBusinesses_(date) {
  return dolphinPagedGet_('/fb-businesses', {
    from_date: date,
    to_date: date,
    currency: CONFIG.CURRENCY
  });
}

function getCampaigns_(date) {
  return dolphinPagedGet_('/fb-campaigns', {
    from_date: date,
    to_date: date,
    currency: CONFIG.CURRENCY,
    'aggregateColumns[]': ['spend'],
    with_trashed: 1,
    showArchivedCampaigns: 1,
    showArchivedAdAccount: 0,
    showAccountArchivedAdAccount: 0
  });
}

function getAllCabs_(fromDate, toDate) {
  return dolphinPagedGet_('/fb-cabs', {
    from_date: fromDate,
    to_date: toDate,
    currency: CONFIG.CURRENCY,
    'aggregateColumns[]': ['spend'],
    showArchivedAdAccount: 0,
    showAccountArchivedAdAccount: 0
  });
}

function getCabsForBusiness_(fromDate, toDate, bmId) {
  return dolphinPagedGet_('/fb-cabs', {
    from_date: fromDate,
    to_date: toDate,
    currency: CONFIG.CURRENCY,
    'aggregateColumns[]': ['spend'],
    showArchivedAdAccount: 0,
    showAccountArchivedAdAccount: 0,
    'bmIds[]': [String(bmId)]
  });
}

function dolphinPagedGet_(path, params) {
  const result = [];
  let page = 1;

  while (true) {
    const query = Object.assign({}, params || {}, {
      perPage: CONFIG.PAGE_SIZE,
      page: page
    });

    const url = CONFIG.DOLPHIN_API_BASE + path + '?' + buildQueryString_(query);
    const json = dolphinGet_(url);
    const items = json.data || [];

    Array.prototype.push.apply(result, items);

    const lastPage = json.meta && Number(json.meta.last_page || 0);
    if (!lastPage || page >= lastPage) break;
    page++;
  }

  return result;
}

function refreshDolphinCurrentState_() {
  const socialsBefore = getFbSocials_();
  if (!socialsBefore.length) {
    throw new Error('Dolphin не вернул ни одного FB-соца');
  }

  const oldSyncMap = {};
  const internalIds = [];

  socialsBefore.forEach(function (social) {
    const id = String(social.id || '');
    if (!id) return;
    oldSyncMap[id] = social.last_sync_date || '';
    internalIds.push(id);
  });

  triggerDolphinSync_(internalIds);
  const socials = waitForDolphinSync_(oldSyncMap, internalIds);

  const today = getToday_();
  const businesses = getBusinesses_(today);
  const cabs = resolveCurrentCabs_(getSixMonthsAgo_(), today, businesses);

  const context = {
    socials: socials,
    businesses: businesses,
    cabs: cabs,
    updatedAt: getCurrentTimestamp_()
  };

  writeCurrentDolphinDatabases_(context);
  return context;
}

function resolveCurrentCabs_(fromDate, toDate, businesses) {
  const bmMap = {};

  businesses.forEach(function (bm) {
    const id = getBusinessId_(bm);
    if (!id) return;

    bmMap[id] = {
      id: id,
      name: getBusinessName_(bm),
      status: getBusinessStatus_(bm)
    };
  });

  const candidates = {};

  getAllCabs_(fromDate, toDate).forEach(function (cab) {
    // The unfiltered list proves that the account exists, but it is not an
    // authoritative source of current BM membership. Nested BM data may be
    // stale after an account is removed from a BM.
    addCabCandidate_(candidates, cab, '', '', '', bmMap, false);
  });

  businesses.forEach(function (bm) {
    const bmId = getBusinessId_(bm);
    if (!bmId) return;

    getCabsForBusiness_(fromDate, toDate, bmId).forEach(function (cab) {
      addCabCandidate_(
        candidates,
        cab,
        bmId,
        getBusinessName_(bm),
        getBusinessStatus_(bm),
        bmMap,
        true
      );
    });
  });

  return Object.keys(candidates).map(function (accountId) {
    return chooseCurrentCabCandidate_(candidates[accountId]).cab;
  });
}

function addCabCandidate_(candidateMap, cab, resolvedBmId, resolvedBmName, resolvedBmStatus, bmMap, trustInternalBm) {
  const accountId = getCabAccountId_(cab);
  if (!accountId) return;

  const internalBm = getInternalBmFromCab_(cab);

  let bmId = resolvedBmId || '';
  let bmName = resolvedBmName || '';
  let bmStatus = resolvedBmStatus || '';

  if (trustInternalBm && internalBm.id) {
    bmId = internalBm.id;
    bmName = internalBm.name || (bmMap[internalBm.id] ? bmMap[internalBm.id].name : '');
    bmStatus = bmMap[internalBm.id] ? bmMap[internalBm.id].status : bmStatus;
  }

  cab._resolved_bm_id = bmId;
  cab._resolved_bm_name = bmName;
  cab._resolved_bm_status = bmStatus;

  let score = 0;
  if (trustInternalBm && internalBm.id && resolvedBmId && internalBm.id === resolvedBmId) score += 100;
  else if (trustInternalBm && internalBm.id) score += 80;
  else if (resolvedBmId) score += 50;

  if (Array.isArray(cab.accounts) && cab.accounts.length) score += 10;

  if (!candidateMap[accountId]) candidateMap[accountId] = [];
  candidateMap[accountId].push({
    cab: cab,
    score: score,
    sync: String(cab.last_sync_date || '')
  });
}

function chooseCurrentCabCandidate_(candidates) {
  if (!candidates || !candidates.length) return null;

  candidates.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.sync).localeCompare(String(a.sync));
  });

  return candidates[0];
}

function getInternalBmFromCab_(cab) {
  if (Array.isArray(cab.bms) && cab.bms.length) {
    const bm = cab.bms[0];
    return {
      id: String(bm.business_id || bm.id || ''),
      name: String(bm.name || bm.business_name || '')
    };
  }

  if (cab.bm) {
    return {
      id: String(cab.bm.business_id || cab.bm.id || ''),
      name: String(cab.bm.name || '')
    };
  }

  return { id: '', name: '' };
}
