// Outbound Webmention (§15.2): telling another blyg it was stubbed or quoted. Fire-and-forget: a publish
// never waits on it, failures retry from the cron with backoff, and the outcome is information, never an error.
import { now, pagePath, type Item, type Site, type StubOf, type Transclusion } from "./blyg";
import { USER_AGENT } from "./resolve";
import { lastStub } from "./store";

type Ref = { origin: string; id: string; version: number; relation: "stub" | "transclusion" };
type Row = { item_id: string; target_origin: string; target_id: string; target_version: number; relation: string; source: string; target: string; status: string; attempts: number };

// RECOMMENDED retry schedule, in minutes, then abandoned (§15.2)
const BACKOFF = [15, 60, 240, 720, 1440];
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

// a post's references to other origins: its stub target, and every quote carrying an origin
function remoteRefs(item: Item, self: string): Ref[] {
  const refs: Ref[] = [];
  const stub = item.stub_of ? (JSON.parse(item.stub_of) as StubOf) : null;
  if (stub && stub.origin !== self) refs.push({ ...stub, relation: "stub" });
  for (const t of JSON.parse(item.transclusions ?? "[]") as Transclusion[]) {
    if (t.origin && t.origin !== self && !refs.some((r) => r.origin === t.origin && r.id === t.id)) refs.push({ origin: t.origin, id: t.id, version: t.version, relation: "transclusion" });
  }
  return refs;
}

async function targetPage(db: D1Database, ref: { origin: string; id: string }) {
  const snap = await db.prepare("SELECT page, kind FROM snapshots WHERE origin = ? AND item_id = ?").bind(ref.origin, ref.id).first<{ page: string | null; kind: string }>();
  return new URL(snap?.page ?? `${snap?.kind === "fragment" ? "f" : "t"}/${ref.id}/`, ref.origin).href;
}

// Queue what a newly published version owes (new references, or ones whose target version changed;
// a withdrawn stub re-sends once so the target sees it stop verifying), then try them now.
export async function mention(db: D1Database, site: Site, item: Item) {
  const source = site.origin + pagePath(item);
  if (item.kind === "withdrawn") {
    const stub = await lastStub(db, item.id);
    if (stub && stub.origin !== site.origin) {
      await db.prepare("UPDATE mentions_out SET status = 'pending', attempts = 0, next_try = ?, updated = ? WHERE item_id = ? AND relation = 'stub' AND status != 'no-endpoint'")
        .bind(now(), now(), item.id).run();
    }
  } else {
    for (const ref of remoteRefs(item, site.origin)) {
      const row = await db.prepare("SELECT target_version, relation FROM mentions_out WHERE item_id = ? AND target_origin = ? AND target_id = ?")
        .bind(item.id, ref.origin, ref.id).first<{ target_version: number; relation: string }>();
      // a republish of a withdrawn stub re-sends too: the target marked it gone
      if (row && row.target_version === ref.version && row.relation === ref.relation && !(await wasWithdrawn(db, item))) continue;
      await db.prepare(
        `INSERT INTO mentions_out (item_id, target_origin, target_id, target_version, relation, source, target, status, attempts, next_try, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT (item_id, target_origin, target_id) DO UPDATE SET target_version = excluded.target_version, relation = excluded.relation,
           source = excluded.source, target = excluded.target, status = 'pending', attempts = 0, next_try = excluded.next_try, last_error = NULL, updated = excluded.updated`,
      ).bind(item.id, ref.origin, ref.id, ref.version, ref.relation, source, await targetPage(db, ref), now(), now()).run();
    }
  }
  await deliverDue(db, item.id);
}

// the version before this one was the endcap
async function wasWithdrawn(db: D1Database, item: Item) {
  const prev = await db.prepare("SELECT kind FROM versions WHERE item_id = ? AND version = ?").bind(item.id, item.version - 1).first<{ kind: string }>();
  return prev?.kind === "withdrawn";
}

// send what's due: one item's (right after publishing it), or everything due (from the cron)
export async function deliverDue(db: D1Database, itemId?: string, limit = 5) {
  const { results } = await db.prepare(
    `SELECT * FROM mentions_out WHERE status = 'pending' AND next_try <= ?${itemId ? " AND item_id = ?" : ""} ORDER BY next_try LIMIT ${limit}`,
  ).bind(...(itemId ? [now(), itemId] : [now()])).all<Row>();
  for (const row of results) await deliver(db, row).catch((e) => console.error(`mention ${row.source} → ${row.target}: ${e}`));
}

async function deliver(db: D1Database, row: Row) {
  const set = (status: string, error: string | null, nextTry: string | null = null) =>
    db.prepare("UPDATE mentions_out SET status = ?, attempts = attempts + 1, last_error = ?, next_try = ?, updated = ? WHERE item_id = ? AND target_origin = ? AND target_id = ?")
      .bind(status, error, nextTry, now(), row.item_id, row.target_origin, row.target_id).run();
  const retry = (error: string) =>
    row.attempts < BACKOFF.length ? set("pending", error, at(BACKOFF[row.attempts])) : set("failed", error);

  let endpoint: string | null;
  try {
    endpoint = await discover(row.target_origin, row.target);
  } catch (e) {
    return retry(`discovery: ${e}`);
  }
  // a static blyg is conformant and simply unreachable this way: recorded, not retried
  if (!endpoint) return set("no-endpoint", null);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
      body: new URLSearchParams({ source: row.source, target: row.target }),
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return retry(String(e));
  }
  if (res.ok) return set("sent", null);
  const error = `${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim();
  // 4xx is terminal, except 429
  if (res.status >= 400 && res.status < 500 && res.status !== 429) return set("failed", error);
  return retry(error);
}

const get = (url: string, method = "GET") =>
  fetch(url, { method, headers: { "user-agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(10_000) });

// the target origin's manifest first, then W3C discovery on the target page (§15.2)
async function discover(origin: string, target: string) {
  const manifestUrl = new URL("blyg.json", origin).href;
  const manifest = await get(manifestUrl);
  if (manifest.ok) {
    const m = (await manifest.json().catch(() => ({}))) as { webmention?: unknown };
    if (typeof m.webmention === "string" && m.webmention) return new URL(m.webmention, manifestUrl).href;
  } else if (manifest.status >= 500) throw new Error(`manifest ${manifest.status}`);

  const fromHeader = (res: Response) => {
    for (const part of (res.headers.get("link") ?? "").split(",")) {
      const m = part.match(/<([^>]*)>\s*;.*\brel\s*=\s*"?([^";]*)"?/i);
      if (m && m[2].split(/\s+/).includes("webmention")) return new URL(m[1], res.url || target).href;
    }
    return null;
  };
  const head = await get(target, "HEAD");
  const viaHead = fromHeader(head);
  if (viaHead) return viaHead;
  const page = await get(target);
  if (page.status >= 500) throw new Error(`target ${page.status}`);
  const viaGet = fromHeader(page);
  if (viaGet) return viaGet;
  if (!page.ok || !(page.headers.get("content-type") ?? "").includes("html")) return null;
  const html = await page.text();
  for (const [tag] of html.matchAll(/<(?:link|a)\b[^>]*>/gi)) {
    const rel = tag.match(/\brel\s*=\s*["']?([^"'>]*)/i)?.[1] ?? "";
    const href = tag.match(/\bhref\s*=\s*["']?([^"'\s>]*)/i)?.[1];
    if (href !== undefined && rel.toLowerCase().split(/\s+/).includes("webmention")) return new URL(href, page.url || target).href;
  }
  return null;
}
