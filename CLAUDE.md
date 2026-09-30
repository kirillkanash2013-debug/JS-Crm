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
