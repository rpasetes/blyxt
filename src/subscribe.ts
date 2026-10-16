// Read side of the Sub topic: subscriptions and polling (spec §12.3, §13).
import { contentHash, ID_RE, now } from "./blyg";
import { USER_AGENT, type Manifest } from "./resolve";
import { parseFeed, syntheticId, type LegacyEntry } from "./rss";
import { sanitize } from "./sanitize";
import { decode, toTelegramHtml, type QuoteLink } from "./tghtml";
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
  feed_url: string | null;
  // 1 while following the feed because the archive index is missing
  lossy: number;
  // 1 for a plain RSS/Atom feed (L0); origin and index_url are then the feed URL
  legacy: number;
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
type ItemDoc = { id: string; kind: string; version: number; content_md?: string; content_html?: string; content_hash?: string; page?: string; author?: { name?: string } };

export type Bot = { token: string; chatId: number };
// one Sub topic: a grouping of followed blygs
export type Sub = Bot & { topicId: number };

export const POLL_MINUTES = 15;
const KINDS = new Set(["fragment", "thread", "withdrawn"]);
// Workers allow 50 subrequests per invocation on the free plan; leave room for Telegram calls
const FETCH_BUDGET = 20;
const MAX_MESSAGE = 3500;
// already-seen items refetched per poll run, oldest check first, to catch stealth edits (§13.3)
const SWEEP = 3;
const RECHECK_HOURS = 6;
// a Sub message this recent is still near the bottom of its topic, so an edit to it is seen without a reply
const FRESH_MINUTES = 60;

const fresh = (at: string | null | undefined) => !!at && Date.parse(at) > Date.now() - FRESH_MINUTES * 60_000;
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

const get = (url: string, etag?: string | null, accept = "application/json") =>
  fetch(url, {
    headers: { "user-agent": USER_AGENT, accept, ...(etag ? { "if-none-match": etag } : {}) },
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
  | { status: "missing" }
  | { status: "ok"; items: IndexEntry[]; etag: string | null }
  | { status: "error"; error: string; retryAfter: string | null };

async function fetchIndex(url: string, etag?: string | null): Promise<IndexResult> {
  const res = await get(url, etag);
  const fail = (error: string): IndexResult => ({ status: "error", error, retryAfter: res.headers.get("retry-after") });
  if (res.status === 304) return { status: "unchanged" };
  // an otherwise-live blyg without an index is nonconforming; the feed stands in (§13.2)
  if (res.status === 404 || res.status === 410) return { status: "missing" };
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

// the feed window as index entries: the highest version per blyg:id (§7)
async function fetchFeed(url: string, etag?: string | null): Promise<IndexResult> {
  const res = await get(url, etag, "application/rss+xml, application/xml;q=0.9, */*;q=0.1");
  if (res.status === 304) return { status: "unchanged" };
  if (!res.ok) return { status: "error", error: `no archive index, and ${res.status} from ${url}`, retryAfter: res.headers.get("retry-after") };
  const latest = new Map<string, IndexEntry>();
  for (const [, body] of (await res.text()).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const tag = (name: string) => body.match(new RegExp(`<blyg:${name}>\\s*([^<]*?)\\s*</blyg:${name}>`))?.[1];
    const [id, version, kind] = [tag("id"), Number(tag("version")), tag("kind")];
    // an unparseable entry is skipped, never the feed (§13.2)
    if (!id || !ID_RE.test(id) || !Number.isInteger(version) || !kind || !KINDS.has(kind)) continue;
    if ((latest.get(id)?.version ?? 0) < version) latest.set(id, { id, kind, version, created: tag("created") });
  }
  return { status: "ok", items: [...latest.values()], etag: res.headers.get("etag") };
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
  const feedUrl = new URL(typeof manifest.feed === "string" ? manifest.feed : "feed.xml", origin).href;
  let index = await fetchIndex(indexUrl);
  const lossy = index.status === "missing";
  if (lossy) index = await fetchFeed(feedUrl);
  if (index.status !== "ok") throw new Error(index.status === "error" ? index.error : "archive index unavailable");

  const at = now();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO sub_topics (topic_id, name, created) VALUES (?, ?, ?)").bind(sub.topicId, topicName, at),
    db.prepare("INSERT OR IGNORE INTO subscriptions (origin, title, index_url, feed_url, lossy, index_etag, created, last_polled, next_poll) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(origin, title, indexUrl, feedUrl, lossy ? 1 : 0, index.etag, at, at, minutesFromNow(POLL_MINUTES)),
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
  return { title, count: index.items.length, lossy };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Sub messages show the rendered item (content_html), so baked quotes read as quotes, not ![[id]] directives
export function messageText(title: string, origin: string, doc: ItemDoc, quoteLinks?: Map<string, QuoteLink>) {
  if (doc.kind === "withdrawn") return `<b>${esc(title)}</b> · withdrawn`;
  const link = new URL(doc.page ?? `${doc.kind === "thread" ? "t" : "f"}/${doc.id}/`, origin).href;
  const body = toTelegramHtml(doc.content_html ?? "", origin, MAX_MESSAGE, quoteLinks && ((q) => quoteLinks.get(`${q.origin} ${q.id}`) ?? null));
  return `<b>${esc(title)}</b>${doc.version > 1 ? ` · v${doc.version}` : ""}\n\n${body}\n\n<a href="${esc(link)}">${esc(link)}</a>`;
}

// each quote baked into a post links to what it quotes, like a citation under it: the page as blyxt last read it,
// else the reference convention for a kind it knows, else the item document, which every blyg serves
export async function quoteLinks(db: D1Database, html: string, origin: string) {
  const links = new Map<string, QuoteLink>();
  for (const [tag] of html.matchAll(/<blockquote\b[^>]*\bdata-blyg-id="[^"]*"[^>]*>/g)) {
    const id = tag.match(/data-blyg-id="([^"]*)"/)![1];
    const from = decode(tag.match(/data-blyg-origin="([^"]*)"/)?.[1] ?? "") || origin;
    const key = `${from} ${id}`;
    if (links.has(key) || !ID_RE.test(id)) continue;
    const known = await db.prepare(
      `SELECT (SELECT title FROM subscriptions WHERE origin = ?1) AS title,
              (SELECT page FROM snapshots WHERE origin = ?1 AND item_id = ?2) AS page,
              (SELECT kind FROM imported WHERE origin = ?1 AND item_id = ?2 AND kind != 'withdrawn' LIMIT 1) AS kind`,
    ).bind(from, id).first<{ title: string | null; page: string | null; kind: string | null }>();
    const path = known?.page ?? (known?.kind ? `${known.kind === "thread" ? "t" : "f"}/${id}/` : `items/${id}.json`);
    let url: string;
    try { url = new URL(path, from).href; } catch { continue; }
    links.set(key, { url, label: known?.title ?? new URL(from).host });
  }
  return links;
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
async function present(db: D1Database, sub: Sub, s: Pick<Subscription, "origin" | "title">, doc: ItemDoc, row: Imported | undefined, text?: string) {
  text ??= messageText(s.title, s.origin, doc, await quoteLinks(db, doc.content_html ?? "", s.origin));
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

type Seen = Map<number, Map<string, Imported>>;

// Bring every following topic up to a fetched document. "pending" when the index promised a version
// the document doesn't have yet (a lagging cache: fetch again next poll), "retry" when Telegram said later.
async function applyDoc(db: D1Database, bot: Bot, s: Subscription, doc: ItemDoc, topics: number[], seen: Seen, listed?: number) {
  const watermarks = topics.map((t) => seen.get(t)!.get(doc.id)?.version ?? 0);
  try {
    // the watermark never regresses; a document below it is the origin rewriting history (§13.3)
    const highest = Math.max(0, ...watermarks);
    if (doc.version < highest) {
      await discrepancy(db, bot, s, topics, seen, doc, "regression", String(highest),
        `⚠ ${s.title} served v${doc.version} of this post after showing v${highest}: its history went backwards. blyxt keeps v${highest}.`);
    }
    // the hash is the origin's claim about its own bytes: a mismatch is a defect report, and the content is shown anyway
    if (typeof doc.content_md === "string" && doc.content_hash && (await contentHash(doc.content_md)) !== doc.content_hash) {
      await discrepancy(db, bot, s, topics, seen, doc, "hash", doc.content_hash,
        `⚠ ${s.title}'s v${doc.version} of this post doesn't match its own content_hash. it's shown anyway; the blyg's software has a bug.`);
    }
    let pending = false;
    const stealthy: number[] = [];
    for (const topicId of [...topics]) {
      const row = seen.get(topicId)!.get(doc.id);
      if (doc.version <= (row?.version ?? 0)) {
        if ((listed ?? 0) > doc.version && doc.version === row?.version) pending = true;
        if (doc.version !== row?.version || !doc.content_hash || row.content_hash === doc.content_hash) continue;
        // same version, new content: adopt it and say so; the watermark stays (§13.3)
        if (row.content_hash) stealthy.push(topicId);
        else {
          // a baseline row learns its hash quietly
          await db.prepare("UPDATE imported SET content_hash = ? WHERE topic_id = ? AND origin = ? AND item_id = ?").bind(doc.content_hash, topicId, s.origin, doc.id).run();
          continue;
        }
      }
      try {
        await present(db, { ...bot, topicId }, s, doc, row);
      } catch (e) {
        if (!(e instanceof TopicGone)) throw e;
        await removeSubTopic(db, topicId);
        topics.splice(topics.indexOf(topicId), 1);
      }
    }
    if (stealthy.length) {
      await discrepancy(db, bot, s, stealthy, seen, doc, "stealth", doc.content_hash!,
        `⚠ ${s.title} changed this post without a new version (still v${doc.version}). blyxt shows the new text; the change should have been v${doc.version + 1}.`);
    }
    if (doc.version >= highest) await saveSnapshot(db, s.origin, doc);
    await db.prepare("UPDATE imported SET checked_at = ? WHERE origin = ? AND item_id = ?").bind(now(), s.origin, doc.id).run();
    return pending ? "pending" : "done";
  } catch (e) {
    if (e instanceof Retry) return "retry";
    throw e;
  }
}

// what quoting bakes (§10.2): the document as read, its HTML made safe for this blyg's pages.
// A withdrawn item keeps no content: nothing was pin-retained, so it can't be quoted (§13.4)
export async function saveSnapshot(db: D1Database, origin: string, doc: ItemDoc) {
  if (!ID_RE.test(doc.id)) return;
  const html = doc.kind === "withdrawn" ? "" : sanitize(doc.content_html ?? "", origin);
  await db.prepare(
    `INSERT INTO snapshots (origin, item_id, version, kind, content_html, page, author, fetched) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (origin, item_id) DO UPDATE SET version = excluded.version, kind = excluded.kind, content_html = excluded.content_html,
       page = excluded.page, author = excluded.author, fetched = excluded.fetched WHERE excluded.version >= snapshots.version`,
  ).bind(origin, doc.id, doc.version, doc.kind, html, doc.page ?? null, doc.author?.name ?? null, now()).run();
}

// a notice to every topic following a blyg
async function announce(bot: Bot, topics: number[], text: string) {
  for (const topicId of topics) {
    await send({ ...bot, topicId }, "sendMessage", { chat_id: bot.chatId, message_thread_id: topicId, text: esc(text) })
      .catch((e) => { if (!(e instanceof TopicGone)) throw e; });
  }
}

// record a protocol violation and tell every following topic, once; the notice replies under the post where it can
async function discrepancy(db: D1Database, bot: Bot, s: Subscription, topics: number[], seen: Seen, doc: ItemDoc, kind: string, detail: string, text: string) {
  const known = await db.prepare("SELECT 1 FROM discrepancies WHERE origin = ? AND item_id = ? AND kind = ? AND version = ? AND detail = ?")
    .bind(s.origin, doc.id, kind, doc.version, detail).first();
  if (known) return;
  for (const topicId of topics) {
    const messageId = seen.get(topicId)!.get(doc.id)?.tg_message_id;
    await send({ ...bot, topicId }, "sendMessage", {
      chat_id: bot.chatId,
      message_thread_id: topicId,
      ...(messageId ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {}),
      text: esc(text),
    }).catch((e) => { if (!(e instanceof TopicGone)) throw e; });
  }
  await db.prepare("INSERT OR IGNORE INTO discrepancies (origin, item_id, kind, version, detail, at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(s.origin, doc.id, kind, doc.version, detail, now()).run();
}

// the topics following a blyg, and what each has seen of it
async function followers(db: D1Database, origin: string) {
  const topics = (await db.prepare("SELECT topic_id FROM follows WHERE origin = ? ORDER BY created").bind(origin).all<{ topic_id: number }>()).results
    .map((f) => f.topic_id);
  const { results } = await db.prepare("SELECT * FROM imported WHERE origin = ?").bind(origin).all<Imported>();
  const seen: Seen = new Map(topics.map((t) => [t, new Map<string, Imported>()]));
  for (const r of results) seen.get(r.topic_id)?.set(r.item_id, r);
  return { topics, seen };
}

// Version bumps show in the index; a stealth edit doesn't. Spare fetches go to refetching seen items, least recently checked first.
async function sweep(db: D1Database, bot: Bot, budget: { left: number }) {
  const { results } = await db.prepare(
    `SELECT s.*, i.item_id FROM imported i JOIN subscriptions s ON s.origin = i.origin
     WHERE i.kind != 'withdrawn' AND s.failures = 0 AND s.legacy = 0 GROUP BY i.origin, i.item_id
     HAVING MIN(COALESCE(i.checked_at, '')) < ? ORDER BY MIN(COALESCE(i.checked_at, '')) LIMIT ?`,
  ).bind(minutesFromNow(-RECHECK_HOURS * 60), Math.min(SWEEP, budget.left)).all<Subscription & { item_id: string }>();
  for (const { item_id, ...s } of results) {
    budget.left--;
    const doc = await fetchItem(s.origin, item_id);
    if (!doc) {
      await db.prepare("UPDATE imported SET checked_at = ? WHERE origin = ? AND item_id = ?").bind(now(), s.origin, item_id).run();
      continue;
    }
    const { topics, seen } = await followers(db, s.origin);
    if ((await applyDoc(db, bot, s, doc, topics, seen)) === "retry") return;
  }
}

// One poll of one blyg: diff its archive index against each following topic's watermarks (§13.2).
// Every changed item is fetched once, however many topics show it.
async function pollOne(db: D1Database, bot: Bot, s: Subscription, budget: { left: number }) {
  if (s.legacy) return pollLegacy(db, bot, s, budget);
  budget.left--;
  // while lossy, the stored ETag is the feed's
  let index = await fetchIndex(s.index_url, s.lossy ? null : s.index_etag);
  const lossy = index.status === "missing";
  if (lossy) {
    budget.left--;
    index = await fetchFeed(s.feed_url ?? new URL("feed.xml", s.origin).href, s.lossy ? s.index_etag : null);
  }
  if (index.status !== "error" && index.status !== "missing" && lossy !== !!s.lossy) {
    // announced before it's recorded, so a busy Telegram means announcing again next poll, not never
    await announce(bot, (await followers(db, s.origin)).topics, lossy
      ? `⚠ ${s.title} has no archive index right now, so blyxt is following its feed instead. posts that scroll out of the feed between polls can be missed.`
      : `${s.title}'s archive index is back; nothing will be missed from here on.`);
    await db.prepare("UPDATE subscriptions SET lossy = ? WHERE origin = ?").bind(lossy ? 1 : 0, s.origin).run();
  }
  if (index.status === "unchanged") return { ok: true as const };
  if (index.status === "missing") return { ok: false as const, error: "archive index missing", retryAfter: null };
  if (index.status === "error") return { ok: false as const, error: index.error, retryAfter: index.retryAfter };

  const { topics, seen } = await followers(db, s.origin);
  // an item is behind when any following topic hasn't shown its current version
  const behind = (entry: IndexEntry, t: number) => entry.version > (seen.get(t)!.get(entry.id)?.version ?? 0);
  const changed = index.items
    .filter((i) => topics.some((t) => behind(i, t)))
    .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));

  let complete = true;
  for (const entry of changed) {
    if (budget.left <= 0) { complete = false; break; }
    budget.left--;
    const doc = await fetchItem(s.origin, entry.id);
    if (!doc) { complete = false; continue; }
    const result = await applyDoc(db, bot, s, doc, topics, seen, entry.version);
    if (result === "pending") complete = false;
    if (result === "retry") { complete = false; break; }
  }
  // only remember the index's ETag once everything it listed has been applied
  await db.prepare("UPDATE subscriptions SET index_etag = ? WHERE origin = ?").bind(complete ? index.etag : null, s.origin).run();
  return { ok: true as const };
}

// Legacy (L0) feeds, §13.6: each entry is a summary + link under a synthetic id. RSS has no versions,
// so changed content under the same GUID is a local version bump; entries leaving the window are kept.

const LEGACY_SUMMARY = 1000;

const legacyHash = (e: LegacyEntry) => contentHash(`${e.title}\n${e.link ?? ""}\n${e.summary}`);

// visibly marked as wrapped legacy content
export function legacyText(feedTitle: string, e: LegacyEntry, version: number) {
  const heading = e.title || e.link || "untitled";
  const title = e.link ? `<a href="${esc(e.link)}">${esc(heading)}</a>` : esc(heading);
  const summary = toTelegramHtml(e.summary, e.link ?? "https://invalid./", LEGACY_SUMMARY);
  return `<b>${esc(feedTitle)}</b> · RSS${version > 1 ? " · updated" : ""}\n\n<b>${title}</b>${summary ? `\n\n${summary}` : ""}`;
}

const fetchLegacy = async (url: string, etag?: string | null) => {
  const res = await get(url, etag, "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.1");
  if (res.status === 304) return { status: "unchanged" as const };
  if (!res.ok) return { status: "error" as const, error: `${res.status} from ${url}`, retryAfter: res.headers.get("retry-after") };
  return { status: "ok" as const, feed: parseFeed(await res.text(), url), etag: res.headers.get("etag") };
};

// like addSubscription: baseline every entry in the window, then show the newest
export async function addLegacySubscription(db: D1Database, sub: Sub, feedUrl: string, topicName = "Sub") {
  const got = await fetchLegacy(feedUrl);
  if (got.status !== "ok") throw new Error(got.status === "error" ? got.error : "feed unavailable");
  const title = got.feed.title || new URL(feedUrl).host;
  const at = now();
  const rows = await Promise.all(got.feed.entries.map(async (e) => ({ id: await syntheticId(e.key), hash: await legacyHash(e) })));
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO sub_topics (topic_id, name, created) VALUES (?, ?, ?)").bind(sub.topicId, topicName, at),
    db.prepare("INSERT OR IGNORE INTO subscriptions (origin, title, index_url, feed_url, legacy, index_etag, created, last_polled, next_poll) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)")
      .bind(feedUrl, title, feedUrl, feedUrl, got.etag, at, at, minutesFromNow(POLL_MINUTES)),
    db.prepare("INSERT INTO follows (topic_id, origin, created) VALUES (?, ?, ?)").bind(sub.topicId, feedUrl, at),
    ...rows.map((r) =>
      db.prepare("INSERT OR IGNORE INTO imported (topic_id, origin, item_id, version, kind, content_hash) VALUES (?, ?, ?, 1, 'l0', ?)").bind(sub.topicId, feedUrl, r.id, r.hash),
    ),
  ]);
  const newest = got.feed.entries[0];
  if (newest) {
    const doc = { id: rows[0].id, kind: "l0", version: 1, content_hash: rows[0].hash };
    await present(db, sub, { origin: feedUrl, title }, doc, undefined, legacyText(title, newest, 1)).catch(() => {});
  }
  return { title, count: got.feed.entries.length };
}

async function pollLegacy(db: D1Database, bot: Bot, s: Subscription, budget: { left: number }) {
  budget.left--;
  const got = await fetchLegacy(s.index_url, s.index_etag);
  if (got.status === "unchanged") return { ok: true as const };
  if (got.status === "error") return { ok: false as const, error: got.error, retryAfter: got.retryAfter };

  const { topics, seen } = await followers(db, s.origin);
  let complete = true;
  // feeds list newest first; post oldest first
  entries: for (const e of [...got.feed.entries].reverse()) {
    const id = await syntheticId(e.key);
    const hash = await legacyHash(e);
    for (const topicId of [...topics]) {
      const row = seen.get(topicId)!.get(id);
      if (row?.content_hash === hash) continue;
      const version = (row?.version ?? 0) + 1;
      try {
        await present(db, { ...bot, topicId }, s, { id, kind: "l0", version, content_hash: hash }, row, legacyText(s.title, e, version));
      } catch (err) {
        if (err instanceof TopicGone) {
          await removeSubTopic(db, topicId);
          topics.splice(topics.indexOf(topicId), 1);
          continue;
        }
        if (!(err instanceof Retry)) throw err;
        complete = false;
        break entries;
      }
    }
  }
  await db.prepare("UPDATE subscriptions SET index_etag = ? WHERE origin = ?").bind(complete ? got.etag : null, s.origin).run();
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
  await sweep(db, bot, budget).catch((e) => console.error(`sweep: ${e}`));
}
