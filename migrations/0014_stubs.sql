-- stubs (§10.6): JSON of the stub_of reference a thread version responds to; NULL otherwise, and on endcaps
ALTER TABLE items ADD COLUMN stub_of TEXT;
ALTER TABLE versions ADD COLUMN stub_of TEXT;

-- outbound Webmentions (§15.2): one per remote reference of a post, re-sent when the reference changes
CREATE TABLE mentions_out (
  item_id TEXT NOT NULL REFERENCES items(id),
  target_origin TEXT NOT NULL,
  target_id TEXT NOT NULL,
  -- the target version last sent for; a republish re-sends only when it changes
  target_version INTEGER NOT NULL,
  relation TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  -- pending, sent, failed, or no-endpoint
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try TEXT,
  last_error TEXT,
  updated TEXT NOT NULL,
  PRIMARY KEY (item_id, target_origin, target_id)
);
CREATE INDEX mentions_out_due ON mentions_out (status, next_try);
