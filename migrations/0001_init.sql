-- current state of each item; what items/{id}.json serves
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_md TEXT NOT NULL,
  content_html TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

-- every publish event; one feed entry each. Content is kept privately and
-- only served at items/{id}/v{n}.json once pinned.
CREATE TABLE versions (
  item_id TEXT NOT NULL REFERENCES items(id),
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  note TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  content_md TEXT NOT NULL,
  content_html TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (item_id, version)
);
CREATE INDEX versions_at ON versions (at DESC);

-- which Telegram message published which item, for edits/pins and idempotent retries
CREATE TABLE tg_messages (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id),
  PRIMARY KEY (chat_id, message_id)
);
