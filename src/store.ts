import { contentHash, generatedBlock, newId, now, type AuthoredKind, type Generated, type Item, type Kind, type Transclusion, type Version } from "./blyg";

export async function listItems(db: D1Database) {
  const { results } = await db.prepare("SELECT * FROM items ORDER BY updated DESC, id").all<Item>();
  return results;
}

export const getItem = (db: D1Database, id: string) =>
  db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Item>();

export async function changelog(db: D1Database, id: string) {
  const { results } = await db
    .prepare("SELECT item_id, version, kind, at, note, pinned FROM versions WHERE item_id = ? ORDER BY version")
    .bind(id)
    .all<Version>();
  return results;
}

// a withdrawn item contributes only its withdrawal event (§7)
export async function recentEvents(db: D1Database, limit: number) {
  const { results } = await db
    .prepare(`SELECT v.item_id, v.version, v.kind, v.at, v.note, v.pinned FROM versions v JOIN items i ON i.id = v.item_id
      WHERE i.kind != 'withdrawn' OR v.version = i.version ORDER BY v.at DESC, v.version DESC LIMIT ?`)
    .bind(limit)
    .all<Version>();
  return results;
}

export async function lastUpdated(db: D1Database) {
  const row = await db.prepare("SELECT MAX(updated) AS u FROM items").first<{ u: string | null }>();
  return row?.u ?? "1970-01-01T00:00:00Z";
}

export const itemForMessage = (db: D1Database, chatId: number, messageId: number) =>
  db.prepare("SELECT item_id, prefix FROM tg_messages WHERE chat_id = ? AND message_id = ?").bind(chatId, messageId).first<{ item_id: string; prefix: string | null }>();

// what a publish event says; html and transclusions come from compose(), which resolves and bakes;
// generated is the provenance of a machine-generated body (§5.7)
export type Content = { md: string; html: string; transclusions: Transclusion[]; generated?: Generated[] };
const EMPTY: Content = { md: "", html: "", transclusions: [] };

// threads record their transclusions on every version; fragments never carry the key (§10.3)
const transclusionsOf = (kind: AuthoredKind, c: Content) => (kind === "thread" ? JSON.stringify(c.transclusions) : null);
const generatedOf = (c: Content) => (c.generated?.length ? JSON.stringify(c.generated) : null);
// a generated body is marked in content_html too (§5.7)
const htmlOf = (c: Content) => (c.generated?.length ? generatedBlock(c.html) : c.html);

// new item at v1, linked to the Telegram message that wrote it (and the quote blyxt prefixed, for a reply)
export async function publishNew(db: D1Database, kind: AuthoredKind, c: Content, source: { chatId: number; messageId: number; prefix?: string }) {
  const at = now();
  const item: Item = {
    id: newId(),
    kind,
    authored_kind: kind,
    created: at,
    updated: at,
    version: 1,
    content_md: c.md,
    content_html: htmlOf(c),
    content_hash: await contentHash(c.md),
    transclusions: transclusionsOf(kind, c),
    generated: generatedOf(c),
  };
  await db.batch([
    db.prepare("INSERT INTO items (id, kind, authored_kind, created, updated, version, content_md, content_html, content_hash, transclusions, generated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(item.id, item.kind, item.authored_kind, item.created, item.updated, item.version, item.content_md, item.content_html, item.content_hash, item.transclusions, item.generated),
    db.prepare("INSERT INTO versions (item_id, version, kind, at, note, content_md, content_html, content_hash, transclusions, generated) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)")
      .bind(item.id, 1, item.kind, at, item.content_md, item.content_html, item.content_hash, item.transclusions, item.generated),
    db.prepare("INSERT INTO tg_messages (chat_id, message_id, item_id, prefix) VALUES (?, ?, ?, ?)")
      .bind(source.chatId, source.messageId, item.id, source.prefix ?? null),
  ]);
  return item;
}

// the next version of an item; the WHERE version guard and the versions primary key make a racing publish fail whole
async function bump(db: D1Database, item: Item, kind: Kind, c: Content, note: string | null) {
  const at = now();
  const next: Item = {
    ...item,
    kind,
    updated: at,
    version: item.version + 1,
    content_md: c.md,
    content_html: htmlOf(c),
    content_hash: await contentHash(c.md),
    // a withdrawn thread's endcap carries [] (§9)
    transclusions: transclusionsOf(item.authored_kind, c),
    generated: generatedOf(c),
  };
  await db.batch([
    db.prepare("UPDATE items SET kind = ?, updated = ?, version = ?, content_md = ?, content_html = ?, content_hash = ?, transclusions = ?, generated = ? WHERE id = ? AND version = ?")
      .bind(next.kind, next.updated, next.version, next.content_md, next.content_html, next.content_hash, next.transclusions, next.generated, item.id, item.version),
    db.prepare("INSERT INTO versions (item_id, version, kind, at, note, content_md, content_html, content_hash, transclusions, generated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(item.id, next.version, next.kind, at, note, next.content_md, next.content_html, next.content_hash, next.transclusions, next.generated),
  ]);
  return next;
}

// next version of a published item; null when the text didn't change or the item is withdrawn
// (a thread re-resolves on every publish, so unchanged text is still unchanged content: snapshots refresh on the next edit)
export async function publishEdit(db: D1Database, id: string, c: Content) {
  const item = await getItem(db, id);
  if (!item || item.kind === "withdrawn" || item.content_md === c.md) return null;
  return bump(db, item, item.kind, c, null);
}

// the endcap (§9): a version bump with the content emptied; the page and changelog stay
// returns null when the item is already withdrawn
export async function withdraw(db: D1Database, id: string, note: string | null) {
  const item = await getItem(db, id);
  if (!item || item.kind === "withdrawn") return null;
  return bump(db, item, "withdrawn", EMPTY, note);
}

// the last content a withdrawn item published, and its provenance, to bring it back with
export const lastContent = (db: D1Database, id: string) =>
  db.prepare("SELECT content_md, generated FROM versions WHERE item_id = ? AND kind != 'withdrawn' ORDER BY version DESC LIMIT 1").bind(id).first<{ content_md: string; generated: string | null }>();

// a withdrawn item returns under its id: vN+1 with its authored kind (§9); null unless it is withdrawn
export async function republish(db: D1Database, id: string, c: Content, note: string | null) {
  const item = await getItem(db, id);
  if (!item || item.kind !== "withdrawn") return null;
  return bump(db, item, item.authored_kind, c, note);
}

export type PinnedVersion = Version & { content_md: string; content_html: string; content_hash: string; transclusions: string | null; generated: string | null };

// a pinned version's content, or null: unpinned history is never served (§8)
export const getPinned = (db: D1Database, id: string, version: number) =>
  db.prepare("SELECT * FROM versions WHERE item_id = ? AND version = ? AND pinned = 1").bind(id, version).first<PinnedVersion>();

// pins are irrevocable and emit no feed event; updated stays the latest changelog entry's time (§5.3, §7, §8)
export async function pin(db: D1Database, id: string, version: number) {
  const row = await db.prepare("SELECT kind, pinned FROM versions WHERE item_id = ? AND version = ?").bind(id, version).first<{ kind: string; pinned: number }>();
  if (!row) return "no such version" as const;
  if (row.kind === "withdrawn") return "endcap" as const;
  if (row.pinned) return "already" as const;
  await db.prepare("UPDATE versions SET pinned = 1 WHERE item_id = ? AND version = ?").bind(id, version).run();
  return "pinned" as const;
}
