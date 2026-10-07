-- blygs followed from the Sub topic; origin is the fetch origin (§12.2)
CREATE TABLE subscriptions (
  origin TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  index_url TEXT NOT NULL,
  index_etag TEXT,
  created TEXT NOT NULL,
  last_polled TEXT,
  next_poll TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- per imported item: the version watermark (§13.3) and the Sub message showing it
CREATE TABLE imported (
  origin TEXT NOT NULL REFERENCES subscriptions(origin) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content_hash TEXT,
  tg_message_id INTEGER,
  PRIMARY KEY (origin, item_id)
);
