-- Fixed query windows and their next persisted source offset survive Worker restarts.
-- No source facts, observations, snapshots or legacy aggregates are rewritten.
ALTER TABLE keitaro_history_state ADD COLUMN continuation TEXT
 CHECK (continuation IS NULL OR json_valid(continuation));
