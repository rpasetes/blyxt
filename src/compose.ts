// Publish-time resolution of a message's markdown (§10.1–10.2): what it links and what it quotes.
import { directives, excerpt, linkIds, now, pagePath, render, textContent, type Link, type LinkTarget, type Snapshot, type StubOf, type Transclusion } from "./blyg";
import { itemUrl } from "./resolve";
import { getItem } from "./store";

export type Composed =
  // stub: the post a thread responds to, when it opens with a quote of it (§10.6)
  | { ok: true; html: string; thread: boolean; transclusions: Transclusion[]; links: Link[]; stub?: StubOf }
  | { ok: false; error: string };

// self: the thread being edited, which may not quote itself, directly or through other local threads
export async function compose(db: D1Database, origin: string, src: string, self?: string): Promise<Composed> {
  src = src.replace(/\r\n?/g, "\n");
  const found = directives(src);
  if (found.some((d) => d.versioned)) return { ok: false, error: "![[id@vN]] is reserved by the spec and can't be published" };

  const quotes = new Map<string, Snapshot>();
  const transclusions: Transclusion[] = [];
  for (const d of found) {
    let snap = quotes.get(d.id);
    if (!snap) {
      const resolved = await resolveQuote(db, origin, d.id, self);
      if (typeof resolved === "string") return { ok: false, error: resolved };
      quotes.set(d.id, (snap = resolved));
    }
    const entry: Transclusion = { id: d.id, version: snap.version, ...(snap.origin ? { origin: snap.origin } : {}) };
    if (d.selection !== undefined) {
      const selector = select(textContent(snap.html), d.selection);
      if (!selector) return { ok: false, error: `the quote under ![[${d.id}]] isn't word for word in that post (v${snap.version})` };
      entry.selector = selector;
    }
    transclusions.push(entry);
  }

  // every [[id]] link resolves, and each is disclosed in links[], in order (§10.1, §10.3a)
  const links = new Map<string, LinkTarget & { origin?: string }>();
  const disclosed: Link[] = [];
  for (const id of linkIds(src)) {
    let target = links.get(id);
    if (!target) {
      const resolved = await resolveLink(db, origin, id);
      if (typeof resolved === "string") return { ok: false, error: resolved };
      links.set(id, (target = resolved));
    }
    disclosed.push(target.origin ? { id, origin: target.origin } : { id });
  }
  // a thread that opens with a quote responds to it: blyxt's stub gesture is the quote itself
  const first = found.length && /^!\[\[/.test(src.trimStart()) ? found[0] : undefined;
  const target = first && quotes.get(first.id)!;
  const stub = target ? { origin: target.origin ?? origin, id: first.id, version: target.version, ...(target.cited ? { cited: target.cited } : {}) } : undefined;
  return { ok: true, html: render(src, origin, links, quotes), thread: found.length > 0, transclusions, links: disclosed, ...(stub ? { stub } : {}) };
}

// the publisher's own current snapshot (§10.2): a local post, else exactly one followed blyg's post as last read.
// Never a live fetch: quoting follows reading
async function resolveQuote(db: D1Database, origin: string, id: string, self?: string): Promise<Snapshot | string> {
  if (id === self) return "a thread can't quote itself";
  const local = await getItem(db, id);
  if (local && local.kind !== "withdrawn") {
    if (self && local.kind === "thread" && (await reaches(db, id, self))) return `![[${id}]] already quotes this thread, so quoting it back would loop`;
    return { version: local.version, html: local.content_html, cited: { url: origin + pagePath(local), excerpt: excerpt(local.content_md, 200), retrieved: now() } };
  }
  if (local) return `![[${id}]] is withdrawn`;

  // L0 rows never match: their ids aren't blyg ids (§13.6)
  const { results } = await db.prepare(
    `SELECT s.origin, s.version, s.kind, s.content_html, s.page, s.author, s.fetched, sub.title, sub.item_tpl
     FROM snapshots s JOIN subscriptions sub ON sub.origin = s.origin AND sub.legacy = 0 WHERE s.item_id = ?`,
  ).bind(id).all<{ origin: string; version: number; kind: string; content_html: string; page: string | null; author: string | null; fetched: string; title: string; item_tpl: string | null }>();
  if (results.length > 1) return `![[${id}]] matches posts in ${results.length} blygs you follow; the spec won't pick one`;
  const snap = results[0];
  if (snap?.kind === "withdrawn") return `![[${id}]] is withdrawn at ${snap.title}`;
  if (snap) {
    // the cited url is the page its document gave, else its item document (§5.9): never a guessed f/ or t/ path
    const page = snap.page ? new URL(snap.page, snap.origin).href : itemUrl(snap.origin, snap.item_tpl, id);
    return {
      version: snap.version,
      html: snap.content_html,
      origin: snap.origin,
      cited: { source: snap.title, ...(snap.author ? { author: snap.author } : {}), excerpt: clip(textContent(snap.content_html), 200), url: page, retrieved: snap.fetched },
    };
  }
  const imported = await db.prepare("SELECT 1 FROM imported WHERE item_id = ? LIMIT 1").bind(id).first();
  if (imported) return `![[${id}]] is from a blyg you follow, but blyxt hasn't kept a copy of it yet. try again after the next poll`;
  return `![[${id}]] doesn't match a post here or in a blyg you follow`;
}

// a caption from text as it reads, not markdown (§5.9 caps it near 200 characters)
// the label blyxt writes on a quote it opens for you, so the source still says what it quotes (§10.1, #70):
// "blyg: opening line" for a followed post, the opening line for your own, from the same snapshot the quote
// bakes. It is the quoter's words and bakes as data-blyg-label (#81); never ]] (a label can't contain it) or a break
export async function labelFor(db: D1Database, origin: string, id: string) {
  const snap = await resolveQuote(db, origin, id);
  if (typeof snap === "string") return undefined;
  const opening = textContent(snap.html).split("\n")[0] ?? "";
  const label = clip((snap.cited?.source ? `${snap.cited.source}: ${opening}` : opening).replace(/[[\]]/g, ""), 60);
  return label || undefined;
}

function clip(text: string, n: number) {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}

// the one closure check: walk local threads' stored transclusions looking for the publishing thread (§10.2)
async function reaches(db: D1Database, from: string, target: string) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const item = await getItem(db, queue.shift()!);
    for (const t of JSON.parse(item?.transclusions ?? "[]") as Transclusion[]) {
      if (t.origin) continue; // remote closures are not walked
      if (t.id === target) return true;
      if (!seen.has(t.id)) { seen.add(t.id); queue.push(t.id); }
    }
  }
  return false;
}

// a partial quote must be a substring of the snapshot's text; the selector is its W3C text-quote shape (§10.3)
function select(text: string, selection: string): Transclusion["selector"] | null {
  const at = selection ? text.indexOf(selection) : -1;
  if (at < 0) return null;
  const prefix = text.slice(Math.max(0, at - 32), at);
  const suffix = text.slice(at + selection.length, at + selection.length + 32);
  return { exact: selection, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) };
}

// a local published item first, then exactly one followed blyg's item; anything else is a publish error.
// A remote link's href is the target's page as its document gave it, else its item document: never a
// guessed f/ or t/ path, which are presentation that blyg may not serve (§4, §15.2)
async function resolveLink(db: D1Database, origin: string, id: string): Promise<(LinkTarget & { origin?: string }) | string> {
  const local = await getItem(db, id);
  if (local && local.kind !== "withdrawn") return { url: origin + pagePath(local), label: excerpt(local.content_md, 40) || id };
  // a local id never falls through to an import (§10.2)
  if (local) return `[[${id}]] is withdrawn`;

  const { results } = await db
    .prepare(`SELECT i.origin, MAX(s.page) AS page, MAX(sub.item_tpl) AS item_tpl FROM imported i
      LEFT JOIN snapshots s ON s.origin = i.origin AND s.item_id = i.item_id LEFT JOIN subscriptions sub ON sub.origin = i.origin
      WHERE i.item_id = ? AND i.kind NOT IN ('withdrawn', 'l0') GROUP BY i.origin`)
    .bind(id)
    .all<{ origin: string; page: string | null; item_tpl: string | null }>();
  if (results.length > 1) return `[[${id}]] matches posts in ${results.length} blygs you follow; the spec won't pick one`;
  if (results.length === 1) {
    const { origin: from, page, item_tpl } = results[0];
    return { url: page ? new URL(page, from).href : itemUrl(from, item_tpl, id), label: id, origin: from };
  }
  return `[[${id}]] doesn't match a post here or in a blyg you follow`;
}
