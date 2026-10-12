-- Sub groupings: each Sub topic follows its own set of blygs. A followed blyg is
-- still fetched once per poll (subscriptions keeps that fetch state) and shown in
-- every topic that follows it.
PRAGMA defer_foreign_keys = true;

CREATE TABLE sub_topics (
  topic_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created TEXT NOT NULL
);

CREATE TABLE follows (
  topic_id INTEGER NOT NULL REFERENCES sub_topics(topic_id) ON DELETE CASCADE,
  origin TEXT NOT NULL REFERENCES subscriptions(origin) ON DELETE CASCADE,
  created TEXT NOT NULL,
  PRIMARY KEY (topic_id, origin)
);

-- per topic and imported item: the version watermark (§13.3), the Sub message
-- showing it, and the latest reply announcing a later version
CREATE TABLE imported_by_topic (
  topic_id INTEGER NOT NULL,
  origin TEXT NOT NULL,
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content_hash TEXT,
  tg_message_id INTEGER,
  posted_at TEXT,
  reply_message_id INTEGER,
  replied_at TEXT,
  PRIMARY KEY (topic_id, origin, item_id),
  FOREIGN KEY (topic_id, origin) REFERENCES follows(topic_id, origin) ON DELETE CASCADE
);

-- existing subscriptions all lived in the one Sub topic: SUB_TOPIC_ID in wrangler.jsonc
INSERT INTO sub_topics (topic_id, name, created)
  SELECT 3, 'Sub', MIN(created) FROM subscriptions HAVING COUNT(*) > 0;
INSERT INTO follows (topic_id, origin, created)
  SELECT 3, origin, created FROM subscriptions;
INSERT INTO imported_by_topic (topic_id, origin, item_id, version, kind, content_hash, tg_message_id)
  SELECT 3, origin, item_id, version, kind, content_hash, tg_message_id FROM imported;

DROP TABLE imported;
ALTER TABLE imported_by_topic RENAME TO imported;
