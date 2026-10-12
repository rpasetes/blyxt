-- drafts other clients (an agent, a script) submit for the owner to publish from Pub; invisible to the
-- protocol until then, and discarding one is a hard delete (§5.2, §9)
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  content_md TEXT NOT NULL,
  -- JSON of the generated[] entries the draft declared (§5.7), or NULL
  generated TEXT,
  created TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  -- the Pub message previewing it, and the full markdown attached when the preview was cut short
  message_id INTEGER,
  file_message_id INTEGER
);
CREATE INDEX drafts_message ON drafts (chat_id, message_id);
