-- presentation only, never part of an item: filing a post or listing it in the menu makes no new version
CREATE TABLE collections (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE collection_items (
  slug TEXT NOT NULL REFERENCES collections(slug),
  item_id TEXT NOT NULL REFERENCES items(id),
  at TEXT NOT NULL,
  PRIMARY KEY (slug, item_id)
);
-- posts listed in the menu under Pages (an About thread), by label
CREATE TABLE menu_pages (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  label TEXT NOT NULL,
  at TEXT NOT NULL
);
