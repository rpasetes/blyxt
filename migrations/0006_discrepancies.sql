-- protocol violations seen in followed blygs (§13.3), each surfaced once
CREATE TABLE discrepancies (
  origin TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,       -- regression | stealth | hash
  version INTEGER NOT NULL, -- the version the blyg served
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  PRIMARY KEY (origin, item_id, kind, version, detail)
);
