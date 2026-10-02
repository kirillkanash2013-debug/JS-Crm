-- Facebook account name (shown as «Соц» on the card, distinct from the antidetect
-- profile name which is the label) and the count of the social's own personal ad
-- accounts (outside any BM). «РК» on the card counts BM ad accounts only.
ALTER TABLE socials ADD COLUMN fb_name TEXT;
ALTER TABLE socials ADD COLUMN rk_personal INTEGER;
