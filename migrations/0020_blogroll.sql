-- the blogroll (§11) is curated: a subscription is in it only once the owner says so (/roll), never by default.
-- Unsubscribing deletes the row, so it leaves the blogroll too
ALTER TABLE subscriptions ADD COLUMN blogroll INTEGER NOT NULL DEFAULT 0;
