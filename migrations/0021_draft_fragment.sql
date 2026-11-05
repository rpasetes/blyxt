-- a new post is a thread unless flagged a fragment; a draft carries the flag from POST /api/drafts to /publish
ALTER TABLE drafts ADD COLUMN fragment INTEGER NOT NULL DEFAULT 0;
