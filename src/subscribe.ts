// Read side of the Sub topic: subscriptions and polling (spec §12.3, §13).
import { ID_RE, now } from "./blyg";
import { USER_AGENT, type Manifest } from "./resolve";
import { tg } from "./telegram";

export type Subscription = {
  origin: string;
  title: string;
  index_url: string;
  index_etag: string | null;
  created: string;
  last_polled: string | null;
  next_poll: string;
  failures: number;
  last_error: string | null;
};

type Imported = { item_id: string; version: number; kind: string; content_hash: string | null; tg_message_id: number | null };
type IndexEntry = { id: string; kind: string; created?: string; version: number };
type ItemDoc = { id: string; kind: string; version: number; content_md?: string; content_hash?: string; page?: string };

export type Sub = { token: string; chatId: number; topicId: number };

export const POLL_MINUTES = 15;
const KINDS = new Set(["fragment", "thread", "withdrawn"]);
// Workers allow 50 subrequests per invocation on the free plan; leave room for Telegram calls
const FETCH_BUDGET = 20;
const MAX_MESSAGE = 3500;

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

const get = (url: string, etag?: string | null) =>
  fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...(etag ? { "if-none-match": etag } : {}) },
    signal: AbortSignal.timeout(10_000),
  });

export const listSubscriptions = async (db: D1Database) =>
  (await db.prepare("SELECT * FROM subscriptions ORDER BY created").all<Subscription>()).results;

export const getSubscription = (db: D1Database, origin: string) =>
  db.prepare("SELECT * FROM subscriptions WHERE origin = ?").bind(origin).first<Subscription>();

export async function removeSubscription(db: D1Database, origin: string) {
  await db.batch([
    db.prepare("DELETE FROM imported WHERE origin = ?").bind(origin),
    db.prepare("DELETE FROM subscriptions WHERE origin = ?").bind(origin),
  ]);
}

type IndexResult =
  | { status: "unchanged" }
  | { status: "ok"; items: IndexEntry[]; etag: string | null }
  | { status: "error"; error: string; retryAfter: string | null };

async function fetchIndex(url: string, etag?: string | null): Promise<IndexResult> {
  const res = await get(url, etag);
  const fail = (error: string): IndexResult => ({ status: "error", error, retryAfter: res.headers.get("retry-after") });
  if (res.status === 304) return { status: "unchanged" };
  if (!res.ok) return fail(`${res.status} from ${url}`);
  try {
    const data = (await res.json()) as { items?: unknown };
    if (!Array.isArray(data.items)) return fail(`no items array in ${url}`);
    const items = data.items.filter(
      (i): i is IndexEntry => !!i && typeof i.id === "string" && ID_RE.test(i.id) && Number.isInteger(i.version) && KINDS.has(i.kind),
    );
    return { status: "ok", items, etag: res.headers.get("etag") };
  } catch {
    return fail(`unparseable ${url}`);
  }
}

async function fetchItem(origin: string, id: string): Promise<ItemDoc | null> {
  const res = await get(new URL(`items/${id}.json`, origin).href);
  if (!res.ok) return null;
  try {
    const doc = (await res.json()) as ItemDoc;
    return doc && doc.id === id && Number.isInteger(doc.version) && KINDS.has(doc.kind) ? doc : null;
  } catch {
    return null;
  }
}

// Subscribing baselines every current item without posting it, then shows the newest one.
export async function addSubscription(db: D1Database, sub: Sub, origin: string, manifest: Manifest) {
  const title = (typeof manifest.title === "string" && manifest.title.trim()) || new URL(origin).host;
  const indexUrl = new URL(typeof manifest.items === "string" ? manifest.items : "items/index.json", origin).href;
  const index = await fetchIndex(indexUrl);
  if (index.status !== "ok") throw new Error(index.status === "error" ? index.error : "archive index unavailable");

  const at = now();
  await db.batch([
    db.prepare("INSERT INTO subscriptions (origin, title, index_url, index_etag, created, last_polled, next_poll) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(origin, title, indexUrl, index.etag, at, at, minutesFromNow(POLL_MINUTES)),
    ...index.items.map((i) =>
      db.prepare("INSERT OR IGNORE INTO imported (origin, item_id, version, kind) VALUES (?, ?, ?, ?)").bind(origin, i.id, i.version, i.kind),
    ),
  ]);

  const newest = index.items.find((i) => i.kind !== "withdrawn");
  if (newest) {
    const doc = await fetchItem(origin, newest.id);
    if (doc) await present(db, sub, { origin, title }, doc, { item_id: doc.id, version: 0, kind: doc.kind, content_hash: null, tg_message_id: null });
  }
  return { title, count: index.items.length };
}

function messageText(title: string, origin: string, doc: ItemDoc) {
  if (doc.kind === "withdrawn") return `${title} · withdrawn`;
  const link = new URL(doc.page ?? `${doc.kind === "thread" ? "t" : "f"}/${doc.id}/`, origin).href;
  let body = (doc.content_md ?? "").trim();
  if (body.length > MAX_MESSAGE) body = body.slice(0, MAX_MESSAGE).trimEnd() + "…";
  return `${title}${doc.version > 1 ? ` · v${doc.version}` : ""}\n\n${body}\n\n${link}`;
}

// Show a document in the Sub topic: a new message for a new item, an edit for a later version.
async function present(db: D1Database, sub: Sub, s: Pick<Subscription, "origin" | "title">, doc: ItemDoc, row: Imported | undefined) {
  const text = messageText(s.title, s.origin, doc);
  let messageId = row?.tg_message_id ?? null;

  if (messageId) {
    const edited = await tg(sub.token, "editMessageText", { chat_id: sub.chatId, message_id: messageId, text, link_preview_options: { is_disabled: true } });
    if (!edited.ok) messageId = null;
  }
  // withdrawn content is never posted fresh (§13.4); there is nothing to show
  if (!messageId && doc.kind !== "withdrawn") {
    const sent = await tg(sub.token, "sendMessage", { chat_id: sub.chatId, message_thread_id: sub.topicId, text, link_preview_options: { is_disabled: true } });
    messageId = sent.ok ? (sent.result as { message_id: number }).message_id : null;
  }

  await db.prepare(
    `INSERT INTO imported (origin, item_id, version, kind, content_hash, tg_message_id) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (origin, item_id) DO UPDATE SET version = excluded.version, kind = excluded.kind, content_hash = excluded.content_hash, tg_message_id = excluded.tg_message_id`,
  ).bind(s.origin, doc.id, doc.version, doc.kind, doc.content_hash ?? null, messageId).run();
}

// One poll of one blyg: diff its archive index against our watermarks (§13.2).
async function pollOne(db: D1Database, sub: Sub, s: Subscription, budget: { left: number }) {
  budget.left--;
  const index = await fetchIndex(s.index_url, s.index_etag);
  if (index.status === "unchanged") return { ok: true as const };
  if (index.status === "error") return { ok: false as const, error: index.error, retryAfter: index.retryAfter };

  const { results } = await db.prepare("SELECT item_id, version, kind, content_hash, tg_message_id FROM imported WHERE origin = ?").bind(s.origin).all<Imported>();
  const seen = new Map(results.map((r) => [r.item_id, r]));
  const changed = index.items
    .filter((i) => i.version > (seen.get(i.id)?.version ?? 0))
    .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));

  let complete = true;
  for (const entry of changed) {
    if (budget.left <= 0) { complete = false; break; }
    budget.left--;
    const doc = await fetchItem(s.origin, entry.id);
    const row = seen.get(entry.id);
    // the document is ground truth; never adopt a version below the watermark (§13.3)
    if (!doc || doc.version <= (row?.version ?? 0)) { complete = false; continue; }
    await present(db, sub, s, doc, row);
  }
  // only remember the index's ETag once everything it listed has been applied
  await db.prepare("UPDATE subscriptions SET index_etag = ? WHERE origin = ?").bind(complete ? index.etag : null, s.origin).run();
  return { ok: true as const };
}

export async function pollDue(db: D1Database, sub: Sub) {
  const { results } = await db.prepare("SELECT * FROM subscriptions WHERE next_poll <= ? ORDER BY next_poll").bind(now()).all<Subscription>();
  const budget = { left: FETCH_BUDGET };
  for (const s of results) {
    if (budget.left <= 0) break;
    const result = await pollOne(db, sub, s, budget).catch((e) => ({ ok: false as const, error: String(e), retryAfter: null }));
    if (result.ok) {
      await db.prepare("UPDATE subscriptions SET last_polled = ?, next_poll = ?, failures = 0, last_error = NULL WHERE origin = ?")
        .bind(now(), minutesFromNow(POLL_MINUTES), s.origin).run();
    } else {
      // exponential backoff capped at a day; Retry-After can only lengthen it (§12.3)
      const backoff = Math.min(POLL_MINUTES * 2 ** (s.failures + 1), 24 * 60);
      const retryAfter = Number(result.retryAfter) / 60 || 0;
      await db.prepare("UPDATE subscriptions SET last_polled = ?, next_poll = ?, failures = failures + 1, last_error = ? WHERE origin = ?")
        .bind(now(), minutesFromNow(Math.max(backoff, retryAfter)), result.error, s.origin).run();
    }
  }
}
