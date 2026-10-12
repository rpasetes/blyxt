-- threads (§10): the transclusions each version baked, as JSON; NULL for fragments
ALTER TABLE items ADD COLUMN transclusions TEXT;
ALTER TABLE versions ADD COLUMN transclusions TEXT;
-- a thread started by replying in Pub: the directive (and quote) blyxt put before the message text,
-- so edits to that message keep quoting the same post
ALTER TABLE tg_messages ADD COLUMN prefix TEXT;
