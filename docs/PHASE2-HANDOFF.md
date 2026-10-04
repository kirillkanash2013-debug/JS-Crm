# Phase 2 — first historical-data milestone

Status: implemented for Architect / Control review; no merge or deploy.
Base: approved Phase 1 `2e05e15301a58e5a7b92622716769b7d0b648757`.
Branch: `implementation/phase2-historical-data`. Stacked on `implementation/phase1-social-refresh`; PR #7 and `claude-code` unchanged. `claude-code` pushes automatically deploy, so this milestone must not be pushed there.

## Confirmed existing path

`shared/keitaro-report.mjs` performs bounded, paginated `report/build` and `conversions/log` reads. Worker socket and Node container share this implementation; `platform/src/keitaro.mjs` forwards bridge responses. `platform/src/bot.mjs::loadKeitaro` previously immediately aggregated raw rows via `today.mjs`. D1 retained one encrypted latest stats payload and publication receipts, not individual conversions or old payloads.

Requested conversion fields: conversion_id, sub_id (click identifier), campaign_id/campaign (Keitaro IDs/names, NOT Meta join), offer, revenue, status, click_datetime, postback_datetime and the configured sub_id_N. Inst is currently report/build unique clicks, not individual acquisition events. Real provider response availability is NOT live verified.

## Implemented model / migration

Additive migration `platform/migrations/0014_historical_facts.sql`:
- `keitaro_evidence`: tenant + source origin + deterministic evidence digest, original encrypted response, query context and first ingestion time.
- `keitaro_events`: tenant/source/event key, source ID, evidence reference, first ingested_at and structured normalized current fact.
- `keitaro_event_observations`: original structured facts per source evidence; corrected source payouts/statuses update current knowledge without adding another event. Raw evidence retains source attribution inputs.
- `keitaro_attribution`: separate campaign relationship, canonical matched/unmatched/unattributed state, update time.
- `stats_snapshot_history`: tenant/cycle key, publication time, source timestamps and encrypted payload. SQL UPDATE/DELETE rejection; stored atomically with latest pointer and receipt. Migration copies only a recoverable latest payload with matching receipt; missing pre-migration historical payloads cannot be reconstructed.

Legacy tables remain. Events and attribution are ingested in bounded batches before presentation aggregation; retries resume safely. Evidence persists before normalization, including a response with inadequate identity. Production must apply migration before running new Worker code; no migration has been applied remotely.

## Contracts

Stable conversion_id is the primary identifier scoped by tenant and source origin. Without it, SHA-256 identity includes click ID, actual conversion timestamp, status and source offer identity; payout, Meta attribution and ingestion day are excluded. Missing both a stable ID and sufficient deterministic identity fails closed after raw evidence storage. Two indistinguishable source conversions without unique source identifiers cannot be distinguished reliably.

Timestamp strings preserve provider semantics verbatim; absent timestamps remain null. first_click_at uses actual click time, registration_at for lead uses conversion time, ftd_at for sale uses conversion time; explicitly supplied event-time fields take precedence. No strict timezone normalization. Dep remains sale/FTD under existing contract.

Revenue amount is source payout as a decimal string, currency is an explicit nullable source field. Unknown is null, zero is retained as zero; settings currency is never substituted. Country and payout source are preserved when supplied. No FX or anomaly logic.

Meta join uses configured sub_id_N, never campaign name or Keitaro campaign_id. No ID = unattributed (Долёт); existing ID not in known Meta set = unmatched. New Meta data re-matches old unmatched facts even outside today's source response. An already matched same relationship is retained if temporarily unavailable in a later Meta set. Re-attribution and corrected source facts never add a second event. Distinct source instances reusing the same origin/IDs would require an explicit source-instance identifier.

Current presentation aggregation dedupes conversions by normalized identity. Attribution correction removes previous click-day-based Долёт classification; formatting, formulas and UI remain unchanged. Legacy aggregates remain for current presentation compatibility; normalized facts are the separate historical layer, not Telegram text.

Published payload now includes structured campaigns, Keitaro aggregates, Meta source generations and Keitaro evidence ID/ingestion time, alongside legacy rendered text for read compatibility. Historical business data does not depend on rendered text. Legacy no-cycle completion also uses atomic publication storage. Collector fences and Phase 1 ownership/refresh contracts are unchanged.

## Changed files

Migration 0014; platform/src/history.mjs; platform/src/store.mjs; platform/src/bot.mjs; platform/src/today.mjs; platform/tests/history.test.mjs; platform/tests/today.test.mjs; .github/workflows/phase1-checks.yml; this handoff. Workflow adds check-only pushes for this implementation branch; no deployment workflow changes.

## Tests

Six new tests exercise real D1 SQL/migrations and memory: stable/fallback dedupe, late event timestamps, re-attribution without today's conversion rows, tenant/source isolation, nullable money versus zero, non-default sub_id, registration/FTD semantics, day rollover, missing identity, corrected payout with retained observations, matched relationship retention, immutable old snapshots/replay and atomic rollback on history failure. Existing rendering fixture now represents Долёт with absent campaign ID.

Local full suite: 216 passed, 0 failed, 1 skipped (217 total); Chromium unavailable locally. Root npm test passed. Final exact-head CI must be checked separately; full suite rerun after final changes.

CODED: yes (first milestone).
TESTED: local SQL, regressions and existing suites; exact-head CI reported in PR handoff.
DEPLOYED: no.
LIVE VERIFIED: no.

## Remaining gaps / risks — Phase 2 is not declared fully complete

НЕИЗВЕСТНО: actual Keitaro version response schema, stable conversion_id uniqueness/updates, provider status sale=first-deposit semantics, currency/country availability. Current request does not ask optional currency/GEO columns; fields are nullable if omitted. Need read-only provider capability verification before changing requested columns.

Inst remains an aggregate: no click-log/acquisition feed has been verified; do not fabricate individual events from aggregate counts. Historical backfill and overlapping lookback scheduling are not added; late rows are safely persisted when the current source query returns them, but arbitrary older provider edits outside that query are not automatically discovered. Existing aggregates are not migrated into invented events.

Latest observed source fact wins for a reused stable ID; raw and normalized observations retain previous versions. No provider revision-order guarantee has been confirmed. Fallback identity depends on source timestamps/status/offer stability; changes to those fields without stable ID cannot safely be inferred as updates.

Strict calendar/timezone normalization, FX, cohort UI, Phase 3 alerts and payout anomalies remain out of scope. Architect should review this milestone and remaining acquisition/source-capability work before Phase 2 acceptance.
