-- a changelog note queued with /note in Pub; the post's next edit publishes its version with it
CREATE TABLE pending_notes (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  note TEXT NOT NULL,
  at TEXT NOT NULL
);
