-- disclosed links (§10.3a): JSON of the links[] a version resolved from its [[id]] links; NULL when it has none, and on endcaps
ALTER TABLE items ADD COLUMN links TEXT;
ALTER TABLE versions ADD COLUMN links TEXT;
