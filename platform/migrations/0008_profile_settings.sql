-- Profile settings: whether to push the fresh «Сейчас» report into the bot on
-- every data refresh, and how often to pull from Keitaro and the ad accounts
-- (minutes: 30 / 60 / 120).
ALTER TABLE settings ADD COLUMN notify_on_update INTEGER;
ALTER TABLE settings ADD COLUMN refresh_minutes INTEGER;
