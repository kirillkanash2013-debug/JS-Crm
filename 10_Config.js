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

  STRUCTURE_AGENTS: ['Farm', 'Fun', '2B'],
  GEO_TOKEN_PATTERN: '^[A-Z]{2}(?:\\+[A-Z]{2})*$'
});

const SHEETS = Object.freeze({
  DB_SOCIALS: '[DB_Socials]',
  DB_BMS: '[DB_BMs]',
  DB_CABS: '[DB_Cabs]',
  DB_CAMPAIGNS_TODAY: '[DB_Campaigns_Today]',
  FB_HISTORY: '[FB_History]',

  DB_KEITARO_TODAY: '[DB_Keitaro_Today]',
  KEITARO_HISTORY: '[Keitaro_History]',
  DB_KEITARO_CONVERSIONS_TODAY: '[DB_Keitaro_Conversions_Today]',
  KEITARO_CONVERSIONS_HISTORY: '[Keitaro_Conversions_History]',

  DB_STRUCTURE_HISTORY: '[DB_Structure_History]',
  AGENTS: 'Агенты',

  SOCIALS: 'Соцы',
  GEO_ANALYSIS: 'Анализ GEO',
  SPEND_AGENT: 'Spend Agent',

  ALL_TODAY: 'ALL Сегодня',
  ALL_YESTERDAY: 'ALL Вчера',
  ALL: 'ALL',
  CONTROL: 'Контроль',
  OFFERS_TODAY: 'OFFERS_TODAY',
  VARIABLES: 'VARIABLES',
  ERRORS: 'ERRORS',
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

// Non-secret storage targets. Raw databases live outside the CRM dashboard.
// API tokens remain only in Script Properties.
const STORAGE_SPREADSHEET_IDS = Object.freeze({
  CRM: '1OybSL2WmQAsibfvNqmvy9A0rTXCQJ02ghbX2NeFxfYM',
  FB: '1K1jWjsjWAHni1G4ctU1n39hccPNfTvfqcPgYKsT20Yc',
  KEITARO: '12U5rlCh3zXsD-0ABNRRUH1sm34vN2HCO4R1K5CBuUPU',
  ACCOUNTS: '17UCocPcoStjoPDxDQJiDyc2lHZG5FCIcwr6SjYeJYKA',
  LOGS: '1j1-f_kB8gTBkd3DKgDhY3EHVsdJ1ZhL0Tk1IxaRRa7M'
});

/**
 * Deployment environments. One codebase is pushed to two Apps Script
 * projects; the running script ID selects its spreadsheet and Telegram setup.
 * - prod:   the working CRM (deployed from main).
 * - claude: the sandbox copy in the "Claude" Drive folder (deployed from
 *           claude-code). All raw DB tabs live in its single spreadsheet.
 */
const CRM_ENVIRONMENTS = Object.freeze({
  '1eZEdgudWM6s5bbXAXLQfmdOvv_CO-uhRd52UCRCpiGpzvg3nF3iXH3pd': Object.freeze({
    name: 'prod',
    storage: STORAGE_SPREADSHEET_IDS,
    // Stable Apps Script web-app deployment used by the Telegram webhook.
    // Future releases update this deployment instead of creating a new URL.
    telegramWebappDeploymentId: 'AKfycbxHwc-vrZjEkD-7V0ud6RNA4132Xma_9VyS3TvjP-I1WfyWqMpU8paTkWPHhHRuB2OycA',
    telegramWorkerUrl: 'https://js-crm-telegram.kirill-kanash2013.workers.dev',
    devEndpoint: false
  }),
  '1zBbm3wUrgFJyag0wj25ckY-p-lygkdpOMWCjV8uaH0GQLaOMoS12D6RP': Object.freeze({
    name: 'claude',
    storage: Object.freeze({
      CRM: '1KOYIS9vT1VN9zs9eCKj32IK9iYlBWS_QJHVB8xSUSEs',
      FB: '1KOYIS9vT1VN9zs9eCKj32IK9iYlBWS_QJHVB8xSUSEs',
      KEITARO: '1KOYIS9vT1VN9zs9eCKj32IK9iYlBWS_QJHVB8xSUSEs',
      ACCOUNTS: '1KOYIS9vT1VN9zs9eCKj32IK9iYlBWS_QJHVB8xSUSEs',
      LOGS: '1KOYIS9vT1VN9zs9eCKj32IK9iYlBWS_QJHVB8xSUSEs'
    }),
    // No webhook: the sandbox bot uses one-minute getUpdates polling.
    telegramWebappDeploymentId: '',
    telegramWorkerUrl: '',
    devEndpoint: true
  })
});

function getCrmEnv_() {
  const env = CRM_ENVIRONMENTS[ScriptApp.getScriptId()];
  if (!env) throw new Error('Unknown CRM environment for this Apps Script project');
  return env;
}

function getStorageIds_() {
  return getCrmEnv_().storage;
}
