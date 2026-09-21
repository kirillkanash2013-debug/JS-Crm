/**
 * Общая конфигурация проекта.
 * Секреты сюда НЕ кладём — только Script Properties.
 */

const CONFIG = Object.freeze({
  TIMEZONE: 'Europe/Minsk',
  DAILY_HOUR: 6,
  CURRENCY: 'USD',

  DOLPHIN_API_BASE: 'https://cloud.dolphin.tech/api/v1',
  KEITARO_API_BASE: 'http://91.223.123.254/admin_api/v1',

  DOLPHIN_SYNC_POLL_MS: 15000,
  DOLPHIN_SYNC_MAX_ATTEMPTS: 20,
  PAGE_SIZE: 100,

  STRUCTURE_AGENTS: ['Farm', 'Fun', '2B']
});

const SHEETS = Object.freeze({
  DB_SOCIALS: '[DB_Socials]',
  DB_BMS: '[DB_BMs]',
  DB_CABS: '[DB_Cabs]',
  DB_CAMPAIGNS_TODAY: '[DB_Campaigns_Today]',
  FB_HISTORY: '[FB_History]',

  DB_KEITARO_TODAY: '[DB_Keitaro_Today]',
  KEITARO_HISTORY: '[Keitaro_History]',

  DB_STRUCTURE_HISTORY: '[DB_Structure_History]',
  AGENTS: 'Агенты',

  ALL_TODAY: 'ALL Сегодня',
  ALL: 'ALL',
  CONTROL: 'Контроль',
  LOG: '[LOG]',

  FARM: 'Farm',
  FUN: 'Fun',
  B2: '2B',
  UNASSIGNED: 'Не определен'
});

const SCRIPT_PROPERTIES = Object.freeze({
  DOLPHIN_TOKEN: 'DOLPHIN_API_TOKEN',
  KEITARO_KEY: 'KEITARO_API_KEY',
  TELEGRAM_BOT_TOKEN: 'TELEGRAM_BOT_TOKEN',
  TELEGRAM_CHAT_ID: 'TELEGRAM_CHAT_ID'
});
