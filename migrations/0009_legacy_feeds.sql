-- plain RSS/Atom feeds followed as legacy (L0) subscriptions (§13.6); their origin is the feed URL
ALTER TABLE subscriptions ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0;
