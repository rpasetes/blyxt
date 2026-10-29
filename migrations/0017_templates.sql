-- the manifest-located surface (§6.1): where a followed blyg keeps its item and pin documents, as its manifest's
-- RFC 6570 templates; NULL means the default (items/{id}.json, items/{id}/v{n}.json). manifest_checked is when
-- blyxt last re-read the manifest, so a blyg that moves its surface is followed there
ALTER TABLE subscriptions ADD COLUMN item_tpl TEXT;
ALTER TABLE subscriptions ADD COLUMN pin_tpl TEXT;
ALTER TABLE subscriptions ADD COLUMN manifest_checked TEXT;
-- the origin a followed blyg's manifest last redirected to: adopting it is an identity change the user makes by
-- subscribing there (§12.2), so blyxt only says so, once per new origin
ALTER TABLE subscriptions ADD COLUMN moved_to TEXT;
