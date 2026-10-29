-- held revisions: an edit that arrives with no changelog note waits here unpublished until the owner writes one.
-- Rows stay after they resolve, so a retried or late reply to blyxt's question is recognized, never published as a post
CREATE TABLE held_edits (
  id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  -- the version the edit was made against; if the post moves past it, the hold is dropped
  base_version INTEGER NOT NULL,
  -- JSON of the content the edit composed: md, html, transclusions, links
  content TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  -- blyxt's "what changed?" message; replying to it with a note publishes the edit
  ask_message_id INTEGER,
  -- held, published or dropped
  state TEXT NOT NULL DEFAULT 'held',
  at TEXT NOT NULL
);
CREATE INDEX held_edits_item ON held_edits (item_id, state);
CREATE INDEX held_edits_ask ON held_edits (chat_id, ask_message_id);
