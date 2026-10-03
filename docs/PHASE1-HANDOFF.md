# Phase 1 — Social Lifecycle + Refresh Engine

Base checked against GitHub: `claude-code`, `17c70a62e17dcdf873d7b529cfb45c958f8de220`.
Implementation branch: `implementation/phase1-social-refresh`; PR targets `claude-code`.

## Accepted contract implemented

- Only `active`, `needs_auth`, `disconnected`; explicit `lifecycle_status`, `auth_issue_reason`, `lifecycle_updated_at` in encrypted collector state. Only active socials enter the cycle's fixed mandatory set.
- Confirmed authentication/challenge failure fails the current cycle and marks the social needs_auth; next active cycle excludes it. Transient failures retry and do not change active lifecycle.
- Reconnect first validates the credentials, then collects. Until successful identity-checked collection it is not active. Same Facebook user ID keeps the entity and SQL history. Disconnect clears credentials and current state summary while preserving history and identity; disconnected entries are omitted from the existing connections API to retain deletion UX.
- Cycle identity spans trigger, initial active set, separate validation candidates, Meta jobs, attempts, generations, timestamps, publication attempts, result, failure reason and snapshot reference. Failed validation candidates are not automatically included in future active-only cycles.
- Collector cycles are durable encrypted state records. Meta attempts have UUIDs. Generation binds successful job ID, attempt ID and observed timestamp. Published encrypted D1 snapshot includes `cycle_id`; collector stores its reference after platform acknowledgment.
- Meta has three total job attempts with increasing backoff. Existing API/token/browser fallback remains within a job attempt. Lease recovery is bounded; absolute cycle deadline also applies while admission is unavailable.
- Keitaro retry uses already collected Meta generation; no extra Meta collection. Platform re-reads archived campaign data and validates generation immediately before snapshot save. Temporary Keitaro failure requests backoff; permanent failure and retry exhaustion retain prior snapshot.
- Subscription expiry pauses execution without deleting connection schedules or antidetect configuration. A lightweight alarm checks subscription each minute while suspended. Renewal resumes retained active schedules and repairs missing active schedules without reconnect. Auth/disconnected entries remain excluded.
- Replay after snapshot save is idempotent by `cycle_id`; Telegram notification errors do not relabel a committed snapshot as failed.

## Migration

No D1 SQL migration is required: lifecycle and cycle history belong to the existing encrypted Durable Object state, and snapshot identity is added to its existing encrypted JSON payload. `normalize()` is an additive, idempotent migration on state load. Legacy needs_auth jobs produce needs_auth lifecycle; other legacy socials remain active. Existing pending jobs are adopted into a cycle; old pending-publication flags without a tracked cycle are cleared conservatively so future publication uses a fresh complete cycle. Existing SQL archive/history is retained.

Both web and Telegram renewal paths wake the authenticated collector, including payment replay. This also repairs active schedules on legacy collectors whose old expiry code removed their alarm. A failed wake is retried with the same idempotent payment; subscription duration is not extended again. New suspension additionally retains a polling alarm, so renewal detected through the database also resumes collection.

## Changed files

Runtime:
- `cloud-collector/src/control.mjs`
- `cloud-collector/src/lifecycle.mjs`
- `cloud-collector/src/diagnostics.mjs`
- `cloud-collector/src/index.mjs`
- `shared/collection-errors.mjs`
- `platform/src/bot.mjs`
- `platform/src/entry.mjs`
- `platform/src/index.mjs`
- `platform/src/refresh.mjs`
- `server/collector.mjs`
- `server/container-runner.mjs`

Tests:
- New: `cloud-collector/tests/phase1.test.mjs`, `platform/tests/phase1-refresh.test.mjs`, `server/tests/social-auth.test.mjs`.
- Updated: `cloud-collector/tests/control.test.mjs`, `cloud-collector/tests/cheap-mode.test.mjs`, `cloud-collector/tests/archive.test.mjs`, `platform/tests/paired-stats.test.mjs`.

Checks/documentation:
- `.github/workflows/phase1-checks.yml` (checks only; no deploy)
- `docs/PHASE1-HANDOFF.md`

## Verification and release status

CODED: contracts above, migration, tests and checks-only workflow.
TESTED locally: 176 passing tests, zero failures, one real Chromium fixture skipped (177 total); failure/recovery tests; all non-browser suites; root `npm test`; both Wrangler Worker dry-run bundles. Collector dry-run used `--containers-rollout=none` because Docker is unavailable.
NOT TESTED locally: real Chromium fixture (browser download produced a corrupt ZIP), Docker image startup/build. CI requires real Chromium with `REQUIRE_BROWSER=1`.
DEPLOYED: no changes deployed or merged.
LIVE VERIFIED: none; no claims about production behavior.

Commands:
```
npm test
node --test cloud-collector/tests/*.test.mjs platform/tests/*.test.mjs extension/tests/*.test.mjs server/tests/*.test.mjs
# CI additionally installs Chromium and sets REQUIRE_BROWSER=1.
cd cloud-collector && wrangler deploy --dry-run --containers-rollout=none
cd platform && ../cloud-collector/node_modules/.bin/wrangler deploy --dry-run
```

## Implementation policy and remaining release work

Retry limit/backoff, 45-minute cycle deadline, five-minute publication lease, and retained 100 recent cycles are implementation policy, not permanent business contracts. History is bounded in state; business SQL history remains unchanged. Capacity exhaustion may fail a cycle while keeping socials active. Container/API/browser fallback can make several provider reads within one job attempt, but overall attempt count/deadline are bounded.

Release/QA must check actual Meta challenge/proxy/container failures, subscription expiry/renewal, reconnect with same user, callback replay and preserved snapshot after Keitaro outage on isolated services before production. Roll out collector/platform/container together: the new platform callback returns a typed publication acknowledgment, and the container preserves error classification. Update the existing container image/version mechanism as part of release so old running containers are not reused.

As in the existing engine, generation check and D1 snapshot commit cross Worker/DO boundaries rather than one distributed transaction. Validate concurrent reconnect/disconnect at the publication boundary in Release/QA; late collector job results and callback acknowledgments are fenced by revision/cycle/attempt identity.

No changes to gambling formulas, Dep/FTD/Revenue semantics, campaign ownership, attribution/Долёт, billing model, Telegram menus/text or delegated permissions.
