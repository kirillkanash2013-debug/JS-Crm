const DOLPHIN_TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiYWMyZDNhZmFiMzc1MTg2NjA4Nzc1MDg0N2Q0M2QwOWFmOGQxOWFkYzVkYzIxYWUxYmFkOGFmYjUzNWU1ZWMwYmIwYWE0MzZhODBlODE4YWEiLCJpYXQiOjE3ODk4MzgzMDAuMjMzMzcxLCJuYmYiOjE3ODk4MzgzMDAuMjMzMzc2LCJleHAiOjE5NDc2MDQ3MDAuMjMxMDU0LCJzdWIiOiIzZjExY2I1MC00YzAyLTQ4OTMtYjM1Yi1hMGQzMjllZDE4N2YiLCJzY29wZXMiOltdfQ.OgnH0RkyS5SxkG1uCUv6rvKeN8LxbNzcNUMQzf__g3sHNxCoX0hbXMang4PlzeOLQJ9I6EfXoblHsiK1TkEU830bn1hy5oIqKaQVL7arBTkUZG6PLNNgc5FSnynwjg2W5v80f01n_hbS7fP5vxUNntzG1MkD6D2N7Ti9jF3PiM-76hRVlfdGLNoedUxiIQjOGhSztoVzdpJ7M_D1lIxZxN8qVkR0jhBXn3ogoWr40Fj7FFxzLK698vMSzH5z66fO81fOyY5CSLztOdUlbB2wzopVGoSYdi6hI_BTw0Bu4gHo0i3Dsz9590ovHTVaqx06RIxzu2DZUm6ikCYAsgPDnB94TU-HHaNqTtyfx9J0OX8NDNdojLLgdiC1b6dN9pJvk-oF4lMCpyIrUrHbwXZiI_y2Mx4vdDbfLJvgEaiHPxG33UVyt-W1BJL717P8d7fB9I0stuiYSMxrUnjbU65dHKbTQLFSabXRQpmdmsKjmv2jayuOxu9xPAymgjYG-w3NzmAzqEzyjnMCmo6wkfNm4BNSvC7HO4tKi-KVPTsKQR7RsOAqIkCR_IcQITyFJQGQI7Q_oFJw6ZXnAXcwXn54fiBUN1cqn_hv3ucPXsxnogFTCTcoVqpbcFsya6CZiLRKOgjNdEzjzVsErf9nuoAPYYjhRWWbczIHE_mCaUoZn4E';

const API_BASE = 'https://cloud.dolphin.tech/api/v1';
const TIMEZONE = 'Europe/Minsk';

const AGENTS = ['Farm', 'Fun', '2B'];


/* ============================================================
   ОСНОВНЫЕ ФУНКЦИИ
   ============================================================ */


/*
  РУЧНОЕ ОБНОВЛЕНИЕ.

  Можно запускать руками когда угодно.
  Делает то же самое, что часовое обновление.
*/
function manualRefresh() {
  hourlyRefresh();
}


/*
  КАЖДЫЙ ЧАС.

  Обновляем только оперативное состояние:
  - Dolphin
  - FB Сегодня
  - Кабинеты
  - История структуры
  - Farm / Fun / 2B

  FB История здесь НЕ трогаем.
*/
function hourlyRefresh() {

  Logger.log('=== HOURLY REFRESH START ===');

  const data =
    loadCurrentDolphinData();


  /*
    Сегодняшние кампании
  */

  const campaignsToday =
    getCampaignData(
      getToday()
    );


  writeTodaySheet(
    campaignsToday,
    data.socials,
    data.cabs
  );


  /*
    Текущая база кабинетов
  */

  writeCabinetsDatabase(
    data.socials,
    data.businesses,
    data.cabs
  );


  /*
    Историческая структура
  */

  updateStructureHistory();


  /*
    Визуальные структуры агентов
  */

  buildAllAgentStructures();


  Logger.log('=== HOURLY REFRESH DONE ===');
}


/*
  ЕЖЕДНЕВНО ОКОЛО 06:00.

  Здесь уже закрываем вчера.

  Позже сюда добавим:
  - Keitaro История
  - ALL
  - Контроль
  - TG отчёт
*/
function dailyFinalization() {

  Logger.log('=== DAILY FINALIZATION START ===');


  const data =
    loadCurrentDolphinData();


  /*
    Вчерашние кампании
  */

  const campaignsYesterday =
    getCampaignData(
      getYesterday()
    );


  appendHistory(
    campaignsYesterday,
    data.socials,
    data.cabs
  );


  /*
    Заодно обновляем текущую структуру
  */

  writeCabinetsDatabase(
    data.socials,
    data.businesses,
    data.cabs
  );


  updateStructureHistory();

  buildAllAgentStructures();


  /*
    ПОЗЖЕ:

    finalizeKeitaroYesterday();

    rebuildAllYesterday();

    runControlChecks();

    sendTelegramReport();
  */


  Logger.log('=== DAILY FINALIZATION DONE ===');
}


/* ============================================================
   ЗАГРУЗКА ВСЕХ ТЕКУЩИХ ДАННЫХ DOLPHIN
   ============================================================ */

function loadCurrentDolphinData() {

  /*
    1. Получаем соцы до синка
  */

  const socialsBefore =
    getFbSocials();


  if (
    !socialsBefore.length
  ) {

    throw new Error(
      'Dolphin не вернул ни одного FB-соца'
    );
  }


  const oldSyncMap = {};
  const socialIds = [];


  socialsBefore.forEach(
    function(social) {

      const id =
        String(
          social.id || ''
        );


      if (!id) return;


      oldSyncMap[id] =
        social.last_sync_date || '';


      socialIds.push(id);

    }
  );


  /*
    2. Обновляем ТОЛЬКО соцы
  */

  triggerDolphinSync(
    socialIds
  );


  /*
    3. Ждём реального завершения
  */

  waitForDolphinSync(
    oldSyncMap,
    socialIds
  );


  /*
    4. Получаем свежие данные
  */

  const socials =
    getFbSocials();


  /*
    Добавляем новые соцы
    во вкладку "Агенты".
  */

  ensureAgentsSheet(
    socials
  );


  const businesses =
    getBusinesses(
      getToday()
    );


  /*
    Берём кабинеты за последние 6 месяцев.

    Период нужен для Spend при POLICY.
  */

  const cabs =
    getCurrentCabs(
      getSixMonthsAgo(),
      getToday(),
      businesses
    );


  return {

    socials:
      socials,

    businesses:
      businesses,

    cabs:
      cabs

  };
}


/* ============================================================
   СОЦЫ
   ============================================================ */

function getFbSocials() {

  const url =
    API_BASE +
    '/fb-accounts' +
    '?currency=USD';


  const json =
    dolphinGet(
      url
    );


  return json.data || [];
}


/* ============================================================
   SYNC СОЦЕЙ
   ============================================================ */

function triggerDolphinSync(
  accountIds
) {

  const url =
    API_BASE +
    '/fb-accounts/sync';


  const payload = {

    accountsIds:
      accountIds,

    diff_days:
      null

  };


  const response =
    UrlFetchApp.fetch(
      url,
      {

        method:
          'post',

        contentType:
          'application/json',

        headers: {

          'Authorization':
            'Bearer ' +
            DOLPHIN_TOKEN,

          'Accept':
            'application/json'

        },

        payload:
          JSON.stringify(
            payload
          ),

        muteHttpExceptions:
          true

      }
    );


  const code =
    response.getResponseCode();


  if (
    code !== 200
  ) {

    throw new Error(
      'Dolphin Sync Error ' +
      code +
      ': ' +
      response.getContentText()
    );

  }
}


/* ============================================================
   ЖДЁМ SYNC
   ============================================================ */

function waitForDolphinSync(
  oldSyncMap,
  accountIds
) {

  const MAX_ATTEMPTS = 20;
  const WAIT_MS = 15000;


  for (
    let attempt = 1;
    attempt <= MAX_ATTEMPTS;
    attempt++
  ) {

    Utilities.sleep(
      WAIT_MS
    );


    const socials =
      getFbSocials();


    let readyCount = 0;


    socials.forEach(
      function(social) {

        const id =
          String(
            social.id || ''
          );


        if (
          !accountIds.includes(
            id
          )
        ) {
          return;
        }


        const oldDate =
          oldSyncMap[id] || '';


        const newDate =
          social.last_sync_date ||
          '';


        const syncStatus =
          String(
            social.stats_sync_status ||
            ''
          ).toUpperCase();


        if (
          newDate &&
          newDate !== oldDate &&
          syncStatus === 'COMPLETED'
        ) {

          readyCount++;

        }

      }
    );


    Logger.log(
      'Dolphin sync: ' +
      readyCount +
      '/' +
      accountIds.length
    );


    if (
      readyCount ===
      accountIds.length
    ) {

      Logger.log(
        'Все соцы обновились'
      );

      return;
    }

  }


  throw new Error(
    'Dolphin не успел обновить все соцы'
  );
}


/* ============================================================
   BUSINESS MANAGERS
   ============================================================ */

function getBusinesses(
  date
) {

  const result = [];

  let page = 1;

  const perPage = 100;


  while (true) {

    const url =
      API_BASE +
      '/fb-businesses' +

      '?perPage=' +
      perPage +

      '&page=' +
      page +

      '&from_date=' +
      date +

      '&to_date=' +
      date +

      '&currency=USD';


    const json =
      dolphinGet(
        url
      );


    const items =
      json.data || [];


    items.forEach(
      function(item) {

        result.push(
          item
        );

      }
    );


    if (
      !json.meta ||
      !json.meta.last_page ||
      page >=
        json.meta.last_page
    ) {

      break;
    }


    page++;
  }


  return result;
}


/* ============================================================
   ВСЕ КАБИНЕТЫ
   ============================================================ */

/*
  Мы специально делаем ДВА типа запросов:

  1. Все кабинеты вообще.
  2. Кабинеты каждого BM через bmIds[].

  Это нужно для корректной обработки переносов.
*/
function getCurrentCabs(
  fromDate,
  toDate,
  businesses
) {

  /*
    BM справочник
  */

  const bmMap = {};


  businesses.forEach(
    function(bm) {

      const bmId =
        getBusinessId(
          bm
        );


      if (!bmId) {
        return;
      }


      bmMap[bmId] = {

        id:
          bmId,

        name:
          getBusinessName(
            bm
          ),

        status:
          getBusinessStatus(
            bm
          ),

        raw:
          bm

      };

    }
  );


  /*
    Кандидаты одного и того же кабинета.

    Account ID может временно прилететь
    из нескольких BM при переносах.
  */

  const candidateMap = {};


  /*
    Сначала получаем вообще все кабинеты.
  */

  const allCabs =
    getAllCabs(
      fromDate,
      toDate
    );


  allCabs.forEach(
    function(cab) {

      addCabCandidate(
        candidateMap,
        cab,
        '',
        '',
        '',
        bmMap
      );

    }
  );


  /*
    Потом запрос по каждому BM.
  */

  businesses.forEach(
    function(bm) {

      const bmId =
        getBusinessId(
          bm
        );


      if (!bmId) {
        return;
      }


      const bmName =
        getBusinessName(
          bm
        );


      const bmStatus =
        getBusinessStatus(
          bm
        );


      const items =
        getCabsForBusiness(
          fromDate,
          toDate,
          bmId
        );


      items.forEach(
        function(cab) {

          addCabCandidate(
            candidateMap,
            cab,
            bmId,
            bmName,
            bmStatus,
            bmMap
          );

        }
      );

    }
  );


  /*
    Выбираем единственное
    АКТУАЛЬНОЕ положение кабинета.
  */

  const result = [];


  Object.keys(
    candidateMap
  ).forEach(
    function(accountId) {

      const candidates =
        candidateMap[
          accountId
        ];


      const winner =
        chooseCurrentCabCandidate(
          candidates
        );


      if (
        winner &&
        winner.cab
      ) {

        result.push(
          winner.cab
        );

      }

    }
  );


  Logger.log(
    'Уникальных текущих кабинетов: ' +
    result.length
  );


  return result;
}


/* ============================================================
   ВСЕ КАБИНЕТЫ БЕЗ ФИЛЬТРА BM
   ============================================================ */

function getAllCabs(
  fromDate,
  toDate
) {

  const result = [];

  let page = 1;

  const perPage = 100;


  while (true) {

    const url =
      API_BASE +
      '/fb-cabs' +

      '?perPage=' +
      perPage +

      '&page=' +
      page +

      '&from_date=' +
      fromDate +

      '&to_date=' +
      toDate +

      '&currency=USD' +

      '&aggregateColumns[]=spend' +

      '&showArchivedAdAccount=0' +

      '&showAccountArchivedAdAccount=0';


    const json =
      dolphinGet(
        url
      );


    const items =
      json.data || [];


    items.forEach(
      function(item) {

        result.push(
          item
        );

      }
    );


    if (
      !json.meta ||
      !json.meta.last_page ||
      page >=
        json.meta.last_page
    ) {

      break;
    }


    page++;
  }


  return result;
}


/* ============================================================
   КАБИНЕТЫ КОНКРЕТНОГО BM
   ============================================================ */

function getCabsForBusiness(
  fromDate,
  toDate,
  bmId
) {

  const result = [];

  let page = 1;

  const perPage = 100;


  while (true) {

    const url =
      API_BASE +
      '/fb-cabs' +

      '?perPage=' +
      perPage +

      '&page=' +
      page +

      '&from_date=' +
      fromDate +

      '&to_date=' +
      toDate +

      '&currency=USD' +

      '&aggregateColumns[]=spend' +

      '&showArchivedAdAccount=0' +

      '&showAccountArchivedAdAccount=0' +

      '&bmIds[]=' +
      encodeURIComponent(
        bmId
      );


    const json =
      dolphinGet(
        url
      );


    const items =
      json.data || [];


    items.forEach(
      function(item) {

        result.push(
          item
        );

      }
    );


    if (
      !json.meta ||
      !json.meta.last_page ||
      page >=
        json.meta.last_page
    ) {

      break;
    }


    page++;
  }


  return result;
}


/* ============================================================
   КАНДИДАТЫ РАЗМЕЩЕНИЯ КАБИНЕТА
   ============================================================ */

function addCabCandidate(
  candidateMap,
  cab,
  resolvedBmId,
  resolvedBmName,
  resolvedBmStatus,
  bmMap
) {

  const accountId =
    getCabAccountId(
      cab
    );


  if (!accountId) {
    return;
  }


  /*
    BM который сам Dolphin
    отдаёт внутри кабинета.
  */

  const internalBm =
    getInternalBmFromCab(
      cab
    );


  let finalBmId =
    resolvedBmId || '';


  let finalBmName =
    resolvedBmName || '';


  let finalBmStatus =
    resolvedBmStatus || '';


  /*
    Если внутри самого объекта
    Dolphin указан BM —
    считаем это более сильным сигналом.
  */

  if (
    internalBm.id
  ) {

    finalBmId =
      internalBm.id;


    finalBmName =
      internalBm.name ||
      (
        bmMap[
          internalBm.id
        ]
          ? bmMap[
              internalBm.id
            ].name
          : ''
      );


    finalBmStatus =
      bmMap[
        internalBm.id
      ]
        ? bmMap[
            internalBm.id
          ].status
        : finalBmStatus;

  }


  cab._resolved_bm_id =
    finalBmId;


  cab._resolved_bm_name =
    finalBmName;


  cab._resolved_bm_status =
    finalBmStatus;


  /*
    Насколько доверяем этому варианту.
  */

  let score = 0;


  if (
    internalBm.id &&
    resolvedBmId &&
    internalBm.id ===
      resolvedBmId
  ) {

    score += 100;

  }


  else if (
    internalBm.id
  ) {

    score += 80;

  }


  else if (
    resolvedBmId
  ) {

    score += 50;

  }


  if (
    Array.isArray(
      cab.accounts
    ) &&
    cab.accounts.length
  ) {

    score += 10;

  }


  if (
    !candidateMap[
      accountId
    ]
  ) {

    candidateMap[
      accountId
    ] = [];

  }


  candidateMap[
    accountId
  ].push({

    cab:
      cab,

    score:
      score,

    sync:
      String(
        cab.last_sync_date ||
        ''
      )

  });
}


/* ============================================================
   ВЫБИРАЕМ АКТУАЛЬНЫЙ BM ДЛЯ КАБИНЕТА
   ============================================================ */

function chooseCurrentCabCandidate(
  candidates
) {

  if (
    !candidates ||
    !candidates.length
  ) {

    return null;
  }


  candidates.sort(
    function(a, b) {

      if (
        b.score !==
        a.score
      ) {

        return (
          b.score -
          a.score
        );

      }


      return String(
        b.sync
      ).localeCompare(
        String(
          a.sync
        )
      );

    }
  );


  return candidates[0];
}


/* ============================================================
   BM ВНУТРИ CAB
   ============================================================ */

function getInternalBmFromCab(
  cab
) {

  if (
    Array.isArray(
      cab.bms
    ) &&
    cab.bms.length
  ) {

    const bm =
      cab.bms[0];


    return {

      id:
        String(
          bm.business_id ||
          bm.id ||
          ''
        ),

      name:
        String(
          bm.name ||
          bm.business_name ||
          ''
        )

    };
  }


  if (
    cab.bm
  ) {

    return {

      id:
        String(
          cab.bm.business_id ||
          cab.bm.id ||
          ''
        ),

      name:
        String(
          cab.bm.name ||
          ''
        )

    };
  }


  return {
    id: '',
    name: ''
  };
}


/* ============================================================
   КАМПАНИИ
   ============================================================ */

function getCampaignData(
  date
) {

  const result = [];

  let page = 1;

  const perPage = 100;


  while (true) {

    const url =
      API_BASE +
      '/fb-campaigns' +

      '?perPage=' +
      perPage +

      '&page=' +
      page +

      '&from_date=' +
      date +

      '&to_date=' +
      date +

      '&currency=USD' +

      '&aggregateColumns[]=spend';


    const json =
      dolphinGet(
        url
      );


    const items =
      json.data || [];


    items.forEach(
      function(item) {

        result.push(
          item
        );

      }
    );


    if (
      !json.meta ||
      !json.meta.last_page ||
      page >=
        json.meta.last_page
    ) {

      break;
    }


    page++;
  }


  return result;
}


/* ============================================================
   ВКЛАДКА АГЕНТЫ
   ============================================================ */

function ensureAgentsSheet(
  socials
) {

  const sheet =
    getOrCreateSheet(
      'Агенты'
    );


  const headers = [
    'Social ID',
    'Соц',
    'Agent'
  ];


  const oldMap = {};


  if (
    sheet.getLastRow() > 1
  ) {

    const old =
      sheet.getRange(
        2,
        1,
        sheet.getLastRow() - 1,
        3
      ).getValues();


    old.forEach(
      function(row) {

        const id =
          String(
            row[0] || ''
          );


        if (id) {

          oldMap[id] = {

            name:
              String(
                row[1] || ''
              ),

            agent:
              String(
                row[2] || ''
              )

          };

        }

      }
    );

  }


  const rows = [];


  socials.forEach(
    function(social) {

      const socialId =
        getSocialId(
          social
        );


      if (!socialId) {
        return;
      }


      const name =
        String(
          social.name ||
          social.fb_name ||
          ''
        );


      let agent =
        oldMap[
          socialId
        ]
          ? oldMap[
              socialId
            ].agent
          : '';


      /*
        Если соц новый —
        пробуем безопасно угадать
        только по явным словам.
      */

      if (!agent) {

        agent =
          inferAgentFromName(
            name
          );

      }


      rows.push([
        socialId,
        name,
        agent
      ]);

    }
  );


  sheet.clear();


  sheet.getRange(
    'A:A'
  ).setNumberFormat(
    '@'
  );


  sheet.getRange(
    1,
    1,
    1,
    headers.length
  ).setValues(
    [headers]
  );


  if (
    rows.length
  ) {

    sheet.getRange(
      2,
      1,
      rows.length,
      headers.length
    ).setValues(
      rows
    );

  }
}


/* ============================================================
   ОПРЕДЕЛЯЕМ АГЕНТА
   ============================================================ */

function inferAgentFromName(
  name
) {

  const s =
    String(
      name || ''
    ).toLowerCase();


  if (
    /(^|[\s_\-])farm([\s_\-]|$)/i.test(
      s
    )
  ) {

    return 'Farm';

  }


  if (
    /(^|[\s_\-])fun([\s_\-]|$)/i.test(
      s
    )
  ) {

    return 'Fun';

  }


  if (
    /(^|[\s_\-])2b([\s_\-]|$)/i.test(
      s
    )
  ) {

    return '2B';

  }


  return 'НЕ ОПРЕДЕЛЕН';
}


/* ============================================================
   ЧИТАЕМ SOCIAL ID → AGENT
   ============================================================ */

function getAgentMap() {

  const sheet =
    getOrCreateSheet(
      'Агенты'
    );


  const result = {};


  if (
    sheet.getLastRow() < 2
  ) {

    return result;

  }


  const data =
    sheet.getRange(
      2,
      1,
      sheet.getLastRow() - 1,
      3
    ).getValues();


  data.forEach(
    function(row) {

      const id =
        String(
          row[0] || ''
        );


      if (id) {

        result[id] =
          String(
            row[2] ||
            'НЕ ОПРЕДЕЛЕН'
          );

      }

    }
  );


  return result;
}


/* ============================================================
   FB СЕГОДНЯ
   ============================================================ */

function writeTodaySheet(
  campaigns,
  socials,
  cabs
) {

  const sheet =
    getOrCreateSheet(
      'FB Сегодня'
    );


  const headers = [
    'Дата',
    'Время обновления',
    'Соц',
    'Account ID',
    'Campaign ID',
    'Кампания',
    'Spend'
  ];


  const now =
    getCurrentTime();


  const cabMap =
    buildCabMap(
      cabs
    );


  const rows = [];


  campaigns.forEach(
    function(campaign) {

      const spend =
        getCampaignSpend(
          campaign
        );


      if (
        spend <= 0
      ) {

        return;

      }


      const accountId =
        String(
          campaign.account_id ||
          ''
        );


      const cab =
        cabMap[
          accountId
        ] ||
        campaign.cab ||
        {};


      const socialMeta =
        getSocialMetaFromCab(
          cab,
          socials
        );


      rows.push([

        getToday(),

        now,

        socialMeta.name,

        accountId,

        String(
          campaign.campaign_id ||
          campaign.id ||
          ''
        ),

        campaign.name || '',

        spend

      ]);

    }
  );


  sheet.clear();


  sheet.getRange(
    'A:F'
  ).setNumberFormat(
    '@'
  );


  sheet.getRange(
    1,
    1,
    1,
    headers.length
  ).setValues(
    [headers]
  );


  if (
    rows.length
  ) {

    sheet.getRange(
      2,
      1,
      rows.length,
      headers.length
    ).setValues(
      rows
    );

  }


  sheet.getRange(
    'G:G'
  ).setNumberFormat(
    '0.00'
  );


  sheet.getRange(
    'I1'
  ).setValue(
    'Последнее обновление'
  );


  sheet.getRange(
    'I2'
  ).setValue(
    now
  );
}


/* ============================================================
   FB ИСТОРИЯ
   ============================================================ */

function appendHistory(
  campaigns,
  socials,
  cabs
) {

  const sheet =
    getOrCreateSheet(
      'FB История'
    );


  const headers = [
    'Дата',
    'Время обновления',
    'Соц',
    'Account ID',
    'Campaign ID',
    'Кампания',
    'Spend'
  ];


  if (
    sheet.getLastRow() === 0
  ) {

    sheet.getRange(
      1,
      1,
      1,
      headers.length
    ).setValues(
      [headers]
    );

  }


  const date =
    getYesterday();


  const now =
    getCurrentTime();


  const existingKeys =
    new Set();


  if (
    sheet.getLastRow() > 1
  ) {

    const old =
      sheet.getRange(
        2,
        1,
        sheet.getLastRow() - 1,
        7
      ).getValues();


    old.forEach(
      function(row) {

        existingKeys.add(

          String(
            row[0]
          ) +
          '|' +
          String(
            row[4]
          )

        );

      }
    );

  }


  const cabMap =
    buildCabMap(
      cabs
    );


  const rows = [];


  campaigns.forEach(
    function(campaign) {

      const spend =
        getCampaignSpend(
          campaign
        );


      if (
        spend <= 0
      ) {

        return;

      }


      const campaignId =
        String(
          campaign.campaign_id ||
          campaign.id ||
          ''
        );


      const key =
        date +
        '|' +
        campaignId;


      if (
        existingKeys.has(
          key
        )
      ) {

        return;

      }


      const accountId =
        String(
          campaign.account_id ||
          ''
        );


      const cab =
        cabMap[
          accountId
        ] ||
        campaign.cab ||
        {};


      const social =
        getSocialMetaFromCab(
          cab,
          socials
        );


      rows.push([

        date,

        now,

        social.name,

        accountId,

        campaignId,

        campaign.name || '',

        spend

      ]);

    }
  );


  if (
    rows.length
  ) {

    sheet.getRange(
      'A:F'
    ).setNumberFormat(
      '@'
    );


    sheet.getRange(
      sheet.getLastRow() + 1,
      1,
      rows.length,
      headers.length
    ).setValues(
      rows
    );

  }


  sheet.getRange(
    'G:G'
  ).setNumberFormat(
    '0.00'
  );
}


/* ============================================================
   КАБИНЕТЫ = ТЕКУЩЕЕ СОСТОЯНИЕ
   ============================================================ */

function writeCabinetsDatabase(
  socials,
  businesses,
  cabs
) {

  const sheet =
    getOrCreateSheet(
      'Кабинеты'
    );


  const headers = [

    'Account ID',

    'Agent',

    'Social ID',

    'Соц',

    'Статус соца',

    'BM ID',

    'BM Name',

    'Статус BM',

    'Статус кабинета',

    'Spend на момент POLICY',

    'Last Sync',

    'Кабинет'

  ];


  const oldPolicySpend =
    readOldPolicySpend(
      sheet
    );


  const agentMap =
    getAgentMap();


  const rows = [];


  cabs.forEach(
    function(cab) {

      const accountId =
        getCabAccountId(
          cab
        );


      if (!accountId) {
        return;
      }


      const social =
        getSocialMetaFromCab(
          cab,
          socials
        );


      const agent =
        agentMap[
          social.id
        ] ||
        'НЕ ОПРЕДЕЛЕН';


      const bmId =
        String(
          cab._resolved_bm_id ||
          ''
        );


      const bmName =
        String(
          cab._resolved_bm_name ||
          ''
        );


      const bmStatus =
        String(
          cab._resolved_bm_status ||
          'UNKNOWN'
        );


      const cabStatus =
        getCabStatus(
          cab
        );


      let policySpend =
        '';


      /*
        Уже зафиксированный НЕНУЛЕВОЙ spend
        не меняем никогда.
      */

      if (
        oldPolicySpend[
          accountId
        ] > 0
      ) {

        policySpend =
          oldPolicySpend[
            accountId
          ];

      }


      else if (
        cabStatus ===
          'POLICY'
      ) {

        const spend =
          getCabSixMonthSpend(
            cab
          );


        /*
          Ноль не фиксируем навсегда.

          Тогда следующий запуск
          попробует снова.
        */

        if (
          spend > 0
        ) {

          policySpend =
            spend;

        }

      }


      rows.push([

        accountId,

        agent,

        social.id,

        social.name,

        social.status,

        bmId,

        bmName,

        bmStatus,

        cabStatus,

        policySpend,

        cab.last_sync_date ||
        '',

        getCabName(
          cab
        )

      ]);

    }
  );


  /*
    Полностью перезаписываем:
    здесь всегда ТЕКУЩЕЕ состояние.
  */

  sheet.clear();


  /*
    Только технические форматы.

    Никакой стилизации кроме статусов.
  */

  sheet.getRange(
    'A:A'
  ).setNumberFormat('@');


  sheet.getRange(
    'C:C'
  ).setNumberFormat('@');


  sheet.getRange(
    'F:F'
  ).setNumberFormat('@');


  sheet.getRange(
    1,
    1,
    1,
    headers.length
  ).setValues(
    [headers]
  );


  if (
    rows.length
  ) {

    sheet.getRange(
      2,
      1,
      rows.length,
      headers.length
    ).setValues(
      rows
    );

  }


  sheet.getRange(
    'J:J'
  ).setNumberFormat(
    '0.00'
  );


  /*
    Только подсветка статусов.
  */

  paintStatusColumn(
    sheet,
    5
  );


  paintStatusColumn(
    sheet,
    8
  );


  paintStatusColumn(
    sheet,
    9
  );
}


/* ============================================================
   POLICY SPEND ИЗ СТАРОЙ БАЗЫ
   ============================================================ */

function readOldPolicySpend(
  sheet
) {

  const result = {};


  if (
    sheet.getLastRow() < 2
  ) {

    return result;

  }


  /*
    Новая схема:
    A = Account ID
    J = Policy Spend
  */

  const data =
    sheet.getRange(
      2,
      1,
      sheet.getLastRow() - 1,
      10
    ).getValues();


  data.forEach(
    function(row) {

      const id =
        String(
          row[0] || ''
        );


      const spend =
        Number(
          row[9] || 0
        );


      if (
        id &&
        spend > 0
      ) {

        result[id] =
          spend;

      }

    }
  );


  return result;
}


/* ============================================================
   ИСТОРИЯ СТРУКТУРЫ
   ============================================================ */

function updateStructureHistory() {

  const cabinets =
    getOrCreateSheet(
      'Кабинеты'
    );


  const history =
    getOrCreateSheet(
      'История структуры'
    );


  const headers = [

    'Agent',

    'Social ID',

    'Соц',

    'Статус соца',

    'BM ID',

    'BM Name',

    'Статус BM',

    'Account ID',

    'Кабинет',

    'Статус кабинета',

    'Spend POLICY',

    'First Seen',

    'Last Seen',

    'Текущая связь'

  ];


  /*
    Текущие кабинеты.
  */

  if (
    cabinets.getLastRow() < 2
  ) {

    return;

  }


  const current =
    cabinets.getRange(
      2,
      1,
      cabinets.getLastRow() - 1,
      12
    ).getValues();


  /*
    Читаем старую историю.
  */

  const historyRows = [];


  if (
    history.getLastRow() > 1
  ) {

    const old =
      history.getRange(
        2,
        1,
        history.getLastRow() - 1,
        headers.length
      ).getValues();


    old.forEach(
      function(row) {

        /*
          Сначала все старые связи
          считаем НЕ текущими.
        */

        row[13] =
          'NO';


        historyRows.push(
          row
        );

      }
    );

  }


  /*
    Индекс исторических связей.

    КЛЮЧ:
    Agent + Social + BM + Account ID

    Поэтому перенос создаёт
    НОВУЮ историческую запись.
  */

  const index = {};


  historyRows.forEach(
    function(row, i) {

      const key =
        makeStructureKey(

          row[0],

          row[1],

          row[4],

          row[7]

        );


      index[key] = i;

    }
  );


  const now =
    getCurrentTime();


  current.forEach(
    function(row) {

      const accountId =
        String(
          row[0] || ''
        );


      const agent =
        String(
          row[1] ||
          'НЕ ОПРЕДЕЛЕН'
        );


      const socialId =
        String(
          row[2] || ''
        );


      const socialName =
        String(
          row[3] || ''
        );


      const socialStatus =
        String(
          row[4] || ''
        );


      const bmId =
        String(
          row[5] || ''
        );


      const bmName =
        String(
          row[6] || ''
        );


      const bmStatus =
        String(
          row[7] || ''
        );


      const cabStatus =
        String(
          row[8] || ''
        );


      const policySpend =
        row[9];


      const cabName =
        String(
          row[11] ||
          accountId
        );


      const key =
        makeStructureKey(
          agent,
          socialId,
          bmId,
          accountId
        );


      if (
        index[key] !==
          undefined
      ) {

        /*
          Такая связь уже существовала.

          Обновляем только её
          последние статусы.
        */

        const i =
          index[key];


        historyRows[i][2] =
          socialName;

        historyRows[i][3] =
          socialStatus;

        historyRows[i][5] =
          bmName;

        historyRows[i][6] =
          bmStatus;

        historyRows[i][8] =
          cabName;

        historyRows[i][9] =
          cabStatus;


        if (
          policySpend !== '' &&
          policySpend !== null
        ) {

          historyRows[i][10] =
            policySpend;

        }


        historyRows[i][12] =
          now;


        historyRows[i][13] =
          'YES';

      }


      else {

        /*
          НОВОЕ положение.

          Старое не удаляем.
        */

        const newRow = [

          agent,

          socialId,

          socialName,

          socialStatus,

          bmId,

          bmName,

          bmStatus,

          accountId,

          cabName,

          cabStatus,

          policySpend,

          now,

          now,

          'YES'

        ];


        index[key] =
          historyRows.length;


        historyRows.push(
          newRow
        );

      }

    }
  );


  /*
    Полностью перезаписываем
    историческую базу.
  */

  history.clear();


  history.getRange(
    'B:B'
  ).setNumberFormat('@');


  history.getRange(
    'E:E'
  ).setNumberFormat('@');


  history.getRange(
    'H:H'
  ).setNumberFormat('@');


  history.getRange(
    1,
    1,
    1,
    headers.length
  ).setValues(
    [headers]
  );


  if (
    historyRows.length
  ) {

    history.getRange(
      2,
      1,
      historyRows.length,
      headers.length
    ).setValues(
      historyRows
    );

  }


  history.getRange(
    'K:K'
  ).setNumberFormat(
    '0.00'
  );
}


/* ============================================================
   УНИКАЛЬНЫЙ КЛЮЧ СТРУКТУРЫ
   ============================================================ */

function makeStructureKey(
  agent,
  socialId,
  bmId,
  accountId
) {

  return [

    String(
      agent || ''
    ),

    String(
      socialId || ''
    ),

    String(
      bmId ||
      'NO_BM'
    ),

    String(
      accountId || ''
    )

  ].join('|');
}


/* ============================================================
   СТРОИМ FARM / FUN / 2B
   ============================================================ */

function buildAllAgentStructures() {

  buildAgentStructureSheet(
    'Farm'
  );


  buildAgentStructureSheet(
    'Fun'
  );


  buildAgentStructureSheet(
    '2B'
  );


  /*
    На случай нового соца,
    который ещё не распределили.
  */

  buildAgentStructureSheet(
    'НЕ ОПРЕДЕЛЕН'
  );
}


/* ============================================================
   СТРУКТУРА ОДНОГО АГЕНТА
   ============================================================ */

function buildAgentStructureSheet(
  agent
) {

  const history =
    getOrCreateSheet(
      'История структуры'
    );


  const sheetName =
    agent ===
      'НЕ ОПРЕДЕЛЕН'
        ? 'Не определен'
        : agent;


  const target =
    getOrCreateSheet(
      sheetName
    );


  target.clear();


  const headers = [

    'Структура',

    'ID',

    'Статус',

    'Spend POLICY',

    'Текущая связь',

    'Last Seen'

  ];


  target.getRange(
    1,
    1,
    1,
    headers.length
  ).setValues(
    [headers]
  );


  if (
    history.getLastRow() < 2
  ) {

    return;

  }


  const data =
    history.getRange(
      2,
      1,
      history.getLastRow() - 1,
      14
    ).getValues();


  /*
    Только нужный агент.
  */

  const filtered =
    data.filter(
      function(row) {

        return String(
          row[0] || ''
        ) === agent;

      }
    );


  /*
    Tree:

    Social
      -> BM
          -> cabinets
  */

  const tree = {};


  filtered.forEach(
    function(row) {

      const socialId =
        String(
          row[1] || ''
        );


      const socialName =
        String(
          row[2] ||
          socialId ||
          'Без соца'
        );


      const socialStatus =
        String(
          row[3] ||
          'UNKNOWN'
        );


      const bmId =
        String(
          row[4] || ''
        );


      const bmName =
        String(
          row[5] ||
          bmId ||
          'Без BM'
        );


      const bmStatus =
        String(
          row[6] ||
          'UNKNOWN'
        );


      const accountId =
        String(
          row[7] || ''
        );


      const cabName =
        String(
          row[8] ||
          accountId
        );


      const cabStatus =
        String(
          row[9] ||
          'UNKNOWN'
        );


      const policySpend =
        row[10];


      const lastSeen =
        String(
          row[12] || ''
        );


      const current =
        String(
          row[13] || 'NO'
        );


      const socialKey =
        socialId ||
        socialName;


      if (
        !tree[
          socialKey
        ]
      ) {

        tree[
          socialKey
        ] = {

          id:
            socialId,

          name:
            socialName,

          status:
            socialStatus,

          lastSeen:
            lastSeen,

          bms:
            {}

        };

      }


      /*
        Берём самый свежий статус соца.
      */

      if (
        lastSeen >=
        tree[
          socialKey
        ].lastSeen
      ) {

        tree[
          socialKey
        ].status =
          socialStatus;


        tree[
          socialKey
        ].lastSeen =
          lastSeen;

      }


      const bmKey =
        bmId ||
        'NO_BM';


      if (
        !tree[
          socialKey
        ].bms[
          bmKey
        ]
      ) {

        tree[
          socialKey
        ].bms[
          bmKey
        ] = {

          id:
            bmId,

          name:
            bmName,

          status:
            bmStatus,

          lastSeen:
            lastSeen,

          cabs:
            []

        };

      }


      /*
        Самый свежий статус BM.
      */

      if (
        lastSeen >=
        tree[
          socialKey
        ].bms[
          bmKey
        ].lastSeen
      ) {

        tree[
          socialKey
        ].bms[
          bmKey
        ].status =
          bmStatus;


        tree[
          socialKey
        ].bms[
          bmKey
        ].lastSeen =
          lastSeen;

      }


      tree[
        socialKey
      ].bms[
        bmKey
      ].cabs.push({

        id:
          accountId,

        name:
          cabName,

        status:
          cabStatus,

        spend:
          policySpend,

        current:
          current,

        lastSeen:
          lastSeen

      });

    }
  );


  const rows = [];


  Object.keys(
    tree
  ).forEach(
    function(socialKey) {

      const social =
        tree[
          socialKey
        ];


      /*
        СОЦ
      */

      rows.push([

        social.name,

        social.id,

        social.status,

        '',

        '',

        social.lastSeen

      ]);


      Object.keys(
        social.bms
      ).forEach(
        function(bmKey) {

          const bm =
            social.bms[
              bmKey
            ];


          /*
            BM
          */

          rows.push([

            '└─ ' +
            bm.name,

            bm.id,

            bm.status,

            '',

            '',

            bm.lastSeen

          ]);


          /*
            CAB
          */

          bm.cabs.forEach(
            function(cab) {

              rows.push([

                '    └─ ' +
                cab.name,

                cab.id,

                cab.status,

                cab.spend,

                cab.current,

                cab.lastSeen

              ]);

            }
          );

        }
      );

    }
  );


  target.getRange(
    'B:B'
  ).setNumberFormat('@');


  if (
    rows.length
  ) {

    target.getRange(
      2,
      1,
      rows.length,
      headers.length
    ).setValues(
      rows
    );

  }


  target.getRange(
    'D:D'
  ).setNumberFormat(
    '0.00'
  );


  /*
    Заголовок.
  */

  target.getRange(
    1,
    1,
    1,
    headers.length
  ).setFontWeight(
    'bold'
  );


  target.setFrozenRows(
    1
  );


  /*
    Цвета по статусам.
  */

  paintStatusColumn(
    target,
    3
  );
}


/* ============================================================
   СОЦ ИЗ CAB
   ============================================================ */

function getSocialMetaFromCab(
  cab,
  socials
) {

  let account = null;


  if (
    cab &&
    Array.isArray(
      cab.accounts
    ) &&
    cab.accounts.length
  ) {

    account =
      cab.accounts[0];

  }


  else if (
    cab &&
    cab.account
  ) {

    account =
      cab.account;

  }


  /*
    Пытаемся найти полный объект соца.
  */

  if (account) {

    const accountInternalId =
      String(
        account.id || ''
      );


    const accountFbId =
      String(
        account.fb_id || ''
      );


    for (
      let i = 0;
      i < socials.length;
      i++
    ) {

      const social =
        socials[i];


      if (
        (
          accountInternalId &&
          String(
            social.id || ''
          ) ===
            accountInternalId
        )
        ||
        (
          accountFbId &&
          String(
            social.fb_id || ''
          ) ===
            accountFbId
        )
      ) {

        return {

          id:
            getSocialId(
              social
            ),

          name:
            String(
              social.name ||
              account.name ||
              ''
            ),

          status:
            getSocialStatus(
              social
            )

        };

      }

    }


    return {

      id:
        String(
          account.fb_id ||
          account.id ||
          ''
        ),

      name:
        String(
          account.name ||
          ''
        ),

      status:
        getSocialStatus(
          account
        )

    };

  }


  /*
    Fallback когда соц сейчас один.
  */

  if (
    socials.length === 1
  ) {

    return {

      id:
        getSocialId(
          socials[0]
        ),

      name:
        String(
          socials[0].name ||
          ''
        ),

      status:
        getSocialStatus(
          socials[0]
        )

    };

  }


  return {

    id: '',

    name: '',

    status:
      'UNKNOWN'

  };
}


/* ============================================================
   SOCIAL ID
   ============================================================ */

function getSocialId(
  social
) {

  /*
    Предпочитаем FB ID.
    Если его нет — Dolphin UUID.
  */

  return String(

    social.fb_id ||

    social.id ||

    ''

  );
}


/* ============================================================
   СТАТУС СОЦА
   ============================================================ */

function getSocialStatus(
  social
) {

  if (!social) {

    return 'UNKNOWN';

  }


  const text = [

    social.status,

    social.error_type,

    social.error_message,

    social.stats_sync_status,

    social.checkpoint_type,

    social.reason

  ].join(' ')
   .toUpperCase();


  /*
    SELFIE / CHECKPOINT
  */

  if (
    text.includes(
      'SELFIE'
    ) ||
    text.includes(
      'CHECKPOINT'
    ) ||
    text.includes(
      'FACIAL'
    ) ||
    text.includes(
      'FACE VERIFICATION'
    )
  ) {

    return 'SELFIE';

  }


  if (
    Number(
      social.activity_block
    ) === 1
  ) {

    return 'BLOCKED';

  }


  if (
    text.includes(
      'DISABLED'
    )
  ) {

    return 'DISABLED';

  }


  if (
    social.error_message
  ) {

    return 'ERROR';

  }


  if (
    String(
      social.stats_sync_status ||
      ''
    ).toUpperCase() ===
      'COMPLETED'
  ) {

    return 'OK';

  }


  return 'UNKNOWN';
}


/* ============================================================
   BM ID
   ============================================================ */

function getBusinessId(
  bm
) {

  return String(

    bm.business_id ||

    bm.id ||

    ''

  );
}


/* ============================================================
   BM NAME
   ============================================================ */

function getBusinessName(
  bm
) {

  return String(

    bm.name ||

    bm.business_name ||

    getBusinessId(
      bm
    )

  );
}


/* ============================================================
   СТАТУС BM
   ============================================================ */

function getBusinessStatus(
  bm
) {

  if (!bm) {

    return 'UNKNOWN';

  }


  const text = [

    bm.status,

    bm.business_status,

    bm.account_status,

    bm.state,

    bm.error_type,

    bm.error_message,

    bm.reason

  ].join(' ')
   .toUpperCase();


  if (
    text.includes(
      'POLICY'
    )
  ) {

    return 'POLICY';

  }


  if (
    text.includes(
      'DISABLED'
    ) ||
    text.includes(
      'BLOCKED'
    )
  ) {

    return 'DISABLED';

  }


  if (
    text.includes(
      'ACTIVE'
    )
  ) {

    return 'ACTIVE';

  }


  if (
    bm.disabled ===
      true
  ) {

    return 'DISABLED';

  }


  if (
    bm.error_message
  ) {

    return 'ERROR';

  }


  /*
    Если Dolphin не отдаёт
    отдельное поле статуса BM,
    пока оставляем UNKNOWN,
    а не выдумываем ACTIVE.
  */

  return 'UNKNOWN';
}


/* ============================================================
   СТАТУС КАБИНЕТА
   ============================================================ */

function getCabStatus(
  cab
) {

  if (!cab) {

    return 'UNKNOWN';

  }


  const stringStatus =

    typeof cab.status ===
      'string'
        ? cab.status
        :

    typeof cab.account_status ===
      'string'
        ? cab.account_status
        : '';


  if (
    stringStatus
  ) {

    return stringStatus
      .toUpperCase();

  }


  const raw =
    Number(

      cab.account_status ||

      cab.status ||

      0

    );


  const map = {

    1:
      'ACTIVE',

    2:
      'DISABLED',

    3:
      'UNSETTLED',

    7:
      'PENDING_RISK_REVIEW',

    8:
      'PENDING_SETTLEMENT',

    9:
      'IN_GRACE_PERIOD',

    100:
      'PENDING_CLOSURE',

    101:
      'CLOSED'

  };


  return (
    map[raw] ||
    'UNKNOWN'
  );
}


/* ============================================================
   POLICY SPEND ЗА 6 МЕСЯЦЕВ
   ============================================================ */

function getCabSixMonthSpend(
  cab
) {

  const candidates = [


    cab &&
    cab.stats &&
    cab.stats.spend,


    cab &&
    cab.statsTotal &&
    cab.statsTotal.spend,


    cab &&
    cab.statistics &&
    cab.statistics.spend,


    cab &&
    cab.spend


  ];


  for (
    let i = 0;
    i < candidates.length;
    i++
  ) {

    const value =
      candidates[i];


    if (
      value ===
        undefined ||
      value ===
        null ||
      value ===
        ''
    ) {

      continue;

    }


    const num =
      Number(
        value
      );


    if (
      !isNaN(
        num
      )
    ) {

      return num;

    }

  }


  return 0;
}


/* ============================================================
   CAB ID
   ============================================================ */

function getCabAccountId(
  cab
) {

  return String(

    cab.ad_account_id ||

    cab.account_id ||

    cab.id ||

    ''

  );
}


/* ============================================================
   CAB NAME
   ============================================================ */

function getCabName(
  cab
) {

  return String(

    cab.name ||

    cab.ad_account_name ||

    getCabAccountId(
      cab
    ) ||

    ''

  );
}


/* ============================================================
   CAB MAP
   ============================================================ */

function buildCabMap(
  cabs
) {

  const result = {};


  cabs.forEach(
    function(cab) {

      const id =
        getCabAccountId(
          cab
        );


      if (id) {

        result[id] =
          cab;

      }

    }
  );


  return result;
}


/* ============================================================
   SPEND КАМПАНИИ
   ============================================================ */

function getCampaignSpend(
  campaign
) {

  if (
    campaign &&
    campaign.stats &&
    campaign.stats.spend !==
      undefined
  ) {

    return Number(
      campaign.stats.spend
    ) || 0;

  }


  return 0;
}


/* ============================================================
   ЦВЕТА СТАТУСОВ
   ============================================================ */

function paintStatusColumn(
  sheet,
  column
) {

  const lastRow =
    sheet.getLastRow();


  if (
    lastRow < 2
  ) {

    return;

  }


  const range =
    sheet.getRange(
      2,
      column,
      lastRow - 1,
      1
    );


  /*
    Сначала чистим прошлую заливку.
  */

  range.setBackground(
    null
  );


  const values =
    range.getValues();


  const backgrounds = [];


  values.forEach(
    function(row) {

      const status =
        String(
          row[0] || ''
        ).toUpperCase();


      backgrounds.push([
        getStatusColor(
          status
        )
      ]);

    }
  );


  range.setBackgrounds(
    backgrounds
  );
}


/* ============================================================
   ЦВЕТ ПО СТАТУСУ
   ============================================================ */

function getStatusColor(
  status
) {

  /*
    Зелёный
  */

  if (
    status === 'ACTIVE' ||
    status === 'OK' ||
    status === 'COMPLETED'
  ) {

    return '#d9ead3';

  }


  /*
    SELFIE
  */

  if (
    status === 'SELFIE' ||
    status === 'CHECKPOINT'
  ) {

    return '#f9cb9c';

  }


  /*
    POLICY
  */

  if (
    status === 'POLICY'
  ) {

    return '#f4cccc';

  }


  /*
    Жёсткий бан
  */

  if (
    status === 'DISABLED' ||
    status === 'BLOCKED' ||
    status === 'CLOSED'
  ) {

    return '#ea9999';

  }


  /*
    Pending / Review
  */

  if (
    status.includes(
      'PENDING'
    ) ||
    status.includes(
      'REVIEW'
    ) ||
    status === 'UNSETTLED'
  ) {

    return '#fff2cc';

  }


  /*
    Ошибка / неизвестно
  */

  if (
    status === 'ERROR' ||
    status === 'UNKNOWN'
  ) {

    return '#d9d9d9';

  }


  /*
    Без статуса
  */

  return '#ffffff';
}


/* ============================================================
   DOLPHIN GET
   ============================================================ */

function dolphinGet(
  url
) {

  const response =
    UrlFetchApp.fetch(
      url,
      {

        method:
          'get',

        headers: {

          'Authorization':
            'Bearer ' +
            DOLPHIN_TOKEN,

          'Accept':
            'application/json'

        },

        muteHttpExceptions:
          true

      }
    );


  const code =
    response.getResponseCode();


  if (
    code !== 200
  ) {

    throw new Error(
      'Dolphin API Error ' +
      code +
      ': ' +
      response.getContentText()
    );

  }


  return JSON.parse(
    response.getContentText()
  );
}


/* ============================================================
   GOOGLE SHEETS
   ============================================================ */

function getOrCreateSheet(
  name
) {

  const ss =
    SpreadsheetApp
      .getActiveSpreadsheet();


  let sheet =
    ss.getSheetByName(
      name
    );


  if (!sheet) {

    sheet =
      ss.insertSheet(
        name
      );

  }


  return sheet;
}


/* ============================================================
   ДАТЫ
   ============================================================ */

function getToday() {

  return Utilities.formatDate(
    new Date(),
    TIMEZONE,
    'yyyy-MM-dd'
  );
}


function getYesterday() {

  const date =
    new Date();


  date.setDate(
    date.getDate() - 1
  );


  return Utilities.formatDate(
    date,
    TIMEZONE,
    'yyyy-MM-dd'
  );
}


function getSixMonthsAgo() {

  const date =
    new Date();


  date.setMonth(
    date.getMonth() - 6
  );


  return Utilities.formatDate(
    date,
    TIMEZONE,
    'yyyy-MM-dd'
  );
}


function getCurrentTime() {

  return Utilities.formatDate(
    new Date(),
    TIMEZONE,
    'yyyy-MM-dd HH:mm:ss'
  );
}


/* ============================================================
   ТРИГГЕРЫ
   ============================================================ */

/*
  ЗАПУСТИТЬ ОДИН РАЗ РУКАМИ.

  Создаст:
  - каждый час → hourlyRefresh
  - каждый день около 06:00 → dailyFinalization
*/
function installTriggers() {

  const triggers =
    ScriptApp
      .getProjectTriggers();


  /*
    Удаляем только наши триггеры,
    чтобы не создать дубли.
  */

  triggers.forEach(
    function(trigger) {

      const fn =
        trigger
          .getHandlerFunction();


      if (
        fn ===
          'hourlyRefresh'
        ||
        fn ===
          'dailyFinalization'
      ) {

        ScriptApp
          .deleteTrigger(
            trigger
          );

      }

    }
  );


  /*
    Каждый час.
  */

  ScriptApp
    .newTrigger(
      'hourlyRefresh'
    )
    .timeBased()
    .everyHours(1)
    .create();


  /*
    Каждый день около 06:00 Минск.
  */

  ScriptApp
    .newTrigger(
      'dailyFinalization'
    )
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .inTimezone(
      TIMEZONE
    )
    .create();


  Logger.log(
    'Триггеры установлены'
  );
}

