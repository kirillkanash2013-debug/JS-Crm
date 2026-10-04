# Phase 2 — Historical ingestion completeness + event-time projection

First milestone APPROVED by Architect / Control at `14c3fdfd44665657d9c21653df8045e4f1617ce3`. This incremental milestone stays in `implementation/phase2-historical-data`, draft PR #8, stacked on approved Phase 1 (`2e05e15301a58e5a7b92622716769b7d0b648757`). PR #7, `claude-code`, Social Lifecycle / Refresh Cycle contracts, Campaign Actions, Telegram UI/formulas and alerts are unchanged. No merge, remote migration or deployment.

## ПОДТВЕРЖДЕНО — existing data path and verification limits

Shared `fetchKeitaroReport` executes paginated report/build and conversions/log; Worker socket and Node container use that implementation. Platform ingests encrypted raw evidence and normalized conversions before current presentation aggregation. Approved migration 0014 retains original aggregates, receipts and immutable snapshot payloads.

Actual API credentials are unavailable in this execution environment: read-only `node server/keitaro-schema-check.mjs` returned `not_verified / credentials_unavailable / live_verified:false`. No successful authenticated query to the user's tracker is claimed. GitHub access is verified separately; Keitaro credentials are not extracted from GitHub secrets or printed.

Primary reference checked: https://admin-api.docs.keitaro.io/ documents conversions/log, conversion_id, click_datetime, postback_datetime, sale_datetime, sub_id_1..30 and country_code. https://docs.keitaro.io/en/conversions-and-postback/postback.html documents provider corrections and transaction identifiers. These references are not evidence of the installed instance's capabilities or payout-currency semantics.

## РЕШЕНО — bounded independent historical ingestion

After a successful publication, BotNotify passes `ExecutionContext.waitUntil` to a separate historical task. No history request precedes or blocks publication; history failure never changes the successful refresh result or Published Snapshot. Current-day presentation still reads its original current-day report. Historical ingestion does not enqueue Meta work or own Refresh Cycle state. It uses the same private Keitaro bridge/admission/Node-or-socket transport and already-authorized tenant source.

`runHistoricalIngestion` has independent tenant/source durable lease/cursor:
- Maximum 25 seconds of work budget per invocation; 60-second lease; 15-minute successful-work cooldown.
- At most one lookback window (today minus 6 days through today) and one archive window (up to 7 days) per successful refresh. Archive windows overlap by one day.
- Bounded 180-day horizon; cursor walks backward, then wraps for another correction sweep. Dates follow the explicit source query timezone; no strict timezone/Meta-day normalization.
- Each window requests conversions only, limit 250, maximum 4 pages, maximum 10-second response budget. A once-per-source/day/configured-sub probe has a 5-second budget within the same total budget.
- Complete windows checkpoint durable cursor only after persistence. Pagination/time/identity errors and partial responses mark history incomplete. Failed archive window retains its cursor for a later retry. Cursor and lease survive Worker reload; expired-owner checkpoint/release cannot affect a new owner.
- There is no additional cron, Telegram command, provider mutation or live deployment. Work resumes on subsequent successful refreshes. Sites/automations are not required.

`fetchKeitaroReport` now accepts bounded historical options without changing existing current-report defaults. Both transports and container runner forward the same options. Deadline handling does not wait indefinitely for a transport Promise; the underlying transport still has its own socket/request cleanup timeout. Authoritative total permits a full last page to complete at the exact page limit.

## Read-only capabilities

`probeKeitaroConversions` requests one conversion row with baseline conversion_id / click ID / timestamps / configured sub_id_N / status / revenue; then independently checks optional sale_datetime, country_code, currency, revenue_currency, payout_currency, tid and params columns. It never calls a provider write API, prints keys, or returns raw conversion rows.

HTTP 400/406 are classified as unsupported optional fields; temporary/auth/unknown responses remain unknown. Accepted columns and returned/non-null field flags are stored in durable source capability metadata. Empty samples prove neither actual field values nor event semantics. Only accepted optional event fields are included in historical windows. No assumption that sub_id_4 is the configured join.

Read-only CLI: `server/keitaro-schema-check.mjs`. It requires KEITARO_URL, KEITARO_API_KEY, KEITARO_PROBE_DAY, KEITARO_TIMEZONE and KEITARO_SUB_INDEX in the environment. Credential values are never in output. It can be run by Release/QA against the existing instance without deploying this branch.

## Data model / additive migrations

0014 remains unchanged:
- keitaro_evidence: encrypted source response, query context, first ingestion timestamp, evidence digest.
- keitaro_events: one source conversion/business identity per tenant/source/key.
- keitaro_attribution: separate Campaign ID relationship and matched / unmatched / unattributed.
- keitaro_event_observations: legacy normalized observations per distinct evidence.
- stats_snapshot_history: immutable structured Published Snapshots atomically with latest pointer and receipt, including campaigns / generations / source evidence reference. Legacy rendered text is only a compatibility field, not historical business truth.

New `0015_history_completeness.sql`:
- Adds events.observed_at and indexed events.event_day; preserves first ingested_at. Backfills existing source event dates and rejects invalid calendar dates rather than inventing an ingestion day.
- keitaro_observation_history: append-only observation_id/evidence_id/observed_at/fact/original source campaign input. Copies legacy observations without inventing their unavailable original campaign relationship. SQL triggers reject UPDATE/DELETE on both observation tables.
- keitaro_history_state: durable cursor, cooldown, fenced lease, last completed window/result/error and capability metadata.
- keitaro_known_campaigns: durable identities actually observed from Meta; seeded from previously matched relationships. New conversions can match a historically known campaign even if temporarily absent from today's Meta list.

No old history or aggregate is deleted. Production rollout must apply additive 0015 before new Worker code; no remote migration has run.

## Idempotency and correction semantics

Stable conversion_id remains primary tenant/source identity. Fallback identity remains the approved deterministic click + actual conversion time + status + offer key; attribution, payout and ingestion day are excluded. tid is preserved as source metadata, but does not silently change identity strategy for already-ingested fallback events.

Each completed fetch has a separate observation identity. A→B→A payout changes therefore append three observations even if A's raw evidence digest repeats. Exact observation replay cannot rewrite a later current fact. Overlapping windows never increment stored counters: one source event row remains, projection uses its current fact exactly once.

observed_at is acquisition-start time of the source read, not business event time. Older concurrent reads cannot replace newer observed facts. There is still no verified provider revision sequence; observation order does not prove provider revision order. Known-Campaign re-attribution works on old unmatched events without requiring them in the current source window. The original relationship input remains in append-only observations.

## Event-time daily facts

`historicalDailyFacts(tenantId, source, {from,to})` projects structured normalized current facts, with an indexed source-day filter and explicit 50,000-row limit (fails closed above it). This is a data API, not a Telegram/cohort UI.

- Registration uses registration_at; FTD uses ftd_at; other conversions use conversion_at. Explicit source sale_datetime is preserved and preferred for sale event time over a later correction postback timestamp. Raw click/postback/sale timestamps remain stored verbatim.
- Missing/invalid event time stays undated, reported explicitly; never assigned to the ingestion date or first-click date for FTD. No fabricated acquisition events from aggregate unique-click counts.
- Groups retain day, Campaign ID, canonical attribution state and currency. Reg / FTD counts and source sale payouts come from unique current source events. Долёт remains unattributed, never a day-rollover classification.
- Exact decimal source-payout sums; no floating point rounding or FX. Unknown amounts yield nullable amount plus known_amount/unknown_amounts. Different and unknown currencies remain separate.
- Revenue is not labeled with payout_currency when the supplied amount is tracker revenue. Original source payout amount/currency is stored separately when present; no settings-currency substitution.

Historical corrections can change the current daily knowledge. Previously published snapshots remain immutable and answer what the user saw then.

## Changed files (this incremental milestone)

platform/migrations/0015_history_completeness.sql; platform/src/history.mjs; platform/src/history-ingestion.mjs; platform/src/history-projection.mjs; platform/src/bot.mjs; platform/src/entry.mjs; platform/tests/history.test.mjs; platform/tests/paired-stats.test.mjs; shared/keitaro-report.mjs; cloud-collector/src/keitaro-socket.mjs; server/keitaro.mjs; server/container-runner.mjs; server/keitaro-schema-check.mjs; this handoff.

## Tests and status

New regressions run through real SQLite/D1 SQL and MemoryStore: overlapping old windows / corrections, late conversion projected into its past event day, out-of-window unmatched→matched, durable archive checkpoint/retry, lease fencing, repeated A→B→A observations, replay/stale-read protection, exact decimals / mixed currencies / unknown payouts, explicit sale versus later postback timestamps, 0014→0015 populated migration upgrade, read-only capability classification and configured sub_id, bounded pagination/deadline and full last-page completion. Bot integration verifies that background requests see an already-published pair, and failures leave ready/publication unchanged. Accepted Phase 1 and first-milestone regressions remain in the full suite.

Local full suite: 226 passed / 0 failed / 1 skipped (227 total; Chromium unavailable locally). Root npm test passed. Exact-head GitHub CI and commit are reported in PR #8 after checks finish, so this file does not introduce another unverified code head just to include its own hash.

CODED: yes (historical lookback/backfill and event-time projection milestone).
TESTED: local suite passed; exact-head CI reported in PR #8/final handoff.
DEPLOYED: no.
LIVE VERIFIED: no; real schema check blocked by missing API credentials.

## НЕИЗВЕСТНО / remaining gaps

- Real instance API schema, conversion_id uniqueness/correction semantics, currency/GEO availability and event-time semantics have not been authenticated/live verified. Stable ID and sale=FTD mapping follow the accepted existing contract, not a new inference from public docs.
- Individual Inst/acquisition feed remains unverified; Inst is still the existing current-report aggregate. Do not invent individual source facts.
- Coverage is explicitly bounded to 180 days and successful refresh opportunities. Older stored facts remain, but provider corrections beyond the horizon are not automatically rescanned. No deletion/tombstone feed has been verified; absence from a query is not treated as deletion.
- Dense windows above 1,000 rows, repeated pagination, deadlines or Worker interruption can stay incomplete until a later successful bounded read. There is no adaptive subdivision or paginated cross-invocation offset checkpoint in this milestone; last_result/incomplete and unchanged cursor expose this limit. A terminated background task can leave its 60-second lease until expiry; completed facts are idempotent on retry.
- Missing stable IDs require fallback source fields to remain stable. Indistinguishable repeated conversions cannot be safely separated. Changes to fallback timestamp/status/offer without a stable ID cannot be inferred reliably as corrections.
- No verified provider revision ordering; latest acquired observation is current knowledge. Observations retain all fetched versions, but events never returned by this API cannot be reconstructed.

## ПРЕДЛОЖЕНИЕ — next review gate

Architect / Control should review this incremental milestone on the new exact head in the same draft PR #8. Read-only authenticated capability/schema verification remains a Release/QA prerequisite; there is no merge/deploy authorization. Phase 2 is not declared fully accepted, and Phase 3 formulas, FX, strict timezone normalization, cohort UI and alerts remain out of scope.
