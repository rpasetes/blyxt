// The home page's furniture: collections (/file) and menu pages (/page). Presentation only, held beside the
// items and never in them, so filing or listing a post publishes nothing and makes no version.
import { now, pagePath, type Item, type Menu, type Rolled, type Site } from "./blyg";

// "Variegated Demand Theory" → variegated-demand-theory
export const slugOf = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);

export async function file(db: D1Database, id: string, name: string) {
  const slug = slugOf(name);
  if (!slug) return null;
  await db.prepare("INSERT INTO collections (slug, name, created) VALUES (?, ?, ?) ON CONFLICT (slug) DO NOTHING").bind(slug, name, now()).run();
  const had = await db.prepare("SELECT 1 FROM collection_items WHERE slug = ? AND item_id = ?").bind(slug, id).first();
  if (!had) await db.prepare("INSERT INTO collection_items (slug, item_id, at) VALUES (?, ?, ?)").bind(slug, id, now()).run();
  return { slug, name: (await collection(db, slug))!.name, added: !had };
}

export async function unfile(db: D1Database, id: string, name: string) {
  const slug = slugOf(name);
  const had = await db.prepare("SELECT 1 FROM collection_items WHERE slug = ? AND item_id = ?").bind(slug, id).first();
  if (had) await db.prepare("DELETE FROM collection_items WHERE slug = ? AND item_id = ?").bind(slug, id).run();
  return !!had;
}

export const collection = (db: D1Database, slug: string) =>
  db.prepare("SELECT slug, name FROM collections WHERE slug = ?").bind(slug).first<{ slug: string; name: string }>();

// a collection's posts, newest first; withdrawn ones stay filed but aren't shown
export async function collectionItems(db: D1Database, slug: string) {
  const { results } = await db.prepare(
    "SELECT i.* FROM collection_items c JOIN items i ON i.id = c.item_id WHERE c.slug = ? AND i.kind != 'withdrawn' ORDER BY i.updated DESC, i.id",
  ).bind(slug).all<Item>();
  return results;
}

export async function setPage(db: D1Database, id: string, label: string | null) {
  if (label === null) return db.prepare("DELETE FROM menu_pages WHERE item_id = ?").bind(id).run();
  return db.prepare("INSERT INTO menu_pages (item_id, label, at) VALUES (?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET label = excluded.label")
    .bind(id, label, now()).run();
}

// what the menu shows: pages in the order they were listed, then collections with something to show
export async function menuOf(db: D1Database, site: Site): Promise<Menu> {
  const pages = await db.prepare(
    "SELECT p.label, i.id, i.authored_kind FROM menu_pages p JOIN items i ON i.id = p.item_id WHERE i.kind != 'withdrawn' ORDER BY p.at",
  ).all<{ label: string; id: string; authored_kind: Item["authored_kind"] }>();
  const collections = await db.prepare(
    `SELECT c.slug, c.name, COUNT(*) AS n FROM collections c JOIN collection_items ci ON ci.slug = c.slug JOIN items i ON i.id = ci.item_id
     WHERE i.kind != 'withdrawn' GROUP BY c.slug ORDER BY c.name COLLATE NOCASE`,
  ).all<{ slug: string; name: string; n: number }>();
  return {
    blogroll: await blogroll(db),
    pages: pages.results.map((p) => ({ label: p.label, url: site.origin + pagePath(p) })),
    collections: collections.results.map((c) => ({ name: c.name, url: `${site.origin}h/${encodeURIComponent(c.slug)}/`, count: c.n })),
  };
}

// the blogroll (§11): followed blygs the owner chose to show, by title. A blyg's xmlUrl is the feed its
// manifest names (feed_url, refreshed daily), its htmlUrl the origin; a plain RSS feed's origin is its feed
// URL, so it has no htmlUrl rather than a wrong one. A followed blyg that moved still lists at the origin
// blyxt follows, because that is what's followed until the owner resubscribes
export async function blogroll(db: D1Database): Promise<Rolled[]> {
  const { results } = await db.prepare("SELECT origin, title, feed_url, legacy FROM subscriptions WHERE blogroll = 1 ORDER BY title COLLATE NOCASE, origin")
    .all<{ origin: string; title: string; feed_url: string | null; legacy: number }>();
  return results.map((r) => r.legacy
    ? { title: r.title, xmlUrl: r.feed_url ?? r.origin }
    : { title: r.title, xmlUrl: r.feed_url ?? new URL("feed.xml", r.origin).href, htmlUrl: r.origin });
}

export async function setRolled(db: D1Database, origin: string, on: boolean) {
  await db.prepare("UPDATE subscriptions SET blogroll = ? WHERE origin = ?").bind(on ? 1 : 0, origin).run();
}
