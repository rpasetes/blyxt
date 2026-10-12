-- followed blygs whose archive index is missing are followed through their feed instead,
-- which can miss posts that scroll out of its window between polls (§13.2)
ALTER TABLE subscriptions ADD COLUMN feed_url TEXT;
ALTER TABLE subscriptions ADD COLUMN lossy INTEGER NOT NULL DEFAULT 0;
UPDATE subscriptions SET feed_url = origin || 'feed.xml';
