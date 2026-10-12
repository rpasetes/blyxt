import { contentHash, newId, now, type AuthoredKind, type Item, type Version } from "./blyg";

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
  db.prepare("SELECT item_id FROM tg_messages WHERE chat_id = ? AND message_id = ?").bind(chatId, messageId).first<{ item_id: string }>();

// new item at v1, linked to the Telegram message that wrote it
// html comes from compose(), which resolves links and makes URLs absolute
export async function publishNew(db: D1Database, kind: AuthoredKind, md: string, html: string, source: { chatId: number; messageId: number }) {
  const at = now();
  const item: Item = {
    id: newId(),
    kind,
    authored_kind: kind,
    created: at,
    updated: at,
    version: 1,
    content_md: md,
    content_html: html,
    content_hash: await contentHash(md),
  };
  await db.batch([
    db.prepare("INSERT INTO items (id, kind, authored_kind, created, updated, version, content_md, content_html, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(item.id, item.kind, item.authored_kind, item.created, item.updated, item.version, item.content_md, item.content_html, item.content_hash),
    db.prepare("INSERT INTO versions (item_id, version, kind, at, note, content_md, content_html, content_hash) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)")
      .bind(item.id, 1, item.kind, at, item.content_md, item.content_html, item.content_hash),
    db.prepare("INSERT INTO tg_messages (chat_id, message_id, item_id) VALUES (?, ?, ?)")
      .bind(source.chatId, source.messageId, item.id),
  ]);
  return item;
}

// next version of an existing item; returns null when the text didn't change
export async function publishEdit(db: D1Database, id: string, md: string, html: string) {
  const item = await getItem(db, id);
  if (!item || item.kind === "withdrawn" || item.content_md === md) return null;
  const at = now();
  const next: Item = {
    ...item,
    updated: at,
    version: item.version + 1,
    content_md: md,
    content_html: html,
    content_hash: await contentHash(md),
  };
  await db.batch([
    db.prepare("UPDATE items SET updated = ?, version = ?, content_md = ?, content_html = ?, content_hash = ? WHERE id = ? AND version = ?")
      .bind(next.updated, next.version, next.content_md, next.content_html, next.content_hash, id, item.version),
    db.prepare("INSERT INTO versions (item_id, version, kind, at, note, content_md, content_html, content_hash) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)")
      .bind(id, next.version, next.kind, at, next.content_md, next.content_html, next.content_hash),
  ]);
  return next;
}

// the endcap (§9): a version bump with the content emptied; the page and changelog stay
// returns null when the item is already withdrawn
export async function withdraw(db: D1Database, id: string, note: string | null) {
  const item = await getItem(db, id);
  if (!item || item.kind === "withdrawn") return null;
  const at = now();
  const next: Item = {
    ...item,
    kind: "withdrawn",
    updated: at,
    version: item.version + 1,
    content_md: "",
    content_html: "",
    content_hash: await contentHash(""),
  };
  await db.batch([
    db.prepare("UPDATE items SET kind = ?, updated = ?, version = ?, content_md = '', content_html = '', content_hash = ? WHERE id = ? AND version = ?")
      .bind(next.kind, next.updated, next.version, next.content_hash, id, item.version),
    db.prepare("INSERT INTO versions (item_id, version, kind, at, note, content_md, content_html, content_hash) VALUES (?, ?, 'withdrawn', ?, ?, '', '', ?)")
      .bind(id, next.version, at, note, next.content_hash),
  ]);
  return next;
}

export type PinnedVersion = Version & { content_md: string; content_html: string; content_hash: string };

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
