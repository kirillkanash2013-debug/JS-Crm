# JS CRM

Модульный Google Apps Script проект для автоматизации Meta/Dolphin + Keitaro + ALL + Telegram.

## Основные сценарии

- `hourlyRefresh()` — оперативное обновление текущего дня.
- `dailyFinalization()` — закрытие вчерашнего дня около 06:00.
- `refreshStructureOnly()` — ручное обновление структуры.
- `installTriggers()` — установка триггеров.

## Script Properties

Обязательные:
- `DOLPHIN_API_TOKEN`
- `KEITARO_API_KEY`

Опциональные:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## DB-вкладки

- `[DB_Socials]`
- `[DB_BMs]`
- `[DB_Cabs]`
- `[DB_Campaigns_Today]`
- `[FB_History]`
- `[DB_Keitaro_Today]`
- `[Keitaro_History]`
- `[DB_Structure_History]`
- `[LOG]`

## Рабочие вкладки

- `Агенты`
- `Farm`
- `Fun`
- `2B`
- `ALL Сегодня`
- `ALL`
- `Контроль`

## Важно

Keitaro `report/build` может немного отличаться по payload в зависимости от версии. Если `testKeitaroConnection()` проходит, а `refreshKeitaroToday_()` нет — исправляется только `getKeitaroReport_()` в `30_Keitaro_API.js`.
