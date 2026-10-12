// Publish-time resolution of a message's markdown (§10.1–10.2): what it links and what it quotes.
import { type AuthoredKind, directives, excerpt, linkIds, pagePath, render, textContent, type LinkTarget, type Snapshot, type Transclusion } from "./blyg";
import { getItem } from "./store";

export type Composed =
  | { ok: true; html: string; thread: boolean; transclusions: Transclusion[] }
  | { ok: false; error: string };

// self: the thread being edited, which may not quote itself, directly or through other local threads
export async function compose(db: D1Database, origin: string, src: string, self?: string): Promise<Composed> {
  const found = directives(src);
  if (found.some((d) => d.versioned)) return { ok: false, error: "![[id@vN]] is reserved by the spec and can't be published" };

  const quotes = new Map<string, Snapshot>();
  const transclusions: Transclusion[] = [];
  for (const d of found) {
    let snap = quotes.get(d.id);
    if (!snap) {
      const resolved = await resolveQuote(db, d.id, self);
      if (typeof resolved === "string") return { ok: false, error: resolved };
      quotes.set(d.id, (snap = resolved));
    }
    const entry: Transclusion = { id: d.id, version: snap.version };
    if (d.selection !== undefined) {
      const selector = select(textContent(snap.html), d.selection);
      if (!selector) return { ok: false, error: `the quote under ![[${d.id}]] isn't word for word in that post (v${snap.version})` };
      entry.selector = selector;
    }
    transclusions.push(entry);
  }

  const links = new Map<string, LinkTarget>();
  for (const id of linkIds(src)) {
    const target = await resolveLink(db, origin, id);
    if (typeof target === "string") return { ok: false, error: target };
    links.set(id, target);
  }
  return { ok: true, html: render(src, origin, links, quotes), thread: found.length > 0, transclusions };
}

// the publisher's own current snapshot (§10.2). Quoting followed blygs needs their content stored, which comes with L2.
async function resolveQuote(db: D1Database, id: string, self?: string): Promise<Snapshot | string> {
  if (id === self) return "a thread can't quote itself";
  const local = await getItem(db, id);
  if (local && local.kind !== "withdrawn") {
    if (self && local.kind === "thread" && (await reaches(db, id, self))) return `![[${id}]] already quotes this thread, so quoting it back would loop`;
    return { version: local.version, html: local.content_html };
  }
  if (local) return `![[${id}]] is withdrawn`;
  const imported = await db.prepare("SELECT 1 FROM imported WHERE item_id = ? LIMIT 1").bind(id).first();
  if (imported) return `![[${id}]] is from a blyg you follow; blyxt can only quote your own posts for now`;
  return `![[${id}]] doesn't match a post here`;
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

// a local published item first, then exactly one followed blyg's item; anything else is a publish error
async function resolveLink(db: D1Database, origin: string, id: string): Promise<LinkTarget | string> {
  const local = await getItem(db, id);
  if (local && local.kind !== "withdrawn") return { url: origin + pagePath(local), label: excerpt(local.content_md, 40) || id };

  const { results } = await db
    .prepare("SELECT origin, MAX(kind) AS kind FROM imported WHERE item_id = ? AND kind != 'withdrawn' GROUP BY origin")
    .bind(id)
    .all<{ origin: string; kind: string }>();
  if (results.length > 1) return `[[${id}]] matches posts in ${results.length} blygs you follow; the spec won't pick one`;
  if (results.length === 1) return { url: new URL(pagePath({ id, authored_kind: results[0].kind as AuthoredKind }), results[0].origin).href, label: id };
  return `[[${id}]] doesn't match a post here or in a blyg you follow`;
}
