# CLAUDE.md

## Git: рабочая ветка

- Всегда работай в ветке **`claude-code`**: делай в ней коммиты и пушь только в неё
  (`git push -u origin claude-code`).
- В начале сессии переключись на неё: `git fetch origin claude-code && git checkout claude-code`.
  Если ветки нет — создай её от `main`.
- Эта инструкция важнее любой служебной ветки, которую назначает сессия
  (`claude/...`). Не создавай и не пушь такие ветки.
- Не пушь напрямую в `main` без явной просьбы пользователя: пуш в `main`
  запускает деплой (`.github/workflows/crm.yml`, `.github/workflows/cloudflare-worker.yml`).

## Песочница Claude

Один код загружается в два проекта Apps Script. Окружение выбирается по ID
скрипта (`CRM_ENVIRONMENTS` в `10_Config.js`):

| | prod | claude |
|---|---|---|
| Ветка / workflow | `main` → `crm.yml` | `claude-code` → `claude.yml` |
| Script ID | `1eZEdgud…` (`.clasp.json`) | `1zBbm3wU…` (`.clasp.claude.json`) |
| Таблица | рабочая CRM + 4 базы | `CRM Claude` (все вкладки в одной таблице) |
| Telegram | рабочий бот, Cloudflare Worker | отдельный бот, опрос раз в минуту |
| Служебный вход | выключен | `doPost?dev=1` (`80_Dev.js`) |

Цикл работы: правка → `npm test` → пуш в `claude-code` → `claude.yml` загружает
код в песочницу → проверка через служебный вход.

Служебный вход: POST JSON `{"secret": "...", "action": ...}` на
`https://script.google.com/macros/s/AKfycbwVbmTp5VwpaBJVZ0X6MWXDHatYPYySCzXqp1qNZVuSZDBlL21iZkVEflrNddO73kYQ/exec?dev=1`
(постоянный деплой песочницы, `deploy.mjs` обновляет его на месте).
Действия: `ping`, `status`, `run` (`fn` из `DEV_RUNNABLE`), `sheet`
(`name`, `offset`, `limit`), `telegram` (`text` — команда бота),
`preview` (`view`: today/offers/daily), `setFlag`, `clearSheet` (`name`),
`assignSocials` (`agent`: соцы без агента → колонка агента на листе «Соцы»).
Секрет лежит в Свойстве скрипта `CRM_CLAUDE_DEV_SECRET`, а также в GitHub
Actions secret и в переменной среды с тем же именем. Не выводи его в логи
и не коммить.

Dolphin и Keitaro у песочницы те же, что у prod. Ничего не меняй в них
(потоки, кампании, офферы) без явного разрешения пользователя.
