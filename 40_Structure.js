/**
 * История структуры + визуальные вкладки Farm / Fun / 2B.
 */

function ensureAgentsFromSocials_(socials) {
  const sheet = getOrCreateSheet_(SHEETS.SOCIALS);
  const headers = [
    'Social ID', 'Соц', 'Agent', 'Social Status',
    'Account IDs', 'Кабинеты', 'Кол-во кабинетов', 'Last Sync'
  ];

  const oldMap = {};
  const oldNames = {};
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.min(sheet.getLastColumn(), headers.length))
      .getValues().forEach(function (row) {
      const id = String(row[0] || '');
      if (id) {
        oldNames[id] = String(row[1] || '');
        oldMap[id] = String(row[2] || '');
      }
    });
  }

  // One-time compatibility with the former technical assignment sheet.
  const legacy = getStorageSpreadsheetForSheet_(SHEETS.AGENTS).getSheetByName(SHEETS.AGENTS);
  if (legacy && legacy.getLastRow() > 1) {
    legacy.getRange(2, 1, legacy.getLastRow() - 1, 3).getValues().forEach(function (row) {
      const id = String(row[0] || '');
      if (id && !oldMap[id]) oldMap[id] = String(row[2] || '');
      if (id && !oldNames[id]) oldNames[id] = String(row[1] || '');
    });
  }

  const cabsBySocial = {};
  const cabSheet = getStorageSpreadsheetForSheet_(SHEETS.DB_CABS).getSheetByName(SHEETS.DB_CABS);
  if (cabSheet && cabSheet.getLastRow() > 1) {
    cabSheet.getRange(2, 1, cabSheet.getLastRow() - 1, 13).getValues().forEach(function (row) {
      const socialId = String(row[2] || '');
      if (!socialId) return;
      if (!cabsBySocial[socialId]) cabsBySocial[socialId] = [];
      cabsBySocial[socialId].push({id: String(row[0] || ''), name: String(row[1] || '')});
    });
  }

  const currentIds = new Set();
  const rows = socials.map(function (social) {
    const id = getSocialId_(social);
    currentIds.add(id);
    const name = String(social.name || social.fb_name || '');
    const agent = oldMap[id] || inferAgentFromName_(name);
    const cabs = cabsBySocial[id] || [];

    return [
      id, name, agent, getSocialStatus_(social),
      cabs.map(function (cab) { return cab.id; }).join(', '),
      cabs.map(function (cab) { return cab.name || cab.id; }).join(', '),
      cabs.length,
      String(social.last_sync_date || '')
    ];
  });

  Object.keys(oldMap).forEach(function (id) {
    if (!currentIds.has(id)) rows.push([id, oldNames[id], oldMap[id], 'NO_ACCESS', '', '', 0, '']);
  });

  writeDbSheet_(SHEETS.SOCIALS, headers, rows, {
    textColumns: [1, 5]
  });

  sheet.setFrozenRows(1);
  paintStatusColumn_(sheet, 4);

  const agentRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(CONFIG.STRUCTURE_AGENTS.concat(['НЕ ОПРЕДЕЛЕН']), true)
    .setAllowInvalid(false)
    .build();
  if (rows.length) sheet.getRange(2, 3, rows.length, 1).setDataValidation(agentRule);
}

function inferAgentFromName_(name) {
  const s = String(name || '').toLowerCase();

  if (/(^|[\s_-])farm([\s_-]|$)/i.test(s)) return 'Farm';
  if (/(^|[\s_-])fun([\s_-]|$)/i.test(s)) return 'Fun';
  if (/(^|[\s_-])2b([\s_-]|$)/i.test(s)) return '2B';

  return 'НЕ ОПРЕДЕЛЕН';
}

function getAgentMap_() {
  const sheet = getOrCreateSheet_(SHEETS.SOCIALS);
  const result = {};

  if (sheet.getLastRow() < 2) return result;

  sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues().forEach(function (row) {
    const socialId = String(row[0] || '');
    if (socialId) result[socialId] = String(row[2] || 'НЕ ОПРЕДЕЛЕН');
  });

  return result;
}

function updateStructureHistoryFromCurrentDb_() {
  const cabSheet = getOrCreateSheet_(SHEETS.DB_CABS);
  if (cabSheet.getLastRow() < 2) return;

  const agentMap = getAgentMap_();
  const historySheet = getOrCreateSheet_(SHEETS.DB_STRUCTURE_HISTORY);

  const headers = [
    'Agent',
    'Social ID',
    'Соц',
    'Social Status',
    'BM ID',
    'BM Name',
    'BM Status',
    'Account ID',
    'Cabinet',
    'Cab Status',
    'Policy Spend',
    'First Seen',
    'Last Seen',
    'Current'
  ];

  let historyRows = [];
  if (historySheet.getLastRow() > 1) {
    historyRows = historySheet.getRange(
      2, 1, historySheet.getLastRow() - 1, headers.length
    ).getValues();

    historyRows.forEach(function (row) {
      row[13] = 'NO';
    });
  }

  const index = {};
  historyRows.forEach(function (row, i) {
    index[structureKey_(row[0], row[1], row[4], row[7])] = i;
  });

  const now = getCurrentTimestamp_();

  cabSheet.getRange(2, 1, cabSheet.getLastRow() - 1, 13).getValues().forEach(function (row) {
    const accountId = String(row[0] || '');
    const cabinet = String(row[1] || accountId);
    const socialId = String(row[2] || '');
    const socialName = String(row[3] || '');
    const socialStatus = String(row[4] || 'UNKNOWN');
    const bmId = String(row[5] || '');
    const bmName = String(row[6] || '');
    const bmStatus = String(row[7] || 'UNKNOWN');
    const cabStatus = String(row[8] || 'UNKNOWN');
    const policySpend = row[10];
    const agent = agentMap[socialId] || 'НЕ ОПРЕДЕЛЕН';

    const key = structureKey_(agent, socialId, bmId, accountId);

    if (cabStatus === 'NO_ACCESS') {
      if (index[key] !== undefined) {
        historyRows[index[key]][9] = 'NO_ACCESS';
        historyRows[index[key]][13] = 'NO';
      }
      return;
    }

    if (index[key] !== undefined) {
      const i = index[key];
      historyRows[i][2] = socialName;
      historyRows[i][3] = socialStatus;
      historyRows[i][5] = bmName;
      historyRows[i][6] = bmStatus;
      historyRows[i][8] = cabinet;
      historyRows[i][9] = cabStatus;
      if (policySpend !== '' && policySpend !== null) historyRows[i][10] = policySpend;
      historyRows[i][12] = now;
      historyRows[i][13] = 'YES';
    } else {
      index[key] = historyRows.length;
      historyRows.push([
        agent,
        socialId,
        socialName,
        socialStatus,
        bmId,
        bmName,
        bmStatus,
        accountId,
        cabinet,
        cabStatus,
        policySpend,
        now,
        now,
        'YES'
      ]);
    }
  });

  writeDbSheet_(SHEETS.DB_STRUCTURE_HISTORY, headers, historyRows, {
    textColumns: [2, 5, 8],
    numberColumns: [11],
    dateTimeColumns: [12, 13]
  });
}

function structureKey_(agent, socialId, bmId, accountId) {
  return [
    String(agent || ''),
    String(socialId || ''),
    String(bmId || 'NO_BM'),
    String(accountId || '')
  ].join('|');
}

function refreshStructureFromDatabases_() {
  updateStructureHistoryFromCurrentDb_();

  buildAgentStructureSheet_('Farm', SHEETS.FARM);
  buildAgentStructureSheet_('Fun', SHEETS.FUN);
  buildAgentStructureSheet_('2B', SHEETS.B2);
  buildAgentStructureSheet_('НЕ ОПРЕДЕЛЕН', SHEETS.UNASSIGNED);
}

function buildAgentStructureSheet_(agent, sheetName) {
  const history = getOrCreateSheet_(SHEETS.DB_STRUCTURE_HISTORY);
  const target = getOrCreateSheet_(sheetName);

  const headers = [
    'Структура',
    'ID',
    'Статус',
    'Spend POLICY',
    'Текущая связь',
    'Last Seen'
  ];

  if (history.getLastRow() < 2) {
    writeDbSheet_(sheetName, headers, [], {});
    return;
  }

  const data = history.getRange(2, 1, history.getLastRow() - 1, 14).getValues()
    .filter(function (row) {
      return String(row[0] || '') === agent;
    });

  const tree = {};

  data.forEach(function (row) {
    const socialId = String(row[1] || '');
    const socialName = String(row[2] || socialId || 'Без соца');
    const socialStatus = String(row[3] || 'UNKNOWN');
    const bmId = String(row[4] || '');
    const bmName = String(row[5] || bmId || 'Без BM');
    const bmStatus = String(row[6] || 'UNKNOWN');
    const accountId = String(row[7] || '');
    const cabName = String(row[8] || accountId);
    const cabStatus = String(row[9] || 'UNKNOWN');
    const policySpend = row[10];
    const lastSeen = String(row[12] || '');
    const current = String(row[13] || 'NO');

    if (!tree[socialId]) {
      tree[socialId] = {
        id: socialId,
        name: socialName,
        status: socialStatus,
        lastSeen: lastSeen,
        bms: {}
      };
    }

    if (lastSeen >= tree[socialId].lastSeen) {
      tree[socialId].status = socialStatus;
      tree[socialId].lastSeen = lastSeen;
    }

    const bmKey = bmId || 'NO_BM';

    if (!tree[socialId].bms[bmKey]) {
      tree[socialId].bms[bmKey] = {
        id: bmId,
        name: bmName,
        status: bmStatus,
        lastSeen: lastSeen,
        cabs: []
      };
    }

    if (lastSeen >= tree[socialId].bms[bmKey].lastSeen) {
      tree[socialId].bms[bmKey].status = bmStatus;
      tree[socialId].bms[bmKey].lastSeen = lastSeen;
    }

    tree[socialId].bms[bmKey].cabs.push({
      id: accountId,
      name: cabName,
      status: cabStatus,
      spend: policySpend,
      current: current,
      lastSeen: lastSeen
    });
  });

  const rows = [];

  Object.keys(tree).forEach(function (socialKey) {
    const social = tree[socialKey];

    rows.push([
      social.name,
      social.id,
      social.status,
      '',
      '',
      social.lastSeen
    ]);

    Object.keys(social.bms).forEach(function (bmKey) {
      const bm = social.bms[bmKey];

      rows.push([
        '└─ ' + bm.name,
        bm.id,
        bm.status,
        '',
        '',
        bm.lastSeen
      ]);

      bm.cabs.forEach(function (cab) {
        rows.push([
          '    └─ ' + cab.name,
          cab.id,
          cab.status,
          cab.spend,
          cab.current,
          cab.lastSeen
        ]);
      });
    });
  });

  writeDbSheet_(sheetName, headers, rows, {
    textColumns: [2],
    numberColumns: [4]
  });

  paintStatusColumn_(target, 3);
}
