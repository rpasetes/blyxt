-- generation provenance (§5.7): JSON of the generated[] entries each version disclosed; NULL when none
ALTER TABLE items ADD COLUMN generated TEXT;
ALTER TABLE versions ADD COLUMN generated TEXT;
