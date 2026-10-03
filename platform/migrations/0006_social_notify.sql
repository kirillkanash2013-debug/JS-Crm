-- For the progressive "profile connected" card edited in place: the Telegram
-- message id to edit, and the last collected counts (ad accounts / BM / pages)
-- so the card can be re-rendered from the DB at any time (loading until set).
ALTER TABLE socials ADD COLUMN notify_msg_id TEXT;
ALTER TABLE socials ADD COLUMN rk INTEGER;
ALTER TABLE socials ADD COLUMN bm INTEGER;
ALTER TABLE socials ADD COLUMN fp INTEGER;
ALTER TABLE socials ADD COLUMN collected_at TEXT;
