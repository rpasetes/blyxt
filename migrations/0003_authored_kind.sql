-- the kind an item was authored as; it fixes the page path (f/ or t/), which
-- a withdrawal endcap keeps (§9) and a return to publication restores
ALTER TABLE items ADD COLUMN authored_kind TEXT NOT NULL DEFAULT 'fragment';
UPDATE items SET authored_kind = kind WHERE kind != 'withdrawn';
