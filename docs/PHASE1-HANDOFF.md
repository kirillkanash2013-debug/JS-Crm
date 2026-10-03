# Phase 1 — Social Lifecycle + Refresh Engine

Base checked against GitHub: `claude-code`, `17c70a62e17dcdf873d7b529cfb45c958f8de220`.
Implementation branch: `implementation/phase1-social-refresh`; PR targets `claude-code`.

## Accepted contract implemented

- Only `active`, `needs_auth`, `disconnected`; explicit `lifecycle_status`, `auth_issue_reason`, `lifecycle_updated_at` in encrypted collector state. Only active socials enter the cycle's fixed mandatory set.
- Confirmed authentication/challenge failure fails the current cycle and marks the social needs_auth; next active cycle excludes it. Transient failures retry and do not change active lifecycle.
- Reconnect first validates the credentials, then collects. Until successful identity-checked collection it is not active. Same Facebook user ID keeps the entity and SQL history. Disconnect clears credentials and current state summary while preserving history and identity; disconnected entries are omitted from the existing connections API to retain deletion UX.
- Cycle identity spans trigger, initial active set, separate validation candidates, Meta jobs, attempts, generations, timestamps, publication attempts, result, failure reason and snapshot reference. Failed validation candidates are not automatically included in future active-only cycles.
- Collector cycles are durable encrypted state records. Meta attempts have UUIDs. Generation binds successful job ID, attempt ID and observed timestamp. Published encrypted D1 snapshot includes `cycle_id`; collector commits its reference using a durable D1 publication receipt.
- Meta has three total job attempts with increasing backoff. Existing API/token/browser fallback remains within a job attempt. Lease recovery is bounded; absolute cycle deadline also applies while admission is unavailable.
- Keitaro retry uses already collected Meta generation; no extra Meta collection. Platform re-reads archived campaign data and validates generation before the fenced publication commit. Temporary Keitaro failure requests backoff; permanent failure and retry exhaustion retain prior snapshot.
- Subscription expiry pauses execution without deleting connection schedules or antidetect configuration. A lightweight alarm checks subscription each minute while suspended. Renewal resumes retained active schedules and repairs missing active schedules without reconnect. Auth/disconnected entries remain excluded.
- Replay after snapshot save is idempotent by `cycle_id`; Telegram notification errors do not relabel a committed snapshot as failed.

## Migration

`platform/migrations/0013_publication_receipts.sql` adds nullable `stats_snapshots.cycle_id` and tenant/cycle-keyed `stats_publication_receipts`. Existing snapshots remain readable; lifecycle/cycles remain in encrypted DO state. `normalize()` is an additive, idempotent migration on state load. Legacy needs_auth jobs produce needs_auth lifecycle; other legacy socials remain active. Existing pending jobs are adopted into a cycle; old pending-publication flags without a tracked cycle are cleared conservatively so future publication uses a fresh complete cycle. Existing SQL archive/history is retained.

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
TESTED locally: 193 passing tests, zero failures, one real Chromium fixture skipped (194 total); failure/recovery tests; all non-browser suites; root `npm test`; both Wrangler Worker dry-run bundles. Collector dry-run used `--containers-rollout=none` because Docker is unavailable.
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

Publication now uses a private RPC. Collector holds its DO concurrency gate throughout proof validation and atomic D1 snapshot/receipt commit. Disconnect/reconnect use the same gate. Receipt reconciliation runs before mutations, expiration and callbacks, and on DO initialization. A committed receipt is authoritative after acknowledgment loss or restart: the cycle becomes published, never failed. Platform also reads the receipt after a lost commit response. Replay does not overwrite a newer snapshot. No public gateway route exposes commit. Legacy platform publication remains only for a collector exposing no structured cycle; a structured cycle without the private binding fails closed. Old in-flight cycles without revision proofs may fail conservatively, then a fresh cycle collects normally.

No changes to gambling formulas, Dep/FTD/Revenue semantics, campaign ownership, attribution/Долёт, billing model, Telegram menus/text or delegated permissions.


## Architect review fixes — same draft PR #7

1. Publication validates cycle, attempt lease, fixed active set, connection revisions, Meta proof and archived timestamps under the DO gate. D1 atomically commits encrypted snapshot and durable receipt, checking subscription and snapshot lease. Stale/failed cycles cannot replace Published Snapshot; replay and acknowledgment recovery use the receipt.
2. Validation jobs have separate kind/identity and optional origin-cycle trace, never mandatory meta_jobs. Candidate checkpoint/exhaustion does not fail an active cycle. Successful identity-checked collection activates the candidate for a subsequent fixed active set. When no active cycle exists, its generation seeds the first cycle without an extra Meta read. Platform uses the fixed active set; validation work does not report active refresh as failed.
3. Collection dedupe excludes Campaign Actions, imports and validation. Post-action refresh creates/attaches collection jobs. Action ownership, serialization and absence of automatic write retries remain intact.
4. HTTP status survives malformed JSON and container transport. HTTP 503/429 retry with bounded increasing backoff and retain active lifecycle. Auth classification takes priority; real permission/auth failures do not become retryable.

Additional changed files: extension/meta.mjs, platform/src/store.mjs, platform/wrangler.jsonc, platform/migrations/0013_publication_receipts.sql, platform/tests/d1-store.test.mjs. Existing Phase 1 tests are extended.

Regressions: disconnect/reconnect publication window at commit and platform callback; stale revision/generation/lease and failed cycles; lost acknowledgment/restart/deadline recovery; replay after newer snapshot; real SQLite atomic rollback and receipt idempotence; active success plus candidate checkpoint; candidate activation during current cycle; queued/running action versus collection dedupe; JSON/non-JSON 503/429 exhaustion and recovery; non-transient auth/permission failures.

Release/QA: apply migration 0013 first; configure private PUBLICATION_COMMIT service binding to collector PublicationCommit entrypoint; roll out coordinated collector/platform/container versions. Verify isolated real Worker/D1 concurrency, service-binding failure recovery and container startup. No deploy or merge in this milestone. Docker/browser fixture is unavailable locally; CI requires Chromium and all 194 tests. Check GitHub CI on the final PR head before handoff. CODED and local TESTED do not imply DEPLOYED or LIVE VERIFIED.
