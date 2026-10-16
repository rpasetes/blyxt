-- the latest version blyxt has read of each followed blyg's posts; quotes bake from this, never a live fetch (§10.2)
CREATE TABLE snapshots (
  origin TEXT NOT NULL,
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content_html TEXT NOT NULL,
  page TEXT,
  author TEXT,
  fetched TEXT NOT NULL,
  PRIMARY KEY (origin, item_id)
);
CREATE INDEX snapshots_item ON snapshots (item_id);
