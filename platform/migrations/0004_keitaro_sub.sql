-- Which Keitaro sub_id holds the Facebook campaign id (the join key between FB
-- spend and Keitaro revenue). Asked during onboarding; default sub_id_4.
ALTER TABLE settings ADD COLUMN keitaro_sub TEXT;
