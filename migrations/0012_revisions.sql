-- revision drafts: a draft that names a published post becomes its next version when published
ALTER TABLE drafts ADD COLUMN item_id TEXT REFERENCES items(id);
-- the version it was written against; publishing refuses if the post moved on
ALTER TABLE drafts ADD COLUMN base_version INTEGER;
ALTER TABLE drafts ADD COLUMN note TEXT;
ALTER TABLE drafts ADD COLUMN note_generated INTEGER NOT NULL DEFAULT 0;
-- the client wrote the changelog note, not the author (§5.2)
ALTER TABLE versions ADD COLUMN note_generated INTEGER NOT NULL DEFAULT 0;
