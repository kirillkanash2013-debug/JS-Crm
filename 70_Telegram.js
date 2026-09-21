/**
 * Telegram-отчёт.
 * Токен и chat id — только Script Properties.
 */

function isTelegramConfigured_() {
  const props = PropertiesService.getScriptProperties();
  return Boolean(
    props.getProperty(SCRIPT_PROPERTIES.TELEGRAM_BOT_TOKEN) &&
    props.getProperty(SCRIPT_PROPERTIES.TELEGRAM_CHAT_ID)
  );
}

function sendDailyTelegramReport_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty(SCRIPT_PROPERTIES.TELEGRAM_BOT_TOKEN);
  const chatId = props.getProperty(SCRIPT_PROPERTIES.TELEGRAM_CHAT_ID);

  if (!token || !chatId) {
    throw new Error('Telegram Script Properties не настроены');
  }

  const text = buildDailyTelegramReport_();

  const response = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + token + '/sendMessage',
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
      }),
      muteHttpExceptions: true
    }
  );

  parseJsonResponseOrThrow_(response, 'Telegram sendMessage');
}

function buildDailyTelegramReport_() {
  const date = getYesterday_();
  const rows = filterSheetRowsByDate_(SHEETS.ALL, date);

  const totals = rows.reduce(function (acc, row) {
    acc.spend += num_(row[5]);
    acc.inst += num_(row[6]);
    acc.reg += num_(row[7]);
    acc.ftd += num_(row[8]);
    acc.revenue += num_(row[9]);
    return acc;
  }, {
    spend: 0,
    inst: 0,
    reg: 0,
    ftd: 0,
    revenue: 0
  });

  const roi = totals.spend > 0
    ? ((totals.revenue - totals.spend) / totals.spend) * 100
    : 0;

  return [
    '<b>Отчёт за ' + escapeHtml_(date) + '</b>',
    '',
    'Spend: ' + totals.spend.toFixed(2),
    'Inst: ' + totals.inst,
    'Reg: ' + totals.reg,
    'FTD: ' + totals.ftd,
    'Revenue: ' + totals.revenue.toFixed(2),
    'ROI: ' + roi.toFixed(2) + '%'
  ].join('\n');
}
