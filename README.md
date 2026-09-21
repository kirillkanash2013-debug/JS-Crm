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

## GitHub → новый CRM (2026-09-21)

Целевой Script ID: `1eZEdgudWM6s5bbXAXLQfmdOvv_CO-uhRd52UCRCpiGpzvg3nF3iXH3pd`.
Таблица: `1OybSL2WmQAsibfvNqmvy9A0rTXCQJ02ghbX2NeFxfYM`.
Старый проект не является целью загрузки. `Dolphin.js`, `Other.js` и `Keitaro.js` оставлены для справки и исключены из clasp: в них повторялись глобальные функции.

Workflow `CRM checks and Apps Script sync`: проверка кода → серверная резервная версия Apps Script → push → чтение кода обратно и сравнение. При ошибке readback загрузка считается неуспешной; предыдущая серверная версия сохранена для восстановления. Сырые резервные копии и credentials в публичные артефакты Actions не публикуются.

### Единовременная авторизация владельца

1. Включить Apps Script API: https://script.google.com/home/usersettings
2. На своём компьютере с Node.js 22+: `npx @google/clasp@3.4.1 login`. Выбрать аккаунт владельца новой CRM и проверить запрашиваемые Google разрешения.
3. Создать repository Actions secret `CLASP_AUTH_JSON` в Settings → Secrets and variables → Actions. Значение — содержимое локального `%USERPROFILE%\.clasprc.json` после входа. Этот файл является секретом: не коммитить и не отправлять в чат.
4. Запустить workflow через Actions → CRM checks and Apps Script sync → Run workflow.

Вход даёт CI доступ к Apps Script в пределах выданных Google разрешений; это не ограничение OAuth одним Script ID. Загрузчик дополнительно проверяет точный целевой ID. Секрет передаётся только в job загрузки на main, не в pull request проверки.

### Текущий статус — НЕ production-ready

Код загружается отдельно от запуска. Триггеры автоматически НЕ устанавливаются. До подтверждённой миграции и проверки API `CRM_PIPELINE_VERIFIED` оставлять незаданным.

Оставшиеся задачи:
- миграция ALL: исходные 23 колонки не совпадают с 15 колонками нового модуля;
- центральные базы в отдельных файлах, реестр Projects, дашборды;
- отделение вызовов API от DB и окончательная оркестрация;
- исправление исторических ключей и date-aware join, неоднозначных названий кампаний;
- реальная карта событий Keitaro: текущие conversions→Inst, sales→FTD и Reg=0 являются временными допущениями;
- проверка пагинации, полноты данных, статусов и Policy Spend;
- live прогон, сверка контрольных сумм и установка триггеров.

Защита схемы останавливает финализацию до записи, если существующий ALL не соответствует новому формату. Не обходить её установкой флага: сначала выполнить миграцию с резервной копией и проверить весь pipeline.

### Инцидент с токеном

Из текущего Dolphin.js удалён встроенный токен. Он был в публичной истории репозитория: владелец должен отозвать его и записать новый в Script Properties `DOLPHIN_API_TOKEN`. Удаление строки не отзывает ранее опубликованный токен.
