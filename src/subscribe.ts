// Read side of the Sub topic: subscriptions and polling (spec §12.3, §13).
import { ID_RE, now } from "./blyg";
import { USER_AGENT, type Manifest } from "./resolve";
import { toTelegramHtml } from "./tghtml";
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

type Imported = {
  topic_id: number;
  item_id: string;
  version: number;
  kind: string;
  content_hash: string | null;
  tg_message_id: number | null;
  posted_at?: string | null;
  reply_message_id?: number | null;
  replied_at?: string | null;
};
type IndexEntry = { id: string; kind: string; created?: string; version: number };
type ItemDoc = { id: string; kind: string; version: number; content_html?: string; content_hash?: string; page?: string };

export type Bot = { token: string; chatId: number };
// one Sub topic: a grouping of followed blygs
export type Sub = Bot & { topicId: number };

export const POLL_MINUTES = 15;
const KINDS = new Set(["fragment", "thread", "withdrawn"]);
// Workers allow 50 subrequests per invocation on the free plan; leave room for Telegram calls
const FETCH_BUDGET = 20;
const MAX_MESSAGE = 3500;
// a Sub message this recent is still near the bottom of its topic, so an edit to it is seen without a reply
const FRESH_MINUTES = 60;

const fresh = (at: string | null | undefined) => !!at && Date.parse(at) > Date.now() - FRESH_MINUTES * 60_000;
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

const get = (url: string, etag?: string | null) =>
  fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...(etag ? { "if-none-match": etag } : {}) },
    signal: AbortSignal.timeout(10_000),
  });

// the blygs one Sub topic follows
export const listSubscriptions = async (db: D1Database, topicId: number) =>
  (await db.prepare("SELECT s.* FROM subscriptions s JOIN follows f ON f.origin = s.origin WHERE f.topic_id = ? ORDER BY f.created")
    .bind(topicId).all<Subscription>()).results;

export const getSubscription = (db: D1Database, topicId: number, origin: string) =>
  db.prepare("SELECT s.* FROM subscriptions s JOIN follows f ON f.origin = s.origin WHERE f.topic_id = ? AND s.origin = ?")
    .bind(topicId, origin).first<Subscription>();

export type SubTopic = { topic_id: number; name: string; created: string };

export const getSubTopic = (db: D1Database, topicId: number) =>
  db.prepare("SELECT * FROM sub_topics WHERE topic_id = ?").bind(topicId).first<SubTopic>();

// register a topic as a Sub grouping, or rename one
export const nameSubTopic = (db: D1Database, topicId: number, name: string) =>
  db.prepare("INSERT INTO sub_topics (topic_id, name, created) VALUES (?, ?, ?) ON CONFLICT (topic_id) DO UPDATE SET name = excluded.name")
    .bind(topicId, name, now()).run();

// every grouping with the blygs it follows, for the overview in the home Sub topic
export async function listAllSubscriptions(db: D1Database) {
  const { results } = await db.prepare(
    `SELECT t.topic_id, t.name, s.* FROM sub_topics t LEFT JOIN follows f ON f.topic_id = t.topic_id LEFT JOIN subscriptions s ON s.origin = f.origin
     ORDER BY t.created, t.topic_id, f.created`,
  ).all<SubTopic & Partial<Subscription>>();
  return results;
}

// forget a grouping (its topic was deleted); blygs no other topic follows stop being polled
export async function removeSubTopic(db: D1Database, topicId: number) {
  await db.batch([
    db.prepare("DELETE FROM imported WHERE topic_id = ?").bind(topicId),
    db.prepare("DELETE FROM follows WHERE topic_id = ?").bind(topicId),
    db.prepare("DELETE FROM sub_topics WHERE topic_id = ?").bind(topicId),
    db.prepare("DELETE FROM subscriptions WHERE NOT EXISTS (SELECT 1 FROM follows f WHERE f.origin = subscriptions.origin)"),
  ]);
}

// unfollow in one topic; a blyg no topic follows anymore stops being polled
export async function removeSubscription(db: D1Database, topicId: number, origin: string) {
  await db.batch([
    db.prepare("DELETE FROM imported WHERE topic_id = ? AND origin = ?").bind(topicId, origin),
    db.prepare("DELETE FROM follows WHERE topic_id = ? AND origin = ?").bind(topicId, origin),
    db.prepare("DELETE FROM subscriptions WHERE origin = ? AND NOT EXISTS (SELECT 1 FROM follows WHERE origin = ?)").bind(origin, origin),
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
// A blyg another topic already follows keeps its fetch state; this topic gets its own watermarks.
export async function addSubscription(db: D1Database, sub: Sub, origin: string, manifest: Manifest, topicName = "Sub") {
  const title = (typeof manifest.title === "string" && manifest.title.trim()) || new URL(origin).host;
  const indexUrl = new URL(typeof manifest.items === "string" ? manifest.items : "items/index.json", origin).href;
  const index = await fetchIndex(indexUrl);
  if (index.status !== "ok") throw new Error(index.status === "error" ? index.error : "archive index unavailable");

  const at = now();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO sub_topics (topic_id, name, created) VALUES (?, ?, ?)").bind(sub.topicId, topicName, at),
    db.prepare("INSERT OR IGNORE INTO subscriptions (origin, title, index_url, index_etag, created, last_polled, next_poll) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(origin, title, indexUrl, index.etag, at, at, minutesFromNow(POLL_MINUTES)),
    db.prepare("INSERT INTO follows (topic_id, origin, created) VALUES (?, ?, ?)").bind(sub.topicId, origin, at),
    ...index.items.map((i) =>
      db.prepare("INSERT OR IGNORE INTO imported (topic_id, origin, item_id, version, kind) VALUES (?, ?, ?, ?, ?)").bind(sub.topicId, origin, i.id, i.version, i.kind),
    ),
  ]);

  const newest = index.items.find((i) => i.kind !== "withdrawn");
  if (newest) {
    const doc = await fetchItem(origin, newest.id);
    // the preview is a courtesy; if Telegram is busy the next new item shows up anyway
    if (doc) await present(db, sub, { origin, title }, doc, { topic_id: sub.topicId, item_id: doc.id, version: 0, kind: doc.kind, content_hash: null, tg_message_id: null }).catch(() => {});
  }
  return { title, count: index.items.length };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Sub messages show the rendered item (content_html), so baked quotes read as quotes, not ![[id]] directives
export function messageText(title: string, origin: string, doc: ItemDoc) {
  if (doc.kind === "withdrawn") return `<b>${esc(title)}</b> · withdrawn`;
  const link = new URL(doc.page ?? `${doc.kind === "thread" ? "t" : "f"}/${doc.id}/`, origin).href;
  const body = toTelegramHtml(doc.content_html ?? "", origin, MAX_MESSAGE);
  return `<b>${esc(title)}</b>${doc.version > 1 ? ` · v${doc.version}` : ""}\n\n${body}\n\n<a href="${esc(link)}">${esc(link)}</a>`;
}

// Telegram said "later" (rate limit, outage): the item stays unapplied and the next poll retries it
class Retry extends Error {}
// the topic was deleted in Telegram: its grouping goes too
class TopicGone extends Error {}

const plain = (html: string) =>
  html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

async function send(sub: Sub, method: string, body: Record<string, unknown>) {
  let result = await tg(sub.token, method, { ...body, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  // markup Telegram rejects still gets through as plain text
  if (!result.ok && result.error_code === 400 && result.description?.includes("parse entities")) {
    result = await tg(sub.token, method, { ...body, text: plain(String(body.text)), link_preview_options: { is_disabled: true } });
  }
  if (!result.ok && (result.error_code === 429 || (result.error_code ?? 500) >= 500)) throw new Retry(result.description);
  if (!result.ok && result.description?.includes("message thread not found")) throw new TopicGone(result.description);
  return result;
}

// Show a document in the Sub topic: a new message for a new item, an edit for a later version.
// Edits don't move a message, so a later version of an older post also gets a reply under it,
// and a burst of versions keeps editing that one reply while it's fresh.
async function present(db: D1Database, sub: Sub, s: Pick<Subscription, "origin" | "title">, doc: ItemDoc, row: Imported | undefined) {
  const text = messageText(s.title, s.origin, doc);
  let messageId = row?.tg_message_id ?? null;
  let postedAt = row?.posted_at ?? null;
  let replyId = row?.reply_message_id ?? null;
  let repliedAt = row?.replied_at ?? null;

  if (messageId) {
    const edited = await send(sub, "editMessageText", { chat_id: sub.chatId, message_id: messageId, text });
    // "not modified" means the message already shows this; anything else (deleted, too old) gets a fresh post
    if (!edited.ok && !edited.description?.includes("message is not modified")) messageId = replyId = repliedAt = null;
    else if (!fresh(postedAt)) {
      const reedited = replyId && fresh(repliedAt) && (await send(sub, "editMessageText", { chat_id: sub.chatId, message_id: replyId, text }));
      if (!reedited || (!reedited.ok && !reedited.description?.includes("message is not modified"))) {
        const replied = await send(sub, "sendMessage", {
          chat_id: sub.chatId,
          message_thread_id: sub.topicId,
          reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
          text,
        });
        replyId = replied.ok ? (replied.result as { message_id: number }).message_id : null;
        repliedAt = replyId ? now() : null;
      }
    }
  }
  // withdrawn content is never posted fresh (§13.4); there is nothing to show
  if (!messageId && doc.kind !== "withdrawn") {
    const sent = await send(sub, "sendMessage", { chat_id: sub.chatId, message_thread_id: sub.topicId, text });
    messageId = sent.ok ? (sent.result as { message_id: number }).message_id : null;
    postedAt = messageId ? now() : null;
  }

  await db.prepare(
    `INSERT INTO imported (topic_id, origin, item_id, version, kind, content_hash, tg_message_id, posted_at, reply_message_id, replied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (topic_id, origin, item_id) DO UPDATE SET version = excluded.version, kind = excluded.kind, content_hash = excluded.content_hash,
       tg_message_id = excluded.tg_message_id, posted_at = excluded.posted_at, reply_message_id = excluded.reply_message_id, replied_at = excluded.replied_at`,
  ).bind(sub.topicId, s.origin, doc.id, doc.version, doc.kind, doc.content_hash ?? null, messageId, postedAt, replyId, repliedAt).run();
}

// One poll of one blyg: diff its archive index against each following topic's watermarks (§13.2).
// Every changed item is fetched once, however many topics show it.
async function pollOne(db: D1Database, bot: Bot, s: Subscription, budget: { left: number }) {
  budget.left--;
  const index = await fetchIndex(s.index_url, s.index_etag);
  if (index.status === "unchanged") return { ok: true as const };
  if (index.status === "error") return { ok: false as const, error: index.error, retryAfter: index.retryAfter };

  const topics = (await db.prepare("SELECT topic_id FROM follows WHERE origin = ? ORDER BY created").bind(s.origin).all<{ topic_id: number }>()).results
    .map((f) => f.topic_id);
  const { results } = await db.prepare("SELECT * FROM imported WHERE origin = ?")
    .bind(s.origin).all<Imported>();
  const seen = new Map(topics.map((t) => [t, new Map<string, Imported>()]));
  for (const r of results) seen.get(r.topic_id)?.set(r.item_id, r);
  // an item is behind when any following topic hasn't shown its current version
  const behind = (entry: IndexEntry, t: number) => entry.version > (seen.get(t)!.get(entry.id)?.version ?? 0);
  const changed = index.items
    .filter((i) => topics.some((t) => behind(i, t)))
    .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));

  let complete = true;
  items: for (const entry of changed) {
    if (budget.left <= 0) { complete = false; break; }
    budget.left--;
    const doc = await fetchItem(s.origin, entry.id);
    if (!doc) { complete = false; continue; }
    for (const topicId of [...topics]) {
      const row = seen.get(topicId)!.get(entry.id);
      // the document is ground truth; never adopt a version below the watermark (§13.3)
      if (doc.version <= (row?.version ?? 0)) {
        if (behind(entry, topicId)) complete = false;
        continue;
      }
      try {
        await present(db, { ...bot, topicId }, s, doc, row);
      } catch (e) {
        if (e instanceof TopicGone) {
          await removeSubTopic(db, topicId);
          topics.splice(topics.indexOf(topicId), 1);
          continue;
        }
        if (!(e instanceof Retry)) throw e;
        complete = false;
        break items;
      }
    }
  }
  // only remember the index's ETag once everything it listed has been applied
  await db.prepare("UPDATE subscriptions SET index_etag = ? WHERE origin = ?").bind(complete ? index.etag : null, s.origin).run();
  return { ok: true as const };
}

export async function pollDue(db: D1Database, bot: Bot) {
  const { results } = await db.prepare("SELECT * FROM subscriptions WHERE next_poll <= ? ORDER BY next_poll").bind(now()).all<Subscription>();
  const budget = { left: FETCH_BUDGET };
  for (const s of results) {
    if (budget.left <= 0) break;
    const result = await pollOne(db, bot, s, budget).catch((e) => ({ ok: false as const, error: String(e), retryAfter: null }));
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
