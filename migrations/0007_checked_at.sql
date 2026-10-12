-- when blyxt last refetched an imported item to look for stealth edits (§13.3)
ALTER TABLE imported ADD COLUMN checked_at TEXT;
